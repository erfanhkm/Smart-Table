-- Idea 2 (Group Pay): item claims. Guests at the same table coordinate who
-- pays what by claiming bill items from their own phones. A claim is stored
-- server-side, shown live on every phone at the table via the bill poll, and
-- an item can be claimed by exactly one device (UNIQUE check_id+item_index),
-- so the same dish is never paid twice. A successful payment releases the
-- payer's claims (see the pay route + src/services/grouppay.ts).
CREATE TABLE IF NOT EXISTS item_claims (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  item_fingerprint TEXT NOT NULL,
  device_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (check_id, item_index)
);
CREATE INDEX IF NOT EXISTS idx_item_claims_check ON item_claims(check_id);
