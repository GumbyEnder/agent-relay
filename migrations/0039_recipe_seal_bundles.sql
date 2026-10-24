-- Recipe Seal — Step 4: published bundles.
-- Content-addressed by sha256(JCS(manifest)). A bundle row is immutable; a new
-- version is a new hash. `status` only ever moves forward: published -> revoked.

CREATE TABLE IF NOT EXISTS ar_recipe_bundle (
  hash          text PRIMARY KEY,
  recipe_id     text NOT NULL,
  version       text NOT NULL,
  author_id     text NOT NULL,
  manifest      jsonb NOT NULL,
  bundle_ref    text NOT NULL,
  semantic_ref  text NOT NULL,
  checks_ref    text NOT NULL,
  status        text NOT NULL DEFAULT 'published',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ar_recipe_bundle_status_chk CHECK (status IN ('draft', 'published', 'revoked')),
  CONSTRAINT ar_recipe_bundle_version_uniq UNIQUE (recipe_id, version)
);

CREATE INDEX IF NOT EXISTS ar_recipe_bundle_recipe_idx
  ON ar_recipe_bundle (recipe_id, created_at DESC);

-- The manifest must never carry the prose half. Any key named for the semantic
-- payload is rejected at write time so a future change cannot quietly store it.
ALTER TABLE ar_recipe_bundle
  DROP CONSTRAINT IF EXISTS ar_recipe_bundle_no_prose_chk;
ALTER TABLE ar_recipe_bundle
  ADD CONSTRAINT ar_recipe_bundle_no_prose_chk
  CHECK (
    NOT (manifest ? 'semantic_text')
    AND NOT (manifest ? 'prompt')
    AND NOT (manifest ? 'discovery')
  );
