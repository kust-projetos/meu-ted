-- anchor-backfill-20260930.apply.sql
-- Concrete anchor repair for pi_financeiro_canonical (TEST DATA, user-authorized).
-- One transaction (implicit in DO), explicit locks, source materialization from
-- the 31 unique account.create receipts, snapshot asserts, anchor-only update,
-- financial rowhash invariance, atomic 2-row audit append (one per household).
--
-- Run ONLY via the executor (or the contract test):
--   psql -v ON_ERROR_STOP=1 -U postgres -d <db> \
--     -v repair_id=<uuid> -v backup_id=<id> -v backup_sha=<64hex> \
--     -v procedure_version=anchor-backfill-20260930.apply.sql@v1 \
--     -v reason=<short-text-no-quotes> \
--     -f scripts/ops/anchor-backfill-20260930.apply.sql
-- Any assert failure raises => whole transaction rolls back, zero partial writes.

BEGIN;

-- psql variables are substituted OUTSIDE the dollar-quoted body (psql never
-- interpolates inside $...$), so they land here in a temp params table.
CREATE TEMP TABLE repair_params ON COMMIT DROP AS
SELECT :'repair_id'         AS repair_id,
       :'backup_id'         AS backup_id,
       :'backup_sha'        AS backup_sha,
       :'procedure_version' AS procedure_version,
       :'reason'            AS reason;

DO $repair$
DECLARE
  v_repair_id   text;
  v_backup_id   text;
  v_backup_sha  text;
  v_procver     text;
  v_reason      text;
  v_n           integer;
  v_src_hash    text;
  v_ledger_hash text;
  v_ledger_cnt  integer;
  v_ledger_post text;
  v_pre_rowhash text;
  v_post_rowhash text;
  v_acct_pre    text;
  v_acct_post   text;
  v_strip_pre   text;
  v_strip_post  text;
  v_hh          record;
  v_hh_detail   jsonb;
  v_ids_csv     text;
BEGIN
  SELECT p.repair_id, p.backup_id, p.backup_sha, p.procedure_version, p.reason
    INTO v_repair_id, v_backup_id, v_backup_sha, v_procver, v_reason
  FROM repair_params p;
  -- 0. Parameter sanity -----------------------------------------------------
  PERFORM v_repair_id::uuid;  -- raises when not a uuid
  IF v_backup_sha !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'anchor-backfill: backup_sha must be 64 hex (got len %)', length(v_backup_sha);
  END IF;
  IF v_backup_id = '' OR v_procver = '' OR v_reason = '' THEN
    RAISE EXCEPTION 'anchor-backfill: backup_id/procedure_version/reason are required';
  END IF;
  IF position('''' IN v_reason) > 0 THEN
    RAISE EXCEPTION 'anchor-backfill: reason must not contain quotes';
  END IF;

  -- 1. Lock all touched tables (blocks concurrent writers for the TX) -------
  LOCK TABLE accounts, transactions, operation_records, audit_logs
    IN SHARE ROW EXCLUSIVE MODE;

  -- 1b. SAMEID CAS: refuse retry of an already-recorded repair ----------------
  SELECT count(*) INTO v_n FROM audit_logs
  WHERE operation = 'financial_repair.anchor_backfill'
    AND metadata->>'repairId' = v_repair_id;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'anchor-backfill: repair % already recorded (% rows): refusing retry',
      v_repair_id, v_n;
  END IF;

  -- 2. Materialize the authoritative source: unique original account.create --
  CREATE TEMP TABLE repair_source ON COMMIT DROP AS
  SELECT (r.response->'body'->>'id')::uuid            AS account_id,
         (r.response->'body'->>'householdId')::uuid   AS household_id,
         (r.response->'body'->>'balanceCents')::bigint AS orig_balance,
         r.created_at                                 AS create_ts
  FROM operation_records r
  WHERE r.status = 'completed'
    AND r.response->'body'->'receipt'->>'mutationKind' = 'account.create'
    AND (r.response->'body'->>'balanceCents')::bigint = 10000;

  -- 2a. Source asserts: 31 rows, 31 unique ids, hh split {11,20} -------------
  SELECT count(*) INTO v_n FROM repair_source;
  IF v_n <> 31 THEN
    RAISE EXCEPTION 'anchor-backfill: source rows % <> 31', v_n;
  END IF;
  SELECT count(DISTINCT account_id) INTO v_n FROM repair_source;
  IF v_n <> 31 THEN
    RAISE EXCEPTION 'anchor-backfill: source unique ids % <> 31', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT household_id FROM repair_source GROUP BY household_id) s;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'anchor-backfill: source households % <> 2', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT count(*) c FROM repair_source GROUP BY household_id) s
    WHERE c NOT IN (11, 20);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'anchor-backfill: source hh split is not {11,20}';
  END IF;

  -- 2b. Source/accounts cross-match: id + household, temporal (no tx before create)
  SELECT count(*) INTO v_n
  FROM repair_source s
  WHERE NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = s.account_id AND a.household_id = s.household_id);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'anchor-backfill: % source rows without matching account id+hh', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM accounts a
  WHERE NOT EXISTS (
    SELECT 1 FROM repair_source s WHERE s.account_id = a.id);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'anchor-backfill: % accounts without source create', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM accounts a
  WHERE EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.account_id = a.id AND t.deleted_at IS NULL
      AND t.created_at < (SELECT s.create_ts FROM repair_source s
                          WHERE s.account_id = a.id));
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'anchor-backfill: % accounts with ledger before create', v_n;
  END IF;

  -- 2c. Source ID-set hash (proven constant for this dataset) ----------------
  SELECT md5(string_agg(account_id::text, ',' ORDER BY account_id::text))
    INTO v_src_hash FROM repair_source;
  IF v_src_hash <> 'c30e17441d7899283182684a59099d7d' THEN
    RAISE EXCEPTION 'anchor-backfill: source hash % unexpected', v_src_hash;
  END IF;

  -- 2d. Ledger fingerprint: full-row json hash + count (proven constants) -----
  -- A same-sum tamper (e.g. description-only or amount swap) MUST fail here.
  SELECT count(*),
         md5(string_agg(row_to_json(t)::text, ',' ORDER BY t.id::text))
    INTO v_n, v_ledger_hash
  FROM transactions t WHERE t.deleted_at IS NULL;
  IF v_n <> 28 THEN
    RAISE EXCEPTION 'anchor-backfill: ledger rows % <> 28', v_n;
  END IF;
  v_ledger_cnt := v_n;
  IF v_ledger_hash <> 'a153163d334bacc4d4f1dc9c90a8fe3b' THEN
    RAISE EXCEPTION 'anchor-backfill: ledger fingerprint % unexpected', v_ledger_hash;
  END IF;

  -- 3. Snapshot assumes (pre-repair world) -----------------------------------
  SELECT count(*) INTO v_n FROM accounts;
  IF v_n <> 31 THEN RAISE EXCEPTION 'anchor-backfill: accounts % <> 31', v_n; END IF;
  SELECT count(*) INTO v_n FROM accounts WHERE initial_balance_cents = 0;
  IF v_n <> 31 THEN RAISE EXCEPTION 'anchor-backfill: anchors-at-0 % <> 31', v_n; END IF;
  SELECT COALESCE(sum(balance_cents),0) INTO v_n FROM accounts;
  IF v_n <> 306300 THEN RAISE EXCEPTION 'anchor-backfill: balances sum % <> 306300', v_n; END IF;
  SELECT count(*) INTO v_n FROM transactions WHERE deleted_at IS NULL;
  IF v_n <> 28 THEN RAISE EXCEPTION 'anchor-backfill: tx count % <> 28', v_n; END IF;
  SELECT COALESCE(sum(amount_cents),0) INTO v_n
  FROM transactions WHERE deleted_at IS NULL;
  IF v_n <> 3700 THEN RAISE EXCEPTION 'anchor-backfill: tx sum % <> 3700', v_n; END IF;
  SELECT count(*) INTO v_n FROM transactions
  WHERE deleted_at IS NULL AND kind <> 'expense';
  IF v_n <> 0 THEN RAISE EXCEPTION 'anchor-backfill: non-expense tx present'; END IF;
  SELECT count(*) INTO v_n FROM transactions t
  WHERE t.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id);
  IF v_n <> 0 THEN RAISE EXCEPTION 'anchor-backfill: orphan tx present'; END IF;
  SELECT count(*) INTO v_n
  FROM accounts a
  WHERE a.deleted_at IS NULL
    AND a.balance_cents + COALESCE(
      (SELECT sum(amount_cents) FROM transactions t
       WHERE t.account_id = a.id AND t.deleted_at IS NULL), 0) = 10000;
  IF v_n <> 31 THEN
    RAISE EXCEPTION 'anchor-backfill: opening invariant holds for % <> 31', v_n;
  END IF;

  -- 4. Pre-repair hashes: financial rowhash + full-row accounts json -----------
  SELECT md5(string_agg(
      a.id::text || '|' || a.household_id::text || '|' || a.kind || '|' ||
      a.balance_cents::text || '|' || a.status, ',' ORDER BY a.id::text))
    INTO v_pre_rowhash
  FROM accounts a WHERE a.deleted_at IS NULL;
  SELECT md5(string_agg(row_to_json(a)::text, ',' ORDER BY a.id::text))
    INTO v_acct_pre
  FROM accounts a;
  SELECT md5(string_agg(
      ((to_jsonb(a) - 'initial_balance_cents') - 'updated_at')::text, ',' ORDER BY a.id::text))
    INTO v_strip_pre
  FROM accounts a;

  -- 5. Anchor-only update, joined on source id+hh, guarded per row ------------
  -- NOTE: current balance reflects post-creation expenses, so the per-row
  -- guard re-proves the opening invariant (balance + movements = orig 10000)
  -- instead of comparing balance to the creation-time snapshot.
  UPDATE accounts a
  SET initial_balance_cents = 10000
  FROM repair_source s
  WHERE a.id = s.account_id
    AND a.household_id = s.household_id
    AND a.deleted_at IS NULL
    AND a.initial_balance_cents = 0
    AND a.balance_cents + COALESCE(
      (SELECT sum(amount_cents) FROM transactions t
       WHERE t.account_id = a.id AND t.deleted_at IS NULL), 0) = s.orig_balance;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 31 THEN
    RAISE EXCEPTION 'anchor-backfill: updated % rows <> 31', v_n;
  END IF;

  -- 6. Post asserts: hashes unchanged, residual zero, totals invariant -------
  SELECT md5(string_agg(
      a.id::text || '|' || a.household_id::text || '|' || a.kind || '|' ||
      a.balance_cents::text || '|' || a.status, ',' ORDER BY a.id::text))
    INTO v_post_rowhash
  FROM accounts a WHERE a.deleted_at IS NULL;
  IF v_post_rowhash <> v_pre_rowhash THEN
    RAISE EXCEPTION 'anchor-backfill: financial rowhash changed (pre % post %)',
      v_pre_rowhash, v_post_rowhash;
  END IF;
  SELECT md5(string_agg(row_to_json(a)::text, ',' ORDER BY a.id::text))
    INTO v_acct_post
  FROM accounts a;
  -- Only the anchor (plus the accounts_set_updated_at trigger bump) may
  -- differ: stripped full-row hashes must be identical.
  SELECT md5(string_agg(
      ((to_jsonb(a) - 'initial_balance_cents') - 'updated_at')::text, ',' ORDER BY a.id::text))
    INTO v_strip_post
  FROM accounts a;
  IF v_strip_post <> v_strip_pre THEN
    RAISE EXCEPTION 'anchor-backfill: non-anchor account content changed';
  END IF;
  SELECT count(*) INTO v_n
  FROM accounts a
  WHERE a.deleted_at IS NULL
    AND a.balance_cents <> a.initial_balance_cents + COALESCE(
      (SELECT sum(CASE
                    WHEN t.kind = 'income' THEN t.amount_cents
                    WHEN t.kind = 'expense' THEN -t.amount_cents
                    WHEN t.kind = 'transfer'
                         AND t.transfer_to_account_id = a.id THEN t.amount_cents
                    WHEN t.kind = 'transfer' THEN -t.amount_cents
                    ELSE 0 END)
       FROM transactions t
       WHERE (t.account_id = a.id OR t.transfer_to_account_id = a.id)
         AND t.deleted_at IS NULL), 0);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'anchor-backfill: residual nonzero on % accounts', v_n;
  END IF;
  SELECT COALESCE(sum(balance_cents),0) INTO v_n FROM accounts;
  IF v_n <> 306300 THEN RAISE EXCEPTION 'anchor-backfill: post balances sum changed'; END IF;
  SELECT COALESCE(sum(amount_cents),0) INTO v_n
  FROM transactions WHERE deleted_at IS NULL;
  IF v_n <> 3700 THEN RAISE EXCEPTION 'anchor-backfill: post tx sum changed'; END IF;

  -- 6b. Ledger post: recompute ACTUAL hash after the update, assert == pre ----
  -- (no reused const: independently computed, then persisted below)
  SELECT count(*),
         md5(string_agg(row_to_json(t)::text, ',' ORDER BY t.id::text))
    INTO v_n, v_ledger_post
  FROM transactions t WHERE t.deleted_at IS NULL;
  IF v_n <> 28 OR v_ledger_post <> v_ledger_hash THEN
    RAISE EXCEPTION 'anchor-backfill: post ledger hash/count drifted (pre % post %)',
      v_ledger_hash, v_ledger_post;
  END IF;

  -- 7. Atomic audit append: exactly 2 rows, one per household -----------------
  FOR v_hh IN
    SELECT s.household_id AS hh, count(*) AS cnt
    FROM repair_source s GROUP BY s.household_id ORDER BY s.household_id
  LOOP
    SELECT string_agg(s.account_id::text, ',' ORDER BY s.account_id::text),
           jsonb_agg(jsonb_build_object(
             'id', s.account_id::text,
             'beforeAnchor', 0,
             'afterAnchor', 10000,
             'origBalance', s.orig_balance)
             ORDER BY s.account_id::text)
      INTO v_ids_csv, v_hh_detail
    FROM repair_source s WHERE s.household_id = v_hh.hh;

    INSERT INTO audit_logs (
      id, operation_record_id, workspace_id, actor_id,
      operation, event_type, payload_hash, effect_ref, metadata, actor_type
    ) VALUES (
      gen_random_uuid(),
      NULL, -- repair is not an operation_record: no fake linkage, ever
      v_hh.hh,
      'system:anchor-backfill-20260930',
      'financial_repair.anchor_backfill',
      'financial_repair.committed',
      md5(v_ids_csv),
      'anchor-backfill:' || v_hh.hh::text,
      jsonb_build_object(
        'repairId', v_repair_id,
        'procedureVersion', v_procver,
        'reason', v_reason,
        'backupId', v_backup_id,
        'backupSha', v_backup_sha,
        'householdId', v_hh.hh::text,
        'accountCount', v_hh.cnt,
        'anchorValueCents', 10000,
        'sourceHash', v_src_hash,
        'preRowHash', v_pre_rowhash,
        'postRowHash', v_post_rowhash,
        'preLedgerHash', v_ledger_hash,
        'postLedgerHash', v_ledger_post,
        'ledgerRowCount', v_ledger_cnt,
        'preAccountsFullHash', v_acct_pre,
        'postAccountsFullHash', v_acct_post,
        'accountIds', v_ids_csv,
        'perAccount', v_hh_detail,
        'actorTypeNote', 'schema CHECK audit_logs_actor_type_check allows only device|user; repair is operator-executed system work recorded as user with namespaced non-user actor_id (zero system:* ids pre-exist)',
        'supersedesNothing', true
      ),
      'user' -- CHECK-constrained; truth lives in operation/event_type/metadata
    );
  END LOOP;

  SELECT count(*) INTO v_n FROM audit_logs
  WHERE operation = 'financial_repair.anchor_backfill'
    AND event_type = 'financial_repair.committed'
    AND metadata->>'repairId' = v_repair_id;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'anchor-backfill: audit rows % <> 2', v_n;
  END IF;

  RAISE NOTICE 'anchor-backfill OK repair=% src=% pre=% post=%',
    v_repair_id, v_src_hash, v_pre_rowhash, v_post_rowhash;
END $repair$;

COMMIT;
