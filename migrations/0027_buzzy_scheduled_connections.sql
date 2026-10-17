-- 0027: Scheduled jobs + connections (plan doc 23, components #4/#5,
-- integrations). Scheduled output ALWAYS lands as a draft in the approve
-- queue — the harness works while the owner doesn't, but never acts alone.
CREATE TABLE IF NOT EXISTS buzzy_scheduled_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  company_id   TEXT,
  name         TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  cadence      TEXT NOT NULL DEFAULT 'weekly',
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  last_result  TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_scheduled_due
  ON buzzy_scheduled_jobs (enabled, next_run_at);

-- Integration connections. Read-only-first by contract: write scope exists
-- only as draft-creation, never autonomous outward action.
CREATE TABLE IF NOT EXISTS buzzy_connections (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'read',
  status       TEXT NOT NULL DEFAULT 'connected',
  last_error   TEXT NOT NULL DEFAULT '',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind)
);
