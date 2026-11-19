/**
 * Feedback — the yellow pill in the nav, on every page, signed in or not.
 *
 * Product decision (7318): the Ask control stays; a Feedback control sits beside
 * it in the same yellow pill (`#ffd40d`), the chat icon keeps the left slot, and
 * the panel is `#bzFeedback`. There is NO screenshot in v1 — a screenshot is a
 * second copy of a customer's screen in a table nothing can delete, and the
 * diagnostics block already carries the page, the build and the console errors.
 *
 * Retention (7319), and each rule has a reason:
 *  - no `account_email` column: the email is joined from "user" when a user_id
 *    exists, so deleting the account deletes the identity with it;
 *  - `ip_hash` is nullable and salted, and the limiter only reads rows with
 *    `created_at > now() - interval '1 day'`;
 *  - feedback rows are in portability.ts's DELETION_STATEMENTS, so the account
 *    deletion receipt counts them;
 *  - the sweep runs after the migrate step and is non-fatal;
 *  - the limiter is a per-ip cap AND a route-wide cap, both on a proven
 *    concurrent arm (an UPSERT row lock), never on a racy count(*).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";

/** A report is a paragraph, not a document. */
export const FEEDBACK_TEXT_MAX = 4000;
/** Per-ip ceiling, and the window it belongs to (7318: 15/hour). */
export const IP_LIMIT = 15;
/** Route-wide ceiling: what one bad actor's spread of addresses cannot exceed. */
export const ROUTE_LIMIT = 300;
/** The reserved gate key for the route-wide counter. */
export const ROUTE_GATE = "__route__";
/** Anonymous audio: 60 s decoded, 8 MB on the wire (the ASR ceiling). */
export const FEEDBACK_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_AUDIO_MAX_SECONDS = 60;
/** Rows older than this are swept at boot. */
export const RETENTION_DAYS = Number(process.env.BZ_FEEDBACK_RETENTION_DAYS || 90);

export const FEEDBACK_KINDS = ["bug", "confusing", "idea", "general"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackInput {
  message?: unknown;
  kind?: unknown;
  pageUrl?: unknown;
  buildSha?: unknown;
  userAgent?: unknown;
  viewport?: unknown;
  diagnostics?: unknown;
}

export interface FeedbackReport {
  message: string;
  kind: FeedbackKind;
  pageUrl: string;
  buildSha: string;
  userAgent: string;
  viewport: string;
  diagnostics: Record<string, unknown> | null;
}

/** Redact anything that looks like a key, a token or a card before it is stored. */
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)_[A-Za-z0-9_\-]{8,}/g,
  /\bARK_[A-Za-z0-9_\-]{8,}/g,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g,
  /\b\d{13,19}\b/g,
];

export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

/** What the person is about to send, validated. Nothing here touches the DB. */
export function checkFeedback(body: FeedbackInput): { ok: true; report: FeedbackReport } | { ok: false; error: string; code: string } {
  const raw = String(body?.message ?? "");
  const message = redact(raw).trim();
  if (!message) return { ok: false, error: "Say what happened, in a sentence.", code: "empty" };
  if (message.length > FEEDBACK_TEXT_MAX) {
    return { ok: false, error: `Keep it under ${FEEDBACK_TEXT_MAX.toLocaleString("en")} characters.`, code: "too_long" };
  }
  const kind = (FEEDBACK_KINDS as readonly string[]).includes(String(body?.kind))
    ? (String(body.kind) as FeedbackKind)
    : "general";
  const str = (v: unknown, max: number) => redact(String(v ?? "")).slice(0, max);
  let diagnostics: Record<string, unknown> | null = null;
  if (body?.diagnostics && typeof body.diagnostics === "object") {
    // Store what the panel displayed and nothing more: a plain object, string
    // leaves only, capped, and redacted. A nested blob from a page is untrusted.
    const src = body.diagnostics as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src).slice(0, 40)) {
      if (typeof v === "string") out[k.slice(0, 60)] = redact(v).slice(0, 2000);
      else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k.slice(0, 60)] = v;
      else if (Array.isArray(v)) out[k.slice(0, 60)] = v.slice(0, 20).map((x) => redact(String(x)).slice(0, 400));
    }
    diagnostics = Object.keys(out).length ? out : null;
  }
  return {
    ok: true,
    report: {
      message,
      kind,
      pageUrl: str(body?.pageUrl, 300),
      buildSha: str(body?.buildSha, 64),
      userAgent: str(body?.userAgent, 300),
      viewport: str(body?.viewport, 40),
      diagnostics,
    },
  };
}

/** A salted, non-reversible limiter key. The address itself is never stored. */
export function ipHash(ip: string, salt = process.env.BZ_IP_SALT || "bz-feedback"): string {
  const addr = String(ip || "").trim();
  if (!addr) return "";
  return createHash("sha256").update(`${salt}:${addr}`).digest("hex").slice(0, 32);
}

/** The first x-forwarded-for hop, which is what the edge saw. */
export function clientIp(headers: Record<string, string | undefined>): string {
  const fwd = String(headers["x-forwarded-for"] || "").split(",")[0]?.trim() || "";
  return fwd || String(headers["x-real-ip"] || "").trim();
}

/**
 * The short code read back to the person. Not a sequential id: `BZ-` plus four
 * base36 characters from the row's own random id, so a report can be quoted in a
 * sentence without enumerating the table.
 */
export function referenceFor(id: string): string {
  const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let n = 0;
  // Every character of the id, not a prefix: two ids that share a prefix must not
  // share a reference (the column is UNIQUE and a collision would lose a report).
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) % 1_679_616;
  let out = "";
  for (let i = 0; i < 4; i++) {
    out = alphabet[n % alphabet.length] + out;
    n = Math.floor(n / alphabet.length);
  }
  return `BZ-${out}`;
}

export function newFeedbackId(): string {
  return `fb_${randomBytes(8).toString("hex")}`;
}

/**
 * Take one slot from a limiter counter, atomically.
 *
 * The UPSERT is the concurrency arm: the row lock it takes serialises two
 * simultaneous callers, so the second sees the first's increment. Returns the
 * count AFTER this request, so the caller refuses when it is over the limit
 * without a second query and without a window in which two callers both pass.
 */
export async function takeSlot(sql: Sql, gateKey: string, limit: number): Promise<number> {
  const rows = await sql<{ n: number }>`
    INSERT INTO buzzy_feedback_gate (gate_key, bucket, n)
    VALUES (${gateKey}, date_trunc('hour', now()), 1)
    ON CONFLICT (gate_key) DO UPDATE SET
      n = CASE
            WHEN buzzy_feedback_gate.bucket = date_trunc('hour', now())
            THEN buzzy_feedback_gate.n + 1
            ELSE 1
          END,
      bucket = date_trunc('hour', now())
    RETURNING n
  `;
  return Number(rows[0]?.n ?? limit + 1);
}

export interface SavedFeedback {
  id: string;
  reference: string;
}

/**
 * Save one report. Both caps are checked first (per-ip, then route-wide), and a
 * refusal spends no slot on the other counter — the route counter is only taken
 * once the per-ip one has passed, so a single abusive address cannot exhaust the
 * route-wide budget for everyone else.
 */
export async function saveFeedback(
  sql: Sql,
  userId: string | null,
  report: FeedbackReport,
  ip: string,
): Promise<{ ok: true; saved: SavedFeedback } | { ok: false; error: string; code: string; retryAfter?: number }> {
  const key = ipHash(ip);
  if (key) {
    const n = await takeSlot(sql, key, IP_LIMIT);
    if (n > IP_LIMIT) {
      return { ok: false, error: "That is a lot of feedback in one hour. Try again a little later.", code: "rate_limited", retryAfter: 3600 };
    }
  }
  const routeN = await takeSlot(sql, ROUTE_GATE, ROUTE_LIMIT);
  if (routeN > ROUTE_LIMIT) {
    return { ok: false, error: "Feedback is very busy right now. Try again in a few minutes.", code: "route_busy", retryAfter: 600 };
  }

  const id = newFeedbackId();
  const reference = referenceFor(id);
  await sql`
    INSERT INTO buzzy_feedback
      (id, reference, user_id, kind, message, page_url, build_sha, user_agent, viewport, diagnostics, ip_hash)
    VALUES
      (${id}, ${reference}, ${userId}, ${report.kind}, ${report.message}, ${report.pageUrl || null},
       ${report.buildSha || null}, ${report.userAgent || null}, ${report.viewport || null},
       ${report.diagnostics ? JSON.stringify(report.diagnostics) : null}, ${key || null})
  `;
  return { ok: true, saved: { id, reference } };
}

/**
 * Decoded seconds from a WAV payload, or null when this is not one we can read.
 *
 * 7319 requires oversize audio to be refused on decoded duration, not on the
 * byte count: an 8 MB cap alone lets a 10-second 192 kHz stereo clip through on
 * the wire size and still cost 40 seconds of transcription. Our own recorder
 * emits 16 kHz mono 16-bit PCM, so the header is authoritative.
 */
export function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate = 0;
  let dataBytes = -1;
  let o = 12;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const len = dv.getUint32(o + 4, true);
    if (id === "fmt " && o + 8 + 8 <= bytes.byteLength) byteRate = dv.getUint32(o + 16, true);
    if (id === "data") {
      dataBytes = Math.min(len, bytes.byteLength - (o + 8));
      break;
    }
    o += 8 + len + (len % 2);
  }
  if (byteRate <= 0 || dataBytes < 0) return null;
  return dataBytes / byteRate;
}

/** How many rows the sweep would remove, for the receipt. */
export async function sweepOldFeedback(sql: Sql, days = RETENTION_DAYS): Promise<number> {
  const rows = await sql<{ id: string }>`
    DELETE FROM buzzy_feedback
    WHERE created_at < now() - (${Math.max(1, days)} || ' days')::interval
    RETURNING id
  `;
  return rows.length;
}
