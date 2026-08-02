-- Optional sealed secret for operator reveal in the UI (AES-GCM).
-- Verification still uses key_hash only. Legacy keys have NULL ciphertext.

ALTER TABLE ar_api_keys
  ADD COLUMN IF NOT EXISTS key_ciphertext TEXT;
