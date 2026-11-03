-- 0048 — bulk asset store.
--
-- Why: a person arrives with a skills corpus — markdown plus thousands of
-- images — and the product only ever accepted one paste or one chat attachment.
-- The unit of work is a directory, not a file, so storage is content-addressed:
-- (user_id, sha256) is unique, which makes re-running an interrupted 4,000-file
-- upload free instead of duplicating everything.
--
-- Bytes live in Postgres because that is the only durable store this deployment
-- has. One row per distinct file, never per upload attempt.
--
-- No full-text or transcript columns here: this table is a blob shelf, and the
-- only thing we ever query is identity, path and size.

CREATE TABLE IF NOT EXISTS buzzy_assets (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  content_type  TEXT,
  bytes         INTEGER NOT NULL,
  body          BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)
);

CREATE INDEX IF NOT EXISTS buzzy_assets_user_path_idx
  ON buzzy_assets (user_id, rel_path);

CREATE INDEX IF NOT EXISTS buzzy_assets_user_created_idx
  ON buzzy_assets (user_id, created_at DESC);
