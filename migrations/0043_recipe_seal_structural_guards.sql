-- Recipe Seal — Step 4 hardening from independent review.
--
-- 0039's prose guard was a *naming ban*: it rejected the literal keys
-- semantic_text / prompt / discovery, so a manifest carrying {"guidance": …} or
-- {"checklist": …} stored prose happily. Replace it with a structural allow-list:
-- a manifest may contain ONLY the protocol's keys, at top level and inside
-- capability. That is checkable, versioned, and cannot be sidestepped by renaming.

ALTER TABLE ar_recipe_bundle DROP CONSTRAINT IF EXISTS ar_recipe_bundle_no_prose_chk;
ALTER TABLE ar_recipe_bundle DROP CONSTRAINT IF EXISTS ar_recipe_bundle_manifest_keys_chk;
ALTER TABLE ar_recipe_bundle ADD CONSTRAINT ar_recipe_bundle_manifest_keys_chk
  CHECK (
    (manifest - ARRAY[
      'protocol', 'id', 'version', 'created_at', 'author', 'capability', 'checks',
      'semantic', 'dek_wrapped', 'evals', 'pricing', 'chain', 'signature'
    ]::text[]) = '{}'::jsonb
  );

ALTER TABLE ar_recipe_bundle DROP CONSTRAINT IF EXISTS ar_recipe_bundle_capability_keys_chk;
ALTER TABLE ar_recipe_bundle ADD CONSTRAINT ar_recipe_bundle_capability_keys_chk
  CHECK (
    (manifest->'capability') - ARRAY[
      'inputs', 'outputs', 'tools', 'forbidden_tools', 'boundary_summary'
    ]::text[] = '{}'::jsonb
  );

-- Quota can never be overspent, even by a bug in application code.
ALTER TABLE ar_recipe_license DROP CONSTRAINT IF EXISTS ar_recipe_license_used_le_quota_chk;
ALTER TABLE ar_recipe_license ADD CONSTRAINT ar_recipe_license_used_le_quota_chk
  CHECK (quota IS NULL OR used <= quota);
