-- Entitlements + usage ledger: what makes "our keys as a service" billable.
--
-- Kept beside ar_user_admin rather than inside Better Auth's "user" table: the auth
-- migrator owns that table and we do not fight it.
--
-- bz_entitlements  one row per account: which plan, until when, and the epoch before
--                  which every minted token is stale (instant revocation without a
--                  deny list).
-- bz_usage         one row per spent capability. units are the thing the provider
--                  bills us for: requests for inference, seconds for music.
--
-- Quotas are computed from this ledger over a rolling 24 h window rather than kept
-- in counters: a counter drifts the moment a request dies half-way, and reconciling
-- it costs more than a sum over an index.
CREATE TABLE IF NOT EXISTS bz_entitlements (
  user_id            TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  plan               TEXT NOT NULL DEFAULT 'free',
  plan_until         TIMESTAMPTZ,
  tokens_valid_after TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bz_usage (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  scope      TEXT NOT NULL,
  units      NUMERIC NOT NULL DEFAULT 1,
  ms         INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,
  code       TEXT,
  model      TEXT,
  jti        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bz_usage_user_scope_time_idx
  ON bz_usage (user_id, scope, created_at DESC);

CREATE INDEX IF NOT EXISTS bz_usage_time_idx
  ON bz_usage (created_at DESC);
