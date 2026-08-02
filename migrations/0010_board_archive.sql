-- Soft-archive boards: hide from active rail, keep history/missions.

ALTER TABLE ar_projects
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ar_projects_archived_idx
  ON ar_projects (archived_at)
  WHERE archived_at IS NOT NULL;
