-- Buzzy agent chat — Phase 1 tables
-- Layer 1: flat chat transcript (per user, survives restarts)
CREATE TABLE IF NOT EXISTS buzzy_chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  job_id     TEXT,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Layer 2: structured per-user memory (key-value, Honcho-swappable)
CREATE TABLE IF NOT EXISTS buzzy_user_memory (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  job_id     TEXT,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id, key)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_buzzy_messages_user_job
  ON buzzy_chat_messages (user_id, job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buzzy_memory_user_job
  ON buzzy_user_memory (user_id, job_id);
