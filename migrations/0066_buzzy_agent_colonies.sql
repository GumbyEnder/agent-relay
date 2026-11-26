-- 0066 — Zilla agent colonies: named folders of agents, each with a purpose.
--
-- Owner, 2026-11-21: "When you click and hold an agent, you can drop it on another
-- agent, just like you can drop a Discord server on another Discord server. It
-- creates a folder of agents, and prompts: name your new colony, name and purpose,
-- with a grayed-out example tailored to the agents inside, e.g. 'These agents are
-- dedicated to my real estate business', '...my personal productivity', '...fun
-- and hobbies'. The user is encouraged to fill it out."
--
-- A colony is a folder of agents with a name and a purpose. The sidebar lists a
-- person's loose agents and their colonies in one order; a colony can be open (its
-- agents show under it) or closed (one row); agents can be reordered, moved into a
-- colony and moved out again. Ungrouping a colony puts its agents back at the top
-- level, in its place, and deletes nothing but the folder.
--
-- buzzy_agent_colonies: one row per colony a person has made.
--   name      what the person called it, up to 40 characters. agents.ts never stores
--             an empty one: a colony left without a name is called "New colony".
--   purpose   their own words about it ("These agents are dedicated to my real estate
--             business"), up to 200 characters, '' when they left it empty. BeeZilla
--             is shown it as something they wrote, never as a rule.
--   open      whether its agents show under it. A closed colony is a single row.
--   pos       its place among the person's top-level items (see Order below).
--
-- buzzy_agents.colony_id: the colony an agent sits in, or NULL when it is on its own.
--
-- Order. The top level of the sidebar is the person's agents with no colony
-- (colony_id IS NULL) and their colonies, merged by pos, an older row first when two
-- tie. Inside a colony its agents go by their own pos. So an agent's pos is its place
-- at the top level while colony_id is NULL, and its place inside the colony once it
-- has one. Both tables keep their own pos, and agents.ts rewrites them together
-- whenever the layout changes: every move is written by one statement, because the
-- database layer has no multi-statement transaction, so a failed write leaves the old
-- order and never half of a new one.
--
-- A colony always has at least one agent: agents.ts deletes the colony when its last
-- agent is moved out or removed. Nothing here enforces that and nothing relies on it
-- either: a colony with nobody in it is shown as an empty folder, and the next layout
-- write removes it.
--
-- No foreign keys on purpose, as in 0065: an agent whose colony_id names a colony that
-- is no longer there is read as being on its own, and the next layout write sets it
-- right. The account deletion list (portability.ts) removes these rows with the rest
-- of the person's.

CREATE TABLE IF NOT EXISTS buzzy_agent_colonies (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  purpose     TEXT NOT NULL DEFAULT '',
  open        BOOLEAN NOT NULL DEFAULT TRUE,
  pos         INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_agent_colonies_user_idx
  ON buzzy_agent_colonies (user_id, pos, created_at);

ALTER TABLE buzzy_agents ADD COLUMN IF NOT EXISTS colony_id TEXT;

CREATE INDEX IF NOT EXISTS buzzy_agents_colony_idx
  ON buzzy_agents (user_id, colony_id);
