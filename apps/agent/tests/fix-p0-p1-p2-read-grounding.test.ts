import { describe, expect, it, vi, afterEach } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { validateGroundedClaims } from '../src/evidence/grounding-validator.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import type { EvidenceEnvelope } from '../src/evidence/evidence-envelope.js';
import { adaptProviderOutput } from '../src/orchestration/provider-adapter.js';
import { DEFAULT_POLICY } from '../src/safety/usage-policy.js';
import { sanitizeForPersistence } from '../src/privacy/history.js';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { attachRelayUsageStorage } from './helpers/relay-usage-storage.js';
import * as apiClient from '../src/tools/api-client.js';

/**
 * Fix batch (HEAD 47b5974) — RED-first coverage for:
 * P0 attachment bypass, P1 name grounding + stable read ids,
 * P2 token caps + DLP single funnel.
 */

const isoNow = () => new Date().toISOString();

/** Tool envelope with NO usable rows (ok status, empty data). */
const EMPTY_TOOLS: EvidenceEnvelope = {
  version: '1',
  items: [{
    ref: 'statement',
    source: 'api.transactions',
    retrievedAt: isoNow(),
    status: 'ok',
    data: [],
  }],
};

const moneyEnvelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'api.balance', retrievedAt: isoNow(), status: 'ok', data }],
});

const identity: AuthenticatedIdentity = {
  actorId: 'actor-fix',
  workspaceId: 'workspace-fix',
  role: 'member',
  deviceId: 'device-fix',
};

const transactionsReadPlan = () => ({
  version: '2' as const,
  mode: 'read' as const,
  domain: 'transactions' as const,
  skillNames: ['saldo-extrato'],
  requestedOperations: [{ name: 'get_balance', kind: 'read' as const }],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

describe('P0 — attachment bypass: tool-empty envelope never publishes a block figure', () => {
  it('validator: attributed document money with NO tool money fails closed', () => {
    const result = validateGroundedClaims(
      'O documento informa R$ 999,00.',
      EMPTY_TOOLS,
      ['fatura do cartao total R$ 999,00 vencimento 2026-03-12'],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBeGreaterThanOrEqual(1);
  });

  it('validator: the same attributed citation still grounds when tool money exists', () => {
    const result = validateGroundedClaims(
      'O documento informa R$ 999,00.',
      moneyEnvelope({ balanceCents: 100, accountName: 'Conta' }),
      ['fatura do cartao total R$ 999,00 vencimento 2026-03-12'],
    );
    expect(result.valid).toBe(true);
  });

  it('orchestrator: attachment turn with tool-empty envelope stays deterministic (provider untouched)', async () => {
    const responseProvider = vi.fn(async () => 'O documento informa R$ 999,00.');
    const orchestrator = new ConversationOrchestrator({
      plan: transactionsReadPlan,
      evidenceProvider: async () => EMPTY_TOOLS,
      responseProvider,
      events: () => undefined,
    });
    const base = normalizeRestTurn(
      { text: 'quanto deu a fatura no pdf?', intentionId: 'intent-p0-empty-tools' },
      identity,
    );
    const result = await orchestrator.runTurn({ ...base, hasAttachmentData: true });
    expect(responseProvider).not.toHaveBeenCalled();
    expect(result.response?.text).toBe('Não há dados disponíveis para extrato.');
    expect(result.response?.text).not.toMatch(/999/);
  });
});

describe('P1 — name grounding requires a multi-token/entity match', () => {
  it('head-only first token never validates a multi-token claim', () => {
    // Evidence holds only "nubank"; the claim names the "Nubank Premium"
    // entity (quoted so the extractor yields exactly that entity).
    const result = validateGroundedClaims(
      'O "Nubank Premium" está ativo.',
      moneyEnvelope({ accountName: 'nubank' }),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
  });

  it('a denial citing an existing name never validates as grounded', () => {
    const result = validateGroundedClaims(
      'Não encontrei a conta Nubank.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
  });

  it('an exact entity match still grounds (no over-blocking)', () => {
    expect(validateGroundedClaims(
      'O "Nubank Premium" está ativo.',
      moneyEnvelope({ accountName: 'Nubank Premium' }),
      [],
    ).valid).toBe(true);
    expect(validateGroundedClaims(
      'A conta "Nubank" está ativa.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    ).valid).toBe(true);
  });
});

describe('P1 — read branches persist stable intention-derived ids', () => {
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
    Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
    attachRelayUsageStorage(agent);
    Object.defineProperty(agent, 'env', {
      value: {
        API_ORIGIN: 'https://api.test.local',
        AGENT_CONFIG_TOKEN: 'config-test-token',
        AGENT_RUNTIME_ADMIN_TOKEN: 'admin-test-token',
        AGENT_DELEGATION_SECRET: 'read-delegation-test-secret',
      },
      writable: true,
      configurable: true,
    });
    return { agent, persisted };
  };

  const chatRequest = (text: string, intentionId: string) =>
    new Request('https://agent.test.local/rpc/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-actor': 'actor-stable',
        'x-agent-workspace': 'ws-stable',
      },
      body: JSON.stringify({ text, intentionId }),
    });

  it('redelivery with the same intentionId persists zero new rows', async () => {
    const { agent, persisted } = createTestAgent();
    const requestSpy = vi.spyOn(apiClient, 'requestPiApiJson').mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/accounts') {
        return { items: [{ id: 'acc-1', name: 'Conta principal', status: 'active' }] } as unknown as Record<string, unknown>;
      }
      throw new Error(`unexpected production read: ${method} ${path}`);
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify({
          runtime: {
            singleton: 'active', version: 3, securityEpoch: 1,
            activeProviderId: 'opencode-zen', activeModelId: 'opencode-zen:zen-1',
            activeProtocol: 'chat-completions', activeRolloutPercentage: 100,
            activeRolloutMode: 'all', fallbackProviderId: null, fallbackModelId: null,
            updatedBy: null,
          },
          activeProvider: null, activeModel: null, fallbackProvider: null,
          fallbackModel: null, activeDisabled: false, fallbackDisabled: false,
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const intentionId = 'intent-stable-read-redelivery';
      const first = await agent.fetch(chatRequest('qual meu saldo?', intentionId));
      expect(first.status).toBe(200);
      const idsAfterFirst = persisted.map((m) => String((m as { id?: unknown }).id ?? ''));
      expect(idsAfterFirst).toContain(`msg-user-${intentionId}`);
      expect(idsAfterFirst).toContain(`msg-asst-${intentionId}`);
      const countAfterFirst = persisted.length;

      const second = await agent.fetch(chatRequest('qual meu saldo?', intentionId));
      expect(second.status).toBe(200);
      expect(persisted.length).toBe(countAfterFirst);
      expect(persisted.filter((m) => String((m as { id?: unknown }).id ?? '') === `msg-user-${intentionId}`)).toHaveLength(1);
      expect(persisted.filter((m) => String((m as { id?: unknown }).id ?? '') === `msg-asst-${intentionId}`)).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      requestSpy.mockRestore();
    }
  });
});

describe('P2 — token caps aligned to the single reservation slice', () => {
  const plan = {
    version: '2' as const, mode: 'read' as const, domain: 'accounts' as const,
    skillNames: ['financial-analysis'],
    requestedOperations: [{ name: 'get_balance', kind: 'read' as const }],
    missingFields: [], ambiguity: null, confidence: 1,
  };

  it('the provider text cap matches the single reservation slice (output slice)', () => {
    // One leg reserves maxOutputTokens for the reply; estimateTokens charges
    // ~1 token per 4 chars, so a reply beyond maxOutputTokens * 4 chars was
    // never reserved and fails validation. Total budgets are untouched.
    expect(DEFAULT_POLICY.maxOutputTokens * 4).toBe(8_000);
    expect(DEFAULT_POLICY.maxInputTokens).toBe(2_000);
    expect(DEFAULT_POLICY.dailyBudget).toBe(400_000);
    expect(DEFAULT_POLICY.actorDailyBudget).toBe(200_000);
  });

  it('provider text validation matches the single output slice (maxOutputTokens * 4 chars)', () => {
    const ok = 'y'.repeat(7_900);
    expect(adaptProviderOutput({ text: JSON.stringify({ plan, response: { text: ok } }) }).response.text).toBe(ok);
    const over = 'y'.repeat(9_000);
    expect(() => adaptProviderOutput({ text: JSON.stringify({ plan, response: { text: over } }) })).toThrow(
      'agent.invalid_provider_output',
    );
  });
});

describe('P2 — DLP single funnel (history delegates to dlp)', () => {
  it('history sanitization redacts PAN via the central funnel', () => {
    expect(sanitizeForPersistence('meu cartao 4111111111111111 vence em 2030')).not.toContain('4111');
    expect(sanitizeForPersistence('meu cartao 4111111111111111 vence em 2030')).toContain('[REDACTED]');
  });

  it('history sanitization keeps redacting credential patterns', () => {
    expect(sanitizeForPersistence('password="s3cr3t-value"')).not.toContain('s3cr3t-value');
  });
});
