-- v0.3 multi-POS: generic encrypted credential model + generalized external IDs.
-- One credential row per (merchant, pos_type): a location's whole backend
-- resolves its adapter AND its token from the location's pos_type, so a
-- Square location can never touch Clover credentials or vice versa.
-- Statements are executed one at a time by src/migrate.ts (split on `;` + newline),
-- so keep exactly one statement per `;` and no `;` inside comments.

CREATE TABLE IF NOT EXISTS pos_credentials (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  pos_type TEXT NOT NULL,
  external_merchant_ref TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, pos_type)
);
CREATE INDEX IF NOT EXISTS idx_pos_credentials_merchant ON pos_credentials(merchant_id);

-- merchants: a row is one owner's account on one POS.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pos_type TEXT NOT NULL DEFAULT 'square';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS external_merchant_ref TEXT;
UPDATE merchants SET external_merchant_ref = square_merchant_id WHERE external_merchant_ref IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchants_pos_ref ON merchants(pos_type, external_merchant_ref);
-- square_merchant_id is legacy (only meaningful for square rows); allow NULL
-- for other POS so we don't need synthetic placeholder values.
ALTER TABLE merchants ALTER COLUMN square_merchant_id DROP NOT NULL;
-- The new canonical uniqueness is (pos_type, external_merchant_ref); drop the
-- legacy single-column unique so NULLs are allowed (portable across pg-mem).
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_square_merchant_id_key;

-- checks: POS-native check reference + denormalized pos_type (from the location
-- at link time) so the same external id on two POS can never collide and the
-- single-POS-per-location invariant is checkable on the row itself.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS pos_type TEXT NOT NULL DEFAULT 'square';
ALTER TABLE checks ADD COLUMN IF NOT EXISTS external_check_ref TEXT;
UPDATE checks SET external_check_ref = square_order_id WHERE external_check_ref IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_checks_pos_ref ON checks(pos_type, external_check_ref);
-- square_order_id is legacy (only meaningful for square rows); allow NULL for
-- other POS. The canonical uniqueness is now (pos_type, external_check_ref).
ALTER TABLE checks ALTER COLUMN square_order_id DROP NOT NULL;
ALTER TABLE checks DROP CONSTRAINT IF EXISTS checks_square_order_id_key;

-- payments: POS-native payment reference.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS external_payment_ref TEXT;
UPDATE payments SET external_payment_ref = square_payment_id WHERE external_payment_ref IS NULL AND square_payment_id IS NOT NULL;

-- webhook dedupe: which POS the event came from.
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS pos_type TEXT NOT NULL DEFAULT 'square';
