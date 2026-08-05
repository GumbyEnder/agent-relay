/**
 * Endpoint-oriented private-board isolation (two synthetic owners).
 * Exercises the same store gates the HTTP layer uses for board/mission scope
 * without spinning a full Nitro server.
 */
import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";
import { canAccessBoardByOwner } from "../src/lib/board-tenancy";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function main() {
  await ensureBoardReady();

  const ownerA = `ten_a_${Date.now().toString(36)}`;
  const ownerB = `ten_b_${Date.now().toString(36)}`;

  const boardA = await durableBoard.createProject({
    name: `Private A ${ownerA}`,
    slug: `priv-a-${Date.now().toString(36)}`,
    ownerUserId: ownerA,
  });
  const boardB = await durableBoard.createProject({
    name: `Private B ${ownerB}`,
    slug: `priv-b-${Date.now().toString(36)}`,
    ownerUserId: ownerB,
  });
  assert(boardA.id && boardB.id, "created private boards");

  const mA = await durableBoard.createMission({
    title: "Secret work A",
    objective: "only owner A",
    projectId: boardA.id,
    column: "ready",
  });
  assert(mA.ok, "mission on A");
  const missionId = mA.data.mission.id;

  // Snapshot by board id (what GET /board?project= does after resolve)
  const snapA = await durableBoard.snapshot(boardA.id);
  const snapB = await durableBoard.snapshot(boardB.id);
  assert(
    snapA.missions.some((m) => m.id === missionId),
    "owner board snapshot includes mission",
  );
  assert(
    !snapB.missions.some((m) => m.id === missionId),
    "peer board snapshot excludes other private mission",
  );

  // Journal / history only meaningful when mission is known — peer never sees id in snap
  const hist = await durableBoard.history(missionId);
  assert(Array.isArray(hist), "history loads for known mission");
  const journal = await durableBoard.journalMarkdown(missionId);
  assert(journal && journal.includes(missionId), "journal for known mission");

  // Access matrix for HTTP gate (requireOperatorProjectAccess / assertCanReadMission)
  const actorA = { authRequired: true as const, userId: ownerA, role: "operator" as const };
  const actorB = { authRequired: true as const, userId: ownerB, role: "operator" as const };
  const actorAdmin = { authRequired: true as const, userId: "admin_x", role: "admin" as const };

  assert(canAccessBoardByOwner(actorA, boardA.ownerUserId), "A reads own board");
  assert(!canAccessBoardByOwner(actorB, boardA.ownerUserId), "B denied A board");
  assert(canAccessBoardByOwner(actorAdmin, boardA.ownerUserId), "admin reads A board");
  assert(canAccessBoardByOwner(actorB, boardB.ownerUserId), "B reads own board");

  // Fleet list for a board must not pull missions from the other private board
  const fleetA = await durableBoard.snapshot(boardA.id);
  const fleetB = await durableBoard.snapshot(boardB.id);
  const idsA = new Set(fleetA.missions.map((m) => m.id));
  const idsB = new Set(fleetB.missions.map((m) => m.id));
  assert(idsA.has(missionId) && !idsB.has(missionId), "mission id isolation across fleet snaps");

  // Admin user disable flag table path (migration 0015)
  const created = await durableBoard.adminCreateUser({
    email: `qa-${Date.now().toString(36)}@example.test`,
    password: "testpass-99",
    name: "QA Tenant",
    role: "operator",
  });
  assert(created.id, "admin create user");
  assert(!(await durableBoard.isUserDisabled(created.id)), "new user not disabled");
  await durableBoard.setUserDisabled({ userId: created.id, disabled: true, reason: "qa" });
  assert(await durableBoard.isUserDisabled(created.id), "disabled flag set");
  await durableBoard.setUserDisabled({ userId: created.id, disabled: false });
  assert(!(await durableBoard.isUserDisabled(created.id)), "re-enabled");
  await durableBoard.adminResetUserPassword({
    userId: created.id,
    password: "newpass-88xx",
  });

  // P0 regression: empty allowedProjectIds must NOT fail open to all boards
  const privateMission = missionId;
  const leakSnap = await durableBoard.adminSnapshot("all", {
    allowedProjectIds: [],
  });
  assert(
    leakSnap.missions.length === 0,
    "empty allow list must yield zero missions (no fail-open)",
  );
  assert(
    !leakSnap.missions.some((m) => m.id === privateMission),
    "private mission must not appear under empty allow list",
  );
  const openSnap = await durableBoard.adminSnapshot("all", {
    allowedProjectIds: null,
  });
  assert(
    openSnap.missions.some((m) => m.id === privateMission),
    "null allow list remains unrestricted for open/admin-all paths",
  );
  const filtered = await durableBoard.adminSnapshot("all", {
    allowedProjectIds: [boardA.id],
  });
  assert(
    filtered.missions.some((m) => m.id === privateMission),
    "owner allow list includes own mission",
  );
  assert(
    !filtered.missions.some((m) => m.projectId === boardB.id && m.id !== privateMission) ||
      filtered.missions.every((m) => m.projectId === boardA.id),
    "filtered snap only owner A boards",
  );

  console.log("✓ tenancy endpoint isolation + admin user flags + empty-allow fail-closed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
