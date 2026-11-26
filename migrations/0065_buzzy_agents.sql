-- 0065 — Zilla agents: dedicated helpers in a sidebar, each with a name, a size, a
-- colour and a job.
--
-- Owner, 2026-11-21: "On the left side, we need to create an agent system … a series
-- of agents that can do things on your behalf. Each agent should have a name by
-- default given to them and a size and color." They start with the bee (BeeZilla
-- herself, the executive assistant: she is never a row, the app draws her) and one
-- greyed-out bunny underneath; a plus adds more, "maybe hundreds". Clicking an
-- unconfigured agent asks "what role do you want me to play?", and from then on it
-- "helps with" that job; its face becomes an emoji for the job.
--
-- buzzy_agents: one row per agent a person has made.
--   creature + look  which Zilla picture it wears: public/buzzy/zillas/<creature>.webp
--                    when look is '' (the owner's own art), else
--                    <creature>-<look>.webp (a colour version). Kept as two words,
--                    not a file name, so a real coloured Zilla can replace a
--                    stand-in without touching a row.
--   name             "Bunnyzilla" by default; the person can rename it.
--   color            #RRGGBB, the colour of the Talk button while they talk to it.
--   size             s | m | l, how big its picture is in the sidebar.
--   role             what it helps with, in a few words ("to-do list"). '' means
--                    the agent has no job yet: the sidebar greys it out and Talk
--                    opens on the question "what role do you want me to play?".
--   instructions     the person's own words about the job, kept as they typed them
--                    (capped in agents.ts). Shown to the agent as data they wrote.
--   face             one emoji for the job, or '' for none.
--   pos              the order in the sidebar, lowest first (the person can drag
--                    agents into any order).
--
-- buzzy_agent_seed: a marker that the person has been given their starter agent.
-- Without it a person who deletes the starter bunny would get it back on the next
-- visit. The marker and the starter are written by one statement (agents.ts), so
-- two first visits at the same moment make one bunny, not two.
--
-- buzzy_sessions.agent_id: which agent a conversation belongs to. The session is the
-- authority when a turn is answered (chatLoop asks the session, never the request),
-- so reopening an old conversation from History carries on as the same agent. NULL
-- is an ordinary BeeZilla conversation, which is every conversation made before
-- this file.
--
-- No foreign keys on purpose: an agent that is deleted leaves its conversations in
-- History as ordinary ones (agents.ts clears their agent_id), and the account
-- deletion list (portability.ts) removes these rows with the rest of the person's.

CREATE TABLE IF NOT EXISTS buzzy_agents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  creature      TEXT NOT NULL,
  look          TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,
  size          TEXT NOT NULL DEFAULT 'm' CHECK (size IN ('s', 'm', 'l')),
  role          TEXT NOT NULL DEFAULT '',
  instructions  TEXT NOT NULL DEFAULT '',
  face          TEXT NOT NULL DEFAULT '',
  pos           INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_agents_user_idx
  ON buzzy_agents (user_id, pos, created_at);

CREATE TABLE IF NOT EXISTS buzzy_agent_seed (
  user_id    TEXT PRIMARY KEY,
  seeded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE buzzy_sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;

CREATE INDEX IF NOT EXISTS buzzy_sessions_agent_idx
  ON buzzy_sessions (user_id, agent_id, updated_at DESC);
