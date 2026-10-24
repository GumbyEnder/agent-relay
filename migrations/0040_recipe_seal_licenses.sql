-- Recipe Seal — Step 4: licences.
-- A licence grants execution rights against ONE bundle hash. It never grants the
-- text. `used` is incremented by a single atomic UPDATE (see registry.ts) — a
-- read-then-write quota check is the classic over-issue bug and is not used.

CREATE TABLE IF NOT EXISTS ar_recipe_license (
  id             text PRIMARY KEY,
  bundle_hash    text NOT NULL REFERENCES ar_recipe_bundle(hash) ON DELETE CASCADE,
  licensee_kind  text NOT NULL,
  licensee_id    text NOT NULL,
  scopes         text[] NOT NULL DEFAULT '{run,verify}',
  quota          integer,
  used           integer NOT NULL DEFAULT 0,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_by     text,
  price_cents    integer NOT NULL DEFAULT 0,
  split_bp       jsonb NOT NULL DEFAULT '{"author":7000,"platform":3000}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ar_recipe_license_kind_chk CHECK (licensee_kind IN ('account', 'agent', 'org')),
  CONSTRAINT ar_recipe_license_quota_chk CHECK (quota IS NULL OR quota >= 0),
  CONSTRAINT ar_recipe_license_used_chk CHECK (used >= 0)
);

CREATE INDEX IF NOT EXISTS ar_recipe_license_bundle_idx
  ON ar_recipe_license (bundle_hash, licensee_id);
CREATE INDEX IF NOT EXISTS ar_recipe_license_licensee_idx
  ON ar_recipe_license (licensee_kind, licensee_id);
