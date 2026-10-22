-- 017: fee-ledger integrity (Claude cycle-1 section-2, E-2/E-9).
--
-- batch_id: processAccruedFees claims a location's accrued rows under a
-- batch id before charging the card on file, so overlapping runs can never
-- sweep the same rows twice and a charge's Square idempotency key is
-- derived from the batch (a retry of the same batch dedupes at Square).
ALTER TABLE fee_ledger ADD COLUMN IF NOT EXISTS batch_id TEXT;

-- One original fee per payment: a payment's commission is recorded exactly
-- once per method ('square_app_fee' taken in-flight, or 'accrued').
-- Reversal rows (method = 'reversal') are intentionally excluded — partial
-- refunds legitimately create several reversal rows for one payment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_ledger_payment_method
  ON fee_ledger(payment_row_id, method)
  WHERE payment_row_id IS NOT NULL AND method IN ('square_app_fee', 'accrued');
