-- Per-operator UI preferences (theme, etc.)

CREATE TABLE IF NOT EXISTS ar_operator_prefs (
  user_id TEXT PRIMARY KEY,
  theme TEXT,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
