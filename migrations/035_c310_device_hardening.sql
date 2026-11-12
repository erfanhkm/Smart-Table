-- 035 (C3-10): device / print-job hardening.
--
-- M-2: print_jobs gains the payment link. Until now a job knew only its
-- check, and a check can carry several payments — so when a job failed or
-- expired there was no way to know WHICH payment's receipt_printed_at
-- claim (migration 024) to release, and the claim leaked forever (the
-- guest could never print that payment's receipt again). New jobs record
-- the payment; every job-failure path releases that payment's claim.
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS payment_id TEXT;
CREATE INDEX IF NOT EXISTS idx_print_jobs_payment ON print_jobs(payment_id);

-- M-5: the device state poll asks for the newest of two event types per
-- table (type IN ('call_waiter','waiter_ack') ORDER BY created_at DESC
-- LIMIT 1). Migration 029's composite serves single-type lookups; this
-- additive partial index covers exactly the two-type poll. 029 is
-- append-only history and is not edited.
CREATE INDEX IF NOT EXISTS idx_events_table_waiter_poll
  ON events(table_id, created_at DESC)
  WHERE type IN ('call_waiter', 'waiter_ack');
