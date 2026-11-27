#!/usr/bin/env node
/**
 * test-sketch-load-gate.mjs — the Sketch page must never write over a board it has
 * not read back.
 *
 * WHY THIS EXISTS: load() fetches /api/buzzy/art asynchronously while `doc` already
 * exists as an empty default. Before this guard, a GET that failed (401 while the
 * session settled, a 404, a dropped request) was indistinguishable from "this board
 * is empty": the page fitted the empty doc to the stage, strokes 0, and the next
 * autosave / pagehide / visibilitychange posted it over the marks the server still
 * held. Measured against a built server, signed in, same probe, only this file
 * swapped: before, the failed read posted 2 saves of 0 strokes and the server board
 * went 8 -> 0; after, 0 saves and the board stayed 8.
 *
 * A page-order bug cannot be caught by a unit test of a function, so this is a
 * witness on the source: the ordering that makes the page safe, asserted literally.
 * It is deliberately brittle — if someone rewrites load() and drops the gate, this
 * goes red and they have to think about the race.
 *
 * The mutant to run against it: delete the two `boardState` checks at the top of
 * flushSave() — GATE-1 and GATE-2 go red.
 *
 * Usage: node scripts/test-sketch-load-gate.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "public", "buzzy", "sketch.html"), "utf8");

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); return; }
  fails.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}
// -1 when the literal is gone: a missing gate is a FAIL, not a crash in the harness.
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

console.log("sketch load gate — public/buzzy/sketch.html");

// ── the save path ──────────────────────────────────────────────────────────
const flush = body("flushSave");
const holdAt = flush.indexOf('if (boardState === "loading")');
const refuseAt = flush.indexOf('if (boardState === "unavailable")');
const firstPost = flush.indexOf('fetch("/api/buzzy/art"');
check("GATE-1 a save asked for mid-load is held, not posted", holdAt > 0 && holdAt < firstPost,
  "flushSave must check boardState === \"loading\" before its POST");
check("GATE-2 an unread board is never written", refuseAt > 0 && refuseAt < firstPost,
  "flushSave must refuse while boardState === \"unavailable\"");
check("GATE-3 the hold is remembered, not dropped", /pendingSave = true/.test(flush),
  "a held save must set pendingSave so load() can run it");
check("GATE-4 the refusal is said out loud", /boardNotLoaded\(\)/.test(flush),
  "an unavailable board must surface boardNotLoaded(), not a silent return");

// ── the read path ──────────────────────────────────────────────────────────
const load = body("load");
check("GATE-5 a non-OK answer is a failure, not an empty board",
  /if \(!r\.ok\) throw new Error\(/.test(load),
  "load() must throw on !r.ok — JSON error bodies look like an empty board");
check("GATE-6 the answer must claim ok before it is trusted",
  /if \(!d \|\| d\.ok !== true\) throw new Error\(/.test(load),
  "load() must require d.ok === true");
const appliedAt = at("doc.strokes = d.board.strokes", at("function load("));
const readyAtInLoad = SRC.indexOf('boardState = "ready"', at("function load("));
const fitAtInLoad = SRC.indexOf("if (!doc.w || doc.w < 2) fitDoc();", at("function load("));
check("GATE-7 the document becomes ready only after the boards are applied",
  appliedAt >= 0 && readyAtInLoad > appliedAt,
  "boardState = ready must come after doc.strokes is replaced");
check("GATE-8 ready is set before the page fits or paints",
  readyAtInLoad >= 0 && fitAtInLoad > readyAtInLoad,
  "fitDoc() must not run before the read is trusted");
check("GATE-9 a held save runs once the read lands", /if \(pendingSave\) \{ pendingSave = false; flushSave\(\); \}/.test(load),
  "load() must drain pendingSave after painting");
check("GATE-10 one retry before giving up", /load\(attempt \+ 1\)/.test(load),
  "a dropped request must get one retry");
const catchAt = load.indexOf("if (attempt < 1)");
check("GATE-11 after the retry the page refuses to own the board",
  catchAt > 0 && /boardState = "unavailable"/.test(load.slice(catchAt)) && /boardNotLoaded\(\)/.test(load.slice(catchAt)),
  "the terminal catch must set unavailable and say so");

// ── fitDoc is only reached when the document is ours (or is new) ───────────
const calls = [];
for (let i = SRC.indexOf("fitDoc("); i >= 0; i = SRC.indexOf("fitDoc(", i + 1)) {
  if (SRC.slice(i, i + 10) === "fitDoc() {") continue;      // the definition
  calls.push(i);
}
check("GATE-12 exactly three fitDoc call sites", calls.length === 3, "found " + calls.length);
const loadStart = at("function load(");
check("GATE-13 a new board still fits itself", SRC.includes("if (!jobId) { fitDoc(); return; }"),
  "the no-job path fits the stage");
check("GATE-14 the failed-read fit is inside the terminal catch",
  calls.filter((i) => i > loadStart).every((i) => i > catchAt || (appliedAt >= 0 && i > appliedAt)),
  "no fit before the read is applied");

// ── nothing else may edit or spend on an unread document ───────────────────
check("GATE-15 a dropped or pasted image cannot land on an unread board",
  body("addImage").includes('if (boardState !== "ready")'),
  "addImage() must gate on boardState");
const pointerBlock = SRC.slice(SRC.indexOf('canvas.addEventListener("pointerdown"'), SRC.indexOf('canvas.addEventListener("pointermove"'));
check("GATE-16 drawing waits for the read, pan/zoom do not",
  pointerBlock.indexOf('if (boardState !== "ready")') > pointerBlock.indexOf('tool === "pan"'),
  "the pointer gate must sit after the view-only pan branch");
check("GATE-17 Create will not flatten an unread board",
  /if \(boardState !== "ready"\) \{ setStatus\(boardState === "loading" \? "Loading the board — one moment\."/.test(SRC),
  "a paid render of an empty document must be refused");

// ── the diagnostics the probe reads ────────────────────────────────────────
check("GATE-18 the page reports its own load state",
  /boardState: boardState, pendingSave: pendingSave/.test(SRC),
  "window.__bzSketch.state() must expose boardState for the probe");

console.log("\n" + pass + " passed, " + fails.length + " failed");
if (fails.length) {
  console.log("FAILED:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("ALL SKETCH LOAD-GATE CHECKS PASSED");
