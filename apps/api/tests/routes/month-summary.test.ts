import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A, TOKEN_B } from '../test-app.js';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CATEGORY_FOOD_A,
  CATEGORY_FOOD_B,
  CATEGORY_RENT_A,
  CATEGORY_SALARY_A,
  TRANSACTIONS,
} from '../fixtures/seed.js';

describe('GET /dashboard/month-summary', () => {
  it('opts into competencia by excluding statement payments and rejects unknown bases', async () => {
    const transactions = TRANSACTIONS.map((transaction, index) => index === 1
      ? { ...transaction, statementPaymentId: 'statement-1' } as typeof transaction
      : transaction);
    const { app } = buildTestApp({
      accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
      categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A, CATEGORY_FOOD_B],
      transactions,
    });
    const headers = { 'x-device-token': TOKEN_A };
    const defaultResponse = await app.inject({ method: 'GET', url: '/dashboard/month-summary?yearMonth=2026-06', headers });
    expect(defaultResponse.json()).toEqual({ yearMonth: '2026-06', incomeCents: 1_200_000, expenseCents: 288_050, balanceCents: 911_950, transactionCount: 4 });

    const competencyResponse = await app.inject({ method: 'GET', url: '/dashboard/month-summary?yearMonth=2026-06&basis=competencia', headers });
    expect(competencyResponse.json()).toEqual({ yearMonth: '2026-06', incomeCents: 1_200_000, expenseCents: 48_050, balanceCents: 1_151_950, transactionCount: 3 });

    const invalidBasis = await app.inject({ method: 'GET', url: '/dashboard/month-summary?yearMonth=2026-06&basis=invalid', headers });
    expect(invalidBasis.statusCode).toBe(400);
    expect(invalidBasis.json().code).toBe('validation.error');
  });

  it('requires yearMonth instead of accepting period as its substitute', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/month-summary?period=2026-09',
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(response.statusCode).toBe(400);
  });
  it('summarizes only the requested month and authenticated workspace', async () => {
    const { app } = buildTestApp({
      accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
      categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A, CATEGORY_FOOD_B],
      transactions: TRANSACTIONS,
    });

    const juneA = await app.inject({
      method: 'GET',
      url: '/dashboard/month-summary?yearMonth=2026-06',
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(juneA.statusCode).toBe(200);
    expect(juneA.json()).toMatchObject({
      yearMonth: '2026-06',
      incomeCents: 1_200_000,
      expenseCents: 288_050,
      balanceCents: 911_950,
      transactionCount: 4,
    });

    const juneB = await app.inject({
      method: 'GET',
      url: '/dashboard/month-summary?yearMonth=2026-06',
      headers: { 'x-device-token': TOKEN_B },
    });
    expect(juneB.statusCode).toBe(200);
    expect(juneB.json()).toMatchObject({ incomeCents: 0, expenseCents: 20_000, transactionCount: 1 });

    const invalid = await app.inject({
      method: 'GET',
      url: '/dashboard/month-summary?yearMonth=2026-13',
      headers: { 'x-device-token': TOKEN_A },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
