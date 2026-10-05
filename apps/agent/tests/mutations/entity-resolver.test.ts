import { describe, expect, it } from 'vitest';
import {
  normalizeEntities,
  resolveMutationEntities,
  revalidateResolvedEntities,
  type EntityReader,
  type EntityResolution,
  type EntitySummary,
  type ResolvableMutation,
} from '../../src/mutations/entity-resolver.js';
import { interpretMutationUtterance } from '../../src/mutations/semantic-interpretation.js';

const ACCOUNT_NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ACCOUNT_ITAU = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
const CATEGORY_MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };
const CATEGORY_ALIMENTACAO = { id: '00000000-0000-4000-8000-000000000012', name: 'Alimentação' };
const CATEGORY_CARNE = { id: '00000000-0000-4000-8000-000000000014', name: 'Carne' };
const CATEGORY_CARNE_BOVINA = { id: '00000000-0000-4000-8000-000000000015', name: 'Carne Bovina' };

const reader = (
  accounts: EntitySummary[] = [],
  categories: EntitySummary[] = [],
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

/**
 * A08 / R08 — ordem de resolução e revalidação.
 *
 * Ordem real: escolha explícita do turno > alias confirmado no escopo > match
 * determinístico > ranking semântico entre candidatos ATUAIS > esclarecimento.
 * Uma referência (alias/UUID) que não verifica mais é INVALIDADA e nunca usada;
 * a resolução continua pela ordem, sem estado global novo.
 */
describe('entity-resolver A08 (R08): ordem de resolução', () => {
  const REMOVED = '00000000-0000-4000-8000-0000000000ff';
  const SCOPE = 'workspace-authenticated';
  const OTHER_SCOPE = 'workspace-other';
  const INACTIVE_PJ = '00000000-0000-4000-8000-0000000000bb';
  // `householdId` is the scope field the authoritative read really carries;
  // `scopeId` is the already-normalized form of the SAME axis. Both must
  // survive every re-normalization (the resolver normalizes twice).
  const scopedReader = (
    accounts: { id: string; name: string; status?: string; householdId?: string; scopeId?: string }[],
    categories: { id: string; name: string; status?: string; householdId?: string; scopeId?: string }[] = [],
  ): EntityReader => ({
    scope: { workspaceId: SCOPE },
    listAccounts: async () => accounts,
    listCategories: async () => categories,
  });

  it('RED: alias confirmado para id removido é invalidado e a resolução continua pela ordem', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne categoria carne',
      reader([ACCOUNT_ITAU], [CATEGORY_CARNE]),
      { confirmed: { accountId: REMOVED } },
    );
    // The dead alias is never used: the next tier (single current account) wins.
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.accountId).toBe(ACCOUNT_ITAU.id);
      expect(result.trace.account.source).toBe('deterministic');
      expect(result.trace.account.invalidated).toContain('confirmed_account_id');
    }
  });

  it('RED: alias confirmado fora do escopo do workspace é invalidado, e a linha estrangeira nunca é candidata', async () => {
    const foreign = { id: REMOVED, name: 'Nubank PJ', householdId: OTHER_SCOPE };
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank PJ categoria carne',
      scopedReader([foreign, ACCOUNT_ITAU], [CATEGORY_CARNE]),
      { confirmed: { accountId: REMOVED } },
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.accountId).toBe(ACCOUNT_ITAU.id);
      expect(result.trace.account.invalidated).toContain('confirmed_account_id');
      // The out-of-scope name is never offered as an option either.
      expect(result.trace.account.homonyms).not.toContain('Nubank PJ');
    }
  });

  it('RED: alias confirmado para conta inativa é invalidado e o texto que a nomeia pede decisão visível', async () => {
    const inactive = { ...ACCOUNT_NUBANK, status: 'inactive' };
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank categoria carne',
      reader([inactive, ACCOUNT_ITAU], [CATEGORY_CARNE]),
      { confirmed: { accountId: ACCOUNT_NUBANK.id } },
    );
    // Naming an unusable account never silently redirects to another one.
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.clarification).toMatch(/Nubank/);
      expect(result.clarification).not.toMatch(new RegExp(ACCOUNT_NUBANK.id));
      expect(result.trace.account.invalidated).toContain('confirmed_account_id');
    }
  });

  it('RED: alias confirmado para categoria removida é invalidado e re-resolvido pelo match determinístico atual', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne' }),
      'gastei 50 de carne',
      reader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
      { confirmed: { categoryId: REMOVED } },
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.categoryId).toBe(CATEGORY_CARNE.id);
      expect(result.trace.category.source).toBe('deterministic');
      expect(result.trace.category.invalidated).toContain('confirmed_category_id');
    }
  });

  it('RED: um id de categoria declarado que não existe mais é invalidado e vira pergunta, nunca proposta', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: REMOVED }),
      `gastei 50 de carne categoria ${REMOVED}`,
      reader([ACCOUNT_NUBANK], [CATEGORY_CARNE, CATEGORY_MERCADO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('categoryId');
      expect(result.trace.category.invalidated).toContain('explicit_category_id');
      // The user is told the referenced category is gone — never the dead id.
      expect(result.clarification).toMatch(/não está mais disponível/i);
      expect(result.clarification).not.toMatch(new RegExp(REMOVED));
      expect(result.clarification).toMatch(/Carne/);
    }
  });

  it('RED: a escolha explícita do turno vence o alias confirmado, e o conflito fica registrado', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'mercado' }),
      'Gastei R$ 50 no mercado no Nubank',
      reader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_MERCADO]),
      { confirmed: { accountId: ACCOUNT_ITAU.id } },
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
      expect(result.trace.account.source).toBe('explicit');
      expect(result.trace.account.overrode).toBe('confirmed_account_id');
    }
  });

  it('RED: homônimos continuam visíveis e nunca viram escolha silenciosa, mesmo com alias confirmado', async () => {
    const homonym = { id: '00000000-0000-4000-8000-000000000003', name: 'Nubank PJ' };
    const result = await resolveMutationEntities(
      parsed({ description: 'mercado' }),
      'Gastei R$ 50 no mercado no Nubank PJ',
      reader([ACCOUNT_NUBANK, homonym], [CATEGORY_MERCADO]),
      { confirmed: { accountId: homonym.id } },
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.clarification).toMatch(/Nubank/);
      expect(result.clarification).toMatch(/Nubank PJ/);
      expect(result.trace.account.homonyms).toEqual(['Nubank', 'Nubank PJ']);
    }
  });

  // FIX 1 (HIGH): normalização idempotente. `normalizeEntities` produz
  // `scopeId`, mas o resolver normaliza DE NOVO o que o reader já entregou:
  // uma `EntitySummary` pré-normalizada perdia o escopo e passava pelo
  // `isOutOfScope`. As DUAS formas que o leitor pode devolver são testadas.
  it('RED: payload cru da API com householdId estrangeiro é rejeitado mesmo escopando o reader', async () => {
    const foreign = { id: REMOVED, name: 'Nubank PJ', householdId: OTHER_SCOPE };
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank PJ categoria carne',
      scopedReader([foreign, ACCOUNT_ITAU], [CATEGORY_CARNE]),
      { confirmed: { accountId: REMOVED } },
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.accountId).toBe(ACCOUNT_ITAU.id);
      expect(result.trace.account.homonyms).not.toContain('Nubank PJ');
    }
  });

  it('RED: EntitySummary já normalizada (scopeId) sobrevive à segunda normalização e a linha estrangeira é rejeitada', async () => {
    // Esta é a contraforma exata do reviewer: o reader devolve o tipo já
    // normalizado, e a re-normalização do resolver não pode apagar o escopo.
    const foreign = { id: REMOVED, name: 'Nubank PJ', scopeId: OTHER_SCOPE };
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank PJ categoria carne',
      scopedReader([foreign, ACCOUNT_ITAU], [CATEGORY_CARNE]),
      { confirmed: { accountId: REMOVED } },
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.accountId).toBe(ACCOUNT_ITAU.id);
      // A entidade estrangeira nunca é resolvida NEM nomeada ao usuário.
      expect(result.trace.account.homonyms).not.toContain('Nubank PJ');
      expect(result.trace.account.invalidated).toContain('confirmed_account_id');
    }
  });

  it('RED: categoria estrangeira já normalizada também é rejeitada pela renormalização', async () => {
    const foreignCategory = { id: CATEGORY_MERCADO.id, name: 'Mercado', scopeId: OTHER_SCOPE };
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne categoria carne',
      scopedReader([ACCOUNT_ITAU], [foreignCategory, CATEGORY_CARNE]),
      { confirmed: { categoryId: CATEGORY_MERCADO.id } },
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      // A categoria confirmada é estrangeira: nunca resolvida.
      expect(result.categoryId).not.toBe(CATEGORY_MERCADO.id);
      expect(result.categoryId).toBe(CATEGORY_CARNE.id);
      expect(result.trace.category.invalidated).toContain('confirmed_category_id');
    }
  });

  // FIX 2 (HIGH): referência ESPECÍFICA a uma conta indisponível não pode ser
  // trocada silenciosamente por um match ativo menos específico. "Nubank PJ"
  // (inativa) é citada nominalmente pelo usuário; "Nubank" (ativa) só casa por
  // substring e NÃO pode vencer com `complete: true`.
  it('RED: referência específica a conta inativa não é trocada por match ativo menos específico', async () => {
    const inactivePj = { id: INACTIVE_PJ, name: 'Nubank PJ', status: 'inactive' };
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank PJ categoria carne',
      reader([ACCOUNT_NUBANK, inactivePj], [CATEGORY_CARNE]),
    );
    // Nunca `complete: true` na conta errada.
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      // Esclarece NOMINANDO a indisponível, visível e sem o UUID.
      expect(result.clarification).toMatch(/Nubank PJ/);
      expect(result.clarification).toMatch(/não está mais disponível/i);
      expect(result.clarification).not.toMatch(new RegExp(INACTIVE_PJ));
      // O offer lista as contas utilizáveis para a escolha seguinte.
      expect(result.clarification).toMatch(/Nubank/);
    }
  });

  it('RED: o inverso — "Nubank" ativo único continua resolvendo mesmo com "Nubank PJ" inativa no catálogo', async () => {
    const inactivePj = { id: INACTIVE_PJ, name: 'Nubank PJ', status: 'inactive' };
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank categoria carne',
      reader([ACCOUNT_NUBANK, inactivePj], [CATEGORY_CARNE]),
    );
    // Match legítimo por nome exato não pode ser quebrado pela regra acima.
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
  });

  // FIX 3 (MEDIUM + tester #3): a categoria CONFIRMADA válida vence o ranking
  // semântico. Antes, um `categoryQuery` sem match determinístico pulava direto
  // para semântico/esclarecimento e ignorava a decisão já confirmada.
  it('RED: categoria confirmada válida vence o ranking semântico quando a query não casa deterministicamente', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'feira', categoryQuery: 'feira de ferment' }),
      'gastei 50 de feira categoria feira de ferment',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, { id: '00000000-0000-4000-8000-000000000021', name: 'Fermentados' }]),
      { confirmed: { categoryId: CATEGORY_MERCADO.id } },
    );
    // A decisão confirmada é reaberta apenas por escolha explícita do turno.
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.categoryId).toBe(CATEGORY_MERCADO.id);
      expect(result.trace.category.source).toBe('confirmed_alias');
    }
  });

  it('RED: conflito explícito × confirmada na categoria registra overrode no eixo da categoria', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne bovina' }),
      'gastei 50 de carne categoria carne bovina',
      reader([ACCOUNT_NUBANK], [CATEGORY_CARNE, CATEGORY_CARNE_BOVINA]),
      { confirmed: { categoryId: CATEGORY_CARNE.id } },
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.categoryId).toBe(CATEGORY_CARNE_BOVINA.id);
      expect(result.trace.category.source).toBe('explicit');
      // Simétrico ao eixo da conta: o conflito fica visível nos DOIS eixos.
      expect(result.trace.category.overrode).toBe('confirmed_category_id');
    }
  });

  it('RED: ranking semântico sem referência segura vira candidata visível, nunca seleção', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'feira', categoryQuery: 'feira de ferment' }),
      'gastei 50 de feira categoria feira de ferment',
      reader([ACCOUNT_NUBANK], [{ id: '00000000-0000-4000-8000-000000000021', name: 'Fermentados' }, CATEGORY_MERCADO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('categoryId');
      expect(result.trace.category.source).toBe('semantic_candidate');
      // Only real, current catalog names are ever offered: no category is invented.
      expect(result.trace.category.homonyms).toEqual(['Fermentados']);
      expect(result.clarification).toMatch(/Fermentados/);
      expect(result.clarification).not.toMatch(/criar (uma )?categoria/i);
    }
  });

  it('RED: a regressão A03 continua valendo — "carne" real declarada resolve como escolha explícita', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne categoria carne',
      reader([ACCOUNT_NUBANK], [CATEGORY_CARNE, CATEGORY_CARNE_BOVINA]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.categoryId).toBe(CATEGORY_CARNE.id);
      expect(result.trace.category.source).toBe('explicit');
      expect(result.trace.category.invalidated).toEqual([]);
    }
  });

  it('RED: a regressão A03 continua valendo — descrição "carne" sem categoria real só esclarece', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne' }),
      'gastei 50 de carne',
      reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, CATEGORY_ALIMENTACAO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('categoryId');
      expect(result.trace.category.source).toBe('clarification');
      // The description is never turned into an inferred/suggested category.
      expect(result.clarification).not.toMatch(/quiser dizer/i);
    }
  });

  it('RED: lista ilegível continua falhando fechado, sem proposta', async () => {
    const failing: EntityReader = {
      listAccounts: async () => { throw new Error('api.request_failed'); },
      listCategories: async () => [CATEGORY_MERCADO],
    };
    const result = await resolveMutationEntities(parsed({ description: 'mercado' }), 'Gastei R$ 50 no mercado', failing);
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.missingFields).toContain('accountId');
  });
});

/**
 * A08 / R08 — revalidação IMEDIATAMENTE antes de propor/executar: existência,
 * atividade e escopo são conferidos de novo no ponto do contrato que escreve.
 */
describe('entity-resolver A08 (R08): revalidação antes do propose', () => {
  /** Account list answers the FIRST read and goes empty afterwards. */
  const aliveThenGone: EntityReader = (() => {
    let accountReads = 0;
    return {
      listAccounts: async () => (accountReads++ === 0 ? [ACCOUNT_NUBANK] : []),
      listCategories: async () => [CATEGORY_MERCADO],
    };
  })();

  const aliveReader: EntityReader = reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]);

  const resolveFirst = async (source: EntityReader): Promise<Extract<EntityResolution, { complete: true }>> => {
    const result = await resolveMutationEntities(parsed({ description: 'mercado' }), 'Gastei R$ 50 no mercado', source);
    if (!result.complete) throw new Error('expected a complete resolution');
    return result;
  };

  it('RED: entidade que sumiu entre a resolução e o propose é recusada pela revalidação', async () => {
    const resolution = await resolveFirst(aliveThenGone);
    const verified = await revalidateResolvedEntities(resolution, aliveThenGone);
    expect(verified.complete).toBe(false);
    if (!verified.complete) {
      expect(verified.missingFields).toContain('accountId');
      expect(verified.trace.account.invalidated).toContain('resolved_account');
    }
  });

  it('RED: entidade ainda viva é revalidada com o rótulo atual e permanece completa', async () => {
    const resolution = await resolveFirst(aliveReader);
    const verified = await revalidateResolvedEntities(resolution, aliveReader);
    expect(verified.complete).toBe(true);
    if (verified.complete) {
      expect(verified.accountId).toBe(ACCOUNT_NUBANK.id);
      expect(verified.accountName).toBe(ACCOUNT_NUBANK.name);
      expect(verified.categoryId).toBe(CATEGORY_MERCADO.id);
    }
  });

  it('RED: categoria inativada antes do propose é recusada pela revalidação', async () => {
    const deactivated: EntityReader = reader([ACCOUNT_NUBANK], [{ ...CATEGORY_MERCADO, status: 'inactive' }]);
    const verified = await revalidateResolvedEntities(await resolveFirst(aliveReader), deactivated);
    expect(verified.complete).toBe(false);
    if (!verified.complete) {
      expect(verified.missingFields).toContain('categoryId');
      expect(verified.trace.category.invalidated).toContain('resolved_category');
      expect(verified.clarification).not.toMatch(CATEGORY_MERCADO.id);
    }
  });

  it('RED: revalidação com lista ilegível falha fechado, sem liberar a escrita', async () => {
    const failing: EntityReader = {
      listAccounts: async () => { throw new Error('api.request_failed'); },
      listCategories: async () => [CATEGORY_MERCADO],
    };
    const verified = await revalidateResolvedEntities(await resolveFirst(aliveReader), failing);
    expect(verified.complete).toBe(false);
    if (!verified.complete) expect(verified.missingFields).toContain('accountId');
  });
});

/**
 * A08 / R08 — fail-safe de "referência a entidade indisponível" quando a linha
 * indisponível NÃO chega ao resolver.
 *
 * O leitor de PRODUÇÃO já entrega só linhas utilizáveis: `GET /accounts`
 * filtra no servidor (`WHERE status = 'active' AND deleted_at IS NULL` —
 * `apps/api/src/read-models/postgres-store.ts`). Logo a defesa baseada na
 * LINHA inativa (`unavailableOutranks`) é inerte em produção: com o texto
 * "gastei 50 de carne no Nubank PJ" e o catálogo ativo contendo só "Nubank", o
 * match por substring (`haystack.includes(name)`) resolvia "Nubank" com
 * `complete: true` — o usuário nomeou "Nubank PJ" e a proposta saía em
 * "Nubank". Estes testes fixam o contrato que fecha esse buraco DENTRO do app:
 * um hint explícito que só casa por substring vira esclarecimento.
 */
describe('entity-resolver A08 (R08): reader de produção (só linhas ativas)', () => {
  const INACTIVE_PJ = '00000000-0000-4000-8000-0000000000bb';
  const INACTIVE_TWIN = '00000000-0000-4000-8000-0000000000cc';

  /** Espelha a listagem real: o servidor já devolve apenas linhas ativas. */
  const productionReader = (
    accounts: EntitySummary[],
    categories: EntitySummary[],
  ): EntityReader => ({
    listAccounts: async () => accounts.map((account) => ({ ...account, status: 'active' })),
    listCategories: async () => categories.map((category) => ({ ...category, status: 'active' })),
  });

  it('RED: hint mais específico ("Nubank PJ") sem linha correspondente não vira proposta na conta ativa menos específica', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank PJ categoria carne',
      productionReader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
    );
    // A substituição silenciosa é o defeito: `complete: true` aqui seria uma
    // proposta na conta que o usuário NÃO nomeou.
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.trace.account.source).toBe('clarification');
      // Esclarece com o nome citado e com os candidatos ATUAIS (sem UUID).
      expect(result.clarification).toMatch(/Nubank PJ/);
      expect(result.clarification).toMatch(/Nubank/);
      expect(result.clarification).not.toMatch(new RegExp(ACCOUNT_NUBANK.id));
      // Nenhum id foi resolvido: a decisão continua com o usuário.
      expect(result.trace.account.invalidated).not.toContain('confirmed_account_id');
    }
  });

  it('RED: o mesmo nome folded em linha ativa e inativa nunca vira escolha silenciosa', async () => {
    // Só observável com um reader SINTÉTICO que inclua inativas (o contrato
    // para o dia em que a API expuser indisponíveis ao leitor delegado).
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank categoria carne',
      reader([ACCOUNT_NUBANK, { id: INACTIVE_TWIN, name: 'Nubank', status: 'inactive' }], [CATEGORY_CARNE]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.clarification).toMatch(/não está mais disponível/i);
      expect(result.clarification).not.toMatch(new RegExp(INACTIVE_TWIN));
    }
  });

  it('RED: a conta citada que SÓ existe inativa continua sendo nomeada (defesa por linha preservada)', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank PJ categoria carne',
      reader([ACCOUNT_NUBANK, { id: INACTIVE_PJ, name: 'Nubank PJ', status: 'inactive' }], [CATEGORY_CARNE]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.clarification).toMatch(/Nubank PJ/);
      expect(result.clarification).toMatch(/não está mais disponível/i);
    }
  });

  // --- Regressões que o fail-safe NÃO pode quebrar -------------------------------------

  it('RED: hint exato (fold) continua resolvendo a conta ativa', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no Nubank categoria carne',
      productionReader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_CARNE]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
      expect(result.trace.account.source).toBe('explicit');
    }
  });

  it('RED: A06 — "nubnk"/"nub" normalizados casam exatamente e resolvem', async () => {
    // O resolver recebe em produção o `resolutionText` JÁ normalizado por A06:
    // o token corrigido é o nome inteiro da conta, nunca um prefixo.
    const at = { now: new Date('2026-10-03T12:00:00Z') };
    for (const raw of ['gstei 50 d carne hj no nubnk', 'gastei 50 d carne hj no nub']) {
      const interpretation = interpretMutationUtterance(raw, at);
      expect(interpretation.status).toBe('candidate');
      if (interpretation.status !== 'candidate') return;
      const result = await resolveMutationEntities(
        { ...interpretation.parsed, categoryQuery: 'carne' },
        interpretation.resolutionText,
        productionReader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
      );
      expect(result.complete).toBe(true);
      if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
    }
  });

  it('RED: dinheiro e palavras comuns depois do nome não alongam o hint', async () => {
    for (const text of [
      'gastei 50 no Nubank R$ 50 categoria carne',
      'gastei 50 no Nubank e no mercado categoria carne',
      'gastei 50 no nubank categoria carne',
    ]) {
      const result = await resolveMutationEntities(
        parsed({ description: 'carne', categoryQuery: 'carne' }),
        text,
        productionReader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_CARNE]),
      );
      expect(result.complete).toBe(true);
      if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
    }
  });

  it('RED: pontuação e plural no fim da frase não alongam o hint', async () => {
    // Contraforma exata do falso positivo encontrado ao validar o fail-safe:
    // "no Nubank?" (ponto final) e "nos Nubanks" (plural) são o MESMO nome.
    for (const text of [
      'E se eu registrasse R$ 300 de almoço na categoria Almoço no Nubank?',
      'registrei no Nubanks categoria carne',
    ]) {
      const result = await resolveMutationEntities(
        parsed({ description: 'carne', categoryQuery: 'carne' }),
        text,
        productionReader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
      );
      expect(result.complete).toBe(true);
      if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
    }
  });

  /**
   * Contraexemplos do reviewer (HIGH): a heurística de continuação do run só
   * aceitava maiúscula/dígito, então um sufixo MINÚSCULO ("nubank pj") e um
   * nome ENTRE ASPAS ('no "Nubank PJ"') escapavam do run citado e a conta ativa
   * "Nubank" recebia a proposta silenciosamente — o defeito que a regra R08
   * ("nunca substituir silenciosamente") proíbe.
   */
  it('RED: citação MINÚSCULA mais específica ("no nubank pj") não vira proposta na conta ativa', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no nubank pj categoria carne',
      productionReader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.trace.account.source).toBe('clarification');
      // O nome citado é o do USUÁRIO ("nubank pj"), e a pergunta traz o catálogo atual.
      expect(result.clarification).toMatch(/nubank pj/i);
      expect(result.clarification).toMatch(/Nubank/);
      expect(result.clarification).not.toMatch(new RegExp(ACCOUNT_NUBANK.id));
    }
  });

  it('RED: nome citado ENTRE ASPAS é o run ("no \\"Nubank PJ\\"" / aspas simples) e esclarece', async () => {
    for (const quoted of ['no "Nubank PJ"', "no 'Nubank PJ'"]) {
      const result = await resolveMutationEntities(
        parsed({ description: 'carne', categoryQuery: 'carne' }),
        `gastei 50 de carne ${quoted} categoria carne`,
        productionReader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
      );
      expect(result.complete).toBe(false);
      if (!result.complete) {
        expect(result.missingFields).toContain('accountId');
        expect(result.trace.account.source).toBe('clarification');
        expect(result.clarification).toMatch(/Nubank PJ/);
        expect(result.clarification).not.toMatch(new RegExp(ACCOUNT_NUBANK.id));
      }
    }
  });

  it('RED: o span citado entre aspas NÃO alonga quando é o MESMO nome da ativa', async () => {
    // Contraprova do item 2: aspas só mudam algo quando o span é ≠ a ativa casada
    // e mais longo. `"Nubank"` é o MESMO nome — resolver, não perguntar.
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no "Nubank" categoria carne',
      productionReader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_CARNE]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
  });

  it('RED: alias confirmado apontando para a ativa TAMBÉM é bloqueado por run citado mais longo', async () => {
    // O fall-through para `confirmed_alias` (tier 2) só existe quando o turno
    // NÃO citou nada mais específico: um run citado mais longo também bloqueia
    // o alias, senão o alias vira a saída silenciosa do mesmo defeito.
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne no nubank pj categoria carne',
      productionReader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
      { confirmed: { accountId: ACCOUNT_NUBANK.id } },
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.trace.account.source).toBe('clarification');
      expect(result.clarification).toMatch(/nubank pj/i);
    }
  });

  it('RED: o verbo de mutação TERMINA o run citado (forma canônica A06 continua resolvendo)', async () => {
    // `nubank gastei 50 de carne hoje` é a forma canônica que A06 produz; se o
    // verbo não fosse terminador, o run viraria "nubank gastei" e todo
    // registro com conta citada passaria a pedir confirmação.
    const result = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'nubank gastei 50 de carne hoje',
      productionReader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_CARNE]),
    );
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
  });

  it('RED: o marcador de categoria TERMINA o run citado ("no nubank categoria carne")', async () => {
    for (const text of ['gastei 50 no nubank categoria carne', 'gastei 50 no Nubank na categoria Carne']) {
      const result = await resolveMutationEntities(
        parsed({ description: 'carne', categoryQuery: 'carne' }),
        text,
        productionReader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_CARNE]),
      );
      expect(result.complete).toBe(true);
      if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
    }
  });

  it('RED: dinheiro e conectivos NÃO alongam o run citado', async () => {
    for (const text of [
      'gastei 50 no nubank R$ 50 categoria carne',
      'gastei 50 no nubank e no mercado categoria carne',
      'gastei 50 no nubank de comida hoje categoria carne',
      'gastei 50 no nubank hj categoria carne',
      // Regra (d): minúsculo só alonga com DOIS caracteres ou mais.
      'gastei 50 no nubank x categoria carne',
    ]) {
      const result = await resolveMutationEntities(
        parsed({ description: 'carne', categoryQuery: 'carne' }),
        text,
        productionReader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_CARNE]),
      );
      expect(result.complete).toBe(true);
      if (result.complete) expect(result.accountId).toBe(ACCOUNT_NUBANK.id);
    }
  });

it('RED: "gastei 50 de carne" sem hint de conta segue o fluxo de sempre', async () => {
    const single = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne categoria carne',
      productionReader([ACCOUNT_NUBANK], [CATEGORY_CARNE]),
    );
    expect(single.complete).toBe(true);
    if (single.complete) expect(single.trace.account.source).toBe('deterministic');

    const ambiguous = await resolveMutationEntities(
      parsed({ description: 'carne', categoryQuery: 'carne' }),
      'gastei 50 de carne categoria carne',
      productionReader([ACCOUNT_NUBANK, ACCOUNT_ITAU], [CATEGORY_CARNE]),
    );
    expect(ambiguous.complete).toBe(false);
    if (!ambiguous.complete) expect(ambiguous.missingFields).toContain('accountId');
  });

  it('RED: A03 — a descrição nunca vira consulta de categoria (intocada pelo fail-safe)', async () => {
    const result = await resolveMutationEntities(
      parsed({ description: 'carne' }),
      'gastei 50 de carne no Nubank PJ',
      productionReader([ACCOUNT_NUBANK], [CATEGORY_MERCADO, CATEGORY_ALIMENTACAO]),
    );
    // A conta falha pelo hint mais específico; a categoria segue sem inferência.
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.missingFields).toContain('categoryId');
      expect(result.trace.category.source).toBe('clarification');
      expect(result.clarification).not.toMatch(/quiser dizer/i);
    }
  });
});

/**
 * P1/P2 — `normalizeEntities` is FAIL-CLOSED on a payload it does not
 * understand.
 *
 * A broken contract (renamed key, truncated envelope, an error object that
 * reached the reader as a 200) used to normalize to `[]`, i.e. an EMPTY
 * WORKSPACE. That is indistinguishable from "this workspace really has no
 * accounts", so a contract break could quietly degrade into a clarification
 * about a non-existent account instead of a read failure. An empty collection
 * is legitimate ONLY when the payload actually IS a collection; anything else
 * must raise, and the callers already turn a rejected read into the existing
 * `readFailure()` terminal.
 */
describe('normalizeEntities (fail-closed contract)', () => {
  /** Captures what was thrown (or `undefined` when the call silently returned). */
  const thrownBy = (payload: unknown): unknown => {
    try {
      normalizeEntities(payload);
      return undefined;
    } catch (error) {
      return error;
    }
  };

  const expectContractError = (payload: unknown): void => {
    const error = thrownBy(payload);
    expect(error, `payload ${JSON.stringify(payload) ?? String(payload)} must not normalize`).toBeInstanceOf(Error);
    expect((error as { code?: unknown }).code).toBe('entity.payload_contract');
  };

  it('keeps normalizing the LEGITIMATE empty collections of every accepted shape', () => {
    expect(normalizeEntities([])).toEqual([]);
    expect(normalizeEntities({ items: [] })).toEqual([]);
    expect(normalizeEntities({ data: [] })).toEqual([]);
    expect(normalizeEntities({ accounts: [] })).toEqual([]);
    expect(normalizeEntities({ categories: [] })).toEqual([]);
    // The real API envelope (`{ items, total }`) with an empty page.
    expect(normalizeEntities({ items: [], total: 0 })).toEqual([]);
  });

  it('normalizes the raw API shape and carries the scope into `scopeId` (workspace isolation intact)', () => {
    const householdId = '11111111-1111-4111-8111-111111111111';
    expect(
      normalizeEntities({ items: [{ id: ACCOUNT_NUBANK.id, name: 'Nubank', householdId }], total: 1 }),
    ).toEqual([{ id: ACCOUNT_NUBANK.id, name: 'Nubank', scopeId: householdId }]);
  });

  it('keeps the `status`/`isActive` passthrough of a legitimate row', () => {
    expect(
      normalizeEntities({
        accounts: [
          { id: ACCOUNT_NUBANK.id, name: 'Nubank', status: 'inactive', isActive: false },
          { id: ACCOUNT_ITAU.id, name: 'Itaú', status: 'active', isActive: true },
        ],
      }),
    ).toEqual([
      { id: ACCOUNT_NUBANK.id, name: 'Nubank', status: 'inactive', isActive: false },
      { id: ACCOUNT_ITAU.id, name: 'Itaú', status: 'active', isActive: true },
    ]);
  });

  it('still flattens nested category nodes (`subcategories` and `children`)', () => {
    expect(
      normalizeEntities({
        categories: [
          {
            id: CATEGORY_ALIMENTACAO.id,
            name: 'Alimentação',
            subcategories: [{ id: CATEGORY_CARNE.id, name: 'Carne' }],
          },
          { id: CATEGORY_MERCADO.id, name: 'Mercado', children: [{ id: CATEGORY_CARNE_BOVINA.id, name: 'Carne Bovina' }] },
        ],
      }).map((entity) => entity.name),
    ).toEqual(['Alimentação', 'Carne', 'Mercado', 'Carne Bovina']);
  });

  it('fails closed on `null`, `undefined` and primitives (no contract reads those as empty)', () => {
    expectContractError(null);
    expectContractError(undefined);
    expectContractError('string');
    expectContractError(42);
    expectContractError(true);
  });

  it('fails closed on an unknown record shape (no known collection key)', () => {
    expectContractError({ unexpected: 'payload' });
    expectContractError({});
    // A response that never became a list at all (error envelope, HTML, ...).
    expectContractError({ message: 'Bad Request', statusCode: 400 });
  });

  it('fails closed on a KNOWN key holding a non-array value (partially corrupted shape)', () => {
    expectContractError({ items: 'corrupt' });
    expectContractError({ items: null });
    expectContractError({ data: {} });
    expectContractError({ accounts: 'nubank' });
    expectContractError({ categories: 3 });
  });

  it('fails closed when a valid collection carries a NON-OBJECT element', () => {
    expectContractError({ items: [null] });
    expectContractError({ items: ['x'] });
    expectContractError({ items: [{ id: ACCOUNT_NUBANK.id, name: 'Nubank' }, null] });
    // Also on a flattened nested child: the tree is read as a whole.
    expectContractError({ categories: [{ id: CATEGORY_MERCADO.id, name: 'Mercado', subcategories: [null] }] });
  });

  it('still drops an OBJECT row without id/name instead of raising (documented leniency)', () => {
    expect(normalizeEntities({ items: [{ note: 'no id' }, { id: ACCOUNT_NUBANK.id, name: 'Nubank' }, { id: '  ' }] })).toEqual([
      { id: ACCOUNT_NUBANK.id, name: 'Nubank' },
    ]);
  });

  it('surfaces a contract violation through `resolveMutationEntities` as a READ FAILURE, never an empty workspace', async () => {
    const contractError = Object.assign(new Error('entity payload contract violation'), {
      code: 'entity.payload_contract',
    });
    const result = await resolveMutationEntities(
      parsed(),
      'Gastei R$ 50 no mercado',
      {
        listAccounts: async () => {
          throw contractError;
        },
        listCategories: async () => [CATEGORY_MERCADO],
      },
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('accountId');
      expect(result.clarification).toMatch(/não consegui acessar seus dados financeiros/i);
      // An empty workspace would have asked WHICH account; the read failure
      // must not pretend there is a list to choose from.
      expect(result.clarification).not.toMatch(/em qual conta/i);
    }
  });

  /**
   * A reader is INJECTED at this boundary, so its `listAccounts`/`listCategories`
   * are not obliged to normalize: an implementation that FULFILS with a corrupt
   * collection (`[null]`, `{ unexpected: 1 }`) hands back something the
   * `EntitySummary[]` contract does not describe. The resolver renormalizes
   * what it received, so that violation must reach the SAME fail-closed
   * `readFailure()` terminal a rejected read reaches — for EVERY reader, not
   * only for `createRequestEntityReader` (whose own `normalizeEntities` happens
   * to throw first). A rejection escaping here would be neither a proposal nor
   * a clarification: the turn would blow up instead of failing closed.
   */
  describe('a reader that FULFILS with a payload outside the contract', () => {
    const corruptAccounts: EntityReader = {
      listAccounts: async () => [null] as unknown as EntitySummary[],
      listCategories: async () => [CATEGORY_MERCADO],
    };
    const corruptCategories: EntityReader = {
      listAccounts: async () => [ACCOUNT_NUBANK],
      listCategories: async () => ({ unexpected: 1 }) as unknown as EntitySummary[],
    };

    const expectReadFailure = (result: EntityResolution, field: string): void => {
      expect(result.complete).toBe(false);
      if (result.complete) return;
      expect(result.missingFields).toContain(field);
      expect(result.clarification).toMatch(/não consegui acessar seus dados financeiros/i);
      // An empty workspace would have asked WHICH account/category; the read
      // failure must not pretend there is a list to choose from.
      expect(result.clarification).not.toMatch(/em qual conta|qual categoria/i);
    };

    it('resolveMutationEntities converges a corrupt account read into `readFailure()`, never a rejection', async () => {
      const result = await resolveMutationEntities(parsed(), 'Gastei R$ 50 no mercado', corruptAccounts);
      expectReadFailure(result, 'accountId');
    });

    it('resolveMutationEntities converges a corrupt category read into `readFailure()`, never a rejection', async () => {
      const result = await resolveMutationEntities(parsed(), 'Gastei R$ 50 no mercado', corruptCategories);
      expectReadFailure(result, 'categoryId');
    });

    it('revalidateResolvedEntities converges a corrupt account read into `readFailure()`, never a rejection', async () => {
      const resolved = await resolveMutationEntities(parsed(), 'Gastei R$ 50 no mercado', reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]));
      if (!resolved.complete) throw new Error('expected a complete resolution');
      expectReadFailure(await revalidateResolvedEntities(resolved, corruptAccounts), 'accountId');
    });

    it('revalidateResolvedEntities converges a corrupt category read into `readFailure()`, never a rejection', async () => {
      const resolved = await resolveMutationEntities(parsed(), 'Gastei R$ 50 no mercado', reader([ACCOUNT_NUBANK], [CATEGORY_MERCADO]));
      if (!resolved.complete) throw new Error('expected a complete resolution');
      expectReadFailure(await revalidateResolvedEntities(resolved, corruptCategories), 'categoryId');
    });
  });

  it('routes a corrupt payload read through `createRequestEntityReader` into the same read failure', async () => {
    const { createRequestEntityReader } = await import('../../src/mutations/entity-resolver.js');
    const readerFrom = (payload: unknown): EntityReader =>
      createRequestEntityReader(async () => payload, { workspaceId: '11111111-1111-4111-8111-111111111111' });
    await expect(readerFrom({ unexpected: 'payload' }).listAccounts()).rejects.toThrow();
    // The legitimate raw envelope still works end to end.
    await expect(
      readerFrom({ items: [{ id: ACCOUNT_NUBANK.id, name: 'Nubank' }], total: 1 }).listAccounts(),
    ).resolves.toEqual([{ id: ACCOUNT_NUBANK.id, name: 'Nubank' }]);
  });
});
