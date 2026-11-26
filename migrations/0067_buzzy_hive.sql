-- 0067 — The Hive: the log of what the Zilla agents asked each other.
--
-- Owner, 2026-11-21: "When it scrolls above Bzilla, you see something called Hive… If you
-- click on it, you can see your agents talking to each other to get things done,
-- agent-to-agent chat, and observe it happening in the background: a window of chats that
-- say 'Bunnyzilla asked Bzilla for this.' Bzilla manages all the other agents and can talk
-- across all contexts: an executive assistant that works across all contexts."
--
-- Two things make agents talk, and both are real model calls (hive.ts): an agent in a
-- conversation asks BeeZilla for something outside its job (ask_bzilla), and BeeZilla asks one
-- of the person's agents something that is its job (ask_agent). Each one leaves two lines
-- here, the question and the answer, and the Hive window in the sidebar reads them back.
-- Short notes sit among them too ("Bunnyzilla took on a job: calendars").
--
-- buzzy_hive_messages: one row per line in that window.
--   id          BIGSERIAL: the order lines were written in, which is the order the window
--               shows them in. The window asks for "everything after the last id it saw".
--   thread      one random id shared by the question and its answer, so a reader can pair
--               them up. A note has a thread of its own.
--   kind        ask | answer | note.
--   from_id     who said it: an agent's id (ag_…), or the text 'bzilla' for BeeZilla herself.
--   to_id       who it was said to, in the same words. A note is from and to the same one.
--   from_name,  the names as they were when the line was written, copied in on purpose: a
--   to_name     line must still read right after an agent is renamed or removed ("Bunnyzilla
--               asked BeeZilla" stays that, whatever Bunnyzilla is called next week).
--   body        what was said, up to 4000 characters, cleaned of control characters
--               (hive.ts). Line breaks stay.
--   session_id  the conversation the line was written in, when there was one. Only for
--               tracing a line back to its turn: the Hive route never returns it.
--
-- Only the last 2000 lines of a person are kept: hive.ts removes the oldest as it writes, so
-- the table cannot grow without bound however chatty the agents get.
--
-- No foreign keys on purpose, as in 0065 and 0066: an agent that is deleted leaves its lines
-- behind, still reading right because of the copied names, and the account deletion list
-- (portability.ts) removes these rows with the rest of the person's.

CREATE TABLE IF NOT EXISTS buzzy_hive_messages (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  thread      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('ask', 'answer', 'note')),
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  from_name   TEXT NOT NULL,
  to_name     TEXT NOT NULL,
  body        TEXT NOT NULL,
  session_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_hive_messages_user_idx
  ON buzzy_hive_messages (user_id, id);
