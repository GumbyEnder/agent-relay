/**
 * "What is this process?" — the two axes the deployment has.
 *
 * 1. APP SURFACE (`DEVBOARDS_SURFACE`) — which console this is:
 *    - app.devboards.ai   → `app` (default)
 *    - admin.devboards.ai → `admin`
 *
 * 2. PRODUCT SURFACE (`BZ_SURFACE`) — which product this service serves:
 *    - `all`     (default) one service, hostnames decide (the pre-split shape)
 *    - `buzzy`   the BeeZilla service: consumer paths only, console paths 404
 *    - `console` the Dev Boards service: BeeZilla pages 301 to the product domain
 *
 * Axes are independent on purpose: beezilla.net is `all`/`buzzy` with no app
 * surface, admin.devboards.ai is `admin` + `console`/`all`. Keeping both in one
 * file means there is exactly one place that answers "what am I" — `product-surface.ts`
 * only decides "may I answer THIS request", and it reads the answer from here.
 */

export type AppSurface = "app" | "admin";

export function surfaceFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = typeof process !== "undefined"
    ? process.env
    : {},
): AppSurface | null {
  const raw = (env.DEVBOARDS_SURFACE ?? env.VITE_DEVBOARDS_SURFACE ?? "")
    .trim()
    .toLowerCase();
  if (raw === "admin" || raw === "platform") return "admin";
  if (raw === "app" || raw === "operator" || raw === "board") return "app";
  return null;
}

export function surfaceFromHostname(hostname: string | null | undefined): AppSurface | null {
  const h = (hostname ?? "").trim().toLowerCase();
  if (!h) return null;
  if (h === "admin" || h.startsWith("admin.") || h.includes(".admin.")) return "admin";
  return null;
}

/** Resolve surface for the current process / browser. */
export function resolveSurface(opts?: {
  hostname?: string | null;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): AppSurface {
  const fromEnv = surfaceFromEnv(opts?.env);
  if (fromEnv) return fromEnv;

  const host =
    opts?.hostname ??
    (typeof window !== "undefined" ? window.location.hostname : null);
  const fromHost = surfaceFromHostname(host);
  if (fromHost) return fromHost;

  return "app";
}

/**
 * PRODUCT SURFACE — which product this process serves.
 *
 * `all` is the default and preserves the single-service shape exactly. The value
 * is read once per request by `product-surface.ts`; an unrecognised value falls
 * back to `all` rather than guessing, because guessing wrong here either exposes
 * the operator board on the consumer domain or 404s a paying customer.
 */
export type ProductSurface = "all" | "buzzy" | "console";

export function productSurfaceFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = typeof process !== "undefined"
    ? process.env
    : {},
): ProductSurface {
  const raw = (env.BZ_SURFACE ?? "").trim().toLowerCase();
  return raw === "buzzy" || raw === "console" ? raw : "all";
}

/** Public URL of the admin host (for cross-links from the operator app). */
export function adminPublicUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = typeof process !== "undefined"
    ? process.env
    : {},
): string | null {
  const u = (env.ADMIN_PUBLIC_URL ?? env.VITE_ADMIN_PUBLIC_URL ?? "").trim();
  if (u) return u.replace(/\/$/, "");
  // Sensible default for prod when env not set yet
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    if (h === "app.devboards.ai" || h.endsWith(".devboards.ai")) {
      return "https://admin.devboards.ai";
    }
  }
  return null;
}
