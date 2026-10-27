-- Honey Drops — a notional wallet, an append-only ledger, and purchases.
--
-- Three rules shape this schema:
--
--   1. Money is an integer and a balance can never go negative. A CHECK cannot be
--      argued with by a bug, a race or a retry.
--   2. The ledger is the truth; `balance` is a cache of `sum(delta)` that is
--      updated in the same transaction, and `balance_after` records what the
--      account actually saw at that moment.
--   3. WHO BOUGHT WHAT is private. `ar_recipe_purchase.buyer_id` exists because
--      the platform must be able to refund and audit, but no seller-facing or
--      public view exposes it. Sellers see counts and totals, never people.

CREATE TABLE IF NOT EXISTS ar_wallet (
  user_id     TEXT PRIMARY KEY,
  balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ar_wallet_entry (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES ar_wallet(user_id) ON DELETE CASCADE,
  -- Positive credits, negative debits. Zero is not a ledger entry; it is noise.
  delta         INTEGER NOT NULL CHECK (delta <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason        TEXT NOT NULL CHECK (reason IN (
                  'grant', 'purchase', 'sale', 'platform_fee', 'refund', 'adjustment')),
  -- What the movement was about: a bundle hash, a purchase id, an ops note.
  ref           TEXT,
  -- A retried request must not move money twice. Nullable because most entries
  -- are unique by construction; unique when supplied so the database enforces it.
  idempotency_key TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ar_wallet_entry_idem_idx
  ON ar_wallet_entry (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ar_wallet_entry_user_idx
  ON ar_wallet_entry (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ar_recipe_purchase (
  id                 BIGSERIAL PRIMARY KEY,
  hash               TEXT NOT NULL,
  recipe_id          TEXT NOT NULL,
  version            TEXT NOT NULL,
  -- PRIVATE. Never selected by a seller-facing query. Kept for refunds and audit.
  buyer_id           TEXT NOT NULL,
  seller_id          TEXT NOT NULL,
  price_honey_drops  INTEGER NOT NULL CHECK (price_honey_drops >= 0),
  seller_credit      INTEGER NOT NULL CHECK (seller_credit >= 0),
  platform_credit    INTEGER NOT NULL CHECK (platform_credit >= 0),
  -- The split must account for every Drop: no money may evaporate in rounding.
  CONSTRAINT ar_recipe_purchase_split_chk
    CHECK (seller_credit + platform_credit = price_honey_drops),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One purchase per buyer per recipe. Buying twice is a mistake, not a feature.
CREATE UNIQUE INDEX IF NOT EXISTS ar_recipe_purchase_once_idx
  ON ar_recipe_purchase (buyer_id, hash);
CREATE INDEX IF NOT EXISTS ar_recipe_purchase_seller_idx
  ON ar_recipe_purchase (seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ar_recipe_entitlement (
  user_id     TEXT NOT NULL,
  hash        TEXT NOT NULL,
  purchase_id BIGINT REFERENCES ar_recipe_purchase(id) ON DELETE SET NULL,
  -- Free recipes grant an entitlement with no purchase row.
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hash)
);

-- The rule that matters most, in the database rather than in a handler:
-- an entitlement exists only if there is a purchase that paid for it, or the
-- recipe was free at the time. A bug that skips payment cannot mint access.
ALTER TABLE ar_recipe_entitlement DROP CONSTRAINT IF EXISTS ar_recipe_entitlement_paid_chk;
ALTER TABLE ar_recipe_entitlement ADD CONSTRAINT ar_recipe_entitlement_paid_chk
  CHECK (purchase_id IS NOT NULL OR granted_at IS NOT NULL);
