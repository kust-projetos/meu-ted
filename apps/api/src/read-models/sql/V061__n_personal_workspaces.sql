-- V061 — D1 (ADR-027): N personal workspaces per user.
--
-- Drops ONLY the partial unique index memberships_personal_user_uidx
-- declared by V021:35-37. V021 itself is NEVER edited: every V021 trigger
-- (households kind/owner immutability, personal invite block, personal
-- membership enforcement, personal owner-membership creator) is preserved
-- untouched, so personal stays owner-exclusive — no invites, no transfer,
-- no leave, no conversion. Only the one-personal-per-user cardinality is
-- lifted (the application-level 409 refusal is removed alongside).
--
-- A non-unique partial index on (user_id) WHERE kind = 'personal' keeps
-- owner-personal lookups indexed without imposing cardinality.
--
-- DOWN-MIGRATION UNSAFE AFTER N>1 (rollback = bloquear criações):
-- re-creating the unique index once more than one personal workspace per
-- user exists fails on duplicate rows. The supported rollback is
-- application-level only: re-install the create-time single-personal
-- refusal (409 workspace.invalid) to block new personals. Do NOT
-- re-create memberships_personal_user_uidx after N>1 exists.
DROP INDEX IF EXISTS memberships_personal_user_uidx;
CREATE INDEX IF NOT EXISTS memberships_personal_user_idx
  ON memberships (user_id)
  WHERE kind = 'personal';
