-- Store last chars of API secrets for operator display (not enough to reconstruct the key).

ALTER TABLE ar_api_keys
  ADD COLUMN IF NOT EXISTS key_suffix TEXT;

-- Existing keys: best-effort tip from the stored prefix (creation-time suffix unknown).
UPDATE ar_api_keys
SET key_suffix = right(key_prefix, 6)
WHERE key_suffix IS NULL
  AND key_prefix IS NOT NULL
  AND length(key_prefix) >= 4;
