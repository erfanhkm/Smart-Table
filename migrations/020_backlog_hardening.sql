-- 020: Claude cycle-1 backlog hardening (G-1 indexes, E-9/G-2 schema
-- constraints, G-3 least-privilege role default).
--
-- G-1: the bill poll / pay paths look checks up by square_order_id and
-- payments by their POS refs + status; 005 dropped the square_order_id
-- index and payments never had POS-ref/status indexes.
CREATE INDEX IF NOT EXISTS idx_checks_square_order ON checks(square_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_square ON payments(square_payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_external_ref ON payments(external_payment_ref);
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
-- E-9: one POS payment ref per check (a replayed webhook/charge must not
-- create a second payment row for the same POS payment on one check).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_check_ref ON payments(check_id, external_payment_ref) WHERE external_payment_ref IS NOT NULL;
-- NOTE: uq_refunds_one_pending (Claude's F-2 suggestion) was VETTED AND
-- REJECTED for this batch: distinct partial refunds against one payment
-- are a legitimate flow, and an unknown-outcome PENDING row can persist
-- for hours — the index would block every other refund on that payment
-- meanwhile (it broke the v0.6.6 F-2 test, which encodes that flow).
-- The per-payment advisory lock + same-key replay guard remains the
-- protection. See cycle-01-fixes-v0610.md.
-- Idea-1 dedupe, structural: at most one OPEN alert per (table, kind).
-- raiseServiceAlert inserts with ON CONFLICT DO NOTHING to match.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_open ON service_alerts(table_id, kind) WHERE status = 'open' AND table_id IS NOT NULL;
-- G-3: new portal users default to least privilege. Every real creation
-- path (scripts/seed-portal-user.ts, scripts/seed-demo.ts) sets the role
-- explicitly ('owner'), so the default only catches future inserts that
-- forget — exactly the ones that must NOT silently become owners.
ALTER TABLE portal_users ALTER COLUMN role SET DEFAULT 'staff';
ALTER TABLE portal_users ADD CONSTRAINT chk_portal_users_role CHECK (role IN ('owner', 'manager', 'staff'));
-- G-2: status/amount domains on the money tables. The value sets are the
-- exact enums the services write (webhooks map Square APPROVED ->
-- AUTHORIZED before storing, so no legacy value needs grandfathering).
ALTER TABLE payments ADD CONSTRAINT chk_payments_status CHECK (status IN ('PENDING', 'AUTHORIZED', 'COMPLETED', 'FAILED'));
ALTER TABLE payments ADD CONSTRAINT chk_payments_amounts CHECK (amount_cents >= 0 AND tip_cents >= 0);
ALTER TABLE refunds ADD CONSTRAINT chk_refunds_status CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED'));
ALTER TABLE refunds ADD CONSTRAINT chk_refunds_amount CHECK (amount_cents > 0);
ALTER TABLE checks ADD CONSTRAINT chk_checks_state CHECK (state IN ('OPEN', 'COMPLETED'));
ALTER TABLE checks ADD CONSTRAINT chk_checks_total CHECK (total_cents >= 0);
