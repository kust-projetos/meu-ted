/**
 * card-debt-write review fixes (reviewer HIGH + MEDIUM, security MEDIUM).
 *
 * Scope: apps/api/src/cards/postgres.ts, apps/api/src/cards/in-memory.ts
 * and card-specific tests only (no route changes).
 *
 * - HIGH (installments deadlock): the per-parcel loop locked statements of
 *   different cycles interleaved with the card-account lock
 *   (stmt_A → card → stmt_B), so two installment sets with different
 *   initial cycles on the same card could deadlock. Fixed shape: precompute
 *   every parcel's cycle, acquire ALL statement locks in stable
 *   (ascending-cycle) order BEFORE any transaction insert or card debt
 *   write, with a single exact card delta at the end.
 * - MEDIUM (PATCH in-memory): an amount PATCH with a missing / inactive /
 *   wrong-household card silently skipped the debt delta and still mutated
 *   the ledger. Now fails closed before any mutation.
 * - Security MEDIUM (PATCH date): a date edit could silently cross into
 *   another billing cycle while staying linked to the old statement. Now
 *   rejected (validation.invalid) before any mutation when the new date
 *   resolves to a different statement cycle.
 *
 * Far-future 2030 dates keep fixture statements genuinely 'open'
 * regardless of wall-clock (computeStatus is wall-clock relative).
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createInMemoryCardStore } from '../../src/cards/in-memory.js';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import type { InMemoryState } from '../../src/writes/in-memory.js';

const H = 'household-1';
const OTHER_HOUSEHOLD = 'household-2';

// closingDay 10 → 2030-08-05 sits in cycle 2030-08 (closing 2030-08-10).
const PURCHASE_DATE = '2030-08-05';
const SAME_CYCLE_DATE = '2030-08-03';
const CROSS_CYCLE_DATE = '2030-08-15'; // → closing 2030-09-10 → cycle 2030-09

// ── In-memory helpers ──────────────────────────────────────────────

const baseState = (): InMemoryState => ({
  accounts: [],
  categories: [],
  transactions: [],
  deletedTransactions: new Set<string>(),
});

const setupCardWithPurchase = async (date: string = PURCHASE_DATE) => {
  const state = baseState();
  const cards = createInMemoryCardStore(state);
  const card = await cards.createCard(H, {
    name: 'Nubank',
    creditLimitCents: 5000_00,
    closingDay: 10,
    dueDay: 20,
  });
  const [tx] = await cards.createCardPurchase(H, {
    accountId: card.id,
    description: 'Mercado',
    amountCents: 150_00,
    date,
  });
  return { state, cards, card, tx };
};

const statementTotalOf = async (
  cards: ReturnType<typeof createInMemoryCardStore>,
  cardId: string,
): Promise<number> => {
  const stmts = await cards.listStatements(H, cardId);
  return stmts[0]!.totalCents;
};

// ── Fake-PG helpers (lock-order / SQL-shape assertions, no live DB) ─

type FakeKind = 'stmt-lock' | 'tx-insert' | 'card-write' | 'other';
type FakeLog = { seq: number; client: string; kind: FakeKind; cycle?: string; delta?: number };

type FakeOpts = { closingDay?: number; dueDay?: number; stmtCycle?: string };

const makeFakePool = (opts: FakeOpts = {}) => {
  const closingDay = opts.closingDay ?? 10;
  const dueDay = opts.dueDay ?? 20;
  const log: FakeLog[] = [];
  const sqlLog: string[] = [];
  let seq = 0;
  let clients = 0;
  const stmts = new Map<string, { id: string; closing: string; due: string }>();
  const cardDeltas: Record<string, number[]> = {};
  const detail = { description: 'Mercado', amountCents: 150_00, date: PURCHASE_DATE };

  const stmtRow = (cycle: string) => {
    const s = stmts.get(cycle) ?? { id: `stmt-${cycle}`, closing: `${cycle}-10`, due: `${cycle}-20` };
    return {
      id: s.id,
      household_id: 'h1',
      account_id: 'card-1',
      cycle_year_month: cycle,
      closing_date: new Date(`${s.closing}T00:00:00.000Z`),
      due_date: new Date(`${s.due}T00:00:00.000Z`),
      total_cents: 0,
      paid_cents: 0,
      status: 'open',
    };
  };

  const query = (name: string) => async (text: string, values: unknown[] = []) => {
    // Yield like statement-upsert.test.ts so concurrent callers interleave.
    await Promise.resolve();
    const t = text.replace(/\s+/g, ' ').trim();
    sqlLog.push(t);
    const push = (kind: FakeKind, extra: Partial<FakeLog> = {}): void => {
      log.push({ seq: seq++, client: name, kind, ...extra });
    };
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (t.includes('ON CONFLICT')) {
      const cycle = values[2] as string;
      if (!stmts.has(cycle)) {
        stmts.set(cycle, { id: `stmt-${cycle}`, closing: values[3] as string, due: values[4] as string });
      }
      push('other');
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('SELECT id FROM statements')) {
      const cycle = values[2] as string;
      push('stmt-lock', { cycle });
      return { rows: [{ id: stmts.get(cycle)!.id }], rowCount: 1 };
    }
    if (t.startsWith('SELECT * FROM statements')) {
      const id = values[0] as string;
      const cycle = [...stmts.entries()].find(([, s]) => s.id === id)?.[0] ?? opts.stmtCycle ?? '2030-08';
      push('stmt-lock', { cycle });
      return { rows: [stmtRow(cycle)], rowCount: 1 };
    }
    if (t.startsWith('SELECT id, statement_id FROM transactions')) {
      push('other');
      return {
        rows: [{ id: 'purchase-1', statement_id: `stmt-${opts.stmtCycle ?? '2030-08'}` }],
        rowCount: 1,
      };
    }
    if (t.includes('amount_cents, account_id') && t.includes('FOR UPDATE')) {
      push('other');
      return {
        rows: [{
          id: 'purchase-1',
          statement_id: `stmt-${opts.stmtCycle ?? '2030-08'}`,
          amount_cents: detail.amountCents,
          account_id: 'card-1',
        }],
        rowCount: 1,
      };
    }
    if (t.startsWith('SELECT closing_day FROM accounts')) {
      push('other');
      return { rows: [{ closing_day: closingDay }], rowCount: 1 };
    }
    if (t.startsWith('SELECT balance_cents FROM accounts')) {
      push('other');
      return { rows: [{ balance_cents: 0 }], rowCount: 1 };
    }
    if (t.startsWith('SELECT id, kind, closing_day, due_day FROM accounts')) {
      push('other');
      return {
        rows: [{ id: 'card-1', kind: 'credit_card', closing_day: closingDay, due_day: dueDay }],
        rowCount: 1,
      };
    }
    if (t.startsWith('INSERT INTO transactions') || t.startsWith('INSERT INTO card_purchases')) {
      push('tx-insert');
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('UPDATE transactions SET')) {
      push('other');
      for (const v of values) {
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) detail.date = v;
        else if (typeof v === 'string' && v !== 'purchase-1' && v !== 'h1') detail.description = v;
      }
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('UPDATE card_purchases SET') || t.startsWith('UPDATE statements SET total_cents')) {
      push('other');
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('SUM(amount_cents)')) {
      push('other');
      return { rows: [{ total: detail.amountCents }], rowCount: 1 };
    }
    if (t.startsWith('UPDATE accounts SET balance_cents')) {
      const delta = values[0] as number;
      cardDeltas[name].push(delta);
      push('card-write', { delta });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${t.slice(0, 100)}`);
  };

  const pool = {
    connect: async () => {
      // Assigned synchronously: withTransaction calls connect() in call
      // order, so concurrent runs get deterministic client names.
      const name = `c${++clients}`;
      cardDeltas[name] = [];
      return { query: query(name), release: () => undefined };
    },
    query: async (text: string, _values: unknown[] = []) => {
      await Promise.resolve();
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.includes('FROM statements') && t.includes('cycle_year_month')) {
        return { rows: [stmtRow(opts.stmtCycle ?? '2030-08')], rowCount: 1 };
      }
      if (t.includes('FROM transactions t')) {
        return {
          rows: [{
            id: 'purchase-1',
            description: detail.description,
            amount_cents: detail.amountCents,
            date: detail.date,
            installments_total: null,
            installment_number: null,
            category_id: null,
            category_name: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected pool query: ${t.slice(0, 100)}`);
    },
  };
  const forClient = (name: string): FakeLog[] => log.filter((e) => e.client === name).sort((a, b) => a.seq - b.seq);
  return { pool, log, sqlLog, cardDeltas, forClient };
};

// ── HIGH: installments deadlock (stable statement-lock order) ──────

describe('HIGH — installments lock all cycle statements before any card/insert write', () => {
  it('two installment sets with different initial cycles on the same card converge with stable lock order', async () => {
    const fake = makeFakePool();
    const store = createPostgresCardStore(fake.pool as unknown as Pool);
    const h = 'h1';

    // A starts in cycle 2030-08 (purchase 2030-07-20, closingDay 10),
    // B starts in cycle 2030-09 (purchase 2030-08-20): different initial
    // cycles on the same card — the interleaving that used to deadlock.
    const runA = store.createCardInstallments(h, {
      accountId: 'card-1',
      description: 'Set A',
      totalAmountCents: 300_00,
      purchaseDate: '2030-07-20',
      installmentsTotal: 3,
    });
    const runB = store.createCardInstallments(h, {
      accountId: 'card-1',
      description: 'Set B',
      totalAmountCents: 600_00,
      purchaseDate: '2030-08-20',
      installmentsTotal: 3,
    });
    const [txsA, txsB] = await Promise.all([runA, runB]);
    expect(txsA).toHaveLength(3);
    expect(txsB).toHaveLength(3);

    const logA = fake.forClient('c1');
    const logB = fake.forClient('c2');
    const firstCycle = (entries: FakeLog[]): string | undefined =>
      entries.find((e) => e.kind === 'stmt-lock')?.cycle;
    // Setup sanity: the two sets really start in different cycles.
    expect(firstCycle(logA)).toBe('2030-08');
    expect(firstCycle(logB)).toBe('2030-09');
    expect(firstCycle(logA)).not.toBe(firstCycle(logB));

    for (const [entries, label] of [[logA, 'A'], [logB, 'B']] as const) {
      const locks = entries.filter((e) => e.kind === 'stmt-lock');
      const writes = entries.filter((e) => e.kind === 'tx-insert' || e.kind === 'card-write');
      expect(locks.length).toBeGreaterThan(0);
      // Stable order on DISTINCT cycles: re-locks of an already-held row
      // (recalc under the same tx) are no-ops for deadlock ordering, so
      // the invariant is over first-acquisition order…
      const seen: string[] = [];
      const firstSeq = new Map<string, number>();
      for (const e of locks) {
        if (!firstSeq.has(e.cycle!)) {
          firstSeq.set(e.cycle!, e.seq);
          seen.push(e.cycle!);
        }
      }
      expect(seen, `${label} statement locks in stable order`).toEqual([...seen].sort());
      // …and every distinct statement is first-locked strictly before ANY
      // transaction insert or card debt write.
      const lastFirstLock = Math.max(...[...firstSeq.values()]);
      const firstWrite = Math.min(...writes.map((e) => e.seq));
      expect(firstWrite, `${label} first write after all statement locks`).toBeGreaterThan(lastFirstLock);
    }

    // Exact debt: one delta per set, summing to the input totals.
    expect(fake.cardDeltas['c1']!.reduce((a, b) => a + b, 0)).toBe(300_00);
    expect(fake.cardDeltas['c2']!.reduce((a, b) => a + b, 0)).toBe(600_00);
  });
});

// ── MEDIUM: PATCH in-memory fails closed on bad card ────────────────

describe('MEDIUM — in-memory PATCH amount fails closed when the card is unusable', () => {
  const mutate = async (tweak: (s: InMemoryState, cardId: string) => void) => {
    const { state, cards, card, tx } = await setupCardWithPurchase();
    tweak(state, card.id);
    return { state, cards, card, tx };
  };

  it.each([
    ['missing card', (s: InMemoryState, id: string) => {
      s.accounts.splice(s.accounts.findIndex((a) => a.id === id), 1);
    }],
    ['inactive card', (s: InMemoryState, id: string) => {
      s.accounts.find((a) => a.id === id)!.status = 'inactive';
    }],
    ['wrong-household card', (s: InMemoryState, id: string) => {
      s.accounts.find((a) => a.id === id)!.householdId = OTHER_HOUSEHOLD;
    }],
  ])('%s → 404 Cartão with zero mutation', async (_label, tweak) => {
    const { state, cards, card, tx } = await mutate(tweak);
    await expect(cards.updatePurchase(H, tx.id, { amountCents: 200_00 })).rejects.toMatchObject({
      code: 'not_found',
    });
    // No mutation: ledger amount, projection total and card debt untouched.
    expect(state.transactions.find((t) => t.id === tx.id)!.amountCents).toBe(150_00);
    expect(await statementTotalOf(cards, card.id)).toBe(150_00);
  });
});

// ── Security MEDIUM: PATCH date must not cross billing cycles ───────

describe('Security — PATCH date crossing the billing cycle is rejected', () => {
  it('in-memory: same-cycle date edit is accepted', async () => {
    const { cards, tx } = await setupCardWithPurchase();
    const detail = await cards.updatePurchase(H, tx.id, { date: SAME_CYCLE_DATE });
    expect(detail.purchases[0]!.date).toBe(SAME_CYCLE_DATE);
  });

  it('in-memory: cross-cycle date edit is rejected with zero mutation', async () => {
    const { state, cards, card, tx } = await setupCardWithPurchase();
    await expect(cards.updatePurchase(H, tx.id, { date: CROSS_CYCLE_DATE })).rejects.toMatchObject({
      code: 'validation.invalid',
    });
    expect(state.transactions.find((t) => t.id === tx.id)!.date).toBe(PURCHASE_DATE);
    expect(state.transactions.find((t) => t.id === tx.id)!.amountCents).toBe(150_00);
    expect(await statementTotalOf(cards, card.id)).toBe(150_00);
  });

  it('postgres: cross-cycle date edit is rejected before any ledger mutation', async () => {
    const fake = makeFakePool({ stmtCycle: '2030-08' });
    const store = createPostgresCardStore(fake.pool as unknown as Pool);
    await expect(
      store.updatePurchase('h1', 'purchase-1', { date: CROSS_CYCLE_DATE }),
    ).rejects.toMatchObject({ code: 'validation.invalid' });
    expect(fake.sqlLog.some((t) => t.startsWith('UPDATE transactions SET'))).toBe(false);
    expect(fake.sqlLog.some((t) => t.startsWith('UPDATE card_purchases SET'))).toBe(false);
  });

  it('postgres: same-cycle date edit is accepted', async () => {
    const fake = makeFakePool({ stmtCycle: '2030-08' });
    const store = createPostgresCardStore(fake.pool as unknown as Pool);
    const detail = await store.updatePurchase('h1', 'purchase-1', {
      description: 'Feira',
      date: SAME_CYCLE_DATE,
    });
    expect(detail.purchases[0]!.date).toBe(SAME_CYCLE_DATE);
  });
});
