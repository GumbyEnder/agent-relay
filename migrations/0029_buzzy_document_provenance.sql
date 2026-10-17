-- BZ-F017: per-version provenance + exact-version acceptance.
ALTER TABLE buzzy_document_versions
  ADD COLUMN IF NOT EXISTS parent_version INTEGER,
  ADD COLUMN IF NOT EXISTS creator TEXT,
  ADD COLUMN IF NOT EXISTS brief_revision JSONB,
  ADD COLUMN IF NOT EXISTS expert TEXT,
  ADD COLUMN IF NOT EXISTS policy_version TEXT,
  ADD COLUMN IF NOT EXISTS review JSONB,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_by TEXT;

ALTER TABLE buzzy_documents
  ADD COLUMN IF NOT EXISTS accepted_version INTEGER;
