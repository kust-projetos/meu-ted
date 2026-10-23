/**
 * V4.1 Phase 3 Tasks 3.2–3.4 — keyed mutation dispatch onto the claim tx.
 *
 * RED: `writes/keyed-mutations.ts` (isTxClient / runTransactionMutation) and
 * the `*InTx` extensions on the Postgres write stores do not exist yet.
 *
 * Contract: when the idempotency layer hands the producer an open claim
 * transaction client, the financial effect MUST run on that same client
 * (single COMMIT with claim + completion). Without a tx client the plain
 * store methods keep their own boundary (behavior unchanged).
 */
import { describe, expect, it, vi } from 'vitest';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { isTxClient, runTransactionMutation } from '../../src/writes/keyed-mutations.js';

const H = '00000000-0000-4000-8000-00000000000a';
const ACC = '11111111-1111-4111-8111-111111111111';
const CAT = '22222222-2222-4222-8222-222222222222';

const expenseInput = {
  description: 'Lunch',
  amountCents: 1500,
  date: '2026-06-10',
  accountId: ACC,
  categoryId: CAT,
};

const txRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx-1',
  household_id: H,
  kind: 'expense',
  description: 'Lunch',
  amount_cents: 1500,
  date: new Date('2026-06-10T00:00:00.000Z'),
  account_id: ACC,
  category_id: CAT,
  subcategory_id: null,
  transfer_to_account_id: null,
  notes: null,
  ...overrides,
});

/** Fake PG client that serves the canonical expense path. */
const makeClaimClient = (recorder: string[]) => ({
  query: vi.fn(async (text: string) => {
    recorder.push(text);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text.includes('pg_advisory_xact_lock_shared')) return { rows: [], rowCount: 1 };
    // FIX-WS-D2-R2 item 2: guarda de lifecycle dos writers (workspace active).
    if (text.includes('FROM households')) {
      return { rows: [{ status: 'active' }], rowCount: 1 };
    }
    if (text.includes('FROM accounts')) {
      return { rows: [{ id: ACC, household_id: H, name: 'A', kind: 'bank', balance_cents: 5000, status: 'active' }], rowCount: 1 };
    }
    if (text.includes('FROM categories')) {
      return { rows: [{ id: CAT, household_id: H, name: 'Food', kind: 'expense', status: 'active' }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO transactions')) {
      return { rows: [txRow()], rowCount: 1 };
    }
    if (text.startsWith('UPDATE accounts')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${text.slice(0, 90)}`);
  }),
  release: vi.fn(),
});

describe('isTxClient', () => {
  it('detects a PG claim client and rejects anything else', () => {
    expect(isTxClient(makeClaimClient([]))).toBe(true);
    expect(isTxClient(undefined)).toBe(false);
    expect(isTxClient(null)).toBe(false);
    expect(isTxClient({})).toBe(false);
    expect(isTxClient('client')).toBe(false);
  });
});

describe('V4.1 Phase 3 — canonical store joins the claim tx', () => {
  it('exposes client-bound mutation extensions', () => {
    const writes = createPostgresWriteStore({ pool: {} as never });
    const ext = writes as unknown as Record<string, unknown>;
    for (const name of ['createExpenseInTx', 'createIncomeInTx', 'createTransferInTx', 'updateTransactionInTx']) {
      expect(typeof ext[name], name).toBe('function');
    }
  });

  it('runs the expense effect on the passed claim client without opening a new tx', async () => {
    const connect = vi.fn(async () => {
      throw new Error('nested transaction opened — claim and effect are NOT in one tx');
    });
    const writes = createPostgresWriteStore({ pool: { connect } as never });
    const seen: string[] = [];
    const claimTx = makeClaimClient(seen);
    const tx = await runTransactionMutation(writes, claimTx, H, 'expense', expenseInput);
    expect(tx.id).toBe('tx-1');
    expect(connect).not.toHaveBeenCalled();
    expect(seen.some((q) => q.includes('INSERT INTO transactions'))).toBe(true);
    expect(claimTx.query).toHaveBeenCalled();
  });

  it('falls back to the plain store boundary when no claim client is present', async () => {
    const recorded: string[] = [];
    const client = makeClaimClient(recorded);
    const pool = {
      connect: vi.fn(async () => client),
    };
    const writes = createPostgresWriteStore({ pool: pool as never });
    const tx = await runTransactionMutation(writes, undefined, H, 'expense', expenseInput);
    expect(tx.id).toBe('tx-1');
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(recorded[0]).toBe('BEGIN');
    expect(recorded[recorded.length - 1]).toBe('COMMIT');
  });
});

describe('V4.1 Phase 3 — legacy store joins the claim tx', () => {
  it('exposes client-bound mutation extensions under the same names', () => {
    const writes = createLegacyPostgresWriteStore({ pool: {} as never });
    const ext = writes as unknown as Record<string, unknown>;
    for (const name of ['createExpenseInTx', 'createIncomeInTx', 'createTransferInTx', 'updateTransactionInTx']) {
      expect(typeof ext[name], name).toBe('function');
    }
  });

  it('runs the legacy expense effect on the passed claim client', async () => {
    const recorded: string[] = [];
    const claimTx = {
      query: vi.fn(async (text: string) => {
        recorded.push(text);
        if (text.includes('pg_advisory_xact_lock_shared')) return { rows: [], rowCount: 1 };
        if (text.includes('is_credit_card')) {
          return { rows: [{ is_credit_card: false }], rowCount: 1 };
        }
        if (text.includes('FROM categories')) {
          return {
            rows: [{ id: CAT, household_id: H, name: 'Food', kind: 'expense', active: true, parent_id: null }],
            rowCount: 1,
          };
        }
        if (text.includes('INSERT INTO transactions')) {
          return {
            rows: [{
              id: 'tx-legacy-1', household_id: H, kind: 'expense', description: 'Lunch',
              amount_cents: 1500, date: new Date('2026-06-10T00:00:00.000Z'),
              from_account_id: ACC, to_account_id: null, category_id: CAT,
              subcategory_id: null, notes: null,
            }],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected query: ${text.slice(0, 90)}`);
      }),
    };
    const connect = vi.fn(async () => {
      throw new Error('nested transaction opened — claim and effect are NOT in one tx');
    });
    const writes = createLegacyPostgresWriteStore({ pool: { connect } as never });
    const tx = await runTransactionMutation(writes, claimTx, H, 'expense', expenseInput);
    expect(tx.id).toBe('tx-legacy-1');
    expect(connect).not.toHaveBeenCalled();
    expect(recorded.some((q) => q.includes('INSERT INTO transactions'))).toBe(true);
  });
});

describe('V4.1 Phase 4 — fail-closed when the claim tx has no InTx extension', () => {
  it('claimTx present but no *InTx → invariant error, plain method never runs', async () => {
    const plain = {
      createExpense: vi.fn(async () => ({ id: 'tx-1' })),
      createIncome: vi.fn(async () => ({ id: 'tx-1' })),
      createTransfer: vi.fn(async () => ({ id: 'tx-1' })),
      updateTransaction: vi.fn(async () => ({ id: 'tx-1' })),
      softDeleteTransaction: vi.fn(async () => ({ id: 'tx-1' })),
    };
    const claimTx = makeClaimClient([]);
    await expect(
      runTransactionMutation(plain as never, claimTx, H, 'expense', expenseInput),
    ).rejects.toMatchObject({ code: 'idempotency.atomic_mutation_not_supported' });
    await expect(
      runTransactionMutation(plain as never, claimTx, H, 'income', expenseInput),
    ).rejects.toMatchObject({ code: 'idempotency.atomic_mutation_not_supported' });
    await expect(
      runTransactionMutation(plain as never, claimTx, H, 'transfer', expenseInput),
    ).rejects.toMatchObject({ code: 'idempotency.atomic_mutation_not_supported' });
    await expect(
      runTransactionMutation(plain as never, claimTx, H, 'update', { id: 'tx-1', patch: {} }),
    ).rejects.toMatchObject({ code: 'idempotency.atomic_mutation_not_supported' });
    await expect(
      runTransactionMutation(plain as never, claimTx, H, 'softDelete', { id: 'tx-1' }),
    ).rejects.toMatchObject({ code: 'idempotency.atomic_mutation_not_supported' });
    for (const fn of Object.values(plain)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('V4.1 Phase 3 — in-memory keeps one-phase semantics', () => {
  it('runs the mutation synchronously through the plain method (no tx client)', async () => {
    const { state, writes } = createInMemoryStores();
    state.accounts.push({ id: ACC, householdId: H, name: 'A', kind: 'bank', balanceCents: 5000, status: 'active' });
    state.categories.push({ id: CAT, householdId: H, name: 'Food', kind: 'expense', status: 'active' });
    const tx = await runTransactionMutation(writes, undefined, H, 'expense', expenseInput);
    expect(tx.kind).toBe('expense');
    expect(state.transactions).toHaveLength(1);
  });
});
