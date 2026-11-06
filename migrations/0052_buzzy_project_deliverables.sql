-- 0052_buzzy_project_deliverables.sql
--
-- Three objects, one hierarchy: a thread (buzzy_sessions) produces a project
-- (buzzy_jobs) which owns deliverables (buzzy_assets). Until now a deliverable
-- could not name the project it belonged to, and a project could claim
-- "Draft ready" with no file behind it — which is why a job card could offer
-- "Download the paper" for a paper that was never rendered.
--
-- This migration makes the link explicit and records what happened inside each
-- turn, so a session has a real log instead of a transcript with no timings.

ALTER TABLE buzzy_assets ADD COLUMN IF NOT EXISTS job_id     TEXT;
ALTER TABLE buzzy_assets ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_buzzy_assets_job
  ON buzzy_assets (user_id, job_id);
CREATE INDEX IF NOT EXISTS idx_buzzy_assets_session
  ON buzzy_assets (user_id, session_id);

CREATE TABLE IF NOT EXISTS buzzy_turn_log (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  session_id   TEXT,
  job_id       TEXT,
  surface      TEXT,                       -- 'text' | 'voice'
  model        TEXT,
  latency_ms   INTEGER,
  stages       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{phase,label,etaMs,atMs}]
  tools        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{name,state,ms}]
  artifacts    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{kind,id,url,name,bytes,type}]
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buzzy_turn_log_session
  ON buzzy_turn_log (user_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buzzy_turn_log_job
  ON buzzy_turn_log (user_id, job_id, created_at DESC);
