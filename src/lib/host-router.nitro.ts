/**
 * Host split for the two products that share this deployment.
 *
 * This deployment serves BOTH products, so "which product am I?" is answered by
 * the hostname, not by the build:
 *
 * - **beezilla.net** (consumer) — only BeeZilla surfaces are reachable:
 *   `/buzzy/*` pages and their assets, the BeeZilla APIs, the auth endpoints it
 *   needs, and the capability endpoints a desktop client may point at. Anything
 *   else (the operator board, its API, admin) redirects to `/buzzy/talk`, so a
 *   consumer never lands on Dev Boards furniture.
 *
 * - **every other host** (`app.devboards.ai` and its Railway hostnames) — the
 *   Dev Boards console, unchanged, EXCEPT `/buzzy/*` which 301s to the consumer
 *   domain: BeeZilla now lives on its own product domain.
 *
 * On a console request this handler only ever looks at the path prefix, and on a
 * consumer request it never touches `/api/agent` — which is why it cannot change
 * how the console behaves. Failures here must be loud in tests, not silent in
 * production: the routing is three string comparisons, no I/O.
 */
import { defineEventHandler, getRequestURL, sendRedirect } from "h3";
import type { H3Event } from "h3";
import { CONSUMER_ORIGIN, isConsumerHost } from "./product-hosts";

/**
 * Paths the consumer domain is allowed to serve. Everything else is BeeZilla's
 * front door (`/buzzy/talk`), because a consumer has no use for the operator
 * board, the mission API or the admin surface.
 *
 * `/api/inference*`, `/api/music-token`, `/api/search*` are the capability
 * endpoints a desktop client or the browser spends tokens against; they are
 * harmless on either host and the desktop's cloud URL may be pointed here.
 */
const CONSUMER_PREFIXES = [
  "/buzzy",
  // Crawler files are not product surfaces but a consumer domain must serve its
  // own. Without these the catch-all below answered /robots.txt and /sitemap.xml
  // with a 302 to /buzzy/talk — a crawler asking for rules got a chat page.
  "/robots.txt",
  "/sitemap.xml",

  "/api/auth",
  "/api/buzzy",
  "/api/inference",
  "/api/music-token",
  "/api/search-token",
  "/api/search",
  "/api/recipes",
  "/api/wallet",
  "/brand",
  "/favicon",
  "/assets",
];

/** Request host without port, honouring the proxy header Railway sets. */
function requestHost(event: H3Event): string {
  const headers = event.node?.req?.headers ?? {};
  const forwarded = headers["x-forwarded-host"];
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? headers.host ?? "";
  return String(raw).split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

function isConsumerPath(pathname: string): boolean {
  return CONSUMER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The move is gated: until `beezilla.net` resolves, a 301 on
 * app.devboards.ai/buzzy/* would send every existing bookmark to a dead host.
 * Flip `BZ_MOVE_BUZZY=1` on the service once DNS is verified.
 */
function moveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BZ_MOVE_BUZZY ?? "").trim() === "1";
}

export default defineEventHandler((event) => {
  const url = getRequestURL(event);
  const pathname = url.pathname;
  const host = requestHost(event);

  if (isConsumerHost(host)) {
    // One consumer origin, not two. www and the apex are separate cookie jars, so a
    // sign-in on www leaves the apex signed out (measured: sessions 200 on www, 401
    // on apex in the same browser). www exists to catch typos and old links, so it
    // 301s to the canonical origin before anything else reads the request.
    if (host.startsWith("www.") && CONSUMER_ORIGIN.startsWith("https://")) {
      return sendRedirect(event, `${CONSUMER_ORIGIN}${pathname}${url.search}`, 301);
    }
    if (isConsumerPath(pathname)) return; // BeeZilla surface — let it through.
    // `/` and everything that is not a BeeZilla surface: the consumer front door.
    return sendRedirect(event, "/buzzy/talk", 302);
  }

  // Console host. Move the BeeZilla pages to the product domain — reads only, so
  // a POST to a page path still meets the normal 404/405 rather than a redirect.
  // Gated on BZ_MOVE_BUZZY so this ships safely ahead of DNS.
  if (moveEnabled() && (pathname === "/buzzy" || pathname.startsWith("/buzzy/"))) {
    const method = event.node?.req?.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return;
    return sendRedirect(event, `${CONSUMER_ORIGIN}${pathname}${url.search}`, 301);
  }

  return;
});
