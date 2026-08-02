-- Optional self-reported usage telemetry on deliver (tokens / tools / $).

ALTER TABLE ar_missions
  ADD COLUMN IF NOT EXISTS usage JSONB;
