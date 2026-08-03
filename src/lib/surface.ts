/**
 * App surface: operator board (`app`) vs platform admin (`admin`).
 *
 * Production intent: two Railway services from the same repo
 * - app.devboards.ai  → DEVBOARDS_SURFACE=app (default)
 * - admin.devboards.ai → DEVBOARDS_SURFACE=admin
 *
 * Hostname heuristics also apply so a single deploy can route by Host
 * (useful before the second service is fully wired).
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
