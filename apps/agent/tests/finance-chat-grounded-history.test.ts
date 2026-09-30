import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { attachRelayUsageStorage } from './helpers/relay-usage-storage.js';
import * as apiClient from '../src/tools/api-client.js';

const snapshotBody = () => ({
  runtime: {
    singleton: 'active',
    version: 3,
    securityEpoch: 1,
    activeProviderId: 'opencode-zen',
    activeModelId: 'opencode-zen:zen-1',
    activeProtocol: 'chat-completions',
    activeRolloutPercentage: 100,
    activeRolloutMode: 'all',
    fallbackProviderId: null,
    fallbackModelId: null,
    updatedBy: null,
  },
  activeProvider: null,
  activeModel: null,
  fallbackProvider: null,
  fallbackModel: null,
  activeDisabled: false,
  fallbackDisabled: false,
});

const createTestAgent = () => {
  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: UIMessage[];
    persistMessages: (msgs: UIMessage[]) => Promise<void>;
  };
  // History reads from `messages`; keep both views on the same array so the
  // test observes exactly what /rpc/history would serve.
  agent.messages = persisted;
  agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
    persisted.push(...msgs);
  });
  Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
  // Usage-attempt ledger: the relay leg reserves per dispatch (fail-closed
  // 503 without atomic storage), so the harness provides it like production.
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
      'x-agent-actor': 'actor-history',
      'x-agent-workspace': 'ws-history',
    },
    body: JSON.stringify({ text, intentionId }),
  });

const historyRequest = () =>
  new Request('https://agent.test.local/rpc/history', {
    method: 'GET',
    headers: {
      'x-agent-actor': 'actor-history',
      'x-agent-workspace': 'ws-history',
    },
  });

describe('FINDING 2 (HIGH): persisted history serves the grounded response, never raw rejected text', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grounding rejection → history returns the safe fallback, never the raw relay text', async () => {
    const { agent } = createTestAgent();
    const requestSpy = vi.spyOn(apiClient, 'requestPiApiJson').mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/accounts') {
        // Known data with no deterministic shape (no balance): the read maps
        // to an `error` item, so the envelope is all-error and T3.1 (SPEC
        // §14) fails closed WITHOUT invoking the relay — history serves the
        // deterministic failure, never the raw relay text.
        return { items: [{ id: 'acc-1', name: 'Conta principal', status: 'active' }] } as unknown as Record<string, unknown>;
      }
      throw new Error(`unexpected production read: ${method} ${path}`);
    });
    const RAW_UNSUPPORTED = 'Seu saldo é R$ 999,99 na Conta principal.';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), { status: 200 });
      }
      if (url.includes('/internal/agent/llm-relay')) {
        return new Response(JSON.stringify({ text: RAW_UNSUPPORTED }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const res = await agent.fetch(chatRequest('qual meu saldo?', 'intent-grounded-history'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { output?: string; status?: string };
      expect(body.status).toBe('completed');
      // Fail-closed: the deterministic SPEC §14 failure is served and persisted.
      expect(body.output).toMatch(/Não consegui acessar seus dados financeiros agora/);
      expect(body.output).not.toContain('999,99');

      const historyRes = await agent.fetch(historyRequest());
      expect(historyRes.status).toBe(200);
      const history = (await historyRes.json()) as { items?: Array<{ role?: string; text?: string; content?: string }> };
      const assistantTexts = (history.items ?? [])
        .filter((item) => item.role === 'assistant')
        .map((item) => item.text ?? item.content ?? '');
      expect(assistantTexts.length).toBeGreaterThan(0);
      // The persisted assistant message is the final grounded response…
      expect(assistantTexts[assistantTexts.length - 1]).toBe(body.output);
      // …and the raw rejected provider text never reached durable history.
      expect(JSON.stringify(history)).not.toContain('999,99');
    } finally {
      globalThis.fetch = realFetch;
      requestSpy.mockRestore();
    }
  });
});
