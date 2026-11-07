-- 034: Claude cycle-3 chunk C3-6 hardening (staff/admin/portal/oauth routes).
--
-- C3-6-5: provisioned owners get a one-time temporary password. It must not
-- silently become the permanent credential: provisioning now flags the
-- account, the portal login surfaces the flag, and
-- POST /api/portal/change-password clears it.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- C3-6-2: checks.state gains ABANDONED — the terminal state a forced table
-- free leaves a still-open check in (migration 020 constrained the column
-- to OPEN/COMPLETED). An abandoned check is neither listed on the guest
-- page nor payable; staff can deliberately resurrect it via link-check.
ALTER TABLE checks DROP CONSTRAINT IF EXISTS chk_checks_state;
ALTER TABLE checks ADD CONSTRAINT chk_checks_state CHECK (state IN ('OPEN', 'COMPLETED', 'ABANDONED'));
