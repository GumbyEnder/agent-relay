-- Recipe Seal — Step 4: capability tokens.
-- Opaque `rcp_…` secrets, stored only as sha256 so a database dump cannot be
-- replayed against the API. One licence may hold several tokens (one per agent).

CREATE TABLE IF NOT EXISTS ar_recipe_token (
  id            text PRIMARY KEY,
  license_id    text NOT NULL REFERENCES ar_recipe_license(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  label         text,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ar_recipe_token_license_idx
  ON ar_recipe_token (license_id);

-- Run ledger. Verdict holds CODES ONLY: no draft text, no prompt text, ever.
CREATE TABLE IF NOT EXISTS ar_recipe_run (
  id           text PRIMARY KEY,
  license_id   text NOT NULL REFERENCES ar_recipe_license(id) ON DELETE CASCADE,
  bundle_hash  text NOT NULL,
  idem_key     text,
  inputs_hash  text NOT NULL,
  output_hash  text,
  verdict      jsonb NOT NULL,
  cost_cents   integer NOT NULL DEFAULT 0,
  tokens_in    integer,
  tokens_out   integer,
  lane         text,
  ms           integer,
  attested     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ar_recipe_run_lane_chk CHECK (lane IS NULL OR lane IN ('api', 'local'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ar_recipe_run_idem_uniq
  ON ar_recipe_run (license_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ar_recipe_run_bundle_idx
  ON ar_recipe_run (bundle_hash, created_at DESC);

-- A run verdict may carry codes and warnings only. Assert it structurally so a
-- future payload change cannot start storing prose in the ledger.
ALTER TABLE ar_recipe_run
  DROP CONSTRAINT IF EXISTS ar_recipe_run_verdict_shape_chk;
ALTER TABLE ar_recipe_run
  ADD CONSTRAINT ar_recipe_run_verdict_shape_chk
  CHECK (
    jsonb_typeof(verdict) = 'object'
    AND NOT (verdict ? 'text')
    AND NOT (verdict ? 'draft')
    AND NOT (verdict ? 'prompt')
  );
