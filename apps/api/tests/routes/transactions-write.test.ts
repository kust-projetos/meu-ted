import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import { randomUUID } from 'node:crypto';

const isoDate = '2026-06-10';

type Setup = {
  app: ReturnType<typeof buildTestApp>['app'];
  accountId: string;
  categoryId: string;
};

const setupAccountAndCategory = async (): Promise<Setup> => {
  const { app } = buildTestApp();
  const acc = await app.inject({
    method: 'POST',
    url: '/accounts',
    headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    payload: { name: 'A', kind: 'bank', initialBalanceCents: 5_000 },
  });
  const cat = await app.inject({
    method: 'POST',
    url: '/categories',
    headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    payload: { name: 'Food', kind: 'expense' },
  });
  return { app, accountId: acc.json().id, categoryId: cat.json().id };
};

describe('POST /transactions/expense', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setupAccountAndCategory();
  });

  it('creates an expense', async () => {
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Lunch',
        amountCents: 1500,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('expense');
  });

  it('preserves the supplied description casing for distinct expenses', async () => {
    for (const description of ['mercado', 'Mercado']) {
      const response = await s.app.inject({
        method: 'POST',
        url: '/transactions/expense',
        headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        payload: { description, amountCents: 1500, date: isoDate, accountId: s.accountId, categoryId: s.categoryId },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().description).toBe(description);
    }
    const list = await s.app.inject({ method: 'GET', url: '/transactions', headers: { 'x-device-token': TOKEN_A } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: { description: string }) => item.description)).toEqual(
      expect.arrayContaining(['mercado', 'Mercado']),
    );
  });

  it('rejects amount <= 0', async () => {
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 0,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('books an over-balance expense with the exact negative delta (negative-balance rule)', async () => {
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Too big',
        amountCents: 10_000,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(201);
    const list = await s.app.inject({ method: 'GET', url: '/accounts', headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() } });
    const acc = list.json().items.find((a: { id: string }) => a.id === s.accountId);
    expect(acc.balanceCents).toBe(5_000 - 10_000);
  });

  it('rejects invalid account', async () => {
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: isoDate,
        accountId: randomUUID(),
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/Conta/);
  });

  it('rejects invalid date', async () => {
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: '2026/06/10',
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects 422 when both accountId and cardId are sent (ambiguous origin, item 10/B2)', async () => {
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: isoDate,
        accountId: s.accountId,
        cardId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation.origin_conflict');
  });

  it('rejects 422 when neither accountId nor cardId is sent (missing origin, item 10/B2)', async () => {
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/income',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: isoDate,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation.origin_required');
  });

  it('routes cardId to the CardStore: 1x purchase lands on the statement (H-01)', async () => {
    const card = await s.app.inject({
      method: 'POST',
      url: '/cards',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Nubank', creditLimitCents: 500_000, closingDay: 15, dueDay: 25 },
    });
    expect(card.statusCode).toBe(201);
    const cardId = card.json().id as string;
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Card lunch',
        amountCents: 1500,
        date: isoDate,
        cardId,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().accountId).toBe(cardId);
    // The purchase followed the invoice path: exactly one statement exists
    // for the cycle and it lists the purchase.
    const stmts = await s.app.inject({
      method: 'GET',
      url: `/cards/statements?accountId=${cardId}`,
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(stmts.statusCode).toBe(200);
    expect(stmts.json().items).toHaveLength(1);
    const detail = await s.app.inject({
      method: 'GET',
      url: `/cards/statements/${stmts.json().items[0].id}`,
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(detail.json().purchases.map((p: { description: string }) => p.description)).toContain('Card lunch');
  });

  it('rejects 422 when accountId points at a card on expense (use /cards/purchases, H-01)', async () => {
    const card = await s.app.inject({
      method: 'POST',
      url: '/cards',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Nubank', creditLimitCents: 500_000, closingDay: 15, dueDay: 25 },
    });
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: isoDate,
        accountId: card.json().id,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation.invalid');
  });

  it('persists notes from Mais detalhes and returns them (item 10/B4)', async () => {
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Lunch',
        amountCents: 1500,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
        notes: 'Almoço com cliente, reembolsável',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().notes).toBe('Almoço com cliente, reembolsável');
  });
});

describe('POST /transactions/income', () => {
  it('creates an income', async () => {
    const { app } = buildTestApp();
    const acc = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'A', kind: 'bank', initialBalanceCents: 0 },
    });
    const cat = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Salary', kind: 'income' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/income',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Paycheck',
        amountCents: 12_000_00,
        date: isoDate,
        accountId: acc.json().id,
        categoryId: cat.json().id,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('income');
  });

  it('rejects 422 income with cardId (H-01)', async () => {
    const { app } = buildTestApp();
    const card = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Nubank', creditLimitCents: 500_000, closingDay: 15, dueDay: 25 },
    });
    const cat = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Salary', kind: 'income' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/income',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Refund?',
        amountCents: 100,
        date: isoDate,
        cardId: card.json().id,
        categoryId: cat.json().id,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation.origin_card_income');
  });

  it('rejects 422 income with accountId pointing at a card (H-01)', async () => {
    const { app } = buildTestApp();
    const card = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Nubank', creditLimitCents: 500_000, closingDay: 15, dueDay: 25 },
    });
    const cat = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Salary', kind: 'income' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/income',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Refund?',
        amountCents: 100,
        date: isoDate,
        accountId: card.json().id,
        categoryId: cat.json().id,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation.invalid');
  });
});

describe('POST /transfers', () => {
  it('creates a transfer between two accounts', async () => {
    const { app } = buildTestApp();
    const a = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      // V4.1 Phase 4 (D1): the source must cover the transfer.
      payload: { name: 'A', kind: 'bank', initialBalanceCents: 10_000 },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'B', kind: 'cash', initialBalanceCents: 0 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Move',
        amountCents: 500,
        date: isoDate,
        fromAccountId: a.json().id,
        toAccountId: b.json().id,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe('transfer');
    expect(res.json().transferToAccountId).toBe(b.json().id);
  });

  it('rejects 422 transfer touching a credit card (H-01)', async () => {
    const { app } = buildTestApp();
    const a = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'A', kind: 'bank', initialBalanceCents: 10_000 },
    });
    const card = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'Nubank', creditLimitCents: 500_000, closingDay: 15, dueDay: 25 },
    });
    const fromCard = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 500,
        date: isoDate,
        fromAccountId: card.json().id,
        toAccountId: a.json().id,
      },
    });
    expect(fromCard.statusCode).toBe(422);
    const toCard = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 500,
        date: isoDate,
        fromAccountId: a.json().id,
        toAccountId: card.json().id,
      },
    });
    expect(toCard.statusCode).toBe(422);
  });

  it('rejects fromAccount === toAccount', async () => {
    const { app } = buildTestApp();
    const a = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'A', kind: 'bank', initialBalanceCents: 0 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: isoDate,
        fromAccountId: a.json().id,
        toAccountId: a.json().id,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /transactions/:id', () => {
  it('updates description on expense', async () => {
    const s = await setupAccountAndCategory();
    const tx = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Old',
        amountCents: 1000,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    const res = await s.app.inject({
      method: 'PATCH',
      url: `/transactions/${tx.json().id}`,
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { description: 'New' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().description).toBe('New');
  });

  it('patches notes on expense (item 10/B4)', async () => {
    const s = await setupAccountAndCategory();
    const tx = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'Old',
        amountCents: 1000,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    const res = await s.app.inject({
      method: 'PATCH',
      url: `/transactions/${tx.json().id}`,
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { notes: 'Nota adicionada depois' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes).toBe('Nota adicionada depois');
  });

  it('rejects amount change on transfer (unsupported → 422 per SPEC §9.7)', async () => {
    const { app } = buildTestApp();
    const a = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      // V4.1 Phase 4 (D1): the source must cover the transfer.
      payload: { name: 'A', kind: 'bank', initialBalanceCents: 10_000 },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { name: 'B', kind: 'cash', initialBalanceCents: 0 },
    });
    const tx = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: isoDate,
        fromAccountId: a.json().id,
        toAccountId: b.json().id,
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/transactions/${tx.json().id}`,
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: { amountCents: 200 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('unsupported');
  });
});

describe('DELETE /transactions/:id (soft)', () => {
  it('soft-deletes; subsequent GET /transactions excludes it', async () => {
    const s = await setupAccountAndCategory();
    const tx = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    const id = tx.json().id;
    const del = await s.app.inject({
      method: 'DELETE',
      url: `/transactions/${id}`,
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().id).toBe(id);
    expect(del.json().receipt.mutationKind).toBe('transaction.delete');
    const list = await s.app.inject({
      method: 'GET',
      url: '/transactions',
      headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() },
    });
    expect(list.json().items.find((t: { id: string }) => t.id === id)).toBeUndefined();
  });

  it('returns 404 on second delete', async () => {
    const s = await setupAccountAndCategory();
    const tx = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers: { 'x-device-token': TOKEN_A, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      payload: {
        description: 'X',
        amountCents: 100,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    const id = tx.json().id;
    await s.app.inject({ method: 'DELETE', url: `/transactions/${id}`, headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() } });
    const res = await s.app.inject({ method: 'DELETE', url: `/transactions/${id}`, headers: { 'x-device-token': TOKEN_A, 'idempotency-key': crypto.randomUUID() } });
    expect(res.statusCode).toBe(404);
  });
});

describe('idempotency', () => {
  it('replays the same response on duplicate key + same payload', async () => {
    const s = await setupAccountAndCategory();
    const payload = {
      description: 'Idem',
      amountCents: 100,
      date: isoDate,
      accountId: s.accountId,
      categoryId: s.categoryId,
    };
    const headers = {
      'x-device-token': TOKEN_A,
      'content-type': 'application/json',
      'idempotency-key': 'abc-123',
    };
    const first = await s.app.inject({ method: 'POST', url: '/transactions/expense', headers, payload });
    const second = await s.app.inject({ method: 'POST', url: '/transactions/expense', headers, payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().id).toBe(second.json().id);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('returns 409 on duplicate key + different payload', async () => {
    const s = await setupAccountAndCategory();
    const headers = {
      'x-device-token': TOKEN_A,
      'content-type': 'application/json',
      'idempotency-key': 'abc-456',
    };
    await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers,
      payload: {
        description: 'First',
        amountCents: 100,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    const res = await s.app.inject({
      method: 'POST',
      url: '/transactions/expense',
      headers,
      payload: {
        description: 'Different',
        amountCents: 200,
        date: isoDate,
        accountId: s.accountId,
        categoryId: s.categoryId,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('idempotency.conflict');
  });
});
