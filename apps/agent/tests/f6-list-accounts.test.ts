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
  actorId: 'actor-f6',
  workspaceId: 'ws-f6-a',
  role: 'member',
  deviceId: 'device-f6',
};

const apiAccounts = [
  { id: 'account-a1', name: 'Conta A', kind: 'bank', balanceCents: 12500, householdId: 'ws-f6-a' },
  { id: 'account-a2', name: 'Carteira A', kind: 'cash', balanceCents: 4500, householdId: 'ws-f6-a' },
];

const planFor = (input: TurnInput): TurnPlan => routeIntent(input.text) as unknown as TurnPlan;

const runListTurn = async (listAccounts: ChannelReadTools['listAccounts']) => {
  const readSpy = vi.fn(listAccounts);
  const unused = async () => { throw new Error('read.not_planned'); };
  const readTools = {
    listAccounts: readSpy,
    listRecentTransactions: unused,
    getMonthSummary: unused,
    listCards: unused,
    listStatements: unused,
    listAccountsPayable: unused,
    listBudgets: unused,
    listGoals: unused,
    listCategories: unused,
    analyticsKpis: unused,
    analyticsCategoryBreakdown: unused,
  } as ChannelReadTools;
  const provider = vi.fn(async () => 'provider must not answer account-list reads');
  const grounding = createChannelGrounding({
    respond: async () => 'unused',
    readTools,
    readToken: async () => 'delegated-ws-f6-a',
  });
  const orchestrator = new ConversationOrchestrator({
    plan: planFor,
    evidenceProvider: grounding.evidenceProvider,
    responseProvider: provider,
    events: () => undefined,
  });
  const result = await orchestrator.runTurn(
    normalizeRestTurn({ text: 'Liste minhas contas', intentionId: 'intent-f6-list' }, identity),
  );
  return { result, readSpy, provider };
};

describe('F6 — listagem de contas no workspace autenticado', () => {
  it('a pergunta natural executa só list_accounts e responde com os dados daquela API/workspace', async () => {
    const { result, readSpy, provider } = await runListTurn(async (params, auth) => {
      // Simula o contrato de GET /accounts: o servidor limita o payload pela
      // identidade autenticada; nenhum registro de outro workspace é incluído.
      expect(params).toEqual({ householdId: identity.workspaceId });
      expect(auth?.delegatedToken).toBe('delegated-ws-f6-a');
      return { items: apiAccounts, total: apiAccounts.length };
    });

    expect(routeIntent('Liste minhas contas').requestedOperations).toEqual([
      { name: 'list_accounts', kind: 'read' },
    ]);
    expect(CORE_READ_TOOLS).toContain('list_accounts');
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toContain('Conta A');
    expect(result.response?.text).toContain('Carteira A');
    expect(result.response?.text).toMatch(/R\$\s*125,00/);
    expect(result.response?.text).toMatch(/R\$\s*45,00/);
    expect(result.response?.text).not.toContain('Conta de outro workspace');
    expect(provider).not.toHaveBeenCalled();
  });

  it('distingue resposta vazia legítima de erro na leitura', async () => {
    const empty = await runListTurn(async () => ({ items: [], total: 0 }));
    expect(empty.readSpy).toHaveBeenCalledTimes(1);
    expect(empty.result.response?.text).toMatch(/não encontrei contas|guie no cadastro/i);
    expect(empty.result.response?.text).not.toMatch(/acessar seus dados financeiros/i);

    const failed = await runListTurn(async () => {
      throw Object.assign(new Error('HTTP 503'), { statusCode: 503, code: 'api.request_failed' });
    });
    expect(failed.result.response?.text).toMatch(/acessar seus dados financeiros/i);
    expect(failed.result.response?.text).not.toMatch(/não encontrei contas|guie no cadastro/i);
  });
});
