-- BZ-F021: controlled sharing — explicit, version-pinned, expiring, revocable.
-- A share link exposes EXACTLY one reviewed (accepted) document version via
-- an unguessable token. Completion never makes anything public by itself.
CREATE TABLE IF NOT EXISTS buzzy_share_links (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  doc_id      TEXT NOT NULL REFERENCES buzzy_documents(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS buzzy_share_links_user ON buzzy_share_links (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_share_links_token ON buzzy_share_links (token);
