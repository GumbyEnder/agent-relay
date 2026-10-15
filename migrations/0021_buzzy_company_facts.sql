-- Lines read from a company website. They stay proposed until the owner
-- confirms or edits them. A dropped line is not a company fact.
ALTER TABLE buzzy_companies ADD COLUMN IF NOT EXISTS website TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS buzzy_company_facts (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  fact_key       TEXT NOT NULL,
  label          TEXT NOT NULL,
  value          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'proposed',
  source_label   TEXT NOT NULL DEFAULT 'from the website',
  source_page    TEXT NOT NULL DEFAULT '',
  original_value TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_company_facts_company
  ON buzzy_company_facts (user_id, company_id);
