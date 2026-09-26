/**
 * legacy-purchase-unlinked-patch (Reviewer P2 → HIGH hardening).
 *
 * Scope: apps/api/src/cards/legacy-postgres.ts updatePurchase orphan branch
 * (card_purchases without transaction_id) + this focused test only.
 *
 * Fail-closed rule (HIGH): an unlinked projection cannot prove a unique
 * ledger candidate from household/statement/amount/date heuristics — even
 * 1 candidate could be the wrong row. Any amount/date/description PATCH
 * that would need the ledger is rejected with 409 BEFORE any write (no
 * heuristic guessing, no ledger sync, no candidate lookup). Category-only
 * edits stay projection-only.
 *
 * Fake-PG shape (no live DB): mimics the pg Pool/Client SQL surface used by
 * updatePurchaseCoreInTx + withTransaction + getStatementDetail.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createLegacyPostgresCardStore } from '../../src/cards/legacy-postgres.js';

const HH = 'household-1';
const PURCHASE_ID = 'purchase-orphan-1';
const STMT_ID = 'stmt-1';
const CARD_ID = 'card-1';
const OLD_AMOUNT = 15000;
const OLD_DATE = '2030-08-05';

type CandidateMode = 0 | 1 | 2;

const makeFakeLegacyPool = (candidates: CandidateMode) => {
  const sqlLog: string[] = [];
  const candidateValuesLog: unknown[][] = [];
  let cardPurchaseUpdates = 0;
  let transactionUpdates = 0;
  let rollbacks = 0;
  let commits = 0;

  const stmtRow = () => ({
    id: STMT_ID,
    household_id: HH,
    account_id: CARD_ID,
    cycle_year_month: '2030-08',
    closing_date: new Date('2030-08-15T00:00:00.000Z'),
    due_date: new Date('2030-08-25T00:00:00.000Z'),
    total_cents: OLD_AMOUNT,
    paid_cents: 0,
    status: 'open',
  });

  const cpRow = () => ({
    id: PURCHASE_ID,
    statement_id: STMT_ID,
    amount_cents: OLD_AMOUNT,
    date: OLD_DATE,
    transaction_id: null,
  });

  const candidateRows = () => {
    if (candidates === 0) return [];
    if (candidates === 1) return [{ id: 'tx-candidate-1' }];
    return [{ id: 'tx-candidate-1' }, { id: 'tx-candidate-2' }];
  };

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
    // Orphan candidate lookup (household-scoped, pre-update amount/date).
    if (
      t.includes('FROM transactions WHERE household_id') &&
      t.includes('statement_id = $2') &&
      t.includes('amount_cents = $3')
    ) {
      candidateValuesLog.push(values);
      const rows = candidateRows();
      return { rows, rowCount: rows.length };
    }
    // Projection peek + locked read.
    if (t.includes('FROM card_purchases WHERE id = $1')) {
      return { rows: [cpRow()], rowCount: 1 };
    }
    // Statement lock (gate + recalc share the shape).
    if (t.startsWith('SELECT * FROM statements')) {
      return { rows: [stmtRow()], rowCount: 1 };
    }
    // Writes under test.
    if (t.startsWith('UPDATE card_purchases SET')) {
      cardPurchaseUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('UPDATE transactions SET')) {
      transactionUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    // Recalc total.
    if (t.includes('SUM(amount_cents)')) {
      return { rows: [{ total: OLD_AMOUNT }], rowCount: 1 };
    }
    if (t.startsWith('UPDATE statements SET total_cents')) {
      return { rows: [], rowCount: 1 };
    }
    // Detail read on the same client (updatePurchaseInTx path — not used
    // here, but harmless if reached).
    if (t.includes('FROM statements') && t.includes('cycle_year_month')) {
      return { rows: [stmtRow()], rowCount: 1 };
    }
    if (t.includes('FROM card_purchases cp')) {
      return {
        rows: [{
          id: PURCHASE_ID,
          description: 'Mercado',
          amount_cents: OLD_AMOUNT,
          date: OLD_DATE,
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

  const poolQuery = async (text: string, values: unknown[] = []) => {
    const t = text.replace(/\s+/g, ' ').trim();
    sqlLog.push(`POOL: ${t}`);
    if (t.includes('FROM statements') && t.includes('cycle_year_month')) {
      return { rows: [stmtRow()], rowCount: 1 };
    }
    if (t.includes('FROM card_purchases cp')) {
      return {
        rows: [{
          id: PURCHASE_ID,
          description: 'Mercado',
          amount_cents: OLD_AMOUNT,
          date: OLD_DATE,
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

  return {
    pool: pool as unknown as Pool,
    sqlLog,
    candidateValuesLog,
    stats: () => ({ cardPurchaseUpdates, transactionUpdates, rollbacks, commits }),
  };
};

describe('legacy updatePurchase orphan branch fails closed (P2)', () => {
  it('zero ledger candidates → conflict before any write (rollback)', async () => {
    const fake = makeFakeLegacyPool(0);
    const store = createLegacyPostgresCardStore(fake.pool);
    await expect(
      store.updatePurchase(HH, PURCHASE_ID, { amountCents: 20000 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const s = fake.stats();
    expect(s.cardPurchaseUpdates).toBe(0);
    expect(s.transactionUpdates).toBe(0);
    expect(s.rollbacks).toBe(1);
    expect(s.commits).toBe(0);
    // No heuristic lookup: unlinked financial edits reject before any
    // candidate query (even 1 candidate could be the wrong row).
    expect(fake.candidateValuesLog).toHaveLength(0);
  });

  it('multiple ledger candidates → conflict before any write (rollback)', async () => {
    const fake = makeFakeLegacyPool(2);
    const store = createLegacyPostgresCardStore(fake.pool);
    await expect(
      store.updatePurchase(HH, PURCHASE_ID, { amountCents: 20000 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const s = fake.stats();
    expect(s.cardPurchaseUpdates).toBe(0);
    expect(s.transactionUpdates).toBe(0);
    expect(s.rollbacks).toBe(1);
    expect(s.commits).toBe(0);
    expect(fake.candidateValuesLog).toHaveLength(0);
  });

  it('exactly one candidate → still conflict (no heuristic guessing, rollback)', async () => {
    const fake = makeFakeLegacyPool(1);
    const store = createLegacyPostgresCardStore(fake.pool);
    await expect(
      store.updatePurchase(HH, PURCHASE_ID, { amountCents: 20000 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const s = fake.stats();
    expect(s.cardPurchaseUpdates).toBe(0);
    expect(s.transactionUpdates).toBe(0);
    expect(s.rollbacks).toBe(1);
    expect(s.commits).toBe(0);
    // No heuristic lookup: rejection happens before any candidate query.
    expect(fake.candidateValuesLog).toHaveLength(0);
  });
});
