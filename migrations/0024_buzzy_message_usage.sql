-- 0024: Buzzy per-turn LLM usage accounting (Phase 0 — Tools & Agent Loop).
-- Tool results and a bounded model loop make token/latency/cost accounting
-- per turn non-optional (plan doc 23: preconditions #3). Additive columns on
-- the assistant rows; user rows stay null. cost_usd stays nullable until a
-- price map exists in the model catalog.
ALTER TABLE buzzy_chat_messages
  ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS total_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6);
