-- anchor-backfill-20260930.verify.sql
-- SHARED mode-aware post-verify, read-only. Used by the executor (post-verify
-- gates) and by the contract test (REAL run on restored PG after apply and
-- after compensate). Run with -v mode='apply'|'compensate' -v repair_id=<uuid>.
-- Output: name~value rows (psql -tA -F'~'). Mode selects its row block via
-- HAVING on :'mode' (a bare WHERE on an aggregate still emits one row, so the
-- mode gate MUST be in HAVING; psql \if does NOT interpolate :'vars', so no
-- meta-commands are used here). All values cast to text (UNION typing).
-- Callers assert the expected values below.
-- Expected APPLY: anchors_10000=31 residual=0 sum_bal=306300 sum_tx=3700
--   audit_rows=2 audit_workspaces=2 one_per_hh_bad=0 hh_counts_bad=0
--   meta_len_bad=0 ids_acct_not_audit=0 ids_audit_not_acct=0
-- Expected COMPENSATE: anchors_0=31 sum_bal=306300 sum_tx=3700
--   comp_rows=2 comp_workspaces=2 comp_one_per_hh_bad=0
SELECT 'mode' AS name, (:'mode')::text AS value
UNION ALL SELECT 'anchors_10000', (count(*))::text FROM accounts WHERE initial_balance_cents = 10000 HAVING :'mode' = 'apply'
UNION ALL SELECT 'residual', (count(*))::text FROM accounts a WHERE a.deleted_at IS NULL AND a.balance_cents <> a.initial_balance_cents + COALESCE((SELECT sum(CASE WHEN t.kind = 'income' THEN t.amount_cents WHEN t.kind = 'expense' THEN -t.amount_cents WHEN t.kind = 'transfer' AND t.transfer_to_account_id = a.id THEN t.amount_cents WHEN t.kind = 'transfer' THEN -t.amount_cents ELSE 0 END) FROM transactions t WHERE (t.account_id = a.id OR t.transfer_to_account_id = a.id) AND t.deleted_at IS NULL), 0) HAVING :'mode' = 'apply'
UNION ALL SELECT 'sum_bal', (COALESCE(sum(balance_cents), 0))::text FROM accounts
UNION ALL SELECT 'sum_tx', (COALESCE(sum(amount_cents), 0))::text FROM transactions WHERE deleted_at IS NULL
UNION ALL SELECT 'audit_rows', (count(*))::text FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id' HAVING :'mode' = 'apply'
UNION ALL SELECT 'audit_workspaces', (count(DISTINCT workspace_id))::text FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id' HAVING :'mode' = 'apply'
UNION ALL SELECT 'one_per_hh_bad', (count(*))::text FROM (SELECT workspace_id, count(*) c FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id' GROUP BY workspace_id) s WHERE s.c <> 1 HAVING :'mode' = 'apply'
UNION ALL SELECT 'hh_counts_bad', (count(*))::text FROM (SELECT (metadata->>'accountCount')::int c FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id') s WHERE s.c NOT IN (11, 20) HAVING :'mode' = 'apply'
UNION ALL SELECT 'meta_len_bad', (count(*))::text FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id' AND jsonb_array_length(metadata->'perAccount') <> (metadata->>'accountCount')::int HAVING :'mode' = 'apply'
UNION ALL SELECT 'ids_acct_not_audit', (count(*))::text FROM (SELECT id::text t FROM accounts EXCEPT SELECT DISTINCT (elem->>'id') FROM audit_logs, jsonb_array_elements(metadata->'perAccount') AS elem WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id') d HAVING :'mode' = 'apply'
UNION ALL SELECT 'ids_audit_not_acct', (count(*))::text FROM (SELECT DISTINCT (elem->>'id') t FROM audit_logs, jsonb_array_elements(metadata->'perAccount') AS elem WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id' EXCEPT SELECT id::text FROM accounts) d HAVING :'mode' = 'apply'
UNION ALL SELECT 'anchors_0', (count(*))::text FROM accounts WHERE initial_balance_cents = 0 HAVING :'mode' = 'compensate'
UNION ALL SELECT 'comp_rows', (count(*))::text FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.compensated' AND metadata->>'compensatesRepairId' = :'repair_id' HAVING :'mode' = 'compensate'
UNION ALL SELECT 'comp_workspaces', (count(DISTINCT workspace_id))::text FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.compensated' AND metadata->>'compensatesRepairId' = :'repair_id' HAVING :'mode' = 'compensate'
UNION ALL SELECT 'comp_one_per_hh_bad', (count(*))::text FROM (SELECT workspace_id, count(*) c FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.compensated' AND metadata->>'compensatesRepairId' = :'repair_id' GROUP BY workspace_id) s WHERE s.c <> 1 HAVING :'mode' = 'compensate'
ORDER BY 1;
