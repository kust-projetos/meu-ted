import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';
import { FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT } from '../../src/responses/deterministic-responses.js';

/**
 * A19-GROUND-EVIDENCE (orchestrator): on an attachment turn the admitted
 * block text travels server-side into grounded validation, so a reply
 * citing the block figure publishes while an invented figure is still
 * rejected. Admitted texts are attachment-extracted ONLY — never typed
 * text, never client input.
 *
 * V1-GROUND-ATTRIBUTION: a block figure is published only when the reply
 * ATTRIBUTES it to the document; an unattributed figure fails closed.
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

/**
 * P0-ATTACHMENT-BYPASS: the deterministic path owns tool-empty turns, so the
 * publish path below carries a (non-covering) tool money row — the block
 * figure publishes as an attributed citation supplementing tool evidence,
 * never on its own.
 */
const supplementedStatementEnvelope: EvidenceEnvelope = {
  version: '1',
  items: [{
    ref: 'statement',
    source: 'api.transactions',
    retrievedAt: new Date().toISOString(),
    status: 'ok',
    data: [{ feeCents: 1 }],
  }],
};

const BLOCK = ['fatura do cartao Nubank total R$ 999,00 Conta principal'];

describe('A19-GROUND-EVIDENCE: attachment turns publish block-grounded replies', () => {
  it('fails closed on stale-only evidence and emits sanitized freshness telemetry', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const staleEnvelope: EvidenceEnvelope = {
      version: '1',
      items: [{
        ref: 'private-ref',
        source: 'api.transactions',
        retrievedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        status: 'ok',
        data: [{ amountCents: 123456, description: 'private-data' }],
      }],
      omittedReads: ['accounts'],
    };
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan(),
      evidenceProvider: async () => staleEnvelope,
      responseProvider: vi.fn(async () => 'não deve narrar'),
      events: (type, fields) => events.push({ type, fields }),
    });
    const result = await orchestrator.runTurn(normalizeRestTurn(
      { text: 'qual meu saldo?', intentionId: 'intent-stale-only' },
      identity,
      { typedText: 'qual meu saldo?' },
    ));
    expect(result.response?.text).toBe(FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT);
    expect(result.response?.text).not.toContain('1.234,56');
    expect(events.filter((event) => event.type === 'agent.evidence.stale')).toEqual([
      { type: 'agent.evidence.stale', fields: expect.objectContaining({ staleCount: 1, currentCount: 0 }) },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private-ref|private-data|123456/);
    expect(staleEnvelope.items).toHaveLength(1);
    expect(staleEnvelope.omittedReads).toEqual(['accounts']);
    expect(result.mutation).toBeUndefined();
  });

  it('keeps current evidence, excludes stale values, and emits only aggregate stale telemetry', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan(),
      evidenceProvider: async () => ({
        version: '1',
        items: [
          { ref: 'current-ref', source: 'api.transactions', retrievedAt: new Date().toISOString(), status: 'ok', data: [{ amountCents: 1234, description: 'current' }] },
          { ref: 'stale-ref', source: 'api.transactions', retrievedAt: new Date(Date.now() - 10 * 60_000).toISOString(), status: 'ok', data: [{ amountCents: 999999, description: 'stale-private' }] },
        ],
      }),
      responseProvider: vi.fn(async () => 'O valor atual é R$ 12,34 na Conta principal.'),
      events: (type, fields) => events.push({ type, fields }),
    });
    const result = await orchestrator.runTurn(normalizeRestTurn(
      { text: 'qual meu saldo?', intentionId: 'intent-stale-mixed' }, identity,
      { typedText: 'qual meu saldo?', hasAttachmentData: true, attachmentTexts: BLOCK },
    ));
    expect(result.response?.text).toContain('12,34');
    expect(result.response?.text).not.toMatch(/9\.999,99|stale-private/);
    const stale = events.filter((event) => event.type === 'agent.evidence.stale');
    expect(stale).toHaveLength(1);
    expect(stale[0].fields).toEqual({
      intentionId: 'intent-stale-mixed',
      traceId: expect.any(String),
      domain: 'transactions',
      staleCount: 1,
      currentCount: 1,
    });
    expect(JSON.stringify(stale)).not.toMatch(/999999|stale-ref|api\.transactions|12,34/);
    expect(result.mutation).toBeUndefined();
  });

  it('does not emit stale telemetry for current-only or non-ok evidence and preserves A04/R04 failure behavior', async () => {
    const run = async (items: EvidenceEnvelope['items']) => {
      const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
      const orchestrator = new ConversationOrchestrator({
        plan: () => readPlan(),
        evidenceProvider: async () => ({ version: '1', items }),
        responseProvider: vi.fn(async () => 'não deve narrar'),
        events: (type, fields) => events.push({ type, fields }),
      });
      const result = await orchestrator.runTurn(normalizeRestTurn(
        { text: 'qual meu saldo?', intentionId: 'intent-no-stale' }, identity,
      ));
      return { result, events };
    };
    const current = await run([{
      ref: 'current', source: 'api.transactions', retrievedAt: new Date().toISOString(),
      status: 'ok', data: [{ amountCents: 1234 }],
    }]);
    expect(current.events.some((event) => event.type === 'agent.evidence.stale')).toBe(false);
    expect(current.result.mutation).toBeUndefined();

    const nonOk = await run([
      { ref: 'empty', source: 'api.transactions', retrievedAt: new Date().toISOString(), status: 'empty', reason: 'entity_not_found', data: [] },
      { ref: 'error', source: 'api.accounts', retrievedAt: new Date().toISOString(), status: 'error', reason: 'unavailable', data: null },
    ]);
    expect(nonOk.events.some((event) => event.type === 'agent.evidence.stale')).toBe(false);
    expect(nonOk.result.response?.text).toBe(FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT);
    expect(nonOk.result.failClosed).toBe(true);
    expect(nonOk.result.mutation).toBeUndefined();
  });

  it('publishes a reply citing the admitted block figure (with tool money present)', async () => {
    const providerText = 'Segundo o anexo, a fatura é R$ 999 na Conta principal.';
    const responseProvider = vi.fn(async () => providerText);
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan(),
      evidenceProvider: async () => supplementedStatementEnvelope,
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

  it('stays deterministic on a tool-empty turn instead of publishing the block figure (P0)', async () => {
    const providerText = 'Segundo o anexo, a fatura é R$ 999 na Conta principal.';
    const responseProvider = vi.fn(async () => providerText);
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan(),
      evidenceProvider: async () => emptyStatementEnvelope,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn(
      { text: 'quanto deu a fatura no pdf?', intentionId: 'intent-block-empty-tools' },
      identity,
      { typedText: 'quanto deu a fatura no pdf?', hasAttachmentData: true, attachmentTexts: BLOCK },
    );
    const result = await orchestrator.runTurn(base);
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe('Não há dados disponíveis para extrato.');
    expect(result.response?.text).not.toMatch(/999/);
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
    // P0: an empty tool envelope never reaches the provider — the
    // deterministic render answers without any figure.
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe('Não há dados disponíveis para extrato.');
    expect(result.response?.text).not.toMatch(/888,88/);
  });

  it('rejects an UNATTRIBUTED block figure: the document is not provenance', async () => {
    // V1-GROUND-ATTRIBUTION: the figure IS in the block, yet the reply
    // presents it as workspace state — a deny-list alone would publish it.
    // P0: an empty tool envelope never reaches the provider either way.
    const responseProvider = vi.fn(async () => 'A fatura é R$ 999 na Conta principal.');
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan(),
      evidenceProvider: async () => emptyStatementEnvelope,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn(
      { text: 'quanto deu a fatura no pdf?', intentionId: 'intent-block-unattributed' },
      identity,
      { typedText: 'quanto deu a fatura no pdf?', hasAttachmentData: true, attachmentTexts: BLOCK },
    );
    const result = await orchestrator.runTurn(base);
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe('Não há dados disponíveis para extrato.');
    expect(result.response?.text).not.toMatch(/999/);
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
