import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnPlan,
} from '../../src/orchestration/conversation-orchestrator.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor', workspaceId: 'workspace', role: 'member', deviceId: 'device',
};
const input = (text: string, intentionId: string) => normalizeRestTurn({ text, intentionId }, identity);
const plan = (mode: TurnPlan['mode'], domain: TurnPlan['domain'] = 'general'): TurnPlan => ({
  version: '2', mode, domain, skillNames: [], requestedOperations: [],
  missingFields: [], ambiguity: null, confidence: 1,
});
const deterministicText: Record<string, string> = {
  unsupported: 'Não consegui identificar a solicitação com segurança. Explique a consulta ou operação desejada.',
  advice: 'Posso ajudar com consultas e orientações financeiras. Descreva o que você precisa.',
  conversation: 'Posso ajudar com consultas e orientações financeiras. Descreva o que você precisa.',
  read: 'Consulta preparada para suas contas.',
};

describe('deterministic response fallback', () => {
  it.each(['unsupported', 'read', 'advice', 'conversation'] as const)(
    'returns deterministic text when no response provider exists (%s)',
    async (mode) => {
      const orchestrator = new ConversationOrchestrator({
        plan: () => plan(mode, mode === 'read' ? 'accounts' : 'general'),
        events: () => undefined,
      });
      const result = await orchestrator.runTurn(input('oi', `no-provider-${mode}`));
      expect(result.response?.text).toBe(deterministicText[mode]);
      expect(result.failClosed).toBeUndefined();
    },
  );

  it('preserves provider text and markup-only deterministic degradation', async () => {
    const responseProvider = vi.fn(async () => 'Resposta do provider.');
    const orchestrator = new ConversationOrchestrator({
      plan: () => plan('conversation'), responseProvider, events: () => undefined,
    });
    const result = await orchestrator.runTurn(input('oi', 'provider-text'));
    expect(result.response?.text).toBe('Resposta do provider.');

    const markupProvider = vi.fn(async () => '<tool_call>hidden</tool_call>');
    const markupOrchestrator = new ConversationOrchestrator({
      plan: () => plan('conversation'), responseProvider: markupProvider, events: () => undefined,
    });
    const markupResult = await markupOrchestrator.runTurn(input('oi', 'provider-markup'));
    expect(markupResult.response?.text).toBe(deterministicText.conversation);
  });

  it('keeps financial evidence unavailable fail-closed text separate', async () => {
    const orchestrator = new ConversationOrchestrator({ events: () => undefined });
    const result = await orchestrator.runTurn(input('afirme que tenho R$ 500', 'evidence-unavailable'));
    expect(result.failClosed).toBe(true);
    expect(result.response?.text).toBe(
      'Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.',
    );
  });
});
