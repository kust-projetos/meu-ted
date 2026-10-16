import { describe, expect, it, vi } from 'vitest';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { createLegacyPostgresCardStore } from '../../src/cards/legacy-postgres.js';

const HOUSEHOLD_A = '00000000-0000-4000-8000-00000000000a';
const _HOUSEHOLD_B = '00000000-0000-4000-8000-00000000000b';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111114';
const CATEGORY_B = '22222222-2222-4222-8222-222222222224';
const STATEMENT_ID = '33333333-3333-4333-8333-333333333301';

const fakePool = (query: ReturnType<typeof vi.fn>) => ({
  query,
  connect: async () => ({
    query: async (text: string, values?: unknown[]) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim().toUpperCase())) return { rows: [], rowCount: 0 };
      return query(text, values);
    },
    release: vi.fn(),
  }),
});

describe('card store category IDOR protection', () => {
  it.each([
    ['canonical', createPostgresCardStore],
    ['legacy', createLegacyPostgresCardStore],
  ])('rejects a category from another household in %s store', async (_name, createStore) => {
    // FIX-WS-D2-R2 item 2: a guarda de lifecycle responde active; o
    // downstream IDOR (categoria de outro household) segue 404.
    const query = vi.fn(async (text: string) => {
      if (typeof text === 'string' && text.includes('FROM households')) {
        return { rows: [{ status: 'active' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = createStore(fakePool(query) as never);

    await expect(store.createCardPurchase(HOUSEHOLD_A, {
      accountId: ACCOUNT_ID,
      categoryId: CATEGORY_B,
      description: 'cross-household category',
      amountCents: 1000,
      date: '2026-07-15',
    })).rejects.toMatchObject({ code: 'not_found' });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('household_id = $2'),
      [CATEGORY_B, HOUSEHOLD_A],
    );
  });

  it.each([
    ['canonical', createPostgresCardStore],
    ['legacy', createLegacyPostgresCardStore],
  ])('rejects a recurring purchase account from another household in %s store', async (_name, createStore) => {
    // FIX-WS-D2-R2 item 2: a guarda de lifecycle responde active; o
    // downstream IDOR (conta de outro household) segue 404.
    const query = vi.fn(async (text: string) => {
      if (typeof text === 'string' && text.includes('FROM households')) {
        return { rows: [{ status: 'active' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = createStore(fakePool(query) as never);

    await expect(store.createRecurringPurchase(HOUSEHOLD_A, {
      accountId: ACCOUNT_ID,
      description: 'cross-household recurring purchase',
      amountCents: 1000,
      frequency: 'monthly',
      startDate: '2026-07-15',
    })).rejects.toMatchObject({ code: 'not_found' });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('household_id = $2'),
      [ACCOUNT_ID, HOUSEHOLD_A],
    );
  });

  it('canonical update rejects a foreign purchase without querying the legacy table', async () => {
    // FIX-WS-D2-R2 item 2: a guarda de lifecycle responde active (1ª
    // query); o peek do downstream segue 404 sem tocar em card_purchases.
    const query = vi.fn(async (text: string) => {
      if (typeof text === 'string' && text.includes('FROM households')) {
        return { rows: [{ status: 'active' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = createPostgresCardStore(fakePool(query) as never);

    await expect(store.updatePurchase(HOUSEHOLD_A, 'foreign-purchase-id', {
      description: 'attempted update',
    })).rejects.toMatchObject({ code: 'not_found' });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('FROM households');
    expect(query.mock.calls[1]?.[0]).not.toContain('card_purchases');
  });

  it('does not return a foreign category id from the canonical statement read', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: STATEMENT_ID,
        household_id: HOUSEHOLD_A,
        account_id: ACCOUNT_ID,
        cycle_year_month: '2026-07',
        closing_date: new Date('2026-07-15T00:00:00Z'),
        due_date: new Date('2026-07-25T00:00:00Z'),
        total_cents: 1000,
        paid_cents: 0,
        status: 'open',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: '44444444-4444-4444-8444-444444444444',
        description: 'legacy purchase',
        amount_cents: 1000,
        date: new Date('2026-07-10T00:00:00Z'),
        category_id: null,
        category_name: null,
        installments_total: null,
        installment_number: null,
      }] });
    const store = createPostgresCardStore(fakePool(query) as never);

    const detail = await store.getStatementDetail(HOUSEHOLD_A, STATEMENT_ID);

    expect(detail?.purchases[0]?.categoryId).toBeUndefined();
    expect(query.mock.calls[1]?.[0]).toContain('c.id AS category_id');
  });

  it('does not return a foreign category id from the legacy statement read', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: STATEMENT_ID,
        household_id: HOUSEHOLD_A,
        account_id: ACCOUNT_ID,
        cycle_year_month: '2026-07',
        closing_date: new Date('2026-07-15T00:00:00Z'),
        due_date: new Date('2026-07-25T00:00:00Z'),
        total_cents: 1000,
        paid_cents: 0,
        status: 'open',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: '44444444-4444-4444-8444-444444444444',
        description: 'legacy purchase',
        amount_cents: 1000,
        date: '2026-07-10',
        category_id: null,
        category_name: null,
        installments_total: null,
        installment_number: null,
      }] });
    const store = createLegacyPostgresCardStore({ query } as never);

    const detail = await store.getStatementDetail(HOUSEHOLD_A, STATEMENT_ID);

    expect(detail?.purchases[0]?.categoryId).toBeUndefined();
    expect(query.mock.calls[1]?.[0]).toContain('c.id AS category_id');
  });
});
