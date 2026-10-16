import Fastify from 'fastify';
import { describe, expect, it, afterAll } from 'vitest';
import {
  createInMemoryPendingOperationV2Store,
  type PendingIdentity,
} from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';

/**
 * Issue #201 — expiradas continuam listadas como acionáveis.
 *
 * `listActive` (base do active-list do Agent e dos cards do PWA) nunca
 * filtrava `expires_at`: propostas vencidas há semanas seguiam aparecendo
 * como "Confirma?" — e confirmar devolvia `approval.expired`.
 *
 * Contrato exigido (transição preguiçosa, mesma semântica do confirm):
 * vencer ⇒ some da lista E a linha é marcada `expired` (com evento de
 * auditoria). Idempotente, sem efeito financeiro.
 */

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const expenseArgs = () => ({
  description: 'Mercado semanal',
  amountCents: 8500,
  date: '2026-09-14',
  accountId: crypto.randomUUID(),
  categoryId: crypto.randomUUID(),
});

const ALL = [
  'financial.approval.propose',
  'financial.approval.read',
  'financial.approval.confirm',
  'financial.approval.execute',
  'financial.approval.retry',
  'financial.approval.cancel',
];

const scopedApp = (identity: { workspace: string; actor: string; device: string }) => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = {
      iss: 'pi-agent', aud: 'pi-finance-api', sub: identity.actor, workspace: identity.workspace,
      role: 'owner', capabilities: ALL, jti: crypto.randomUUID(), request: 'r',
      deviceId: identity.device, iat: 1, exp: 301,
    };
    request.authenticatedContext = {
      householdId: identity.workspace, actorId: identity.actor, authUserId: identity.actor,
      actorType: 'user', deviceId: identity.device, role: 'owner',
    };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }),
    v2Store,
    v2Only: true,
  });
  return { app, v2Store };
};

describe('listActive expira preguiçosamente (issue #201)', () => {
  it('proposta vencida some da lista e é marcada expired (in-memory)', async () => {
    const id = { workspace: 'ws-exp', actor: 'actor-a', device: 'device-a' };
    const { app, v2Store } = scopedApp(id);
    const identity: PendingIdentity = { workspaceId: id.workspace, actorId: id.actor, deviceId: id.device };

    const propose = await app.inject({
      method: 'POST', url: '/pending-operations/v2/propose',
      headers: { 'idempotency-key': 'lazy-expiry-1' },
      payload: {
        tool: 'transactions.expense.create',
        normalizedArgs: expenseArgs(),
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      },
    });
    expect(propose.statusCode).toBe(201);
    const opId = (propose.json() as { id: string }).id;

    // Visível enquanto válida.
    expect((await app.inject({ method: 'GET', url: '/pending-operations/v2/active' })).json().total).toBe(1);

    // Vence o TTL curto.
    await new Promise((resolve) => setTimeout(resolve, 2200));

    // Some da lista...
    const listed = await app.inject({ method: 'GET', url: '/pending-operations/v2/active' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().total).toBe(0);
    // ...E a transição fica registrada (não só filtrada): evento expire
    // de auditoria para a operação, sem nenhum confirm/execute.
    const expiredEvents = v2Store.audit.filter((e) => e.operationId === opId && e.event === 'expire');
    expect(expiredEvents.length).toBeGreaterThan(0);
    void identity;
  }, 15000);
});

// Real Postgres integration — gated by DATABASE_URL_TEST + DB_TEST_MARKER.
const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;

describe('listActive expira preguiçosamente em PG real (issue #201)', () => {
  let pool: import('pg').Pool | undefined;
  const createdWorkspaces = new Set<string>();

  afterAll(async () => {
    if (!pool) return;
    for (const ws of createdWorkspaces) {
      await pool.query(`DELETE FROM pending_operations WHERE workspace_id = $1`, [ws]).catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  });

  itIfDatabase('linha vencida some da lista e é marcada expired', async () => {
    const { Pool: PgPool } = await import('pg');
    const { createPostgresPendingOperationV2Store } = await import('../../src/approvals/pending-v2.js');
    pool = new PgPool({ connectionString: DB_URL }) as import('pg').Pool;
    const store = createPostgresPendingOperationV2Store(pool);
    const ws = crypto.randomUUID();
    createdWorkspaces.add(ws);
    const identity = { workspaceId: ws, actorId: 'actor-a', deviceId: 'device-a' };
    const key = `lazy-exp-${ws}`;

    await pool.query(
      `INSERT INTO pending_operations (workspace_id, requester_id, operation, payload, reason, idempotency_key, status, expires_at, protocol_version, actor_id, device_id, tool, normalized_args, proposal_hash, execution_status)
       VALUES ($1, $2, 'transactions.expense.create', '{}'::jsonb, 'high_value', $3, 'pending', NOW() - INTERVAL '1 hour', 2, 'actor-a', 'device-a', 'transactions.expense.create', '{}'::jsonb, $4, 'proposed')`,
      [ws, 'actor-a', key, '0'.repeat(64)],
    );

    const listed = await store.listActive(identity);
    expect(listed.filter((r) => r.idempotencyKey === key)).toHaveLength(0);

    const row = await pool.query(`SELECT execution_status FROM pending_operations WHERE workspace_id = $1 AND idempotency_key = $2`, [ws, key]);
    expect(row.rows[0]?.['execution_status']).toBe('expired');
  });
});
