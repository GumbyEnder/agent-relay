-- Rollback of 0067: the Hive has nothing to show.
-- The log of what the agents asked each other goes. Agents, colonies and conversations are
-- untouched: nothing else read this table, and the agents simply stop leaving lines.
DROP INDEX IF EXISTS buzzy_hive_messages_user_idx;
DROP TABLE IF EXISTS buzzy_hive_messages;
