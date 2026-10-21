/**
 * deactivate-reader-wiring — o fluxo de desativação precisa do entityReader
 * no caminho REST, mesmo sob plano `read`.
 *
 * Evidência live: "desative a conta nubank" planeja `accounts/read` (sem
 * mutação) e o orquestrador cai em `runDeactivateTurn` →
 * `readDeactivationAccounts` → `entityReaderOrClosed` → stub
 * (`agent.entity_reader_missing`) → read null → `DEACTIVATE_READ_FAILURE_TEXT`.
 * Causa: `finance-chat-agent.ts` injeta o reader SOMENTE se `needsMutation`.
 * Testes de desativação escondiam o gap (injetam o reader manualmente).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import type { ConversationOrchestrator } from '../../src/orchestration/conversation-orchestrator.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';
import * as apiClient from '../../src/tools/api-client.js';
import { attachRelayUsageStorage } from '../helpers/relay-usage-storage.js';

const SECRET = 'deactivate-reader-wiring-secret';

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
      AGENT_DELEGATION_SECRET: SECRET,
      AGENT_RUNTIME_ADMIN_TOKEN: 'admin-test-token',
      AGENT_CONFIG_TOKEN: 'config-test-token',
    },
    writable: true,
    configurable: true,
  });
  (agent as unknown as { resolveIntentionSnapshot: () => Promise<unknown> }).resolveIntentionSnapshot = async () => ({
    intention_id: 'intent-test-1',
    version: 1,
    provider_id: 'opencode-zen',
    model_id: 'opencode-zen:zen-free-model',
    protocol: 'chat-completions',
    rollout_percentage: 100,
    security_epoch: 1,
    fallback_provider_id: null,
    fallback_model_id: null,
    model_name: 'zen-free-model',
    fallback_model_name: null,
    created_at: new Date().toISOString(),
  });
  return agent;
};

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

/** Captura o dependency bag do `orchestratorForChannel` delegando ao real. */
const captureWiring = (agent: FinanceChatAgent): { deps: () => Record<string, unknown> } => {
  const seen: Array<Record<string, unknown>> = [];
  const target = agent as unknown as {
    orchestratorForChannel: (deps?: Record<string, unknown>) => ConversationOrchestrator;
  };
  const original = target.orchestratorForChannel.bind(agent);
  target.orchestratorForChannel = (deps: Record<string, unknown> = {}) => {
    seen.push(deps);
    return original(deps);
  };
  return { deps: () => seen[0] ?? {} };
};

const postChat = (agent: FinanceChatAgent, text: string, intentionId: string, workspace = 'ws-deact-wiring', deviceId?: string) =>
  agent.fetch(
    new Request('https://agent.test.local/rpc/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-actor': 'actor-deact-wiring',
        'x-agent-workspace': workspace,
        ...(deviceId ? { 'x-agent-device': deviceId } : {}),
      },
      body: JSON.stringify({ text, intentionId }),
    }),
  );

describe('deactivate-reader-wiring (REST)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turno "desative a conta nubank" (plano read) chega ao orquestrador COM entityReader escopado', async () => {
    const agent = createTestAgent();
    const wiring = captureWiring(agent);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      if (String(info).includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ text: 'Resposta simples sem números.', providerAttempted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await postChat(agent, 'desative a conta nubank', 'intent-deact-wiring-1');
    expect(res.status).toBe(200);

    const reader = wiring.deps().entityReader as EntityReader | undefined;
    expect(reader).toBeDefined();
    expect(typeof reader!.listAccounts).toBe('function');
    // Escopo/visibilidade preservados: o mesmo builder escopado no workspace.
    expect(reader!.scope?.workspaceId).toBe('ws-deact-wiring');
  });

  it('sinal por anáfora ("delete ela") também recebe o reader', async () => {
    const agent = createTestAgent();
    const wiring = captureWiring(agent);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      if (String(info).includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ text: 'Resposta simples sem números.', providerAttempted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await postChat(agent, 'delete ela', 'intent-deact-wiring-2');
    expect(res.status).toBe(200);
    expect(wiring.deps().entityReader).toBeDefined();
  });

  it('leitura sem sinal de desativação e sem mutação segue SEM reader (byte-idêntico)', async () => {    const agent = createTestAgent();
    const wiring = captureWiring(agent);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      if (String(info).includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ text: 'Resposta simples sem números.', providerAttempted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await postChat(agent, 'qual meu saldo?', 'intent-deact-wiring-3');
    expect(res.status).toBe(200);
    expect(wiring.deps().entityReader).toBeUndefined();
  });

  it('turno "desative a conta nubank" com device chega COM mutationApiClient (transporte de proposta)', async () => {
    const agent = createTestAgent();
    const wiring = captureWiring(agent);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      if (String(info).includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ text: 'Resposta simples sem números.', providerAttempted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await postChat(agent, 'desative a conta nubank', 'intent-deact-wiring-4', 'ws-deact-wiring', 'dev-deact-wiring');
    expect(res.status).toBe(200);
    expect(wiring.deps().mutationApiClient).toBeDefined();
  });

  it('leitura com device mas sem sinal segue SEM mutationApiClient (byte-idêntico)', async () => {
    const agent = createTestAgent();
    const wiring = captureWiring(agent);
    vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (info) => {
      if (String(info).includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ text: 'Resposta simples sem números.', providerAttempted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await postChat(agent, 'qual meu saldo?', 'intent-deact-wiring-5', 'ws-deact-wiring', 'dev-deact-wiring');
    expect(res.status).toBe(200);
    expect(wiring.deps().mutationApiClient).toBeUndefined();
  });
});
