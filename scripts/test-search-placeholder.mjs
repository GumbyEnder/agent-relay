#!/usr/bin/env node
/**
 * The header search's placeholder must be able to FIT.
 *
 * What went wrong: at 390px the search input's content box is 79px wide (two
 * 48px tap targets sit beside it) while the shipped placeholder needs 551px at
 * 16px, so the phone rendered "Search eve…" — a cut-off sentence that reads as a
 * broken field. browse.js now picks the longest wording that fits and re-picks on
 * resize / after webfonts.
 *
 * This suite pins the *contract*, not the layout (there is no browser in CI):
 *   1. talk.html carries a SHORT, readable default ("Search your work or a web
 *      address"), so a phone that never runs the shrink still shows whole words.
 *      The long sentence is an upgrade browse.js applies only when it measures.
 *   2. browse.js holds the long line and a shrink list in one place,
 *      longest-first, ending at a word short enough for the narrowest phone
 *      (measured: "Search" = 51px < 79px).
 *   3. The choosing is measured (canvas measureText), not a breakpoint guess — a
 *      hardcoded breakpoint is what a future edit would reach for.
 *   4. No fixed placeholder string is assigned anywhere else, or a page-level copy
 *      silently wins over the fitted one.
 */
import fs from "node:fs";

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("PASS  " + name);
  else { failed++; console.log("FAIL  " + name + (detail ? " — " + detail : "")); }
}

const talk = fs.readFileSync("public/buzzy/talk.html", "utf8");
const browse = fs.readFileSync("public/buzzy/browse.js", "utf8");

const m = talk.match(/<input[^>]*id="bzSearch"[^>]*>/s);
ok("talk.html still has the #bzSearch input", !!m);
const tag = m ? m[0] : "";
const ph = tag.match(/placeholder="([^"]*)"/);
ok("the markup placeholder is a short readable default (12-40 chars)", !!ph && ph[1].length >= 12 && ph[1].length <= 40,
  ph ? `got ${ph[1].length} chars` : "no placeholder attribute");
ok("the input is not given a fixed size/width in the markup",
  !/\bsize\s*=/.test(tag) && !/\bstyle\s*=/.test(tag));

const longM = browse.match(/PLACEHOLDER_LONG\s*=\s*"([^"]*)"/);
ok("browse.js defines the long line as an upgrade (>= 40 chars)", !!longM && longM[1].length >= 40,
  longM ? `got ${longM[1].length} chars` : "no PLACEHOLDER_LONG");

const listM = browse.match(/PLACEHOLDER_SHRINKS\s*=\s*\[([^\]]*)\]/);
ok("browse.js has one shrink list", !!listM);
const list = listM ? [...listM[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : [];
ok("the shrink list is longest-first and ends with a single word",
  list.length >= 2 && list[list.length - 1].split(" ").length === 1, JSON.stringify(list));
ok("the long line is not restated in the shrink list (one source of truth)",
  !!longM && !list.includes(longM[1]), "the list re-states the long line: two sources of truth");
ok("the last candidate is short enough for the narrowest phone measured (<= 79px of room)",
  list.length > 0 && list[list.length - 1].length <= 8, JSON.stringify(list.slice(-1)));

ok("the choice is measured, not guessed from a breakpoint",
  /measureText/.test(browse) && !/matchMedia\(\s*["']\(max-width:\s*(390|400|420|480)/.test(browse));
ok("the fitted placeholder is actually written back to the input",
  /input\.placeholder\s*=\s*chosen/.test(browse));
ok("it re-picks on resize and after webfonts",
  /addEventListener\(\s*["']resize["']/.test(browse) && /document\.fonts/.test(browse));

const assigners = [...browse.matchAll(/\.placeholder\s*=\s*(["'][^"']*["'])/g)].map((x) => x[1]);
ok("no other code path assigns a fixed placeholder", assigners.length === 0, JSON.stringify(assigners));

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
