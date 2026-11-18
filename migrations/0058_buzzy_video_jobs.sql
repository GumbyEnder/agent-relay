-- 0058 — video jobs started by BeeZilla.
--
-- Why: the video recipes run on a separate render service (the Breadcrumbs kit)
-- behind one shared X-Kit-Token. That token can read ANY job on that service, so
-- BeeZilla must hold its own record of which user started which kit job. Without
-- this table, `GET /api/buzzy/video/<kit job id>` would be an open proxy to every
-- other user's video.
--
-- The topic text is deliberately NOT stored: the kit is told the topic, BeeZilla
-- keeps only its sha256 so a job can be recognised without the words sitting in a
-- table, a log line or a support dump.
--
-- state mirrors the kit's vocabulary (queued | running | done | failed) and is
-- updated when a poll observes a change, so a lost poll costs nothing.

CREATE TABLE IF NOT EXISTS buzzy_video_jobs (
  job_id      TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  recipe      TEXT NOT NULL,
  topic_sha   TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'queued',
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_video_jobs_user_created_idx
  ON buzzy_video_jobs (user_id, created_at DESC);
