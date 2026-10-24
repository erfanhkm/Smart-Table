-- v0.8.0: guest-chosen receipt printing on the table's STT-101 device.
-- payments.receipt_printed_at is claimed atomically before the print job
-- is queued (one device print per payment, mirroring receipt_emailed_at).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_printed_at TIMESTAMPTZ;
