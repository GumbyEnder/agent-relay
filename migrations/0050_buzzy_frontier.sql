-- 0050 — the frontier ranking becomes data, not code.
--
-- A ranking baked into a deployed file means "the model in position 3" silently
-- means "whatever position 3 was when we shipped". One row holds the current
-- ranking so it can be refreshed without a deploy; the bundled frontier.json
-- stays as the fallback for a fresh database or a failed loader.

CREATE TABLE IF NOT EXISTS buzzy_frontier (
  id          TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  source      TEXT NOT NULL,
  as_of       TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
