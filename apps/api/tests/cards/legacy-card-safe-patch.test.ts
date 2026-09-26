/**
 * legacy-card-safe-patch (Reviewer HIGH + MEDIUM).
 *
 * Scope: apps/api/src/cards/legacy-postgres.ts updatePurchase
 * (unlinked fail-closed + linked cross-cycle guard) + this test only.
 *
 * - HIGH: unlinked card_purchases (transaction_id NULL) reject any
 *   amount/date/description PATCH with 409 BEFORE any write — even when
 *   exactly 1 ledger candidate exists. Category-only edits stay
 *   projection-only. No heuristic candidate lookup runs.
 * - MEDIUM: LINKED purchases validate a date edit against the locked
 *   statement cycle via the card closing_day (same rule as the canonical
 *   store). Cross-cycle → validation.invalid before any write;
 *   same-cycle → success with ledger + projection sync.
 *
 * Lock order preserved: STATEMENT (household-scoped FOR UPDATE) →
 * TRANSACTION → projection; the claim-tx path (updatePurchaseInTx) runs
 * the same core on the caller's client. Tests assert the statement lock
 * carries the household scope and precedes any write.
 *
 * Fake-PG shape (no live DB): mimics the pg Pool/Client SQL surface used
 * by updatePurchaseCoreInTx + withTransaction + getStatementDetail.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createLegacyPostgresCardStore } from '../../src/cards/legacy-postgres.js';

const HH = 'household-1';
const CARD_ID = 'card-1';
const STMT_ID = 'stmt-1';
const CLOSING_DAY = 10;
// closingDay 10 → 2030-08-05 sits in cycle 2030-08 (closing 2030-08-10).
const OLD_DATE = '2030-08-05';
const OLD_AMOUNT = 15000;
const SAME_CYCLE_DATE = '2030-08-03';
const CROSS_CYCLE_DATE = '2030-08-15'; // → closing 2030-09-10 → cycle 2030-09

type Mode = 'orphan' | 'linked';

const makeFakePool = (mode: Mode) => {
  const sqlLog: string[] = [];
  const stmtLockValues: unknown[][] = [];
  let cardPurchaseUpdates = 0;
  let transactionUpdates = 0;
  let candidateLookups = 0;
  let rollbacks = 0;
  let commits = 0;

  const stmtRow = () => ({
    id: STMT_ID,
    household_id: HH,
    account_id: CARD_ID,
    cycle_year_month: '2030-08',
    closing_date: new Date('2030-08-10T00:00:00.000Z'),
    due_date: new Date('2030-08-20T00:00:00.000Z'),
    total_cents: OLD_AMOUNT,
    paid_cents: 0,
    status: 'open',
  });

  const cpRow = () => ({
    id: mode === 'orphan' ? 'purchase-orphan-1' : 'purchase-linked-1',
    statement_id: STMT_ID,
    account_id: CARD_ID,
    amount_cents: OLD_AMOUNT,
    date: OLD_DATE,
    transaction_id: mode === 'orphan' ? null : 'tx-linked-1',
  });

  const clientQuery = async (text: string, values: unknown[] = []) => {
    const t = text.replace(/\s+/g, ' ').trim();
    sqlLog.push(t);
    if (t === 'BEGIN' || t === 'COMMIT') {
      if (t === 'COMMIT') commits += 1;
      return { rows: [], rowCount: 0 };
    }
    if (t === 'ROLLBACK') {
      rollbacks += 1;
      return { rows: [], rowCount: 0 };
    }
    if (t.includes('FROM categories WHERE id')) {
      return { rows: [], rowCount: 0 };
    }
    if (t.includes('FROM card_purchases WHERE id = $1')) {
      return { rows: [cpRow()], rowCount: 1 };
    }
    if (t.startsWith('SELECT * FROM statements')) {
      stmtLockValues.push(values);
      return { rows: [stmtRow()], rowCount: 1 };
    }
    // Linked ledger lock (SELECT id ... FOR UPDATE) and legacy tx path.
    if (t.startsWith('SELECT id FROM transactions WHERE id = $1')) {
      return { rows: [{ id: 'tx-linked-1' }], rowCount: 1 };
    }
    if (t.startsWith('SELECT closing_day FROM accounts')) {
      return { rows: [{ closing_day: CLOSING_DAY }], rowCount: 1 };
    }
    // Any heuristic candidate scan must never run under the new rule.
    if (
      t.includes('FROM transactions WHERE household_id') &&
      t.includes('statement_id = $2') &&
      t.includes('amount_cents = $3')
    ) {
      candidateLookups += 1;
      return { rows: [{ id: 'tx-candidate-1' }], rowCount: 1 };
    }
    if (t.startsWith('UPDATE card_purchases SET')) {
      cardPurchaseUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('UPDATE transactions SET')) {
      transactionUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('SUM(amount_cents)')) {
      return { rows: [{ total: OLD_AMOUNT }], rowCount: 1 };
    }
    if (t.startsWith('UPDATE statements SET total_cents')) {
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('FROM statements') && t.includes('cycle_year_month')) {
      return { rows: [stmtRow()], rowCount: 1 };
    }
    if (t.includes('FROM card_purchases cp')) {
      return {
        rows: [{
          id: cpRow().id,
          description: 'Mercado',
          amount_cents: OLD_AMOUNT,
          date: mode === 'linked' && sqlLog.some((s) => s.startsWith('UPDATE transactions SET')) ? SAME_CYCLE_DATE : OLD_DATE,
          installments_total: null,
          installment_number: null,
          category_id: null,
          category_name: null,
        }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected client query: ${t.slice(0, 120)}`);
  };

  const poolQuery = async (text: string, _values: unknown[] = []) => {
    const t = text.replace(/\s+/g, ' ').trim();
    sqlLog.push(`POOL: ${t}`);
    if (t.includes('FROM statements') && t.includes('cycle_year_month')) {
      return { rows: [stmtRow()], rowCount: 1 };
    }
    if (t.includes('FROM card_purchases cp')) {
      return {
        rows: [{
          id: cpRow().id,
          description: 'Mercado',
          amount_cents: OLD_AMOUNT,
          date: SAME_CYCLE_DATE,
          installments_total: null,
          installment_number: null,
          category_id: null,
          category_name: null,
        }],
        rowCount: 1,
      };
    }
    if (t.includes('FROM transactions t')) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected pool query: ${t.slice(0, 120)}`);
  };

  const pool = {
    connect: async () => ({ query: clientQuery, release: () => undefined }),
    query: poolQuery,
  };

  const firstWriteIdx = () =>
    sqlLog.findIndex((s) => s.startsWith('UPDATE card_purchases SET') || s.startsWith('UPDATE transactions SET'));
  const stmtLockIdx = () => sqlLog.findIndex((s) => s.startsWith('SELECT * FROM statements'));

  return {
    pool: pool as unknown as Pool,
    sqlLog,
    stats: () => ({ cardPurchaseUpdates, transactionUpdates, candidateLookups, rollbacks, commits }),
    stmtLockValues,
    firstWriteIdx,
    stmtLockIdx,
  };
};

describe('legacy-card-safe-patch', () => {
  it('HIGH — unlinked projection with exactly 1 ledger candidate still rejects 409 before any write', async () => {
    const fake = makeFakePool('orphan');
    const store = createLegacyPostgresCardStore(fake.pool);
    await expect(
      store.updatePurchase(HH, 'purchase-orphan-1', { amountCents: 20000 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const s = fake.stats();
    expect(s.cardPurchaseUpdates).toBe(0);
    expect(s.transactionUpdates).toBe(0);
    expect(s.candidateLookups).toBe(0);
    expect(s.rollbacks).toBe(1);
    expect(s.commits).toBe(0);
    // Household-scoped statement lock still precedes the rejection.
    expect(fake.stmtLockValues).toHaveLength(1);
    expect(fake.stmtLockValues[0]![1]).toBe(HH);
  });

  it('HIGH — unlinked date/description edits also reject; category-only stays projection-only', async () => {
    for (const patch of [{ date: SAME_CYCLE_DATE }, { description: 'Feira' }]) {
      const fake = makeFakePool('orphan');
      const store = createLegacyPostgresCardStore(fake.pool);
      await expect(store.updatePurchase(HH, 'purchase-orphan-1', patch)).rejects.toMatchObject({
        code: 'conflict',
      });
      const s = fake.stats();
      expect(s.cardPurchaseUpdates).toBe(0);
      expect(s.transactionUpdates).toBe(0);
      expect(s.rollbacks).toBe(1);
    }

    const fakeCat = makeFakePool('orphan');
    const storeCat = createLegacyPostgresCardStore(fakeCat.pool);
    // Category id shape: plain existence check runs inline (no row needed
    // to fail here would 404; use a fake category lookup miss → skip).
    // Instead assert the fail-closed boundary only gates ledger fields:
    // a category-only patch must not hit the conflict branch. The fake
    // has no categories table, so expect not_found (proves the orphan
    // 409 did NOT fire first).
    await expect(storeCat.updatePurchase(HH, 'purchase-orphan-1', { categoryId: 'cat-1' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('MEDIUM — linked cross-cycle date edit is rejected before any ledger/projection mutation', async () => {
    const fake = makeFakePool('linked');
    const store = createLegacyPostgresCardStore(fake.pool);
    await expect(
      store.updatePurchase(HH, 'purchase-linked-1', { date: CROSS_CYCLE_DATE }),
    ).rejects.toMatchObject({ code: 'validation.invalid' });
    const s = fake.stats();
    expect(s.cardPurchaseUpdates).toBe(0);
    expect(s.transactionUpdates).toBe(0);
    expect(s.rollbacks).toBe(1);
    expect(s.commits).toBe(0);
    // Statement was locked (household-scoped) before the rejection.
    expect(fake.stmtLockIdx()).toBeGreaterThanOrEqual(0);
    expect(fake.stmtLockValues[0]![1]).toBe(HH);
  });

  it('MEDIUM — linked same-cycle date edit succeeds with ledger + projection sync', async () => {
    const fake = makeFakePool('linked');
    const store = createLegacyPostgresCardStore(fake.pool);
    const detail = await store.updatePurchase(HH, 'purchase-linked-1', { date: SAME_CYCLE_DATE });
    expect(detail).toBeDefined();
    const s = fake.stats();
    expect(s.cardPurchaseUpdates).toBe(1);
    expect(s.transactionUpdates).toBe(1);
    expect(s.commits).toBe(1);
    expect(s.rollbacks).toBe(0);
    // Lock order: household-scoped statement lock precedes every write.
    expect(fake.stmtLockIdx()).toBeGreaterThanOrEqual(0);
    expect(fake.firstWriteIdx()).toBeGreaterThan(fake.stmtLockIdx());
    expect(fake.stmtLockValues[0]![1]).toBe(HH);
  });
});
