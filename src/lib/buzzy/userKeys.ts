/**
 * The person's own AI key, in the cloud version too.
 *
 * Owner, 2026-11-18: "Even on the cloud mode, I need to be able to put in my own API
 * key." A key is saved per account, sealed with AES-256-GCM, and used for that
 * account's chat turns through withLlmOverride() (llm.ts). The page never gets the
 * key back: it sees only the provider address, the model and the last four
 * characters, so a stolen page or log line cannot leak it.
 *
 * Any OpenAI-compatible endpoint works (OpenRouter, OpenAI, Together, Groq, a
 * self-hosted server…). Only https addresses are accepted, plus localhost for a
 * desktop runtime — a key must never travel in clear text.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Sql } from "@/lib/db";
import type { LlmOverride } from "./llm";

/** Ready-made addresses for the common providers; "custom" takes any https URL. */
export const KEY_PROVIDERS: Record<string, { label: string; baseUrl: string }> = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  together: { label: "Together", baseUrl: "https://api.together.xyz/v1" },
};

function sealKey(): Buffer {
  const raw =
    process.env.BZ_KEY_SEAL_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    "beezilla-dev-key-seal-not-for-prod";
  return createHash("sha256").update("bz-user-ai-key:" + raw, "utf8").digest();
}

/** Seal a secret. Format: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function sealSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(), iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Open a sealed secret, or null when it is missing, tampered with or sealed elsewhere. */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed || !sealed.startsWith("v1.")) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(parts[1]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Whether an address on this machine or its private network may be used. Only a
 * local runtime (the desktop app, or a deployment whose own model is local) may: on
 * the cloud, a "provider address" of http://127.0.0.1:… or 10.x.x.x would make the
 * server call its own private services with whatever the person typed (SSRF).
 */
function allowPrivate(): boolean {
  if ((process.env.BZ_ALLOW_LOCAL_AI_KEY_URL ?? "").trim() === "1") return true;
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])\b/i.test((process.env.BZ_CHAT_BASE_URL ?? "").trim());
}

/** Loopback, private, link-local, carrier-grade NAT and "internal" names. */
export function isPrivateHost(host: string): boolean {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return mapped ? isPrivateHost(mapped[1]!) : false;
  }
  return false;
}

/** An address a key may be sent to: https to a public host; http or private only for a local runtime. */
export function cleanBaseUrl(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!s || s.length > 300) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  const priv = isPrivateHost(u.hostname);
  if (priv && !allowPrivate()) return null;
  if (u.protocol === "https:") return u.toString().replace(/\/+$/, "");
  if (u.protocol === "http:" && priv && allowPrivate()) return u.toString().replace(/\/+$/, "");
  return null;
}

// A public name can still resolve to a private address. Checked before a key is
// saved and before each turn uses it; answers are kept for ten minutes.
const dnsSeen = new Map<string, { ok: boolean; at: number }>();
export async function resolvesPublic(baseUrl: string): Promise<boolean> {
  if (allowPrivate()) return true;
  let host = "";
  try { host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, ""); } catch { return false; }
  if (isIP(host)) return !isPrivateHost(host);
  const hit = dnsSeen.get(host);
  if (hit && Date.now() - hit.at < 600_000) return hit.ok;
  let ok = false;
  try {
    const all = await lookup(host, { all: true });
    ok = all.length > 0 && all.every((a) => !isPrivateHost(a.address));
  } catch { ok = false; }
  dnsSeen.set(host, { ok, at: Date.now() });
  return ok;
}

/** What the page may see about a saved key. Never the key itself. */
export interface KeySummary {
  saved: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string | null;
  hint?: string;
  updatedAt?: string;
}

function providerOf(baseUrl: string): string {
  for (const [id, p] of Object.entries(KEY_PROVIDERS)) if (p.baseUrl === baseUrl) return id;
  return "custom";
}

export async function keySummary(sql: Sql, userId: string): Promise<KeySummary> {
  const rows = await sql`
    SELECT base_url, model, key_hint, updated_at FROM buzzy_user_ai_keys WHERE user_id = ${userId}`;
  const r = rows[0];
  if (!r) return { saved: false };
  const baseUrl = String(r.base_url);
  return {
    saved: true,
    provider: providerOf(baseUrl),
    baseUrl,
    model: r.model ? String(r.model) : null,
    hint: String(r.key_hint),
    updatedAt: r.updated_at ? new Date(String(r.updated_at)).toISOString() : undefined,
  };
}

export type SaveKeyResult = { ok: true; summary: KeySummary } | { ok: false; error: string; code: string };

/** Save (or replace) the person's key. `provider` picks a ready address; "custom" needs baseUrl. */
export async function saveKey(
  sql: Sql,
  userId: string,
  input: { provider?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown },
): Promise<SaveKeyResult> {
  const provider = String(input.provider ?? "openrouter");
  const chosen = KEY_PROVIDERS[provider];
  const baseUrl = chosen ? chosen.baseUrl : cleanBaseUrl(input.baseUrl);
  if (!baseUrl) return { ok: false, code: "bad_url", error: "That address can't be used. It has to start with https:// and be a public address." };
  if (!(await resolvesPublic(baseUrl))) {
    return { ok: false, code: "bad_url", error: "That address can't be reached from BeeZilla, or it points inside a private network." };
  }
  const apiKey = String(input.apiKey ?? "").trim();
  if (apiKey.length < 8 || apiKey.length > 400 || /\s/.test(apiKey)) {
    return { ok: false, code: "bad_key", error: "That doesn't look like an API key. Paste the whole key." };
  }
  const modelRaw = String(input.model ?? "").trim();
  if (modelRaw.length > 120 || /[\s<>"']/.test(modelRaw)) {
    return { ok: false, code: "bad_model", error: "That model name can't be used." };
  }
  const model = modelRaw || null;
  const hint = apiKey.slice(-4);
  await sql`
    INSERT INTO buzzy_user_ai_keys (user_id, base_url, model, key_sealed, key_hint, updated_at)
    VALUES (${userId}, ${baseUrl}, ${model}, ${sealSecret(apiKey)}, ${hint}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      base_url = EXCLUDED.base_url, model = EXCLUDED.model,
      key_sealed = EXCLUDED.key_sealed, key_hint = EXCLUDED.key_hint, updated_at = now()`;
  return { ok: true, summary: await keySummary(sql, userId) };
}

export async function deleteKey(sql: Sql, userId: string): Promise<void> {
  await sql`DELETE FROM buzzy_user_ai_keys WHERE user_id = ${userId}`;
}

/** The override for this person's turns, or null when they have no (usable) key. */
export async function overrideFor(sql: Sql, userId: string): Promise<LlmOverride | null> {
  try {
    const rows = await sql`
      SELECT base_url, model, key_sealed FROM buzzy_user_ai_keys WHERE user_id = ${userId}`;
    const r = rows[0];
    if (!r) return null;
    const apiKey = openSecret(String(r.key_sealed));
    const baseUrl = cleanBaseUrl(r.base_url);
    if (!apiKey || !baseUrl || !(await resolvesPublic(baseUrl))) return null;
    return { baseUrl, apiKey, model: r.model ? String(r.model) : null };
  } catch {
    // An older database without the table: the deployment's own key still works.
    return null;
  }
}
