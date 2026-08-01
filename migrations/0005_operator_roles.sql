-- Human operator roles (viewer / operator / admin). Agents use API keys, not this table.

CREATE TABLE IF NOT EXISTS ar_operator_roles (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ar_operator_roles_email_idx
  ON ar_operator_roles (lower(email));
