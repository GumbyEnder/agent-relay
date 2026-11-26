-- Rollback of 0066: the Zilla agents sidebar has no colonies.
-- Colonies go. Every agent stays, on its own, in the order the sidebar showed it: an
-- agent's pos meant "its place inside its colony" while it was in one, so each agent's
-- pos is first rewritten to its place on the whole page (its colony's place, then its
-- place inside the colony) before the column that explained it is dropped. Safe to run
-- twice: the rewrite only happens while the colonies table is still there.
DO $$
BEGIN
  IF to_regclass('buzzy_agent_colonies') IS NOT NULL THEN
    UPDATE buzzy_agents a
    SET pos = flat.n
    FROM (
      SELECT x.id,
             (row_number() OVER (
                PARTITION BY x.user_id
                ORDER BY COALESCE(c.pos, x.pos), COALESCE(c.created_at, x.created_at), COALESCE(c.id, x.id), x.pos, x.created_at, x.id
              ) - 1)::int AS n
      FROM buzzy_agents x
      LEFT JOIN buzzy_agent_colonies c ON c.id = x.colony_id AND c.user_id = x.user_id
    ) flat
    WHERE a.id = flat.id;
  END IF;
END
$$;
DROP INDEX IF EXISTS buzzy_agents_colony_idx;
ALTER TABLE buzzy_agents DROP COLUMN IF EXISTS colony_id;
DROP TABLE IF EXISTS buzzy_agent_colonies;
