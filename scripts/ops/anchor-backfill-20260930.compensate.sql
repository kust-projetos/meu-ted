-- anchor-backfill-20260930.compensate.sql
-- Concrete compensation for ONE committed anchor-backfill repair.
-- Reverts anchors 10000 -> 0 on EXACTLY the repaired 31-set, guarded:
-- same IDs, anchors currently 10000, financial rowhash/content unchanged
-- since the repair (rejects changed rows), repair not already compensated.
-- NO broad reset. NO automatic full restore (restore-from-backup stays a
-- separate, human-authorized operation).
--
-- Run:
--   psql -v ON_ERROR_STOP=1 -U postgres -d <db> \
--     -v repair_id=<uuid-of-the-repair-to-compensate> \
--     -v procedure_version=anchor-backfill-20260930.compensate.sql@v1 \
--     -v reason=<short-text-no-quotes> \
--     -f scripts/ops/anchor-backfill-20260930.compensate.sql

BEGIN;

-- psql variables land in a temp params table (no interpolation inside $...$).
CREATE TEMP TABLE comp_params ON COMMIT DROP AS
SELECT :'repair_id'         AS repair_id,
       :'procedure_version' AS procedure_version,
       :'reason'            AS reason;

DO $compensate$
DECLARE
  v_repair_id   text;
  v_procver     text;
  v_reason      text;
  v_n           integer;
  v_m           integer;
  v_now_rowhash text;
  v_rec         record;
BEGIN
  SELECT p.repair_id, p.procedure_version, p.reason
    INTO v_repair_id, v_procver, v_reason
  FROM comp_params p;
  PERFORM v_repair_id::uuid;
  IF v_procver = '' OR v_reason = '' THEN
    RAISE EXCEPTION 'anchor-compensate: procedure_version/reason are required';
  END IF;
  IF position('''' IN v_reason) > 0 THEN
    RAISE EXCEPTION 'anchor-compensate: reason must not contain quotes';
  END IF;

  LOCK TABLE accounts, transactions, operation_records, audit_logs
    IN SHARE ROW EXCLUSIVE MODE;

  -- 1. Refuse double compensation --------------------------------------------
  SELECT count(*) INTO v_n FROM audit_logs
  WHERE operation = 'financial_repair.anchor_backfill'
    AND event_type = 'financial_repair.compensated'
    AND metadata->>'compensatesRepairId' = v_repair_id;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'anchor-compensate: repair % already compensated', v_repair_id;
  END IF;

  -- 2. Load the committed repair scope (must be exactly 2 household rows) -----
  SELECT count(*) INTO v_n FROM audit_logs
  WHERE operation = 'financial_repair.anchor_backfill'
    AND event_type = 'financial_repair.committed'
    AND metadata->>'repairId' = v_repair_id;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'anchor-compensate: repair % has % committed rows <> 2',
      v_repair_id, v_n;
  END IF;

  CREATE TEMP TABLE comp_scope ON COMMIT DROP AS
  SELECT (elem->>'id')::uuid AS account_id,
         (a.metadata->>'householdId')::uuid AS household_id,
         (a.metadata->>'postRowHash') AS post_rowhash,
         (a.metadata->>'postLedgerHash') AS post_ledgerhash,
         (a.metadata->>'ledgerRowCount')::integer AS ledger_rowcount,
         (a.metadata->>'accountCount')::integer AS hh_cnt
  FROM audit_logs a,
       jsonb_array_elements(a.metadata->'perAccount') AS elem
  WHERE a.operation = 'financial_repair.anchor_backfill'
    AND a.event_type = 'financial_repair.committed'
    AND a.metadata->>'repairId' = v_repair_id;

  SELECT count(*) INTO v_n FROM comp_scope;
  IF v_n <> 31 THEN
    RAISE EXCEPTION 'anchor-compensate: scope rows % <> 31', v_n;
  END IF;
  SELECT count(DISTINCT account_id) INTO v_n FROM comp_scope;
  IF v_n <> 31 THEN
    RAISE EXCEPTION 'anchor-compensate: scope unique ids % <> 31', v_n;
  END IF;

  -- 3. Reject changed rows: anchors must still be 10000 on the whole set -----
  SELECT count(*) INTO v_n
  FROM comp_scope s JOIN accounts a ON a.id = s.account_id
  WHERE a.deleted_at IS NULL AND a.initial_balance_cents = 10000;
  IF v_n <> 31 THEN
    RAISE EXCEPTION 'anchor-compensate: only % of 31 anchors still 10000 (rows changed?)', v_n;
  END IF;

  -- 4. Reject changed rows: financial content must equal post-repair hash ----
  SELECT md5(string_agg(
      a.id::text || '|' || a.household_id::text || '|' || a.kind || '|' ||
      a.balance_cents::text || '|' || a.status, ',' ORDER BY a.id::text))
    INTO v_now_rowhash
  FROM accounts a JOIN comp_scope s ON s.account_id = a.id
  WHERE a.deleted_at IS NULL;
  SELECT count(*) INTO v_n FROM (
    SELECT DISTINCT post_rowhash FROM comp_scope) h
  WHERE h.post_rowhash = v_now_rowhash;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'anchor-compensate: financial content changed since repair (rowhash mismatch)';
  END IF;

  -- 5. Ledger totals still the proven snapshot --------------------------------
  SELECT COALESCE(sum(balance_cents),0) INTO v_n FROM accounts;
  IF v_n <> 306300 THEN RAISE EXCEPTION 'anchor-compensate: balances sum changed'; END IF;
  SELECT COALESCE(sum(amount_cents),0) INTO v_n
  FROM transactions WHERE deleted_at IS NULL;
  IF v_n <> 3700 THEN RAISE EXCEPTION 'anchor-compensate: tx sum changed'; END IF;

  -- 5b. Ledger fingerprint + count must equal the recorded post-repair state --
  -- (under the same locks; a same-sum content tamper fails here, not on sums)
  SELECT count(*),
         md5(string_agg(row_to_json(t)::text, ',' ORDER BY t.id::text))
    INTO v_n, v_now_rowhash
  FROM transactions t WHERE t.deleted_at IS NULL;
  SELECT count(*) INTO v_m FROM (
    SELECT DISTINCT post_ledgerhash, ledger_rowcount FROM comp_scope) h
  WHERE h.post_ledgerhash = v_now_rowhash AND h.ledger_rowcount = v_n;
  IF v_m <> 1 THEN
    RAISE EXCEPTION 'anchor-compensate: ledger fingerprint/count changed since repair';
  END IF;

  -- 6. Guarded revert, same IDs only ------------------------------------------
  UPDATE accounts a
  SET initial_balance_cents = 0
  FROM comp_scope s
  WHERE a.id = s.account_id
    AND a.household_id = s.household_id
    AND a.deleted_at IS NULL
    AND a.initial_balance_cents = 10000;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 31 THEN
    RAISE EXCEPTION 'anchor-compensate: reverted % rows <> 31', v_n;
  END IF;

  -- 7. Atomic compensation audit: 2 rows linked to the repair -----------------
  FOR v_rec IN
    SELECT household_id AS hh, count(*) AS cnt,
           string_agg(account_id::text, ',' ORDER BY account_id::text) AS ids
    FROM comp_scope GROUP BY household_id ORDER BY household_id
  LOOP
    INSERT INTO audit_logs (
      id, operation_record_id, workspace_id, actor_id,
      operation, event_type, payload_hash, effect_ref, metadata, actor_type
    ) VALUES (
      gen_random_uuid(),
      NULL,
      v_rec.hh,
      'system:anchor-backfill-20260930',
      'financial_repair.anchor_backfill',
      'financial_repair.compensated',
      md5(v_rec.ids),
      'anchor-compensate:' || v_rec.hh::text,
      jsonb_build_object(
        'compensatesRepairId', v_repair_id,
        'procedureVersion', v_procver,
        'reason', v_reason,
        'householdId', v_rec.hh::text,
        'accountCount', v_rec.cnt,
        'accountIds', v_rec.ids,
        'revertedAnchorTo', 0,
        'verifiedLedgerHash', v_now_rowhash,
        'actorTypeNote', 'schema CHECK audit_logs_actor_type_check allows only device|user; see apply file',
        'supersedesNothing', true
      ),
      'user' -- CHECK-constrained; truth lives in operation/event_type/metadata
    );
  END LOOP;

  SELECT count(*) INTO v_n FROM audit_logs
  WHERE operation = 'financial_repair.anchor_backfill'
    AND event_type = 'financial_repair.compensated'
    AND metadata->>'compensatesRepairId' = v_repair_id;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'anchor-compensate: compensation audit rows % <> 2', v_n;
  END IF;

  RAISE NOTICE 'anchor-compensate OK repair=%', v_repair_id;
END $compensate$;

COMMIT;
