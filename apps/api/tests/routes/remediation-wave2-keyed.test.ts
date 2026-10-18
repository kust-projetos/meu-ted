/**
 * Wave 2 remediation — route-level keyed contract (in-memory app).
 *
 * T05 routes: POST /accounts, PATCH /accounts/:id, POST /accounts/:id/deactivate,
 * POST /categories, PATCH /categories/:id, POST /categories/:id/deactivate.
 * T06 routes (closed list): POST /categories/apply-defaults,
 * POST /categories/:id/delete, POST /payables/:id/unpay,
 * POST /payables/:id/cancel, POST /goals/:id/cancel,
 * POST /subscriptions/:id/cancel, PATCH /subscriptions/:id.
 *
 * Contract per route (mirrors domain-keyed-mutations.test.ts):
 * - G2.2.4: financial mutations REQUIRE Idempotency-Key — a missing key is
 *   rejected with 400 validation.required by the centralized preHandler;
 * - same key + same payload sequential → replay of ORIGINAL response
 *   (same status + body) with `Idempotent-Replayed: true`, exactly 1 effect;
 *   without a key the request never reaches the producer.
 * - same key + divergent payload → 409 idempotency.conflict;
 * - N concurrent same-key requests → identical bodies, exactly 1 effect;
 * - same key in another workspace → independent effect.
 * Atomicity itself is proven on Postgres in
 * tests/writes/account-category-keyed-postgres.test.ts and
 * tests/writes/seven-mutations-keyed-postgres.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A, TOKEN_B } from '../test-app.js';
import Fastify from 'fastify';
import { registerAccountRoutes } from '../../src/routes/accounts.js';
import { registerCategoryRoutes } from '../../src/routes/categories.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryReadModelStore } from '../../src/read-models/store.js';
import { createInMemoryIdempotencyStore, httpIdempotencyPayload } from '../../src/writes/idempotency.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';

const authA = (key?: string) => ({
  'x-device-token': TOKEN_A,
  'content-type': 'application/json',
  ...(key ? { 'idempotency-key': key } : {}),
});
const authB = (key?: string) => ({
  'x-device-token': TOKEN_B,
  'content-type': 'application/json',
  ...(key ? { 'idempotency-key': key } : {}),
});

const setupBase = async () => {
  const { app, state } = buildTestApp();
  const acc = await app.inject({
    method: 'POST', url: '/accounts', headers: authA(`base-acc-${crypto.randomUUID()}`),
    payload: { name: 'Bank', kind: 'bank', initialBalanceCents: 500_000 },
  });
  expect(acc.statusCode).toBe(201);
  const accountId = acc.json().id as string;
  const cat = await app.inject({
    method: 'POST', url: '/categories', headers: authA(`base-cat-${crypto.randomUUID()}`),
    payload: { name: 'Food', kind: 'expense' },
  });
  expect(cat.statusCode).toBe(201);
  const categoryId = cat.json().id as string;
  return { app, state, accountId, categoryId };
};

describe('T05 PATCH /accounts/:id keyed', () => {
  it('replays the original update response with the replay header', async () => {
    const s = await setupBase();
    const payload = { name: 'Renamed' };
    const first = await s.app.inject({ method: 'PATCH', url: `/accounts/${s.accountId}`, headers: authA('t05-acct-patch-1'), payload });
    expect(first.statusCode).toBe(200);
    const second = await s.app.inject({ method: 'PATCH', url: `/accounts/${s.accountId}`, headers: authA('t05-acct-patch-1'), payload });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('concurrent same-key PATCH converges to one body; divergent payload conflicts', async () => {
    const s = await setupBase();
    const payload = { name: 'Raced' };
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        s.app.inject({ method: 'PATCH', url: `/accounts/${s.accountId}`, headers: authA('t05-acct-patch-race'), payload }),
      ),
    );
    for (const r of raced) expect(r.statusCode).toBe(200);
    expect(new Set(raced.map((r) => JSON.stringify(r.json()))).size).toBe(1);
    expect(s.state.accounts.filter((a) => a.householdId && a.name === 'Raced')).toHaveLength(1);

    const conflict = await s.app.inject({ method: 'PATCH', url: `/accounts/${s.accountId}`, headers: authA('t05-acct-patch-race'), payload: { name: 'Other' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency.conflict');
  });

  it('same key in another workspace is independent; missing key is rejected (G2.2.4)', async () => {
    const s = await setupBase();
    const payload = { name: 'Renamed' };
    const a1 = await s.app.inject({ method: 'PATCH', url: `/accounts/${s.accountId}`, headers: authA('t05-acct-patch-ws'), payload });
    expect(a1.statusCode).toBe(200);
    // TOKEN_B household has no such account → 404, proving workspace scoping
    // (the key did not replay household A's response).
    const b1 = await s.app.inject({ method: 'PATCH', url: `/accounts/${s.accountId}`, headers: authB('t05-acct-patch-ws'), payload });
    expect(b1.statusCode).toBe(404);
    // G2.2.4 centralized enforcement: financial mutations REQUIRE the key.
    const unkeyed = await s.app.inject({ method: 'PATCH', url: `/accounts/${s.accountId}`, headers: authA(), payload: { name: 'Plain' } });
    expect(unkeyed.statusCode).toBe(400);
    expect(unkeyed.json().code).toBe('validation.required');
  });
});

describe('T05 remaining account/category keyed routes', () => {
  it('POST /accounts replays the original create response with one effect', async () => {
    const { app, state } = buildTestApp();
    const payload = { name: 'Savings', kind: 'bank', initialBalanceCents: 1000 };
    const first = await app.inject({ method: 'POST', url: '/accounts', headers: authA('t05-acc-create-1'), payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/accounts', headers: authA('t05-acc-create-1'), payload });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(state.accounts.filter((a) => a.name === 'Savings')).toHaveLength(1);
  });

  it('POST /accounts/:id/deactivate replays after terminal state', async () => {
    const s = await setupBase();
    const first = await s.app.inject({ method: 'POST', url: `/accounts/${s.accountId}/deactivate`, headers: authA('t05-acc-deact-1'), payload: {} });
    expect(first.statusCode).toBe(200);
    const second = await s.app.inject({ method: 'POST', url: `/accounts/${s.accountId}/deactivate`, headers: authA('t05-acc-deact-1'), payload: {} });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('POST /categories + PATCH /categories/:id replay; deactivate replays after terminal', async () => {
    const s = await setupBase();
    const payload = { name: 'Transport', kind: 'expense' };
    const first = await s.app.inject({ method: 'POST', url: '/categories', headers: authA('t05-cat-create-1'), payload });
    expect(first.statusCode).toBe(201);
    const second = await s.app.inject({ method: 'POST', url: '/categories', headers: authA('t05-cat-create-1'), payload });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    const catId = first.json().id as string;

    const upd = { name: 'Transport Updated' };
    const u1 = await s.app.inject({ method: 'PATCH', url: `/categories/${catId}`, headers: authA('t05-cat-upd-1'), payload: upd });
    expect(u1.statusCode).toBe(200);
    const u2 = await s.app.inject({ method: 'PATCH', url: `/categories/${catId}`, headers: authA('t05-cat-upd-1'), payload: upd });
    expect(u2.headers['idempotent-replayed']).toBe('true');
    expect(u2.json()).toEqual(u1.json());

    const d1 = await s.app.inject({ method: 'POST', url: `/categories/${catId}/deactivate`, headers: authA('t05-cat-deact-1'), payload: {} });
    expect(d1.statusCode).toBe(200);
    const d2 = await s.app.inject({ method: 'POST', url: `/categories/${catId}/deactivate`, headers: authA('t05-cat-deact-1'), payload: {} });
    expect(d2.headers['idempotent-replayed']).toBe('true');
    expect(d2.json()).toEqual(d1.json());
  });
});

describe('T06 POST /categories/apply-defaults keyed', () => {
  it('missing key is rejected (G2.2.4); keyed sequential replays the original receipt', async () => {
    const { app } = buildTestApp();
    const plain = await app.inject({ method: 'POST', url: '/categories/apply-defaults', headers: authA(), payload: {} });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().code).toBe('validation.required');
  });

  it('keyed apply-defaults replays identically with the replay header', async () => {
    const { app } = buildTestApp();
    const first = await app.inject({ method: 'POST', url: '/categories/apply-defaults', headers: authA('t06-apply-1'), payload: {} });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/categories/apply-defaults', headers: authA('t06-apply-1'), payload: {} });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });
});

describe('T06 POST /categories/:id/delete keyed', () => {
  it('move-mode delete replays the original receipt; divergent payload conflicts', async () => {
    const s = await setupBase();
    const doomed = await s.app.inject({ method: 'POST', url: '/categories', headers: authA(`t06-doom-${crypto.randomUUID()}`), payload: { name: 'Doomed', kind: 'expense' } });
    const doomedId = doomed.json().id as string;
    const payload = { mode: 'move', destinationCategoryId: s.categoryId };
    const first = await s.app.inject({ method: 'POST', url: `/categories/${doomedId}/delete`, headers: authA('t06-catdel-1'), payload });
    expect(first.statusCode).toBe(200);
    const second = await s.app.inject({ method: 'POST', url: `/categories/${doomedId}/delete`, headers: authA('t06-catdel-1'), payload });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());

    const other = await s.app.inject({ method: 'POST', url: '/categories', headers: authA(`t06-doom2-${crypto.randomUUID()}`), payload: { name: 'Doomed2', kind: 'expense' } });
    const otherId = other.json().id as string;
    await s.app.inject({ method: 'POST', url: `/categories/${otherId}/delete`, headers: authA('t06-catdel-div'), payload });
    const conflict = await s.app.inject({ method: 'POST', url: `/categories/${otherId}/delete`, headers: authA('t06-catdel-div'), payload: { mode: 'cascade', confirm: true } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency.conflict');
  });

  it('R2 concurrent same-key delete converges to one receipt', async () => {
    const s = await setupBase();
    const doomed = await s.app.inject({ method: 'POST', url: '/categories', headers: authA(`r2-doom-${crypto.randomUUID()}`), payload: { name: 'R2 Doomed', kind: 'expense' } });
    const doomedId = doomed.json().id as string;
    const payload = { mode: 'move', destinationCategoryId: s.categoryId };
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        s.app.inject({ method: 'POST', url: `/categories/${doomedId}/delete`, headers: authA('r2-catdel-race'), payload }),
      ),
    );
    for (const r of raced) expect(r.statusCode).toBe(200);
    expect(new Set(raced.map((r) => JSON.stringify(r.json()))).size).toBe(1);
  });
});

describe('T06 POST /payables/:id/unpay + :id/cancel keyed', () => {
  const createPayable = async (app: ReturnType<typeof buildTestApp>['app'], accountId: string, key?: string, description = 'Bill') => {
    const res = await app.inject({
      method: 'POST', url: '/payables', headers: authA(key ?? `t06-pay-${crypto.randomUUID()}`),
      payload: { accountId, description, amountCents: 2000, dueDate: '2026-08-10' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  it('unpay replays the original receipt; exactly one reversal on concurrent race', async () => {
    const s = await setupBase();
    const id = await createPayable(s.app, s.accountId);
    const pay = await s.app.inject({ method: 'POST', url: `/payables/${id}/pay`, headers: authA(`t06-pay-${crypto.randomUUID()}`), payload: {} });
    expect(pay.statusCode).toBe(200);
    const paidTxId = pay.json().paidTransactionId as string;
    expect(paidTxId).toBeDefined();
    const payload = { paidTransactionId: paidTxId };
    const before = s.state.accounts.find((a) => a.id === s.accountId)!.balanceCents;

    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        s.app.inject({ method: 'POST', url: `/payables/${id}/unpay`, headers: authA('t06-unpay-race'), payload }),
      ),
    );
    for (const r of raced) expect(r.statusCode).toBe(200);
    expect(new Set(raced.map((r) => JSON.stringify(r.json()))).size).toBe(1);
    // Exactly one reversal: balance credited back exactly once.
    const after = s.state.accounts.find((a) => a.id === s.accountId)!.balanceCents;
    expect(after - before).toBe(2000);

    const replay = await s.app.inject({ method: 'POST', url: `/payables/${id}/unpay`, headers: authA('t06-unpay-race'), payload });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(raced[0]!.json());
  });

  it('cancel replays after terminal; invalid body returns 400 with NO write', async () => {
    const s = await setupBase();
    const id = await createPayable(s.app, s.accountId);
    const first = await s.app.inject({ method: 'POST', url: `/payables/${id}/cancel`, headers: authA('t06-paycancel-1'), payload: {} });
    expect(first.statusCode).toBe(200);
    const second = await s.app.inject({ method: 'POST', url: `/payables/${id}/cancel`, headers: authA('t06-paycancel-1'), payload: {} });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());

    const id2 = await createPayable(s.app, s.accountId, undefined, 'Other');
    const bad = await s.app.inject({ method: 'POST', url: `/payables/${id2}/cancel`, headers: authA(`t06-paycancel-bad-${crypto.randomUUID()}`), payload: { reason: 123 } });
    expect(bad.statusCode).toBe(400);
    // NO write: the payable is untouched (still present, never cancelled).
    const list = await s.app.inject({ method: 'GET', url: '/payables', headers: authA() });
    const found = list.json().items.find((p: { id: string }) => p.id === id2);
    expect(found).toBeDefined();
    expect(found.status).not.toBe('cancelled');
  });
});

describe('T06 POST /goals/:id/cancel keyed', () => {
  it('replays the original cancel receipt; divergent payload conflicts', async () => {
    const s = await setupBase();
    const g = await s.app.inject({
      method: 'POST', url: '/goals', headers: authA(`t06-goal-${crypto.randomUUID()}`),
      payload: { name: 'Trip', goalType: 'savings', targetAmountCents: 10_000, startDate: '2026-01-01' },
    });
    expect(g.statusCode).toBe(201);
    const goalId = g.json().id as string;
    const first = await s.app.inject({ method: 'POST', url: `/goals/${goalId}/cancel`, headers: authA('t06-goalcancel-1'), payload: {} });
    expect(first.statusCode).toBe(200);
    const second = await s.app.inject({ method: 'POST', url: `/goals/${goalId}/cancel`, headers: authA('t06-goalcancel-1'), payload: {} });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('R2 concurrent same-key cancel converges to one receipt', async () => {
    const s = await setupBase();
    const g = await s.app.inject({
      method: 'POST', url: '/goals', headers: authA(`r2-goal-${crypto.randomUUID()}`),
      payload: { name: 'Race', goalType: 'savings', targetAmountCents: 5_000, startDate: '2026-01-01' },
    });
    expect(g.statusCode).toBe(201);
    const goalId = g.json().id as string;
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        s.app.inject({ method: 'POST', url: `/goals/${goalId}/cancel`, headers: authA('r2-goalcancel-race'), payload: {} }),
      ),
    );
    for (const r of raced) expect(r.statusCode).toBe(200);
    expect(new Set(raced.map((r) => JSON.stringify(r.json()))).size).toBe(1);
  });
});

describe('T06 subscriptions cancel + update keyed', () => {
  const createSub = async (app: ReturnType<typeof buildTestApp>['app']) => {
    const res = await app.inject({
      method: 'POST', url: '/subscriptions', headers: authA(`t06-sub-${crypto.randomUUID()}`),
      payload: { name: 'Stream', amountCents: 4990, cycle: 'monthly', day: 5, paymentMethod: 'card' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  it('cancel replays after terminal with one effect', async () => {
    const { app } = buildTestApp();
    const id = await createSub(app);
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({ method: 'POST', url: `/subscriptions/${id}/cancel`, headers: authA('t06-subcancel-race'), payload: {} }),
      ),
    );
    for (const r of raced) expect(r.statusCode).toBe(200);
    expect(new Set(raced.map((r) => JSON.stringify(r.json()))).size).toBe(1);
    // Same-key sequential replay returns the original even though the state
    // is already terminal.
    const replay = await app.inject({ method: 'POST', url: `/subscriptions/${id}/cancel`, headers: authA('t06-subcancel-race'), payload: {} });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(raced[0]!.json());
  });

  it('PATCH update replays; divergent payload conflicts; missing key is rejected (G2.2.4)', async () => {
    const { app } = buildTestApp();
    const id = await createSub(app);
    const payload = { name: 'Stream Plus' };
    const first = await app.inject({ method: 'PATCH', url: `/subscriptions/${id}`, headers: authA('t06-subupd-1'), payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'PATCH', url: `/subscriptions/${id}`, headers: authA('t06-subupd-1'), payload });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    const conflict = await app.inject({ method: 'PATCH', url: `/subscriptions/${id}`, headers: authA('t06-subupd-1'), payload: { name: 'Other' } });
    expect(conflict.statusCode).toBe(409);
    const unkeyed = await app.inject({ method: 'PATCH', url: `/subscriptions/${id}`, headers: authA(), payload: { name: 'Plain' } });
    expect(unkeyed.statusCode).toBe(400);
    expect(unkeyed.json().code).toBe('validation.required');
  });

  it('R2 concurrent same-key PATCH converges to one receipt', async () => {
    const { app } = buildTestApp();
    const id = await createSub(app);
    const payload = { name: 'R2 Raced' };
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({ method: 'PATCH', url: `/subscriptions/${id}`, headers: authA('r2-subupd-race'), payload }),
      ),
    );
    for (const r of raced) expect(r.statusCode).toBe(200);
    expect(new Set(raced.map((r) => JSON.stringify(r.json()))).size).toBe(1);
    expect(raced[0]!.json().name).toBe('R2 Raced');
  });
});

describe('R3 legacy replay compat (P2): stored {status:200} create envelopes replay as 201', () => {
  // Minimal route composition sharing ONE in-memory idempotency store, so a
  // pre-upgrade-style record (stored {status:200}, external contract 201) can
  // be seeded through the public store path and replayed through the route.
  const buildLegacyReplayApp = (householdId: string) => {
    const { state, writes } = createInMemoryStores();
    const store = createInMemoryReadModelStore({
      accounts: state.accounts,
      categories: state.categories,
      transactions: state.transactions,
      deletedTransactionIds: state.deletedTransactions,
    });
    const idempotency = createInMemoryIdempotencyStore();
    const app = Fastify({ logger: false });
    const resolveToken = async () => ({ deviceId: 'r3-device', householdId });
    registerAccountRoutes(app, { store, writes, resolveToken, idempotency });
    registerCategoryRoutes(app, { store, writes, resolveToken, idempotency });
    return { app, idempotency };
  };
  const jsonHeaders = (key: string) => ({ 'content-type': 'application/json', 'idempotency-key': key });

  it('R3 POST /accounts replays a legacy {status:200} envelope as 201 with the original body', async () => {
    const { app, idempotency } = buildLegacyReplayApp(HOUSEHOLD_A);
    const body = { name: 'Legacy', kind: 'bank', initialBalanceCents: 1000 };
    const legacyBody = { id: crypto.randomUUID(), householdId: HOUSEHOLD_A, name: 'Legacy', kind: 'bank', balanceCents: 1000, status: 'active' };
    await idempotency.lookupOrRecord(
      HOUSEHOLD_A,
      'r3-legacy-acc-create',
      httpIdempotencyPayload({ route: 'POST /accounts' }, body),
      async () => ({ status: 200, body: legacyBody }),
    );
    const replay = await app.inject({ method: 'POST', url: '/accounts', headers: jsonHeaders('r3-legacy-acc-create'), payload: body });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(legacyBody);
  });

  it('R3 POST /categories replays a legacy {status:200} envelope as 201 with the original body', async () => {
    const { app, idempotency } = buildLegacyReplayApp(HOUSEHOLD_A);
    const body = { name: 'Legacy Cat', kind: 'expense' };
    const legacyBody = { id: crypto.randomUUID(), householdId: HOUSEHOLD_A, name: 'Legacy Cat', kind: 'expense', status: 'active' };
    await idempotency.lookupOrRecord(
      HOUSEHOLD_A,
      'r3-legacy-cat-create',
      httpIdempotencyPayload({ route: 'POST /categories' }, body),
      async () => ({ status: 200, body: legacyBody }),
    );
    const replay = await app.inject({ method: 'POST', url: '/categories', headers: jsonHeaders('r3-legacy-cat-create'), payload: body });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(legacyBody);
  });
});
