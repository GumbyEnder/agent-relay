-- Rollback of 0059: search words, board recipes and personal AI keys go away.
-- Saved files themselves (buzzy_assets) are untouched; search falls back to names.
DROP TABLE IF EXISTS buzzy_user_ai_keys;
DROP TABLE IF EXISTS buzzy_board_recipes;
DROP TABLE IF EXISTS buzzy_asset_tags;
