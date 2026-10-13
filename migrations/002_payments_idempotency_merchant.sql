-- Smart Table 002: stored idempotent payment results + merchant on each check.
-- Statements are executed one at a time by src/migrate.ts (split on `;` + newline),
-- so keep exactly one statement per `;` and no `;` inside comments.
-- merchant_id is nullable: rows created before this migration stay NULL (backfill is not needed
-- for the sandbox MVP; every check linked from now on carries the merchant of its location).

ALTER TABLE checks ADD COLUMN merchant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_checks_merchant ON checks(merchant_id);

ALTER TABLE payments ADD COLUMN remaining_after_cents INTEGER;
ALTER TABLE payments ADD COLUMN check_state TEXT;
ALTER TABLE payments ADD COLUMN currency CHAR(3);
