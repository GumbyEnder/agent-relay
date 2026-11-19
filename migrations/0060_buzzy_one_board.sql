-- 0059 — the one board: search words for saved work, recipes made on the board,
-- and the person's own AI key.
--
-- Owner, 2026-11-18:
--   * "Everything you save has to be having at least 45 tags that are relevant to
--     that item generated so that it comes up when you search. … if I search house,
--     it should bring up the picture of a house I asked."  → buzzy_asset_tags
--   * "I need to be able to select a bunch of those things, like an area within the
--     board, and say create recipe."                       → buzzy_board_recipes
--   * "Even on the cloud mode, I need to be able to put in my own API key."
--                                                          → buzzy_user_ai_keys
--
-- buzzy_assets stays a blob shelf (0048); its words live beside it so a search
-- never has to read file bodies. A tag row is replaced, never appended: one row per
-- asset, rewritten when a better pass (the model instead of the word fallback) runs.

CREATE TABLE IF NOT EXISTS buzzy_asset_tags (
  asset_id     BIGINT PRIMARY KEY REFERENCES buzzy_assets(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- One tag per line, lower case. Searched with ILIKE; small enough per user.
  tags         TEXT NOT NULL DEFAULT '',
  tag_count    INTEGER NOT NULL DEFAULT 0,
  -- 'model' when the AI wrote the tags, 'words' when the offline fallback did
  -- (a later pass upgrades those).
  source       TEXT NOT NULL DEFAULT 'model',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_asset_tags_user_idx
  ON buzzy_asset_tags (user_id);

-- A recipe drawn on the whiteboard: agent instructions, skills, the lines between
-- them and the output, as the board stored them. Owned by one account.
CREATE TABLE IF NOT EXISTS buzzy_board_recipes (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  graph        JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_board_recipes_user_idx
  ON buzzy_board_recipes (user_id, created_at DESC);

-- The person's own AI key. Sealed with AES-256-GCM (src/lib/buzzy/userKeys.ts);
-- the page only ever sees key_hint (the last four characters).
CREATE TABLE IF NOT EXISTS buzzy_user_ai_keys (
  user_id      TEXT PRIMARY KEY,
  base_url     TEXT NOT NULL,
  model        TEXT,
  key_sealed   TEXT NOT NULL,
  key_hint     TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
