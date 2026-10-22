-- 016: tenant scoping + demo flag (Claude review cycle 1, section 2 batch 1).
--
-- C-4: a POS check reference is only unique WITHIN a location. Two
-- restaurants on the same POS can both have a check "1001"; the old global
-- unique key let link-check re-point another tenant's check. checks now
-- carries location_id (denormalized from its table) and the unique key is
-- (location_id, pos_type, external_check_ref). Rows whose table is unknown
-- keep location_id NULL — Postgres treats NULLs as distinct, so legacy rows
-- never collide.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS location_id TEXT;
UPDATE checks SET location_id = t.location_id
FROM tables t
WHERE t.id = checks.table_id AND checks.location_id IS NULL;
DROP INDEX IF EXISTS uq_checks_pos_ref;
CREATE UNIQUE INDEX IF NOT EXISTS uq_checks_location_ref
  ON checks(location_id, pos_type, external_check_ref);

-- B-11: who recorded an outside-rail (cash) payment — audit for staff
-- record-external-payment.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recorded_by TEXT;

-- C-5/E-5/D-9: explicit demo mode. A location flagged demo=true (founder
-- panel / founder SQL only) may run on the platform's app-level POS
-- credential; every other location MUST have its own pos_credentials row.
-- This replaces the implicit "no credentials row -> use the app token"
-- fallback in the adapters.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS demo BOOLEAN NOT NULL DEFAULT false;
