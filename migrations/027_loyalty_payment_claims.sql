-- v0.8.5 (F4-2): a settled payment may count for exactly ONE loyalty
-- phone number. The claim is inserted atomically when a visit counts;
-- a conflict means the payment was already counted by someone else.
CREATE TABLE IF NOT EXISTS loyalty_payment_claims (
  payment_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  phone_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
