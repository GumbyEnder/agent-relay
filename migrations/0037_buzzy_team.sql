-- BZ-F041: multi-user identity — membership is the precondition for F034.
-- Members are real signed-in accounts (better-auth magic link). The owner's
-- data stays keyed by the owner's user_id; member access resolves THROUGH
-- this table, never by sharing credentials.
CREATE TABLE IF NOT EXISTS buzzy_team_members (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  member_user_id TEXT,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('admin', 'member', 'reviewer')),
  status        TEXT NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited', 'active', 'revoked')),
  invited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ,
  UNIQUE (owner_user_id, email)
);

CREATE TABLE IF NOT EXISTS buzzy_team_invites (
  token      TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES buzzy_team_members(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_team_members_owner ON buzzy_team_members (owner_user_id, status);
CREATE INDEX IF NOT EXISTS buzzy_team_members_user ON buzzy_team_members (member_user_id, status);
