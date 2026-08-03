-- Team / company tenancy sketch (unused by app runtime until product wires it).
-- Safe no-op for existing flows: all new tables empty; boards unchanged.

CREATE TABLE IF NOT EXISTS ar_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ar_teams (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES ar_companies (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug)
);

CREATE TABLE IF NOT EXISTS ar_company_members (
  company_id TEXT NOT NULL REFERENCES ar_companies (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE IF NOT EXISTS ar_team_members (
  team_id TEXT NOT NULL REFERENCES ar_teams (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

ALTER TABLE ar_projects
  ADD COLUMN IF NOT EXISTS company_id TEXT,
  ADD COLUMN IF NOT EXISTS owner_team_id TEXT;

CREATE INDEX IF NOT EXISTS ar_projects_company_idx ON ar_projects (company_id);
CREATE INDEX IF NOT EXISTS ar_projects_owner_team_idx ON ar_projects (owner_team_id);
CREATE INDEX IF NOT EXISTS ar_company_members_user_idx ON ar_company_members (user_id);
CREATE INDEX IF NOT EXISTS ar_team_members_user_idx ON ar_team_members (user_id);
