-- Tester feedback (owner, 2026-11-17): "Collect confusion points, bug reports,
-- screenshots, and real task results." One row per report, written from "Send
-- feedback" in the menu under your name and read by admins on /buzzy/testers.
-- The screenshot is the picture the person chose, as a data URL (1.5 MB at most).
CREATE TABLE IF NOT EXISTS buzzy_feedback (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  page        TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL,
  screenshot  TEXT,
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS buzzy_feedback_created_idx ON buzzy_feedback (created_at DESC);
