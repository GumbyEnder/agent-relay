-- A paper dropped on a company's job. Extracted lines stay proposed
-- until the owner accepts or corrects them. Nothing here is a company fact.
CREATE TABLE IF NOT EXISTS buzzy_papers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  job_id      TEXT,
  session_id  TEXT,
  filename    TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'document',
  place       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_papers_company
  ON buzzy_papers (user_id, company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS buzzy_paper_facts (
  id             TEXT PRIMARY KEY,
  paper_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  job_id         TEXT,
  fact_key       TEXT NOT NULL,
  label          TEXT NOT NULL,
  value          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'proposed',
  place          TEXT NOT NULL DEFAULT '',
  original_value TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_paper_facts_paper
  ON buzzy_paper_facts (paper_id, user_id);
