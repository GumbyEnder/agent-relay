-- Platform admin flags for human accounts (disable/suspend).
-- Kept outside Better Auth's "user" table so we don't fight the auth migrator.
CREATE TABLE IF NOT EXISTS ar_user_admin (
  user_id TEXT PRIMARY KEY,
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ar_user_admin_disabled_idx
  ON ar_user_admin (disabled_at)
  WHERE disabled_at IS NOT NULL;
