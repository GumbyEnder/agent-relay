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

export interface InferenceClaims {
  /** the account the token was minted for */
  sub: string;
  /** always "inference" — a token for anything else is refused */
  scope: "inference";
  /** issued at, epoch seconds */
  iat: number;
  /** expires at, epoch seconds */
  exp: number;
  /** unique per mint, so a gateway can dedupe/audit without storing the token */
  jti: string;
}

export type VerifyFailure = "malformed" | "bad_signature" | "expired" | "scope" | "no_secret";

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

  const claims: InferenceClaims = {
    sub: userId,
    scope: "inference",
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
  opts: { secret?: string; now?: number } = {},
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
  if (!claims?.sub || claims.scope !== "inference" || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: "malformed" };
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
