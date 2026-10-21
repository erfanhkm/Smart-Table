-- v0.4: Smart Table billing — how restaurants pay US.
--
-- Two plans per location (billing_accounts.plan):
--   commission   — 2% of every card payment a guest makes through Smart
--                  Table. On Square the fee is taken in-flight as a Square
--                  application fee (money split by Square at charge time);
--                  on other POS the fee accrues in fee_ledger and is charged
--                  monthly to the card on file (see services/billing.ts).
--   subscription — flat monthly price, charged by a Square Subscription on
--                  OUR platform Square account against the card on file.
--                  No per-payment fees while the subscription is active.
--
-- fee_ledger is the single source of truth for "what a location owes /
-- has paid us" on the commission plan. Subscription charges live in
-- Square (invoices linked from the subscription) and are read live.

CREATE TABLE IF NOT EXISTS billing_accounts (
  location_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'commission',
  pending_plan TEXT,
  commission_bps INTEGER NOT NULL DEFAULT 200,
  subscription_price_cents INTEGER NOT NULL DEFAULT 4900,
  currency CHAR(3) NOT NULL DEFAULT 'CAD',
  square_customer_id TEXT,
  square_card_id TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  square_subscription_id TEXT,
  subscription_status TEXT,
  subscription_paid_through DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fee_ledger (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  payment_row_id TEXT,
  pos_payment_ref TEXT,
  charge_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CAD',
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collected',
  platform_charge_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_location ON fee_ledger(location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_status ON fee_ledger(status);

CREATE TABLE IF NOT EXISTS billing_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
