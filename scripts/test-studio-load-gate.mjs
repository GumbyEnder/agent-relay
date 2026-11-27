#!/usr/bin/env node
/**
 * test-studio-load-gate.mjs — the Studio page must never write a form it did not read.
 *
 * WHY THIS EXISTS: load() fetches /api/buzzy/studio?job= asynchronously while the page
 * is already rendering an empty form (state = null). Before this guard, a GET that
 * failed (401 while the session settled, a 404, a 500, a dropped request) left the
 * empty form on screen with "Save brief" live, and planFromForm() sent
 * prompt:"", lyrics:"", instruments:[] — savePlan merges those over the stored plan.
 * Measured against a built server, signed in, same probe, only this file swapped:
 * before, one click on Save brief took {prompt:"KEEP THIS BRIEF", lyrics:"KEEP THESE
 * WORDS", instruments:["piano","cello"]} to {prompt:"", lyrics:"", instruments:[]};
 * after, the read is refused, the buttons are off, and the plan is untouched.
 *
 * This is a witness on the source ordering, not a unit test: the safety is "the gate
 * runs before the POST", which a page rewrite can quietly drop.
 *
 * The mutant to run against it: change the body of canWrite() to `return true;` —
 * GATE-5 goes red (the rest still passes, because the calls are still in place);
 * delete the `if (!canWrite()) return;` calls and GATE-7..GATE-10 go red.
 *
 * Usage: node scripts/test-studio-load-gate.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "public", "buzzy", "studio.html"), "utf8");

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); return; }
  fails.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}
const at = (needle, from = 0) => SRC.indexOf(needle, from);

// The body of a top-level `function NAME(` in the page's single IIFE, by brace count.
function body(name) {
  const start = at("function " + name + "(");
  if (start < 0) return "";
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(open, i + 1); }
  }
  return "";
}

// An addEventListener("click") handler for a button id, sliced to the next `});`.
function handler(id) {
  const start = at('$("' + id + '").addEventListener("click"');
  if (start < 0) return "";
  const end = SRC.indexOf("\n    });", start);
  return end < 0 ? "" : SRC.slice(start, end);
}

console.log("studio load gate — public/buzzy/studio.html");

// ── the flag ───────────────────────────────────────────────────────────────
check("GATE-1 the page starts unread", at("var loaded = false;") > 0,
  "studio.html must declare `var loaded = false;`");

// ── the read path ──────────────────────────────────────────────────────────
const load = body("load");
check("GATE-2 a failed read leaves the page unread and says so",
  load.indexOf("loaded = false;") > 0 && load.indexOf("loaded = false;") < load.indexOf("return;", load.indexOf("if (!res.ok)")),
  "the !res.ok branch must set loaded = false before it returns");
check("GATE-3 the page is read only after the body lands",
  load.indexOf("state = res.body;") > 0 && load.indexOf("loaded = true;") > load.indexOf("state = res.body;"),
  "loaded = true must follow state = res.body, never precede it");
check("GATE-4 a dropped request is a failed read too",
  /\.catch\(function \(\) \{\s*loaded = false;/.test(load),
  "the GET needs a .catch that leaves loaded = false");
check("GATE-4b a failed read switches the writes off",
  load.indexOf("armWrites(false);") > 0 && load.indexOf("armWrites(false);") < load.indexOf("setStatus(", load.indexOf("if (!res.ok)")),
  "the !res.ok branch must call armWrites(false)");
{
  const failAt = load.indexOf("if (!res.ok)");
  const failBranch = failAt < 0 ? "" : load.slice(failAt, load.indexOf("return;", failAt) + 7);
  check("GATE-4c a failed read says what to do about it",
    /reload before saving/.test(failBranch),
    "the !res.ok status must say reload before saving, whatever the server error said");
}

// ── the guard ──────────────────────────────────────────────────────────────
const can = body("canWrite");
check("GATE-5 the guard refuses an unread page",
  can.indexOf("if (loaded) return true;") > 0 && can.indexOf("return false;") > can.indexOf("if (loaded) return true;"),
  "canWrite() must return true only when loaded, false otherwise");
check("GATE-6 the refusal is said out loud", /setStatus\(/.test(can) && /Reload before saving/.test(can),
  "canWrite() must tell the person why nothing was saved");

// ── the write paths: the gate runs before the POST ─────────────────────────
for (const [id, label] of [["savePlan", "GATE-7 Save brief"], ["saveLyrics", "GATE-8 Save lyrics"],
  ["renderBtn", "GATE-9 Create track"], ["editBtn", "GATE-10 Change this passage"]]) {
  const h = handler(id);
  const gate = h.indexOf("if (!canWrite()) return;");
  const post = h.indexOf('api("POST"');
  const busyAt = h.search(/busy\((this|btn)/);
  check(label + " refuses to write an unread form",
    h.length > 0 && gate > 0 && post > gate,
    "$(\"" + id + "\") must call canWrite() before its POST");
  check(label + " checks before it locks the button",
    h.length > 0 && gate > 0 && busyAt > gate,
    "$(\"" + id + "\") must check canWrite() before busy()");
}

// ── arming order ───────────────────────────────────────────────────────────
const armed = SRC.lastIndexOf("armWrites(false);");
const boot = SRC.lastIndexOf("\n    load();");
check("GATE-11 nothing writes before the first read", armed > 0 && boot > armed,
  "armWrites(false) must run before load()");

if (fails.length) {
  console.log("\nSTUDIO LOAD-GATE CHECKS FAILED (" + pass + " passed, " + fails.length + " failed)");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("\nALL STUDIO LOAD-GATE CHECKS PASSED (" + pass + ")");
