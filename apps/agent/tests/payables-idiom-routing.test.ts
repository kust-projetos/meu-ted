/**
 * Payables-idiom routing (debugger payables-absence): "contas a pagar" /
 * "contas vencidas" são payables, nunca bancário.
 *
 * Causa provada: o router somava `list_accounts` (match genérico
 * `conta|contas`, intent-router:245) ao `list_payables` do override
 * (intent-router:261). Com contas preenchidas (ok) + payables vazio, o
 * gate de ausência (renderDeterministicFromEvidence, ok.length > 0)
 * ignorava o empty e o turno caía no provider com evidência markup-only
 * → frase live "Não consegui processar suas contas a pagar agora".
 * Contraprova: remover apenas `list_accounts` devolve o empty honesto.
 *
 * Contrato desta fatia (mínimo, sem ampliar):
 * - idiomático payables ("contas a pagar", "contas vencidas",
 *   "conta de luz vence ...") NÃO inclui `list_accounts`;
 * - pedido explicitamente misto preservado (cada metade com sua leitura);
 * - imperativo de cartão ("crie cartao ... vencimento ...") é capacidade
 *   não suportada honesta — nunca read vazio, nunca promessa de cadastro,
 *   NENHUMA mutação de cartão;
 * - ausência segue determinística sem provider; erro da API segue erro,
 *   nunca vazio inventado.
 */
import { describe, expect, it, vi } from 'vitest';
import { routeIntent } from '../src/orchestration/intent-router.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';

const opNames = (text: string): string[] =>
  routeIntent(text).requestedOperations.map((operation) => operation.name);

const identity: AuthenticatedIdentity = {
  actorId: 'actor-payables-idiom',
  workspaceId: 'ws-payables-idiom',
  role: 'member',
  deviceId: 'device-payables-idiom',
};

const turn = (text: string, intentionId: string) =>
  normalizeRestTurn({ text, intentionId }, identity);

describe('payables-idiom: "contas a pagar/vencidas" nunca inclui bancário', () => {
  it('"minhas contas a pagar" planeja list_payables, nunca list_accounts', () => {
    const ops = opNames('minhas contas a pagar');
    expect(ops).toContain('list_payables');
    expect(ops).not.toContain('list_accounts');
  });

  it('"contas vencidas" planeja list_payables, nunca list_accounts', () => {
    const ops = opNames('quais contas vencidas tenho?');
    expect(ops).toContain('list_payables');
    expect(ops).not.toContain('list_accounts');
  });

  it('"minha conta de luz vence dia 10" é conta a pagar, nunca bancário', () => {
    const ops = opNames('minha conta de luz vence dia 10');
    expect(ops).toContain('list_payables');
    expect(ops).not.toContain('list_accounts');
  });

  it('controle: "liste minhas contas" continua bancário, sem payables', () => {
    const ops = opNames('liste minhas contas');
    expect(ops).toContain('list_accounts');
    expect(ops).not.toContain('list_payables');
  });

  it('misto explícito preservado: saldo + a pagar carrega as duas leituras', () => {
    const ops = opNames('qual meu saldo e quais contas estão a pagar');
    expect(ops).toContain('get_balance');
    expect(ops).toContain('list_payables');
  });

  it('misto explícito preservado: "minhas contas e minhas contas a pagar" carrega as duas', () => {
    const ops = opNames('mostre minhas contas e minhas contas a pagar');
    expect(ops).toContain('list_accounts');
    expect(ops).toContain('list_payables');
  });

  it('MED: "minhas contas a pagar e boletos vencidos" não inclui bancário (sem bypass por conjunção)', () => {
    const ops = opNames('minhas contas a pagar e boletos vencidos');
    expect(ops).toContain('list_payables');
    expect(ops).not.toContain('list_accounts');
  });

  it('MED: "minhas contas a pagar e minhas contas vencidas" não inclui bancário', () => {
    const ops = opNames('minhas contas a pagar e minhas contas vencidas');
    expect(ops).toContain('list_payables');
    expect(ops).not.toContain('list_accounts');
  });

  it('MED: misto com qualificadora bancária preserva as duas ("minhas contas bancárias e boletos vencidos")', () => {
    const ops = opNames('minhas contas bancárias e boletos vencidos');
    expect(ops).toContain('list_accounts');
    expect(ops).toContain('list_payables');
  });

  it('MED4: "minhas contas que já estão vencidas" absorve (qualificadores sem limite), sem bancário', () => {
    const ops = opNames('minhas contas que já estão vencidas');
    expect(ops).toContain('list_payables');
    expect(ops).not.toContain('list_accounts');
  });

  it('MED4: "minhas contas e meus boletos" preserva as duas (conjunção quebra a absorção)', () => {
    const ops = opNames('liste minhas contas e meus boletos');
    expect(ops).toContain('list_accounts');
    expect(ops).toContain('list_payables');
  });

  it('MED4: "quando vence minha conta" absorve (idiom reverso), sem bancário', () => {
    const ops = opNames('quando vence minha conta');
    expect(ops).toContain('list_payables');
    expect(ops).not.toContain('list_accounts');
  });
});

describe('cartão imperativo: capacidade não suportada honesta', () => {
  it('router: "crie cartao QA Visa final1234 vencimento dia10" nunca é read (sem list_cards/list_payables)', () => {
    const plan = routeIntent('crie cartao QA Visa final1234 vencimento dia10');
    expect(plan.mode).toBe('unsupported');
    expect(plan.requestedOperations).toEqual([]);
    expect(plan.ambiguity).toBe('unsupported_card_create');
  });

  it('controle: "mostre meus cartoes" continua read com list_cards', () => {
    const plan = routeIntent('mostre meus cartoes');
    expect(plan.mode).toBe('read');
    expect(opNames('mostre meus cartoes')).toContain('list_cards');
  });

  it('turno: imperativo de cartão responde honesto sem leitura, sem provider, sem mutação', async () => {
    const responseProvider = vi.fn(async () => 'invented by model');
    const evidenceProvider = vi.fn(async () => {
      throw new Error('no read must run on the unsupported-card path');
    });
    const orchestrator = new ConversationOrchestrator({
      responseProvider,
      evidenceProvider: evidenceProvider as never,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      turn('crie cartao QA Visa final1234 vencimento dia10', 'intent-card-create-1'),
    );
    expect(result.response?.text).toMatch(/cart/i);
    expect(result.response?.text).toMatch(/ainda n.o|crie|criar|suport/i);
    expect(result.response?.text).not.toMatch(/cadastro|cadastrado|criado com sucesso/i);
    expect(result.mutation).toBeUndefined();
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });
});
