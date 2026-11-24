-- 0055 — the whiteboard follows the person to any computer.
--
-- The Idea Board is the Talk page's surface: the agent.md it read, the steps it
-- took, what it made, and whatever the person dragged onto it. Until this
-- migration that board lived only in the browser that drew it (localStorage
-- "bz.board.<conversation id>"), which means a second computer started blank and
-- a cleared cache lost the drawing. This line serves the same Talk page as the
-- hosted app, so a board that only exists in one browser is the one part that
-- could not follow either.
--
-- buzzy_whiteboards: one board per person and conversation, as it is now. The key
-- is the conversation id, or 'talk' for the board in front of a conversation that
-- has no id yet (voice-stage.js SCRATCH_BOARD). `rev` goes up by one on every save;
-- a save names the rev it started from, so two computers never silently overwrite
-- each other (the later one merges card by card and saves again).
--
-- buzzy_whiteboard_versions: the history. Every save lands in the newest entry; a
-- save more than five minutes after that entry began starts a new one, and going
-- back to an earlier entry always starts a new one. At most 30 entries per board,
-- none older than 90 days (pruned on save, filtered on read).
--
-- The rules that clean, cap and check a board live in src/lib/buzzy/whiteboards.ts;
-- this file only makes the shelves.

CREATE TABLE IF NOT EXISTS buzzy_whiteboards (
  user_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  -- { v: 2, cards: [...], links: [...], view: { x, y, z } }, cleaned and capped
  -- (1 MB) by whiteboards.ts before it gets here.
  state        JSONB NOT NULL,
  rev          INTEGER NOT NULL DEFAULT 1,
  card_count   INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS buzzy_whiteboards_user_idx
  ON buzzy_whiteboards (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS buzzy_whiteboard_versions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  rev          INTEGER NOT NULL,
  state        JSONB NOT NULL,
  card_count   INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  -- A few card titles, newest first, one per line: what the history list shows.
  titles       TEXT NOT NULL DEFAULT '',
  -- 'save' for ordinary saves, 'restore' when the person went back to an earlier one.
  reason       TEXT NOT NULL DEFAULT 'save' CHECK (reason IN ('save', 'restore')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, session_id)
    REFERENCES buzzy_whiteboards (user_id, session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS buzzy_whiteboard_versions_board_idx
  ON buzzy_whiteboard_versions (user_id, session_id, id DESC);
