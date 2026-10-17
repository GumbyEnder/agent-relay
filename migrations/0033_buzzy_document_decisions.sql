-- BZ-F027: human acceptance + revision loop.
-- Internal reviewer acceptance and CUSTOMER acceptance are distinct records;
-- every decision is tied to an exact document version, and a rejected output
-- creates a bounded correction note for that version (not a fresh job).
CREATE TABLE IF NOT EXISTS buzzy_document_decisions (
  id         BIGSERIAL PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES buzzy_documents(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('accept', 'request_changes', 'keep_draft')),
  role       TEXT NOT NULL DEFAULT 'internal' CHECK (role IN ('internal', 'customer')),
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS buzzy_document_decisions_doc ON buzzy_document_decisions (doc_id, created_at DESC);
