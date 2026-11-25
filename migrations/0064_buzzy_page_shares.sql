-- 0064 — sharing a page, only after the person says yes (owner, 2026-11-21).
--
-- The QR code and Copy page link used to hand out the page's own address, which opens
-- nothing for anyone else (every page asks them to sign in). Now they open a window that
-- says plainly what becomes public and to whom; only its "Yes, share this page" makes the
-- row below, and the link it gives is the only door:  /buzzy/p/<token>.
--
-- What a link shows is a COPY made at that moment (snapshot): the person's Idea Board
-- cards and the conversation in front of it, as text. Nothing is read from their account
-- when someone opens the link, so what is public is exactly what the window listed, and
-- later changes stay private until they choose "Update". See src/lib/buzzy/pageShare.ts.
--
-- search_blocked is the small "Block searches" tick, on unless they untick it. While it is
-- on, the page is served with `X-Robots-Tag: noindex…` and a robots meta tag. Turning the
-- link off sets revoked_at AND empties the copy, so nothing lingers in the table.
--
-- One live link per person and board: sharing again updates it (same address, so a
-- printed QR code keeps working) instead of piling up links.

CREATE TABLE IF NOT EXISTS buzzy_page_shares (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  -- The conversation id, or 'talk' for the board in front of a conversation with no id.
  board_id       TEXT NOT NULL,
  -- ps_ + 43 url-safe characters (32 random bytes). The address is the only secret.
  token          TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL DEFAULT '',
  search_blocked BOOLEAN NOT NULL DEFAULT TRUE,
  -- { v: 1, title, sharedAt, cards: [...], lines, messages: [...] } — built on the server
  -- from the person's own rows, capped (600 KB) and text-only. '{}' once turned off.
  snapshot       JSONB NOT NULL,
  bytes          INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS buzzy_page_shares_user ON buzzy_page_shares (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS buzzy_page_shares_live
  ON buzzy_page_shares (user_id, board_id) WHERE revoked_at IS NULL;
