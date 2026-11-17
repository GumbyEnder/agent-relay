/**
 * Which product is this request, and is this service allowed to answer it?
 *
 * One repo now ships two services (stage 2 of the split, 2026-11-17). The
 * console service keeps serving everything. The BeeZilla service serves ONLY the
 * consumer surface: `/buzzy/*` pages and assets, the BeeZilla APIs, auth, the
 * capability endpoints a client spends tokens against, and the platform
 * healthcheck. A console path arriving on the consumer service is a
 * misconfiguration, so it is refused loudly (404) rather than redirected to a
 * chat page, where nobody would notice.
 *
 * `BZ_SURFACE` selects the service's job:
 *   all     — default; exactly today's behaviour (one service, host routing only)
 *   buzzy   — the consumer service
 *   console — the operator service (Buzzy pages 301 to the product domain)
 *
 * This module is deliberately pure: it takes the host, the path, the method and
 * the env, and returns a decision. `scripts/test-surface-routing.ts` drives it
 * through the whole matrix in CI, because a routing bug here is a product bug on
 * a page a customer is looking at.
 */

import { productSurfaceFromEnv, type ProductSurface } from "./surface";

export type Surface = ProductSurface;


export type SurfaceDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string; status: 301 | 302 }
  | { kind: "deny"; status: 404; reason: string };

/**
 * Paths the consumer service may serve. Anything else is not BeeZilla's.
 *
 * `/api/inference*`, `/api/music-token`, `/api/search*` are the capability
 * endpoints a desktop client or the browser spends tokens against; they are
 * harmless on either host and the desktop's cloud URL may be pointed here.
 */
export const CONSUMER_PREFIXES = [
  "/buzzy",
  // Crawler files are not product surfaces but a consumer domain must serve its
  // own. Without these the catch-all answered /robots.txt and /sitemap.xml with a
  // 302 to /buzzy/talk — a crawler asking for rules got a chat page.
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

/**
 * Liveness only. The platform healthcheck (`railway.json`) probes
 * `/api/agent/health` on every service, including the consumer one — it answers
 * "the process is up", not "here is the board", so it is served on both. Refusing
 * it would mean a green consumer service reported as unhealthy and rolled back.
 */
export const HEALTH_PATHS = ["/api/agent/health"];

export function surfaceFromEnv(env: Record<string, string | undefined> = process.env): Surface {
  return productSurfaceFromEnv(env);
}

export function moveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BZ_MOVE_BUZZY ?? "").trim() === "1";
}

const matches = (pathname: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

export function isConsumerPath(pathname: string): boolean {
  return matches(pathname, CONSUMER_PREFIXES);
}

export function isHealthPath(pathname: string): boolean {
  return matches(pathname, HEALTH_PATHS);
}

export interface SurfaceInput {
  surface: Surface;
  /** Request host, lowercased, port stripped. */
  host: string;
  /** Request pathname, already decoded. */
  pathname: string;
  method: string;
  /** `?a=b`, or "" — carried through redirects. */
  search: string;
  moveEnabled: boolean;
  consumerOrigin: string;
  /** `beezilla.net`, `www.beezilla.net`, … — from product-hosts. */
  isConsumerHost: boolean;
}

export function decideSurface(input: SurfaceInput): SurfaceDecision {
  const { surface, host, pathname, method, search, consumerOrigin } = input;

  if (input.isConsumerHost) {
    // One consumer origin, not two. www and the apex are separate cookie jars, so
    // a sign-in on www leaves the apex signed out (measured: sessions 200 on www,
    // 401 on apex in the same browser). www exists to catch typos and old links.
    if (host.startsWith("www.") && consumerOrigin.startsWith("https://")) {
      return { kind: "redirect", to: `${consumerOrigin}${pathname}${search}`, status: 301 };
    }
    if (isConsumerPath(pathname)) return { kind: "allow" };
    if (isHealthPath(pathname)) return { kind: "allow" };
    // `/` and everything that is not a BeeZilla surface: the consumer front door.
    return { kind: "redirect", to: "/buzzy/talk", status: 302 };
  }

  // Not a consumer host: this is the console's hostname, a Railway hostname, or a
  // client pointed at the API. What we serve depends on what this service is for.
  if (surface === "buzzy") {
    if (isConsumerPath(pathname) || isHealthPath(pathname)) return { kind: "allow" };
    return {
      kind: "deny",
      status: 404,
      reason: `this service serves BeeZilla only; "${pathname}" belongs to the console`,
    };
  }

  // Console (and `all`, the single-service default). Move the BeeZilla pages to the
  // product domain — reads only, so a POST to a page path still meets the normal
  // 404/405 rather than a redirect. Gated on BZ_MOVE_BUZZY so this ships safely
  // ahead of DNS.
  if (input.moveEnabled && (pathname === "/buzzy" || pathname.startsWith("/buzzy/"))) {
    if (method !== "GET" && method !== "HEAD") return { kind: "allow" };
    return { kind: "redirect", to: `${consumerOrigin}${pathname}${search}`, status: 301 };
  }

  return { kind: "allow" };
}
