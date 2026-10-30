import { describe, expect, it, vi } from 'vitest';
import { CORE_READ_TOOLS } from '../src/agent-config/tools.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnInput,
  type TurnPlan,
} from '../src/orchestration/conversation-orchestrator.js';
import { createChannelGrounding, type ChannelReadTools } from '../src/orchestration/channel-evidence.js';
import { routeIntent } from '../src/orchestration/intent-router.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-l1',
  workspaceId: 'ws-l1-authenticated',
  role: 'member',
  deviceId: 'device-l1',
};

const planFor = (input: TurnInput): TurnPlan => routeIntent(input.text) as unknown as TurnPlan;

const runListTurn = async (
  turnIdentity: AuthenticatedIdentity,
  listCategories: ChannelReadTools['listCategories'],
) => {
  const readSpy = vi.fn(listCategories);
  const unused = async () => { throw new Error('read.not_planned'); };
  const readTools = {
    listAccounts: unused,
    listRecentTransactions: unused,
    getMonthSummary: unused,
    listCards: unused,
    listStatements: unused,
    listAccountsPayable: unused,
    listBudgets: unused,
    listGoals: unused,
    listCategories: readSpy,
    analyticsKpis: unused,
    analyticsCategoryBreakdown: unused,
  } as ChannelReadTools;
  const provider = vi.fn(async () => 'provider must not answer category-list reads');
  const grounding = createChannelGrounding({
    respond: async () => 'unused',
    readTools,
    readToken: async (input) => `delegated-${input.workspaceId}`,
  });
  const orchestrator = new ConversationOrchestrator({
    plan: planFor,
    evidenceProvider: grounding.evidenceProvider,
    responseProvider: provider,
    events: () => undefined,
  });
  const result = await orchestrator.runTurn(
    normalizeRestTurn({ text: 'Liste minhas categorias', intentionId: 'intent-l1-list' }, turnIdentity),
  );
  return { result, readSpy, provider };
};

describe('L1 — listar categorias pelo seam de leitura autenticado', () => {
  it('a pergunta natural passa workspace e token do turno ao mock de list_categories', async () => {
    const categories = [
      { id: 'cat-food', name: 'Alimentação', kind: 'expense', householdId: identity.workspaceId },
      { id: 'cat-salary', name: 'Salário', kind: 'income', householdId: identity.workspaceId },
    ];
    const { result, readSpy, provider } = await runListTurn(identity, async (params, auth) => {
      expect(params).toEqual({ householdId: identity.workspaceId });
      expect(auth?.delegatedToken).toBe(`delegated-${identity.workspaceId}`);
      // O mock representa dados devolvidos para o token recebido; não prova o
      // isolamento da API real, que é garantido pelo workspace do token.
      return { items: categories, total: categories.length };
    });

    expect(routeIntent('Liste minhas categorias').requestedOperations).toEqual([
      { name: 'list_categories', kind: 'read' },
    ]);
    expect(CORE_READ_TOOLS).toContain('list_categories');
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toContain('Alimentação');
    expect(result.response?.text).toContain('Salário');
    expect(result.response?.text).not.toContain('Categoria de outro workspace');
    expect(result.response?.text).not.toContain('cat-food');
    expect(provider).not.toHaveBeenCalled();
  });

  it('usa o token correspondente à identidade de cada turno ao chamar o seam', async () => {
    const otherIdentity: AuthenticatedIdentity = {
      ...identity,
      actorId: 'actor-l1-other',
      workspaceId: 'ws-l1-other',
    };
    const observed: Array<{ householdId?: string; token?: string }> = [];
    const listForTurn = async (turnIdentity: AuthenticatedIdentity) => runListTurn(
      turnIdentity,
      async (params, auth) => {
        observed.push({
          householdId: (params as { householdId?: string }).householdId,
          token: auth?.delegatedToken,
        });
        return { items: [{ id: `cat-${turnIdentity.workspaceId}`, name: 'Categoria', kind: 'expense' }], total: 1 };
      },
    );

    await listForTurn(identity);
    await listForTurn(otherIdentity);

    expect(observed).toEqual([
      { householdId: identity.workspaceId, token: `delegated-${identity.workspaceId}` },
      { householdId: otherIdentity.workspaceId, token: `delegated-${otherIdentity.workspaceId}` },
    ]);
  });

  it('distingue lista vazia legítima de erro na leitura', async () => {
    const empty = await runListTurn(identity, async () => ({ items: [], total: 0 }));
    expect(empty.readSpy).toHaveBeenCalledTimes(1);
    expect(empty.result.response?.text).toMatch(/não encontrei categorias|categorias.*cadastro/i);
    expect(empty.result.response?.text).not.toMatch(/acessar seus dados financeiros/i);
    expect(empty.provider).not.toHaveBeenCalled();

    const failed = await runListTurn(identity, async () => {
      throw Object.assign(new Error('HTTP 503'), { statusCode: 503, code: 'api.request_failed' });
    });
    expect(failed.result.response?.text).toMatch(/acessar seus dados financeiros/i);
    expect(failed.result.response?.text).not.toMatch(/não encontrei categorias|categorias.*cadastro/i);
    expect(failed.provider).not.toHaveBeenCalled();
  });
});
