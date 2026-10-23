-- Recipe Seal — Step 4: metering rollup.
-- The run ledger is the source of truth; this view is the read model used by the
-- usage endpoint and by revenue accounting. Keeping it a view means there is no
-- second place where counts can drift.

CREATE OR REPLACE VIEW ar_recipe_metering AS
SELECT
  r.bundle_hash,
  r.license_id,
  date_trunc('day', r.created_at) AS day,
  count(*)                        AS runs,
  count(*) FILTER (WHERE (r.verdict->>'ok')::boolean)  AS passed,
  count(*) FILTER (WHERE NOT (r.verdict->>'ok')::boolean) AS failed,
  sum(r.cost_cents)               AS cost_cents,
  sum(coalesce(r.tokens_in, 0))   AS tokens_in,
  sum(coalesce(r.tokens_out, 0))  AS tokens_out
FROM ar_recipe_run r
GROUP BY r.bundle_hash, r.license_id, date_trunc('day', r.created_at);

-- Scopes are a closed set: a typo cannot silently widen a capability.
ALTER TABLE ar_recipe_license
  DROP CONSTRAINT IF EXISTS ar_recipe_license_scopes_chk;
ALTER TABLE ar_recipe_license
  ADD CONSTRAINT ar_recipe_license_scopes_chk
  CHECK (scopes <@ ARRAY['run', 'verify', 'usage']::text[]);
