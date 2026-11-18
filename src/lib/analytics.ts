/**
 * OpenPanel analytics — one instance, two brands.
 *
 * Dev Boards and BeeZilla ship from this repo; the brand flag decides which
 * OpenPanel project (and thus which write client) events land in. Client IDs
 * are public write clients — safe in the bundle, unlike clientSecret.
 *
 * Runtime env note: Railway Docker builds don't receive service variables at
 * build time, so we read the attribute the SSR pass bakes onto <html>
 * (same pattern as src/lib/brand.ts) rather than import.meta.env.
 */
import { OpenPanel } from "@openpanel/web";
import { OPENPANEL_CLIENT_ID } from "@/lib/analytics-id";

// IDs live in analytics-id.ts: the Nitro pages handler needs the same value and
// must not import this module (it would pull the browser SDK into the server bundle).
export const op = new OpenPanel({
  clientId: OPENPANEL_CLIENT_ID,
  trackScreenViews: true,
  trackOutgoingLinks: false,
  trackAttributes: true,
});
