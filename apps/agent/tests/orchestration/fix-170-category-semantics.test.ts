/**
 * FIX-170 — 'mercado' não avança (TDD RED→GREEN).
 *
 * Fluxo P0: 'gastei 90 com carne' abre draft pendendo categoria; a resposta
 * curta ('mercado', 'de mercado', ...) nunca completava o draft porque
 * `categoryQueryFrom` só aceitava 'categoria X' ou 'de X' (loop de pergunta).
 *
 * Leitura de aceite adotada (defensável, sem violar R03/A03):
 * - (a) o primeiro turno HONESTO lista o catálogo vigente como sugestão
 *   (draft editável, zero categoryId inventado, zero proposta executada);
 * - (b) a resposta curta completa o MESMO draft e vira proposta 'proposed';
 * - (c) 'não, transporte' corrige para Transporte;
 * - (d) ausente/homônima esclarece sem criar nada, com impasse estável finito;
 * - (e) R$90 só executa após confirmação explícita (proposed, nunca succeeded).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import {
  InMemoryMutationDraftStore,
  type MutationDraftStore,
} from '../../src/mutations/mutation-draft.js';
import {
  resolveMutationEntities,
  type EntityReader,
} from '../../src/mutations/entity-resolver.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const ALIMENTACAO = { id: '00000000-0000-4000-8000-000000000010', name: 'Alimentação' };
const MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };
const TRANSPORTE = { id: '00000000-0000-4000-8000-000000000012', name: 'Transporte' };

const reader = (
  accounts = [NUBANK],
  categories = [ALIMENTACAO, MERCADO],
): EntityReader => ({
  listAccounts: async () => accounts,
  listCategories: async () => categories,
});

const makeFakeApi = () => {
  const ops = new Map<string, { id: string; payload: string }>();
  let seq = 0;
  const request = vi.fn();
  request.mockImplementation(async (method: string, path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      return { items: [], total: 0 };
    }
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const key = opts?.idempotencyKey;
      const wireBody = (opts?.body ?? {}) as { tool?: unknown; normalizedArgs?: unknown };
      const payload = JSON.stringify({ tool: wireBody.tool, normalizedArgs: wireBody.normalizedArgs });
      const known = ops.get(key ?? '');
      if (known) {
        if (known.payload !== payload) {
          const conflict = new Error('idempotency.conflict');
          (conflict as { statusCode?: number }).statusCode = 409;
          throw conflict;
        }
        return { id: known.id, existing: true };
      }
      seq += 1;
      const id = `pending-${seq}`;
      ops.set(key ?? '', { id, payload });
      return { id };
    }
    throw new Error(`unexpected request ${method} ${path}`);
  });
  const proposePosts = () => request.mock.calls.filter((call) => call[0] === 'POST' && call[1] === '/pending-operations/v2/propose').length;
  return { api: new MutationApiClient({ request }), request, proposePosts };
};

const NOW = () => Date.parse('2026-10-14T12:00:00.000Z');

const setup = (
  fake: ReturnType<typeof makeFakeApi>,
  store: MutationDraftStore,
  entityReader: EntityReader,
) =>
  new ConversationOrchestrator({
    mutationApiClient: fake.api,
    entityReader,
    draftStore: store,
    draftNow: NOW,
  });

const turn = (orchestrator: ConversationOrchestrator, text: string, intentionId: string) =>
  orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));

const openDraft = async () => {
  const fake = makeFakeApi();
  const store = new InMemoryMutationDraftStore();
  const orchestrator = setup(fake, store, reader());
  const first = await turn(orchestrator, 'gastei 90 com carne', 'fix170-open');
  return { fake, store, orchestrator, first };
};

describe('FIX-170 (a): primeiro turno sugere do catálogo, sem inventar id', () => {
  it('clarifica com o catálogo vigente, preserva a descrição e nada propõe', async () => {
    const { fake, store, first } = await openDraft();
    expect(first.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(first.clarification?.missingFields).toContain('categoryId');
    expect(first.response?.text).toMatch(/qual categoria/i);
    expect(first.response?.text).toMatch(/Mercado/);
    expect(first.response?.text).toMatch(/Alimentação/);
    // Zero categoryId inventado: o draft guarda só a descrição.
    const drafts = store.listActive(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
      NOW(),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.resolvedArgs.description).toBe('com carne');
    expect(drafts[0]!.resolvedArgs.categoryId).toBeUndefined();
    expect(drafts[0]!.resolvedArgs.amountCents).toBe(9000);
    // Nenhum UUID vazado/inventado na resposta.
    expect(first.response?.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});

describe('FIX-170 (b): resposta curta completa o MESMO draft', () => {
  const answers = [
    'mercado',
    'supermercado',
    'categoria mercado',
    'de mercado',
    'alimentação > mercado',
  ];
  for (const answer of answers) {
    it(`'${answer}' vira proposta com Mercado, sem novo draft`, async () => {
      const { fake, store, orchestrator, first } = await openDraft();
      expect(first.mutation).toBeUndefined();
      const second = await turn(orchestrator, answer, 'fix170-answer');
      expect(second.mutation?.status).toBe('proposed');
      expect(second.mutation?.operationId).toMatch(/^pending-/);
      expect(fake.proposePosts()).toBe(1);
      const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
      expect(body?.body?.normalizedArgs).toMatchObject({
        amountCents: 9000,
        description: 'com carne',
        accountId: NUBANK.id,
        categoryId: MERCADO.id,
      });
      // MESMO draft: nenhum draft ativo restante, um consumido.
      const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
      expect(store.listActive(ctx, NOW())).toHaveLength(0);
    });
  }
});

describe('FIX-170 (c): negação com alternativa corrige a categoria', () => {
  it("'não, transporte' completa o mesmo draft com Transporte", async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, reader([NUBANK], [ALIMENTACAO, MERCADO, TRANSPORTE]));
    const first = await turn(orchestrator, 'gastei 90 com carne', 'fix170-neg-1');
    expect(first.mutation).toBeUndefined();
    const second = await turn(orchestrator, 'não, transporte', 'fix170-neg-2');
    expect(second.mutation?.status).toBe('proposed');
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({ categoryId: TRANSPORTE.id });
  });
});

describe('FIX-170 (d): ausente/homônima esclarece sem criar e sem loop', () => {
  it('categoria ausente: honesto, sem proposta, sem criação implícita', async () => {
    const { fake, orchestrator } = await openDraft();
    const answer = await turn(orchestrator, 'xyz-nao-existe', 'fix170-absent');
    expect(answer.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(answer.response?.text).toMatch(/qual categoria|não encontrei/i);
    expect(answer.response?.text).toMatch(/Mercado/);
    expect(answer.response?.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(answer.response?.text).not.toMatch(/criar (uma )?categoria/i);
  });

  it('homônimas: lista as duas, sem escolha silenciosa', async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const twin = { id: '00000000-0000-4000-8000-000000000099', name: 'Mercado' };
    const orchestrator = setup(fake, store, reader([NUBANK], [MERCADO, twin]));
    const first = await turn(orchestrator, 'gastei 90 com carne', 'fix170-hom-1');
    expect(first.mutation).toBeUndefined();
    const answer = await turn(orchestrator, 'mercado', 'fix170-hom-2');
    expect(answer.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(answer.response?.text).toMatch(/mais de uma categoria/i);
  });

  it('resposta idêntica repetida converge para impasse estável (limite finito)', async () => {
    const { orchestrator } = await openDraft();
    const t2 = await turn(orchestrator, 'xyz-nao-existe', 'fix170-loop-2');
    const t3 = await turn(orchestrator, 'xyz-nao-existe', 'fix170-loop-3');
    const t4 = await turn(orchestrator, 'xyz-nao-existe', 'fix170-loop-4');
    expect(t2.mutation).toBeUndefined();
    expect(t3.mutation).toBeUndefined();
    expect(t4.mutation).toBeUndefined();
    // A pergunta não se repete idêntica indefinidamente: converge e estabiliza.
    expect(t3.response?.text).not.toBe(t2.response?.text);
    expect(t4.response?.text).toBe(t3.response?.text);
    expect(t4.response?.text).not.toMatch(/criar (uma )?categoria/i);
  });
});

describe('FIX-170 regressão: bare com conta pendente não rouba a resposta', () => {
  it("'Nubank' com conta+categoria pendentes resolve a conta e segue perguntando a categoria", async () => {
    const CARNE_BOVINA = { id: '00000000-0000-4000-8000-000000000021', name: 'Carne Bovina' };
    const ITAU = { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' };
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, reader([NUBANK, ITAU], [CARNE_BOVINA]));
    const first = await turn(orchestrator, 'gastei 50 de carne', 'fix170-both-1');
    expect(first.mutation).toBeUndefined();
    expect(first.clarification?.missingFields).toEqual(expect.arrayContaining(['accountId', 'categoryId']));
    // 'Nubank' NÃO vira categoryQuery: resolve a conta no turno, categoria segue pendente.
    const second = await turn(orchestrator, 'Nubank', 'fix170-both-2');
    expect(second.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(second.clarification?.missingFields).toEqual(['categoryId']);
    // A categoria (única pendente agora) aceita o bare e fica armazenada;
    // a conta, que nunca persiste em draft incompleto, é pedida de novo.
    const third = await turn(orchestrator, 'Carne Bovina', 'fix170-both-3');
    expect(third.mutation).toBeUndefined();
    expect(third.clarification?.missingFields).toEqual(['accountId']);
    // Conta respondida de novo conclui o MESMO draft com os dois ids.
    const fourth = await turn(orchestrator, 'Nubank', 'fix170-both-4');
    expect(fourth.mutation?.status).toBe('proposed');
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({ accountId: NUBANK.id, categoryId: CARNE_BOVINA.id });
  });
});

describe('FIX-169-170-R2 (P2-3) RED: instrução negativa nunca vira query de categoria', () => {
  const negatives = ['não use mercado', 'não quero mercado', 'não use categoria mercado'];
  for (const [index, text] of negatives.entries()) {
    it(`'${text}' esclarece sem propor e sem consumir o draft`, async () => {
      const { fake, store, orchestrator, first } = await openDraft();
      expect(first.mutation).toBeUndefined();
      const second = await turn(orchestrator, text, `fixp23-neg-${index}`);
      expect(second.mutation).toBeUndefined();
      expect(fake.proposePosts()).toBe(0);
      expect(second.clarification?.missingFields).toContain('categoryId');
      expect(second.response?.text).toMatch(/qual categoria/i);
      // O draft segue ativo com a categoria ainda pendente (nada consumido).
      const drafts = store.listActive(
        { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
        NOW(),
      );
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.missingFields).toContain('categoryId');
    });
  }
});

describe('FIX-169-170-R3 RED: negação dupla com vírgula nunca vira query de categoria', () => {
  const doubles = ['não, não quero mercado', 'não, não use categoria mercado'];
  for (const [index, text] of doubles.entries()) {
    it(`'${text}' esclarece sem propor e sem consumir o draft`, async () => {
      const { fake, store, orchestrator, first } = await openDraft();
      expect(first.mutation).toBeUndefined();
      const second = await turn(orchestrator, text, `fixr3-neg-${index}`);
      expect(second.mutation).toBeUndefined();
      expect(fake.proposePosts()).toBe(0);
      expect(second.clarification?.missingFields).toContain('categoryId');
      expect(second.response?.text).toMatch(/qual categoria/i);
      // O draft segue ativo com a categoria ainda pendente (nada consumido).
      const drafts = store.listActive(
        { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
        NOW(),
      );
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.missingFields).toContain('categoryId');
    });
  }

  it("'não, transporte' segue resolvendo a alternativa (regressão R3)", async () => {
    const fake = makeFakeApi();
    const store = new InMemoryMutationDraftStore();
    const orchestrator = setup(fake, store, reader([NUBANK], [ALIMENTACAO, MERCADO, TRANSPORTE]));
    const first = await turn(orchestrator, 'gastei 90 com carne', 'fixr3-neg-alt-1');
    expect(first.mutation).toBeUndefined();
    const second = await turn(orchestrator, 'não, transporte', 'fixr3-neg-alt-2');
    expect(second.mutation?.status).toBe('proposed');
    const body = fake.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({ categoryId: TRANSPORTE.id });
  });

  it("'não,não,não,não,não,não quero categoria mercado' (R4: bound-3 esgotado) esclarece sem propor", async () => {
    const { fake, store, orchestrator, first } = await openDraft();
    expect(first.mutation).toBeUndefined();
    const second = await turn(orchestrator, 'não,não,não,não,não,não quero categoria mercado', 'fixr4-neg-bound');
    expect(second.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(second.clarification?.missingFields).toContain('categoryId');
    expect(second.response?.text).toMatch(/qual categoria/i);
    const drafts = store.listActive(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
      NOW(),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.missingFields).toContain('categoryId');
  });

  it("'não,não transporte' (R4: conservador) esclarece sem propor", async () => {
    const { fake, store, orchestrator, first } = await openDraft();
    expect(first.mutation).toBeUndefined();
    const second = await turn(orchestrator, 'não,não transporte', 'fixr4-neg-nospace');
    expect(second.mutation).toBeUndefined();
    expect(fake.proposePosts()).toBe(0);
    expect(second.clarification?.missingFields).toContain('categoryId');
    const drafts = store.listActive(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
      NOW(),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.missingFields).toContain('categoryId');
  });
});

describe('FIX-170 (e/INT-03): R$90 só após confirmação explícita', () => {
  it('o fluxo termina em proposed, nunca succeeded, sem executar', async () => {
    const { orchestrator } = await openDraft();
    const second = await turn(orchestrator, 'mercado', 'fix170-int03');
    expect(second.mutation?.status).toBe('proposed');
    expect(second.mutation?.status).not.toBe('succeeded');
    expect(second).not.toHaveProperty('receipt');
  });
});

describe('FIX-170 resolver: descrição vira sugestão, nunca seleção', () => {
  const parsed = (description: string, categoryQuery?: string) => ({
    kind: 'expense' as const,
    amountCents: 9000,
    description,
    date: '2026-10-14',
    ...(categoryQuery ? { categoryQuery } : {}),
  });
  it("sugere candidata do catálogo vigente sem selecionar ('carne' → Carne Bovina?)", async () => {
    const CARNE_BOVINA = { id: '00000000-0000-4000-8000-000000000021', name: 'Carne Bovina' };
    const result = await resolveMutationEntities(
      parsed('carne'),
      'gastei 90 com carne',
      reader([NUBANK], [CARNE_BOVINA, MERCADO]),
    );
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingFields).toContain('categoryId');
      expect(result.trace.category.source).toBe('semantic_candidate');
      expect(result.trace.category.homonyms).toEqual(['Carne Bovina']);
      expect(result.clarification).toMatch(/Carne Bovina/);
      expect(result.clarification).not.toMatch(/Não encontrei a categoria\s*"carne"/i);
    }
  });
});
