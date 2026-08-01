-- Mark seed/demo agents so the UI can hide them by default.

ALTER TABLE ar_agents
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

UPDATE ar_agents
SET is_demo = true
WHERE id IN (
  'agent_scout',
  'agent_forge',
  'agent_lens',
  'agent_relay',
  'agent_night',
  'agent_hermes',
  'agent_grok',
  'agent_omp',
  'agent_openclaw'
)
OR notes = 'seed';
