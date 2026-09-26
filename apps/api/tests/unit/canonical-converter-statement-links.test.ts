import { describe, expect, it } from 'vitest';
import { BalanceError, resolveStatementLinks } from '../../src/scripts/canonical-converter/balances.js';

type Row = Record<string, unknown>;

/**
 * FINDING-1 RED suite: legacy card purchases may link to their transaction
 * via `card_purchases.transaction_id` while the transaction row itself
 * carries no `statement_id` (V032/V033 normalization). The converter must
 * backfill the canonical `statement_id` from that link BEFORE recomputing
 * balances — otherwise the purchase is debited from the wrong account.
 */
const stubPool = (data: { purchases?: Row[]; transactions?: Row[]; statements?: Row[] }) => {
  const calls: string[] = [];
  // Faithful Postgres simulation: when the issued SQL carries a
  // `deleted_at IS NULL` predicate, soft-deleted fixture rows (deleted_at
  // set) are filtered exactly as the database would filter them. Rows
  // without the predicate keep every fixture row.
  const activeOnly = (rows: Row[], sql: string): Row[] =>
    sql.includes('deleted_at IS NULL') ? rows.filter((r) => r['deleted_at'] == null) : rows;
  return {
    calls,
    query: async (sql: string, _params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ ok: true }], rowCount: 1 };
      }
      if (sql.includes('information_schema.columns')) {
        // The fixture shape carries the legacy card flag (and, in
        // production-shaped archives, card_purchases.deleted_at from V033).
        return { rows: [{ ok: true }], rowCount: 1 };
      }
      if (sql.includes('card_purchases') && sql.includes('transaction_id')) {
        const rows = activeOnly(data.purchases ?? [], sql);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('is_credit_card_purchase')) {
        const rows = activeOnly(
          (data.transactions ?? []).filter((r) => r['is_credit_card_purchase'] === true),
          sql,
        );
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('legacy_archive') && sql.includes('FROM') && sql.includes('transactions')) {
        const rows = activeOnly(data.transactions ?? [], sql);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('statements')) {
        return { rows: data.statements ?? [], rowCount: (data.statements ?? []).length };
      }
      if (sql.includes('UPDATE')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

describe('canonical converter statement-link resolution (FINDING-1)', () => {
  it('backfills the canonical statement_id from card_purchases.transaction_id', async () => {
    const pool = stubPool({
      purchases: [{ transaction_id: 'tx-1', statement_id: 'st-1', household_id: 'hh-1' }],
      transactions: [{ id: 'tx-1', is_credit_card_purchase: true, household_id: 'hh-1' }],
      statements: [{ id: 'st-1', household_id: 'hh-1' }],
    });
    const result = await resolveStatementLinks(pool as never, { schema: 'public' });
    expect(result.backfilled).toBe(1);
    expect(pool.calls.some((sql) => sql.includes('UPDATE') && sql.includes('statement_id'))).toBe(true);
  });

  it('fails closed on an orphan purchase (transaction_id without a transaction)', async () => {
    const pool = stubPool({
      purchases: [{ transaction_id: 'tx-ghost', statement_id: 'st-1', household_id: 'hh-1' }],
      transactions: [],
      statements: [{ id: 'st-1', household_id: 'hh-1' }],
    });
    await expect(resolveStatementLinks(pool as never, { schema: 'public' })).rejects.toThrow(BalanceError);
  });

  it('fails closed when a flagged purchase has no card_purchases row', async () => {
    const pool = stubPool({
      purchases: [],
      transactions: [{ id: 'tx-1', is_credit_card_purchase: true, household_id: 'hh-1' }],
      statements: [],
    });
    await expect(resolveStatementLinks(pool as never, { schema: 'public' })).rejects.toThrow(BalanceError);
  });

  it('fails closed when a purchase points at a missing statement', async () => {
    const pool = stubPool({
      purchases: [{ transaction_id: 'tx-1', statement_id: 'st-ghost', household_id: 'hh-1' }],
      transactions: [{ id: 'tx-1', is_credit_card_purchase: true, household_id: 'hh-1' }],
      statements: [],
    });
    await expect(resolveStatementLinks(pool as never, { schema: 'public' })).rejects.toThrow(BalanceError);
  });

  it('ignores soft-deleted purchase↔transaction pairs (tombstones preserved as-is)', async () => {
    // Regression (production dump shape): the archive holds TWO
    // soft-deleted purchase↔transaction pairs (both sides deleted,
    // statement_id still set) plus ONE active linked purchase. The deleted
    // pairs must NOT trip the orphan fail-closed check: they stay exactly
    // as archived — no backfill, no balance effect, no resurrection, no
    // quarantine. Only the active link is examined.
    const pool = stubPool({
      purchases: [
        { transaction_id: 'tx-1', statement_id: 'st-1', household_id: 'hh-1', deleted_at: null },
        {
          transaction_id: 'tx-del-1',
          statement_id: 'st-1',
          household_id: 'hh-1',
          deleted_at: '2026-08-01T00:00:00.000Z',
        },
        {
          transaction_id: 'tx-del-2',
          statement_id: 'st-1',
          household_id: 'hh-1',
          deleted_at: '2026-08-02T00:00:00.000Z',
        },
      ],
      transactions: [
        { id: 'tx-1', is_credit_card_purchase: true, household_id: 'hh-1', deleted_at: null },
        { id: 'tx-del-1', household_id: 'hh-1', deleted_at: '2026-08-01T00:00:00.000Z' },
        { id: 'tx-del-2', household_id: 'hh-1', deleted_at: '2026-08-02T00:00:00.000Z' },
      ],
      statements: [{ id: 'st-1', household_id: 'hh-1' }],
    });
    const result = await resolveStatementLinks(pool as never, { schema: 'public' });
    expect(result).toEqual({ backfilled: 1, checked: 1 });
  });

  it('still fails closed when an ACTIVE purchase points at a soft-deleted transaction', async () => {
    // Guard against widening the transaction set to include deleted rows:
    // the active-side id set stays `deleted_at IS NULL` only, so an active
    // purchase whose transaction was soft-deleted still refuses to guess.
    const pool = stubPool({
      purchases: [
        { transaction_id: 'tx-1', statement_id: 'st-1', household_id: 'hh-1', deleted_at: null },
      ],
      transactions: [
        {
          id: 'tx-1',
          is_credit_card_purchase: true,
          household_id: 'hh-1',
          deleted_at: '2026-08-01T00:00:00.000Z',
        },
      ],
      statements: [{ id: 'st-1', household_id: 'hh-1' }],
    });
    await expect(resolveStatementLinks(pool as never, { schema: 'public' })).rejects.toThrow(
      /orphan card purchase links transaction 'tx-1'.*refusing to guess/,
    );
  });

  it('pins current global id-match behavior across households (open risk, no household validation)', async () => {
    // OPEN-RISK PIN (not a fix): with no household scope the orphan
    // predicate compares transaction ids GLOBALLY — a purchase in hh-A
    // resolves against a same-id transaction archived under hh-B without
    // complaint. UUIDs make a real collision implausible, but the
    // predicate does not validate it. This test pins the CURRENT
    // behavior; a future fix should require a household match when both
    // sides carry household_id.
    const pool = stubPool({
      purchases: [{ transaction_id: 'tx-1', statement_id: 'st-1', household_id: 'hh-A', deleted_at: null }],
      transactions: [{ id: 'tx-1', is_credit_card_purchase: true, household_id: 'hh-B', deleted_at: null }],
      statements: [{ id: 'st-1', household_id: 'hh-A' }],
    });
    const result = await resolveStatementLinks(pool as never, { schema: 'public' });
    expect(result.checked).toBe(1);
  });
});
