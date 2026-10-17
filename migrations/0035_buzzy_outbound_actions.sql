-- BZ-F033: approved external actions + delivery receipts.
-- Every outward action is its own record: exact document version, recipient,
-- one-shot approval, idempotency key, and a receipt telling the truth about
-- what actually happened (including "no channel configured — nothing sent").
CREATE TABLE IF NOT EXISTS buzzy_outbound_actions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  doc_id          TEXT NOT NULL REFERENCES buzzy_documents(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'email' CHECK (kind IN ('email', 'share_link')),
  recipient       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'blocked', 'sent', 'cancelled')),
  idempotency_key TEXT NOT NULL,
  receipt         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS buzzy_outbound_user ON buzzy_outbound_actions (user_id, created_at DESC);
