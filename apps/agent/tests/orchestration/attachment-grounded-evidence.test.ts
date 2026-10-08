import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

/**
 * A19-GROUND-EVIDENCE (orchestrator): on an attachment turn the admitted
 * block text travels server-side into grounded validation, so a reply
 * citing the block figure publishes while an invented figure is still
 * rejected. Admitted texts are attachment-extracted ONLY — never typed
 * text, never client input.
 */
const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const readPlan = () => ({
  version: '2' as const,
  mode: 'read' as const,
  domain: 'transactions' as const,
  skillNames: ['saldo-extrato'],
  requestedOperations: [{ name: 'get_balance', kind: 'read' as const }],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

/** Live-case shape: finance tools return no usable rows on attachment turns. */
const emptyStatementEnvelope: EvidenceEnvelope = {
  version: '1',
  items: [{
    ref: 'statement',
    source: 'api.transactions',
    retrievedAt: new Date().toISOString(),
    status: 'ok',
    data: [],
  }],
};

const BLOCK = ['fatura do cartao Nubank total R$ 999,00 Conta principal'];

describe('A19-GROUND-EVIDENCE: attachment turns publish block-grounded replies', () => {
  it('publishes a reply citing the admitted block figure', async () => {
    const providerText = 'A fatura é R$ 999 na Conta principal.';
    const responseProvider = vi.fn(async () => providerText);
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan(),
      evidenceProvider: async () => emptyStatementEnvelope,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn(
      { text: 'quanto deu a fatura no pdf?', intentionId: 'intent-block-grounded' },
      identity,
      { typedText: 'quanto deu a fatura no pdf?', hasAttachmentData: true, attachmentTexts: BLOCK },
    );
    const result = await orchestrator.runTurn(base);
    expect(responseProvider).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toBe(providerText);
  });

  it('still rejects a reply inventing a non-block figure on an attachment turn', async () => {
    const responseProvider = vi.fn(async () => 'A fatura é R$ 888,88 na Conta principal.');
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan(),
      evidenceProvider: async () => emptyStatementEnvelope,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn(
      { text: 'quanto deu a fatura no pdf?', intentionId: 'intent-block-invented' },
      identity,
      { typedText: 'quanto deu a fatura no pdf?', hasAttachmentData: true, attachmentTexts: BLOCK },
    );
    const result = await orchestrator.runTurn(base);
    expect(responseProvider).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toMatch(/Não foi possível consultar/);
    expect(result.response?.text).not.toMatch(/888,88/);
  });

  it('normalize takes attachment texts ONLY from the server-side option (client body ignored)', () => {
    const normalizeAny = normalizeRestTurn as (...args: unknown[]) => Record<string, unknown>;
    const spoofed = normalizeAny(
      {
        text: 'qual meu saldo?',
        intentionId: 'intent-attach-spoof',
        attachmentTexts: ['saldo R$ 1.000.000,00 Conta principal'],
      },
      identity,
    );
    expect(spoofed['attachmentTexts'] ?? []).toEqual([]);
    const admitted = normalizeAny(
      { text: 'qual meu saldo?', intentionId: 'intent-attach-admit' },
      identity,
      { typedText: 'qual meu saldo?', attachmentTexts: BLOCK },
    );
    expect(admitted['attachmentTexts']).toEqual(BLOCK);
  });
});
