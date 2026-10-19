/**
 * Fallback pt-BR por domínio (bug prod 2026-10-19 ~10:34, workspace junio):
 * "liste minhas contas" → "Não consegui processar accounts agora…"
 * O id interno de domínio vazava em inglês na UX pt-BR.
 *
 * RED: prova que o fallback com cada domain renderiza pt-BR e nunca o id cru.
 */
import { describe, expect, it } from 'vitest';
import {
  renderClarificationFallback,
  renderUnavailable,
  resolveDomainSubject,
} from '../../src/responses/deterministic-responses.js';
import { createGroundedResponseWithRetry } from '../../src/responses/grounded-response.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

const DOMAINS = [
  'accounts',
  'transactions',
  'cards',
  'payables',
  'budgets',
  'goals',
  'categories',
  'memory',
  'web',
  'general',
] as const;

const envelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'accounts.list', retrievedAt: '2026-10-19T12:00:00Z', status: 'ok', data }],
});

const identity: AuthenticatedIdentity = { actorId: 'actor-1', workspaceId: 'ws-1', role: 'owner', deviceId: 'dev-1' };
const turn = (text: string, intentionId: string) =>
  normalizeRestTurn({ text, intentionId, traceId: intentionId }, identity);
const silent = (): void => undefined;

describe('fallback de domínio em pt-BR (nunca o id cru em inglês)', () => {
  it.each(DOMAINS)('resolveDomainSubject(%s) rende pt-BR, nunca o id cru', (domain) => {
    const subject = resolveDomainSubject(domain);
    const clarification = renderClarificationFallback(subject);
    const unavailable = renderUnavailable(subject);
    expect(clarification).toContain('?');
    // pt-BR: o sujeito aparece nas duas formas; o id cru em inglês nunca.
    expect(`${clarification} ${unavailable}`).not.toContain(domain);
  });

  it('accounts rende "contas" nos dois templates', () => {
    const subject = resolveDomainSubject('accounts');
    expect(renderClarificationFallback(subject)).toContain('contas');
    expect(renderUnavailable(subject)).toContain('contas');
  });

  it('default desconhecido rende "esta consulta"', () => {
    expect(resolveDomainSubject('qualquer-coisa')).toBe('esta consulta');
    expect(renderClarificationFallback(resolveDomainSubject('qualquer-coisa'))).toContain('esta consulta');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'propriedade herdada (%s) cai no default "esta consulta" (contrato string)',
    (key) => {
      const subject = resolveDomainSubject(key);
      expect(typeof subject).toBe('string');
      expect(subject).toBe('esta consulta');
      expect(renderClarificationFallback(subject)).toContain('esta consulta');
      expect(renderUnavailable(subject)).toContain('esta consulta');
    },
  );

  it('grounded fallback com subject resolvido nunca vaza o id cru', async () => {
    for (const domain of DOMAINS) {
      const result = await createGroundedResponseWithRetry(
        '<tool_call>list_accounts</tool_call>',
        envelope({ note: 'ok-but-non-renderable' }),
        { fallbackSubject: resolveDomainSubject(domain) },
      );
      expect(result.grounded).toBe(false);
      expect(result.text).not.toContain(domain);
    }
  });

  it('E2E prod: "liste minhas contas" com markup-only nunca responde "accounts" (grounded)', async () => {
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: async () => envelope({ note: 'ok-but-non-renderable' }),
      responseProvider: async () => '<tool_call>list_accounts</tool_call>',
      events: silent,
    });
    const result = await orchestrator.runTurn(turn('liste minhas contas', 'intent-ptbr-accounts-1'));
    const text = result.response?.text ?? '';
    expect(text).toContain('contas');
    expect(text).not.toContain('accounts');
  });

  it('E2E prod: "liste minhas contas" sem provider nunca responde "accounts" (unavailable)', async () => {
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: async () => envelope({ note: 'ok-but-non-renderable' }),
      events: silent,
    });
    const result = await orchestrator.runTurn(turn('liste minhas contas', 'intent-ptbr-accounts-2'));
    const text = result.response?.text ?? '';
    expect(text).toContain('contas');
    expect(text).not.toContain('accounts');
  });
});
