/**
 * P1 (audit item 7): V2 pending-operation execution must be key-idempotent.
 *
 * Every financial mutation executed through the V2 executor must run with
 * the pending operation's persisted idempotency key; a retry of the same
 * operation must return the first attempt's outcome and never re-execute
 * the write (SPEC invariante 10 + AGENT-006).
 *
 * RED: the executor calls writes.createExpense/createIncome WITHOUT the
 * persisted operation.idempotencyKey, and WriteStore has no keyed path, so
 * a retry after a partial failure (write committed, finalization lost)
 * books a SECOND transaction.
 */
import { describe, expect, it, vi } from 'vitest';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createLegacyPostgresWriteStore } from '../../src/writes/legacy-postgres.js';
import { createPendingOperationV2Executor } from '../../src/routes/index.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';

const H = 'workspace-1';
const IDENTITY = { workspaceId: H, actorId: 'actor-1', deviceId: 'device-1' };

const seedWrites = async () => {
  const { state, writes } = createInMemoryStores();
  const acc = await writes.createAccount(H, { name: 'A', kind: 'bank', initialBalanceCents: 10_000 });
  const cat = await writes.createCategory(H, { name: 'Food', kind: 'expense' });
  const catInc = await writes.createCategory(H, { name: 'Salary', kind: 'income' });
  return { state, writes, acc, cat, catInc };
};

const expenseInput = (accId: string, catId: string, amountCents = 1000) => ({
  description: 'Lunch', amountCents, date: '2026-06-10', accountId: accId, categoryId: catId,
});

const proposal = async (normalizedArgs: Record<string, unknown>, key: string): Promise<PendingOperationV2> => {
  const base = {
    version: 2 as const,
    workspaceId: H, actorId: 'actor-1', deviceId: 'device-1',
    tool: 'transactions.expense.create', normalizedArgs,
    proposalHash: '', idempotencyKey: key,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bindings: { workspaceId: H, actorId: 'actor-1', deviceId: 'device-1' },
  };
  return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
};

describe('P1: V2 execution is idempotent on the persisted idempotency key', () => {
  it('sequential double createExpense with the same key books exactly one transaction', async () => {
    const { state, writes, acc, cat } = await seedWrites();
    const input = expenseInput(acc.id, cat.id);
    const first = await writes.createExpense(H, input, { idempotencyKey: 'op-key-1' });
    const second = await writes.createExpense(H, input, { idempotencyKey: 'op-key-1' });
    expect(second.id).toBe(first.id);
    expect(state.transactions).toHaveLength(1);
  });

  it('concurrent double createExpense with the same key books exactly one transaction', async () => {
    const { state, writes, acc, cat } = await seedWrites();
    const input = expenseInput(acc.id, cat.id);
    const [a, b] = await Promise.all([
      writes.createExpense(H, input, { idempotencyKey: 'op-key-race' }),
      writes.createExpense(H, input, { idempotencyKey: 'op-key-race' }),
    ]);
    expect(a.id).toBe(b.id);
    expect(state.transactions).toHaveLength(1);
  });

  it('same key with a different payload conflicts instead of re-executing', async () => {
    const { writes, acc, cat } = await seedWrites();
    await writes.createExpense(H, expenseInput(acc.id, cat.id, 1000), { idempotencyKey: 'op-key-conflict' });
    await expect(
      writes.createExpense(H, expenseInput(acc.id, cat.id, 2000), { idempotencyKey: 'op-key-conflict' }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('sequential double createIncome with the same key books exactly one transaction', async () => {
    const { state, writes, acc, catInc } = await seedWrites();
    const input = { description: 'Pay', amountCents: 500, date: '2026-06-10', accountId: acc.id, categoryId: catInc.id };
    const first = await writes.createIncome(H, input, { idempotencyKey: 'op-key-inc' });
    const second = await writes.createIncome(H, input, { idempotencyKey: 'op-key-inc' });
    expect(second.id).toBe(first.id);
    expect(state.transactions).toHaveLength(1);
  });

  it('the V2 executor reuses the persisted idempotency key across calls', async () => {
    const { state, writes, acc, cat } = await seedWrites();
    const executor = createPendingOperationV2Executor(writes);
    const op = await proposal(expenseInput(acc.id, cat.id), 'op-key-exec');
    const first = (await executor(op)) as { status: string; operationId: string };
    const second = (await executor(op)) as { status: string; operationId: string };
    expect(first.status).toBe('succeeded');
    expect(second.operationId).toBe(first.operationId);
    expect(state.transactions).toHaveLength(1);
  });

  it('retry after a partial failure (write committed, finalization lost) does not duplicate', async () => {
    const { state, writes, acc, cat } = await seedWrites();
    const store = createInMemoryPendingOperationV2Store();
    const input = expenseInput(acc.id, cat.id);
    const saved = await store.propose(await proposal(input, 'op-key-retry'));
    const confirmed = await store.confirm(saved.id, IDENTITY);
    // First attempt: the write commits, then the executor crashes before the
    // pending store can finalize (status stays failed after rollback).
    const crashAfterWrite = async (operation: PendingOperationV2) => {
      await writes.createExpense(operation.workspaceId, input, { idempotencyKey: operation.idempotencyKey });
      throw new Error('crash-after-write');
    };
    await expect(store.execute(confirmed.attestation!, IDENTITY, crashAfterWrite)).rejects.toThrow('crash-after-write');
    expect(state.transactions).toHaveLength(1);
    const firstTxId = state.transactions[0]!.id;

    const retried = await store.retry(saved.id, IDENTITY);
    const result = await store.execute(
      retried.attestation!, IDENTITY, createPendingOperationV2Executor(writes),
    );
    expect(result.status).toBe('succeeded');
    expect((result.execution as { operationId: string }).operationId).toBe(firstTxId);
    expect(state.transactions).toHaveLength(1);
  });
});

type Recorded = { text: string; values: unknown[] };

const txRow = (id: string) => ({
  id,
  household_id: H,
  kind: 'expense',
  description: 'Lunch',
  amount_cents: 1000,
  date: new Date('2026-06-10T00:00:00.000Z'),
  account_id: 'acc-1',
  category_id: 'cat-1',
  subcategory_id: null,
  transfer_to_account_id: null,
  notes: null,
});

/** Fake pool with a real idempotency_keys map: miss-then-hit across calls. */
const makeKeyedFakePool = () => {
  const recorded: Recorded[] = [];
  const keys = new Map<string, { payload_hash: string; response: string }>();
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      recorded.push({ text, values });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      // FIX-WS-D2-R2 item 2: guarda de lifecycle dos writers (workspace active).
      if (text.includes('FROM households')) {
        return { rows: [{ status: 'active' }], rowCount: 1 };
      }
      if (text.includes('FROM idempotency_keys')) {
        const hit = keys.get(`${String(values[0])}::${String(values[1])}`);
        return hit ? { rows: [hit], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM accounts')) {
        return {
          rows: [{ id: 'acc-1', household_id: H, name: 'A', kind: 'bank', balance_cents: 10_000, status: 'active', is_credit_card: false }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM categories')) {
        return {
          rows: [{ id: 'cat-1', household_id: H, name: 'Food', kind: 'expense', status: 'active', active: true }],
          rowCount: 1,
        };
      }
      if (text.startsWith('INSERT INTO transactions')) return { rows: [txRow('tx-1')], rowCount: 1 };
      if (text.startsWith('UPDATE accounts')) return { rows: [], rowCount: 1 };
      if (text.startsWith('INSERT INTO idempotency_keys')) {
        const composite = `${String(values[0])}::${String(values[1])}`;
        if (keys.has(composite)) return { rows: [], rowCount: 0 };
        keys.set(composite, { payload_hash: String(values[2]), response: String(values[3]) });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text.slice(0, 100)}`);
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: client.query };
  return { pool: pool as never, recorded };
};

describe('P1: postgres write stores replay the recorded result (fake pool)', () => {
  it('canonical store replays without a second transaction INSERT', async () => {
    const { pool, recorded } = makeKeyedFakePool();
    const writes = createPostgresWriteStore({ pool });
    const input = { description: 'Lunch', amountCents: 1000, date: '2026-06-10', accountId: 'acc-1', categoryId: 'cat-1' };
    const first = await writes.createExpense(H, input, { idempotencyKey: 'op-key-pg' });
    const second = await writes.createExpense(H, input, { idempotencyKey: 'op-key-pg' });
    expect(second.id).toBe(first.id);
    expect(recorded.filter((q) => q.text.startsWith('INSERT INTO transactions'))).toHaveLength(1);
  });

  it('canonical store conflicts on same key with different payload', async () => {
    const { pool } = makeKeyedFakePool();
    const writes = createPostgresWriteStore({ pool });
    const input = { description: 'Lunch', amountCents: 1000, date: '2026-06-10', accountId: 'acc-1', categoryId: 'cat-1' };
    await writes.createExpense(H, input, { idempotencyKey: 'op-key-pg-conflict' });
    await expect(
      writes.createExpense(H, { ...input, amountCents: 9999 }, { idempotencyKey: 'op-key-pg-conflict' }),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('legacy store (production VPS path) replays without a second transaction INSERT', async () => {
    const { pool, recorded } = makeKeyedFakePool();
    const writes = createLegacyPostgresWriteStore({ pool });
    const input = { description: 'Lunch', amountCents: 1000, date: '2026-06-10', accountId: 'acc-1', categoryId: 'cat-1' };
    const first = await writes.createExpense(H, input, { idempotencyKey: 'op-key-legacy' });
    const second = await writes.createExpense(H, input, { idempotencyKey: 'op-key-legacy' });
    expect(second.id).toBe(first.id);
    expect(recorded.filter((q) => q.text.startsWith('INSERT INTO transactions'))).toHaveLength(1);
  });
});
