-- 0060 — the whiteboard follows the person to any computer.
--
-- Asked 2026-11-18: save the Talk page's whiteboard to the person's account instead
-- of only the browser that drew it, with a simple history to go back to. Until now
-- each board lived in localStorage ("bz.board.<conversation id>"); that copy stays,
-- as the buffer while the account can't be reached (public/buzzy/whiteboard.js).
--
-- buzzy_whiteboards: one board per person and conversation, as it is now. The key
-- is the conversation id, or 'talk' for the board in front of a conversation that
-- has no id yet. `rev` goes up by one on every save; a save names the rev it started
-- from, so two computers never silently overwrite each other (the later one merges
-- first). See src/lib/buzzy/whiteboards.ts.
--
-- buzzy_whiteboard_versions: the history. Every save lands in the newest entry; a
-- save more than five minutes after that entry began starts a new one, and going
-- back to an earlier entry always starts a new one. At most 30 entries per board,
-- none older than 90 days (pruned on save, filtered on read).

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
