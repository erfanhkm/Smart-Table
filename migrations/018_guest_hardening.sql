-- v0.6.7 (Claude review batch 3): guest-endpoint hardening.
-- C-6: a receipt email binds to ONE payment and can be sent once —
-- payments.receipt_emailed_at is claimed atomically before sending.
-- C-7: a loyalty visit counts once per PAID check — loyalty_visits
-- remembers which check it last counted.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_emailed_at TIMESTAMPTZ;
ALTER TABLE loyalty_visits ADD COLUMN IF NOT EXISTS last_counted_check_id TEXT;
