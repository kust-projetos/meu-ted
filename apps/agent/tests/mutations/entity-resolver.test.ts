import { describe, expect, it } from 'vitest';
import {
  resolveMutationEntities,
  type EntityReader,
  type ResolvableMutation,
} from '../../src/mutations/entity-resolver.js';

const ACCOUNT_NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ACCOUNT_ITAU = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
const CATEGORY_MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };
const CATEGORY_ALIMENTACAO = { id: '00000000-0000-4000-8000-000000000012', name: 'Alimentação' };
const CATEGORY_CARNE = { id: '00000000-0000-4000-8000-000000000014', name: 'Carne' };
const CATEGORY_CARNE_BOVINA = { id: '00000000-0000-4000-8000-000000000015', name: 'Carne Bovina' };

const reader = (
  accounts: { id: string; name: string }[] = [],
  categories: { id: string; name: string }[] = [],
): EntityReader => ({
  listAccounts: async () => accounts,
  listCategories: async () => categories,
});

const parsed = (overrides: Partial<ResolvableMutation> = {}): ResolvableMutation => ({
  kind: 'expense',
  amountCents: 5000,
  description: 'mercado',
  date: '2026-09-14',
  ...overrides,
});

describe('entity-resolver (SPEC §7.2/§7.3/§7.6, H-01)', () => {
  it('RED: multiple accounts without a hint stay unresolved with real missingFields', async () => {
    const result = await resolveMutationEntities(
      parsed(),
      'Gastei R$ 50 no mercado',
      reader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_MERCADO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.clarification).toMatch(/qual conta/i);
      expect(result.clarification).toMatch(/Nubank/);
      expect(result.clarification).toMatch(/Itaú/);
    }
  });

  it('RED: exactly one valid account auto-resolves its authoritative id', async () => {
    const result = await resolveMutationEntities(
      parsed(),
      'Gastei R$ 50 no mercado',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
  });

  it('RED: an explicit unambiguous account indication resolves without guessing', async () => {
    const result = await resolveMutationEntities(
      parsed(),
      'Gastei R$ 50 no mercado no Itaú',
      reader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_MERCADO]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.accountId).toBe(ACCOUNT_ITAU.id);
  });

  it('RED: a categoryQuery with exactly one authoritative match resolves to its real UUID', async () => {
    const result = await resolveMutationEntities(
      parsed({ categoryQuery: 'mercado' }),
      'Gastei R$ 50 no mercado categoria mercado',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, CATEGORY_ALIMENTACAO]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.categoryId).toBe(CATEGORY_MERCADO.id);
  });

  it('RED: a categoryQuery with no match asks for clarification instead of proposing', async () => {
    const result = await resolveMutationEntities(
      parsed({ categoryQuery: 'nave espacial' }),
      'Gastei R$ 50 categoria nave espacial',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('categoryId');
      expect(result.missingFields).not.toContain('accountId');
      expect(result.clarification).toMatch(/categoria/i);
    }
  });

  it('RED: a categoryQuery holding a category UUID resolves by authoritative id', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: CATEGORY_MERCADO.id }),
      `gastei 50 de carne categoria ${CATEGORY_MERCADO.id}`,
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, CATEGORY_ALIMENTACAO]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.categoryId).toBe(CATEGORY_MERCADO.id);
      expect(result.categoryName).toBe(CATEGORY_MERCADO.name);
    }
  });

  it('RED: an ambiguous categoryQuery never picks silently', async () => {
    const result = await resolveMutationEntities(
      parsed({ categoryQuery: 'aliment' }),
      'Gastei R$ 50 categoria aliment',
      reader(
        [ACCOUNT_NUBANK],
        [CATEGORY_ALIMENTACAO, { id: '00000000-0000-4000-8000-000000000013', name: 'Alimentação fora' }],
      ),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.missingFields).toContain('categoryId');
  });
});

/**
 * R03 / AC08 — the transaction description is NOT a category query.
 *
 * "gastei 50 de carne" keeps `carne` as the description; the category is a
 * separate field. Only an explicit `categoryQuery` may be matched fuzzily; the
 * description fallback accepts a literal, fold-exact name match only, so a
 * legitimate catalog hit ("Carne" ↔ "carne") still resolves while a fuzzy
 * inference is never mandatory.
 */
describe('entity-resolver R03: the description is not a category query', () => {
  it('RED: a description with no matching category asks generically instead of quoting the description', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne' }),
      'gastei 50 de carne',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, CATEGORY_ALIMENTACAO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('categoryId');
      expect(result.missingFields).not.toContain('accountId');
      // The description is not a category query, so it must never be reported
      // as a category name that could not be found.
      expect(result.clarification).not.toMatch(/Não encontrei a categoria\s*"carne"/i);
      expect(result.clarification).toMatch(/qual categoria/i);
      expect(result.clarification).toMatch(/Mercado/);
      expect(result.clarification).toMatch(/Alimentação/);
    }
  });

  it('RED: a fold-exact category name equal to the description still resolves', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne' }),
      'gastei 50 de carne',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, CATEGORY_CARNE]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.categoryId).toBe(CATEGORY_CARNE.id);
      expect(result.categoryName).toBe(CATEGORY_CARNE.name);
    }
  });

  it('RED: a description that only matches a category by containment never auto-selects it', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'compras no mercado livre' }),
      'gastei R$ 80 em compras no mercado livre',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, CATEGORY_ALIMENTACAO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('categoryId');
      expect(result.clarification).not.toMatch(/Não encontrei a categoria\s*"compras no mercado livre"/i);
      expect(result.clarification).toMatch(/qual categoria/i);
      expect(result.clarification).toMatch(/Mercado/);
    }
  });

  it('RED: a category contained in the description is a candidate, not a selection', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne' }),
      'gastei 50 de carne',
      reader([ACCOUNT_NUBANK], [CATEGORY_CARNE_BOVINA, CATEGORY_MERCADO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('categoryId');
      expect(result.clarification).not.toMatch(/Não encontrei a categoria\s*"carne"/i);
      expect(result.clarification).toMatch(/Carne Bovina/);
    }
  });

  it('RED: an explicit categoryQuery keeps exact and contained matching', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'mercado' }),
      'gastei 50 de carne categoria mercado',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, CATEGORY_ALIMENTACAO]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.categoryId).toBe(CATEGORY_MERCADO.id);
  });

  it('RED: an explicit categoryQuery keeps fuzzy matching for a partial name', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'aliment' }),
      'gastei 50 de carne categoria aliment',
      reader([ACCOUNT_NUBANK], [CATEGORY_ALIMENTACAO]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.categoryId).toBe(CATEGORY_ALIMENTACAO.id);
  });
});
