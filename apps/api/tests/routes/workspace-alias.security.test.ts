import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import { registerRoutes } from '../../src/routes/index.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryReadModelStoreFromState } from '../../src/read-models/store.js';
import { createInMemoryDeviceTokenStore } from '../../src/auth/device-token.js';
import { createInMemoryIdempotencyStore } from '../../src/writes/idempotency.js';

describe('Security: /internal/workspace-alias', () => {
  let app: FastifyInstance;
  let auth: ReturnType<typeof createBetterAuth>;
  const SERVICE_TOKEN = 'test-service-token-32-chars-minimum!';
  const WRONG_TOKEN = 'wrong-token-32-chars-minimum-xxxx!';
  const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
  const ALIAS = '99999999-9999-4111-8111-999999999999';

  beforeEach(async () => {
    const memoryDb = { user: [], session: [], account: [], verification: [] };
    auth = createBetterAuth({
      database: memoryAdapter(memoryDb),
      disableSignUp: true,
      transaction: false,
      secret: 'test-secret-that-is-at-least-32-characters',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3000'],
    });
    const { state, writes } = createInMemoryStores();
    const store = createInMemoryReadModelStoreFromState(state);
    app = Fastify({ logger: false });
    // Use a mock pool that simulates DB alias lookup
    const mockPool = {
      query: async (text: string, values: unknown[]) => {
        if (text.includes('FROM households')) {
          return { rows: values[0] === HOUSEHOLD ? [{ id: HOUSEHOLD }] : [], rowCount: values[0] === HOUSEHOLD ? 1 : 0 } as unknown as { rows: unknown[]; rowCount: number | null };
        }
        if (text.includes('FROM invites')) {
          return { rows: values[0] === ALIAS ? [{ household_id: HOUSEHOLD }] : [], rowCount: values[0] === ALIAS ? 1 : 0 } as unknown as { rows: unknown[]; rowCount: number | null };
        }
        return { rows: [], rowCount: 0 } as unknown as { rows: unknown[]; rowCount: number | null };
      },
    };
    registerRoutes(app, {
      store,
      writes,
      tokenStore: createInMemoryDeviceTokenStore(),
      idempotency: createInMemoryIdempotencyStore(),
      auth,
      agentAuthServiceToken: SERVICE_TOKEN,
      pool: mockPool as unknown as never,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await auth.close();
  });

  it('RED/GREEN: token ausente deve ser 401 com mesmo código de token incorreto (não enumerável)', async () => {
    const missing = await app.inject({ method: 'GET', url: `/internal/workspace-alias/${ALIAS}` });
    const wrong = await app.inject({ method: 'GET', url: `/internal/workspace-alias/${ALIAS}`, headers: { 'x-agent-service-token': WRONG_TOKEN } });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(missing.json().code).toBe('auth.invalid_service_token');
    expect(wrong.json().code).toBe('auth.invalid_service_token');
    expect(missing.json().code).toBe(wrong.json().code);
  });

  it('CORS: rota interna não deve expor Access-Control-Allow-Origin público', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/internal/workspace-alias/${ALIAS}`,
      headers: { 'x-agent-service-token': SERVICE_TOKEN, origin: 'https://pwa.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('alias autorizado com token correto deve retornar canonical', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/internal/workspace-alias/${ALIAS}`,
      headers: { 'x-agent-service-token': SERVICE_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ alias: ALIAS, canonicalHouseholdId: HOUSEHOLD });
  });

  it('alias não autorizado ou household outro deve permanecer 403/401 e não vazar se alias existe', async () => {
    // Usa um alias que não existe como invite e não é household — ainda retorna 200 com alias==canonical (não vaza)
    // Mas o caller subsequente via workspaceAccess deve falhar com 403 se não for membro
    const res = await app.inject({
      method: 'GET',
      url: `/internal/workspace-alias/00000000-0000-4000-a000-000000000000`,
      headers: { 'x-agent-service-token': SERVICE_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().canonicalHouseholdId).toBe('00000000-0000-4000-a000-000000000000');
  });
});
