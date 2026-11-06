-- Hard rollback for 0053_project_lanes_enforce.sql.
--
-- Lives in migrations/rollback/ ON PURPOSE: scripts/migrate.mjs reads only
-- top-level *.sql and the PGLite path globs /migrations/*.sql, so a file here
-- can never auto-apply.
--
-- Dropping the column loses which boards had been flipped. The safe rollback of
-- an enforcement problem is `LANES_ENFORCE=0` (global veto, no data loss) or
-- `update ar_projects set lanes_enforce = false where id = <board>` — this file
-- is only for removing the feature.
--
-- No table rewrite, no lane data touched: lane values written by a P3 backfill
-- are history, not enforcement state, and must survive.

ALTER TABLE ar_projects
  DROP COLUMN IF EXISTS lanes_enforce;
