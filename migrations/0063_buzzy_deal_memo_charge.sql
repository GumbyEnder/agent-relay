-- 0063 — what a finished deal memo cost, in the wallet's own unit.
--
-- E reserved `charged_cents` for the "nothing charged" promise and every run
-- writes 0 there. F adds the actual debit, and the wallet is denominated in
-- Honey Drops, not cents: 1 Drop is not 1 cent and this schema has no exchange
-- rate. Inventing one in a column name is how a price becomes a lie.
--
-- So: `charged_cents` keeps meaning cents (always 0 for this lane, which can
-- only move Drops), and `charged_drops` records what the ledger actually moved.
-- The reaper zeroes both, because an interrupted run must never look charged.
--
-- The debit itself is keyed by job id on `ar_wallet_entry.idempotency_key`, so a
-- retried finish cannot move money twice; this column is the cached answer the
-- chat card and the poll read.

ALTER TABLE buzzy_deal_memo_jobs
  ADD COLUMN IF NOT EXISTS charged_drops INTEGER NOT NULL DEFAULT 0;

ALTER TABLE buzzy_deal_memo_jobs
  DROP CONSTRAINT IF EXISTS buzzy_deal_memo_jobs_charged_drops_check;
ALTER TABLE buzzy_deal_memo_jobs
  ADD CONSTRAINT buzzy_deal_memo_jobs_charged_drops_check
  CHECK (charged_drops >= 0);
