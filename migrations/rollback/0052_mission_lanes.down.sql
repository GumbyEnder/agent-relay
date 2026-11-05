-- Hard rollback for 0052_mission_lanes.sql.
--
-- Lives in migrations/rollback/ ON PURPOSE: scripts/migrate.mjs reads only
-- top-level *.sql and the PGLite path globs /migrations/*.sql, so a file here
-- can never auto-apply.
--
-- Dropping the columns loses every lane/evidence value written after go-live.
-- Prefer the soft rollback first: LANES_ENFORCE=0 (no data loss, no deploy).
-- Take a pg_dump of ar_missions, ar_mission_lane_history and _migrations before
-- running anything below.

DROP VIEW IF EXISTS ar_mission_lane_violations;
DROP TABLE IF EXISTS ar_mission_lane_history;

DROP INDEX IF EXISTS ar_missions_lane_evidence_idx;
DROP INDEX IF EXISTS ar_missions_lane_idx;

ALTER TABLE ar_missions
  DROP CONSTRAINT IF EXISTS ar_missions_blocked_missing_chk,
  DROP CONSTRAINT IF EXISTS ar_missions_pass_ref_chk,
  DROP CONSTRAINT IF EXISTS ar_missions_closed_evidence_chk,
  DROP CONSTRAINT IF EXISTS ar_missions_authority_required_chk,
  DROP CONSTRAINT IF EXISTS ar_missions_lane_authority_chk,
  DROP CONSTRAINT IF EXISTS ar_missions_check_result_chk,
  DROP CONSTRAINT IF EXISTS ar_missions_evidence_type_chk,
  DROP CONSTRAINT IF EXISTS ar_missions_lane_enum_chk;

ALTER TABLE ar_missions
  DROP COLUMN IF EXISTS evidence_missing,
  DROP COLUMN IF EXISTS check_output,
  DROP COLUMN IF EXISTS check_result,
  DROP COLUMN IF EXISTS evidence_ref,
  DROP COLUMN IF EXISTS evidence_type,
  DROP COLUMN IF EXISTS lane_changed_by,
  DROP COLUMN IF EXISTS lane_changed_at,
  DROP COLUMN IF EXISTS lane_authority,
  DROP COLUMN IF EXISTS lane;

-- So the migration can re-apply cleanly.
DELETE FROM _migrations WHERE name = '0052_mission_lanes.sql';
