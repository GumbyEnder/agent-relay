/**
 * Sharing a page: the person's side and the public address (see pageShare.ts).
 *
 *   /api/buzzy/page-shares…   the signed-in person: preview, share (after the window's Yes),
 *                             turn off
 *   /buzzy/p/<token>          anyone with the link — no sign-in, no nav, no analytics —
 *                             served with the crawler headers the "Block searches" tick chose
 *
 * Its own handler (registered before the /api/buzzy/** and /buzzy/** wildcards in
 * vite.config.ts) so the one public door beside the document links in chat.nitro.ts is
 * easy to find, and the BeeZilla page handler (pages.nitro.ts) never serves it.
 */
import { defineEventHandler, getMethod } from "h3";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getSql } from "@/lib/db";
import { pageShareRoute, publicHeaders, readPublicPage } from "./pageShare";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Matches art.nitro.ts: h3 hands us node headers, and the auth helper wants a Headers.
function headersFromEvent(event: any): Headers {
  const rawHeaders = event.node?.req?.headers ?? event.req?.headers;
  if (rawHeaders instanceof Headers) return rawHeaders;
  const init: [string, string][] = Object.entries(
    (rawHeaders ?? {}) as Record<string, string | string[] | undefined>,
  ).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]);
  return new Headers(init);
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  const fullPath = event.path ?? "";
  const path = (fullPath.split("?")[0] ?? "").replace(/\/+$/, "");

  // ── The public address ────────────────────────────────────────────────
  const pub = /^\/buzzy\/p\/([^/]+)$/.exec(path);
  if (pub) {
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Use GET.", { status: 405, headers: { allow: "GET, HEAD", "x-robots-tag": "noindex, nofollow" } });
    }
    const page = await readPublicPage(await getSql(), pub[1]!);
    return new Response(method === "HEAD" ? null : page.html, {
      status: page.status,
      headers: publicHeaders(page.status, page.searchBlocked),
    });
  }

  // ── The person's own side ─────────────────────────────────────────────
  const rest = /^\/api\/buzzy\/page-shares(?:\/(.*))?$/.exec(path);
  if (!rest) return json(404, { ok: false, error: "Not found", code: "not_found" });

  const user = await getSessionUserFromHeaders(headersFromEvent(event));
  if (!user) return json(401, { ok: false, error: "Sign in required", code: "signed_out" });

  let body: unknown = null;
  if (method === "POST") {
    try { body = await event.req.json(); } catch { /* an empty body is refused by the route */ }
  }
  const query = new URLSearchParams(fullPath.includes("?") ? fullPath.slice(fullPath.indexOf("?") + 1) : "");
  let which = rest[1] ?? "";
  try { which = decodeURIComponent(which); } catch { return json(404, { ok: false, error: "Not found", code: "not_found" }); }
  const out = await pageShareRoute(await getSql(), user.id, method, which, query, body);
  return json(out.status, out.body);
});
