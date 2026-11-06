# Mission lanes — enforcement plan (P2 + P3)

Status: P1 live (`0052_mission_lanes.sql`, `LANES_ENFORCE=0`, inert).
This document is the P2/P3 execution plan. Nothing here flips a board until the
preconditions in "Flip gate" are printed and pasted into the evidence record.

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

## Wire path (P3 code, only after P2 ships)

`enforce_active = projects.lanes_enforce AND LANES_ENFORCE` (env read once per process).
When false, the write path is byte-identical to today. When true:
* reject a transition that would produce any of the eight rule codes, with the rule code in
  the error body;
* exempt the authenticated human principal (`actor_kind='human'`) — decide it from the
  session, never from a request body field — but still insert the lane history row;
* agents and system actors get no exemption.

## Open items

* Which environment gets flipped first (dev → prod), and whether `null_project_id` rows are
  orphaned missions or a missing-project default; needs one query, not a guess.
* `LANES_ENFORCE` unset must read as `0`. An absent env var is not consent.
