import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";

async function main() {
  await ensureBoardReady();
  await durableBoard.reset();
  await durableBoard.claim("msn_agent_protocol_doc", "lens");
  await durableBoard.moveMission("msn_agent_protocol_doc", "review", "operator");
  const snap = await durableBoard.adminSnapshot();
  if (!snap.stats || snap.events.length < 1) throw new Error("missing events");
  if (snap.history.length < 2) throw new Error(`need history >=2 got ${snap.history.length}`);
  const move = snap.history.find((h) => h.toColumn === "review");
  if (!move?.actorName && !move?.actorId) throw new Error("move missing actor");
  console.log("✓ adminSnapshot", {
    missions: snap.stats.missions,
    events: snap.events.length,
    history: snap.history.length,
    byColumn: snap.stats.byColumn,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
