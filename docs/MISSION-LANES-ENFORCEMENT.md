# Mission lanes — enforcement plan (P2 + P3)

Status: P1 live (`0052_mission_lanes.sql`). P2 live (`0053`, `GET /lane-gate`).
P3 **shipped** — the write-path guard lives in `src/lib/lane-rules.ts` +
`durableBoard.setMissionLane` / `moveMission`, exposed as `POST /missions/:id/lane`.
One board (DevBoard APP `board_i80oou4gp0ri`) has `lanes_enforce=true`; whether it
rejects writes is decided by the global `LANES_ENFORCE` env, flipped only on
Shane's go.
This document is the execution plan and the evidence contract for every flip.

Authority: Shane, 2026-11-05 (via grokbot, topic `work`):
* "One at a time is fine" — enforcement is turned on **board by board**, never fleet-wide.
* Per-board `lanes_enforce` defaults to **0**.
* The global env flag is **subtractive only**: `enforce_active = per_board AND global`.
  Global can veto a board; it can never enable one.
* Humans are exempt by the **server-side authenticated principal**, never by a body flag.
  Human transitions are still recorded (lane history row, `actor_kind='human'`).
* Backfill runs **per board at flip time**: backfill → verify 0 violations → `enforce=1`.
* Reuse the `migration:0052` marker for backfill-written lanes, or write a new marker plus a
  history row. Never leave a lane changed with neither.
* Keep the **global** violation count as a cross-check, because `project_id` can be null.
* P2 (the gate read surface) must exist before any flip. No deploys from grokbot.

## Contract

Four lanes: `open | evidence | closed | blocked-evidence`
(DB `blocked_evidence`; API/UI render `blocked-evidence`).

| Transition | Who may make it |
|---|---|
| `open → evidence` | agent, human, system (evidence attached) |
| `evidence ↔ open` | agent, human |
| `* → blocked-evidence` | agent, human (must name `evidence_missing`) |
| `* → closed` | **shane only** (`lane_authority='shane'`, `check_result='pass'`, `evidence_ref` not null) |

Rules that a gate must refuse, in lane-gate vocabulary (all already encoded as
`ar_mission_lane_violations`):

`lane_missing`, `lane_ambiguous`, `closed_no_authority`, `closed_no_evidence`,
`pass_no_ref`, `blocked_no_reason`, `column_lane_mismatch`, `no_lane_history`
(`no_lane_history` exempts `lane_changed_by='migration:0052'`).

## P2 — read surface (no behaviour change)

1. `scripts/lane-gate.mjs` — CLI over `ar_mission_lane_violations`.
   `--project-id <id>` scopes to one board; `--all` runs untouched; `--json` for machines.
   Always prints **three** counts, never one:
   `scoped` (this board), `null_project_id` (disclosure — rows with no `project_id`),
   `global` (cross-check, all rows).
   Exit code: `0` only when `scoped == 0 && null_project_id == 0` for the scoped run;
   `1` otherwise. `--all` exits `0` only on `global == 0`.
2. `GET /api/agent/lane-gate[?project_id=<id>]` — same three counts as JSON, machine-authed
   like the rest of `/api/agent/*`, plus `enforce_active` (`per_board AND global`) and the
   violation rows. Read-only; no writes, no audit noise.
3. Migration `0053_project_lanes_enforce.sql` — `ar_projects.lanes_enforce boolean not null
   default false` (+ rollback). Inert: nothing reads it until P3. Default 0 means the
   fleet-wide state after P2 is exactly the state after P1.

Success for P2: endpoint and CLI agree row-for-row on the same DB snapshot; suites green;
no write path touched.

## Wire path (P3) — live on one board

`enforce_active = projects.lanes_enforce AND LANES_ENFORCE` (env read per call). When
false the write path behaves as before.

* `POST /api/agent/missions/:id/lane { lane, evidence_type?, evidence_ref?, check_result?,
  check_output?, evidence_missing?, note? }` is the only lane write path. The actor kind
  comes from the **server-side principal** (session → `human`, agent key → `agent`), never
  from a body field. A transition that would produce a rule code is refused **422
  `lane_violation`** with the codes in `violations[]`; nothing is written and no lane
  history row is minted.
* `POST /api/agent/missions/:id/move` refuses a move that would leave the card breaching a
  rule (e.g. a `blocked_evidence` card dragged to `running`). `→ done` without an
  evidence/closed lane is **coerced** to `evidence / unverified` with a history row — never
  to `closed`.
* **Humans are exempt** by the principal: their transition is written and recorded
  (`ar_mission_lane_history.actor_kind='human'`), with the exempted codes disclosed in the
  response (`exempt_violations[]`) and in the history note. The only rules a human must
  still satisfy are the two the 0052 CHECK constraints cannot represent (`closed` needs
  `pass` + `evidence_ref`; `blocked_evidence` needs `evidence_missing`) — refused with the
  same 422 shape instead of a Postgres error.
* **`closed` is Shane-only**: authority is resolved server-side from
  `AGENT_RELAY_LANE_AUTHORITY_EMAILS`; a body claiming `lane_authority:"shane"` is ignored.
  A non-authority principal gets 422 `closed_no_authority` on every board.
* Rejected writes are never partial: validation runs before the write, and lane + history +
  event are written together after it.

Rollback without a deploy: `LANES_ENFORCE=0` (or remove the var) — the guard stops
rejecting and the per-board flags stay set. Full rollback: `update ar_projects set
lanes_enforce=false where id=<id>;` plus removing the var.

## P3 — per-board flip runbook

Legs 0–2 run once; leg 3 runs **once per board**; leg 4 runs last.

**Leg 0 — board order (once).** Enumerate boards with missions, ordered by mission count
descending, ties by oldest `created_at` — busiest and most valuable board first, so a broken
rule surfaces where there is evidence to see it:

```sql
select p.id, p.name, count(m.id) as missions
  from ar_projects p join ar_missions m on m.project_id = p.id
 group by p.id, p.name order by missions desc, p.created_at asc;
```

Record the order in the evidence note before touching any board.

**Leg 1 — baseline re-probe (once, and again before leg 4).** Same hour, same query, same
host as the reference run: `violations=0`, `done=436`. Different host or different hour
invalidates the comparison — re-probe, do not reuse the stale number.

**Leg 2 — P2 in place.** Endpoint and CLI both answer on the target environment. A flip with
no gate to read is a blind flip.

**Leg 3 — flip one board.**
1. `scripts/lane-gate.mjs --project-id <id> --json` → capture `scoped`, `null_project_id`,
   `global` **before** any write.
2. Backfill that board only, in one transaction with the flag change
   (`STAMP_MODE` single switch, no half-applied state):
   * write lanes with `lane_changed_by='migration:0053'` (new marker) **and** a
     `ar_mission_lane_history` row per changed mission, `actor_kind='system'`;
   * same-transaction self-check: `ar_missions` rows touched by this backfill ==
     `ar_mission_lane_history` rows inserted by it; `lane_changes` rowcount == history
     inserts. Any mismatch → `ROLLBACK`, do not commit;
   * take the leg-4 counts from **this same transaction snapshot** as the gate rowcount, so
     live writes between statements cannot make them disagree;
   * `update ar_projects set lanes_enforce = true where id = <id>` last, inside the same tx.
3. Gate re-run inside/after the tx, printing scoped / null_project_id / global together.
   Board is accepted only on `scoped == 0 AND null_project_id == 0`. A non-zero
   `null_project_id` blocks the flip even though those rows are not this board's — it means
   the gate cannot see the whole picture.
4. Rollback of a flip: `update ar_projects set lanes_enforce = false where id = <id>` — one
   statement, no data repair. Lane values written by the backfill are correct history and
   stay; they were written with a marker, not derived from enforcement.

**Leg 4 — completion.** All boards flipped and `global == 0`. If any board still has
violations, leave it at 0 and report which rule is failing rather than enforcing a board that
would fail closed on real traffic.

## Wire path (P3, shipped)

`enforce_active = projects.lanes_enforce AND LANES_ENFORCE` (env read per call, so a
flip needs only a restart). When false the write path accepts the lane write and records
it — the guard never rejects unless the env veto and the per-board flag are both on.

When true:
* `POST /missions/:id/lane` rejects a transition that would produce any of the eight rule
  codes, with the rule code(s) in the 422 body (`{code:"lane_violation", violations:[…]}`);
* a column move on an enforced board is refused with the same 422 when it would leave the
  card in `column_lane_mismatch` (e.g. a `blocked_evidence` card dragged into `running`);
  `→ done` is the exception — it coerces the lane to `evidence`/`unverified` with a
  history row, never to `closed`;
* the authenticated human principal (`actor_kind='human'`) is exempt — decided from the
  session server-side, never from a request body field — and still gets a lane history
  row. The only rules a human still has to satisfy are the two the 0052 CHECK constraints
  cannot represent: `closed` needs `check_result='pass'` + `evidence_ref`,
  `blocked_evidence` needs `evidence_missing`;
* agents and system actors get no exemption.

Rollback while this is live: `LANES_ENFORCE=0` (global veto, one restart, no data loss),
then per board `update ar_projects set lanes_enforce=false where id=<id>;`.

## Open items

* Which environment gets flipped first (dev → prod), and whether `null_project_id` rows are
  orphaned missions or a missing-project default; needs one query, not a guess.
* `LANES_ENFORCE` unset must read as `0`. An absent env var is not consent.
