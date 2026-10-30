import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import { randomUUID } from 'node:crypto';

const isoDate = '2026-06-10';

describe('POST /accounts', () => {
  let app: ReturnType<typeof buildTestApp>['app'];
  let _state: ReturnType<typeof buildTestApp>['state'];

  beforeEach(() => {
    const t = buildTestApp();
    app = t.app;
    _state = t.state;
  });

  it('creates an account and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Itaú', kind: 'bank', initialBalanceCents: 100_000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Itaú');
    expect(body.kind).toBe('bank');
    expect(body.balanceCents).toBe(100_000);
    expect(body.status).toBe('active');
  });

  it('rejects with 400 on invalid kind', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'X', kind: 'crypto', initialBalanceCents: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a negative initial balance for bank/cash (negative-balance rule)', async () => {
    for (const kind of ['bank', 'cash'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/accounts',
        headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        payload: { name: `Neg ${kind}`, kind, initialBalanceCents: -5000 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().balanceCents).toBe(-5000);
    }
  });

  it('requires auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'X', kind: 'bank', initialBalanceCents: 0 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('new account is visible on subsequent GET /accounts', async () => {
    await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'New', kind: 'cash', initialBalanceCents: 0 },
    });
    const list = await app.inject({ method: 'GET', url: '/accounts', headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() } });
    expect(list.json().items.find((a: { name: string }) => a.name === 'New')).toBeDefined();
  });
});

describe('PATCH /accounts/:id', () => {
  it('renames an account', async () => {
    const { app } = buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Old', kind: 'bank', initialBalanceCents: 0 },
    });
    const id = created.json().id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/accounts/${id}`,
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'New' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('New');
  });

  it('returns 404 on unknown id', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/accounts/${randomUUID()}`,
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /accounts/:id/deactivate', () => {
  it('deactivates an account with no transactions', async () => {
    const { app } = buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'X', kind: 'bank', initialBalanceCents: 0 },
    });
    const id = created.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/accounts/${id}/deactivate`,
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('inactive');
  });

  it('returns 400 (idempotency.required) when Idempotency-Key is missing', async () => {
    const { app } = buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'X', kind: 'bank', initialBalanceCents: 0 },
    });
    const id = created.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/accounts/${id}/deactivate`,
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.required');
  });

  it('returns 409 when account has active transactions', async () => {
    const { app } = buildTestApp();
    const acc = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      // V4.1 Phase 4 (D1): funded so the setup expense books successfully.
      payload: { name: 'X', kind: 'bank', initialBalanceCents: 10_000 },
    });
    const cat = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Food', kind: 'expense' },
    });
    await app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Lunch',
        amountCents: 1000,
        date: isoDate,
        accountId: acc.json().id,
        categoryId: cat.json().id,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/accounts/${acc.json().id}/deactivate`,
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('in_use');
    expect(res.json().message).toMatch(/lançamentos/);
  });
});
