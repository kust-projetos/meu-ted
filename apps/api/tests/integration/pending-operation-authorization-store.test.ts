import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresPendingOperationV2Store, type PendingIdentity, type PendingOperationV2Store } from '../../src/approvals/pending-v2.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const MARKER = process.env.DB_TEST_MARKER;
const describeIfDb = DB_URL && MARKER ? describe : describe.skip;
let pool: Pool | undefined;
let store: PendingOperationV2Store;
const operationIds: string[] = [];
const identity: PendingIdentity = { workspaceId: randomUUID(), actorId: randomUUID(), deviceId: randomUUID() };
const expenseArgs = () => ({ description: 'Postgres authorization test', amountCents: 3499, date: '2026-10-02', accountId: randomUUID(), categoryId: randomUUID() });

const propose = async (amountCents = 3499) => {
  const normalizedArgs = { ...expenseArgs(), amountCents };
  const base = { version: 2 as const, ...identity, tool: 'transactions.expense.create', normalizedArgs, proposalHash: '', idempotencyKey: randomUUID(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), bindings: identity };
  const saved = await store.propose({ ...base, proposalHash: await computePendingOperationV2Hash(base) });
  operationIds.push(saved.id);
  return saved;
};

describeIfDb('PendingOperation V2 authorization store (Postgres)', () => {
  beforeAll(async () => {
    if (!DB_URL || !MARKER) return;
    pool = createPool({ connectionString: DB_URL, max: 4 });
    await requireTestDatabase(pool, 'pending-operation-authorization-store');
    await runMigrations(pool);
    store = createPostgresPendingOperationV2Store(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool && operationIds.length) await pool.query('DELETE FROM pending_operations WHERE id = ANY($1::uuid[])', [operationIds]);
    await pool?.end();
  });

  it('authorizes and executes once; persists automatic, explicit manual, and default manual metadata', async () => {
    const auto = await propose();
    const issued = await store.authorize(auto.id, identity, { mode: 'auto', reason: 'explicit_low_risk', riskTier: 'low' });
    expect(issued.status).toBe('confirmed'); expect(issued.attestation).toBeTruthy();
    const row = await pool!.query('SELECT execution_status, authorization_mode, authorization_reason, risk_tier, authorized_at, attestation_hash FROM pending_operations WHERE id=$1', [auto.id]);
    expect(row.rows[0]).toMatchObject({ execution_status: 'confirmed', authorization_mode: 'auto', authorization_reason: 'explicit_low_risk', risk_tier: 'low' });
    expect(row.rows[0]?.authorized_at).toBeInstanceOf(Date); expect(row.rows[0]?.attestation_hash).toBeTruthy();
    let effects = 0;
    const executor = async () => { effects += 1; return { status: 'succeeded', operationId: randomUUID() }; };
    expect((await store.execute(issued.attestation!, identity, executor, auto.id)).status).toBe('succeeded');
    await expect(store.execute(issued.attestation!, identity, executor, auto.id)).rejects.toMatchObject({ code: 'approval.attestation_replayed', statusCode: 403 });
    expect(effects).toBe(1);

    const manual = await propose(50000);
    await store.confirm(manual.id, identity, { mode: 'manual', reason: 'high_value', riskTier: 'high' });
    const manualRow = await pool!.query('SELECT authorization_mode, authorization_reason, risk_tier, authorized_at FROM pending_operations WHERE id=$1', [manual.id]);
    expect(manualRow.rows[0]).toMatchObject({ authorization_mode: 'manual', authorization_reason: 'high_value', risk_tier: 'high' });
    expect(manualRow.rows[0]?.authorized_at).toBeInstanceOf(Date);

    const defaultManual = await propose(50000);
    await store.confirm(defaultManual.id, identity);
    const defaultRow = await pool!.query('SELECT authorization_mode, authorization_reason, risk_tier, authorized_at FROM pending_operations WHERE id=$1', [defaultManual.id]);
    expect(defaultRow.rows[0]).toMatchObject({ authorization_mode: 'manual', authorization_reason: 'policy_required', risk_tier: null });
    expect(defaultRow.rows[0]?.authorized_at).toBeInstanceOf(Date);
  }, 30_000);

  it('fails closed for non-proposed/foreign operations and retry preserves authorization columns', async () => {
    const confirmed = await propose();
    await store.confirm(confirmed.id, identity, { mode: 'manual', reason: 'high_value', riskTier: 'high' });
    await expect(store.authorize(confirmed.id, identity, { mode: 'auto', reason: 'explicit_low_risk', riskTier: 'low' })).rejects.toMatchObject({ code: 'approval.not_pending' });
    await expect(store.authorize(confirmed.id, { ...identity, workspaceId: randomUUID() }, { mode: 'auto', reason: 'explicit_low_risk', riskTier: 'low' })).rejects.toMatchObject({ code: 'approval.not_found', statusCode: 404 });
    const initial = await pool!.query('SELECT authorization_mode, authorization_reason, risk_tier, authorized_at FROM pending_operations WHERE id=$1', [confirmed.id]);
    await expect(store.execute((await store.confirm(confirmed.id, identity)).attestation!, identity, async () => { throw new Error('expected retryable error'); }, confirmed.id)).rejects.toThrow('expected retryable error');
    expect((await store.get(confirmed.id, identity)).status).toBe('failed');
    await store.retry(confirmed.id, identity);
    const afterRetry = await pool!.query('SELECT authorization_mode, authorization_reason, risk_tier, authorized_at FROM pending_operations WHERE id=$1', [confirmed.id]);
    expect(afterRetry.rows[0]).toEqual(initial.rows[0]);
  }, 30_000);
});
