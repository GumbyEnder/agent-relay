-- BZ-F015: first-class durable documents + immutable versions.
-- Textual canonical content and metadata are database-backed; versions are
-- append-only so a prior version can never be overwritten (QA-12).
CREATE TABLE IF NOT EXISTS buzzy_documents (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  job_id          TEXT,
  title           TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'document',
  status          TEXT NOT NULL DEFAULT 'draft',   -- draft | ready | accepted
  current_version INTEGER NOT NULL DEFAULT 1,
  expert          TEXT,
  source_refs     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS buzzy_documents_user_updated ON buzzy_documents (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_documents_job ON buzzy_documents (user_id, job_id);

CREATE TABLE IF NOT EXISTS buzzy_document_versions (
  doc_id      TEXT NOT NULL REFERENCES buzzy_documents(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, version)
);
