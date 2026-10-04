import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { attachRelayUsageStorage } from './helpers/relay-usage-storage.js';

const snapshotBody = (overrides: Record<string, unknown> = {}) => ({
  runtime: {
    singleton: 'active',
    version: 3,
    securityEpoch: 2,
    activeProviderId: 'opencode-zen',
    activeModelId: 'opencode-zen:zen-1',
    activeProtocol: 'chat-completions',
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

const chatRequest = (text: string) =>
  new Request('https://agent.test.local/rpc/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-actor': 'user-1',
      'x-agent-workspace': 'ws-1',
    },
    body: JSON.stringify({ text, intentionId: 'intent-h14' }),
  });

describe('H-14: revogação fail-closed + epoch comparado durante a resposta', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('epoch bump durante inferência lenta → 409 e output NÃO publicado/persistido', async () => {
    const { agent, persisted } = createTestAgent();
    let epoch = 2;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody({ securityEpoch: epoch })), { status: 200 });
      }
      if (u.includes('/internal/agent/llm-relay')) {
        epoch = 3; // revogação acontece enquanto a inferência roda
        return new Response(JSON.stringify({ text: 'resposta revogada', providerAttempted: true }), { status: 200 });
      }
      // T3.1 (SPEC §14): finance reads require evidence before inference —
      // serve usable-but-not-deterministically-renderable budget evidence so
      // this turn reaches the relay and the epoch check still applies.
      if (u.includes('/budgets')) {
        return new Response(JSON.stringify({ items: [{ id: 'b1', name: 'Alimentação', limitCents: 100000 }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await agent.fetch(chatRequest('como está meu orçamento?'));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('agent.security_epoch_changed');
    // A mensagem do usuário (pré-inferência, autorizada) persiste; a do
    // assistente (pós-revogação) NUNCA é publicada nem persistida.
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('autoridade indisponível ANTES do turno → fail-closed determinístico, relay nunca chamado', async () => {
    const { agent, persisted } = createTestAgent();
    const relayCalls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/internal/agent/llm-relay')) {
        relayCalls.push(u);
        return new Response(JSON.stringify({ text: 'x' }), { status: 200 });
      }
      throw new Error('api down');
    }) as unknown as typeof fetch;

    const res = await agent.fetch(chatRequest('qual meu saldo?'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: string; status?: string };
    expect(body.status).toBe('completed');
    // T3.1 (SPEC §14): unreadable evidence fails closed with the
    // deterministic failure — the LLM is never consulted for a financial
    // claim. Relay never called; history serves the deterministic failure
    // (user Q + fail-closed A), never invented data.
    expect(relayCalls).toHaveLength(0);
    expect(body.output).toMatch(/Não consegui acessar seus dados financeiros agora/);
    const assistants = persisted.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(JSON.stringify(assistants[0])).toContain('Não consegui acessar seus dados financeiros agora');
  });

  it('autoridade cai DURANTE o turno → 503 e output não publicado', async () => {
    const { agent, persisted } = createTestAgent();
    let authorityUp = true;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/internal/agent/llm-config')) {
        if (!authorityUp) throw new Error('api down');
        return new Response(JSON.stringify(snapshotBody()), { status: 200 });
      }
      if (u.includes('/internal/agent/llm-relay')) {
        authorityUp = false; // cai logo após a inferência
        return new Response(JSON.stringify({ text: 'resposta sem autoridade', providerAttempted: true }), { status: 200 });
      }
      // T3.1: evidence must be usable so the turn reaches inference (see
      // test 1); the authority failure under test happens after the relay.
      if (u.includes('/budgets')) {
        return new Response(JSON.stringify({ items: [{ id: 'b1', name: 'Alimentação', limitCents: 100000 }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await agent.fetch(chatRequest('como está meu orçamento?'));
    expect(res.status).toBe(503);
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('provider disabled no meio do turno → 503 e output não publicado', async () => {
    const { agent, persisted } = createTestAgent();
    let mode: string = 'all';
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody({ activeRolloutMode: mode })), { status: 200 });
      }
      if (u.includes('/internal/agent/llm-relay')) {
        mode = 'disabled';
        return new Response(JSON.stringify({ text: 'resposta desabilitada', providerAttempted: true }), { status: 200 });
      }
      // T3.1: evidence must be usable so the turn reaches inference (see
      // test 1); the disable under test happens after the relay.
      if (u.includes('/budgets')) {
        return new Response(JSON.stringify({ items: [{ id: 'b1', name: 'Alimentação', limitCents: 100000 }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await agent.fetch(chatRequest('como está meu orçamento?'));
    expect(res.status).toBe(503);
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('stream do relay falha após o primeiro chunk → 502 sem publicar parcial', async () => {
    const { agent, persisted } = createTestAgent();
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody()), { status: 200 });
      }
      if (u.includes('/internal/agent/llm-relay')) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"text":"parc'));
            controller.error(new Error('upstream reset'));
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // T3.1: evidence must be usable so the turn reaches inference (see
      // test 1); the relay failure under test happens after the read.
      if (u.includes('/budgets')) {
        return new Response(JSON.stringify({ items: [{ id: 'b1', name: 'Alimentação', limitCents: 100000 }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await agent.fetch(chatRequest('como está meu orçamento?'));
    expect(res.status).toBe(502);
    expect(persisted.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});
