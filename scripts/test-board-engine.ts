/**
 * Pure-logic smoke for claim atomicity + five verbs.
 * Run: npx tsx scripts/test-board-engine.ts
 */
import { SEED_AGENTS, SEED_CALLS, SEED_EVENTS, SEED_MISSIONS } from "../src/lib/seed";
import * as engine from "../src/lib/board-engine";
import type { BoardData } from "../src/lib/board-engine";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

let board: BoardData = {
  agents: structuredClone(SEED_AGENTS),
  missions: structuredClone(SEED_MISSIONS),
  events: structuredClone(SEED_EVENTS),
  calls: structuredClone(SEED_CALLS),
};

let r = engine.pollMissions(board, { column: "ready", limit: 5 });
assert(r.ok, "poll ok");
assert(
  r.data.missions.some((m) => m.id === "msn_agent_protocol_doc"),
  "ready has protocol mission",
);
console.log("✓ poll");

const claim1 = engine.claimMission(board, "msn_agent_protocol_doc", "lens");
assert(claim1.ok, "first claim ok");
board = claim1.board;
const claim2 = engine.claimMission(board, "msn_agent_protocol_doc", "scout");
assert(!claim2.ok && claim2.status === 409, "second claim 409");
console.log("✓ atomic claim (409 on double)");

r = engine.heartbeatMission(board, "msn_agent_protocol_doc", "lens", "drafting card");
assert(r.ok, "heartbeat ok");
board = r.board;
assert(
  board.missions.find((m) => m.id === "msn_agent_protocol_doc")!.progressNote.includes("drafting"),
  "note set",
);
console.log("✓ heartbeat");

r = engine.escalateMission(board, "msn_agent_protocol_doc", "lens", "Ship as /protocol only?");
assert(r.ok, "escalate ok");
board = r.board;
assert(
  board.missions.find((m) => m.id === "msn_agent_protocol_doc")!.column === "needs_human",
  "needs_human",
);
const callId = board.calls[0]!.id;
console.log("✓ escalate");

r = engine.replyToCall(board, callId, "Yes, single page is enough.");
assert(r.ok, "reply ok");
board = r.board;
assert(
  board.missions.find((m) => m.id === "msn_agent_protocol_doc")!.column === "running",
  "back to running",
);
console.log("✓ human reply → running");

r = engine.deliverMission(board, "msn_agent_protocol_doc", "lens", "protocol card ready", [
  "docs/PROTOCOL.md",
]);
assert(r.ok, "deliver ok");
board = r.board;
const delivered = board.missions.find((m) => m.id === "msn_agent_protocol_doc")!;
assert(delivered.column === "review", "review");
assert(board.agents.find((a) => a.name === "lens")!.currentMissionId === null, "agent freed");
console.log("✓ deliver");

console.log("\nAll board-engine checks passed.");
