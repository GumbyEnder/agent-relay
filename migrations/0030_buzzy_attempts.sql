-- BZ-F024: server attempt identity for bounded, non-duplicating retry (QA-09/10).
-- attempt_id ties a client send to exactly one assistant reply — a retried
-- POST with the same attempt_id reconciles to the stored reply instead of
-- re-calling the model (no duplicate charge/artifact).
ALTER TABLE buzzy_chat_messages
  ADD COLUMN IF NOT EXISTS attempt_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS buzzy_chat_attempt_dedupe
  ON buzzy_chat_messages (user_id, COALESCE(job_id, ''), COALESCE(session_id, ''), attempt_id)
  WHERE attempt_id IS NOT NULL;
