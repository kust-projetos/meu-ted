-- V023 — durable approval queue for sensitive Agent side effects.
CREATE TABLE IF NOT EXISTS pending_operations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL,
    requester_id     TEXT NOT NULL,
    operation        TEXT NOT NULL,
    payload          JSONB NOT NULL,
    reason           TEXT NOT NULL CHECK (reason IN ('high_value', 'destructive')),
    idempotency_key  TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ NOT NULL,
    approved_at      TIMESTAMPTZ,
    UNIQUE (workspace_id, idempotency_key)
);

-- Older legacy deployments already have a pending_operations table for chat
-- confirmations. It is empty in the production baseline, but keep the table
-- and add the durable approval columns instead of dropping user data.
ALTER TABLE pending_operations
  ADD COLUMN IF NOT EXISTS workspace_id UUID,
  ADD COLUMN IF NOT EXISTS requester_id TEXT,
  ADD COLUMN IF NOT EXISTS operation TEXT,
  ADD COLUMN IF NOT EXISTS payload JSONB,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS chat_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

DO $$
BEGIN
  -- All probes below are scoped to the canonical public.pending_operations
  -- managed by THIS migration. An unqualified information_schema /
  -- pg_constraint probe matches same-named relations in other schemas
  -- (e.g. legacy_archive.pending_operations kept by archive-and-bootstrap
  -- during the F2 canonical rehearsal), while the unqualified ALTER TABLE
  -- resolves to the fresh public table — a cross-schema mismatch that
  -- aborts the replay with `column "household_id" ... does not exist`
  -- (2026-09-26) and would silently skip the V023 CHECK constraints.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pending_operations' AND column_name = 'household_id') THEN
    ALTER TABLE pending_operations ALTER COLUMN household_id DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pending_operations' AND column_name = 'chat_id') THEN
    ALTER TABLE pending_operations ALTER COLUMN chat_id DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pending_operations' AND column_name = 'amount_cents') THEN
    ALTER TABLE pending_operations ALTER COLUMN amount_cents DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pending_operations' AND column_name = 'date') THEN
    ALTER TABLE pending_operations ALTER COLUMN date DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE pending_operations ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE pending_operations DROP CONSTRAINT IF EXISTS pending_operations_kind_check;
ALTER TABLE pending_operations DROP CONSTRAINT IF EXISTS pending_operations_status_check;

DO $$
BEGIN
  -- conrelid scoping: same-named CHECK constraints on an archived namesake
  -- (legacy_archive.pending_operations) must NOT suppress creation on the
  -- canonical public table (see the column-probe note above).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_operations_status_v023_check' AND conrelid = to_regclass('public.pending_operations')) THEN
    ALTER TABLE pending_operations
      ADD CONSTRAINT pending_operations_status_v023_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'expired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_operations_reason_v023_check' AND conrelid = to_regclass('public.pending_operations')) THEN
    ALTER TABLE pending_operations
      ADD CONSTRAINT pending_operations_reason_v023_check
      CHECK (reason IN ('high_value', 'destructive'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pending_operations_workspace_key_idx
    ON pending_operations (workspace_id, idempotency_key)
    WHERE workspace_id IS NOT NULL AND idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS pending_operations_workspace_status_idx
    ON pending_operations (workspace_id, status, created_at);
