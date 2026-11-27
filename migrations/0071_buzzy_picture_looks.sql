-- 0071 — what BeeZilla saw in each picture (testers, 2026-11-24: "BeeZilla able to read
-- and analyze a referred or uploaded image … it should be reading everything on that
-- board").
--
-- On a turn, the pictures that matter (the one pointed at, the ones joined into a step,
-- the others on the Idea Board, one just dropped in Talk) are looked at by a model that
-- can see, and what each shows goes into that turn's instructions (src/lib/buzzy/
-- vision.ts). The plain description is kept here, one row per picture, so the next turn
-- reads it instead of sending the picture out again. Answers to questions about a picture
-- are never kept: they belong to that turn.
--
-- The row goes with the picture (ON DELETE CASCADE) and with the account (portability.ts).

CREATE TABLE IF NOT EXISTS buzzy_picture_looks (
  asset_id    BIGINT PRIMARY KEY REFERENCES buzzy_assets(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  -- What the picture shows, in plain sentences (at most 1,400 characters).
  note        TEXT NOT NULL,
  -- The model that looked, so a better one can look again later.
  model       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_picture_looks_user ON buzzy_picture_looks (user_id);
