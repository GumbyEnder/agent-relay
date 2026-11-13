/**
 * Outbound mail for operator auth (verification, etc.).
 *
 * Delivery order:
 * 1. SMTP when SMTP_HOST (or SMTP_URL) is set — via nodemailer
 * 2. Resend HTTP API when RESEND_API_KEY is set
 * 3. Dev fallback: log + in-memory inbox (and optional file)
 *
 * Set AGENT_RELAY_DEV_MAIL=0 to hide the dev inbox endpoint even without SMTP.
 */
import { createTransport, type Transporter } from "nodemailer";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface OutboundEmail {
  id: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Verification / action URL if present in body */
  actionUrl?: string;
  at: number;
  transport: "smtp" | "resend" | "dev";
}

const globalMail = globalThis as typeof globalThis & {
  __agentRelayMailInbox__?: OutboundEmail[];
  __agentRelaySmtp__?: Transporter;
};

function inbox(): OutboundEmail[] {
  globalMail.__agentRelayMailInbox__ ??= [];
  return globalMail.__agentRelayMailInbox__;
}

function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/**
 * Product label for outbound mail.
 *
 * One deployment serves both products, so the brand of an email is decided by
 * the HOST the request arrived on, not by a build-time env var. Reading only
 * `BZ_BRAND` sent BeeZilla sign-ups a "Verify your Dev Boards email" from a
 * devboards address — the account was right and the product was wrong. The env
 * var stays as the fallback for callers with no request (magic links from a
 * background job, dev mail).
 */
export type MailBrand = "BeeZilla" | "Dev Boards";

export function brandLabel(host?: string | null): MailBrand {
  const h = String(host ?? "").toLowerCase();
  if (h.endsWith("beezilla.net")) return "BeeZilla";
  if (h && (h.startsWith("app.devboards.ai") || h.endsWith("devboards.ai"))) return "Dev Boards";
  return process.env.BZ_BRAND === "beezilla" ? "BeeZilla" : "Dev Boards";
}

/** Replace only the display name of a From value, keeping the address. */
function withDisplayName(from: string, label: string): string {
  const m = /<([^>]+)>/.exec(from);
  if (m) return `${label} <${m[1]}>`;
  if (from.includes("@")) return `${label} <${from}>`;
  return from;
}

/**
 * From header for a brand. A true BeeZilla address needs its own verified
 * sender (`MAIL_FROM_BEEZILLA`); without one we keep the configured address and
 * correct the display name rather than inventing an unverified domain.
 */
export function mailFromAddress(label: MailBrand = brandLabel()): string {
  const perBrand = env("MAIL_FROM_BEEZILLA") || env("BZ_MAIL_FROM");
  if (label === "BeeZilla" && perBrand) return perBrand;
  const configured = env("SMTP_FROM") || env("MAIL_FROM");
  if (configured) {
    const current = brandLabel();
    if (label === current) return configured;
    return withDisplayName(configured, label);
  }
  return `${label} <noreply@localhost>`;
}

export function isSmtpConfigured(): boolean {
  return Boolean(env("SMTP_URL") || env("SMTP_HOST") || env("RESEND_API_KEY"));
}

/** Dev inbox is on unless SMTP is configured or explicitly disabled. */
export function isDevMailInboxEnabled(): boolean {
  const flag = env("AGENT_RELAY_DEV_MAIL")?.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  return !isSmtpConfigured();
}

function remember(mail: OutboundEmail): void {
  const box = inbox();
  box.unshift(mail);
  if (box.length > 50) box.length = 50;
  try {
    const dir = env("AGENT_RELAY_MAIL_LOG_DIR") || join(process.cwd(), ".data");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "outbound-mail.jsonl"),
      JSON.stringify(mail) + "\n",
      "utf8",
    );
  } catch {
    /* ignore log write failures */
  }
}

export function listDevMail(opts: { email?: string; limit?: number } = {}): OutboundEmail[] {
  const lim = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  let rows = inbox();
  if (opts.email?.trim()) {
    const e = opts.email.trim().toLowerCase();
    rows = rows.filter((m) => m.to.toLowerCase() === e);
  }
  return rows.slice(0, lim);
}

export function latestDevMailFor(email: string): OutboundEmail | null {
  return listDevMail({ email, limit: 1 })[0] ?? null;
}

function getSmtp(): Transporter | null {
  if (globalMail.__agentRelaySmtp__) return globalMail.__agentRelaySmtp__;
  // Every stage is bounded. An SMTP host that accepts the TCP connection and then
  // never greets used to hold the sign-up request open indefinitely, which the
  // browser showed as a button stuck on "Creating…" for an account that already
  // existed. 8s is generous for a handshake and short enough to stay under a
  // proxy's patience.
  const timeouts = {
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  };
  const url = env("SMTP_URL");
  if (url) {
    // The URL goes inside the options object. As a second argument the timeouts
    // were message defaults, not connection settings: they never applied, and
    // the call did not type-check (every CI run on main failed on it).
    globalMail.__agentRelaySmtp__ = createTransport({ url, ...timeouts });
    return globalMail.__agentRelaySmtp__;
  }
  const host = env("SMTP_HOST");
  if (!host) return null;
  const port = Number(env("SMTP_PORT") ?? "587");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS") || env("SMTP_PASSWORD");
  globalMail.__agentRelaySmtp__ = createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: env("SMTP_SECURE") === "1" || env("SMTP_SECURE") === "true" || port === 465,
    auth: user ? { user, pass: pass ?? "" } : undefined,
    ...timeouts,
  });
  return globalMail.__agentRelaySmtp__;
}

async function sendViaResend(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from: string;
}): Promise<boolean> {
  const key = env("RESEND_API_KEY");
  if (!key) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    // Bounded like SMTP: a provider that stops answering must not hold a
    // sign-up request (and the button on screen) open.
    signal: AbortSignal.timeout(8000),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html ?? undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend failed ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  actionUrl?: string;
  /** Which product this mail belongs to. Defaults from BZ_BRAND. */
  brand?: MailBrand;
}): Promise<OutboundEmail> {
  const from = mailFromAddress(input.brand ?? brandLabel());
  const id = `mail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const base: OutboundEmail = {
    id,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    actionUrl: input.actionUrl,
    at: Date.now(),
    transport: "dev",
  };

  try {
    if (await sendViaResend({ ...input, from })) {
      const sent = { ...base, transport: "resend" as const };
      remember(sent);
      console.info(`[mail] resend → ${input.to} · ${input.subject}`);
      return sent;
    }
    const smtp = getSmtp();
    if (smtp) {
      await smtp.sendMail({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
      const sent = { ...base, transport: "smtp" as const };
      remember(sent);
      console.info(`[mail] smtp → ${input.to} · ${input.subject}`);
      return sent;
    }
  } catch (err) {
    console.error("[mail] delivery failed, falling back to dev inbox:", err);
  }

  // Dev fallback
  remember(base);
  console.info(
    `[mail:dev] To: ${input.to}\nSubject: ${input.subject}\n${input.actionUrl ? `Link: ${input.actionUrl}\n` : ""}${input.text}\n---`,
  );
  return base;
}

export async function sendVerificationMail(opts: {
  to: string;
  name?: string | null;
  url: string;
  /** Request hostname, so the mail carries the product the user signed up to. */
  host?: string | null;
}): Promise<OutboundEmail> {
  const brand = brandLabel(opts.host);
  const name = opts.name?.trim() || "there";
  const subject = `Verify your ${brand} email`;
  const text = [
    `Hi ${name},`,
    "",
    `Thanks for registering with ${brand}.`,
    "Please verify your email by opening this link:",
    "",
    opts.url,
    "",
    "This link expires in about one hour.",
    "If you did not create an account, you can ignore this message.",
    "",
    `— ${brand}`,
  ].join("\n");
  const html = `
    <div style="font-family:system-ui,sans-serif;line-height:1.5;max-width:32rem">
      <p>Hi ${escapeHtml(name)},</p>
      <p>Thanks for registering with <strong>${brand}</strong>.</p>
      <p><a href="${escapeAttr(opts.url)}" style="display:inline-block;padding:0.6rem 1rem;background:#111;color:#fff;text-decoration:none;border-radius:6px">Verify email</a></p>
      <p style="color:#666;font-size:0.9rem">Or paste this URL:<br/><code>${escapeHtml(opts.url)}</code></p>
      <p style="color:#666;font-size:0.85rem">Link expires in about one hour. If you did not sign up, ignore this email.</p>
    </div>
  `.trim();
  return sendMail({ to: opts.to, subject, text, html, actionUrl: opts.url, brand });
}

/** Magic-link sign-in email (Better Auth magicLink plugin). */
export async function sendMagicLinkMail(opts: {
  to: string;
  name?: string | null;
  url: string;
  host?: string | null;
}): Promise<OutboundEmail> {
  const brand = brandLabel(opts.host);
  const name = opts.name?.trim() || "there";
  const subject = `Your ${brand} sign-in link`;
  const text = [
    `Hi ${name},`,
    "",
    `Click this link to sign in to ${brand}:`,
    "",
    opts.url,
    "",
    "This link expires in 15 minutes and can be used once.",
    "If you did not request it, you can ignore this message.",
    "",
    `— ${brand}`,
  ].join("\n");
  const html = `
    <div style="font-family:system-ui,sans-serif;line-height:1.5;max-width:32rem">
      <p>Hi ${escapeHtml(name)},</p>
      <p>Click below to sign in to <strong>${brand}</strong>:</p>
      <p><a href="${escapeAttr(opts.url)}" style="display:inline-block;padding:0.6rem 1rem;background:#111;color:#fff;text-decoration:none;border-radius:6px">Sign in</a></p>
      <p style="color:#666;font-size:0.9rem">Or paste this URL:<br/><code>${escapeHtml(opts.url)}</code></p>
      <p style="color:#666;font-size:0.85rem">This link expires in 15 minutes and can be used once. If you didn't request it, ignore this email.</p>
    </div>
  `.trim();
  return sendMail({ to: opts.to, subject, text, html, actionUrl: opts.url, brand });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
