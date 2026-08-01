/**
 * Drives the shipped board-engine + history collection path.
 * Run: npx tsx scripts/test-history.ts
 */
import { SEED_AGENTS, SEED_CALLS, SEED_EVENTS, SEED_MISSIONS } from "../src/lib/seed";
import * as engine from "../src/lib/board-engine";
import type { BoardData } from "../src/lib/board-engine";
import type { MissionColumn, MissionHistoryEntry } from "../src/lib/types";
import { uid } from "../src/lib/utils";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

function collectHistory(
  before: BoardData,
  after: BoardData,
  actor: { id: string | null; name: string | null; kind: MissionHistoryEntry["actorKind"] },
): MissionHistoryEntry[] {
  const prev = new Map(before.missions.map((m) => [m.id, m]));
  const out: MissionHistoryEntry[] = [];
  for (const m of after.missions) {
    const p = prev.get(m.id);
    if (!p) continue;
    if (p.column !== m.column) {
      out.push({
        id: uid("hist"),
        missionId: m.id,
        actorId: actor.id,
        actorName: actor.name,
        actorKind: actor.kind,
        fromColumn: p.column,
        toColumn: m.column,
        at: Date.now(),
      });
    }
  }
  return out;
}

let board: BoardData = {
  agents: structuredClone(SEED_AGENTS),
  missions: structuredClone(SEED_MISSIONS),
  events: structuredClone(SEED_EVENTS),
  calls: structuredClone(SEED_CALLS),
};

const missionId = "msn_agent_protocol_doc";
const allHist: MissionHistoryEntry[] = [];

// move 1: claim ready -> running
{
  const before = board;
  const r = engine.claimMission(board, missionId, "lens");
  assert(r.ok, "claim");
  const hist = collectHistory(before, r.board, {
    id: "agent_lens",
    name: "lens",
    kind: "agent",
  });
  assert(hist.length >= 1, "history on claim");
  assert(hist[0]!.fromColumn === "ready", "from ready");
  assert(hist[0]!.toColumn === "running", "to running");
  assert(hist[0]!.actorName === "lens", "actor lens");
  assert(hist[0]!.missionId === missionId, "mission id");
  assert(typeof hist[0]!.at === "number", "timestamp");
  allHist.push(...hist);
  board = r.board;
}

// move 2: escalate running -> needs_human
{
  const before = board;
  const r = engine.escalateMission(board, missionId, "lens", "OK to ship?");
  assert(r.ok, "escalate");
  const hist = collectHistory(before, r.board, {
    id: "agent_lens",
    name: "lens",
    kind: "agent",
  });
  assert(hist.length >= 1, "history on escalate");
  assert(hist[0]!.fromColumn === "running", "from running");
  assert(hist[0]!.toColumn === "needs_human", "to needs_human");
  allHist.push(...hist);
  board = r.board;
}

assert(allHist.length >= 2, "≥2 history entries");
// ordered
assert(allHist[0]!.toColumn === "running", "order 1");
assert(allHist[1]!.toColumn === "needs_human", "order 2");

console.log("✓ history recording path:", allHist.length, "entries");
for (const h of allHist) {
  console.log(
    `  ${h.fromColumn} → ${h.toColumn} by ${h.actorName} (${h.actorKind}) @ ${h.at}`,
  );
}
console.log("\nAll history checks passed.");
