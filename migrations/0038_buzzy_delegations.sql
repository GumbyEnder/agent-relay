-- BZ-F034: team spaces + delegated approvals with explicit caps.
-- A delegation grants one action to one member, optionally scoped to a company
-- ("space") and capped by an amount. Absence of a row means no delegation —
-- permission is never implied by role alone for actions the role lacks.
CREATE TABLE IF NOT EXISTS buzzy_delegations (
  id                TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL REFERENCES buzzy_team_members(id) ON DELETE CASCADE,
  owner_user_id     TEXT NOT NULL,
  action            TEXT NOT NULL
                    CHECK (action IN ('accept_document', 'request_changes', 'send_outbound', 'share_link')),
  scope_company_id  TEXT,
  max_amount_cents  INTEGER,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, action, scope_company_id)
);
CREATE INDEX IF NOT EXISTS buzzy_delegations_member ON buzzy_delegations (member_id, action);
