-- 0040 — tool-call telemetry.
--
-- Every tool the model invokes leaves one row: which tool, which gate applied,
-- how long it took, whether it worked, and how big the result was.
--
-- Deliberately NO arguments and NO result text: a search query is the owner's
-- words and a page result is somebody else's content. Identity + timing only.
--
-- `path` distinguishes HTTP vs rendered reads, so the browser spend can be
-- justified per call rather than argued about.

CREATE TABLE IF NOT EXISTS buzzy_tool_calls (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  job_id       TEXT,
  session_id   TEXT,
  turn_id      TEXT,
  tool         TEXT NOT NULL,
  gate         TEXT,             -- always | draft
  ms           INTEGER,
  ok           BOOLEAN NOT NULL DEFAULT true,
  error_code   TEXT,
  result_bytes INTEGER,
  path         TEXT,             -- http | browser | null
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_tool_calls_user_time
  ON buzzy_tool_calls (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_tool_calls_tool_time
  ON buzzy_tool_calls (tool, created_at DESC);
