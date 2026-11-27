#!/usr/bin/env npx tsx
/**
 * test-draw-board.ts — CR-16: the sketch tool's gate, its layout, and its board.
 *
 * WHY THIS EXISTS: draw_board writes over the owner's own Sketch board, so two things
 * must stay true without a browser in the loop:
 *   1. it is offered ONLY on a turn that asked for a diagram (a conversational turn has
 *      no tool surface at all, so it can never see one), and only once the deliverable
 *      gate is open — the same gate render_document sits behind;
 *   2. what it saves is a board the art route (and therefore the Sketch page) accepts.
 *
 * Asserts, in order:
 *   GATE-1  a closed gate offers no draw_board (and no tools at all: an ordinary turn)
 *   GATE-2  an open gate without diagram intent still withholds it
 *   GATE-3  an open gate with diagram intent offers it
 *   GATE-4  withheld, it explains itself in words a person can read
 *   INTENT  the funnel brief is a diagram request; questions and "make it faster" are not
 *   BOARD-1 "sketch the funnel: visitors -> signups -> paid" draws 3 boxes and 2 arrows
 *   BOARD-2 the boxes are layered left to right, in order, level with each other
 *   BOARD-3 the saved document is the sketch page's own shape (v3, strokes, order, size)
 *   BOARD-4 a follow-up appends exactly one box and one connector, keeping the old marks
 *   BOARD-5 a second whole diagram is refused rather than replacing the board
 *   BOARD-6 the 40-box ceiling and the unknown-connector refusal are named errors
 *   ART-1   the saved board is POSTed to /api/buzzy/art and read back unchanged (real HTTP)
 *   ART-2   the served Sketch page renders the mark types it wrote (rect/text/arrow/line)
 *
 * The HTTP half boots `.output/server/index.mjs` like test-buzzy-art-cap.mjs does, so
 * `npm run build` must have run first. Pass a baseUrl as argv[2] to drive a live server
 * (it must then trust its own origin and write dev mail to argv[3]).
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { offeredToolNames, offeredTools, refusalFor, policyFor } from "../src/lib/buzzy/toolRegistry";
import { isDiagramRequest } from "../src/lib/buzzy/intent";
import { drawBoard, MAX_BOARD_NODES, type BoardDoc } from "../src/lib/buzzy/drawBoard";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(ROOT, ".output", "server", "index.mjs");

let failures = 0;
function check(name: string, cond: unknown, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures += 1;
}

const FUNNEL = "sketch the funnel: visitors -> signups -> paid";

// ── The gate ─────────────────────────────────────────────────────────
console.log("# gate");
const closed = offeredToolNames({ draftGateOpen: false });
check("GATE-1a  a closed gate offers no draw_board", !closed.includes("draw_board"), closed.join(","));
check("GATE-1b  the tool is declared on the diagram gate (not always, not plain draft)", policyFor("draw_board")?.gate === "diagram" && policyFor("draw_board")?.offered === true, String(policyFor("draw_board")?.gate));
check("GATE-1c  a closed gate offers no draw_board, and the always-tools never include it", (offeredTools({ draftGateOpen: false }) as unknown[]).length > 0 && !offeredToolNames({ draftGateOpen: false }).includes("draw_board"));

const openNoIntent = offeredToolNames({ draftGateOpen: true });
check("GATE-2  an open gate without a diagram request withholds it", !openNoIntent.includes("draw_board"), openNoIntent.join(","));
check("GATE-2b  ...while the document renderers are offered (same gate, wider)", openNoIntent.includes("render_document"));

const openIntent = offeredToolNames({ draftGateOpen: true, diagram: true });
check("GATE-3  an open gate with a diagram request offers it", openIntent.includes("draw_board"), openIntent.join(","));
check("GATE-3b  and it stays out of a documents-only turn's way", !offeredToolNames({ draftGateOpen: true, documentsOnly: true }).includes("draw_board"));

const whyClosed = String(refusalFor("draw_board", { draftGateOpen: false }));
const whyNoIntent = String(refusalFor("draw_board", { draftGateOpen: true }));
check("GATE-4a  withheld for the gate, it says the deliverable is not ready", /not available yet/i.test(whyClosed) && /diagram|sketch/i.test(whyClosed), whyClosed);
check("GATE-4b  withheld for intent, it says nothing here asked for a diagram", /not offered in this turn/i.test(whyNoIntent) && /diagram/i.test(whyNoIntent), whyNoIntent);
check("GATE-4c  allowed, it has no refusal", refusalFor("draw_board", { draftGateOpen: true, diagram: true }) === null);

// ── Intent ───────────────────────────────────────────────────────────
console.log("# intent");
const intents: Array<[string, boolean]> = [
  [FUNNEL, true],
  ["draw a flow chart of the onboarding", true],
  ["make me a mind map for the launch", true],
  ["sketch how a customer gets from signup to paid", true],
  ["map out the support journey", true],
  ["what does visitors -> paid mean?", false],
  ["make the process faster", false],
  ["write me a document about funnels", false],
  ["how do I draw a flow chart in Figma?", false],
];
for (const [text, want] of intents) {
  check(`INTENT  ${want ? "yes" : "no "}  ${JSON.stringify(text)}`, isDiagramRequest(text) === want, String(isDiagramRequest(text)));
}

// ── The board ────────────────────────────────────────────────────────
console.log("# board");
const first = drawBoard(null, {
  title: "Signup funnel",
  nodes: [{ label: "visitors" }, { label: "signups" }, { label: "paid" }],
  edges: [{ from: "visitors", to: "signups" }, { from: "signups", to: "paid" }],
});
const board = first.board as BoardDoc;
const boxes = (board?.strokes ?? []).filter((s) => s.bzRole === "node");
const arrows = (board?.strokes ?? []).filter((s) => s.tool === "arrow");
check("BOARD-1a  the funnel brief draws", first.ok, first.error ?? "");
check("BOARD-1b  three boxes", boxes.length === 3, `boxes=${boxes.length}`);
check("BOARD-1c  two arrows", arrows.length === 2, `arrows=${arrows.length}`);
check("BOARD-1d  a label under each box", (board?.strokes ?? []).filter((s) => s.bzRole === "nodeLabel").length === 3);
check("BOARD-1e  the labels are the owner's words", boxes.map((b) => b.bzLabel).join(",") === "visitors,signups,paid", boxes.map((b) => b.bzLabel).join(","));

const xs = boxes.map((b) => Number(b.x1));
check("BOARD-2a  layered left to right", xs[0]! < xs[1]! && xs[1]! < xs[2]!, xs.join(","));
check("BOARD-2b  one row for a straight flow", new Set(boxes.map((b) => Number(b.y1))).size === 1, boxes.map((b) => b.y1).join(","));
const firstArrow = arrows[0]!;
check("BOARD-2c  the arrow runs from the first box's right edge to the second's left edge", Number(firstArrow.x1) === xs[0]! + 200 && Number(firstArrow.x2) === xs[1]!, `${firstArrow.x1}->${firstArrow.x2}`);

check("BOARD-3a  the art route's document version", board?.version === 3);
check("BOARD-3b  a canvas that contains every mark", board?.w! > Math.max(...boxes.map((b) => Number(b.x2))) && board?.h! > 0, `w=${board?.w} h=${board?.h}`);
check("BOARD-3c  an order entry per mark", board?.order.length === board?.strokes.length && board.order.every((o) => board.strokes.some((s) => s.id === o.id)));
check("BOARD-3d  no images, no raster", (board?.images.length ?? -1) === 0 && board?.raster === null);
const TOOLS = new Set(["rect", "text", "arrow", "line"]);
check("BOARD-3e  only marks the sketch page draws", board.strokes.every((s) => TOOLS.has(String(s.tool))), board.strokes.map((s) => s.tool).join(","));
check("BOARD-3f  every mark has numbers where the page reads them", board.strokes.every((s) => Number.isFinite(Number(s.x1)) && Number.isFinite(Number(s.y1))));
check("BOARD-3g  under the 8 MB save cap", JSON.stringify(board).length < 8 * 1024 * 1024, `${JSON.stringify(board).length} B`);

const before = JSON.stringify(board);
const follow = drawBoard(board, {
  nodes: [{ label: "referrals", after: "paid" }],
  edges: [{ from: "paid", to: "referrals", label: "18% of paid" }],
});
const after = follow.board as BoardDoc;
const afterBoxes = after.strokes.filter((s) => s.bzRole === "node");
check("BOARD-4a  the follow-up adds exactly one box and one connector", follow.ok && follow.added?.nodes === 1 && follow.added?.edges === 1, JSON.stringify(follow.added));
check("BOARD-4b  the board now has four boxes", afterBoxes.length === 4, `boxes=${afterBoxes.length}`);
check("BOARD-4c  every original mark is still there, unchanged", board.strokes.every((s) => JSON.stringify(after.strokes.find((n) => n.id === s.id)) === JSON.stringify(s)));
check("BOARD-4d  the new box sits in a new column to the right", Number(afterBoxes[3]!.x1) > Number(afterBoxes[2]!.x1), `${afterBoxes[3]!.x1}`);
check("BOARD-4e  the connector's words ride on it", after.strokes.some((s) => s.bzRole === "edgeLabel" && s.text === "18% of paid" && typeof s.anchor === "string" && s.anchor !== ""));
check("BOARD-4f  nothing was lost from the old board", before.length < JSON.stringify(after).length);

const again = drawBoard(after, {
  nodes: [{ label: "visitors" }, { label: "signups" }, { label: "paid" }],
  edges: [{ from: "visitors", to: "signups" }, { from: "signups", to: "paid" }],
});
check("BOARD-5  a second whole diagram is refused, never a replacement", !again.ok && again.errorCode === "one_at_a_time", `${again.errorCode}: ${again.error}`);

const many = drawBoard(null, { nodes: Array.from({ length: MAX_BOARD_NODES + 1 }, (_, i) => ({ label: `step ${i + 1}` })) });
check("BOARD-6a  the 41st box is refused by name", !many.ok && many.errorCode === "too_many_boxes", `${many.errorCode}`);
const badEdge = drawBoard(null, { nodes: [{ label: "a" }], edges: [{ from: "a", to: "nowhere" }] });
check("BOARD-6b  a connector to a box that does not exist is refused by name", !badEdge.ok && badEdge.errorCode === "unknown_box", `${badEdge.errorCode}`);
const noJob = drawBoard(null, { nodes: [] });
check("BOARD-6c  an empty call draws nothing and says so", !noJob.ok && noJob.errorCode === "nothing_to_add", `${noJob.errorCode}`);

// ── The art route, for real ──────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;
let BASE = process.argv[2] ?? "";
let MAIL_LOG = process.argv[3] ?? "";
let child: ReturnType<typeof spawn> | null = null;
let mailDir: string | null = null;
let serverLog = "";

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function ensurePgliteAssets() {
  const libs = join(ROOT, ".output", "server", "_libs");
  const src = join(ROOT, "node_modules", "@electric-sql", "pglite", "dist");
  for (const file of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
    const dest = join(libs, file);
    if (!existsSync(dest) && existsSync(join(src, file))) copyFileSync(join(src, file), dest);
  }
}

async function boot(): Promise<boolean> {
  if (BASE) return true;
  if (!existsSync(SERVER_ENTRY)) return false;
  ensurePgliteAssets();
  mailDir = mkdtempSync(join(tmpdir(), "bz-draw-board-"));
  MAIL_LOG = join(mailDir, "outbound-mail.jsonl");
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of ["RESEND_API_KEY", "SMTP_URL", "SMTP_HOST"]) delete env[key];
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      AGENT_RELAY_DEV_MAIL: "1",
      AGENT_RELAY_MAIL_LOG_DIR: mailDir,
      BETTER_AUTH_URL: BASE,
      BETTER_AUTH_TRUSTED_ORIGINS: BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk: Buffer) => { serverLog = (serverLog + chunk.toString()).slice(-8000); };
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  const tail = serverLog.trim().split("\n").slice(-25).join("\n");
  console.error(`FAIL  the built server never became healthy on ${BASE}\n${tail}`);
  return false;
}

async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  child = null;
  if (mailDir) { rmSync(mailDir, { recursive: true, force: true }); mailDir = null; }
}
process.on("exit", () => { if (child && child.exitCode === null) child.kill("SIGKILL"); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void stop().finally(() => process.exit(130)); });

async function readMailUrl(email: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (existsSync(MAIL_LOG)) {
      const lines = readFileSync(MAIL_LOG, "utf8").trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const mail = JSON.parse(line) as { to?: string; actionUrl?: string; html?: string; text?: string };
          if (mail.to !== email) continue;
          const url =
            mail.actionUrl ||
            (mail.html ?? "").match(/href="([^"]*magic-link\/verify[^"]*)"/)?.[1] ||
            (mail.text ?? "").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0];
          if (url) return url.replace(/&amp;/g, "&");
        } catch { /* partial line */ }
      }
    }
    await sleep(500);
  }
  throw new Error(`no magic-link mail for ${email} in ${MAIL_LOG}`);
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`magic-link request failed ${res.status}: ${await res.text()}`);
  const verify = await fetch(await readMailUrl(email), { redirect: "manual" });
  const cookies = verify.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error(`magic-link verify returned ${verify.status} with no session cookie`);
  return cookie;
}

async function main() {
  const up = await boot();
  if (!up) {
    console.log(`SKIP  ART-1/2  no built server at ${SERVER_ENTRY} — run: npm run build`);
    return;
  }
  const cookie = await signIn(`draw-board-${Date.now().toString(36)}@example.test`);
  const jobId = `job_draw_${Date.now().toString(36)}`;
  const created = await fetch(`${BASE}/api/buzzy/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify({ id: jobId, title: "draw board test", status: "In progress", data: {} }),
  });
  check("ART-0  a project can be opened to draw on", created.ok, `HTTP ${created.status}`);

  const save = await fetch(`${BASE}/api/buzzy/art`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify({ action: "save", jobId, board: after }),
  });
  const saved = (await save.json().catch(() => null)) as { ok?: boolean; saved?: boolean } | null;
  check("ART-1a  the art route accepts the board draw_board saved", save.status === 200 && saved?.ok === true && saved?.saved === true, `HTTP ${save.status}`);

  const got = await fetch(`${BASE}/api/buzzy/art?job=${jobId}`, { headers: { cookie } });
  const gotJson = (await got.json().catch(() => null)) as { board?: BoardDoc } | null;
  const readBack = gotJson?.board;
  // jsonb does not keep key order, so compare the fields the page actually reads.
  const fingerprint = (s: Record<string, unknown>) =>
    JSON.stringify([s.id, s.tool, s.x1, s.y1, s.x2 ?? null, s.y2 ?? null, s.text ?? null, s.size ?? null, s.color ?? null, s.fillColor ?? null, s.anchor ?? null]);
  const mine = after.strokes.map(fingerprint).sort();
  const theirs = (readBack?.strokes ?? []).map(fingerprint).sort();
  check(
    "ART-1b  it comes back exactly as it went in (every mark, in order)",
    got.status === 200 &&
      readBack?.strokes.length === after.strokes.length &&
      readBack?.order.length === after.order.length &&
      readBack.order.every((o, i) => o.id === after.order[i]!.id) &&
      JSON.stringify(mine) === JSON.stringify(theirs),
    `HTTP ${got.status} strokes=${readBack?.strokes.length}/${after.strokes.length} order=${readBack?.order.length}/${after.order.length} sameMarks=${JSON.stringify(mine) === JSON.stringify(theirs)}`,
  );

  const page = await fetch(`${BASE}/buzzy/sketch?job=${jobId}`, { headers: { cookie } });
  const pageText = await page.text();
  // The page must know how to draw every mark this tool writes: a rect, an arrow, a text.
  const rendersIt = /case "rect":/.test(pageText) && /case "line": case "arrow":/.test(pageText) && /s\.tool === "text"/.test(pageText);
  check("ART-2  the served Sketch page draws rect, arrow and text marks", page.status === 200 && rendersIt, `HTTP ${page.status} rect=${/case "rect":/.test(pageText)} arrow=${/case "line": case "arrow":/.test(pageText)} text=${/s\.tool === "text"/.test(pageText)}`);

  // The project page must list the board as a source — that is where the owner finds it
  // again without the chat transcript.
  const project = await fetch(`${BASE}/api/buzzy/projects/${jobId}`, { headers: { cookie } });
  const projectJson = (await project.json().catch(() => null)) as { project?: { data?: { sources?: Array<{ kind?: string; url?: string }> } } } | null;
  const sources = projectJson?.project?.data?.sources ?? [];
  check(
    "ART-3  the project lists its board as a source with a Sketch link",
    project.status === 200 && sources.some((s) => s.kind === "board" && String(s.url).includes(`/buzzy/sketch?job=${jobId}`)),
    JSON.stringify(sources).slice(0, 160),
  );

  // The route's own cap still guards a board someone else posts (unchanged by this work).
  const huge = { ...after, images: [{ id: "im_big", url: "data:image/jpeg;base64," + "A".repeat(9 * MB), x: 0, y: 0, w: 1, h: 1 }] };
  const over = await fetch(`${BASE}/api/buzzy/art`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify({ action: "save", jobId, board: huge }),
  });
  check("ART-4  the 8 MB board cap is still enforced after this change", over.status === 413, `HTTP ${over.status}`);
}

main()
  .catch((err) => { failures += 1; console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`); })
  .finally(async () => {
    await stop();
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
