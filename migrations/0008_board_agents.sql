-- Agents can belong to one or more boards (projects).
-- Roster on Agents tab = membership for the selected board.

CREATE TABLE IF NOT EXISTS ar_board_agents (
  project_id TEXT NOT NULL REFERENCES ar_projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES ar_agents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, agent_id)
);

CREATE INDEX IF NOT EXISTS ar_board_agents_agent_idx ON ar_board_agents (agent_id);

-- Backfill: keys that bind an agent to a board
INSERT INTO ar_board_agents (project_id, agent_id)
SELECT DISTINCT project_id, agent_id
FROM ar_api_keys
WHERE agent_id IS NOT NULL
  AND revoked_at IS NULL
ON CONFLICT DO NOTHING;

-- Backfill: agents that claimed missions on a board
INSERT INTO ar_board_agents (project_id, agent_id)
SELECT DISTINCT m.project_id, a.id
FROM ar_missions m
JOIN ar_agents a ON a.id = m.claimed_by OR a.name = m.claimed_by
WHERE m.claimed_by IS NOT NULL
  AND m.project_id IS NOT NULL
ON CONFLICT DO NOTHING;
