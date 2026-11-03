-- Which lane answered, and whether the client heard the same voice.
-- A turn on the text lane with spoken=false and voice requested is exactly the
-- "it sounded different / it was silent" report, so it needs to be queryable.
ALTER TABLE buzzy_voice_metrics ADD COLUMN IF NOT EXISTS lane TEXT;
ALTER TABLE buzzy_voice_metrics ADD COLUMN IF NOT EXISTS session_id_text TEXT;
CREATE INDEX IF NOT EXISTS idx_buzzy_voice_metrics_created
  ON buzzy_voice_metrics (created_at DESC);
