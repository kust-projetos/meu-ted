-- V059 — additive authorization audit columns per ADR-026.
-- NULL for legacy rows and manual confirmations predating the policy; populated
-- only by confirm (manual) and authorize (auto) paths landing in a later
-- workstream. Additive nullable fields preserve rollback compatibility.
ALTER TABLE pending_operations
  ADD COLUMN IF NOT EXISTS authorization_mode TEXT,
  ADD COLUMN IF NOT EXISTS authorization_reason TEXT,
  ADD COLUMN IF NOT EXISTS risk_tier TEXT,
  ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_operations_v2_auth_mode_check' AND conrelid = 'pending_operations'::regclass) THEN
    ALTER TABLE pending_operations ADD CONSTRAINT pending_operations_v2_auth_mode_check
      CHECK (authorization_mode IS NULL OR authorization_mode IN ('manual','auto'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_operations_v2_risk_tier_check' AND conrelid = 'pending_operations'::regclass) THEN
    ALTER TABLE pending_operations ADD CONSTRAINT pending_operations_v2_risk_tier_check
      CHECK (risk_tier IS NULL OR risk_tier IN ('low','medium','high','destructive'));
  END IF;
END $$;
