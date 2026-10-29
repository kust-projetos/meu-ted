/**
 * HIGH (review): data explícita que o parser financeiro não resolve nunca
 * pode virar "hoje" em silêncio — `dateFor` só entende hoje/ontem/anteontem.
 * Casos: mês+ano ("em janeiro de 2020"), data numérica ("dia 12/03") e
 * valor igual ao ano com moeda explícita ("R$ 2020 ... de 2020").
 * Todos devem clarificar (missingFields date), nunca propor com hoje.
 */
import { describe, expect, it } from 'vitest';
import { interpretMutationUtterance } from '../src/mutations/semantic-interpretation.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';

const clarificationOf = (result: unknown): string => {
  const r = result as { clarification?: string };
  return (r.clarification ?? '').toLowerCase();
};

describe('HIGH — data explícita não resolvida nunca vira hoje', () => {
  it('mês+ano clarifica data ("Gastei R$ 50 em janeiro de 2020")', () => {
    const result = interpretMutationUtterance('Gastei R$ 50 em janeiro de 2020');
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    expect(clarificationOf(result)).toContain('data');
    expect(routeIntent('Gastei R$ 50 em janeiro de 2020').mode).not.toBe('mutation-proposal');
  });

  it('data numérica clarifica data ("Gastei R$ 50 dia 12/03")', () => {
    const result = interpretMutationUtterance('Gastei R$ 50 dia 12/03');
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    expect(clarificationOf(result)).toContain('data');
    expect(routeIntent('Gastei R$ 50 dia 12/03').mode).not.toBe('mutation-proposal');
  });

  it('valor igual ao ano com moeda explícita clarifica ("Gastei R$ 2020 de 2020")', () => {
    const result = interpretMutationUtterance('Gastei R$ 2020 de 2020');
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.missingFields).toContain('date');
    expect(routeIntent('Gastei R$ 2020 de 2020').mode).not.toBe('mutation-proposal');
    expect(routeIntent('Gastei R$ 2020 em 2020').mode).not.toBe('mutation-proposal');
  });

  it('turno com data numérica pede data sem proposta', async () => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'Gastei R$ 50 dia 12/03', intentionId: 'intent-high-numdate' },
        { actorId: 'actor-high', workspaceId: 'ws-high', role: 'member', deviceId: 'device-high' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const text = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(text).toContain('data');
  });

  it('controles seguros preservados: relativa, sem data, colado e B058', () => {
    // Data relativa resolvível continua candidata.
    expect(interpretMutationUtterance('Gastei R$ 50 ontem').status).toBe('candidate');
    // Sem material de data: default hoje documentado, fluxo normal.
    expect(interpretMutationUtterance('Gastei R$ 50 com carne').status).toBe('candidate');
    // Valor colado ao ano sem adjunto de data: mutação legítima.
    expect(interpretMutationUtterance('Gastei R$ 2020 no mercado').status).toBe('candidate');
    expect(routeIntent('Gastei R$ 2020 no mercado').mode).toBe('mutation-proposal');
    // B058 intacto.
    const b058 = interpretMutationUtterance('Gastei R$ 20 em 2020');
    expect(b058.status).toBe('clarify');
  });
});

describe('HIGH — data explícita anteposta ao valor também clarifica', () => {
  it('ano anteposto clarifica ("Em 2020 gastei R$ 20 no mercado")', () => {
    const result = interpretMutationUtterance('Em 2020 gastei R$ 20 no mercado');
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    // Só a data falta: valor e descrição seguem intactos no turno.
    expect([...result.missingFields]).toEqual(['date']);
    const text = clarificationOf(result);
    expect(text).toContain('ano');
    expect(text).toContain('data');
    expect(routeIntent('Em 2020 gastei R$ 20 no mercado').mode).not.toBe('mutation-proposal');
  });

  it('data numérica anteposta clarifica ("Dia 12/03 gastei R$ 50 no mercado")', () => {
    const result = interpretMutationUtterance('Dia 12/03 gastei R$ 50 no mercado');
    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect([...result.missingFields]).toEqual(['date']);
    expect(clarificationOf(result)).toContain('data');
    expect(routeIntent('Dia 12/03 gastei R$ 50 no mercado').mode).not.toBe('mutation-proposal');
  });

  it('turno com ano anteposto pede data sem proposta', async () => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'Em 2020 gastei R$ 20 no mercado', intentionId: 'intent-high-prefix' },
        { actorId: 'actor-high', workspaceId: 'ws-high', role: 'member', deviceId: 'device-high' },
      ),
    );
    expect(result.mutation).toBeUndefined();
    const text = (result.clarification?.text ?? result.response?.text ?? '').toLowerCase();
    expect(text).toContain('ano');
    expect(text).toContain('data');
  });

  it('controles: S8 continua leitura e nominal anteposto continua mutação', () => {
    // Ano-como-valor sem moeda explícita pertence ao guard S8 do router.
    expect(interpretMutationUtterance('Quanto gastei em janeiro de 2020?').status).toBe('candidate');
    expect(routeIntent('Quanto gastei em janeiro de 2020?').mode).toBe('read');
    // "de 2020" nominal anteposto não é adjunto temporal.
    expect(interpretMutationUtterance('Edição de 2020, gastei R$ 20').status).toBe('candidate');
    // Sem R$ mas com adjunto temporal anteposto: clarifica.
    expect(interpretMutationUtterance('Em 2020 gastei 20 no mercado').status).toBe('clarify');
  });
});
