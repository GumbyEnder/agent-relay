/**
 * Nitro handler for /api/search — OUR search gateway.
 *
 * This is the half that makes "search works out of the box" true: the Brave key lives
 * here, server-side, and never travels to a client. A desktop install presents the
 * short-lived, search-scoped token it was minted, and we spend OUR quota on its
 * behalf.
 *
 *   200  Brave-shaped JSON (web.results[]) — the client already knows how to read it,
 *        so there is exactly one parser in the product
 *   401  no/invalid token, wrong scope, or expired
 *   405  not a GET
 *   429  upstream rate limit (passed through so the client can say so)
 *   503  no Brave key on this deployment (fail closed — never search with nothing)
 *
 * Deliberate limits: the token is the only credential (no cookies, no API key), the
 * query is capped in length, and the result count is clamped. Anything that reaches
 * Brave is logged by count only, never by query text.
 */
import { defineEventHandler, getQuery } from "h3";
import { verifyInferenceToken } from "./buzzy/inferenceToken";

const MAX_QUERY_CHARS = 400;
const MAX_COUNT = 10;
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const braveKey = () => (process.env.BZ_BRAVE_KEY ?? "").trim();
const braveBase = () => (process.env.BZ_BRAVE_URL ?? "").trim() || BRAVE_ENDPOINT;

export default defineEventHandler(async (event) => {
  const key = braveKey();
  if (!key) {
    // Fail closed BEFORE looking at the token: a 401 would tell a correctly-signed-in
    // user that their credential is bad when the deployment simply has no quota.
    return json(503, { ok: false, code: "not_configured", error: "BeeZilla search has no provider key on this deployment" });
  }

  if (event.method !== "GET") {
    return json(405, { ok: false, code: "method_not_allowed", error: "use GET" });
  }

  const auth = String(event.headers.get("authorization") ?? "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return json(401, { ok: false, code: "unauthenticated", error: "a BeeZilla search token is required" });
  }

  const verified = verifyInferenceToken(token, { scope: "search" });
  if (!verified.ok) {
    // One message for every failure mode: callers do not get to probe which part of
    // the token was wrong.
    return json(401, { ok: false, code: "invalid_token", error: "this search token is not valid" });
  }

  const query = getQuery(event);
  const q = String(query.q ?? "").trim();
  if (!q) return json(400, { ok: false, code: "bad_request", error: "q is required" });
  if (q.length > MAX_QUERY_CHARS) {
    return json(400, { ok: false, code: "bad_request", error: `q must be under ${MAX_QUERY_CHARS} characters` });
  }

  const count = Math.max(1, Math.min(MAX_COUNT, Number.parseInt(String(query.count ?? "5"), 10) || 5));
  const url = new URL(braveBase());
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(count));
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("text_decorations", "false");
  if (query.freshness) url.searchParams.set("freshness", String(query.freshness).slice(0, 16));

  try {
    const upstream = await fetch(url, {
      headers: { accept: "application/json", "x-subscription-token": key },
      signal: AbortSignal.timeout(9000),
    });

    if (upstream.status === 429) {
      return json(429, { ok: false, code: "rate_limited", error: "search is rate limited right now" });
    }
    if (!upstream.ok) {
      return json(502, { ok: false, code: "provider_error", error: `search provider answered ${upstream.status}` });
    }

    // Pass the provider payload through unchanged: one shape for the client, and no
    // place for us to accidentally editorialise a result.
    const body = await upstream.text();
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return json(502, {
      ok: false,
      code: "provider_unreachable",
      error: `could not reach the search provider: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});
