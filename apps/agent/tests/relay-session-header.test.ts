import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { attachRelayUsageStorage } from './helpers/relay-usage-storage.js';

const snapshotBody = (overrides: Record<string, unknown> = {}) => ({
  runtime: {
    singleton: 'active',
    version: 3,
    securityEpoch: 2,
    activeProviderId: 'opencode-go',
    activeModelId: 'opencode-go:muse-spark-1.3-contributor',
    activeProtocol: 'responses',
    activeRolloutPercentage: 100,
    activeRolloutMode: 'all',
    fallbackProviderId: null,
    fallbackModelId: null,
    updatedBy: null,
    ...overrides,
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
  agent.messages = [];
  agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
    persisted.push(...msgs);
  });
  Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
  // Usage-attempt ledger: the relay leg reserves per dispatch (fail-closed
  // 503 without atomic storage), so the harness provides it like production.
  attachRelayUsageStorage(agent);
  Object.defineProperty(agent, 'env', {
    value: { API_ORIGIN: 'https://api.example.test', AGENT_CONFIG_TOKEN: 'config-test-token' },
    writable: true,
    configurable: true,
  });
  return { agent, persisted };
};

const relayInits: RequestInit[] = [];

const stubWorkerEgress = () => {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/internal/agent/llm-config')) {
      return new Response(JSON.stringify(snapshotBody()), { status: 200 });
    }
    if (u.includes('/internal/agent/llm-relay')) {
      relayInits.push(init ?? {});
      return new Response(JSON.stringify({ text: 'ok', providerAttempted: true }), { status: 200 });
    }
    // T3.1 (SPEC §14): usable evidence so the turn reaches the relay.
    if (u.includes('/budgets')) {
      return new Response(JSON.stringify({ budgets: [{ id: 'b1', name: 'Alimentação', limitCents: 100000 }] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
};

describe('FIX-AGENT-RELAY-EDGE-REDIRECT: relay leg is executable at the Workers edge', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
    relayInits.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('uses redirect "manual" (Workers fetch throws TypeError on redirect "error")', async () => {
    const { agent } = createTestAgent();
    stubWorkerEgress();
    const res = await agent.fetch(chatRequest('como está meu orçamento?', 'intent-r1'));
    expect(res.status).toBe(200);
    expect(relayInits.length).toBeGreaterThanOrEqual(1);
    expect(relayInits[0]!['redirect']).toBe('manual');
    expect(relayInits[0]!['redirect']).not.toBe('error');
  });
});

const chatRequest = (text: string, intentionId: string) =>
  new Request('https://agent.test.local/rpc/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-actor': 'user-1',
      'x-agent-workspace': 'ws-1',
    },
    body: JSON.stringify({ text, intentionId }),
  });

describe('FIX-AGENT-RELAY-SESSION-ID: relay body carries a stable x-opencode-session id', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('two turns in the same workspace send the SAME sessionId (upstream prompt-cache affinity)', async () => {
    const { agent } = createTestAgent();
    const relayBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), { status: 200 });
      }
      if (u.includes('/internal/agent/llm-relay')) {
        relayBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ text: 'ok', providerAttempted: true }), { status: 200 });
      }
      // T3.1 (SPEC §14): usable evidence so the turn reaches the relay.
      if (u.includes('/budgets')) {
        return new Response(JSON.stringify({ budgets: [{ id: 'b1', name: 'Alimentação', limitCents: 100000 }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res1 = await agent.fetch(chatRequest('como está meu orçamento?', 'intent-s1'));
    expect(res1.status).toBe(200);
    const res2 = await agent.fetch(chatRequest('e agora?', 'intent-s2'));
    expect(res2.status).toBe(200);

    expect(relayBodies).toHaveLength(2);
    expect(relayBodies[0]!['sessionId']).toBe('ted-ws-1');
    expect(relayBodies[1]!['sessionId']).toBe('ted-ws-1');
    expect(String(relayBodies[0]!['sessionId'])).toMatch(/^ted-[A-Za-z0-9._:-]+$/);
  });

  it('different workspaces produce different sessionIds (no cross-workspace affinity)', async () => {
    const { agent } = createTestAgent();
    const relayBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), { status: 200 });
      }
      if (u.includes('/internal/agent/llm-relay')) {
        relayBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ text: 'ok', providerAttempted: true }), { status: 200 });
      }
      if (u.includes('/budgets')) {
        return new Response(JSON.stringify({ budgets: [{ id: 'b1', name: 'Alimentação', limitCents: 100000 }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const reqA = new Request('https://agent.test.local/rpc/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-actor': 'u1', 'x-agent-workspace': 'ws-A' },
      body: JSON.stringify({ text: 'oi', intentionId: 'i-a' }),
    });
    const reqB = new Request('https://agent.test.local/rpc/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-actor': 'u2', 'x-agent-workspace': 'ws-B' },
      body: JSON.stringify({ text: 'oi', intentionId: 'i-b' }),
    });
    await agent.fetch(reqA);
    await agent.fetch(reqB);

    expect(relayBodies[0]!['sessionId']).toBe('ted-ws-A');
    expect(relayBodies[1]!['sessionId']).toBe('ted-ws-B');
  });
});
