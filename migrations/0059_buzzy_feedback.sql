-- 0059 — CR-6 feedback.
--
-- Two tables, both with a short life by design:
--
--   buzzy_feedback        the report itself. `diag` is the consented environment
--                         snapshot and nothing else; `account_email` does not
--                         exist because 7318 dropped it — the stored row must
--                         not hold more than the panel showed. `user_id` is
--                         NULL for anonymous reports and is deleted with the
--                         account (portability.ts DELETION_STATEMENTS), never
--                         kept as a 24-month archive of a closed account.
--   buzzy_feedback_asr_hits
--                         one row per anonymous transcription request, pruned
--                         after two days. It exists so the 15/hour/ip and the
--                         whole-route cap are counted across BOTH services
--                         rather than in one process's memory. No audio, no
--                         text, no transcript — only the peppered ip hash and
--                         the time.
--
-- `ip_hash` is nullable on purpose: retention nulls it at 90 days. Every read
-- of it is scoped to `created_at > now() - interval '1 day'`, so a NULL hash
-- can never be compared against a live request (a NULL-mixed `ip_hash = $1`
-- would match nothing — or, worse, be counted — depending on the query shape;
-- the time scope is what makes it impossible).
--
-- `id` is TEXT because this deployment has no uuid extension in its migration
-- history; the server generates it.

CREATE TABLE IF NOT EXISTS buzzy_feedback (
  id              TEXT PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id         TEXT,
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  page_url        TEXT,
  route           TEXT,
  app_sha         TEXT,
  diag            JSONB,
  diag_redactions INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','triaged','fixed','wontfix','duplicate')),
  admin_note      TEXT,
  ip_hash         TEXT,
  ua              TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_feedback_created_idx
  ON buzzy_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_feedback_status_created_idx
  ON buzzy_feedback (status, created_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_feedback_user_created_idx
  ON buzzy_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_feedback_ip_created_idx
  ON buzzy_feedback (ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS buzzy_feedback_asr_hits (
  id         BIGSERIAL PRIMARY KEY,
  ip_hash    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_feedback_asr_hits_ip_created_idx
  ON buzzy_feedback_asr_hits (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_feedback_asr_hits_created_idx
  ON buzzy_feedback_asr_hits (created_at DESC);
