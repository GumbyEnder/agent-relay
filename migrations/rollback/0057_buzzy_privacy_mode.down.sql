-- Rollback of 0057: drops the per-account privacy mode. The Talk slider then
-- falls back to the per-browser value it already keeps.
DROP TABLE IF EXISTS buzzy_privacy_mode;
