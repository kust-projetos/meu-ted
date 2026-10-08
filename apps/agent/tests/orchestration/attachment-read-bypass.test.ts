import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { hasAcceptedAttachmentData } from '../../src/finance-chat-agent.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';
import { FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT } from '../../src/responses/deterministic-responses.js';

/**
 * A19-READ-BYPASS: attachment turns routed mode=read terminated in
 * runGroundedRead's deterministic render (empty finance data → "sem dados")
 * WITHOUT calling the LLM — the composed attachment block never got
 * consulted. A server-side `hasAttachmentData` flag (true ONLY on accepted
 * non-empty extraction) skips the deterministic render and lets the turn
 * reach the provider path with the composed text.
 */
const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const readPlan = (domain: 'accounts' | 'transactions' = 'accounts') => ({
  version: '2' as const,
  mode: 'read' as const,
  domain,
  skillNames: ['saldo-extrato'],
  requestedOperations: [{ name: 'get_balance', kind: 'read' as const }],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

/** Deterministic-render envelope: a balance that renders without the model. */
const balanceEnvelope: EvidenceEnvelope = {
  version: '1',
  items: [{
    ref: 'account:acc-1',
    source: 'api.accounts',
    retrievedAt: new Date().toISOString(),
    status: 'ok',
    data: { balanceCents: 12345, accountName: 'Conta principal' },
  }],
};

/**
 * Live-case envelope (A19-READ-BYPASS root cause): finance tools return NO
 * usable rows, so the old code answered deterministically ("sem dados")
 * without ever consulting the composed attachment block.
 */
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

/** Provider text with NO financial claims (money/dates/names) → grounding passes. */
const ATTACHMENT_PROVIDER_TEXT = 'leitura do anexo concluida sem valores.';

describe('A19-READ-BYPASS: attachment data skips the deterministic read render', () => {
  it('read WITH attachment data calls the provider instead of rendering deterministically', async () => {
    const responseProvider = vi.fn(async () => ATTACHMENT_PROVIDER_TEXT);
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan('transactions'),
      evidenceProvider: async () => emptyStatementEnvelope,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn({ text: 'quanto deu a fatura no pdf?', intentionId: 'intent-bypass' }, identity);
    const input = { ...base, hasAttachmentData: true };
    const result = await orchestrator.runTurn(input);
    expect(responseProvider).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toBe(ATTACHMENT_PROVIDER_TEXT);
  });

  it('read WITHOUT attachment data keeps the deterministic render (provider untouched)', async () => {
    const responseProvider = vi.fn(async () => ATTACHMENT_PROVIDER_TEXT);
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan('transactions'),
      evidenceProvider: async () => emptyStatementEnvelope,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: 'quanto deu a fatura no pdf?', intentionId: 'intent-no-bypass' }, identity),
    );
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe('Não há dados disponíveis para extrato.');
  });

  it('null envelope WITH attachment data still fails closed (provider untouched)', async () => {
    const responseProvider = vi.fn(async () => ATTACHMENT_PROVIDER_TEXT);
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan('transactions'),
      evidenceProvider: async () => null,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn({ text: 'o que diz o anexo?', intentionId: 'intent-bypass-null' }, identity);
    const input = { ...base, hasAttachmentData: true };
    const result = await orchestrator.runTurn(input);
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.failClosed).toBe(true);
    expect(result.response?.text).toBe(FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT);
  });

  it('normalize sets the flag ONLY from the server-side option (client body ignored)', () => {
    const normalizeAny = normalizeRestTurn as (...args: unknown[]) => Record<string, unknown>;
    const withFlag = normalizeAny(
      { text: 'o que diz o anexo?', intentionId: 'intent-opt-true' },
      identity,
      { typedText: 'o que diz o anexo?', hasAttachmentData: true },
    );
    expect(withFlag['hasAttachmentData']).toBe(true);
    const withoutOption = normalizeAny(
      { text: 'qual meu saldo?', intentionId: 'intent-opt-absent' },
      identity,
    );
    expect(withoutOption['hasAttachmentData'] ?? false).toBe(false);
    // A client-supplied same-named body field never confers the flag.
    const spoofed = normalizeAny(
      { text: 'qual meu saldo?', intentionId: 'intent-opt-spoof', hasAttachmentData: true },
      identity,
    );
    expect(spoofed['hasAttachmentData'] ?? false).toBe(false);
  });
});

describe('A19-READ-BYPASS: accepted-extraction predicate', () => {
  it('is true ONLY on accepted non-empty extraction', () => {
    expect(hasAcceptedAttachmentData([])).toBe(false);
    expect(hasAcceptedAttachmentData([{ kind: 'pdf', text: '' }])).toBe(false);
    expect(hasAcceptedAttachmentData([{ kind: 'pdf', text: '   ' }])).toBe(false);
    expect(hasAcceptedAttachmentData([{ kind: 'pdf', text: 'conteudo do bloco' }])).toBe(true);
  });
});

describe('A19-GROUND-FORMATS: smuggled figures rejected on attachment turns', () => {
  it.each([
    ['999 reais', 'A fatura totaliza 999 reais.'],
    ['R$ 999', 'A fatura totaliza R$ 999.'],
    ['canonical R$ 999,99', 'A fatura totaliza R$ 999,99.'],
    ['bare decimal in financial context', 'O saldo total é 999,00.'],
  ])('rejects %s without evidence on an attachment turn', async (label, providerText) => {
    const responseProvider = vi.fn(async () => providerText);
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan('transactions'),
      evidenceProvider: async () => emptyStatementEnvelope,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn(
      { text: 'quanto deu a fatura no pdf?', intentionId: `intent-smuggle-${label}` },
      identity,
    );
    const result = await orchestrator.runTurn({ ...base, hasAttachmentData: true });
    expect(responseProvider).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toMatch(/Não foi possível consultar/);
    expect(result.response?.text).not.toMatch(/999/);
  });

  it('rejects a correction retry that smuggles an unverified figure on an attachment turn', async () => {
    const responseProvider = vi.fn(async () => 'A fatura totaliza 999 reais.');
    const correctionProvider = vi.fn(async () => 'Correcao: a fatura totaliza 999 reais.');
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan('transactions'),
      evidenceProvider: async () => emptyStatementEnvelope,
      responseProvider,
      correctionProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn(
      { text: 'quanto deu a fatura no pdf?', intentionId: 'intent-smuggle-correction' },
      identity,
    );
    const result = await orchestrator.runTurn({ ...base, hasAttachmentData: true });
    expect(correctionProvider).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toMatch(/Não foi possível consultar/);
    expect(result.response?.text).not.toMatch(/999/);
  });

  it('still publishes a verified figure on an attachment turn (no over-blocking)', async () => {
    const verifiedEnvelope: EvidenceEnvelope = {
      version: '1',
      items: [{
        ref: 'account:acc-1',
        source: 'api.accounts',
        retrievedAt: new Date().toISOString(),
        status: 'ok',
        data: { balanceCents: 99900, accountName: 'Conta principal' },
      }],
    };
    const responseProvider = vi.fn(async () => 'Seu saldo é R$ 999 na Conta principal.');
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlan('accounts'),
      evidenceProvider: async () => verifiedEnvelope,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn(
      { text: 'qual meu saldo no extrato?', intentionId: 'intent-verified-attachment' },
      identity,
    );
    const result = await orchestrator.runTurn({ ...base, hasAttachmentData: true });
    expect(result.response?.text).toBe('Seu saldo é R$ 999 na Conta principal.');
  });
});
