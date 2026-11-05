/**
 * Nitro handler for /api/inference/music — OUR music quota, without OUR key.
 *
 * The desktop can hold `BZ_ELEVEN_KEY` today, which means a shipped install either
 * carries a shared secret or asks a civilian to paste one. Neither is acceptable
 * for a product sold as a capability. This is the passthrough that lets a client
 * spend our ElevenLabs quota with a short-lived `bz1.*` token (scope `music`) and
 * nothing else: the key stays here.
 *
 *   200  audio/mpeg (bytes, exactly as the provider returned them)
 *   400  bad JSON / empty prompt
 *   401  no token, wrong scope, forged or expired
 *   402  the provider says the plan does not cover music — passed through
 *   405  not a POST
 *   429  provider rate limit
 *   503  no music key or no signing secret on this deployment (fail closed)
 */
import { defineEventHandler } from "h3";
import { verifyInferenceToken } from "./buzzy/inferenceToken";
import { generateMusic, musicConfigured } from "./buzzy/music";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default defineEventHandler(async (event) => {
  if (!musicConfigured()) {
    // Fail closed before auth: a 401 would tell a correctly-signed-in user their
    // credential is bad when the deployment simply has no music plan.
    return json(503, { ok: false, code: "not_configured", error: "music has no provider key on this deployment" });
  }
  if (event.method !== "POST") {
    return json(405, { ok: false, code: "method_not_allowed", error: "use POST" });
  }

  const auth = String(event.headers.get("authorization") ?? "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return json(401, { ok: false, code: "unauthenticated", error: "a BeeZilla music token is required" });
  }
  const verified = verifyInferenceToken(token, { scope: "music" });
  if (!verified.ok) {
    return json(401, { ok: false, code: "invalid_token", error: "this music token is not valid" });
  }

  let body: { prompt?: string; seconds?: number } = {};
  try {
    body = (await event.req.json()) as { prompt?: string; seconds?: number };
  } catch {
    return json(400, { ok: false, code: "bad_json", error: "send { prompt, seconds }" });
  }
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return json(400, { ok: false, code: "no_prompt", error: "prompt is required" });
  const seconds = Math.min(300, Math.max(3, Number(body.seconds) || 20));

  const started = Date.now();
  const made = await generateMusic(prompt, seconds * 1000);
  if (!made.ok || !made.bytes) {
    const status = made.code === "paid_plan_required" ? 402 : made.code === "rate_limited" ? 429 : 502;
    return json(status, { ok: false, code: made.code, error: made.error });
  }
  console.log(`[buzzy/music] ${verified.claims?.sub ?? "?"} ok ms=${Date.now() - started} bytes=${made.bytes.length}`);
  // Buffer is a Uint8Array at runtime; the DOM typing wants a plain one.
  return new Response(new Uint8Array(made.bytes), {
    status: 200,
    headers: {
      "content-type": made.contentType || "audio/mpeg",
      "cache-control": "no-store",
      "x-bz-seconds": String(seconds),
    },
  });
});
