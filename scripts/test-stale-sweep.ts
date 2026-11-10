/**
 * Stale-claim sweep through the shipped store: poll() must DEMOTE to inbox,
 * never "release in place" on running.
 *
 * Runs against the PGLite fallback (no DATABASE_URL) — same SQL both backends
 * parse. Run: npx tsx scripts/test-stale-sweep.ts
 */
import { durableBoard } from "../src/lib/board-store.server";
import { getSql } from "../src/lib/db";
import { classifyMissionHealth } from "../src/lib/stale-heartbeat";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

const DAY = 86_400_000;

async function main() {
  assert(!process.env.DATABASE_URL, "run without DATABASE_URL (PGLite)");
  // Fresh instance each run: the fallback DB is in-memory.
  const tag = Date.now().toString(36);
  const board = await durableBoard.createProject({
    name: `Sweep test ${tag}`,
    slug: `sweep-${tag}`,
    ownerUserId: `sweep_owner_${tag}`,
  });

  const mk = async (title: string, tags: string[] = [], column: "running" | "ready" = "running") => {
    const r = await durableBoard.createMission({
      title,
      objective: "o",
      projectId: board.id,
      column,
      tags,
    });
    assert(r.ok, `created ${title}`);
    return r.data.mission.id;
  };

  // 1. Abandoned claim: claimed 2 days ago, no heartbeat since.
  const abandoned = await mk("abandoned claim");
  assert((await durableBoard.claim(abandoned, "agent_sweep_a")).ok, "claimed abandoned");

  // 2. Re-claimed just now, but still carries the previous owner's dead heartbeat.
  const reclaimed = await mk("re-claimed with inherited dead heartbeat");
  assert((await durableBoard.claim(reclaimed, "agent_sweep_b")).ok, "claimed reclaimed");

  // 3. Sustained: exempt by tag.
  const sustained = await mk("sustained epic", ["sustained"]);
  assert((await durableBoard.claim(sustained, "agent_sweep_c")).ok, "claimed sustained");

  // 4. Unowned runner (never claimed): the sweep must not touch it; the
  //    classifier must call it orphaned.
  const unowned = await mk("unowned runner");

  const sql = await getSql();
  const old = new Date(Date.now() - 2 * DAY);
  await sql`update ar_missions set claimed_at = ${old}, last_heartbeat = ${old} where id = ${abandoned}`;
  await sql`update ar_missions set last_heartbeat = ${old} where id = ${reclaimed}`;
  await sql`update ar_missions set claimed_at = ${old}, last_heartbeat = ${old} where id = ${sustained}`;
  await sql`update ar_missions set last_heartbeat = ${old} where id = ${unowned}`;

  // Run the sweep through the real poll path.
  const polled = await durableBoard.poll({ projectId: board.id });
  assert(polled.ok, "poll ok");

  const snap = await durableBoard.snapshot(board.id);
  const at = (id: string) => {
    const m = snap.missions.find((x) => x.id === id);
    assert(m, `mission ${id} in snapshot`);
    return m;
  };

  // (a) demoted, not released in place
  const ab = at(abandoned);
  assert(ab.column === "inbox", `abandoned demoted to inbox (got ${ab.column})`);
  assert(ab.claimedBy === null, "abandoned claim cleared");
  assert(ab.claimedAt === null, "abandoned claimed_at cleared");
  assert(ab.lastHeartbeat === null, "abandoned heartbeat cleared (no dead clock left behind)");

  // (c) max(lastHeartbeat, claimedAt): a fresh claim is not swept on arrival
  const rc = at(reclaimed);
  assert(rc.column === "running", "re-claimed card survives the sweep");
  assert(rc.claimedBy !== null, "re-claimed card keeps its owner");
  assert(classifyMissionHealth(rc, Date.now()) === "ok", "re-claimed card classifies ok");

  // sustained exemption
  const su = at(sustained);
  assert(su.column === "running", "sustained card survives the sweep");
  assert(classifyMissionHealth(su, Date.now()) === "n/a", "sustained classifies n/a");

  // scope: the sweep owns claimed-then-abandoned only; unowned runners are the
  // classifier's (and a backfill's) business, not the sweep's.
  const un = at(unowned);
  assert(un.column === "running", "unowned runner is left where it is");
  assert(classifyMissionHealth(un, Date.now()) === "orphaned", "unowned runner classifies orphaned");

  // audit trail: one history row + one event per demotion, and none on the others
  const hist = (await sql`
    select id, from_column, to_column, note, actor_name, actor_kind
      from ar_mission_history where mission_id = ${abandoned}
     and actor_name = 'stale-claim-sweep'
  `) as Array<Record<string, unknown>>;
  assert(hist.length === 1, `one sweep history row (got ${hist.length})`);
  assert(hist[0]!.from_column === "running" && hist[0]!.to_column === "inbox", "history running→inbox");
  assert(hist[0]!.note === "released-by-stale-sweep", "history note");
  assert(hist[0]!.actor_kind === "system", "history actor_kind=system");

  const evs = (await sql`
    select kind, message from ar_events where mission_id = ${abandoned} and kind = 'mission_released'
  `) as Array<Record<string, unknown>>;
  assert(evs.length === 1, `one mission_released event (got ${evs.length})`);

  const other = (await sql`
    select mission_id from ar_mission_history
     where actor_name = 'stale-claim-sweep' and mission_id = any(${[reclaimed, sustained, unowned]}::text[])
  `) as Array<Record<string, unknown>>;
  assert(other.length === 0, "no sweep history on surviving cards");

  // idempotent: a second poll must not demote again or duplicate history
  await durableBoard.poll({ projectId: board.id });
  const hist2 = (await sql`
    select id from ar_mission_history where mission_id = ${abandoned} and actor_name = 'stale-claim-sweep'
  `) as Array<Record<string, unknown>>;
  assert(hist2.length === 1, "second poll adds no duplicate history");

  console.log("✓ stale-claim sweep demotes to inbox (a), max-clock (c), sustained exemption, audit trail");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
