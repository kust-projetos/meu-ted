/**
 * P3 — full backend flow with the REAL A4 broker and the REAL delegated-token
 * verifier (synthetic API/store, no Postgres, no network):
 *
 *   proposal intent → Agent broker mints `financial.approval.propose`
 *   → API Pending V2 (zero ledger rows) → authoritative active card
 *   → authenticated confirm/execute → EXACTLY one row + receipt.
 *
 * Also proves rejection = zero rows, redelivery = same operation, and another
 * workspace can never confirm.
 */
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import {
  createDelegatedTokenForTest,
  verifyDelegatedTurnToken,
} from '../../src/auth/delegated-token.js';
import type { PendingExecutor } from '../../src/approvals/pending.js';
import type { ReadModelStore } from '../../src/read-models/store.js';
import { proposeExpenseFromIntent } from '../../../agent/src/mutations/pending-proposal-broker.js';

const SECRET = 'test-delegation-secret-32-chars-min!!';
const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = 'actor-a';
const DEVICE = 'device-a';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '22222222-2222-4222-8222-222222222222';
const API_ORIGIN = 'https://api.example.test';

type LedgerRow = { operationId: string; amountCents: number; description: string };

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const readModel = {
  listAccounts: async () => [{ id: ACCOUNT, name: 'Nubank' }],
  listCategories: async () => [{ id: CATEGORY, name: 'Mercado' }],
} as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;

const fakeExecutor = (ledger: LedgerRow[]): PendingExecutor =>
  (async (operation: { id: string; normalizedArgs: Record<string, unknown> }) => {
    if (!ledger.some((row) => row.operationId === operation.id)) {
      ledger.push({
        operationId: operation.id,
        amountCents: operation.normalizedArgs.amountCents as number,
        description: operation.normalizedArgs.description as string,
      });
    }
    return {
      status: 'succeeded' as const,
      operationId: crypto.randomUUID(),
      receipt: {
        mutationId: crypto.randomUUID(),
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts'],
        operationId: operation.id,
        entity: { type: 'transaction', id: crypto.randomUUID() },
      },
    };
  }) as unknown as PendingExecutor;

async function apiApp(ledger: LedgerRow[]): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('preHandler', async (request, reply) => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ code: 'auth.invalid_token' });
    }
    try {
      const claims = await verifyDelegatedTurnToken(header.slice('Bearer '.length).trim(), SECRET);
      request.delegatedTurn = claims;
      request.authenticatedContext = {
        householdId: claims.workspace,
        actorId: claims.sub,
        authUserId: claims.sub,
        actorType: 'user',
        deviceId: claims.deviceId ?? '',
        role: claims.role,
      };
    } catch {
      return reply.code(401).send({ code: 'auth.invalid_token' });
    }
  });
  registerPendingOperationRoutes(app, {
    store: legacyStore,
    resolveToken: async () => ({ householdId: WS_A, deviceId: DEVICE }),
    v2Store: createInMemoryPendingOperationV2Store(),
    v2Executor: fakeExecutor(ledger),
    v2Only: true,
    readModel,
  });
  await app.ready();
  return app;
}

const forwardTo = (app: FastifyInstance) =>
  (async (url: unknown, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${parsed.pathname}${parsed.search}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

const token = (workspaceId: string, capabilities: string[], requestId: string) =>
  createDelegatedTokenForTest(
    {
      actorId: ACTOR,
      workspaceId,
      role: 'owner',
      deviceId: DEVICE,
      capabilities,
      requestId,
    },
    SECRET,
  );

const intent = (intentionId: string) => ({
  tool: 'transactions.expense.create' as const,
  intentionId,
  normalizedArgs: {
    amountCents: 5000,
    description: 'mercado',
    date: '2026-11-06',
    accountId: ACCOUNT,
    categoryId: CATEGORY,
  },
});

describe('P3 — intent → broker → Pending V2 → confirm (real verifier, synthetic store)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('writes zero rows until confirmation, then exactly one + receipt', async () => {
    const ledger: LedgerRow[] = [];
    const app = await apiApp(ledger);
    globalThis.fetch = forwardTo(app);
    const identity = { workspaceId: WS_A, actorId: ACTOR, deviceId: DEVICE, role: 'owner' as const };

    const proposed = await proposeExpenseFromIntent({ intent: intent('int-1'), identity, secret: SECRET, apiOrigin: API_ORIGIN });
    expect(proposed.existing).toBe(false);
    expect(ledger).toHaveLength(0);

    const active = await app.inject({
      method: 'GET',
      url: '/pending-operations/v2/active',
      headers: { authorization: `Bearer ${await token(WS_A, ['financial.approval.read'], 'read-1')}` },
    });
    expect(active.statusCode).toBe(200);
    const items = active.json().items as Array<{ id: string; amountCents: number; presentation?: unknown }>;
    expect(items.map((item) => item.id)).toContain(proposed.id);
    expect(items.find((item) => item.id === proposed.id)?.amountCents).toBe(5000);
    expect(ledger).toHaveLength(0);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${proposed.id}/confirm`,
      headers: { authorization: `Bearer ${await token(WS_A, ['financial.approval.confirm'], 'confirm-1')}` },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(typeof confirmed.json().attestation).toBe('string');
    expect(ledger).toHaveLength(0);

    const executed = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${proposed.id}/execute`,
      headers: { authorization: `Bearer ${await token(WS_A, ['financial.approval.execute'], 'confirm-1')}` },
      payload: { attestation: confirmed.json().attestation },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe('succeeded');
    expect(ledger).toEqual([{ operationId: proposed.id, amountCents: 5000, description: 'mercado' }]);
    const receipt = executed.json().execution?.receipt ?? executed.json().receipt;
    expect(receipt.mutationKind).toBe('transactions.expense.create');
  });

  it('rejection writes zero rows', async () => {
    const ledger: LedgerRow[] = [];
    const app = await apiApp(ledger);
    globalThis.fetch = forwardTo(app);
    const identity = { workspaceId: WS_A, actorId: ACTOR, deviceId: DEVICE, role: 'owner' as const };

    const proposed = await proposeExpenseFromIntent({ intent: intent('int-cancel'), identity, secret: SECRET, apiOrigin: API_ORIGIN });
    const cancelled = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${proposed.id}/cancel`,
      headers: { authorization: `Bearer ${await token(WS_A, ['financial.approval.cancel'], 'cancel-1')}` },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect(ledger).toHaveLength(0);
  });

  it('a redelivered intent replays the same operation (no duplicate)', async () => {
    const ledger: LedgerRow[] = [];
    const app = await apiApp(ledger);
    globalThis.fetch = forwardTo(app);
    const identity = { workspaceId: WS_A, actorId: ACTOR, deviceId: DEVICE, role: 'owner' as const };

    const first = await proposeExpenseFromIntent({ intent: intent('int-replay'), identity, secret: SECRET, apiOrigin: API_ORIGIN });
    const second = await proposeExpenseFromIntent({ intent: intent('int-replay'), identity, secret: SECRET, apiOrigin: API_ORIGIN });
    expect(second.id).toBe(first.id);
    expect(second.existing).toBe(true);
    expect(ledger).toHaveLength(0);
  });

  it('a foreign workspace cannot confirm the proposal', async () => {
    const ledger: LedgerRow[] = [];
    const app = await apiApp(ledger);
    globalThis.fetch = forwardTo(app);

    const proposed = await proposeExpenseFromIntent({
      intent: intent('int-cross'),
      identity: { workspaceId: WS_A, actorId: ACTOR, deviceId: DEVICE, role: 'owner' },
      secret: SECRET,
      apiOrigin: API_ORIGIN,
    });
    const foreign = await app.inject({
      method: 'POST',
      url: `/pending-operations/v2/${proposed.id}/confirm`,
      headers: { authorization: `Bearer ${await token(WS_B, ['financial.approval.confirm'], 'cross-1')}` },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().code).toBe('approval.forbidden');
    expect(ledger).toHaveLength(0);
  });
});
