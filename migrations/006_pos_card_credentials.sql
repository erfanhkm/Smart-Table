-- v0.3: card payment credentials per merchant+POS.
--
-- Some POS keep card processing on separate credentials from the REST/OAuth
-- token: Clover's Ecommerce API uses per-merchant public/private token pairs,
-- Helcim uses a Helcim.js configuration token (public) + API token (private).
-- The public token is safe for the guest browser (it only tokenizes cards);
-- the private token is encrypted and never leaves the server.
ALTER TABLE pos_credentials
  ADD COLUMN IF NOT EXISTS card_public_token TEXT,
  ADD COLUMN IF NOT EXISTS card_private_token_enc TEXT;
