/**
 * B058 — ano nu como data em mutação ("Gastei R$ 20 em 2020").
 * Deve pedir data completa (ano/data), nunca propor mutação com ano
 * como descrição/data de hoje.
 */
import { describe, expect, it } from 'vitest';
import { interpretMutationUtterance } from '../src/mutations/semantic-interpretation.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';

describe('B058 — ano isolado em mutação pede data completa', () => {
  it('interpretação clarifica data (contém "ano" e "data")', () => {
    const result = interpretMutationUtterance('Gastei R$ 20 em 2020');
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    const text = result.clarification.toLowerCase();
    expect(text).toContain('ano');
    expect(text).toContain('data');
  });

  it('router nunca propõe mutação para "Gastei R$ 20 em 2020"', () => {
    const plan = routeIntent('Gastei R$ 20 em 2020');
    expect(plan.mode).not.toBe('mutation-proposal');
    expect(plan.requestedOperations.some((op) => op.kind === 'mutation')).toBe(false);
  });

  it('turno pede data completa sem proposta nem leitura', async () => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'Gastei R$ 20 em 2020', intentionId: 'intent-b058' },
        { actorId: 'actor-b058', workspaceId: 'ws-b058', role: 'member', deviceId: 'device-b058' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const text = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(text).toContain('ano');
    expect(text).toContain('data');
    expect(text).not.toMatch(/R\$\s*[\d.]+,\d{2}/);
  });

  it('controles válidos preservados: relativa e valor colado ao ano continuam mutação', () => {
    // HIGH: mês+ano não resolvido agora clarifica (ver issue-b058-explicit-date).
    expect(routeIntent('Gastei R$ 50 ontem no mercado').mode).toBe('mutation-proposal');
    expect(routeIntent('Gastei R$ 2020 no mercado').mode).toBe('mutation-proposal');
    const dated = interpretMutationUtterance('Gastei R$ 50 ontem no mercado');
    expect(dated.status).toBe('candidate');
  });

  it('segurança: sem proposta, sem execução, ano nunca vira valor', () => {
    const result = interpretMutationUtterance('Gastei R$ 20 em 2020');
    if (result.status === 'candidate') {
      expect(result.parsed.amountCents).not.toBe(2020 * 100);
      expect(result.parsed.description.toLowerCase()).not.toContain('2020');
    } else {
      expect(result.status).toBe('clarify');
    }
  });

  it('sem falso positivo: descrição legítima com ano ("edição de 2020") continua mutação', () => {
    // "de 2020" aqui complementa o substantivo "edição" (parte da descrição),
    // não é adjunto temporal — o fluxo normal de proposta deve seguir.
    const result = interpretMutationUtterance('Gastei R$ 20 com edição de 2020');
    expect(result.status).toBe('candidate');
    expect(routeIntent('Gastei R$ 20 com edição de 2020').mode).toBe('mutation-proposal');
  });
});
