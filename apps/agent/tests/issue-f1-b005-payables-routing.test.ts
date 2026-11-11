/**
 * F1-B005 — "Quais contas tenho que pagar" lê payables, nunca accounts, sem mutação.
 *
 * Oráculo preservado em `tests/poc-structured/frozen/scenarios.json` (id
 * `F1-B005`): leitura `list_payables` (`GET /payables`), sem proposta,
 * `answer-from-evidence`. Este teste é INDEPENDENTE do harness F1: exercita
 * o `routeIntent` real e o turno completo com evidência mockada, sem rede,
 * sem modelo e sem tocar nos geradores/relatórios F1.
 *
 * Cobre ainda a família "conta(s) + pagar" (F1-B020 `Pague a conta de luz`,
 * `paguei a conta de luz` no passado) e os controles de escopo por
 * cláusula: `conta` sem pagar continua bancária, `pagar` sem `conta`
 * continua no seu recurso, e o pagar da cláusula vizinha não contamina.
 */
import { describe, expect, it } from 'vitest';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { hasAccountCreationSignal } from '../src/mutations/account-creation.js';
import { InMemoryMutationDraftStore } from '../src/mutations/mutation-draft.js';
import { renderFailure } from '../src/responses/deterministic-responses.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnInput,
  type TurnPlan,
} from '../src/orchestration/conversation-orchestrator.js';
import type { EvidenceEnvelope } from '../src/evidence/evidence-envelope.js';

const opNames = (text: string): string[] =>
  routeIntent(text).requestedOperations.map((operation) => operation.name);

const hasMutationOp = (text: string): boolean =>
  routeIntent(text).requestedOperations.some((operation) => operation.kind === 'mutation');

describe('F1-B005 — contas a pagar lê payables, nunca accounts, sem mutação', () => {
  it('1) "Quais contas tenho que pagar" é read/payables com list_payables, sem list_accounts e sem mutação', () => {
    const plan = routeIntent('Quais contas tenho que pagar');
    expect(plan.mode).toBe('read');
    expect(plan.domain).toBe('payables');
    expect(opNames('Quais contas tenho que pagar')).toContain('list_payables');
    expect(opNames('Quais contas tenho que pagar')).not.toContain('list_accounts');
    expect(hasMutationOp('Quais contas tenho que pagar')).toBe(false);
  });

  it('2) "Pague a conta de luz" (imperativo, F1-B020) é read/payables, sem list_accounts e sem mutação', () => {
    const plan = routeIntent('Pague a conta de luz');
    expect(plan.mode).toBe('read');
    expect(plan.domain).toBe('payables');
    expect(opNames('Pague a conta de luz')).toContain('list_payables');
    expect(opNames('Pague a conta de luz')).not.toContain('list_accounts');
    expect(hasMutationOp('Pague a conta de luz')).toBe(false);
  });

  it('3) "paguei a conta de luz" (passado) continua leitura payables — nenhuma operação financeira proposta ou executada', () => {
    const plan = routeIntent('paguei a conta de luz');
    expect(plan.mode).toBe('read');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(opNames('paguei a conta de luz')).toContain('list_payables');
    expect(opNames('paguei a conta de luz')).not.toContain('list_accounts');
    expect(hasMutationOp('paguei a conta de luz')).toBe(false);
  });
});

describe('F1-B005 — controles de escopo por cláusula (regressão)', () => {
  it('4) "Quais contas eu tenho?" (conta sem pagar) continua bancária, sem payables', () => {
    expect(opNames('Quais contas eu tenho?')).toContain('list_accounts');
    expect(opNames('Quais contas eu tenho?')).not.toContain('list_payables');
  });

  it('5) "quero pagar a fatura" (pagar sem conta) continua statements, sem payables e sem accounts', () => {
    expect(opNames('quero pagar a fatura')).toContain('list_statements');
    expect(opNames('quero pagar a fatura')).not.toContain('list_payables');
    expect(opNames('quero pagar a fatura')).not.toContain('list_accounts');
  });

  it('6) cláusula vizinha não contamina: "liste minhas contas e pague o aluguel" mantém accounts, sem payables', () => {
    expect(opNames('liste minhas contas e pague o aluguel')).toContain('list_accounts');
    expect(opNames('liste minhas contas e pague o aluguel')).not.toContain('list_payables');
  });
});

const identityFor = (tag: string): AuthenticatedIdentity => ({
  actorId: `actor-b005-${tag}`,
  workspaceId: `ws-b005-${tag}`,
  role: 'member',
  deviceId: `device-b005-${tag}`,
});

const OP_TO_GET: Readonly<Record<string, string>> = {
  list_payables: 'GET /payables',
  list_accounts: 'GET /accounts',
  list_statements: 'GET /cards/statements',
};

const runB005Turn = async (text: string, tag: string) => {
  const apiCalls: string[] = [];
  const providerCalls: string[] = [];
  const orchestrator = new ConversationOrchestrator({
    plan: (input: TurnInput) => routeIntent(input.text) as never,
    evidenceProvider: async (_input: TurnInput, plan: TurnPlan): Promise<EvidenceEnvelope> => {
      const stamp = new Date().toISOString();
      return {
        version: '1',
        items: plan.requestedOperations.map((operation) => {
          apiCalls.push(OP_TO_GET[operation.name] ?? `GET /${operation.name}`);
          if (operation.name === 'list_payables') {
            return {
              ref: 'payables',
              source: 'api.payables',
              retrievedAt: stamp,
              status: 'empty',
              data: [],
              reason: 'setup_incomplete',
            };
          }
          return {
            ref: operation.name,
            source: `api.${operation.name}`,
            retrievedAt: stamp,
            status: 'empty',
            data: [],
            reason: 'setup_incomplete',
          };
        }),
      } as EvidenceEnvelope;
    },
    responseProvider: async () => {
      providerCalls.push('called');
      return '**resumo** markup-only';
    },
    events: () => undefined,
  });
  const result = await orchestrator.runTurn(
    normalizeRestTurn({ text, intentionId: `intent-b005-${tag}` }, identityFor(tag)),
  );
  return { result, apiCalls, providerCalls };
};

const runB005TurnWithDraftStore = async (text: string, tag: string) => {
  const apiCalls: string[] = [];
  const providerCalls: string[] = [];
  const store = new InMemoryMutationDraftStore();
  const identity = identityFor(tag);
  const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
  const orchestrator = new ConversationOrchestrator({
    plan: (input: TurnInput) => routeIntent(input.text) as never,
    draftStore: store,
    evidenceProvider: async (_input: TurnInput, plan: TurnPlan): Promise<EvidenceEnvelope> => {
      const stamp = new Date().toISOString();
      return {
        version: '1',
        items: plan.requestedOperations.map((operation) => {
          apiCalls.push(OP_TO_GET[operation.name] ?? `GET /${operation.name}`);
          return {
            ref: operation.name,
            source: `api.${operation.name}`,
            retrievedAt: stamp,
            status: 'empty',
            data: [],
            reason: 'setup_incomplete',
          };
        }),
      } as EvidenceEnvelope;
    },
    responseProvider: async () => {
      providerCalls.push('called');
      return '**resumo** markup-only';
    },
    events: () => undefined,
  });
  const result = await orchestrator.runTurn(
    normalizeRestTurn({ text, intentionId: `intent-b005-${tag}` }, identity),
  );
  return { result, apiCalls, providerCalls, store, ctx };
};

describe('F1-B005 — turno completo com mock: GET /payables, nunca GET /accounts, sem mutação', () => {
  it.each([
    ['Quais contas tenho que pagar', 'que-pagar'],
    ['Pague a conta de luz', 'imperativo'],
  ])('7) turno "%s": só GET /payables, resposta sobre contas a pagar, sem provider e sem mutação', async (text, tag) => {
    const { result, apiCalls, providerCalls } = await runB005Turn(text, tag);
    expect(apiCalls).toEqual(['GET /payables']);
    expect(apiCalls).not.toContain('GET /accounts');
    expect(result.response?.text).toMatch(/contas a pagar/i);
    expect(providerCalls).toHaveLength(0);
    expect(result.mutation).toBeUndefined();
  });

  it('8) turno "paguei a conta de luz" (passado sem valor): zero leituras e zero mutação — clarifica fail-closed', async () => {
    const { result, apiCalls, providerCalls } = await runB005Turn('paguei a conta de luz', 'passado');
    // A guarda de mutação (valor ausente) responde antes da evidência: nem
    // GET /payables nem GET /accounts acontece, e nada é proposto/executado.
    expect(apiCalls).toEqual([]);
    expect(providerCalls).toHaveLength(0);
    expect(result.mutation).toBeUndefined();
    expect(result.clarification?.missingFields).toContain('amount');
    expect(result.response?.text).toMatch(/valor/i);
  });
});

describe('F1-B005 — imperativo de criação nunca vira leitura payables (reviewer)', () => {
  it('9) "Crie uma conta para pagar o aluguel" tem sinal de criação e o plano NÃO lê payables nem propõe mutação', () => {
    expect(hasAccountCreationSignal('Crie uma conta para pagar o aluguel')).toBe(true);
    expect(hasAccountCreationSignal('Quais contas tenho que pagar')).toBe(false);
    const plan = routeIntent('Crie uma conta para pagar o aluguel');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(opNames('Crie uma conta para pagar o aluguel')).not.toContain('list_payables');
    expect(hasMutationOp('Crie uma conta para pagar o aluguel')).toBe(false);
  });

  it('10) controle: "crie conta a pagar QA Luz" (idiom estrangeiro) preserva payables', () => {
    expect(hasAccountCreationSignal('crie conta a pagar QA Luz')).toBe(false);
    expect(opNames('crie conta a pagar QA Luz')).toContain('list_payables');
  });

  it('11) turno SEM draftStore: zero GETs, sem mutação, limitação honesta de criação (indisponibilidade)', async () => {
    const { result, apiCalls, providerCalls } = await runB005Turn(
      'Crie uma conta para pagar o aluguel',
      'criar-conta',
    );
    expect(apiCalls).toEqual([]);
    expect(providerCalls).toHaveLength(0);
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toBe(renderFailure('a criação da conta'));
    expect(result.response?.text).not.toMatch(/contas a pagar/i);
  });

  it('12) turno COM InMemoryMutationDraftStore: abre draft de criação, sem execução/proposta e sem alegar sucesso', async () => {
    const { result, apiCalls, providerCalls, store, ctx } = await runB005TurnWithDraftStore(
      'Crie uma conta para pagar o aluguel',
      'criar-conta-store',
    );
    expect(apiCalls).toEqual([]);
    expect(providerCalls).toHaveLength(0);
    expect(result.mutation).toBeUndefined();
    const actives = store.listActive(ctx, Date.now());
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.create');
    expect(result.response?.text).toMatch(/criar a conta/i);
    expect(result.response?.text).not.toMatch(/criada com sucesso|sucesso/i);
  });
});
