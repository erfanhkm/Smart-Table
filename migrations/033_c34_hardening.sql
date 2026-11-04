-- 033: Claude cycle-3 chunk C3-4 hardening (guest routes + group pay).
--
-- C3-4-5: an order reservation now stores a hash of the cart it was created
-- with. A same-key replay/resume whose cart differs is rejected instead of
-- silently returning (or resuming) the ORIGINAL order while the guest's new
-- items vanish. Legacy rows keep NULL and stay replayable.
ALTER TABLE order_requests ADD COLUMN IF NOT EXISTS cart_hash TEXT;
