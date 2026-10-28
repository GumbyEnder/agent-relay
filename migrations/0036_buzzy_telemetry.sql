-- BZ-F039: privacy-conscious success telemetry.
-- Identity + revision references only. No raw chat, brief or document content
-- is ever stored here — the recorder enforces that at write time.
CREATE TABLE IF NOT EXISTS buzzy_telemetry (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  job_id     TEXT,
  doc_id     TEXT,
  event      TEXT NOT NULL,
  props      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS buzzy_telemetry_user_time ON buzzy_telemetry (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_telemetry_event ON buzzy_telemetry (event, created_at DESC);
