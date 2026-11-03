/**
 * Nitro handler for /api/search-token
 *
 * Our Brave quota, without the Brave key: a signed-in owner gets a short-lived,
 * search-scoped token and points it at OUR gateway. BYOK users never call this —
 * their own key goes straight to Brave.
 *
 *   200 { ok, token, expiresAt, expiresInSeconds, endpoint }
 *   401 not signed in · 405 not a POST · 503 no gateway/signing secret configured
 *
 * FAIL CLOSED: with no BZ_SEARCH_GATEWAY_URL there is nowhere for the token to be
 * spent, so minting one would hand out a credential that cannot work.
 */
import { defineEventHandler } from "h3";
import { handleCapabilityToken } from "./capability-token.server";

const gateway = (process.env.BZ_SEARCH_GATEWAY_URL ?? "").trim().replace(/\/+$/, "");

export default defineEventHandler((event) => {
  if (!gateway) {
    // Refuse BEFORE auth or minting: there is nowhere to spend the token, so a 401
    // would send the user off to sign in for something that cannot work anyway.
    return new Response(
      JSON.stringify({
        ok: false,
        error: "BeeZilla search is not deployed yet (BZ_SEARCH_GATEWAY_URL)",
        code: "not_configured",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return handleCapabilityToken(event.req as Request, "search", () => ({ url: gateway }), "search");
});
