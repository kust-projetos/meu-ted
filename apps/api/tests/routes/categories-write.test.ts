import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import { randomUUID } from 'node:crypto';

describe('POST /categories', () => {
  let app: ReturnType<typeof buildTestApp>['app'];
  beforeEach(() => {
    app = buildTestApp().app;
  });

  it('creates a category and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Mercado', kind: 'expense' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Mercado');
  });

  it('rejects invalid kind', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'X', kind: 'transfer' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a subcategory with parentId and returns 201', async () => {
    const parent = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Alimentação', kind: 'expense' },
    });
    expect(parent.statusCode).toBe(201);
    const parentId = parent.json().id;

    const res = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Mercado', kind: 'expense', parentId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Mercado');
    expect(res.json().parentId).toBe(parentId);
  });

  it('rejects subcategory of a subcategory (max depth 1)', async () => {
    const parent = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Alimentação', kind: 'expense' },
    });
    const child = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Mercado', kind: 'expense', parentId: parent.json().id },
    });
    expect(child.statusCode).toBe(201);

    const grandchild = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Hortifrúti', kind: 'expense', parentId: child.json().id },
    });
    expect(grandchild.statusCode).toBe(400);
    expect(grandchild.json().code).toBe('validation.invalid');
  });

  it('rejects parentId pointing to non-existent category', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Mercado', kind: 'expense', parentId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('rejects parentId with different kind', async () => {
    const parent = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Salário', kind: 'income' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Bônus', kind: 'expense', parentId: parent.json().id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.invalid');
  });
});

describe('PATCH /categories/:id', () => {
  it('renames a category', async () => {
    const { app } = buildTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Old', kind: 'expense' },
    });
    const id = created.json().id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/categories/${id}`,
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
      url: `/categories/${randomUUID()}`,
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /categories/:id/deactivate', () => {
  it('returns 409 when category has active transactions', async () => {
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
        date: '2026-06-10',
        accountId: acc.json().id,
        categoryId: cat.json().id,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/categories/${cat.json().id}/deactivate`,
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('in_use');
    expect(res.json().message).toMatch(/registros vinculados ativos/i);
  });
});
