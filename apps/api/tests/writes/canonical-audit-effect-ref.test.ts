import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresIdempotencyStore } from '../../src/writes/postgres.js';

const TX_ID = '11111111-1111-4111-8111-111111111111';
const ACCT_ID = '22222222-2222-4222-8222-222222222222';
const CAT_ID = '33333333-3333-4333-8333-333333333333';

type Captured = { text: string; values?: unknown[] };

const makeFakePool = (captured: Captured[], recordId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') => {
  const client = {
    async query(text: string, values?: unknown[]) {
      captured.push({ text, values });
      if (text.includes('INSERT INTO operation_records')) {
        return { rowCount: 1, rows: [{ id: recordId, status: 'processing', response: null, effect_ref: null }] };
      }
      if (text.includes('UPDATE operation_records')) return { rowCount: 1, rows: [] };
      if (text.includes('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
      if (text.startsWith('SELECT id, status')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
};

const expenseResponse = () => ({
  status: 201,
  body: {
    id: TX_ID,
    householdId: '99999999-9999-4999-8999-999999999999',
    kind: 'expense',
    receipt: {
      mutationId: '44444444-4444-4444-8444-444444444444',
      mutationKind: 'transaction.create',
      status: 'succeeded',
      affectedTargets: ['transactions'],
      entity: { type: 'transaction', id: TX_ID },
    },
  },
});

describe('canonical audit effect_ref — RED: HTTP receipt must bind the entity', () => {
  it('binds effect_ref from the committed canonical body receipt (expense)', async () => {
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured) });
    await store.lookupOrRecord(
      {
        workspaceId: '99999999-9999-4999-8999-999999999999',
        actorType: 'device',
        actorId: 'device-1',
        operation: 'transactions.expense.create',
        key: 'k-expense-1',
      },
      { seed: 'red' },
      async () => expenseResponse() as never,
    );
    const update = captured.find((c) => c.text.includes('UPDATE operation_records'));
    expect(update).toBeDefined();
    // values: [recordId, householdId, responseJson, effectRef]
    expect(update!.values?.[3]).toBe(TX_ID);
    const audit = captured.find((c) => c.text.includes('INSERT INTO audit_logs'));
    expect(audit).toBeDefined();
    // values: [id, recordId, household, actor, operation, payloadHash, effectRef, metadata]
    expect(audit!.values?.[6]).toBe(TX_ID);
  });

  it('binds account and category receipts too', async () => {
    for (const [operation, id, kind, type] of [
      ['accounts.create', ACCT_ID, 'account.create', 'account'],
      ['categories.create', CAT_ID, 'category.create', 'category'],
    ] as const) {
      const captured: Captured[] = [];
      const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured) });
      await store.lookupOrRecord(
        {
          workspaceId: '99999999-9999-4999-8999-999999999999',
          actorType: 'device',
          actorId: 'device-1',
          operation,
          key: `k-${id}`,
        },
        { seed: 'red' },
        async () =>
          ({
            status: 201,
            body: {
              id,
              receipt: {
                mutationId: '44444444-4444-4444-8444-444444444444',
                mutationKind: kind,
                status: 'succeeded',
                affectedTargets: ['accounts'],
                entity: { type, id },
              },
            },
          }) as never,
      );
      const audit = captured.find((c) => c.text.includes('INSERT INTO audit_logs'));
      expect(audit!.values?.[6]).toBe(id);
    }
  });

  it('refuses mismatched receipt ids (no fake binding)', async () => {
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured) });
    await store.lookupOrRecord(
      {
        workspaceId: '99999999-9999-4999-8999-999999999999',
        actorType: 'device',
        actorId: 'device-1',
        operation: 'transactions.expense.create',
        key: 'k-mismatch',
      },
      { seed: 'red' },
      async () =>
        ({
          status: 201,
          body: {
            id: TX_ID,
            receipt: {
              mutationId: '44444444-4444-4444-8444-444444444444',
              mutationKind: 'transaction.create',
              status: 'succeeded',
              affectedTargets: ['transactions'],
              entity: { type: 'transaction', id: ACCT_ID },
            },
          },
        }) as never,
    );
    const audit = captured.find((c) => c.text.includes('INSERT INTO audit_logs'));
    expect(audit!.values?.[6]).toBeNull();
  });

  it('preserves the legacy transactionId contract', async () => {
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured) });
    await store.lookupOrRecord(
      {
        workspaceId: '99999999-9999-4999-8999-999999999999',
        actorType: 'device',
        actorId: 'device-1',
        operation: 'transactions.expense.create',
        key: 'k-legacy',
      },
      { seed: 'red' },
      async () => ({ transactionId: TX_ID }) as never,
    );
    const audit = captured.find((c) => c.text.includes('INSERT INTO audit_logs'));
    expect(audit!.values?.[6]).toBe(TX_ID);
  });
});

// ---------------------------------------------------------------------------
// audit.operation derivation — RED: a default-'write' claim over a verified
// canonical receipt must persist the reversible operation vocabulary so the
// undo preview/eligibility (REVERSIBLE_OPERATIONS) finds its target.
// ---------------------------------------------------------------------------

const HOUSEHOLD = '99999999-9999-4999-8999-999999999999';

const keyedResponse = (kind: string, id: string, type: string, bodyKind?: string) => ({
  status: 201,
  body: {
    id,
    ...(bodyKind ? { kind: bodyKind } : {}),
    receipt: {
      mutationId: '44444444-4444-4444-8444-444444444444',
      mutationKind: kind,
      status: 'succeeded',
      affectedTargets: ['transactions'],
      entity: { type, id },
    },
  },
});

const canonicalAuditValues = (captured: Captured[]) =>
  captured.find((c) => c.text.includes('INSERT INTO audit_logs') && c.text.includes('operation_record_id'))!.values!;

const legacyAuditValues = (captured: Captured[]) =>
  captured.find((c) => c.text.includes('INSERT INTO audit_logs') && c.text.includes('household_id'))!.values!;

describe('canonical audit.operation derivation (undo eligibility)', () => {
  it.each([
    ['transaction.create', TX_ID, 'transaction', 'expense', 'transactions.expense.create'],
    ['transaction.create', TX_ID, 'transaction', 'income', 'transactions.income.create'],
    ['transfer.create', TX_ID, 'transaction', 'transfer', 'transactions.transfer.create'],
    ['account.create', ACCT_ID, 'account', undefined, 'accounts.create'],
    ['category.create', CAT_ID, 'category', undefined, 'categories.create'],
  ] as const)('maps receipt %s to audit operation %s (string-form default claim)', async (kind, id, type, bodyKind, expectedOp) => {
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured) });
    await store.lookupOrRecord(
      HOUSEHOLD,
      `k-op-${kind}-${bodyKind ?? 'na'}`,
      { route: 'POST /x', payload: {} },
      async () => keyedResponse(kind, id, type, bodyKind) as never,
    );
    const values = canonicalAuditValues(captured);
    // columns: id, operation_record_id, workspace_id, actor_id, operation, ...
    expect(values[4]).toBe(expectedOp);
    // operation_records keeps the generic claim operation (idempotency compat)
    const update = captured.find((c) => c.text.includes('UPDATE operation_records'))!;
    expect(update.text).toContain('SET status');
  });

  it.each([
    ['transaction.update', TX_ID, 'transaction', 'expense'],
    ['transaction.delete', TX_ID, 'transaction', 'expense'],
    ['account.update', ACCT_ID, 'account', undefined],
    ['account.delete', ACCT_ID, 'account', undefined],
    ['category.delete', CAT_ID, 'category', undefined],
    ['payable.create', TX_ID, 'payable', undefined],
    ['budget.create', TX_ID, 'budget', undefined],
  ] as const)('never promotes %s to a reversible operation (no phantom)', async (kind, id, type, bodyKind) => {
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured) });
    await store.lookupOrRecord(
      HOUSEHOLD,
      `k-nophantom-${kind}`,
      { route: 'POST /x', payload: {} },
      async () => keyedResponse(kind, id, type, bodyKind) as never,
    );
    expect(canonicalAuditValues(captured)[4]).toBe('write');
  });

  it('never alters an explicitly named (TED/structured) operation', async () => {
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured) });
    await store.lookupOrRecord(
      { workspaceId: HOUSEHOLD, actorType: 'device', actorId: 'device-1', operation: 'transactions.expense.create', key: 'k-explicit' },
      { seed: 'x' },
      async () => keyedResponse('transaction.create', TX_ID, 'transaction', 'expense') as never,
    );
    expect(canonicalAuditValues(captured)[4]).toBe('transactions.expense.create');
  });

  it('keeps operation write when the receipt binding is unverified', async () => {
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured) });
    await store.lookupOrRecord(
      HOUSEHOLD,
      'k-unverified',
      { route: 'POST /x', payload: {} },
      async () => ({ status: 201, body: { id: TX_ID } }) as never,
    );
    expect(canonicalAuditValues(captured)[4]).toBe('write');
  });

  it('legacy branch: derives action + binds entity_id, falls back otherwise', async () => {
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured), legacy: true });
    await store.lookupOrRecord(
      HOUSEHOLD,
      'k-legacy-expense',
      { route: 'POST /x', payload: {} },
      async () => keyedResponse('transaction.create', TX_ID, 'transaction', 'expense') as never,
    );
    // legacy columns: id, household_id, user_id, action, entity_id, before, after
    // (entity_type is the 'operation' literal in the SQL text)
    const values = legacyAuditValues(captured);
    expect(values[3]).toBe('transactions.expense.create');
    expect(values[4]).toBe(TX_ID);
  });

  it('legacy branch: non-financial writes keep action write + record entity_id', async () => {
    const recordId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const captured: Captured[] = [];
    const store = createPostgresIdempotencyStore({ pool: makeFakePool(captured, recordId), legacy: true });
    await store.lookupOrRecord(
      HOUSEHOLD,
      'k-legacy-push',
      { route: 'POST /push/subscriptions', payload: {} },
      async () => ({ status: 201, body: { ok: true } }) as never,
    );
    const values = legacyAuditValues(captured);
    expect(values[3]).toBe('write');
    expect(values[4]).toBe(recordId);
  });
});

// ---------------------------------------------------------------------------
// PG-gated end-to-end: keyed canonical create (claim-client producer shaping
// the exact HTTP route response) → audit effect_ref binding → undo restores
// the balance. Test-only, dedicated marker household, no PROD writes.
// ---------------------------------------------------------------------------

import { randomUUID as e2eUUID } from 'node:crypto';
import type { Pool as PgPool, PoolClient as PgClient } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
import { createPostgresAuditLogStore } from '../../src/audit/store.js';
import { createUndoService } from '../../src/approvals/undo.js';
import { attachMutationReceipt } from '../../src/reconciliation/effects-registry.js';

const E2E_DB_URL = process.env.DATABASE_URL_TEST;
const E2E_ENABLED = Boolean(E2E_DB_URL && process.env.DB_TEST_MARKER);
const describeIfPg = E2E_ENABLED ? describe : describe.skip;

if (!E2E_ENABLED) {
  console.log('[canonical-audit-effect-ref] SKIP PG e2e: DATABASE_URL_TEST + DB_TEST_MARKER required.');
}

describeIfPg('canonical audit effect_ref — PG e2e (create → audit bind → undo)', () => {
  let pool: PgPool;
  const households: string[] = [];

  beforeAll(async () => {
    pool = createPool({ connectionString: E2E_DB_URL!, max: 4 });
    await requireTestDatabase(pool, 'canonical-audit-effect-ref-e2e');
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      for (const h of households) {
        await pool.query('DELETE FROM audit_logs WHERE workspace_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM operation_records WHERE workspace_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM transactions WHERE household_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM categories WHERE household_id = $1', [h]).catch(() => undefined);
        await pool.query('DELETE FROM accounts WHERE household_id = $1', [h]).catch(() => undefined);
      }
      await pool.end();
    }
  });

  it('HTTP string-form keyed expense → derived audit op → preview → undo restores balance (no phantom on update)', async () => {
    const householdId = e2eUUID();
    households.push(householdId);
    const actorId = 'e2e-actor';
    const writes = createPostgresWriteStore({ pool });
    const auditStore = createPostgresAuditLogStore(pool);
    const account = await writes.createAccount(householdId, {
      name: `E2E ${e2eUUID().slice(0, 8)}`,
      kind: 'bank',
      initialBalanceCents: 100_000,
    });
    const category = await writes.createCategory(householdId, {
      name: `E2E cat ${e2eUUID().slice(0, 8)}`,
      kind: 'expense',
    });

    const idempotency = createPostgresIdempotencyStore({ pool });
    // HTTP string-form claim (exactly what the routes use): NO explicit
    // operation — the claim persists generic 'write'.
    const createKey = `e2e-${e2eUUID()}`;
    const createEnvelope = { route: 'POST /transactions/expense', payload: { description: 'E2E keyed expense' } };
    const produce = async (claimTx?: unknown) => {
      const tx = await (
        writes as unknown as {
          createExpenseInTx(client: PgClient, householdId: string, input: unknown): Promise<{ id: string }>;
        }
      ).createExpenseInTx(claimTx as PgClient, householdId, {
        description: 'E2E keyed expense',
        amountCents: 12_345,
        date: '2026-09-16',
        accountId: account.id,
        categoryId: category.id,
      });
      return { status: 201, body: attachMutationReceipt(tx, 'transaction.create', { type: 'transaction', id: tx.id }) };
    };

    const first = await idempotency.lookupOrRecord(
      householdId,
      createKey,
      createEnvelope,
      produce as never,
    );
    expect(first.replayed).toBe(false);
    const txId = (first.response as { body: { id: string } }).body.id;

    // operation_records keeps the generic claim (idempotency compat)…
    const records = await pool.query<{ operation: string; effect_ref: string | null; status: string }>(
      'SELECT operation, effect_ref, status FROM operation_records WHERE workspace_id = $1',
      [householdId],
    );
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0]).toMatchObject({ operation: 'write', status: 'completed', effect_ref: txId });

    // …while the AUDIT row carries the derived reversible vocabulary.
    const audits = await pool.query<{ operation: string; effect_ref: string | null; metadata: unknown }>(
      'SELECT operation, effect_ref, metadata FROM audit_logs WHERE workspace_id = $1 AND operation = $2',
      [householdId, 'transactions.expense.create'],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({ operation: 'transactions.expense.create', effect_ref: txId });
    expect(audits.rows[0]!.metadata).toMatchObject({ entityType: 'transaction' });

    // Preview: the new audit row is listed and is undo-eligible.
    const preview = await auditStore.listAuditLogs(householdId, { limit: 10 });
    expect(preview.total).toBe(1);
    expect(preview.items[0]).toMatchObject({ operation: 'transactions.expense.create', effectRef: txId });

    // Idempotency replay: SAME key + SAME payload replays with NO new audit row.
    const second = await idempotency.lookupOrRecord(householdId, createKey, createEnvelope, produce as never);
    expect(second.replayed).toBe(true);
    expect(second.response).toEqual(first.response);
    const auditsAfterReplay = await pool.query('SELECT id FROM audit_logs WHERE workspace_id = $1', [householdId]);
    expect(auditsAfterReplay.rows).toHaveLength(1);

    const spent = await pool.query<{ balance_cents: string }>(
      'SELECT balance_cents FROM accounts WHERE id = $1 AND household_id = $2',
      [account.id, householdId],
    );
    expect(Number(spent.rows[0]!.balance_cents)).toBe(100_000 - 12_345);

    // A later keyed UPDATE (receipt transaction.update) must NOT become reversible.
    const updateProduce = async (claimTx?: unknown) => {
      const updated = await (
        writes as unknown as {
          updateTransactionInTx(client: PgClient, householdId: string, id: string, patch: unknown): Promise<{ id: string }>;
        }
      ).updateTransactionInTx(claimTx as PgClient, householdId, txId, { description: 'E2E updated' });
      return { status: 200, body: attachMutationReceipt(updated, 'transaction.update', { type: 'transaction', id: txId }) };
    };
    await idempotency.lookupOrRecord(
      householdId,
      `e2e-update-${e2eUUID()}`,
      { route: 'PATCH /transactions/:id', payload: { id: txId } },
      updateProduce as never,
    );
    const updateAudit = await pool.query<{ id: string; operation: string; effect_ref: string | null }>(
      'SELECT id, operation, effect_ref FROM audit_logs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1',
      [householdId],
    );
    expect(updateAudit.rows[0]).toMatchObject({ operation: 'write', effect_ref: txId });

    const undo = createUndoService({
      auditLogs: auditStore,
      writes,
      idempotency: createPostgresIdempotencyStore({ pool }),
    });
    // Targeting the update audit directly: nothing reversible → phantom-free.
    await expect(undo.undo(householdId, actorId, `undo-phantom-${e2eUUID()}`, updateAudit.rows[0]!.id)).rejects.toMatchObject({
      code: 'undo.nothing_to_undo',
    });

    // Plain undo targets the expense and restores the balance.
    const result = await undo.undo(householdId, actorId, `undo-${e2eUUID()}`);
    expect(result.undone).toMatchObject({
      operation: 'transactions.expense.create',
      entityId: txId,
      reversal: 'soft_delete',
    });

    const restored = await pool.query<{ balance_cents: string }>(
      'SELECT balance_cents FROM accounts WHERE id = $1 AND household_id = $2',
      [account.id, householdId],
    );
    expect(Number(restored.rows[0]!.balance_cents)).toBe(100_000);
  }, 60_000);
});