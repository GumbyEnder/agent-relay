-- Recipe Seal — the shopfront.
--
-- A shopper needs to see what they are buying: title, description, author, when it
-- was made, when it last changed, and the price in Honey Drops. None of that is the
-- recipe. The sealed half stays sealed; `listing` is the only part of the manifest
-- written *about* the recipe rather than *of* it.
--
-- Two things to notice:
--   * adding a top-level key is a structural change, so the allow-list from 0043 is
--     replaced rather than extended in place — the DB refuses any manifest key the
--     protocol does not define;
--   * `listing` gets its own key allow-list for the same reason `capability` did:
--     an open object beside free text is where prose gets stored.

ALTER TABLE ar_recipe_bundle DROP CONSTRAINT IF EXISTS ar_recipe_bundle_manifest_keys_chk;
ALTER TABLE ar_recipe_bundle ADD CONSTRAINT ar_recipe_bundle_manifest_keys_chk
  CHECK (
    (manifest - ARRAY[
      'protocol', 'id', 'version', 'created_at', 'listing', 'author', 'capability',
      'checks', 'semantic', 'dek_wrapped', 'evals', 'pricing', 'chain', 'signature'
    ]::text[]) = '{}'::jsonb
  );

ALTER TABLE ar_recipe_bundle DROP CONSTRAINT IF EXISTS ar_recipe_bundle_listing_keys_chk;
ALTER TABLE ar_recipe_bundle ADD CONSTRAINT ar_recipe_bundle_listing_keys_chk
  CHECK (
    (manifest->'listing') - ARRAY[
      'title', 'description', 'updated_at', 'price_honey_drops'
    ]::text[] = '{}'::jsonb
  );

-- A price is a non-negative integer. Negative would move Honey Drops from the
-- seller to the buyer on every purchase, which is a bug that pays out.
ALTER TABLE ar_recipe_bundle DROP CONSTRAINT IF EXISTS ar_recipe_bundle_listing_price_chk;
ALTER TABLE ar_recipe_bundle ADD CONSTRAINT ar_recipe_bundle_listing_price_chk
  CHECK (
    jsonb_typeof(manifest->'listing'->'price_honey_drops') = 'number'
    AND (manifest->'listing'->>'price_honey_drops')::numeric >= 0
    AND (manifest->'listing'->>'price_honey_drops')::numeric =
        trunc((manifest->'listing'->>'price_honey_drops')::numeric)
  );

-- Titles are the shelf label. Empty ones make an unbrowsable market and are cheap
-- to refuse here rather than in every client.
ALTER TABLE ar_recipe_bundle DROP CONSTRAINT IF EXISTS ar_recipe_bundle_listing_title_chk;
ALTER TABLE ar_recipe_bundle ADD CONSTRAINT ar_recipe_bundle_listing_title_chk
  CHECK (length(btrim(coalesce(manifest->'listing'->>'title', ''))) BETWEEN 1 AND 120);
