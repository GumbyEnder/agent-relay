-- 0042 — repair inflated session activity timestamps.
--
-- The first version of the summariser stamped `updated_at = now()` when it
-- wrote a summary, so a backfill made every old conversation look like it had
-- just been active ("Active just now" on a chat last touched in October).
--
-- Activity means "the owner last spoke", so repair any row whose updated_at is
-- more than a minute later than its newest message. Rows with no messages keep
-- their created_at. Idempotent: a repaired row no longer satisfies the WHERE.

UPDATE buzzy_sessions s
SET updated_at = GREATEST(
      s.created_at,
      COALESCE((SELECT max(m.created_at) FROM buzzy_chat_messages m WHERE m.session_id = s.id), s.created_at)
    )
WHERE EXISTS (SELECT 1 FROM buzzy_chat_messages m WHERE m.session_id = s.id)
  AND s.updated_at > GREATEST(
        s.created_at,
        COALESCE((SELECT max(m.created_at) FROM buzzy_chat_messages m WHERE m.session_id = s.id), s.created_at)
      ) + interval '1 minute';
