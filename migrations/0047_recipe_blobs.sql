-- Bundle bytes live in the database, not on the container's disk.
--
-- Railway rebuilds the image on every deploy. A bundle written to the filesystem
-- survived until the next restart and then vanished, while `ar_recipe_bundle` still
-- reported it as published — so the shelf listed recipes that could no longer be
-- opened. Content-addressed bytes are small and immutable; the database is the
-- durable store we already have and already trust for the manifest.

CREATE TABLE IF NOT EXISTS ar_recipe_blob (
  key        TEXT PRIMARY KEY,
  bytes      BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
