-- Multi-project support + GitHub external identity

CREATE TABLE IF NOT EXISTS ar_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ar_projects (id, name, slug, description)
VALUES ('proj_default', 'Default', 'default', 'Default project board')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE ar_missions
  ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'proj_default';
ALTER TABLE ar_missions
  ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE ar_missions
  ADD COLUMN IF NOT EXISTS source TEXT;

CREATE INDEX IF NOT EXISTS ar_missions_project_idx ON ar_missions (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS ar_missions_external_id_uidx
  ON ar_missions (external_id) WHERE external_id IS NOT NULL;

ALTER TABLE ar_events
  ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE ar_calls
  ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE ar_mission_history
  ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE ar_agents
  ADD COLUMN IF NOT EXISTS project_id TEXT;

UPDATE ar_events e
SET project_id = m.project_id
FROM ar_missions m
WHERE e.mission_id = m.id AND e.project_id IS NULL;

UPDATE ar_calls c
SET project_id = m.project_id
FROM ar_missions m
WHERE c.mission_id = m.id AND c.project_id IS NULL;

UPDATE ar_mission_history h
SET project_id = m.project_id
FROM ar_missions m
WHERE h.mission_id = m.id AND h.project_id IS NULL;

CREATE INDEX IF NOT EXISTS ar_events_project_idx ON ar_events (project_id);
CREATE INDEX IF NOT EXISTS ar_calls_project_idx ON ar_calls (project_id);
CREATE INDEX IF NOT EXISTS ar_history_project_idx ON ar_mission_history (project_id);
