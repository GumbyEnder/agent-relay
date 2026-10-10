-- Buzzy sessions — first-class Talk sessions (dogfood 163)
CREATE TABLE IF NOT EXISTS buzzy_sessions (
  id         TEXT PRIMARY KEY,            -- e.g. 'sess_' || random suffix
  user_id    TEXT NOT NULL,
  job_id     TEXT,                        -- nullable: loose Talk sessions allowed
  title      TEXT NOT NULL DEFAULT 'New session',
  summary    TEXT,                        -- AI summary, <=200 words
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_sessions_user
  ON buzzy_sessions (user_id, updated_at DESC);
ALTER TABLE buzzy_chat_messages ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_buzzy_messages_session
  ON buzzy_chat_messages (session_id, created_at ASC);
