-- 0041 — conversation recency + one-line summaries.
--
-- The Recent work list needs three things it could not answer reliably:
--   1. "when did this conversation last move?"  → updated_at must be touched on
--      every turn (it was only written on rename/summary).
--   2. "when did it start?"                     → created_at already exists.
--   3. "what was it about?"                     → summary exists but nothing ever
--      generated one automatically, so every row read "Pick up this conversation".
--
-- summary_at / summary_messages let the summariser decide when a stored summary
-- is stale (every N messages) instead of regenerating on every turn.

ALTER TABLE buzzy_sessions ADD COLUMN IF NOT EXISTS summary_at TIMESTAMPTZ;
ALTER TABLE buzzy_sessions ADD COLUMN IF NOT EXISTS summary_messages INTEGER NOT NULL DEFAULT 0;

-- Recency reads walk (user_id, updated_at); the 0017 index covers it, this one
-- keeps the merge with jobs cheap once there are many sessions.
CREATE INDEX IF NOT EXISTS idx_buzzy_sessions_user_recent
  ON buzzy_sessions (user_id, updated_at DESC, created_at DESC);
