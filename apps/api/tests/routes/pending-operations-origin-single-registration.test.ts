import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createPendingOperationV2Executor, registerRoutes } from '../../src/routes/index.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { createInMemoryReadModelStore } from '../../src/read-models/store.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryIdempotencyStore } from '../../src/writes/idempotency.js';
import { createInMemoryDeviceTokenStore } from '../../src/auth/device-token.js';
import { createInMemoryAuditLogStore } from '../../src/audit/store.js';
import { createUndoService } from '../../src/approvals/undo.js';
import { createInMemoryCardStore } from '../../src/cards/in-memory.js';
import { createInMemoryPayableStore } from '../../src/payables/in-memory.js';
import { createInMemoryBudgetStore } from '../../src/budgets/in-memory.js';
import { createInMemoryGoalStore } from '../../src/goals/in-memory.js';
import { createInMemorySubscriptionStore } from '../../src/subscriptions/in-memory.js';
import { createInMemoryProfileStore } from '../../src/profile/in-memory.js';
import { createInMemoryPushSubscriptionStore } from '../../src/push/store.js';
import { createInMemoryPriceAlertStore } from '../../src/price-alerts/store.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';

const OP_ID = '11111111-1111-4111-8111-111111111111';

// CODER-API-ROUTE-DUPE — dedupe na origem (incidente 13/10,
// FST_ERR_DUPLICATED_ROUTE no release 3c3a3f9, forward-fix #154).
//
// O guard first-wins (#154) mascara a duplicata: nenhum teste black-box de
// rotas (404/200, printRoutes, onRoute) consegue observar que
// POST /pending-operations/undo foi TENTADO duas vezes na composição
// produtiva pré-dedupe (registerRoutes + 2º registerPendingOperationRoutes
// v2Only no MESMO app). O único observável da tentativa duplicada é a
// consulta ao guard (`app.hasRoute`) — por isso este teste conta as consultas
// para POST /pending-operations/undo durante a composição completa.
//
// Produção saudável = UMA única tentativa de registro na origem (o guard
// permanece como defesa em profundidade, mas nunca deve engajar). Duas
// consultas = regressão: o registro duplo voltou a existir na origem,
// sustentado apenas pelo silêncio do guard.
describe('pending-operations origin single registration (production composition)', () => {
  it('registers POST /pending-operations/undo exactly once at the origin', async () => {
    const app = Fastify({ logger: false });

    let undoGuardChecks = 0;
    const rawHasRoute = app.hasRoute.bind(app);
    vi.spyOn(app, 'hasRoute').mockImplementation((opts: Parameters<typeof app.hasRoute>[0]) => {
      const probed = opts as unknown as { method?: unknown; url?: unknown };
      if (probed.method === 'POST' && probed.url === '/pending-operations/undo') {
        undoGuardChecks += 1;
      }
      return rawHasRoute(opts);
    });

    const { state, writes } = createInMemoryStores();
    const store = createInMemoryReadModelStore({
      accounts: state.accounts,
      categories: state.categories,
      transactions: state.transactions,
      deletedTransactionIds: state.deletedTransactions,
    });
    const tokenStore = createInMemoryDeviceTokenStore();
    const { token } = await tokenStore.register('test-device', HOUSEHOLD_A);
    const idempotency = createInMemoryIdempotencyStore();
    const auditLogs = createInMemoryAuditLogStore();
    const undoService = createUndoService({ auditLogs, writes, idempotency });

    // Composição produtiva PG pós-dedupe (server/index.ts): UMA única chamada
    // a registerRoutes, com o V2 via threading (pendingV2*) — nenhuma segunda
    // chamada a registerPendingOperationRoutes no mesmo app. O guard
    // first-wins (#154) permanece como defesa em profundidade, mas um boot
    // saudável nunca o engaja para /undo.
    registerRoutes(app, {
      store,
      writes,
      tokenStore,
      idempotency,
      cardStore: createInMemoryCardStore(state),
      payableStore: createInMemoryPayableStore(state),
      budgetStore: createInMemoryBudgetStore(state),
      goalStore: createInMemoryGoalStore(state),
      subscriptionStore: createInMemorySubscriptionStore({ subscriptions: [] }),
      profileStore: createInMemoryProfileStore(),
      pushStore: createInMemoryPushSubscriptionStore(),
      priceAlertStore: createInMemoryPriceAlertStore(),
      auditLogs,
      undoService,
      pendingV2Store: createInMemoryPendingOperationV2Store(),
      pendingV2Executor: createPendingOperationV2Executor(writes),
      pendingV2ReadModel: store,
    });

    // GREEN (pós-dedupe): 1 consulta — registro único, guard nunca engaja.
    // (RED pré-dedupe: 2 — a tentativa duplicada na origem.)
    expect(undoGuardChecks).toBe(1);

    // Pins de preservação de comportamento (verdes antes e depois).
    const undoRes = await app.inject({
      method: 'POST',
      url: '/pending-operations/undo',
      headers: { 'x-device-token': token, 'idempotency-key': crypto.randomUUID() },
      payload: {},
    });
    expect(undoRes.json().code).toBe('undo.nothing_to_undo');

    const v1Res = await app.inject({
      method: 'GET',
      url: `/pending-operations/${OP_ID}`,
      headers: { 'x-device-token': token },
    });
    expect(v1Res.statusCode).toBe(404);

    const v2Res = await app.inject({
      method: 'GET',
      url: '/pending-operations/v2/active',
      headers: { 'x-device-token': token },
    });
    expect(v2Res.statusCode).toBe(403);
    expect(v2Res.json().code).toBe('auth.delegation_scope_forbidden');

    await app.close();
  });
});
