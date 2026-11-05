-- 0052: mission lanes + evidence fields (P1 — schema only, inert).
--
-- Approved by Shane 2026-11-05 (via grokbot, topic work):
--   * four lanes: open | evidence | closed | blocked-evidence
--   * `closed` is Shane-only — no other authority, including frodo
--   * historical `done` cards backfill to evidence/unverified, NEVER closed
--   * `evidence_missing` is its own field (do not overload progress_note)
--   * P1 = this migration only, LANES_ENFORCE=0, no behaviour change
--
-- DB values are snake_case (`blocked_evidence`) to match `needs_human`;
-- the API/UI render `blocked-evidence` to match the Hermes lane contract.
-- Nothing in the write path reads these columns yet, so every existing
-- writer keeps working unchanged (lane defaults to 'open').

ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'open';
ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS lane_authority TEXT;
ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS lane_changed_at TIMESTAMPTZ;
ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS lane_changed_by TEXT;
ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS evidence_type TEXT;
ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS evidence_ref TEXT;
ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS check_result TEXT;
ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS check_output TEXT;
ALTER TABLE ar_missions ADD COLUMN IF NOT EXISTS evidence_missing TEXT;

-- Constraints are added NOT VALID, the backfill runs, then they are validated:
-- keeps the ACCESS EXCLUSIVE window on ar_missions tiny. DROP-then-ADD keeps a
-- re-run of this file idempotent (the migrator records by filename, but manual
-- replay against a restored dump must not blow up).
ALTER TABLE ar_missions DROP CONSTRAINT IF EXISTS ar_missions_lane_enum_chk;
ALTER TABLE ar_missions ADD CONSTRAINT ar_missions_lane_enum_chk
  CHECK (lane IN ('open', 'evidence', 'closed', 'blocked_evidence')) NOT VALID;

ALTER TABLE ar_missions DROP CONSTRAINT IF EXISTS ar_missions_evidence_type_chk;
ALTER TABLE ar_missions ADD CONSTRAINT ar_missions_evidence_type_chk
  CHECK (evidence_type IS NULL OR evidence_type IN
    ('test', 'command_exit', 'file', 'url', 'api_readback', 'none')) NOT VALID;

ALTER TABLE ar_missions DROP CONSTRAINT IF EXISTS ar_missions_check_result_chk;
ALTER TABLE ar_missions ADD CONSTRAINT ar_missions_check_result_chk
  CHECK (check_result IS NULL OR check_result IN
    ('pass', 'fail', 'blocked', 'unverified')) NOT VALID;

-- `closed` means Shane closed it. Nothing else may write that lane.
ALTER TABLE ar_missions DROP CONSTRAINT IF EXISTS ar_missions_lane_authority_chk;
ALTER TABLE ar_missions ADD CONSTRAINT ar_missions_lane_authority_chk
  CHECK (lane <> 'closed' OR lane_authority = 'shane') NOT VALID;

-- Authority-bearing lanes must say who holds the authority.
ALTER TABLE ar_missions DROP CONSTRAINT IF EXISTS ar_missions_authority_required_chk;
ALTER TABLE ar_missions ADD CONSTRAINT ar_missions_authority_required_chk
  CHECK (lane NOT IN ('closed', 'blocked_evidence') OR lane_authority IS NOT NULL) NOT VALID;

-- No closing without a passing check and an independently re-openable ref.
ALTER TABLE ar_missions DROP CONSTRAINT IF EXISTS ar_missions_closed_evidence_chk;
ALTER TABLE ar_missions ADD CONSTRAINT ar_missions_closed_evidence_chk
  CHECK (lane <> 'closed' OR (check_result = 'pass' AND evidence_ref IS NOT NULL)) NOT VALID;

-- A pass with no openable ref is not a pass.
ALTER TABLE ar_missions DROP CONSTRAINT IF EXISTS ar_missions_pass_ref_chk;
ALTER TABLE ar_missions ADD CONSTRAINT ar_missions_pass_ref_chk
  CHECK (check_result IS DISTINCT FROM 'pass' OR evidence_ref IS NOT NULL) NOT VALID;

-- Blocked-evidence must name what is missing (and carry no evidence payload).
ALTER TABLE ar_missions DROP CONSTRAINT IF EXISTS ar_missions_blocked_missing_chk;
ALTER TABLE ar_missions ADD CONSTRAINT ar_missions_blocked_missing_chk
  CHECK (lane <> 'blocked_evidence'
    OR (evidence_missing IS NOT NULL
        AND (evidence_type IS NULL OR evidence_type = 'none'))) NOT VALID;

-- Backfill: historical done cards become evidence/unverified.
-- NEVER closed — none of them carries a Shane authorization or an openable ref,
-- and rubber-stamping 317 cards would destroy the meaning of the lane.
UPDATE ar_missions
   SET lane = 'evidence',
       evidence_type = 'none',
       check_result = 'unverified',
       lane_changed_at = now(),
       lane_changed_by = 'migration:0052'
 WHERE column_id = 'done'
   AND lane = 'open'
   AND lane_changed_by IS NULL;

ALTER TABLE ar_missions VALIDATE CONSTRAINT ar_missions_lane_enum_chk;
ALTER TABLE ar_missions VALIDATE CONSTRAINT ar_missions_evidence_type_chk;
ALTER TABLE ar_missions VALIDATE CONSTRAINT ar_missions_check_result_chk;
ALTER TABLE ar_missions VALIDATE CONSTRAINT ar_missions_lane_authority_chk;
ALTER TABLE ar_missions VALIDATE CONSTRAINT ar_missions_authority_required_chk;
ALTER TABLE ar_missions VALIDATE CONSTRAINT ar_missions_closed_evidence_chk;
ALTER TABLE ar_missions VALIDATE CONSTRAINT ar_missions_pass_ref_chk;
ALTER TABLE ar_missions VALIDATE CONSTRAINT ar_missions_blocked_missing_chk;

CREATE INDEX IF NOT EXISTS ar_missions_lane_idx ON ar_missions (project_id, lane);
CREATE INDEX IF NOT EXISTS ar_missions_lane_evidence_idx ON ar_missions (project_id)
  WHERE lane IN ('evidence', 'closed');

-- Lane changes are authority events: they get their own append-only trail
-- rather than riding along in ar_mission_history.meta.
CREATE TABLE IF NOT EXISTS ar_mission_lane_history (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES ar_missions(id) ON DELETE CASCADE,
  project_id TEXT,
  from_lane TEXT,
  to_lane TEXT NOT NULL,
  authority TEXT,
  evidence_type TEXT,
  evidence_ref TEXT,
  check_result TEXT,
  actor_id TEXT,
  actor_kind TEXT NOT NULL DEFAULT 'system',
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);

CREATE INDEX IF NOT EXISTS ar_mission_lane_history_mission_at_idx
  ON ar_mission_lane_history (mission_id, at DESC);

-- One row per rule breach. This view is the single source of truth for the
-- gate (GET /api/agent/lane-gate, scripts/lane-gate.mjs, the UI badge).
--
-- `no_lane_history` deliberately exempts migration-written lanes: the 0052
-- backfill records itself in lane_changed_by and does not manufacture history
-- rows for cards that were never lane-changed by an actor.
CREATE OR REPLACE VIEW ar_mission_lane_violations AS
  SELECT m.id AS mission_id, m.project_id, 'lane_missing'::text AS rule_code,
         'mission has no lane'::text AS detail
    FROM ar_missions m
   WHERE m.lane IS NULL
  UNION ALL
  SELECT m.id, m.project_id, 'lane_ambiguous',
         'lane value not in the four lane vocabulary: ' || m.lane
    FROM ar_missions m
   WHERE m.lane IS NOT NULL
     AND m.lane NOT IN ('open', 'evidence', 'closed', 'blocked_evidence')
  UNION ALL
  SELECT m.id, m.project_id, 'closed_no_authority',
         'closed lane without shane authority (authority=' ||
         COALESCE(m.lane_authority, 'null') || ')'
    FROM ar_missions m
   WHERE m.lane = 'closed'
     AND m.lane_authority IS DISTINCT FROM 'shane'
  UNION ALL
  SELECT m.id, m.project_id, 'closed_no_evidence',
         'closed lane without pass + openable evidence_ref'
    FROM ar_missions m
   WHERE m.lane = 'closed'
     AND (m.evidence_ref IS NULL OR m.check_result IS DISTINCT FROM 'pass')
  UNION ALL
  SELECT m.id, m.project_id, 'pass_no_ref',
         'check_result=pass with no evidence_ref'
    FROM ar_missions m
   WHERE m.check_result = 'pass'
     AND m.evidence_ref IS NULL
  UNION ALL
  SELECT m.id, m.project_id, 'blocked_no_reason',
         'blocked_evidence lane without evidence_missing'
    FROM ar_missions m
   WHERE m.lane = 'blocked_evidence'
     AND m.evidence_missing IS NULL
  UNION ALL
  SELECT m.id, m.project_id, 'column_lane_mismatch',
         'lane ' || m.lane || ' does not fit column ' || m.column_id
    FROM ar_missions m
   WHERE (m.lane = 'closed' AND m.column_id <> 'done')
      OR (m.lane = 'blocked_evidence' AND m.column_id NOT IN ('needs_human', 'blocked'))
      OR (m.column_id = 'done' AND m.lane NOT IN ('evidence', 'closed'))
  UNION ALL
  SELECT m.id, m.project_id, 'no_lane_history',
         'lane is ' || m.lane || ' but no lane history row exists'
    FROM ar_missions m
   WHERE m.lane <> 'open'
     AND m.lane_changed_by IS DISTINCT FROM 'migration:0052'
     AND NOT EXISTS (
       SELECT 1 FROM ar_mission_lane_history h WHERE h.mission_id = m.id
     );
