-- anchor-backfill-20260930.resolve.sql
-- Uncertainty resolver with a real transaction barrier. Run with
-- -v repair_id=<uuid> -v lock_timeout=<e.g. 5s|30s> (psql -v ON_ERROR_STOP=1).
-- Acquiring the table locks PROVES any concurrent repair/compensate TX has
-- finished (commit or rollback); the snapshot read under the same locks is
-- therefore stable. Lock wait is bounded by lock_timeout: on timeout psql
-- aborts => caller treats as TIMEOUT (keep stopped, BLOCKED, no retry).
-- Output: name~value rows (psql -tA -F'~', all values text). Callers map to a
-- verdict; this file never mutates. Read-only apart from locks.
BEGIN;
SET LOCAL lock_timeout = :'lock_timeout';
LOCK TABLE accounts, transactions, operation_records, audit_logs
  IN SHARE ROW EXCLUSIVE MODE;
SELECT 'committed' AS name, (count(*))::text AS value FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id'
UNION ALL SELECT 'compensated', (count(*))::text FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.compensated' AND metadata->>'compensatesRepairId' = :'repair_id'
UNION ALL SELECT 'anchors_0', (count(*))::text FROM accounts WHERE initial_balance_cents = 0
UNION ALL SELECT 'anchors_10000', (count(*))::text FROM accounts WHERE initial_balance_cents = 10000
UNION ALL SELECT 'sum_bal', (COALESCE(sum(balance_cents), 0))::text FROM accounts
UNION ALL SELECT 'sum_tx', (COALESCE(sum(amount_cents), 0))::text FROM transactions WHERE deleted_at IS NULL
UNION ALL SELECT 'ledger_n', (count(*))::text FROM transactions WHERE deleted_at IS NULL
UNION ALL SELECT 'ledger_hash', md5(string_agg(row_to_json(t)::text, ',' ORDER BY t.id::text)) FROM transactions t WHERE t.deleted_at IS NULL
UNION ALL SELECT 'accounts_financial', md5(string_agg(a.id::text || '|' || a.household_id::text || '|' || a.kind || '|' || a.balance_cents::text || '|' || a.status, ',' ORDER BY a.id::text)) FROM accounts a WHERE a.deleted_at IS NULL
UNION ALL SELECT 'accounts_stripped', md5(string_agg(s.x, ',' ORDER BY s.i)) FROM (SELECT ((to_jsonb(a) - 'initial_balance_cents') - 'updated_at')::text AS x, a.id::text AS i FROM accounts a) s
UNION ALL SELECT 'recorded_post_ledger', COALESCE(max(metadata->>'postLedgerHash'), 'none') FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id'
UNION ALL SELECT 'recorded_post_rowhash', COALESCE(max(metadata->>'postRowHash'), 'none') FROM audit_logs WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed' AND metadata->>'repairId' = :'repair_id'
ORDER BY 1;
COMMIT;
