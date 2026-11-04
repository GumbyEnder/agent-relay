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
  // One capsule for the desktop: inference (chat, ASR, voice) and music both spend
  // OUR provider money, both are metered, and both are revoked the same way.
  handleCapabilityToken(event.req as Request, ["inference", "music"], () => {
    const { baseUrl, model } = inferenceEndpoint();
    return { url: baseUrl, model };
  }, "inference"),
);
