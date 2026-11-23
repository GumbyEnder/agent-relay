-- Rollback of 0065: the Zilla agents sidebar has nothing to show.
-- Agents and the starter marker go; conversations stay, as ordinary BeeZilla ones
-- (their agent_id is dropped with the column).
DROP INDEX IF EXISTS buzzy_sessions_agent_idx;
ALTER TABLE buzzy_sessions DROP COLUMN IF EXISTS agent_id;
DROP TABLE IF EXISTS buzzy_agent_seed;
DROP TABLE IF EXISTS buzzy_agents;
