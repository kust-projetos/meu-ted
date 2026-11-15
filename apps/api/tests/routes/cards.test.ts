import { describe, it, expect } from 'vitest';
import { buildTestApp, TOKEN_A, TOKEN_B } from '../test-app.js';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CARD_A1,
  CATEGORY_FOOD_A,
  CATEGORY_RENT_A,
  CATEGORY_FOOD_B,
  HOUSEHOLD_A,
} from '../fixtures/seed.js';

const seed = {
  accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1, CARD_A1],
  categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_FOOD_B],
  transactions: [],
};

/** Deep-clone seed to prevent test contamination via shared object references. */
function freshSeed() {
  return JSON.parse(JSON.stringify(seed)) as typeof seed;
}

function auth(token: string) {
  return { 'x-device-token': token, 'idempotency-key': crypto.randomUUID() };
}

/**
 * Purchase date guaranteed to land on an OPEN statement regardless of run date.
 * today+35d → attaching statement's closingDate is always >= purchase date
 * (getClosingDate never moves backwards), hence > today → computeStatus 'open'.
 */
function openPurchaseDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 35);
  return d.toISOString().slice(0, 10);
}

describe('GET /cards/accounts', () => {
  it('returns only credit_card accounts for the household', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'GET',
      url: '/cards/accounts',
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe('credit_card');
    expect(body.items[0].name).toBe('Nubank Card');
    expect(body.items[0].creditLimitCents).toBe(5_000_00);
    expect(body.items[0].closingDay).toBe(15);
    expect(body.items[0].dueDay).toBe(25);
  });

  it('scopes to household A vs B', async () => {
    const { app } = buildTestApp(freshSeed());
    const a = await app.inject({
      method: 'GET',
      url: '/cards/accounts',
      headers: auth(TOKEN_A),
    });
    const b = await app.inject({
      method: 'GET',
      url: '/cards/accounts',
      headers: auth(TOKEN_B),
    });
    expect(a.json().items).toHaveLength(1);
    expect(b.json().items).toHaveLength(0);
  });

  it('returns empty when no credit cards exist', async () => {
    const { app } = buildTestApp({
      accounts: [ACCOUNT_A1, ACCOUNT_A2],
      categories: [CATEGORY_FOOD_A],
      transactions: [],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/cards/accounts',
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
  });

  it('requires auth', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({ method: 'GET', url: '/cards/accounts' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /cards/statements', () => {
  it('returns empty when no statements exist', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'GET',
      url: '/cards/statements',
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
  });

  it('accepts accountId filter', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'GET',
      url: `/cards/statements?accountId=${CARD_A1.id}`,
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts status and limit params', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'GET',
      url: '/cards/statements?status=open&limit=5',
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects invalid status', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'GET',
      url: '/cards/statements?status=invalid',
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /cards/purchases', () => {
  it('creates a purchase on a credit card and returns 201', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Supermercado',
        amountCents: 150_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].description).toBe('Supermercado');
    expect(body.items[0].amountCents).toBe(150_00);
    expect(body.items[0].kind).toBe('expense');
  });

  it('returns 400 when account is not a credit card', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: ACCOUNT_A1.id, // bank account
        description: 'Teste',
        amountCents: 100_00,
        date: '2026-06-10',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a purchase and the statement appears in list', async () => {
    const { app } = buildTestApp(freshSeed());

    // Create purchase
    await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Mercado',
        amountCents: 200_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });

    // List statements
    const stmtRes = await app.inject({
      method: 'GET',
      url: `/cards/statements?accountId=${CARD_A1.id}`,
      headers: auth(TOKEN_A),
    });
    expect(stmtRes.statusCode).toBe(200);
    const stmts = stmtRes.json().items;
    expect(stmts.length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates via idempotency key', async () => {
    const { app } = buildTestApp(freshSeed());
    const key = 'dedup-test-key-001';
    const payload = {
      accountId: CARD_A1.id,
      description: 'Teste idempotency',
      amountCents: 50_00,
      date: '2026-06-10',
    };

    const r1 = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'Content-Type': 'application/json', 'idempotency-key': key },
      payload,
    });
    expect(r1.statusCode).toBe(201);

    const r2 = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'Content-Type': 'application/json', 'idempotency-key': key },
      payload,
    });
    expect(r2.statusCode).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
  });

  it('requires auth', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Teste',
        amountCents: 100_00,
        date: '2026-06-10',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('validates required fields', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { accountId: CARD_A1.id }, // missing fields
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /cards/installments', () => {
  it('creates installment purchases and returns 201', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/installments',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Notebook 12x',
        totalAmountCents: 6_000_00,
        purchaseDate: '2026-06-10',
        installmentsTotal: 12,
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.items).toHaveLength(12);
    // First installment is month 0, last has remainder absorbed
    expect(body.items[0].installmentNumber).toBe(1);
    expect(body.items[11].installmentNumber).toBe(12);
  });

  it('returns 400 for non-credit-card account', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/installments',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: ACCOUNT_A1.id,
        description: 'Teste',
        totalAmountCents: 1_000_00,
        purchaseDate: '2026-06-10',
        installmentsTotal: 3,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /cards/recurring', () => {
  it('creates a recurring purchase and returns 201', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/recurring',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Netflix',
        amountCents: 39_90,
        frequency: 'monthly',
        startDate: '2026-06-15',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.description).toBe('Netflix');
    expect(body.frequency).toBe('monthly');
    expect(body.status).toBe('active');
  });

  it('accepts optional endDate', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/recurring',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Seguro',
        amountCents: 200_00,
        frequency: 'yearly',
        startDate: '2026-06-15',
        endDate: '2027-06-15',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().endDate).toBe('2027-06-15');
  });

  it('validates frequency enum', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/recurring',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Teste',
        amountCents: 100_00,
        frequency: 'weekly', // invalid
        startDate: '2026-06-15',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /cards/statements/:id/pay', () => {
  it('pays a statement and returns 200', async () => {
    const { app } = buildTestApp(freshSeed());

    // First create a purchase to generate a statement
    const purchaseRes = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Compra para pagar',
        amountCents: 500_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    expect(purchaseRes.statusCode).toBe(201);

    // Find the statement
    const stmtRes = await app.inject({
      method: 'GET',
      url: `/cards/statements?accountId=${CARD_A1.id}`,
      headers: auth(TOKEN_A),
    });
    const statementId = stmtRes.json().items[0].id;

    // Pay it
    const payRes = await app.inject({
      method: 'POST',
      url: `/cards/statements/${statementId}/pay`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        amountCents: 500_00,
        fromAccountId: ACCOUNT_A1.id,
      },
    });
    expect(payRes.statusCode).toBe(200);
    const paid = payRes.json();
    expect(paid.paidCents).toBe(500_00);
    expect(paid.status).toBe('paid');
  });

  it('returns 400 when paying from a credit card account', async () => {
    const { app } = buildTestApp(freshSeed());

    // Create a purchase first
    const _purchaseRes = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Compra',
        amountCents: 200_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });
    const stmtRes = await app.inject({
      method: 'GET',
      url: `/cards/statements?accountId=${CARD_A1.id}`,
      headers: auth(TOKEN_A),
    });
    const statementId = stmtRes.json().items[0].id;

    const res = await app.inject({
      method: 'POST',
      url: `/cards/statements/${statementId}/pay`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        amountCents: 200_00,
        fromAccountId: CARD_A1.id, // paying from credit card — invalid
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for non-existent statement', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards/statements/00000000-0000-0000-0000-000000000000/pay',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        amountCents: 100_00,
        fromAccountId: ACCOUNT_A1.id,
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /cards', () => {
  it('creates a credit card account and returns 201', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        name: 'Novo Cartão',
        creditLimitCents: 10_000_00,
        closingDay: 20,
        dueDay: 5,
      },
    });
    expect(res.statusCode).toBe(201);
    const card = res.json();
    expect(card.name).toBe('Novo Cartão');
    expect(card.kind).toBe('credit_card');
    expect(card.creditLimitCents).toBe(10_000_00);
    expect(card.closingDay).toBe(20);
    expect(card.dueDay).toBe(5);
    expect(card.status).toBe('active');
  });

  it('persists presentation ids while preserving card financial values', async () => {
    const { app } = buildTestApp(freshSeed());
    const created = await app.inject({
      method: 'POST', url: '/cards',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { name: 'Presented card', creditLimitCents: 120000, closingDay: 20, dueDay: 5, institutionId: 'bank.x', cardProductId: 'visa.gold' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ institutionId: 'bank.x', cardProductId: 'visa.gold', creditLimitCents: 120000, balanceCents: 0 });
    const list = await app.inject({ method: 'GET', url: '/cards/accounts', headers: auth(TOKEN_A) });
    expect(list.json().items.find((x: { id: string }) => x.id === created.json().id)).toMatchObject({ institutionId: 'bank.x', cardProductId: 'visa.gold', creditLimitCents: 120000, balanceCents: 0 });
    const patch = async (body: object) => app.inject({ method: 'PATCH', url: `/cards/${created.json().id}`, headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' }, payload: body });
    const set = await patch({ institutionId: 'bank.y' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ institutionId: 'bank.y', creditLimitCents: 120000, balanceCents: 0 });
    const clear = await patch({ institutionId: null, cardProductId: null });
    expect(clear.json()).toMatchObject({ institutionId: null, cardProductId: null, creditLimitCents: 120000, balanceCents: 0 });
    const invalid = await app.inject({ method: 'POST', url: '/cards', headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID() }, payload: { name: 'bad', creditLimitCents: 1, closingDay: 1, dueDay: 2, institutionId: 'Bad ID' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('lists the new card via GET /cards/accounts', async () => {
    const { app } = buildTestApp(freshSeed());
    const existingCount = (await app.inject({
      method: 'GET', url: '/cards/accounts', headers: auth(TOKEN_A),
    })).json().items.length;

    await app.inject({
      method: 'POST',
      url: '/cards',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { name: 'Novo', creditLimitCents: 5_000_00, closingDay: 10, dueDay: 20 },
    });

    const list = await app.inject({
      method: 'GET', url: '/cards/accounts', headers: auth(TOKEN_A),
    });
    expect(list.json().items).toHaveLength(existingCount + 1);
  });

  it('scopes to household', async () => {
    const { app } = buildTestApp(freshSeed());
    await app.inject({
      method: 'POST',
      url: '/cards',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { name: 'Cartão A', creditLimitCents: 3_000_00, closingDay: 5, dueDay: 15 },
    });
    const bList = await app.inject({
      method: 'GET', url: '/cards/accounts', headers: auth(TOKEN_B),
    });
    expect(bList.json().items).toHaveLength(0);
  });

  it('requires auth', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: { 'Content-Type': 'application/json' },
      payload: { name: 'X', creditLimitCents: 100_00, closingDay: 1, dueDay: 10 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('validates required fields', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'POST',
      url: '/cards',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /cards/:id', () => {
  it('updates card name and returns 200', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { name: 'Novo Nome' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Novo Nome');
    expect(res.json().kind).toBe('credit_card');
  });

  it('updates credit limit', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { creditLimitCents: 8_000_00 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().creditLimitCents).toBe(8_000_00);
  });

  it('updates closingDay and dueDay', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { closingDay: 1, dueDay: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().closingDay).toBe(1);
    expect(res.json().dueDay).toBe(10);
  });

  it('updates multiple fields at once', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { name: 'Updated', creditLimitCents: 12_000_00, closingDay: 5, dueDay: 15 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Updated');
    expect(res.json().creditLimitCents).toBe(12_000_00);
    expect(res.json().closingDay).toBe(5);
    expect(res.json().dueDay).toBe(15);
  });

  it('returns 404 for non-existent card', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'PATCH',
      url: '/cards/00000000-0000-4000-8000-000000000000',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for empty body', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('scopes to household', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: { ...auth(TOKEN_B), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'PATCH',
      url: `/cards/${CARD_A1.id}`,
      headers: { 'Content-Type': 'application/json' },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /cards/statements/:id (detail)', () => {
  it('returns statement detail with purchases', async () => {
    const { app } = buildTestApp(freshSeed());

    // Create a purchase
    await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Mercado',
        amountCents: 150_00,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });

    // Find the statement
    const stmtRes = await app.inject({
      method: 'GET',
      url: `/cards/statements?accountId=${CARD_A1.id}`,
      headers: auth(TOKEN_A),
    });
    const statementId = stmtRes.json().items[0].id;

    // Get detail
    const detailRes = await app.inject({
      method: 'GET',
      url: `/cards/statements/${statementId}`,
      headers: auth(TOKEN_A),
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.purchases).toHaveLength(1);
    expect(detail.purchases[0].description).toBe('Mercado');
    expect(detail.purchases[0].amountCents).toBe(150_00);
    expect(detail.totalCents).toBe(150_00);
    expect(detail.status).toMatch(/open|closed|overdue/);
  });

  it('returns 404 for non-existent statement', async () => {
    const { app } = buildTestApp(freshSeed());
    const res = await app.inject({
      method: 'GET',
      url: '/cards/statements/00000000-0000-0000-0000-000000000000',
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns purchases from card_purchases table (legacy primary source)', async () => {
    const seed = {
      accounts: [ACCOUNT_A1, ACCOUNT_A2, CARD_A1],
      categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A],
      transactions: [],
    };
    const { app, state } = buildTestApp(seed);

    const stmt = {
      id: '00000000-0000-4000-8000-000000008888',
      householdId: HOUSEHOLD_A,
      accountId: CARD_A1.id,
      cycleYearMonth: '2026-07',
      closingDate: '2026-07-15',
      dueDate: '2026-07-25',
      totalCents: 777_40,
      paidCents: 0,
      status: 'open' as const,
    };
    (state as any)._statements!.push(stmt);

    // Seed card_purchases directly (legacy Agent Pi source).
    // These match the statement but are NOT in transactions table.
    (state as any)._cardPurchases!.push({
      id: 'cp-0001',
      statementId: stmt.id,
      description: 'Compra legada 1',
      amountCents: 50_00,
      date: '2026-07-05',
      categoryId: CATEGORY_FOOD_A.id,
      categoryName: 'Alimentação',
    }, {
      id: 'cp-0002',
      statementId: stmt.id,
      description: 'Compra legada 2',
      amountCents: 27_40,
      date: '2026-07-10',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/cards/statements/${stmt.id}`,
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.purchases).toHaveLength(2);
    expect(detail.purchases[0].description).toBe('Compra legada 1');
    expect(detail.purchases[0].amountCents).toBe(50_00);
    expect(detail.purchases[1].description).toBe('Compra legada 2');
    expect(detail.purchases[1].amountCents).toBe(27_40);
    expect(detail.totalCents).toBe(777_40);
  });

  it('returns purchases via legacy fallback when transactions lack statement_id', async () => {
    const seed = {
      accounts: [ACCOUNT_A1, ACCOUNT_A2, CARD_A1],
      categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A],
      transactions: [
        {
          id: 'tx-fallback-1',
          householdId: HOUSEHOLD_A,
          kind: 'expense' as const,
          description: 'Compra sem statement_id',
          amountCents: 1_200_00,
          date: '2026-07-10',
          accountId: CARD_A1.id,
          categoryId: CATEGORY_FOOD_A.id,
        },
      ],
    };
    const { app, state } = buildTestApp(seed);

    // Add a statement directly to the in-memory store's internal state.
    // This simulates a legacy scenario where the statement exists with totalCents
    // but its purchases were never linked via statement_id.
    const stmt = {
      id: '00000000-0000-4000-8000-000000007777',
      householdId: HOUSEHOLD_A,
      accountId: CARD_A1.id,
      cycleYearMonth: '2026-07',
      closingDate: '2026-07-15',
      dueDate: '2026-07-25',
      totalCents: 1_200_00,
      paidCents: 0,
      status: 'open' as const,
    };
    (state as any)._statements!.push(stmt);

    const res = await app.inject({
      method: 'GET',
      url: `/cards/statements/${stmt.id}`,
      headers: auth(TOKEN_A),
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.purchases).toHaveLength(1);
    expect(detail.purchases[0].description).toBe('Compra sem statement_id');
    expect(detail.purchases[0].amountCents).toBe(1_200_00);
    expect(detail.totalCents).toBe(1_200_00);
  });

  it('still returns linked purchases when statement_id exists (no fallback needed)', async () => {
    const { app } = buildTestApp(freshSeed());

    // Create a purchase via API — this links statement_id
    await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: {
        accountId: CARD_A1.id,
        description: 'Compra com statement_id',
        amountCents: 999_99,
        date: '2026-06-10',
        categoryId: CATEGORY_FOOD_A.id,
      },
    });

    // Find the statement
    const stmtRes = await app.inject({
      method: 'GET',
      url: `/cards/statements?accountId=${CARD_A1.id}`,
      headers: auth(TOKEN_A),
    });
    const statementId = stmtRes.json().items[0].id;

    // Get detail
    const detailRes = await app.inject({
      method: 'GET',
      url: `/cards/statements/${statementId}`,
      headers: auth(TOKEN_A),
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.purchases).toHaveLength(1);
    expect(detail.purchases[0].description).toBe('Compra com statement_id');
  });
});

describe('DELETE /cards/purchases/:id', () => {
  it('cancels an active purchase, removes it from statement and is idempotent', async () => {
    const { app } = buildTestApp(freshSeed());
    const create = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { accountId: CARD_A1.id, description: 'Compra cancelável', amountCents: 123_45, date: openPurchaseDate(), categoryId: CATEGORY_FOOD_A.id },
    });
    expect(create.statusCode).toBe(201);
    const purchaseId = create.json().items[0].id;
    const stmtId = (await app.inject({ method: 'GET', url: `/cards/statements?accountId=${CARD_A1.id}`, headers: auth(TOKEN_A) })).json().items[0].id;

    const first = await app.inject({ method: 'DELETE', url: `/cards/purchases/${purchaseId}`, headers: auth(TOKEN_A) });
    expect(first.statusCode).toBe(200);
    expect(first.json().id).toBe(purchaseId);
    expect(first.json().receipt.mutationKind).toBe('transaction.delete');
    const detail = await app.inject({ method: 'GET', url: `/cards/statements/${stmtId}`, headers: auth(TOKEN_A) });
    expect(detail.json().purchases).toHaveLength(0);
    expect(detail.json().totalCents).toBe(0);

    const second = await app.inject({ method: 'DELETE', url: `/cards/purchases/${purchaseId}`, headers: auth(TOKEN_A) });
    expect(second.statusCode).toBe(200);
  });

  it('returns 404 when cancelling a purchase from another household', async () => {
    const { app } = buildTestApp(freshSeed());
    const create = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { accountId: CARD_A1.id, description: 'Compra A', amountCents: 50_00, date: '2026-06-10', categoryId: CATEGORY_FOOD_A.id },
    });
    const purchaseId = create.json().items[0].id;
    const res = await app.inject({ method: 'DELETE', url: `/cards/purchases/${purchaseId}`, headers: auth(TOKEN_B) });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when invoice is not open', async () => {
    const { app } = buildTestApp(freshSeed());
    const create = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { accountId: CARD_A1.id, description: 'Compra paga', amountCents: 100_00, date: openPurchaseDate(), categoryId: CATEGORY_FOOD_A.id },
    });
    const purchaseId = create.json().items[0].id;
    const stmtId = (await app.inject({ method: 'GET', url: `/cards/statements?accountId=${CARD_A1.id}`, headers: auth(TOKEN_A) })).json().items[0].id;
    // Pay statement to close it
    const pay = await app.inject({
      method: 'POST',
      url: `/cards/statements/${stmtId}/pay`,
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { amountCents: 100_00, fromAccountId: ACCOUNT_A1.id },
    });
    expect(pay.statusCode).toBe(200);
    const del = await app.inject({ method: 'DELETE', url: `/cards/purchases/${purchaseId}`, headers: auth(TOKEN_A) });
    expect(del.statusCode).toBe(409);
  });

  it('hides canceled purchases from statement detail', async () => {
    const { app } = buildTestApp(freshSeed());
    const _c1 = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { accountId: CARD_A1.id, description: 'Manter', amountCents: 70_00, date: openPurchaseDate(), categoryId: CATEGORY_FOOD_A.id },
    });
    const c2 = await app.inject({
      method: 'POST',
      url: '/cards/purchases',
      headers: { ...auth(TOKEN_A), 'idempotency-key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      payload: { accountId: CARD_A1.id, description: 'Cancelar', amountCents: 30_00, date: openPurchaseDate(), categoryId: CATEGORY_FOOD_A.id },
    });
    const cancelId = c2.json().items[0].id;
    await app.inject({ method: 'DELETE', url: `/cards/purchases/${cancelId}`, headers: auth(TOKEN_A) });
    const stmtId = (await app.inject({ method: 'GET', url: `/cards/statements?accountId=${CARD_A1.id}`, headers: auth(TOKEN_A) })).json().items[0].id;
    const detail = await app.inject({ method: 'GET', url: `/cards/statements/${stmtId}`, headers: auth(TOKEN_A) });
    expect(detail.json().purchases.map((p: any) => p.description)).toEqual(['Manter']);
    expect(detail.json().totalCents).toBe(70_00);
  });
});
