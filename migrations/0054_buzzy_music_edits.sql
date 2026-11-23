-- The music studio's change log.
--
-- A track is not one file: it is a plan (lyrics, instruments, structure) plus the
-- sequence of edits that produced each render. Storing only the newest MP3 loses
-- both the history and the instruction that caused it, and the agent cannot be
-- "given information on all changes" if the changes were never written down.
--
-- One row per edit, whoever made it (the owner dragging a region, or the model
-- told to change one). before/after point at buzzy_assets so a version can always
-- be played back, and `note` carries what the renderer actually did — including
-- "the provider re-rendered the whole track", which is the truth for ElevenLabs.
CREATE TABLE IF NOT EXISTS buzzy_music_edits (
  id               BIGSERIAL PRIMARY KEY,
  user_id          TEXT NOT NULL,
  job_id           TEXT NOT NULL,
  actor            TEXT NOT NULL DEFAULT 'user',
  instruction      TEXT,
  region_from_ms   INTEGER,
  region_to_ms     INTEGER,
  before_asset_id  BIGINT,
  after_asset_id   BIGINT,
  note             TEXT,
  changes          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buzzy_music_edits_job
  ON buzzy_music_edits (user_id, job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_buzzy_music_edits_asset
  ON buzzy_music_edits (after_asset_id);
