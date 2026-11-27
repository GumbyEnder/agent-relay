-- 0072 — 3D model jobs, kept so each one has an owner and takes each step once.
--
-- A 3D model is several Meshy tasks in a row: the shape, then its paint (refine), and a
-- repaint when one comes back bare (models3d.ts). The page polls; the poll starts the next
-- step. Kept here, not in memory, so (independent review, 2026-11-25):
--   - a job is only ever polled — and its file only ever kept — by the person who started
--     it, also after a restart;
--   - the next step is claimed once (next_id): two polls at the same moment, or a retry
--     after a lost answer, never start (and pay for) a second task; every poller is given
--     the same next id;
--   - a repaint loads the person's picture by its Library id when it is needed, instead of
--     holding the picture's bytes in memory.

CREATE TABLE IF NOT EXISTS buzzy_model3d_jobs (
  meshy_id        TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  -- img | mimg | txt | ref | rtx  (models3d.ts parseJobId)
  kind            TEXT NOT NULL,
  purpose         TEXT NOT NULL DEFAULT 'game',
  prompt          TEXT NOT NULL DEFAULT '',
  texture_prompt  TEXT,
  -- The person's front picture (buzzy_assets.id), for a repaint. Never the bytes.
  picture_id      BIGINT,
  parent_id       TEXT,
  -- The job id ("ref.…", "rtx.…") that continues this one; 'pending' while it is being started.
  next_id         TEXT,
  next_claimed_at TIMESTAMPTZ,
  repainted       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_model3d_jobs_user ON buzzy_model3d_jobs (user_id, created_at DESC);
