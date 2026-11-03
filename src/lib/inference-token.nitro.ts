/**
 * Nitro handler for /api/inference-token
 *
 * The only way a desktop install obtains access to OUR inference: the signed-in
 * owner asks for a short-lived, inference-scoped token. No shared provider key is
 * ever sent to, stored in, or shipped with the app.
 *
 *   200 { ok, token, expiresAt, expiresInSeconds, baseUrl, model }
 *   401 not signed in · 405 not a POST · 503 no signing secret (fail closed)
 */
import { defineEventHandler } from "h3";
import { handleCapabilityToken } from "./capability-token.server";
import { inferenceEndpoint } from "./buzzy/inferenceToken";

export default defineEventHandler((event) =>
  handleCapabilityToken(event.req as Request, "inference", () => {
    const { baseUrl, model } = inferenceEndpoint();
    return { url: baseUrl, model };
  }, "inference"),
);
