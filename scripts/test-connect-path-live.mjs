#!/usr/bin/env node
/**
 * Does the Connect window land on a page that EXISTS?
 *
 * The empty-box bug: `connectAccount` opened `${cloud}/connect`, a path no
 * deployment served. Every other test used a fake cloud that *did* serve it, so
 * the whole suite passed while a shipped app showed a blank window. This probe
 * asks the real deployments the one question the fakes cannot.
 *
 *   node scripts/test-connect-path-live.mjs
 *   node scripts/test-connect-path-live.mjs https://example.up.railway.app
 *
 * Exit 0 = every target answers 200 for CONNECT_PATH. Exit 1 = a blank window is
 * waiting to happen. Errors are named, never swallowed.
 */
import { CONNECT_PATH, DEFAULT_CLOUD_URL } from "../desktop/connect.mjs";

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [...new Set([DEFAULT_CLOUD_URL, process.env.BZ_CLOUD_URL].filter(Boolean))];

if (!targets.length) {
  console.error("no targets — set BZ_CLOUD_URL or pass a URL");
  process.exit(1);
}

let failed = 0;
for (const raw of targets) {
  const base = raw.replace(/\/+$/, "");
  const url = `${base}${CONNECT_PATH}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: "follow", headers: { accept: "text/html" } });
    const body = await res.text();
    const ms = Date.now() - started;
    // A 404 with a 200-shaped app shell is the failure mode that looks fine in a
    // status-only check, so the body has to carry something a person can act on.
    const looksLikeShell = /id="root"|data-theme=/.test(body) && body.length < 4000;
    const ok = res.status === 200 && !/not found|404/i.test(body.slice(0, 400));
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${url}  ${res.status}  ${body.length}b  ${ms}ms` +
        (ok ? "" : `  ← the Connect window would render this${looksLikeShell ? " (blank shell)" : ""}`),
    );
    if (!ok) failed++;
  } catch (err) {
    console.log(`FAIL  ${url}  ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

console.log(failed ? `\n${failed} target(s) would open an empty window` : "\nall targets serve a real page at CONNECT_PATH");
process.exit(failed ? 1 : 0);
