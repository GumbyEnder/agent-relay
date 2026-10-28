/**
 * Nitro handler for /api/inference-token
 *
 * The only way a desktop install obtains access to OUR inference: the signed-in
 * owner asks for a short-lived, inference-scoped token. No shared provider key is
 * ever sent to, stored in, or shipped with the app.
 *
 *   POST /api/inference-token  ->  { ok, token, expiresAt, expiresInSeconds, baseUrl, model }
 *   401  not signed in
 *   405  not a POST
 *   503  this deployment has no signing secret (fail closed — never mint unsigned)
 */
import { defineEventHandler } from "h3";
import { getSessionUserFromHeaders } from "./auth/verify.server";
import { inferenceEndpoint, mintInferenceToken } from "./buzzy/inferenceToken";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default defineEventHandler(async (event) => {
  const req = event.req as Request;

  if (req.method !== "POST") {
    return json(405, { ok: false, error: "use POST to mint an inference token", code: "method_not_allowed" });
  }

  const user = await getSessionUserFromHeaders(req.headers);
  if (!user) {
    return json(401, { ok: false, error: "sign in to use BeeZilla inference", code: "unauthenticated" });
  }

  const body = (await req.json().catch(() => ({}))) as { ttlSeconds?: unknown };
  const ttlSeconds = typeof body?.ttlSeconds === "number" ? body.ttlSeconds : undefined;

  const minted = mintInferenceToken({ userId: user.id, ttlSeconds });
  if (!minted.ok || !minted.token || !minted.claims) {
    // Configuration, not a user error — say so plainly instead of "unauthorized".
    return json(503, { ok: false, error: minted.error ?? "could not mint a token", code: "not_configured" });
  }

  const endpoint = inferenceEndpoint();
  return json(200, {
    ok: true,
    token: minted.token,
    expiresAt: new Date(minted.claims.exp * 1000).toISOString(),
    expiresInSeconds: minted.claims.exp - minted.claims.iat,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
  });
});
