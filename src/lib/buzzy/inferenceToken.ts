/**
 * Short-lived inference tokens — how a desktop install uses OUR inference.
 *
 * The desktop app must never hold a shared provider key. Instead the owner's
 * account mints a token that is:
 *
 *   - SCOPED:   only usable for inference, never for account/recipe/admin calls;
 *   - SHORT:    15 minutes by default, hard-capped, so a leaked token is stale
 *               almost immediately and needs no revocation list;
 *   - BOUND:    it names the user it was minted for, so the gateway can meter and
 *               rate-limit per account rather than per IP;
 *   - SIGNED:   HMAC-SHA256 over the claims with a server secret, verified with a
 *               constant-time compare.
 *
 * FAIL CLOSED. With no signing secret we refuse to mint at all: an unsigned or
 * default-secret token would be forgeable by anyone who reads this file.
 *
 * Token format (opaque to the client, one line, url-safe):
 *   bz1.<base64url(claims-json)>.<base64url(hmac)>
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_PREFIX = "bz1";
export const DEFAULT_TTL_SECONDS = 900; // 15 minutes
export const MAX_TTL_SECONDS = 3600;

/** What a token is allowed to be used for. Nothing else is mintable. */
export type TokenScope = "inference" | "search" | "music" | "image";

export interface InferenceClaims {
  /** the account the token was minted for */
  sub: string;
  /** the first capability (kept for tokens minted before scopes[] existed) */
  scope: TokenScope;
  /**
   * Every capability this token carries. A desktop install keeps ONE credential, so
   * the minted capsule covers inference and music; each gateway tail still demands
   * the scope it needs and nothing else is reachable with it.
   */
  scopes?: TokenScope[];
  /** the account's plan at mint time — observability only; quota reads the DB */
  plan?: string;
  /** issued at, epoch seconds */
  iat: number;
  /** expires at, epoch seconds */
  exp: number;
  /** unique per mint, so a gateway can dedupe/audit without storing the token */
  jti: string;
}

export type VerifyFailure = "malformed" | "bad_signature" | "expired" | "scope" | "no_secret";

const SCOPES: readonly TokenScope[] = ["inference", "search", "music", "image"];

export interface VerifyResult {
  ok: boolean;
  claims?: InferenceClaims;
  reason?: VerifyFailure;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The signing secret, or "" when the deployment is not configured for minting. */
export function signingSecret(raw = process.env.BZ_INFERENCE_SIGNING_KEY): string {
  const value = (raw ?? "").trim();
  // A secret short enough to guess is the same as no secret at all.
  return value.length >= 32 ? value : "";
}

const sign = (secret: string, payload: string): string =>
  b64url(createHmac("sha256", secret).update(payload).digest());

export interface MintOptions {
  userId: string;
  /** defaults to "inference" so existing callers keep their meaning */
  scope?: TokenScope | TokenScope[];
  /** recorded in the claims so a log line says which plan was in force */
  plan?: string;
  ttlSeconds?: number;
  secret?: string;
  now?: number;
}

export interface MintedToken {
  ok: boolean;
  token?: string;
  claims?: InferenceClaims;
  error?: string;
}

/**
 * Mint a token for one account. Returns {ok:false, error} rather than throwing so a
 * route can answer with a status and a reason a human can act on.
 */
export function mintInferenceToken(opts: MintOptions): MintedToken {
  const secret = opts.secret ?? signingSecret();
  if (!secret) {
    return { ok: false, error: "inference tokens are not configured on this deployment (BZ_INFERENCE_SIGNING_KEY)" };
  }
  const userId = (opts.userId ?? "").trim();
  if (!userId) return { ok: false, error: "a user is required to mint a token" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const requested = Number.isFinite(opts.ttlSeconds) ? Math.floor(opts.ttlSeconds!) : DEFAULT_TTL_SECONDS;
  const ttl = Math.min(Math.max(requested, 60), MAX_TTL_SECONDS);

  const requestedScopes = Array.isArray(opts.scope) ? opts.scope : [opts.scope ?? "inference"];
  const scopes = requestedScopes.filter((v, i) => requestedScopes.indexOf(v) === i);
  if (scopes.length === 0) return { ok: false, error: "a token needs at least one scope" };
  const unknown = scopes.find((v) => !SCOPES.includes(v));
  if (unknown) return { ok: false, error: `unknown token scope: ${String(unknown)}` };

  const claims: InferenceClaims = {
    sub: userId,
    scope: scopes[0],
    scopes,
    ...(opts.plan ? { plan: opts.plan } : {}),
    iat: now,
    exp: now + ttl,
    jti: randomBytes(12).toString("hex"),
  };
  const payload = b64url(JSON.stringify(claims));
  return { ok: true, token: `${TOKEN_PREFIX}.${payload}.${sign(secret, payload)}`, claims };
}

/** Verify a token exactly as a gateway would. */
export function verifyInferenceToken(
  token: string,
  opts: { secret?: string; now?: number; scope?: TokenScope } = {},
): VerifyResult {
  const secret = opts.secret ?? signingSecret();
  if (!secret) return { ok: false, reason: "no_secret" };

  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: "malformed" };
  const [, payload, signature] = parts;

  const expected = sign(secret, payload);
  // Length must match before timingSafeEqual, which throws on unequal buffers.
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: InferenceClaims;
  try {
    claims = JSON.parse(fromB64url(payload).toString("utf8")) as InferenceClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // A token is only good for the capabilities it was minted for: nothing on this
  // gateway answers a plain search token, and music needs its own claim.
  const required = opts.scope ?? "inference";
  const held = Array.isArray(claims?.scopes) && claims.scopes.length > 0 ? claims.scopes : [claims?.scope];
  if (
    !claims?.sub ||
    !held.every((v) => SCOPES.includes(v as TokenScope)) ||
    !held.includes(required) ||
    !Number.isFinite(claims.exp)
  ) {
    return { ok: false, reason: "scope" };
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (claims.exp <= now) return { ok: false, reason: "expired", claims };

  return { ok: true, claims };
}

/** The endpoint and model a client should use, so the desktop app never guesses. */
export function inferenceEndpoint(): { baseUrl: string; model: string } {
  return {
    baseUrl: (process.env.BZ_INFERENCE_BASE_URL ?? "https://inference-api.nousresearch.com/v1").replace(/\/+$/, ""),
    model: process.env.BZ_INFERENCE_MODEL ?? "z-ai/glm-5.3-flash",
  };
}
