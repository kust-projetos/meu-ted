-- anonymize-pg-copy.sql — F2 rehearsal PII scrub for a restored prod copy.
--
-- Runs INSIDE the disposable anonymize container (psql -U postgres -d pi_financeiro),
-- AFTER the production dump has been restored and BEFORE the anonymized dump
-- is taken. NEVER run against production.
--
-- INVARIANTS (the F2 gate compares counts and balances against production):
--   - primary keys, foreign keys and row counts are NEVER changed;
--   - amounts (cents), dates, kind/status enums and boolean flags are NEVER changed;
--   - updated_at-preserving: USER triggers (set_updated_at()) are disabled while
--     the scrub runs and re-enabled afterwards, so UPDATEs do not rewrite dates.
--   - placeholders are DETERMINISTIC per row (row_number() over a stable key),
--     so re-runs on the same restore — or on two restores of the same dump —
--     produce identical output. EXCEPTION: the idempotency-key mapping
--     (Step 3a2) uses a fresh per-scrub random salt and therefore differs on
--     every scrub BY DESIGN (unpredictable per export; equality holds only
--     within a single export).
--
-- DECISIONS (explicit, per task spec):
--   - JSON payload columns are FULLY CLEARED to '{}'::jsonb (highest-risk free-form
--     PII carriers; none of their content feeds counts or balances):
--       idempotency_keys.response, operation_records.response,
--       audit_logs.before_json, audit_logs.after_json, pending_operations.payload.
--     (audit_logs has NO metadata column in production — verified 2026-09-26
--     against the live information_schema probe; before_json/after_json are jsonb.)
--     (idempotency_keys.response / operation_records.response ARE copied through
--     by the converter, but '{}' is valid jsonb and content-neutral to the gate.)
--   - actor_id / effect_ref / payload_hash columns are KEPT:
--     they are join/identity keys (UUIDs, hashes), not PII.
--   - idempotency keys ARE scrubbed (client-controlled free-form PII carriers):
--     idempotency_keys.key, operation_records.idempotency_key and the related
--     pending_operations.idempotency_key share ONE per-scrub randomized mapping
--       'anon-idem-' || encode(hmac(value, salt, 'sha256'), 'hex')
--     where salt is a single 256-bit value (gen_random_bytes(32)) generated
--     fresh for this scrub and held ONLY in the transaction-local TEMP table
--     _anon_idem_salt (ON COMMIT DROP): never written to a permanent table,
--     never logged, and never reaching the pg_dump export (TEMP relations are
--     session-local and excluded from dumps). The same salt feeds all three
--     tables, so equality is preserved within AND across tables for this
--     export (the canonical reconciliation unions both scopes on scope+key),
--     uniqueness is preserved (HMAC injectivity up to collision; output is
--     'anon-idem-' + 64 hex = 74 chars, well within the TEXT columns — V002
--     idempotency_keys.key, V013 operation_records.idempotency_key, V023
--     pending_operations.idempotency_key — no length constraint), and the
--     converter PK/UNIQUE constraints
--     ((household_id,key), (workspace_id,idempotency_key)) keep holding.
--     The mapping is intentionally NOT stable across restores (fresh salt per
--     scrub), so a low-entropy raw key cannot be reversed by
--     dictionary-guessing an unkeyed SHA256. Every row is re-mapped on every
--     run (no NOT LIKE 'anon-idem-%' skip): a malicious raw key already
--     starting with 'anon-idem-' is still hashed, so the prefix cannot be
--     abused to smuggle raw PII through.
--   - audit_logs is NEVER imported by the converter, but is still scrubbed here
--     (before_json/after_json cleared) so the anonymized dump carries no PII anywhere.
--   - device_tokens.token_hash is recomputed as md5(old||':anon-f2-a') ||
--     md5(old||':anon-f2-b') (64 hex chars, satisfies CHAR(64); the converter
--     derives the canonical token as 'converted:' || token_hash, so a non-empty
--     fake hash keeps the import working while the real secret never leaves VPS).
--   - invites.token_hash / account_invites.token_hash are replaced with unique
--     per-row fake values (uniqueness preserved, secrets destroyed).
--   - Better-Auth user/session/account/verification keep SHAPE and row counts;
--     only identifying values (emails, names, tokens, IPs, user agents, secrets)
--     are replaced. Inter-table references (user.id, session.user_id,
--     account.user_id) are untouched.
--   - Better-Auth account."accountId" IS scrubbed (reviewer P2: external
--     provider identity = PII — OAuth sub / email). Constraint map
--     (V017__better_auth.sql + V019__better_auth_casing.sql):
--       id TEXT PRIMARY KEY — untouched (PK stability, no external meaning);
--       user_id FK → "user"(id) — untouched (join key);
--       "providerId" TEXT NOT NULL — KEPT raw (fixed provider keys such as
--       'credential', not PII; needed to interpret the credential-vs-oauth
--       grain — scrubbing it would destroy grouping, keeping it leaks nothing);
--       "accountId" TEXT NOT NULL — remapped to
--         'anon-acct-' || hex(hmac("accountId" || '|' || "providerId",
--         per-scrub-salt, 'sha256')) reusing the SAME _anon_idem_salt as
--       Step 3a2: equality-preserving (same raw pair → same pseudonym),
--       uniqueness-preserving (HMAC injectivity up to collision; 'anon-acct-'
--       + 64 hex = 75 chars, TEXT column, no length constraint), and
--       non-reversible per export (fresh 256-bit salt, TEMP ON COMMIT DROP).
--     Every row is re-mapped (no NOT LIKE skip), so a raw value already
--     starting with 'anon-acct-' cannot smuggle PII through. The Step 4b
--     residual gate fails closed on any non-'anon-acct-%' value (Step 6
--     mirrors it post-COMMIT as evidence).
--   - A generic safety net at the end masks residual PII-pattern text columns
--     and clears residual json/jsonb columns on auxiliary tables whose exact
--     legacy shape was not inventoried (installment_plans, notification_log,
--     notification_settings, account_payable_templates, ...). Anything it skips
--     is reported via NOTICE for operator review.
--
-- Verified column sources: production information_schema probe 2026-09-26
-- (516 rows / 43 tables — OVERRIDES apps/api/src/read-models/sql V001..V058 and
-- apps/api/src/scripts/canonical-converter/import.ts (+ mapping.ts) on conflict).

BEGIN;

-- ============================================================
-- Step 0: disable USER triggers (set_updated_at) so UPDATEs do not rewrite dates.
-- Constraint triggers stay active. Re-enabled in Step 4.
-- ============================================================
DO $$
DECLARE
  t TEXT;
  v_tables TEXT[] := ARRAY[
    'users', 'households', 'memberships', 'invites', 'accounts',
    'categories', 'statements', 'transactions', 'card_purchases',
    'accounts_payable', 'budgets', 'goals', 'goal_contributions',
    'payable_templates', 'notification_configs', 'subscriptions',
    'idempotency_keys', 'device_tokens', 'operation_records', 'audit_logs',
    'user', 'session', 'account', 'verification', 'profiles',
    'account_invites', 'push_subscriptions',
    'push_reminder_deliveries', 'push_delivery_attempts', 'pending_operations',
    'recurring_purchases', 'agent_llm_providers', 'agent_llm_runtime_config'
  ];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- Step 1: application identity (users / households / memberships / invites).
-- memberships carries no PII (user_id, household_id, role, status, kind).
-- ============================================================
UPDATE public.users AS u
SET email = s.email,
    name = s.name,
    phone = CASE WHEN u.phone IS NULL THEN NULL ELSE s.phone END
FROM (
  SELECT id,
         'anon' || row_number() OVER (ORDER BY id) || '@invalid.example' AS email,
         'Anon Nome ' || row_number() OVER (ORDER BY id) AS name,
         '+550000000' || lpad(row_number() OVER (ORDER BY id)::text, 4, '0') AS phone
  FROM public.users
) AS s
WHERE u.id = s.id;

UPDATE public.households AS h
SET name = s.name
FROM (
  SELECT id, 'Anon Household ' || row_number() OVER (ORDER BY id) AS name
  FROM public.households
) AS s
WHERE h.id = s.id;

UPDATE public.invites AS i
SET email = s.email,
    email_normalized = s.email_normalized,
    token_hash = s.token_hash
FROM (
  SELECT id,
         'anon-invite' || row_number() OVER (ORDER BY id) || '@invalid.example' AS email,
         'anon-invite' || row_number() OVER (ORDER BY id) || '@invalid.example' AS email_normalized,
         'anon-invite-tokenhash-' || row_number() OVER (ORDER BY id) AS token_hash
  FROM public.invites
) AS s
WHERE i.id = s.id;

-- ============================================================
-- Step 2: financial domain names and free text (amounts/dates/enums untouched).
-- ============================================================
UPDATE public.accounts AS a
SET name = s.name,
    name_normalized = s.name_normalized
FROM (
  SELECT id,
         'Anon Conta ' || row_number() OVER (ORDER BY id) AS name,
         lower('anon conta ' || row_number() OVER (ORDER BY id)) AS name_normalized
  FROM public.accounts
) AS s
WHERE a.id = s.id;

UPDATE public.categories AS c
SET name = s.name
FROM (
  SELECT id, 'Anon Categoria ' || row_number() OVER (ORDER BY id) AS name
  FROM public.categories
) AS s
WHERE c.id = s.id;

UPDATE public.transactions AS t
SET description = 'anon',
    notes = CASE WHEN t.notes IS NULL THEN NULL ELSE 'anon' END,
    recipient_name = CASE WHEN t.recipient_name IS NULL THEN NULL ELSE s.recipient_name END,
    recipient_document = CASE WHEN t.recipient_document IS NULL THEN NULL ELSE s.recipient_document END,
    source_message_id = CASE WHEN t.source_message_id IS NULL THEN NULL ELSE 'anon' END
FROM (
  SELECT id,
         'Anon Nome ' || row_number() OVER (ORDER BY id) AS recipient_name,
         '00000000' || lpad(row_number() OVER (ORDER BY id)::text, 3, '0') AS recipient_document
  FROM public.transactions
) AS s
WHERE t.id = s.id;

UPDATE public.card_purchases AS c
SET description = 'anon',
    notes = CASE WHEN c.notes IS NULL THEN NULL ELSE 'anon' END;

UPDATE public.accounts_payable AS p
SET description = 'anon',
    notes = CASE WHEN p.notes IS NULL THEN NULL ELSE 'anon' END;

UPDATE public.payable_templates AS p
SET name = s.name,
    description = 'anon',
    notes = CASE WHEN p.notes IS NULL THEN NULL ELSE 'anon' END
FROM (
  SELECT id, 'Anon Template ' || row_number() OVER (ORDER BY id) AS name
  FROM public.payable_templates
) AS s
WHERE p.id = s.id;

UPDATE public.budgets AS b
SET name = s.name
FROM (
  SELECT id, 'Anon Orcamento ' || row_number() OVER (ORDER BY id) AS name
  FROM public.budgets
) AS s
WHERE b.id = s.id;

UPDATE public.goals AS g
SET name = s.name,
    description = CASE WHEN g.description IS NULL THEN NULL ELSE 'anon' END,
    notes = CASE WHEN g.notes IS NULL THEN NULL ELSE 'anon' END
FROM (
  SELECT id, 'Anon Meta ' || row_number() OVER (ORDER BY id) AS name
  FROM public.goals
) AS s
WHERE g.id = s.id;

UPDATE public.goal_contributions AS g
SET source = CASE WHEN g.source IS NULL THEN NULL ELSE 'anon' END,
    notes = CASE WHEN g.notes IS NULL THEN NULL ELSE 'anon' END;

UPDATE public.subscriptions AS s
SET name = n.name
FROM (
  SELECT id, 'Anon Assinatura ' || row_number() OVER (ORDER BY id) AS name
  FROM public.subscriptions
) AS n
WHERE s.id = n.id;

UPDATE public.notification_configs AS n
SET chat_id = s.chat_id,
    last_error = CASE WHEN n.last_error IS NULL THEN NULL ELSE 'anon' END
FROM (
  SELECT id, 'anon-chat-' || row_number() OVER (ORDER BY id) AS chat_id
  FROM public.notification_configs
) AS s
WHERE n.id = s.id;

UPDATE public.recurring_purchases AS r
SET description = 'anon';

-- ============================================================
-- Step 3a: high-risk JSON payloads fully cleared (see header for rationale).
-- ============================================================
UPDATE public.idempotency_keys SET response = '{}'::jsonb;
UPDATE public.operation_records SET response = '{}'::jsonb;
UPDATE public.audit_logs SET before_json = '{}'::jsonb, after_json = '{}'::jsonb;

-- ============================================================
-- Step 3a2: client-controlled idempotency keys (free-form PII carriers).
-- Per-scrub RANDOMIZED keyed mapping (HMAC-SHA256, single 256-bit salt).
-- The salt lives ONLY in the transaction-local TEMP table _anon_idem_salt
-- (ON COMMIT DROP): never persisted, never logged, never dumped.
-- Same salt for all three tables preserves equality/uniqueness for this
-- export. Every row is re-mapped on every run (no NOT LIKE guard), so an
-- attacker-controlled raw key starting with 'anon-idem-' cannot bypass
-- the scrub.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TEMP TABLE IF NOT EXISTS _anon_idem_salt(salt TEXT) ON COMMIT DROP;
DELETE FROM _anon_idem_salt;
INSERT INTO _anon_idem_salt(salt) SELECT encode(gen_random_bytes(32), 'hex');

UPDATE public.idempotency_keys
SET "key" = 'anon-idem-' || encode(hmac("key", (SELECT salt FROM _anon_idem_salt), 'sha256'), 'hex');

UPDATE public.operation_records
SET idempotency_key = 'anon-idem-' || encode(hmac(idempotency_key, (SELECT salt FROM _anon_idem_salt), 'sha256'), 'hex');

DO $$
BEGIN
  IF to_regclass('public.pending_operations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'pending_operations'
                    AND column_name = 'idempotency_key') THEN
    UPDATE public.pending_operations
    SET idempotency_key = 'anon-idem-' || encode(hmac(idempotency_key, (SELECT salt FROM _anon_idem_salt), 'sha256'), 'hex')
    WHERE idempotency_key IS NOT NULL;
  ELSE
    RAISE NOTICE 'anonymize: public.pending_operations.idempotency_key absent, skipped';
  END IF;
END $$;
-- ============================================================
-- Step 3b: device tokens (PK rotated, hash recomputed as fake 64-hex).
-- device_id / name replaced; household_id / user_id / dates / flags kept.
-- ============================================================
UPDATE public.device_tokens AS t
SET token = s.anon_token,
    token_hash = s.anon_hash,
    device_id = s.anon_device,
    name = CASE WHEN t.name IS NULL THEN NULL ELSE s.anon_name END
FROM (
  SELECT token AS old_token,
         'anon-device-token-' || row_number() OVER (ORDER BY token) AS anon_token,
         md5(token || ':anon-f2-a') || md5(token || ':anon-f2-b') AS anon_hash,
         'anon-device-' || row_number() OVER (ORDER BY token) AS anon_device,
         'Anon Device ' || row_number() OVER (ORDER BY token) AS anon_name
  FROM public.device_tokens
) AS s
WHERE t.token = s.old_token;

-- ============================================================
-- Step 3c: Better-Auth identity (shape + row counts + references kept).
-- ============================================================
UPDATE public."user" AS u
SET name = s.name,
    email = s.email,
    image = NULL,
    "banReason" = CASE WHEN u."banReason" IS NULL THEN NULL ELSE 'anon' END
FROM (
  SELECT id,
         'Anon Nome ' || row_number() OVER (ORDER BY id) AS name,
         'anon-user' || row_number() OVER (ORDER BY id) || '@invalid.example' AS email
  FROM public."user"
) AS s
WHERE u.id = s.id;

UPDATE public."session" AS s
SET token = n.token,
    "ipAddress" = CASE WHEN s."ipAddress" IS NULL THEN NULL ELSE '0.0.0.0' END,
    "userAgent" = CASE WHEN s."userAgent" IS NULL THEN NULL ELSE 'anon' END
FROM (
  SELECT id, 'anon-session-token-' || row_number() OVER (ORDER BY id) AS token
  FROM public."session"
) AS n
WHERE s.id = n.id;

UPDATE public.account AS a
SET "accountId" = s.pseudo,
    "accessToken" = CASE WHEN a."accessToken" IS NULL THEN NULL ELSE 'anon' END,
    "refreshToken" = CASE WHEN a."refreshToken" IS NULL THEN NULL ELSE 'anon' END,
    "idToken" = CASE WHEN a."idToken" IS NULL THEN NULL ELSE 'anon' END,
    password = CASE WHEN a.password IS NULL THEN NULL ELSE 'anon' END,
    scope = CASE WHEN a.scope IS NULL THEN NULL ELSE 'anon' END
FROM (
  SELECT id,
         'anon-acct-' || encode(hmac("accountId" || '|' || "providerId", (SELECT salt FROM _anon_idem_salt), 'sha256'), 'hex') AS pseudo
  FROM public.account
) AS s
WHERE a.id = s.id;

UPDATE public.verification AS v
SET identifier = s.identifier,
    value = 'anon'
FROM (
  SELECT id, 'anon-verify-' || row_number() OVER (ORDER BY id) || '@invalid.example' AS identifier
  FROM public.verification
) AS s
WHERE v.id = s.id;

-- ============================================================
-- Step 3d: profiles, phone bindings, signup invites, push, ops, LLM config.
-- ============================================================
UPDATE public.profiles AS p
SET name = s.name,
    email = s.email,
    phone = s.phone
FROM (
  SELECT household_id,
         'Anon Nome ' || row_number() OVER (ORDER BY household_id) AS name,
         'anon-profile' || row_number() OVER (ORDER BY household_id) || '@invalid.example' AS email,
         '+550000000' || lpad(row_number() OVER (ORDER BY household_id)::text, 4, '0') AS phone
  FROM public.profiles
) AS s
WHERE p.household_id = s.household_id;

-- NOTE 2026-09-26: phone-bindings scrub block REMOVED — table absent in the
-- production information_schema probe (no public.user_phone_bindings).

UPDATE public.account_invites AS a
SET email = s.email,
    email_normalized = s.email_normalized,
    token_hash = s.token_hash
FROM (
  SELECT id,
         'anon-acct-invite' || row_number() OVER (ORDER BY id) || '@invalid.example' AS email,
         'anon-acct-invite' || row_number() OVER (ORDER BY id) || '@invalid.example' AS email_normalized,
         'anon-acct-invite-tokenhash-' || row_number() OVER (ORDER BY id) AS token_hash
  FROM public.account_invites
) AS s
WHERE a.id = s.id;

UPDATE public.push_subscriptions AS p
SET endpoint = s.endpoint,
    p256dh = s.anon_p256dh,
    auth = s.anon_auth,
    user_agent = CASE WHEN p.user_agent IS NULL THEN NULL ELSE 'anon' END
FROM (
  SELECT id,
         'https://invalid.example/push/anon-' || row_number() OVER (ORDER BY id) AS endpoint,
         'anon-p256dh-' || row_number() OVER (ORDER BY id) AS anon_p256dh,
         'anon-auth-' || row_number() OVER (ORDER BY id) AS anon_auth
  FROM public.push_subscriptions
) AS s
WHERE p.id = s.id;

DO $$
BEGIN
  IF to_regclass('public.push_reminder_deliveries') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'push_reminder_deliveries'
                    AND column_name = 'error_message') THEN
    UPDATE public.push_reminder_deliveries
    SET error_message = CASE WHEN error_message IS NULL THEN NULL ELSE 'anon' END;
  ELSE
    RAISE NOTICE 'anonymize: public.push_reminder_deliveries.error_message absent, skipped';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.pending_operations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'pending_operations'
                  AND column_name = 'payload') THEN
      UPDATE public.pending_operations SET payload = '{}'::jsonb;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'pending_operations'
                  AND column_name = 'chat_id') THEN
      UPDATE public.pending_operations AS p
      SET chat_id = s.chat_id
      FROM (
        SELECT id, 'anon-chat-' || row_number() OVER (ORDER BY id) AS chat_id
        FROM public.pending_operations
      ) AS s
      WHERE p.id = s.id;
    END IF;
  ELSE
    RAISE NOTICE 'anonymize: public.pending_operations absent, skipped';
  END IF;
END $$;

-- ============================================================
-- Step 3f: explicit residual free-text/JSON scrub for auxiliary tables
-- whose columns the safety-net LIKE patterns do not reach. Column names
-- verified against the 2026-09-26 production column probe (PG 15.18,
-- schema public).
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.notification_log') IS NOT NULL THEN
    UPDATE public.notification_log SET title = CASE WHEN title IS NULL THEN NULL ELSE 'anon' END;
    UPDATE public.notification_log SET message = CASE WHEN message IS NULL THEN NULL ELSE 'anon' END;
    UPDATE public.notification_log SET payload = '{}'::jsonb;
  ELSE
    RAISE NOTICE 'anonymize: public.notification_log absent, skipped';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.pending_operations') IS NOT NULL THEN
    UPDATE public.pending_operations SET reason = CASE WHEN reason IS NULL THEN NULL ELSE 'anon' END;
    UPDATE public.pending_operations SET description = CASE WHEN description IS NULL THEN NULL ELSE 'anon' END;
    UPDATE public.pending_operations SET normalized_args = '{}'::jsonb;
    UPDATE public.pending_operations SET execution_result = '{}'::jsonb;
  ELSE
    RAISE NOTICE 'anonymize: public.pending_operations absent, skipped';
  END IF;
END $$;

UPDATE public.agent_llm_providers SET updated_by = CASE WHEN updated_by IS NULL THEN NULL ELSE 'anon' END;
UPDATE public.agent_llm_runtime_config SET updated_by = CASE WHEN updated_by IS NULL THEN NULL ELSE 'anon' END;

-- ============================================================
-- Step 3e: safety net — residual PII-pattern text columns + any json/jsonb
-- columns on auxiliary tables with un-inventoried legacy shapes
-- (installment_plans, notification_log, notification_settings,
-- account_payable_templates, agent_connection_token_replay,
-- push_delivery_attempts, ...). Explicitly handled columns and structural
-- columns (PKs/FKs, *_cents, hashes, idempotency keys, migration ledger)
-- are excluded. Per-column UPDATE failures are collected and raised as a
-- single fail-closed EXCEPTION at the end of the block (the VPS pipeline
-- must abort BEFORE the pg_dump export — a NOTICE-only skip would leak
-- unscrubbed PII into the anonymized dump). Column-absent skips stay
-- NOTICE-only: absence of a column is fine.
-- ============================================================
DO $$
DECLARE
  r RECORD;
  v_sql TEXT;
  v_prefix TEXT;
  v_suffix TEXT;
  v_failed TEXT[] := ARRAY[]::TEXT[];
  v_excluded TEXT[] := ARRAY[
    'users.email', 'users.name', 'users.phone',
    'households.name',
    'invites.email', 'invites.email_normalized', 'invites.token_hash',
    'accounts.name', 'accounts.name_normalized',
    'categories.name',
    'transactions.description', 'transactions.notes', 'transactions.recipient_name',
    'transactions.recipient_document', 'transactions.source_message_id',
    'card_purchases.description', 'card_purchases.notes',
    'accounts_payable.description', 'accounts_payable.notes',
    'payable_templates.name', 'payable_templates.description', 'payable_templates.notes',
    'budgets.name',
    'goals.name', 'goals.description', 'goals.notes',
    'goal_contributions.source', 'goal_contributions.notes',
    'subscriptions.name',
    'notification_configs.chat_id', 'notification_configs.last_error',
    'idempotency_keys.response',
    'operation_records.response',
    'audit_logs.before_json', 'audit_logs.after_json',
    'pending_operations.payload', 'pending_operations.chat_id',
    'device_tokens.token', 'device_tokens.device_id', 'device_tokens.name', 'device_tokens.token_hash',
    'user.name', 'user.email', 'user.image', 'user.banReason',
    'session.token', 'session.ipAddress', 'session.userAgent',
    'account.accessToken', 'account.refreshToken', 'account.idToken',
    'account.scope', 'account.password',
    'account.accountId', 'account.providerId',
    'verification.identifier', 'verification.value',
    'profiles.name', 'profiles.email', 'profiles.phone',
    'account_invites.email', 'account_invites.email_normalized', 'account_invites.token_hash',
    'push_subscriptions.endpoint', 'push_subscriptions.p256dh',
    'push_subscriptions.auth', 'push_subscriptions.user_agent',
    'push_reminder_deliveries.error_message',
    'recurring_purchases.description',
    'agent_llm_providers.updated_by', 'agent_llm_runtime_config.updated_by',
    'agent_llm_providers.secret_alias', 'agent_llm_providers.service_alias',
    'profiles.avatar_color'
  ];
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.table_name NOT IN ('_migrations', '_migration_backup_marker')
       AND NOT (c.table_name || '.' || c.column_name = ANY (v_excluded))
       AND c.column_name <> 'id'
       AND c.column_name NOT LIKE '%\_id'
       AND c.column_name NOT LIKE '%\_cents'
       AND c.column_name NOT LIKE '%\_hash'
       AND c.column_name NOT ILIKE '%idempotency%'
       AND c.column_name <> 'key'
       AND (
             c.data_type IN ('json', 'jsonb')
             OR (
               c.data_type IN ('text', 'character varying', 'character')
               AND (
             c.column_name ILIKE '%email%'
             OR c.column_name ILIKE '%name%'
             OR c.column_name ILIKE '%phone%'
             OR c.column_name ILIKE '%token%'
             OR c.column_name ILIKE '%secret%'
             OR c.column_name ILIKE '%password%' OR c.column_name ILIKE '%passwd%'
             OR c.column_name ILIKE '%document%' OR c.column_name ILIKE '%cpf%' OR c.column_name ILIKE '%cnpj%'
             OR c.column_name ILIKE '%address%' OR c.column_name ILIKE '%endereco%'
             OR c.column_name ILIKE '%description%'
             OR c.column_name ILIKE '%note%'
             OR c.column_name ILIKE '%chat\_id' OR c.column_name ILIKE '%endpoint%'
             OR c.column_name ILIKE '%user\_agent%'
             OR c.column_name ILIKE '%ip\_address%' OR c.column_name ILIKE '%ipaddress%'
             OR c.column_name ILIKE '%identifier%'
             OR c.column_name ILIKE '%image%' OR c.column_name ILIKE '%avatar%'
             OR c.column_name ILIKE '%message\_id%'
             OR c.column_name ILIKE '%banreason%'
             OR c.column_name IN ('payload', 'metadata', 'response', 'details', 'data', 'content', 'body', 'value')
               )
             )
           )
     ORDER BY c.table_name, c.ordinal_position
  LOOP
    BEGIN
      IF r.data_type IN ('json', 'jsonb') THEN
        v_sql := format('UPDATE public.%I SET %I = ''{}''::jsonb', r.table_name, r.column_name);
      ELSIF r.column_name ILIKE '%email%' THEN
        v_prefix := 'anon-' || r.table_name || '-';
        v_suffix := '@invalid.example';
        v_sql := format(
          'UPDATE public.%I AS t SET %I = CASE WHEN t.%I IS NULL THEN NULL ELSE s.v END '
          || 'FROM (SELECT ctid AS c, %L || row_number() OVER (ORDER BY ctid)::text || %L AS v FROM public.%I) AS s '
          || 'WHERE t.ctid = s.c',
          r.table_name, r.column_name, r.column_name, v_prefix, v_suffix, r.table_name);
      ELSIF r.column_name ILIKE '%phone%' THEN
        v_sql := format(
          'UPDATE public.%I AS t SET %I = CASE WHEN t.%I IS NULL THEN NULL ELSE s.v END '
          || 'FROM (SELECT ctid AS c, %L || row_number() OVER (ORDER BY ctid)::text AS v FROM public.%I) AS s '
          || 'WHERE t.ctid = s.c',
          r.table_name, r.column_name, r.column_name, '+550000000-', r.table_name);
      ELSIF r.column_name ILIKE '%ip\_address%' OR r.column_name ILIKE '%ipaddress%' THEN
        v_sql := format('UPDATE public.%I SET %I = CASE WHEN %I IS NULL THEN NULL ELSE ''0.0.0.0'' END',
          r.table_name, r.column_name, r.column_name);
      ELSE
        v_prefix := 'anon-' || r.table_name || '-';
        v_sql := format(
          'UPDATE public.%I AS t SET %I = CASE WHEN t.%I IS NULL THEN NULL ELSE s.v END '
          || 'FROM (SELECT ctid AS c, %L || row_number() OVER (ORDER BY ctid)::text AS v FROM public.%I) AS s '
          || 'WHERE t.ctid = s.c',
          r.table_name, r.column_name, r.column_name, v_prefix, r.table_name);
      END IF;
      EXECUTE v_sql;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || (SQLSTATE || ' ' || r.table_name || '.' || r.column_name || ': ' || SQLERRM);
    END;
  END LOOP;
  IF cardinality(v_failed) > 0 THEN
    RAISE EXCEPTION 'anonymize safety net FAILED on % column(s) — fix the scrub and re-run BEFORE pg_dump export: %',
      cardinality(v_failed), array_to_string(v_failed, '; ');
  END IF;
END $$;

-- ============================================================
-- Step 4: re-enable USER triggers disabled in Step 0.
-- ============================================================
DO $$
DECLARE
  t TEXT;
  v_tables TEXT[] := ARRAY[
    'users', 'households', 'memberships', 'invites', 'accounts',
    'categories', 'statements', 'transactions', 'card_purchases',
    'accounts_payable', 'budgets', 'goals', 'goal_contributions',
    'payable_templates', 'notification_configs', 'subscriptions',
    'idempotency_keys', 'device_tokens', 'operation_records', 'audit_logs',
    'user', 'session', 'account', 'verification', 'profiles',
    'account_invites', 'push_subscriptions',
    'push_reminder_deliveries', 'push_delivery_attempts', 'pending_operations',
    'recurring_purchases', 'agent_llm_providers', 'agent_llm_runtime_config'
  ];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- Step 4b: residual-PII gate — FAIL CLOSED inside the transaction, BEFORE
-- COMMIT and therefore BEFORE any pg_dump export. Any violation aborts the
-- whole scrub (RAISE EXCEPTION rolls back); the VPS pipeline (psql
-- ON_ERROR_STOP=1 + set -o pipefail) stops before the export. Step 6 below
-- mirrors these checks post-COMMIT as 0-violation evidence only.
-- ============================================================
DO $$
DECLARE
  v_n BIGINT;
  v_violations TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_n FROM public.users WHERE email NOT LIKE 'anon%@invalid.example';
    IF v_n > 0 THEN v_violations := v_violations || ('users.email not anon: ' || v_n); END IF;
  END IF;
  IF to_regclass('public."user"') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_n FROM public."user" WHERE email NOT LIKE 'anon-user%@invalid.example';
    IF v_n > 0 THEN v_violations := v_violations || ('user.email not anon: ' || v_n); END IF;
  END IF;
  IF to_regclass('public.session') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_n FROM public."session" WHERE token NOT LIKE 'anon-session-token-%';
    IF v_n > 0 THEN v_violations := v_violations || ('session.token not anon: ' || v_n); END IF;
    SELECT COUNT(*) INTO v_n FROM public."session" WHERE "ipAddress" IS NOT NULL AND "ipAddress" <> '0.0.0.0';
    IF v_n > 0 THEN v_violations := v_violations || ('session.ipAddress not anon: ' || v_n); END IF;
  END IF;
  IF to_regclass('public.account') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_n FROM public.account
      WHERE "accountId" IS NULL OR "accountId" NOT LIKE 'anon-acct-%';
    IF v_n > 0 THEN v_violations := v_violations || ('account.accountId not scrubbed: ' || v_n); END IF;
  END IF;
  IF to_regclass('public.device_tokens') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_n FROM public.device_tokens WHERE token_hash IS NULL OR token_hash !~ '^[0-9a-f]{64}$';
    IF v_n > 0 THEN v_violations := v_violations || ('device_tokens.token_hash not 64-hex: ' || v_n); END IF;
  END IF;
  IF to_regclass('public.invites') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_n FROM public.invites WHERE email NOT LIKE 'anon-invite%@invalid.example';
    IF v_n > 0 THEN v_violations := v_violations || ('invites.email not anon: ' || v_n); END IF;
  END IF;
  IF to_regclass('public.idempotency_keys') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_n FROM public.idempotency_keys WHERE "key" NOT LIKE 'anon-idem-%';
    IF v_n > 0 THEN v_violations := v_violations || ('idempotency_keys.key not scrubbed: ' || v_n); END IF;
  END IF;
  IF to_regclass('public.operation_records') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_n FROM public.operation_records WHERE idempotency_key NOT LIKE 'anon-idem-%';
    IF v_n > 0 THEN v_violations := v_violations || ('operation_records.idempotency_key not scrubbed: ' || v_n); END IF;
  END IF;
  IF to_regclass('public.pending_operations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'pending_operations'
                    AND column_name = 'idempotency_key') THEN
    SELECT COUNT(*) INTO v_n FROM public.pending_operations
      WHERE idempotency_key IS NOT NULL AND idempotency_key NOT LIKE 'anon-idem-%';
    IF v_n > 0 THEN v_violations := v_violations || ('pending_operations.idempotency_key not scrubbed: ' || v_n); END IF;
  END IF;
  IF cardinality(v_violations) > 0 THEN
    RAISE EXCEPTION 'anonymize residual-PII gate FAILED on % check(s) — refusing COMMIT/export: %',
      cardinality(v_violations), array_to_string(v_violations, '; ');
  END IF;
  RAISE NOTICE 'anonymize residual-PII gate: 0 violations (fail-closed before COMMIT)';
END $$;

COMMIT;

-- ============================================================
-- Step 5: verification block — row counts of every converter-imported
-- table plus the Better-Auth identity tables. The operator diffs these
-- against the production counts in the probe report (counts must match).
-- ============================================================
SELECT 'users' AS table_name, COUNT(*) AS anonymized_count FROM public.users
UNION ALL SELECT 'households', COUNT(*) FROM public.households
UNION ALL SELECT 'memberships', COUNT(*) FROM public.memberships
UNION ALL SELECT 'invites', COUNT(*) FROM public.invites
UNION ALL SELECT 'accounts', COUNT(*) FROM public.accounts
UNION ALL SELECT 'categories', COUNT(*) FROM public.categories
UNION ALL SELECT 'statements', COUNT(*) FROM public.statements
UNION ALL SELECT 'transactions', COUNT(*) FROM public.transactions
UNION ALL SELECT 'card_purchases', COUNT(*) FROM public.card_purchases
UNION ALL SELECT 'accounts_payable', COUNT(*) FROM public.accounts_payable
UNION ALL SELECT 'budgets', COUNT(*) FROM public.budgets
UNION ALL SELECT 'goals', COUNT(*) FROM public.goals
UNION ALL SELECT 'goal_contributions', COUNT(*) FROM public.goal_contributions
UNION ALL SELECT 'payable_templates', COUNT(*) FROM public.payable_templates
UNION ALL SELECT 'notification_configs', COUNT(*) FROM public.notification_configs
UNION ALL SELECT 'subscriptions', COUNT(*) FROM public.subscriptions
UNION ALL SELECT 'idempotency_keys', COUNT(*) FROM public.idempotency_keys
UNION ALL SELECT 'device_tokens', COUNT(*) FROM public.device_tokens
UNION ALL SELECT 'operation_records', COUNT(*) FROM public.operation_records
UNION ALL SELECT 'user', COUNT(*) FROM public."user"
UNION ALL SELECT 'session', COUNT(*) FROM public."session"
UNION ALL SELECT 'account', COUNT(*) FROM public.account
UNION ALL SELECT 'verification', COUNT(*) FROM public.verification
ORDER BY 1;

-- ============================================================
-- Step 6: residual-PII spot checks — every row must be 0 violations.
-- Evidence mirror of the fail-closed Step 4b gate (which already aborted on
-- any violation BEFORE COMMIT); kept post-COMMIT for the counts report.
-- ============================================================
SELECT 'residual: users.email not anon' AS check, COUNT(*) AS violations
  FROM public.users WHERE email NOT LIKE 'anon%@invalid.example'
UNION ALL SELECT 'residual: user.email not anon', COUNT(*)
  FROM public."user" WHERE email NOT LIKE 'anon-user%@invalid.example'
UNION ALL SELECT 'residual: session.token not anon', COUNT(*)
  FROM public."session" WHERE token NOT LIKE 'anon-session-token-%'
UNION ALL SELECT 'residual: session.ipAddress not anon', COUNT(*)
  FROM public."session" WHERE "ipAddress" IS NOT NULL AND "ipAddress" <> '0.0.0.0'
UNION ALL SELECT 'residual: account.accountId not scrubbed', COUNT(*)
  FROM public.account WHERE "accountId" IS NULL OR "accountId" NOT LIKE 'anon-acct-%'
UNION ALL SELECT 'residual: device_tokens.token_hash not 64-hex', COUNT(*)
  FROM public.device_tokens WHERE token_hash IS NULL OR token_hash !~ '^[0-9a-f]{64}$'
UNION ALL SELECT 'residual: invites.email not anon', COUNT(*)
  FROM public.invites WHERE email NOT LIKE 'anon-invite%@invalid.example'
UNION ALL SELECT 'residual: idempotency_keys.key not scrubbed', COUNT(*)
  FROM public.idempotency_keys WHERE "key" NOT LIKE 'anon-idem-%'
UNION ALL SELECT 'residual: operation_records.idempotency_key not scrubbed', COUNT(*)
  FROM public.operation_records WHERE idempotency_key NOT LIKE 'anon-idem-%'
ORDER BY 1;
