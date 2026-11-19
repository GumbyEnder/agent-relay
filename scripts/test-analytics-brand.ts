/**
 * The OpenPanel write client must follow the HOST, not the build or the env.
 *
 * Guard for the 2026-11-18 regression: one service answers beezilla.net and
 * app.devboards.ai with no BZ_BRAND set, so a module-level const from process.env
 * sent every BeeZilla page view into the Dev Boards project.
 *
 * WHY THIS ASSERTS THE CLASSIFIER AND NOT JUST THE ID: with BZ_BRAND unset the env
 * fallback and the console id are the same string, so `openpanelClientId("junk")`
 * returning DEVBOARDS_CLIENT_ID proves nothing about whether "junk" was recognised.
 * Every lookalike and unknown-host case therefore asserts `analyticsProjectForHost`
 * (which can distinguish) and only then the id it implies.
 *
 * Run: npx tsx scripts/test-analytics-brand.ts
 */
import {
  analyticsProjectForHost,
  BEEZILLA_CLIENT_ID,
  DEVBOARDS_CLIENT_ID,
  openpanelClientId,
} from "../src/lib/analytics-id";

let failed = 0;
const eq = (label: string, got: string | null, want: string | null) => {
  if (got === want) {
    console.log(`ok   ${label}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${label}: got ${String(got)}, want ${String(want)}`);
};

// Consumer hosts classify as the consumer project, port and case ignored.
for (const host of ["beezilla.net", "beezilla.net:443", "WWW.BeeZilla.net", "www.beezilla.net"]) {
  eq(`consumer class ${host}`, analyticsProjectForHost(host), "beezilla");
  eq(`consumer id ${host}`, openpanelClientId(host), BEEZILLA_CLIENT_ID);
}

// The console's own hosts classify as the console project.
for (const host of ["app.devboards.ai", "devboards.ai", "devboards.up.railway.app"]) {
  eq(`console class ${host}`, analyticsProjectForHost(host), "devboards");
  eq(`console id ${host}`, openpanelClientId(host), DEVBOARDS_CLIENT_ID);
}

// No host and unknown hosts classify as NOTHING, however the fallback id reads.
for (const host of [null, undefined, "", "localhost:3000", "preview-abc.up.railway.app"]) {
  eq(`unclassified ${String(host)}`, analyticsProjectForHost(host), null);
  eq(`fallback id ${String(host)}`, openpanelClientId(host), DEVBOARDS_CLIENT_ID);
}

// Lookalikes are unclassified — not silently rounded into the console. This is the
// assertion that can fail: a suffix game on either domain would classify them.
for (const host of ["notdevboards.ai", "beezilla.net.evil.com", "devboards.ai.evil.com"]) {
  eq(`lookalike class ${host}`, analyticsProjectForHost(host), null);
  eq(`lookalike id ${host}`, String(openpanelClientId(host) === BEEZILLA_CLIENT_ID), "false");
}

if (failed) {
  console.error(`\nanalytics brand: FAILED — ${failed} case(s)`);
  process.exit(1);
}
console.log("\nanalytics brand: all checks passed");
