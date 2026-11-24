-- 0056 — a recipe made by selecting part of the board.
--
-- The board is not only a place to watch work: select the cards that describe a
-- process (an agent.md, the skills, the output) and "Create recipe" turns that
-- selection into something the person can run again. This table keeps those
-- recipes, owned by one account, newest first. The graph is the selection as the
-- board stored it (nodes and the lines between them), cleaned and capped by
-- src/lib/buzzy/boardRecipes.ts before it gets here; the route is
-- /api/buzzy/board-recipes (chat.nitro.ts).
--
-- Why a table of its own rather than a row in buzzy_graphs: a board recipe is
-- drawn on the Idea Board and belongs to the person, not to an orchestration run,
-- and 0049's graphs are the runtime graph store with revisions.

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
