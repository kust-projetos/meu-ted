/**
 * TED read-path pack 1 (F1–F4) — TDD RED→GREEN.
 *
 * F1: /rpc/chat persists the user message on EVERY answered deterministic
 *     read turn (not only fail-closed), deduped by stable intention ids.
 * F2: read-absence copy uses non-possessive domain subjects.
 * F3: "comprei" lexicon + installment guard.
 * F4: deterministic missing-amount reply without provider call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  normalizeSdkTurn,
  ATTACHMENT_CONTENT_UNVERIFIED_TEXT,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { renderReadAbsence } from '../src/responses/deterministic-responses.js';
import {
  isClearlyMutating,
  parseFinancialMutation,
} from '../src/mutations/financial-parser.js';
import {
  hasMutationIntentSignal,
  interpretMutationUtterance,
} from '../src/mutations/semantic-interpretation.js';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { attachRelayUsageStorage } from './helpers/relay-usage-storage.js';

const MISSING_AMOUNT_TEXT =
  'Não identifiquei o valor a registrar. Informe o valor e a descrição.';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-pack1',
  workspaceId: 'workspace-pack1',
  role: 'member',
  deviceId: 'device-pack1',
};

const turn = (text: string, intentionId: string) =>
  normalizeRestTurn({ text, intentionId }, identity);

// ---------------------------------------------------------------------------
// F3 — parser lexicon + installment guard
// ---------------------------------------------------------------------------
describe('F3: "comprei" lexicon + installment guard', () => {
  it('isClearlyMutating recognizes "comprei"', () => {
    expect(isClearlyMutating('comprei 30 reais de carne no cartão')).toBe(true);
  });

  it('"comprei 30 reais de carne no cartão" parses as expense 3000', () => {
    const result = parseFinancialMutation('comprei 30 reais de carne no cartão');
    expect(result).toMatchObject({ kind: 'expense', amountCents: 3000 });
    if (result.kind === 'expense') {
      expect(result.description).toContain('carne');
    }
  });

  it('"comprei 2500 reais de bicicleta em 10x" parses as expense 250000 (installment is not the value)', () => {
    const result = parseFinancialMutation('comprei 2500 reais de bicicleta em 10x');
    expect(result).toMatchObject({ kind: 'expense', amountCents: 250000 });
  });

  it('"comprei uma bicicleta parcela em 10 x" is missing_amount, never 1000', () => {
    const result = parseFinancialMutation('comprei uma bicicleta parcela em 10 x');
    expect(result).toMatchObject({ kind: 'none', reason: 'missing_amount' });
  });

  it('RED P2-1: "comprei 10 parcelas de 250" is missing_amount (count, never 1000)', () => {
    expect(parseFinancialMutation('comprei 10 parcelas de 250')).toMatchObject({
      kind: 'none',
      reason: 'missing_amount',
    });
  });

  it('RED P2-1: "gastei 10 parcelas de 250" is missing_amount (pre-existing verb, same guard)', () => {
    expect(parseFinancialMutation('gastei 10 parcelas de 250')).toMatchObject({
      kind: 'none',
      reason: 'missing_amount',
    });
  });

  it('RED P2-1: "paguei 10 prestações de 250" is missing_amount', () => {
    expect(parseFinancialMutation('paguei 10 prestações de 250')).toMatchObject({
      kind: 'none',
      reason: 'missing_amount',
    });
  });

  it('pin: "paguei a parcela de 250" parses expense 25000 (value sits after "de")', () => {
    expect(parseFinancialMutation('paguei a parcela de 250')).toMatchObject({
      kind: 'expense',
      amountCents: 25000,
    });
  });

  it('non-regression pin: "gastei 90 com carne" stays expense 9000', () => {
    expect(parseFinancialMutation('gastei 90 com carne')).toMatchObject({
      kind: 'expense',
      amountCents: 9000,
    });
  });

  it('non-regression pin: "paguei 50 no mercado" stays expense 5000', () => {
    expect(parseFinancialMutation('paguei 50 no mercado')).toMatchObject({
      kind: 'expense',
      amountCents: 5000,
    });
  });

  it('"não comprei nada" stays none/negation', () => {
    expect(parseFinancialMutation('não comprei nada')).toMatchObject({
      kind: 'none',
      reason: 'negation',
    });
  });

  it('"comprei 30 reais de carne no cartão" routes to mutation-proposal (not read/cards)', () => {
    const plan = routeIntent('comprei 30 reais de carne no cartão');
    expect(plan.mode).toBe('mutation-proposal');
    expect(plan.domain).toBe('transactions');
  });
});

// ---------------------------------------------------------------------------
// F2 — absence copy per domain
// ---------------------------------------------------------------------------
describe('F2: read-absence copy per domain', () => {
  const absenceEnvelope = (reason: 'setup_incomplete' | 'period_empty' = 'setup_incomplete') => ({
    version: '1' as const,
    items: [
      {
        ref: 'test',
        source: 'api.test',
        retrievedAt: new Date().toISOString(),
        status: 'empty' as const,
        data: [],
        reason,
      },
    ],
  });

  const readPlanFor = (domain: 'cards' | 'payables' | 'budgets') =>
    ({
      version: '2' as const,
      mode: 'read' as const,
      domain,
      skillNames: [],
      requestedOperations: [{ name: 'list', kind: 'read' as const }],
      missingFields: [],
      ambiguity: null,
      confidence: 0.95,
    }) as never;

  it.each([
    ['cards', 'faturas'],
    ['payables', 'contas a pagar'],
    ['budgets', 'orçamentos'],
  ] as const)('domain %s answers absence with "%s" and never "dados"', async (domain, noun) => {
    const orchestrator = new ConversationOrchestrator({
      plan: () => readPlanFor(domain),
      evidenceProvider: async () => absenceEnvelope(),
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(turn(`mostre ${noun}`, `intent-f2-${domain}`));
    expect(result.response?.text).toContain(noun);
    expect(result.response?.text).not.toContain('dados');
  });

  it('real router: "liste meus cartões" routes read/cards; absence names the statements read (faturas)', async () => {
    const plan = routeIntent('liste meus cartões');
    expect(plan.mode).toBe('read');
    expect(plan.domain).toBe('cards');
    const evidenceProvider = vi.fn(async () => absenceEnvelope());
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider,
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(turn('liste meus cartões', 'intent-f2-cards-real'));
    expect(evidenceProvider).toHaveBeenCalledTimes(1);
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toContain('faturas');
    expect(result.response?.text).not.toContain('dados');
  });

  it('renderReadAbsence unit pins (no fallback "dados")', () => {
    // `cards` names the statements read (`/cards/statements` = faturas), not
    // the card pool: an empty statement list must never claim "no cartões".
    expect(renderReadAbsence('setup_incomplete', 'faturas')).toContain('faturas');
    expect(renderReadAbsence('period_empty', 'contas a pagar')).toContain('contas a pagar');
    expect(renderReadAbsence('period_empty', 'orçamentos')).toContain('orçamentos');
  });
});

// ---------------------------------------------------------------------------
// F4 — deterministic missing-amount reply (no provider)
// ---------------------------------------------------------------------------
describe('F4: deterministic missing-amount reply', () => {
  it('"comprei uma bicicleta parcela em 10 x" answers deterministically without the provider', async () => {
    const text = 'comprei uma bicicleta parcela em 10 x';
    expect(hasMutationIntentSignal(text)).toBe(true);
    const interpretation = interpretMutationUtterance(text);
    expect(interpretation.status).toBe('unparsed');
    if (interpretation.status === 'unparsed') {
      expect(interpretation.reason).toBe('missing_amount');
    }
    expect(routeIntent(text).mode).toBe('unsupported');

    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(turn(text, 'intent-f4-parcela'));
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe(MISSING_AMOUNT_TEXT);
    expect([...result.plan.missingFields]).toEqual(['amount']);
  });

  it('"quanto gastei esse mês?" is NOT intercepted by F4 (stays read)', () => {
    expect(routeIntent('quanto gastei esse mês?').mode).toBe('read');
  });

  it('"bom dia" small talk still reaches the provider', async () => {
    expect(routeIntent('bom dia').mode).toBe('unsupported');
    const responseProvider = vi.fn(async () => 'Bom dia! Como posso ajudar?');
    const orchestrator = new ConversationOrchestrator({
      responseProvider,
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(turn('bom dia', 'intent-f4-smalltalk'));
    expect(responseProvider).toHaveBeenCalledTimes(1);
    expect(result.response?.text).toBe('Bom dia! Como posso ajudar?');
  });
});

// ---------------------------------------------------------------------------
// CORREÇÃO 2 (P2-2) — missing-amount gate fires on read-mode turns too,
// BEFORE the evidence read (real router, no injected plan)
// ---------------------------------------------------------------------------
describe('F4-read: missing-amount gate before the read branch', () => {
  const absenceEnvelope = () => ({
    version: '1' as const,
    items: [
      {
        ref: 'test',
        source: 'api.test',
        retrievedAt: new Date().toISOString(),
        status: 'empty' as const,
        data: [],
        reason: 'setup_incomplete' as const,
      },
    ],
  });

  const runReal = (text: string, intentionId: string, options?: { hasAttachmentData?: boolean }) => {
    const evidenceProvider = vi.fn(async () => absenceEnvelope() as never);
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider,
      responseProvider,
      events: () => undefined,
    });
    const input =
      options?.hasAttachmentData === true
        ? normalizeRestTurn({ text, intentionId }, identity, { hasAttachmentData: true })
        : turn(text, intentionId);
    return { orchestrator, input, evidenceProvider, responseProvider };
  };

  it('RED P2-2: "comprei uma bicicleta no cartão" routes read/cards but answers missing-amount without any read or provider', async () => {
    const text = 'comprei uma bicicleta no cartão';
    const plan = routeIntent(text);
    expect(plan.mode).toBe('read');
    expect(plan.domain).toBe('cards');

    const { orchestrator, input, evidenceProvider, responseProvider } = runReal(text, 'intent-f4r-bike');
    const result = await orchestrator.runTurn(input);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe(MISSING_AMOUNT_TEXT);
    expect([...result.plan.missingFields]).toEqual(['amount']);
  });

  it('"comprei uma bicicleta parcela em 10 x" (unsupported) answers missing-amount without any read or provider', async () => {
    const text = 'comprei uma bicicleta parcela em 10 x';
    expect(routeIntent(text).mode).toBe('unsupported');
    const { orchestrator, input, evidenceProvider, responseProvider } = runReal(text, 'intent-f4r-parcela');
    const result = await orchestrator.runTurn(input);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe(MISSING_AMOUNT_TEXT);
    expect([...result.plan.missingFields]).toEqual(['amount']);
  });

  it('attachment wins: hasAttachmentData=true answers the attachment fail-closed copy, not missing-amount', async () => {
    const text = 'comprei uma bicicleta no cartão';
    const { orchestrator, input, evidenceProvider, responseProvider } = runReal(text, 'intent-f4r-attach', {
      hasAttachmentData: true,
    });
    const result = await orchestrator.runTurn(input);
    expect(result.response?.text).toBe(ATTACHMENT_CONTENT_UNVERIFIED_TEXT);
    expect(result.response?.text).not.toBe(MISSING_AMOUNT_TEXT);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('"me mostra o que eu comprei no cartão" is NOT intercepted (read cue) — absence copy answers', async () => {
    const text = 'me mostra o que eu comprei no cartão';
    expect(routeIntent(text).mode).toBe('read');
    const { orchestrator, input, evidenceProvider, responseProvider } = runReal(text, 'intent-f4r-show');
    const result = await orchestrator.runTurn(input);
    expect(evidenceProvider).toHaveBeenCalledTimes(1);
    expect(result.response?.text).not.toBe(MISSING_AMOUNT_TEXT);
    expect(responseProvider).not.toHaveBeenCalled();
  });

  it('"você sabe quanto gastei esse mês?" is NOT intercepted (interrogative)', async () => {
    const text = 'você sabe quanto gastei esse mês?';
    const { orchestrator, input, evidenceProvider } = runReal(text, 'intent-f4r-sabe');
    const result = await orchestrator.runTurn(input);
    expect(evidenceProvider).toHaveBeenCalledTimes(1);
    expect(result.response?.text).not.toBe(MISSING_AMOUNT_TEXT);
  });
});

// ---------------------------------------------------------------------------
// F4-sdk — missing-amount gate is channel-independent (sdk has no exception):
// an amount-less mutation turn on the sdk channel answers deterministically
// without any read or provider, exactly like pwa-rest/broker.
// ---------------------------------------------------------------------------
describe('F4-sdk: missing-amount gate fires on the sdk channel too', () => {
  const sdkAbsenceEnvelope = () => ({
    version: '1' as const,
    items: [
      {
        ref: 'test',
        source: 'api.test',
        retrievedAt: new Date().toISOString(),
        status: 'empty' as const,
        data: [],
        reason: 'setup_incomplete' as const,
      },
    ],
  });

  const runSdkReal = (text: string, intentionId: string) => {
    const evidenceProvider = vi.fn(async () => sdkAbsenceEnvelope() as never);
    const responseProvider = vi.fn(async () => 'invented by model');
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider,
      responseProvider,
      events: () => undefined,
    });
    const input = normalizeSdkTurn({ text, intentionId }, identity);
    return { orchestrator, input, evidenceProvider, responseProvider };
  };

  it('sdk "comprei uma bicicleta parcela em 10 x" (unsupported) answers missing-amount without any read or provider', async () => {
    const text = 'comprei uma bicicleta parcela em 10 x';
    expect(routeIntent(text).mode).toBe('unsupported');
    const { orchestrator, input, evidenceProvider, responseProvider } = runSdkReal(text, 'intent-f4sdk-parcela');
    expect(input.channel).toBe('sdk');
    const result = await orchestrator.runTurn(input);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe(MISSING_AMOUNT_TEXT);
    expect([...result.plan.missingFields]).toEqual(['amount']);
  });

  it('sdk "comprei uma bicicleta no cartão" (read) answers missing-amount without any read or provider', async () => {
    const text = 'comprei uma bicicleta no cartão';
    expect(routeIntent(text).mode).toBe('read');
    const { orchestrator, input, evidenceProvider, responseProvider } = runSdkReal(text, 'intent-f4sdk-bike');
    expect(input.channel).toBe('sdk');
    const result = await orchestrator.runTurn(input);
    expect(evidenceProvider).not.toHaveBeenCalled();
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe(MISSING_AMOUNT_TEXT);
    expect([...result.plan.missingFields]).toEqual(['amount']);
  });
});

// ---------------------------------------------------------------------------
// F1 — /rpc/chat persists the user message on deterministic reads
// ---------------------------------------------------------------------------
describe('F1: /rpc/chat persists user+assistant on deterministic reads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createTestAgent = () => {
    const persisted: UIMessage[] = [];
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
      messages: UIMessage[];
      persistMessages: (msgs: UIMessage[]) => Promise<void>;
    };
    agent.messages = persisted;
    agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
      persisted.push(...msgs);
    });
    Object.defineProperty(agent, 'state', {
      value: { storage: {} },
      writable: true,
      configurable: true,
    });
    attachRelayUsageStorage(agent);
    Object.defineProperty(agent, 'env', {
      value: {
        API_ORIGIN: 'https://api.test.local',
        AGENT_DELEGATION_SECRET: 'agent-test-secret-pack1',
      },
      writable: true,
      configurable: true,
    });
    return { agent, persisted };
  };

  const chatHeaders = {
    'content-type': 'application/json',
    'x-agent-actor': 'actor-pack1',
    'x-agent-workspace': 'workspace-pack1',
    'x-agent-device': 'device-pack1',
  };

  const absenceEnvelope = () => ({
    version: '1' as const,
    items: [
      {
        ref: 'test',
        source: 'api.test',
        retrievedAt: new Date().toISOString(),
        status: 'empty' as const,
        data: [],
        reason: 'setup_incomplete' as const,
      },
    ],
  });

  const stubDeterministicRead = (agent: { messages: UIMessage[] }) => {
    (agent as unknown as { orchestratorForChannel: () => ConversationOrchestrator }).orchestratorForChannel =
      () =>
        new ConversationOrchestrator({
          plan: () =>
            ({
              version: '2',
              mode: 'read',
              domain: 'cards',
              skillNames: [],
              requestedOperations: [{ name: 'list_cards', kind: 'read' }],
              missingFields: [],
              ambiguity: null,
              confidence: 0.95,
            }) as never,
          evidenceProvider: async () => absenceEnvelope() as never,
          events: () => undefined,
        });
  };

  const post = (agent: FinanceChatAgent, text: string, intentionId: string) =>
    (agent as unknown as { fetch: typeof fetch }).fetch(
      new Request('https://agent.test.local/rpc/chat', {
        method: 'POST',
        headers: chatHeaders,
        body: JSON.stringify({ text, intentionId }),
      }),
    );

  it('deterministic read persists user AND assistant with stable ids', async () => {
    const { agent, persisted } = createTestAgent();
    stubDeterministicRead(agent);
    const res = await post(agent, 'mostre meus cartões', 'intent-f1-read');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: string };
    expect(body.output).toContain('faturas');

    const userIds = persisted.filter((m) => m.role === 'user').map((m) => String((m as { id?: unknown }).id ?? ''));
    const asstIds = persisted
      .filter((m) => m.role === 'assistant')
      .map((m) => String((m as { id?: unknown }).id ?? ''));
    expect(userIds).toContain('msg-user-intent-f1-read');
    // NOTE: the assistant stable id is `msg-asst-*` (stableHistoryMessageId),
    // not `msg-assistant-*` — pinned to the real contract.
    expect(asstIds).toContain('msg-asst-intent-f1-read');
  });

  it('redelivery of the same intentionId persists zero new rows', async () => {
    const { agent, persisted } = createTestAgent();
    stubDeterministicRead(agent);
    const first = await post(agent, 'mostre meus cartões', 'intent-f1-redelivery');
    expect(first.status).toBe(200);
    const countAfterFirst = persisted.length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(2);

    const second = await post(agent, 'mostre meus cartões', 'intent-f1-redelivery');
    expect(second.status).toBe(200);
    expect(persisted.length).toBe(countAfterFirst);
  });

  it('provider-persisted user is never duplicated by the handler (exactly once)', async () => {
    const { agent, persisted } = createTestAgent();
    stubDeterministicRead(agent);
    // Simulate the provider path: the user bubble was already persisted
    // under the stable id (provideUnifiedResponse dedupes via this.messages).
    // NOTE: agent.messages IS the persisted array in this harness — one push.
    const preSeeded = {
      id: 'msg-user-intent-f1-pre',
      role: 'user',
      parts: [{ type: 'text', text: 'mostre meus cartões' }],
      metadata: {},
    } as unknown as UIMessage;
    agent.messages.push(preSeeded);

    const res = await post(agent, 'mostre meus cartões', 'intent-f1-pre');
    expect(res.status).toBe(200);
    const userRows = persisted
      .filter((m) => m.role === 'user')
      .map((m) => String((m as { id?: unknown }).id ?? ''));
    expect(userRows.filter((id) => id === 'msg-user-intent-f1-pre')).toHaveLength(1);
  });

  it('fail-closed contract is unchanged (user+assistant persisted, failClosed set)', async () => {
    const { agent, persisted } = createTestAgent();
    (agent as unknown as { orchestratorForChannel: () => ConversationOrchestrator }).orchestratorForChannel =
      () =>
        new ConversationOrchestrator({
          plan: () =>
            ({
              version: '2',
              mode: 'read',
              domain: 'cards',
              skillNames: [],
              requestedOperations: [{ name: 'list_cards', kind: 'read' }],
              missingFields: [],
              ambiguity: null,
              confidence: 0.95,
            }) as never,
          evidenceProvider: async () => null,
          events: () => undefined,
        });
    const res = await post(agent, 'mostre meus cartões', 'intent-f1-failclosed');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: string };
    expect(body.output).toBe(
      'Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.',
    );
    const roles = persisted.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });
});
