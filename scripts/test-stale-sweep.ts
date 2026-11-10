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

  // 3. Sustained: exempt by tag. Case-insensitive — the TS classifier lowercases
  //    tags, so the SQL predicate must too or a "Sustained" card is n/a in the
  //    API summary and drained by the sweep in the same poll.
  const sustained = await mk("sustained epic", ["sustained"]);
  assert((await durableBoard.claim(sustained, "agent_sweep_c")).ok, "claimed sustained");
  const sustainedCaps = await mk("sustained epic, odd casing", ["Sustained"]);

  // 4. Unowned runner (never claimed): a supported unclaim leaves exactly this
  //    shape (claimed_by null, column_id still 'running'), so the sweep MUST
  //    reach it. Inverting this assertion is the point of the amendment.
  const unowned = await mk("unowned runner");

  // 5. No clocks at all, but freshly touched: the fallback is updated_at, not
  //    to_timestamp(0) — an operator's just-moved card keeps its 6h.
  const movedFresh = await mk("no clocks, just moved");

  // 6. No clocks at all and an old touch: the updated_at fallback must still
  //    stale out, or a never-claimed card is immortal.
  const movedStale = await mk("no clocks, forgotten");

  // 7. The real unclaim verb: claim then unclaim. It leaves column_id='running'
  //    with claimed_by null and a FRESH last_heartbeat, so the card must survive
  //    the immediate sweep — and stale out 6h after the hand-back, not at once.
  const handback = await mk("claimed then handed back");
  assert((await durableBoard.claim(handback, "agent_sweep_d")).ok, "claimed handback");
  assert((await durableBoard.unclaim(handback, "agent_sweep_d")).ok, "unclaimed handback");

  // 8. A human just dragged an old card into Running: the card still carries a
  //    dead heartbeat from a previous owner, claimed_by is null, and ONLY
  //    updated_at is fresh. It must survive 6h — otherwise a poll overrides the
  //    operator on the most common human path (the D1 regression).
  const humanMoved = await mk("human moved into running");

  // 9. #165-shaped: the exact card 0055 tags before it demotes — running,
  //    unclaimed, 23-day heartbeat, NO `sustained` tag. This is the fixture
  //    that pins Amendment A's blast radius. The sweep no longer carries
  //    `claimed_by is not null`, so an untagged runner is reachable; and the
  //    clock is greatest(hb, claimed_at) — hb is non-null here, so the
  //    updated_at fallback never engages. Demoted is the CORRECT outcome for
  //    every untagged runner; the tag, not an id special-case, is the brake.
  //    If this assertion flips to "running", the sweep has grown an owner
  //    filter again and 0055's tag step is the only thing holding #165 out.
  const epicShaped = await mk("epic-shaped unclaimed runner");

  const sql = await getSql();
  const old = new Date(Date.now() - 2 * DAY);
  await sql`update ar_missions set claimed_at = ${old}, last_heartbeat = ${old}, updated_at = ${old} where id = ${abandoned}`;
  await sql`update ar_missions set last_heartbeat = ${old}, updated_at = ${old} where id = ${reclaimed}`;
  await sql`update ar_missions set claimed_at = ${old}, last_heartbeat = ${old}, updated_at = ${old} where id = ${sustained}`;
  await sql`update ar_missions set last_heartbeat = ${old}, updated_at = ${old} where id = ${sustainedCaps}`;
  await sql`update ar_missions set last_heartbeat = ${old}, updated_at = ${old} where id = ${unowned}`;
  await sql`update ar_missions set updated_at = ${old} where id = ${movedStale}`;
  // dead heartbeat, no owner, ONLY updated_at fresh (what a human drag leaves)
  await sql`update ar_missions set last_heartbeat = ${old}, claimed_by = null where id = ${humanMoved}`;
  await sql`update ar_missions
               set external_id = 'github:gumbyender/agent-relay#165',
                   claimed_by = null,
                   claimed_at = null,
                   last_heartbeat = ${new Date(Date.now() - 23 * DAY)},
                   updated_at = ${new Date(Date.now() - 23 * DAY)}
             where id = ${epicShaped}`;

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
  const suc = at(sustainedCaps);
  assert(suc.column === "running", `sustained survives regardless of tag casing (got ${suc.column})`);

  // sweep reaches an unowned runner: unclaim must not manufacture an orphan
  const un = at(unowned);
  assert(un.column === "inbox", `unowned runner demoted to inbox (got ${un.column})`);
  assert(un.claimedBy === null, "unowned runner stays unclaimed");
  assert(un.lastHeartbeat === null, "unowned runner's dead heartbeat cleared");

  // updated_at fallback: fresh touch survives, forgotten card still drains
  const mf = at(movedFresh);
  assert(mf.column === "running", `no-clocks card with fresh updated_at survives (got ${mf.column})`);
  const ms = at(movedStale);
  assert(ms.column === "inbox", `no-clocks card with stale updated_at demoted (got ${ms.column})`);

  // the real unclaim verb: a fresh hand-back survives on its clock (the
  // classifier calls it `orphaned` at once — ownership is checked first — which
  // is exactly why the sweep, not the badge, has to be the thing that moves it)
  const hb = at(handback);
  assert(hb.column === "running", `just-unclaimed card survives the sweep (got ${hb.column})`);
  assert(hb.claimedBy === null, "just-unclaimed card has no owner");
  assert(classifyMissionHealth(hb, Date.now()) === "orphaned", "just-unclaimed card classifies orphaned");

  // a human's just-moved card survives on updated_at alone (the D1 regression)
  const hm = at(humanMoved);
  assert(hm.column === "running", `human-moved card with dead heartbeat survives (got ${hm.column})`);

  // #165-shaped: an untagged epic is demoted exactly like any other runner.
  // The brake is the `sustained` tag that 0055 applies before this sweep can
  // run; it is not an id special-case and not an owner filter.
  const ep = at(epicShaped);
  assert(ep.column === "inbox", `#165-shaped untagged runner demoted (got ${ep.column})`);
  assert(ep.claimedBy === null, "#165-shaped runner stays unclaimed");
  assert(!ep.tags.includes("sustained"), "#165-shaped fixture carries no sustained tag (0055 adds it)");

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
     where actor_name = 'stale-claim-sweep' and mission_id = any(${[reclaimed, sustained, movedFresh]}::text[])
  `) as Array<Record<string, unknown>>;
  assert(other.length === 0, "no sweep history on surviving cards");

  // idempotent: a second poll must not demote again or duplicate history
  await durableBoard.poll({ projectId: board.id });
  const hist2 = (await sql`
    select id from ar_mission_history where mission_id = ${abandoned} and actor_name = 'stale-claim-sweep'
  `) as Array<Record<string, unknown>>;
  assert(hist2.length === 1, "second poll adds no duplicate history");

  console.log("✓ stale-claim sweep demotes to inbox (a), max-clock (c), updated_at fallback (both directions), unclaimed runner reachable, #165-shaped untagged runner demoted, sustained exemption, audit trail");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
