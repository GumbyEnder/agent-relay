-- Agent Relay board: missions, agents, calls, events, status history

CREATE TABLE IF NOT EXISTS ar_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_heartbeat TIMESTAMPTZ,
  current_mission_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ar_missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  constraints_text TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  column_id TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'p2',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  assignee_id TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  last_heartbeat TIMESTAMPTZ,
  progress_note TEXT NOT NULL DEFAULT '',
  artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  delivery TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ar_missions_column_idx ON ar_missions (column_id);
CREATE INDEX IF NOT EXISTS ar_missions_claimed_by_idx ON ar_missions (claimed_by);

CREATE TABLE IF NOT EXISTS ar_calls (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES ar_missions(id) ON DELETE CASCADE,
  agent_id TEXT,
  question TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'p2',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  reply TEXT
);

CREATE INDEX IF NOT EXISTS ar_calls_open_idx ON ar_calls (resolved_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS ar_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta JSONB
);

CREATE INDEX IF NOT EXISTS ar_events_at_idx ON ar_events (at DESC);

-- Append-only status/column history for missions
CREATE TABLE IF NOT EXISTS ar_mission_history (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES ar_missions(id) ON DELETE CASCADE,
  actor_id TEXT,
  actor_name TEXT,
  actor_kind TEXT NOT NULL DEFAULT 'system',
  from_column TEXT,
  to_column TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  meta JSONB
);

CREATE INDEX IF NOT EXISTS ar_mission_history_mission_at_idx
  ON ar_mission_history (mission_id, at DESC);

CREATE TABLE IF NOT EXISTS ar_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
