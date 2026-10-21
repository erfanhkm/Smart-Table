-- v0.4 pricing decision (2026-10-21): the Base subscription is $99/month.
-- New billing accounts default to 9900 cents. Accounts already created keep
-- the price on their row (the price is per-account and stays adjustable);
-- Pro ($199) is a future tier and is not represented in this schema yet.

ALTER TABLE billing_accounts ALTER COLUMN subscription_price_cents SET DEFAULT 9900;
