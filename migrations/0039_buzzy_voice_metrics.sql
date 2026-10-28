-- 0039 — voice + turn latency metrics.
--
-- Time to talk is a product metric, not a log line. Every spoken turn records
-- two rows: the SERVER's own timings (extract / model / honcho) and the
-- CLIENT's experienced timings (mic stop → send → first audio → turn end).
-- Keeping them apart is the point: a slow model and a slow client are
-- different bugs.
--
-- Identity only — never message text, transcripts or audio.

CREATE TABLE IF NOT EXISTS buzzy_voice_metrics (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  job_id        TEXT,
  session_id    TEXT,
  source        TEXT NOT NULL DEFAULT 'client',  -- client | server
  mode          TEXT,                            -- chat | work
  model         TEXT,
  asr_ms        INTEGER,   -- mic stopped speaking → request sent (client)
  ttft_ms       INTEGER,   -- request sent → first text delta
  ttfa_ms       INTEGER,   -- request sent → first audio heard (client) / first audio chunk (server)
  turn_ms       INTEGER,   -- request sent → reply complete
  extract_ms    INTEGER,   -- slot-extraction call (server)
  llm_ms        INTEGER,   -- reply model call (server)
  honcho_ms     INTEGER,   -- memory sync (server, off critical path)
  reply_chars   INTEGER,
  audio_bytes   INTEGER,
  spoken        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_voice_metrics_user_time
  ON buzzy_voice_metrics (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_voice_metrics_time
  ON buzzy_voice_metrics (created_at DESC);
