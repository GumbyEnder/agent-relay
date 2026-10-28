-- BZ-F032: connected tools, read-only first — explicit scope detail.
-- Stores exactly what the owner selected (labels/folders/messages), so the
-- connection UI can explain scopes and the owner can revoke knowingly.
ALTER TABLE buzzy_connections
  ADD COLUMN IF NOT EXISTS scope_detail JSONB NOT NULL DEFAULT '{}'::jsonb;
