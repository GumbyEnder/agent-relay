/**
 * Shared handler for capability-token endpoints.
 *
 * One shape, two capabilities: inference (our LLM quota) and search (our Brave
 * quota). Both are earned the same way — a signed-in owner asks, we mint a
 * short-lived token bound to their account and scoped to exactly one capability.
 *
 * Kept here rather than duplicated in each nitro file so the auth check, the
 * fail-closed configuration check and the response shape cannot drift apart.
 */
import { getSessionUserFromHeaders } from "./auth/verify.server";
import { mintInferenceToken, type TokenScope } from "./buzzy/inferenceToken";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface CapabilityResponse {
  ok: boolean;
  token?: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  /** where to send the credential — named `baseUrl` for inference, `endpoint` for search */
  endpoint?: string;
  baseUrl?: string;
  model?: string;
  error?: string;
  code?: string;
}

export async function handleCapabilityToken(
  req: Request,
  scope: TokenScope,
  endpoint: () => { url: string; model?: string },
  label: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return json(405, { ok: false, error: `use POST to mint a ${label} token`, code: "method_not_allowed" });
  }

  const user = await getSessionUserFromHeaders(req.headers);
  if (!user) {
    return json(401, { ok: false, error: `sign in to use BeeZilla ${label}`, code: "unauthenticated" });
  }

  const body = (await req.json().catch(() => ({}))) as { ttlSeconds?: unknown };
  const ttlSeconds = typeof body?.ttlSeconds === "number" ? body.ttlSeconds : undefined;

  const minted = mintInferenceToken({ userId: user.id, scope, ttlSeconds });
  if (!minted.ok || !minted.token || !minted.claims) {
    // Configuration, not a user error — say so plainly instead of "unauthorized".
    return json(503, { ok: false, error: minted.error ?? `could not mint a ${label} token`, code: "not_configured" });
  }

  const target = endpoint();
  return json(200, {
    ok: true,
    token: minted.token,
    expiresAt: new Date(minted.claims.exp * 1000).toISOString(),
    expiresInSeconds: minted.claims.exp - minted.claims.iat,
    endpoint: target.url,
    // The inference client already reads `baseUrl`; keep both names rather than
    // break a shipped client for the sake of tidiness.
    baseUrl: target.url,
    model: target.model,
  } satisfies CapabilityResponse);
}
