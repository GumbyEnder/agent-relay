-- 0026: Multi-owner groundwork (plan doc 23, "multi-owner notes") — the
-- approval gate is per-HUMAN, not per-business. Every consequential action
-- on a job is attributable to a named person. buzzy already keys rows by
-- user_id; this adds the action-attribution trail.
CREATE TABLE IF NOT EXISTS buzzy_job_events (
  id         BIGSERIAL PRIMARY KEY,
  job_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buzzy_job_events_job
  ON buzzy_job_events (job_id, created_at DESC);

-- Authority levels, not seat tiers: what each action class requires.
-- Owner-only classes are the money and outward ones (consent-granularity
-- table). This is a data constant of the product, not a feature gate.
CREATE TABLE IF NOT EXISTS buzzy_action_authority (
  action_class TEXT PRIMARY KEY,
  requires     TEXT NOT NULL DEFAULT 'session_user'
);
INSERT INTO buzzy_action_authority (action_class, requires) VALUES
  ('read',        'session_user'),
  ('render',      'session_user'),
  ('draft_save',  'session_user'),
  ('approve',     'owner'),
  ('overwrite',   'owner'),
  ('outward',     'owner')
ON CONFLICT (action_class) DO NOTHING;
