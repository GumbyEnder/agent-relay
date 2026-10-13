-- B8: backfill buzzy_sessions from existing chat history.
-- The Sessions drawer used to appear empty even when chat messages existed,
-- because sessions were only created going forward. Groups every distinct
-- (user_id, job_id) with messages into one session and stamps messages with
-- that session id so past conversations reopen correctly.
INSERT INTO buzzy_sessions (id, user_id, job_id, title, created_at, updated_at)
SELECT
  'sess_bf_' || substr(md5(m.user_id || '::' || COALESCE(m.job_id, '')), 1, 24),
  m.user_id,
  m.job_id,
  'Past chat',
  min(m.created_at),
  max(m.created_at)
FROM buzzy_chat_messages m
GROUP BY m.user_id, m.job_id
ON CONFLICT (id) DO NOTHING;

UPDATE buzzy_chat_messages m
SET session_id = s.id
FROM buzzy_sessions s
WHERE m.user_id = s.user_id
  AND m.job_id IS NOT DISTINCT FROM s.job_id
  AND m.session_id IS NULL;