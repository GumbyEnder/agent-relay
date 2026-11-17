-- The owner's privacy mode belongs to the account, not to one browser.
--
-- Talk's privacy slider (Advocate · Lockdown · Open) was stored per browser and
-- sent with each chat turn, so a second device — or the Ask panel on another
-- page before the slider was touched there — ran without the Lockdown the owner
-- had chosen. One row per account; the chat reads it on every turn and applies
-- Lockdown if EITHER the account or the request says so.
CREATE TABLE IF NOT EXISTS buzzy_privacy_mode (
  user_id    TEXT PRIMARY KEY,
  mode       TEXT NOT NULL DEFAULT 'open' CHECK (mode IN ('advocate', 'lockdown', 'open')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
