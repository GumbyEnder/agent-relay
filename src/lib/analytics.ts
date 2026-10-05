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
import { BZ_BRAND } from "@/lib/brand";

const DEVBOARDS_CLIENT_ID = "875ba120-0402-42f8-aa19-b26a56c1c09b";
const BEEZILLA_CLIENT_ID = "ddc73803-6e93-42d5-ba20-eaf0e30b637f";

export const op = new OpenPanel({
  clientId: BZ_BRAND ? BEEZILLA_CLIENT_ID : DEVBOARDS_CLIENT_ID,
  trackScreenViews: true,
  trackOutgoingLinks: false,
  trackAttributes: true,
});
