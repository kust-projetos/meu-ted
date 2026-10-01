-- anchor-backfill-20260930.guards.sql
-- READ-ONLY guard set for the anchor-backfill repair. No locks, no writes.
-- Each row: guard_name | actual | expected | pass. Exit code is always 0;
-- the executor/test decides on the pass column (psql -tA, pipe-delimited).
-- Run: psql -v ON_ERROR_STOP=1 -U postgres -d <db> -tA -F'|' -f guards.sql

SELECT 'accounts_total'      AS guard, count(*)::text                    AS actual, '31'     AS expected, (count(*) = 31)                        AS pass FROM accounts
UNION ALL SELECT 'anchors_zero',      count(*)::text,                             '31',     (count(*) = 31)                        FROM accounts WHERE initial_balance_cents = 0
UNION ALL SELECT 'balances_sum',      COALESCE(sum(balance_cents),0)::text,       '306300', (COALESCE(sum(balance_cents),0) = 306300) FROM accounts
UNION ALL SELECT 'tx_count',          count(*)::text,                             '28',     (count(*) = 28)                        FROM transactions WHERE deleted_at IS NULL
UNION ALL SELECT 'tx_sum',            COALESCE(sum(amount_cents),0)::text,        '3700',   (COALESCE(sum(amount_cents),0) = 3700) FROM transactions WHERE deleted_at IS NULL
UNION ALL SELECT 'tx_non_expense',    count(*)::text,                             '0',      (count(*) = 0)                         FROM transactions WHERE deleted_at IS NULL AND kind <> 'expense'
UNION ALL SELECT 'tx_orphan',         count(*)::text,                             '0',      (count(*) = 0)                         FROM transactions t WHERE t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id)
UNION ALL SELECT 'tx_transfer_ref',   count(*)::text,                             '0',      (count(*) = 0)                         FROM transactions WHERE deleted_at IS NULL AND transfer_to_account_id IS NOT NULL
UNION ALL SELECT 'opening_invariant', count(*)::text,                             '31',     (count(*) = 31)                        FROM accounts a WHERE a.deleted_at IS NULL AND a.balance_cents + COALESCE((SELECT sum(amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL), 0) = 10000
UNION ALL SELECT 'source_create_31',  count(*)::text,                             '31',     (count(*) = 31)                        FROM operation_records WHERE status = 'completed' AND response->'body'->'receipt'->>'mutationKind' = 'account.create' AND (response->'body'->>'balanceCents')::bigint = 10000
UNION ALL SELECT 'source_id_hh_match', count(*)::text,                            '31',     (count(*) = 31)                        FROM accounts a WHERE EXISTS (SELECT 1 FROM operation_records r WHERE r.response->'body'->'receipt'->>'mutationKind' = 'account.create' AND (r.response->'body'->>'id') = a.id::text AND (r.response->'body'->>'householdId') = a.household_id::text)
UNION ALL SELECT 'source_temporal_31', count(*)::text,                            '31',     (count(*) = 31)                        FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL AND t.created_at < (SELECT r.created_at FROM operation_records r WHERE r.response->'body'->'receipt'->>'mutationKind' = 'account.create' AND (r.response->'body'->>'id') = a.id::text))
UNION ALL SELECT 'source_hash',       md5(string_agg(t, ',' ORDER BY t)),         'c30e17441d7899283182684a59099d7d', (md5(string_agg(t, ',' ORDER BY t)) = 'c30e17441d7899283182684a59099d7d') FROM (SELECT id::text AS t FROM accounts) s
ORDER BY 1;
