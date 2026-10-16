-- 0023: ar_events retention (REVIEW-F9). Cold table for events older than the
-- live window (reads cap at 2000 by design); archived rows are removed from the
-- hot table. Journal falls through to cold storage on demand.
CREATE TABLE IF NOT EXISTS ar_events_cold (
  LIKE ar_events INCLUDING ALL
);

-- Archive events older than 90 days, in bounded batches (index-friendly).
-- Idempotent: re-running archives only newly-aged rows.
INSERT INTO ar_events_cold
SELECT e.* FROM ar_events e
WHERE e.at < now() - interval '90 days'
LIMIT 5000;

DELETE FROM ar_events e
USING ar_events_cold c
WHERE e.id = c.id;

CREATE INDEX IF NOT EXISTS ar_events_cold_mission_idx ON ar_events_cold (mission_id);
CREATE INDEX IF NOT EXISTS ar_events_cold_project_idx ON ar_events_cold (project_id);
