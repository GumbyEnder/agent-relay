/**
 * Lightweight pure-logic smoke for claim atomicity + five verbs.
 * Run: node --experimental-strip-types scripts/test-board-engine.mjs
 *   or: npx tsx scripts/test-board-engine.ts (if using the .ts twin)
 *
 * This file duplicates a minimal harness by dynamically importing the TS module
 * via vite-node/tsx when available; otherwise it inlines critical assertions
 * against a local clone of seed-shaped data.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function loadEngine() {
  // Prefer tsx if present
  try {
    const { register } = await import("node:module");
    // fall through to dynamic import of compiled-less path via tsx CLI is external
  } catch {
    /* ignore */
  }
  // Use vite-node style: spawn is overkill. Import via experimental strip if Node 22+.
  const modPath = path.join(root, "src/lib/board-engine.ts");
  try {
    return await import(pathToFileURL(modPath).href);
  } catch (e) {
    console.error("Direct TS import failed — run with Node 22+ or: npx tsx scripts/test-board-engine.mjs");
    throw e;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const { SEED_AGENTS, SEED_MISSIONS, SEED_EVENTS, SEED_CALLS } = await import(
  pathToFileURL(path.join(root, "src/lib/seed.ts")).href
).catch(async () => {
  // seed may also need strip-types
  throw new Error("Cannot load seed.ts");
});

const engine = await loadEngine();

let board = {
  agents: structuredClone(SEED_AGENTS),
  missions: structuredClone(SEED_MISSIONS),
  events: structuredClone(SEED_EVENTS),
  calls: structuredClone(SEED_CALLS),
};

// poll ready
let r = engine.pollMissions(board, { column: "ready", limit: 5 });
assert(r.ok, "poll ok");
assert(r.data.missions.some((m) => m.id === "msn_agent_protocol_doc"), "ready has protocol mission");
console.log("✓ poll");

// atomic claim race simulation
const claim1 = engine.claimMission(board, "msn_agent_protocol_doc", "lens");
assert(claim1.ok, "first claim ok");
board = claim1.board;
const claim2 = engine.claimMission(board, "msn_agent_protocol_doc", "scout");
assert(!claim2.ok && claim2.status === 409, "second claim 409");
console.log("✓ atomic claim (409 on double)");

// heartbeat
r = engine.heartbeatMission(board, "msn_agent_protocol_doc", "lens", "drafting card");
assert(r.ok, "heartbeat ok");
board = r.board;
assert(board.missions.find((m) => m.id === "msn_agent_protocol_doc").progressNote.includes("drafting"), "note set");
console.log("✓ heartbeat");

// escalate
r = engine.escalateMission(board, "msn_agent_protocol_doc", "lens", "Ship as /protocol only?");
assert(r.ok, "escalate ok");
board = r.board;
assert(board.missions.find((m) => m.id === "msn_agent_protocol_doc").column === "needs_human", "needs_human");
const callId = board.calls[0].id;
console.log("✓ escalate");

// human reply unsticks
r = engine.replyToCall(board, callId, "Yes, single page is enough.");
assert(r.ok, "reply ok");
board = r.board;
assert(board.missions.find((m) => m.id === "msn_agent_protocol_doc").column === "running", "back to running");
console.log("✓ human reply → running");

// deliver
r = engine.deliverMission(board, "msn_agent_protocol_doc", "lens", "protocol card ready", [
  "docs/PROTOCOL.md",
]);
assert(r.ok, "deliver ok");
board = r.board;
const delivered = board.missions.find((m) => m.id === "msn_agent_protocol_doc");
assert(delivered.column === "review", "review");
assert(board.agents.find((a) => a.name === "lens").currentMissionId === null, "agent freed");
console.log("✓ deliver");

console.log("\nAll board-engine checks passed.");
