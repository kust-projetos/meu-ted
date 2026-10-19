/**
 * Residual 4012 (prod pt-BR): path `read` SEM evidenceProvider vazava o id
 * cru de domínio em inglês ("Consulta preparada para accounts.").
 *
 * RED: markup-only no path ungrounded deve degradar para o fallback
 * determinístico em pt-BR com o sujeito resolvido — nunca o id cru.
 */
import { describe, expect, it } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';

const identity: AuthenticatedIdentity = { actorId: 'actor-1', workspaceId: 'ws-1', role: 'owner', deviceId: 'dev-1' };
const turn = (text: string, intentionId: string) =>
  normalizeRestTurn({ text, intentionId, traceId: intentionId }, identity);
const silent = (): void => undefined;

describe('ungrounded read sem evidenceProvider (residual 4012)', () => {
  it('markup-only em "liste minhas contas" rende pt-BR com sujeito resolvido, nunca "accounts"', async () => {
    const orchestrator = new ConversationOrchestrator({
      responseProvider: async () => '<tool_call>list_accounts</tool_call>',
      events: silent,
    });
    const result = await orchestrator.runTurn(turn('liste minhas contas', 'intent-4012-accounts-1'));
    expect(result.plan.mode).toBe('read');
    const text = result.response?.text ?? '';
    expect(text).toContain('suas contas');
    expect(text).not.toContain('accounts');
  });
});
