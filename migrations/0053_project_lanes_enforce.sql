-- 0053: per-board mission-lane enforcement flag (P2 — schema only, inert).
--
-- Approved by Shane 2026-11-05 (via grokbot, topic work):
--   * enforcement is turned on board by board, never fleet-wide
--   * per-board `lanes_enforce` defaults to 0 (false)
--   * the global env LANES_ENFORCE is subtractive only:
--       enforce_active = per_board AND global
--   * backfill runs per board at flip time; P3 flips the flag
--
-- P2 = this column only. Nothing in the read or write path consults it for
-- behaviour yet; scripts/lane-gate.mjs and GET /api/agent/lane-gate only
-- *report* the value. If the process cannot read the column, that read must
-- degrade to false, never to true — an absent gate is not consent.
--
-- `NOT NULL DEFAULT false` rewrites no rows on PG 11+ (the default is stored in
-- the catalogue) and makes the fleet-wide state after 0053 identical to 0052.
-- No extra index: the flag is read by primary key (`where id = $1`).

ALTER TABLE ar_projects
  ADD COLUMN IF NOT EXISTS lanes_enforce BOOLEAN NOT NULL DEFAULT false;
