-- v0.8.14 (F11): device-API hardening support.
-- 1) Composite events index: the device state poll and the waiter-call
--    dedupe read the latest event of a type per table; the 001 index is
--    table-only, so those reads sort the table's whole event history.
CREATE INDEX IF NOT EXISTS idx_events_table_type_created ON events(table_id, type, created_at DESC);
-- 2) Optional caller-supplied idempotency key for staff print jobs, so a
--    retried portal print request replays the original job instead of
--    queueing a duplicate receipt.
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_jobs_device_idem ON print_jobs(device_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
