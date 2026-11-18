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
 */
import { BZ_BRAND } from "@/lib/brand";

export const DEVBOARDS_CLIENT_ID = "875ba120-0402-42f8-aa19-b26a56c1c09b";
export const BEEZILLA_CLIENT_ID = "ddc73803-6e93-42d5-ba20-eaf0e30b637f";

export const OPENPANEL_CLIENT_ID = BZ_BRAND ? BEEZILLA_CLIENT_ID : DEVBOARDS_CLIENT_ID;
