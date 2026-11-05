/**
 * Nitro handler for /api/music-token — a music-scoped capability token.
 *
 * Same contract as /api/search-token: the token names the account and expires in
 * minutes; it is spent at /api/inference/music, where our ElevenLabs key lives.
 * BYOK clients never call this — their own key is their business.
 */
import { defineEventHandler } from "h3";
import { handleCapabilityToken } from "./capability-token.server";

const gateway = (process.env.BZ_MUSIC_GATEWAY_URL ?? "").trim().replace(/\/+$/, "");

export default defineEventHandler((event) => {
  if (!gateway) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "BeeZilla music gateway is not deployed yet (BZ_MUSIC_GATEWAY_URL)",
        code: "not_configured",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return handleCapabilityToken(event.req as Request, "music", () => ({ url: `${gateway}/music` }), "music");
});
