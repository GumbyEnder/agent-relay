/**
 * The OpenPanel write client must follow the HOST, not the build or the env.
 *
 * Guard for the 2026-11-18 regression: one service answers beezilla.net and
 * app.devboards.ai with no BZ_BRAND set, so a module-level const from process.env
 * sent every BeeZilla page view into the Dev Boards project.
 *
 * Run: npx tsx scripts/test-analytics-brand.ts
 */
import {
  BEEZILLA_CLIENT_ID,
  DEVBOARDS_CLIENT_ID,
  openpanelClientId,
} from "../src/lib/analytics-id";

let failed = 0;
const eq = (label: string, got: string, want: string) => {
  if (got === want) {
    console.log(`ok   ${label}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${label}: got ${got}, want ${want}`);
};

for (const host of ["beezilla.net", "beezilla.net:443", "WWW.BeeZilla.net", "www.beezilla.net"]) {
  eq(`consumer host ${host}`, openpanelClientId(host), BEEZILLA_CLIENT_ID);
}
for (const host of ["app.devboards.ai", "devboards.ai", "devboards.up.railway.app"]) {
  eq(`console host ${host}`, openpanelClientId(host), DEVBOARDS_CLIENT_ID);
}
// No host and unknown hosts keep the env fallback (BZ_BRAND unset here).
for (const host of [null, undefined, "", "localhost:3000", "preview-abc.up.railway.app"]) {
  eq(`fallback ${String(host)}`, openpanelClientId(host), DEVBOARDS_CLIENT_ID);
}
// Lookalikes must not inherit a product identity: neither a suffix game on the
// console domain nor a consumer domain embedded in someone else's name.
for (const host of ["notdevboards.ai", "beezilla.net.evil.com", "devboards.ai.evil.com"]) {
  eq(`lookalike ${host}`, openpanelClientId(host), DEVBOARDS_CLIENT_ID);
}
if (failed) {
  console.error(`\nanalytics brand: FAILED — ${failed} case(s)`);
  process.exit(1);
}
console.log("\nanalytics brand: all checks passed");
