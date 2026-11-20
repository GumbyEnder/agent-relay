/**
 * CR-6 feedback — the report row, the consented diagnostic, the anonymous
 * transcription route's throttle, and the retention sweep's shared constants.
 *
 * Rules this file exists to keep (room #7318, frodo's #7319 amendments):
 *
 *  · The stored row holds no more than the panel showed. No account_email. The
 *    user id is a live-account handle, not a snapshot: account deletion removes
 *    the row through portability.ts, and the 90-day ip_hash belongs to a report,
 *    not to a person.
 *  · The diagnostic is a WHITELIST. Unknown keys are dropped, every string is
 *    capped, every URL is reduced to its path, and redaction runs twice — in the
 *    browser before the user sees the object, and here before insert. What is
 *    rendered in "See what's included" is what is sent.
 *  · The client never states who it is or what build it is running. The session
 *    names the user and the server stamps the sha (7318).
 *  · The anonymous ASR route is a money path with no session, so it is capped
 *    per address AND across the whole route, in the one feedback table both
 *    services write (they share the database), and it rejects by decoded WAV
 *    duration rather than by Content-Length.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";

export const FEEDBACK_BODY_MAX = 5000;
export const FEEDBACK_DIAG_MAX_BYTES = 256 * 1024;
export const FEEDBACK_CONSOLE_MAX = 50;
export const FEEDBACK_REQUESTS_MAX = 50;

/** Per-process fallback only used when no pepper is configured (route 503s). */
export const IP_HASH_PREFIX = "sha256:";

/**
 * Anonymous ASR limits. 15/hour/ip is the per-address arm 7318 ruled; the
 * whole-route cap is the money arm frodo asked for — 360/day per address is
 * still a lot of paid transcriptions when one actor owns many addresses.
 */
export const ASR_PER_IP_HOUR = 15;
export const ASR_ROUTE_PER_HOUR = Number(process.env.BZ_FEEDBACK_ASR_ROUTE_HOUR || 500) || 500;
/** 60 s of 16 kHz mono PCM16 WAV is 1,920,000 B; the byte cap is a second net. */
export const ASR_MAX_SECONDS = 60;

export type FeedbackStatus = "new" | "triaged" | "fixed" | "wontfix" | "duplicate";
export const FEEDBACK_STATUSES: FeedbackStatus[] = [
  "new",
  "triaged",
  "fixed",
  "wontfix",
  "duplicate",
];

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Path only: the query string and fragment are where tokens and ids ride. */
export function pathOnly(raw: unknown): string | null {
  const s = str(raw, 2048);
  if (!s) return null;
  try {
    if (/^[a-z]+:\/\//i.test(s)) {
      const u = new URL(s);
      return (u.pathname || "/").slice(0, 512);
    }
  } catch {
    /* fall through to the relative form */
  }
  const cut = s.split(/[?#]/)[0];
  return (cut.startsWith("/") ? cut : `/${cut}`).slice(0, 512);
}

/**
 * Redaction patterns. Deliberately broad on secret SHAPES and narrow on prose:
 * a false positive costs a redacted word in a bug report, a false negative puts
 * a live key in a triage table.
 */
const REDACTIONS: Array<{ kind: string; re: RegExp; replace?: string }> = [
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  {
    kind: "api_key",
    re: /\b(?:sk|rk|ark|pk|ghp|gho|ghu|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g,
  },
  { kind: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  },
  {
    kind: "key_query_param",
    re: /([?&](?:token|key|api_?key|secret|password|passwd|code|sig|signature|access_token)=)[^&#\s"']+/gi,
    replace: "$1[redacted]",
  },
  {
    kind: "high_entropy",
    // 40+ chars of base64/hex with no spaces: keys, hashes, signed blobs.
    re: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-])/g,
  },
];

export interface RedactResult {
  text: string;
  count: number;
  kinds: string[];
}

/** Redact one string. Counts every replacement, not every pattern that hit. */
export function redactText(input: string): RedactResult {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const rule of REDACTIONS) {
    text = text.replace(rule.re, (...args: unknown[]) => {
      count += 1;
      kinds.add(rule.kind);
      if (rule.replace) {
        // `$1` form: keep the parameter name, drop the value.
        const groups = args.slice(0, -2) as string[];
        return rule.replace.replace("$1", groups[1] ?? groups[0] ?? "");
      }
      return "[redacted]";
    });
  }
  return { text, count, kinds: [...kinds].sort() };
}

export interface SanitizedDiag {
  diag: Record<string, unknown> | null;
  redactions: number;
  kinds: string[];
}

/**
 * Whitelist the diagnostic. Anything not named here is dropped silently — the
 * expander renders this object, so an unknown key would be stored-but-unshown.
 * `account.user_id` is never taken from the client: the caller stamps it from
 * the session after this returns.
 *
 * The one key not built here and deliberately present in the stored row is
 * `page.app_sha`: the caller adds it after this call from `appSha()` (env), and
 * a client-supplied value is dropped here. It is an explicit, named exemption:
 * the consumer expander says the server stamps the record with its build sha
 * and shows it in the report as "stamped by the server", and the admin detail
 * pane labels the field exactly that way (feedback-panel.tsx). So it is stored
 * AND shown, not a stored-but-unshown exception (frodo F3, 7331).
 */
export function sanitizeDiag(raw: unknown): SanitizedDiag {
  if (!raw || typeof raw !== "object") return { diag: null, redactions: 0, kinds: [] };
  const src = raw as Record<string, any>;
  let redactions = 0;
  const kinds = new Set<string>();
  const clean = (v: unknown, max: number): string | null => {
    const s = str(v, max);
    if (!s) return null;
    const r = redactText(s);
    redactions += r.count;
    for (const k of r.kinds) kinds.add(k);
    return r.text;
  };

  const pageSrc = (src.page ?? {}) as Record<string, unknown>;
  const browserSrc = (src.browser ?? {}) as Record<string, unknown>;
  const displaySrc = (src.display ?? {}) as Record<string, unknown>;
  const accountSrc = (src.account ?? {}) as Record<string, unknown>;

  const page = {
    url: pathOnly(pageSrc.url),
    route: clean(pageSrc.route, 40),
  };
  const browser = {
    user_agent: clean(browserSrc.user_agent, 300),
    platform: clean(browserSrc.platform, 120),
    language: clean(browserSrc.language, 40),
  };
  const display = {
    screen: clean(displaySrc.screen, 40),
    viewport: clean(displaySrc.viewport, 40),
    device_pixel_ratio: num(displaySrc.device_pixel_ratio),
  };
  const account = {
    signed_in: accountSrc.signed_in === true,
    // Filled by the caller from the session; a client-supplied id is ignored.
    user_id: null as string | null,
  };

  const consoleErrors: Array<Record<string, unknown>> = [];
  if (Array.isArray(src.console_errors)) {
    for (const item of src.console_errors.slice(0, FEEDBACK_CONSOLE_MAX)) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const message = it.message === undefined ? null : clean(it.message, 500);
      consoleErrors.push({
        at: clean(it.at, 40),
        kind: clean(it.kind, 20),
        message,
        source: clean(it.source, 200),
      });
    }
  }

  const failedRequests: Array<Record<string, unknown>> = [];
  if (Array.isArray(src.failed_requests)) {
    for (const item of src.failed_requests.slice(0, FEEDBACK_REQUESTS_MAX)) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      failedRequests.push({
        at: clean(it.at, 40),
        method: clean(it.method, 10),
        // Path only: never headers, never bodies, never the query string.
        url: pathOnly(it.url),
        status: num(it.status),
        ms: num(it.ms),
      });
    }
  }

  const diag = {
    captured_at: clean(src.captured_at, 40),
    page,
    browser,
    display,
    account,
    console_errors: consoleErrors,
    failed_requests: failedRequests,
    redactions: { count: 0, kinds: [] as string[] },
  };
  return { diag, redactions, kinds: [...kinds].sort() };
}

/** Server identity. A header on the request is a claim; env is the build. */
export function appSha(): string | null {
  const v =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.BZ_APP_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "";
  return v.trim() ? v.trim().slice(0, 40) : null;
}

/**
 * The address the EDGE saw, never the address the client claims.
 *
 * `x-real-ip` is written by the edge and cannot be set by the caller through it.
 * X-Forwarded-For is a list the client can prepend to, so its LEFTMOST entry is
 * attacker-chosen: counting that one let one curl rotate a fresh "IP" per
 * request and skip every per-address cap (frodo F2, 7331). The rightmost entry
 * is the hop our own edge appended, so that is the fallback.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = headers.get("x-forwarded-for") || "";
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : "";
}

/**
 * Bucket for an address we could not derive. A public write door must fail
 * CLOSED: the previous shape returned null here and the anonymous arm was
 * `else if (hashed)`, so a request with no derivable address skipped every cap
 * and still wrote a row (frodo F1, 7331). Every unknown-address request now
 * shares one bucket, so it is still capped.
 */
export const UNKNOWN_IP = "unknown";

export function ipHash(ip: string, pepper: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`${pepper}:${ip}`).digest("hex");
}

/** Non-null ip hash: the cap key for both anonymous routes. */
export function anonIpHash(ip: string, pepper: string): string {
  return ipHash(ip || UNKNOWN_IP, pepper) as string;
}

/** 'BZ-FB-XXXXXX' — no 0/O/1/I, because it is read aloud on support calls. */
export function makeRef(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = randomUUID().replace(/-/g, "");
  for (let i = 0; i < 6; i += 1) {
    const n = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
    out += alphabet[n % alphabet.length];
  }
  return `BZ-FB-${out}`;
}

export function newFeedbackId(): string {
  return randomUUID();
}

/**
 * Decoded duration of a WAV clip, from the fmt/data chunks.
 *
 * The rule is "reject by decoded duration, not Content-Length": a client can lie
 * about length, but 96 kB of WAV is 3 s at 16 kHz and 60 s at 800 Hz — the
 * header is the only thing that knows which. Returns null when the bytes are not
 * a parseable WAV; the caller then refuses the clip rather than guessing.
 */
export function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) =>
    String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate = 0;
  let dataSize = 0;
  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= bytes.byteLength) {
      byteRate = view.getUint32(body + 8, true);
    } else if (id === "data") {
      // A truncated upload still declares a size; trust the smaller of the two.
      dataSize = Math.min(size, bytes.byteLength - body);
    }
    off = body + size + (size % 2);
  }
  if (!byteRate || !dataSize) return null;
  return dataSize / byteRate;
}

/**
 * Config: the pepper is required, and the same on every service that can serve
 * the consumer host — `beezilla.net` is `beezilla-web`, `app.devboards.ai` is
 * `agent-relay`, and both write the one feedback table in the one database. A
 * different pepper on the other service would not match an existing ip_hash.
 */
export function feedbackPepper(): string | null {
  const v = (process.env.BZ_FEEDBACK_PEPPER || "").trim();
  return v || null;
}

/** Retention constants, shared by the sweep and its test. */
export const RETENTION = {
  rowMonths: 24,
  diagMonths: 12,
  ipDays: 90,
  asrHitDays: 2,
} as const;

export interface FeedbackInput {
  body: string;
  page_url: string | null;
  route: string | null;
  diag: Record<string, unknown> | null;
  diag_redactions: number;
  user_id: string | null;
  ip_hash: string | null;
  ua: string | null;
  app_sha: string | null;
}

export interface FeedbackLimits {
  anonHour: number;
  anonDay: number;
  userHour: number;
}

export const LIMITS: FeedbackLimits = { anonHour: 5, anonDay: 15, userHour: 20 };

// ── The picture attached to a report (0062) ──────────────────────────────────
//
// A data URL, not a file: the row has to stand on its own so one admin read
// reproduces the report. 1.5 MB of characters is about 1.1 MB of picture, which
// is one phone screenshot at full resolution. Anything bigger is a photo of a
// screen, not evidence, and the person can crop it.
export const SCREENSHOT_MAX = 1_500_000;

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Accept a screenshot only if it is a PNG/JPEG/WebP data URL inside the cap.
 * Returns null for "no picture" — absence is normal, not an error.
 */
export function checkScreenshot(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string; code: string } {
  if (raw == null || raw === "") return { ok: true, value: null };
  const s = String(raw);
  if (s.length > SCREENSHOT_MAX) {
    return { ok: false, error: "That picture is too big. Pick one under about 1 MB.", code: "screenshot_too_big" };
  }
  if (!DATA_URL.test(s)) {
    return { ok: false, error: "A screenshot must be a PNG, JPEG or WebP picture.", code: "bad_screenshot" };
  }
  return { ok: true, value: s };
}

// ── Reading reports back (admins) ────────────────────────────────────────────
//
// id is TEXT in 0059, so nothing here may coerce it to a number. The person who
// wrote a report is joined by user_id, and an anonymous report has NULL there —
// an admin sees "anonymous", never an invented identity.

export interface FeedbackRow {
  id: string;
  ref: string;
  created_at: string;
  body: string;
  route: string | null;
  page_url: string | null;
  status: string;
  has_screenshot: boolean;
  diag_redactions: number;
  email: string | null;
  name: string | null;
}

export async function listFeedback(sql: Sql, limit = 200): Promise<FeedbackRow[]> {
  return sql<FeedbackRow>`
    SELECT f.id, f.ref, f.created_at, f.body, f.route, f.page_url, f.status,
           (f.screenshot IS NOT NULL) AS has_screenshot, f.diag_redactions,
           u.email, u.name
    FROM buzzy_feedback f
    LEFT JOIN "user" u ON u.id = f.user_id
    ORDER BY f.created_at DESC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
}

export async function feedbackScreenshot(sql: Sql, id: string): Promise<string | null> {
  const rows = await sql<{ screenshot: string | null }>`
    SELECT screenshot FROM buzzy_feedback WHERE id = ${id} LIMIT 1
  `;
  return rows[0]?.screenshot ?? null;
}

/** The account a tester signed up with, by email. */
export async function userIdForEmail(sql: Sql, email: string): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM "user" WHERE lower(email) = lower(${email.trim()}) LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export function adminEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    String(env.BZ_ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return !!email && adminEmails(env).has(String(email).trim().toLowerCase());
}
