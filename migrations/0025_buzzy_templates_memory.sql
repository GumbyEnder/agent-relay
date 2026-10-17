-- 0025: Template library (plan doc 23, component #3) — the owner's own
-- documents become reusable structures drafts fill in. Private by default
-- (negative scope: no shared marketplace). Extracted structure is stored as
-- JSON; the docx binary is kept for render-from-template later.
CREATE TABLE IF NOT EXISTS buzzy_templates (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  company_id  TEXT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'document',
  structure   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_templates_user
  ON buzzy_templates (user_id, created_at DESC);

-- Customer memory rollup cache (component #2): derived per company from
-- approved jobs; rebuilt on approval. Contributions are attributable.
ALTER TABLE buzzy_companies ADD COLUMN IF NOT EXISTS customer_memory JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE buzzy_companies ADD COLUMN IF NOT EXISTS memory_updated_at TIMESTAMPTZ;
