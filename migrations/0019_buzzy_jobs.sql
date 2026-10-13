-- B2: durable, account-scoped jobs.
-- Replaces the browser-localStorage source of truth so jobs survive device
-- change, sign-out, and browser reset. `data` holds the full client job state
-- (same shape the client used to JSON.stringify into localStorage); indexed
-- columns (template/title/status) power the list without unpacking JSON.
CREATE TABLE IF NOT EXISTS buzzy_jobs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  template   TEXT,
  title      TEXT,
  status     TEXT,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_jobs_user
  ON buzzy_jobs (user_id, updated_at DESC);