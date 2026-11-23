-- 0068 — The brain: one tree for everything BeeZilla and the Zilla agents keep, and Code
-- Monkey, the coding agent every account starts with.
--
-- Owner, 2026-11-23: "whenever somebody clicks a folder, they should also see a /brain at
-- the very core, which they can breadcrumb back to. When they breadcrumb back to it, it shows
-- them their memories… At the core, it'll be like, instead of /C, it'll be like brain. And
-- then we'll have a division… /knowledge… /systems… and… assets." Systems is "anything that
-- isn't knowledge… skills, bots… their agent.md… The avatar of the bot", with skills stored
-- "under what they're useful for: web design, programming"; assets are reusable media ("a
-- video clip of a monkey dancing"). "The memory is going to store and reorganize everything
-- the AI stores based on what it thinks is the fastest path on a regular basis."
--
-- The tree itself is worked out by brain.ts from what is already kept (remembered decisions,
-- conversations, files, the agents, the skills). These tables hold only what that cannot
-- know on its own:
--
-- buzzy_brain_places: where one thing sits in the tree. `item` names the thing by where it
--   comes from ("fact:<job>:<key>", "chat:<session>", "file:<asset id>"). `placed_by` is
--   'auto' when the tidy put it there, 'person' when the person moved it: the tidy never
--   moves a thing the person placed.
-- buzzy_brain_folders: folders the person made themselves. An empty one stays until they
--   remove it; the tidy never removes it.
-- buzzy_brain_touches: which folder a turn was about, who was speaking (an agent's id, or
--   'bzilla') and in which conversation. It is what "the folders a bot often operates from"
--   and "recent sessions related to that folder" are read from. Only the newest 5000 of a
--   person are kept (brain.ts prunes as it writes).
-- buzzy_brain_tidy: when the person's brain was last tidied and what the tidy did, so it
--   runs on its cadence (once a day, or sooner once 20 new things are waiting) and the
--   Memory tab can say when it last ran.
--
-- buzzy_agents.domains: the folders an agent works in, given when it is made (by the person,
--   or by BeeZilla when she makes one) or worked out from its job. A JSON list of paths
--   under brain/ ("knowledge/programming", "systems/skills/programming").
--
-- buzzy_agent_starters: one row per starter agent a person has been given (0065's
--   buzzy_agent_seed covers the first one, the grey bunny). 'code-monkey' is the coding
--   agent under BeeZilla. The marker and the agent are written by one statement, so two
--   first visits make one Code Monkey, and one the person removed never comes back.
--
-- No foreign keys, as in 0065-0067: the account deletion list (portability.ts) removes these
-- rows with the rest of the person's.

CREATE TABLE IF NOT EXISTS buzzy_brain_places (
  user_id    TEXT NOT NULL,
  item       TEXT NOT NULL,
  path       TEXT NOT NULL,
  placed_by  TEXT NOT NULL DEFAULT 'auto' CHECK (placed_by IN ('auto', 'person')),
  placed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item)
);

CREATE TABLE IF NOT EXISTS buzzy_brain_folders (
  user_id     TEXT NOT NULL,
  path        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, path)
);

CREATE TABLE IF NOT EXISTS buzzy_brain_touches (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  path        TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  session_id  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_brain_touches_user_idx
  ON buzzy_brain_touches (user_id, at DESC);
CREATE INDEX IF NOT EXISTS buzzy_brain_touches_path_idx
  ON buzzy_brain_touches (user_id, path);

CREATE TABLE IF NOT EXISTS buzzy_brain_tidy (
  user_id     TEXT PRIMARY KEY,
  tidied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  items       INTEGER NOT NULL DEFAULT 0,
  moved       INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE buzzy_agents ADD COLUMN IF NOT EXISTS domains JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS buzzy_agent_starters (
  user_id    TEXT NOT NULL,
  starter    TEXT NOT NULL,
  seeded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, starter)
);
