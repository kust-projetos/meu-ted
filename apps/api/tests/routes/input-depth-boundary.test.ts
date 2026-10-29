import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import type { ReadModelStore } from '../../src/read-models/store.js';

/**
 * Fase E: estruturas profundas / payload volumoso antes de processamento caro.
 *
 * - POST /client-events executa o scan recursivo de privacidade
 *   (assertPrivacy, em `audit/events.ts`) ANTES do allowlist barato — um
 *   payload profundo/volumoso paga o scan completo antes da rejeição.
 * - POST /pending-operations/v2/propose valida o envelope
 *   `z.record(z.string(), z.unknown())` e depois o contrato strict do
 *   registry ANTES de hash/read-model/store.
 *
 * Cada probe abaixo fixa o comportamento fail-closed (4xx com o `code` da
 * camada pretendida — nunca 500) para entradas profundas/volumosas.
 */
const auth = { 'x-device-token': TOKEN_A };

const deepJsonString = (depth: number): string => {
  let inner = '1';
  for (let i = 0; i < depth; i++) inner = `{"k":${inner}}`;
  return `{"eventType":"mic.error","payload":{"reason":"denied","capability":"on","deep":${inner}}}`;
};

const wideClientPayload = (keys: number): Record<string, unknown> => {
  const payload: Record<string, unknown> = { reason: 'denied', capability: 'on' };
  for (let i = 0; i < keys; i++) payload[`pad${i}`] = i;
  return payload;
};

describe('Fase E boundary: deep/voluminous input fails closed before expensive work', () => {
  it('control: valid accounts.update rename proposes 201 (harness reaches the store)', async () => {
    const { app } = buildProposeApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/pending-operations/v2/propose',
        headers: { 'idempotency-key': 'fase-e-control' },
        payload: { tool: 'accounts.update', normalizedArgs: validRenameArgs() },
      });
      expect(response.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('client-events: deeply nested extra payload is rejected by the event contract (never 500)', async () => {
    const { app } = buildTestApp();
    try {
      for (const depth of [2000, 8000]) {
        const response = await app.inject({
          method: 'POST',
          url: '/client-events',
          headers: { ...auth, 'content-type': 'application/json' },
          payload: deepJsonString(depth),
        });
        // Intended path: parsed by Fastify, scanned by assertPrivacy (keys
        // 'k'/values 1 carry no forbidden content), rejected by the strict
        // per-event allowlist on the unknown 'deep' field.
        expect(response.statusCode, `depth=${depth}`).toBe(400);
        expect(response.json().code, `depth=${depth}`).toBe('observability.privacy_violation');
      }
      // Same overflow class through a KNOWN field: the privacy scan runs
      // before the per-field type validators, so a deep 'reason' must also
      // fail closed (never 500).
      let inner = '1';
      for (let i = 0; i < 8000; i++) inner = `{"k":${inner}}`;
      const knownDeep = await app.inject({
        method: 'POST',
        url: '/client-events',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: `{"eventType":"mic.error","payload":{"reason":${inner},"capability":"on"}}`,
      });
      expect(knownDeep.statusCode, 'known-field depth=8000').toBe(400);
      expect(knownDeep.json().code, 'known-field depth=8000').toBe('observability.privacy_violation');
    } finally {
      await app.close();
    }
  });

  it('client-events: wide extra payload is rejected by the event contract (never 500)', async () => {
    const { app } = buildTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/client-events',
        headers: auth,
        payload: { eventType: 'mic.error', payload: wideClientPayload(20000) },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('observability.privacy_violation');
    } finally {
      await app.close();
    }
  });

  it('propose: deeply nested normalizedArgs is rejected by the tool contract (never 500)', async () => {
    const { app } = buildProposeApp();
    try {
      let inner: unknown = 1;
      for (let i = 0; i < 2000; i++) inner = { k: inner };
      const response = await app.inject({
        method: 'POST',
        url: '/pending-operations/v2/propose',
        headers: { 'idempotency-key': 'fase-e-deep' },
        // accounts.update carries a strict registry schema: the unknown
        // 'deep' field must fail closed here — before hash, read-model gate
        // and store. (transactions.expense.create is non-strict/strip and
        // would accept with the junk dropped — a different contract.)
        payload: {
          tool: 'accounts.update',
          normalizedArgs: { ...validRenameArgs(), deep: inner },
        },
      });
      // Intended path: envelope parse accepts (z.unknown), the strict
      // per-tool registry schema rejects the unknown 'deep' field — before
      // hash, read-model and store.
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('approval.invalid_args');
    } finally {
      await app.close();
    }
  });

  it('propose: wide normalizedArgs is rejected by the tool contract (never 500)', async () => {
    const { app } = buildProposeApp();
    try {
      const normalizedArgs: Record<string, unknown> = { ...validRenameArgs() };
      for (let i = 0; i < 20000; i++) normalizedArgs[`pad${i}`] = i;
      const response = await app.inject({
        method: 'POST',
        url: '/pending-operations/v2/propose',
        headers: { 'idempotency-key': 'fase-e-wide' },
        payload: { tool: 'accounts.update', normalizedArgs },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('approval.invalid_args');
    } finally {
      await app.close();
    }
  });

  it('propose: non-strict expense contract drops deep junk before hashing (never 500)', async () => {
    const { app } = buildProposeApp();
    try {
      let inner: unknown = 1;
      for (let i = 0; i < 2000; i++) inner = { k: inner };
      const response = await app.inject({
        method: 'POST',
        url: '/pending-operations/v2/propose',
        headers: { 'idempotency-key': 'fase-e-strip' },
        payload: {
          tool: 'transactions.expense.create',
          normalizedArgs: {
            description: 'Mercado semanal',
            amountCents: 8500,
            date: '2026-09-14',
            accountId: GATE_ACCOUNT_ID,
            categoryId: GATE_CATEGORY_ID,
            deep: inner,
          },
        },
      });
      // Pre-existing strip contract (not strict): unknown fields are dropped
      // by Zod without traversal, so the deep value never reaches the hash,
      // read-model or store — the proposal persists clean.
      expect(response.statusCode).toBe(201);
      expect(JSON.stringify(response.json())).not.toContain('"deep"');
    } finally {
      await app.close();
    }
  });
});

const GATE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const GATE_CATEGORY_ID = '22222222-2222-4222-8222-222222222222';

const validRenameArgs = () => ({
  accountId: GATE_ACCOUNT_ID,
  name: 'Conta Renomeada',
  expectedName: 'Conta Teste',
});

const legacyStore = {
  async get() { return null; }, async list() { return []; }, async findByChatId() { return null; },
  async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); },
  async reject() { throw new Error('unused'); },
};

const buildProposeApp = (): { app: FastifyInstance } => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: 'a', workspace: 'w', role: 'owner', capabilities: ['financial.approval.propose'], jti: crypto.randomUUID(), request: 'r', deviceId: 'd', iat: 1, exp: 301 };
    request.authenticatedContext = { householdId: 'w', actorId: 'a', authUserId: 'a', actorType: 'user', deviceId: 'd', role: 'owner' };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  const readModel = {
    listAccounts: async () => [{ id: GATE_ACCOUNT_ID, name: 'Conta Teste' }],
    listCategories: async () => [{ id: GATE_CATEGORY_ID, name: 'Categoria Teste' }],
  } as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;
  registerPendingOperationRoutes(app, { store: legacyStore, resolveToken: async () => ({ householdId: 'w', deviceId: 'd' }), v2Store, v2Only: true, readModel });
  return { app };
};
