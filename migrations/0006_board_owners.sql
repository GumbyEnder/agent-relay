-- User-owned boards (product language: Board; table remains ar_projects).

ALTER TABLE ar_projects
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT;

CREATE INDEX IF NOT EXISTS ar_projects_owner_idx
  ON ar_projects (owner_user_id);

-- Legacy seed rows stay shared (owner_user_id NULL) until claimed/hidden by product rules.
