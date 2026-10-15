-- Company tabs: one owner, several companies. Jobs and chats belong to a
-- company once the owner files them there. Null means "not in a company yet".
CREATE TABLE IF NOT EXISTS buzzy_companies (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  one_liner  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_companies_user
  ON buzzy_companies (user_id, created_at ASC);

ALTER TABLE buzzy_jobs ADD COLUMN IF NOT EXISTS company_id TEXT;
CREATE INDEX IF NOT EXISTS idx_buzzy_jobs_company
  ON buzzy_jobs (user_id, company_id);

ALTER TABLE buzzy_sessions ADD COLUMN IF NOT EXISTS company_id TEXT;
CREATE INDEX IF NOT EXISTS idx_buzzy_sessions_company
  ON buzzy_sessions (user_id, company_id);
