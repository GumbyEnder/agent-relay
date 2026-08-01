-- Scoped API keys, project settings (webhooks, github secret)

CREATE TABLE IF NOT EXISTS ar_api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ar_api_keys_project_idx ON ar_api_keys (project_id);
CREATE INDEX IF NOT EXISTS ar_api_keys_prefix_idx ON ar_api_keys (key_prefix);

CREATE TABLE IF NOT EXISTS ar_project_settings (
  project_id TEXT PRIMARY KEY REFERENCES ar_projects(id) ON DELETE CASCADE,
  github_webhook_secret TEXT,
  github_repo TEXT,
  reply_webhook_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
