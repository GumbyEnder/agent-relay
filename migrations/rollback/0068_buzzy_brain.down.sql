-- Rollback of 0068: the brain keeps no places of its own, and Code Monkey is an ordinary agent.
-- What the tidy decided, the folders the person made, which folders turns were about and when the
-- brain was last tidied go. Everything the tree was worked out from stays: remembered decisions,
-- conversations, files and agents are untouched (Code Monkey stays on the accounts that have it,
-- as an agent like any other). The agents lose the list of folders they work in.
DROP INDEX IF EXISTS buzzy_brain_touches_path_idx;
DROP INDEX IF EXISTS buzzy_brain_touches_user_idx;
DROP TABLE IF EXISTS buzzy_brain_touches;
DROP TABLE IF EXISTS buzzy_brain_places;
DROP TABLE IF EXISTS buzzy_brain_folders;
DROP TABLE IF EXISTS buzzy_brain_tidy;
DROP TABLE IF EXISTS buzzy_agent_starters;
ALTER TABLE buzzy_agents DROP COLUMN IF EXISTS domains;
