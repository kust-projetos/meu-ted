import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import { attachRelayUsageStorage } from '../helpers/relay-usage-storage.js';
import {
  normalizeBrokerTurn,
  normalizeRestTurn,
  normalizeSdkTurn,
} from '../../src/orchestration/conversation-orchestrator.js';
import { decodeDelegatedTurnToken } from '../../src/delegated-token.js';
import * as apiClient from '../../src/tools/api-client.js';

// H-14 authority snapshot shape (fail-closed when unreachable): the REST
// turn re-verifies epoch/rollout around inference, so every leg is served.
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

const identity = {
  actorId: 'actor-authenticated',
  workspaceId: 'ws-authenticated',
  role: 'member' as const,
  deviceId: 'device-authenticated',
};

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
      'x-agent-actor': identity.actorId,
      'x-agent-workspace': identity.workspaceId,
    },
    body: JSON.stringify({ text, intentionId }),
  });

describe('AGENT-005 production channel grounding (orchestratorForChannel)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders balance deterministically on every channel without calling the generative provider', async () => {
    const { agent } = createTestAgent();
    const requestSpy = vi.spyOn(apiClient, 'requestPiApiJson').mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/accounts') {
        // Canonical API item shape (camelCase — see generated projection).
        return {
          items: [{ id: 'acc-1', name: 'Conta principal', balanceCents: 12345, status: 'active' }],
        } as unknown as Record<string, unknown>;
      }
      throw new Error(`unexpected production read: ${method} ${path}`);
    });
    const respondSpy = vi.spyOn(agent as unknown as Record<string, (...args: never[]) => unknown>, 'provideUnifiedResponse');
    const orchestrator = (agent as unknown as { orchestratorForChannel: () => { runTurn: (input: never) => Promise<{ response?: { text: string } }> } }).orchestratorForChannel();

    // Default production plan (routeIntent, no override): 'qual meu saldo?'
    // is a read/accounts turn, so the grounded read path must activate.
    const inputs = [
      normalizeRestTurn({ text: 'qual meu saldo?', intentionId: 'intent-prod-rest' }, identity),
      normalizeSdkTurn({ text: 'qual meu saldo?', intentionId: 'intent-prod-sdk' }, identity),
      normalizeBrokerTurn({ text: 'qual meu saldo?', intentionId: 'intent-prod-broker' }, identity),
    ];
    for (const input of inputs) {
      const result = await orchestrator.runTurn(input as never);
      expect(result.response?.text).toContain('Conta principal');
      expect(result.response?.text).toContain('123,45');
    }
    expect(respondSpy).not.toHaveBeenCalled();
    expect(requestSpy).toHaveBeenCalledWith('GET', '/accounts', expect.anything());
    // Reads are scoped by the turn's authenticated workspace: the per-turn
    // `financial.read` delegation travels explicitly per request (never via
    // module-global state), so concurrent turns cannot cross-use tokens.
    const scopedCall = requestSpy.mock.calls.at(-1)?.[2] as { delegatedToken?: string; apiOrigin?: string } | undefined;
    const scopedToken = scopedCall?.delegatedToken;
    expect(typeof scopedToken).toBe('string');
    const claims = await decodeDelegatedTurnToken(scopedToken!, 'read-delegation-test-secret');
    expect(claims.capabilities).toEqual(['financial.read']);
    expect(claims.workspace).toBe(identity.workspaceId);
    expect(claims.sub).toBe(identity.actorId);
    expect(claims.request).toBe('intent-prod-broker');
    requestSpy.mockRestore();
  });

  it('fails closed without calling the generative provider when account rows carry no usable balance', async () => {
    const { agent } = createTestAgent();
    const requestSpy = vi.spyOn(apiClient, 'requestPiApiJson').mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/accounts') {
        // Known data with no deterministic shape (no balance): the read maps
        // to an `error` item, so the envelope is all-error. T3.1 (SPEC §14
        // H-06): the turn fails closed WITHOUT asking the LLM to wing it —
        // zero relay calls, deterministic failure, never an invented number.
        return { items: [{ id: 'acc-1', name: 'Conta principal', status: 'active' }] } as unknown as Record<string, unknown>;
      }
      throw new Error(`unexpected production read: ${method} ${path}`);
    });
    const relayTexts = ['Seu saldo é R$ 999,99 na Conta principal.', 'Seu saldo é R$ 777,77 na Conta principal.'];
    let relayCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), { status: 200 });
      }
      if (url.includes('/internal/agent/llm-relay')) {
        const text = relayTexts[Math.min(relayCalls, relayTexts.length - 1)];
        relayCalls += 1;
        return new Response(JSON.stringify({ text }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const res = await agent.fetch(chatRequest('qual meu saldo?', 'intent-prod-retry'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { output?: string; status?: string };
      expect(body.status).toBe('completed');
      // Fail-closed: no generative call at all (not even ONE correction
      // attempt), deterministic SPEC §14 failure, never an invented number.
      expect(relayCalls).toBe(0);
      expect(body.output).toMatch(/Não consegui acessar seus dados financeiros agora/);
      expect(body.output).not.toMatch(/999,99|777,77/);
    } finally {
      globalThis.fetch = realFetch;
      requestSpy.mockRestore();
    }
  });
});
