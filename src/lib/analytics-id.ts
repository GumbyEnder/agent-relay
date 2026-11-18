/**
 * OpenPanel write client ids, in one place.
 *
 * Client ids are public write clients — safe in a bundle and safe in served HTML,
 * unlike clientSecret. They live here (not in analytics.ts) because the static
 * /buzzy/* pages are served by Nitro, not by React: importing analytics.ts into a
 * server handler would drag the whole browser SDK into the server bundle.
 *
 * Brand decides the project: BeeZilla traffic must land in the BeeZilla project,
 * never in Dev Boards' — the two have separate funnels and separate dashboards.
 *
 * The HOST decides the brand, exactly as it does for the mailer's From name
 * (`brandLabel` in mailer.ts). One Railway service answers beezilla.net AND
 * app.devboards.ai and that service carries no BZ_BRAND, so a module-level
 * constant read from `process.env` could only ever answer "Dev Boards".
 * Measured on live 9b5918f (2026-11-18): beezilla.net/buzzy/talk served
 * 875ba120… — the Dev Boards project — on every page view. Passing the request
 * host is therefore required, not optional; the env flag survives only as the
 * fallback for callers with no request (background jobs, build-time imports).
 */
import { BZ_BRAND } from "@/lib/brand";
import { isConsumerHost } from "@/lib/product-hosts";

export const DEVBOARDS_CLIENT_ID = "875ba120-0402-42f8-aa19-b26a56c1c09b";
export const BEEZILLA_CLIENT_ID = "ddc73803-6e93-42d5-ba20-eaf0e30b637f";

/** True when the hostname is the console's own (never the consumer's). */
function isConsoleHost(host: string): boolean {
  // Exact or dot-suffixed, so a lookalike like `notdevboards.ai` cannot claim the
  // console's client id. `endsWith("devboards.ai")` alone would accept it.
  return (
    host === "devboards.ai" ||
    host.endsWith(".devboards.ai") ||
    host === "devboards.up.railway.app"
  );
}

/**
 * The OpenPanel write client id for the host that served the request.
 *
 * Unknown hosts (previews, localhost) fall back to the env flag so behaviour
 * there is unchanged.
 */
export function openpanelClientId(host?: string | null): string {
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (h && isConsumerHost(h)) return BEEZILLA_CLIENT_ID;
  if (h && isConsoleHost(h)) return DEVBOARDS_CLIENT_ID;
  return BZ_BRAND ? BEEZILLA_CLIENT_ID : DEVBOARDS_CLIENT_ID;
}
