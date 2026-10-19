import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    // V2 waits for the completed stream and explicitly observes metadata so
    // provider failures cannot become unhandled rejections.
    streamText: vi.fn(() => ({
      text: Promise.resolve('resposta-mockada'),
      finishReason: Promise.resolve('stop'),
      totalUsage: Promise.resolve({ totalTokens: 1 }),
    })),
  };
});

const { streamText } = await import('ai');
const mockedStreamText = streamText as unknown as ReturnType<typeof vi.fn>;

// Realistic empty DO SQLite (ctx.storage.sql is the only storage surface):
// usage ledgers read zero, intention snapshots miss (remote refetch below),
// every other statement is a permissive no-op. Normal-path wiring tests run
// with storage AVAILABLE so the turn reaches inference.
const makeDurableSql = () => ({
  exec: (<T>(query: string, ..._bindings: unknown[]): Iterable<T> => {
    if (query.includes('SELECT COUNT(*) AS req_count')) {
      return [{ req_count: 0 }] as unknown as Iterable<T>;
    }
    if (query.includes('SELECT COALESCE(SUM')) {
      if (query.includes('WHERE actor_id = ?')) {
        return [{ actor_tokens: 0 }] as unknown as Iterable<T>;
      }
      return [{ total_tokens: 0 }] as unknown as Iterable<T>;
    }
    return [] as unknown as Iterable<T>;
  }),
});

const withDurableSql = (agent: FinanceChatAgent) => {
  Object.defineProperty(agent, 'ctx', {
    value: { storage: { sql: makeDurableSql() } },
    writable: true,
    configurable: true,
  });
  (agent as unknown as { messages: unknown }).messages = [];
  (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
};

const snapshotBody = {
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
  },
  activeProvider: null,
  activeModel: null,
  fallbackProvider: null,
  fallbackModel: null,
  activeDisabled: false,
  fallbackDisabled: false,
};

describe('onChatMessage cognitive wiring (Part A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh Response per call: a body can be consumed only once, and each
    // turn fetches the authority snapshot 2+ times (resolve + H-03/H-14
    // re-verification, fail-closed when unreachable).
    // Route-aware: the runtime snapshot body answers the config/authority
    // reads, while LIST routes answer the shape the API really declares
    // (`{items, total}`). Returning the snapshot body for a list route is an
    // out-of-contract payload, and the evidence layer fails closed on it —
    // which would short-circuit the turn before the provider, hiding exactly
    // what these two tests guard.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const target = String(url);
      const listRead = ['/accounts', '/transactions', '/categories', '/budgets', '/goals', '/payables', '/cards/statements']
        .some((path) => target.includes(path));
      return new Response(JSON.stringify(listRead ? { items: [], total: 0 } : snapshotBody), { status: 200 });
    });
  });

  it('passes tools, stopWhen and the assembled system prompt to streamText', async () => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    (agent as unknown as { env: unknown }).env = {
      API_ORIGIN: 'https://api.example.test',
      AGENT_CONFIG_TOKEN: 'config-token-test',
      OPENCODE_ZEN_API_KEY: 'zen-key-test',
    };
    withDurableSql(agent);
    // A04/R04: every mocked read in this suite answers with the runtime
    // snapshot body, so `list_accounts` proves NO accounts — a typed
    // `setup_incomplete` absence, now answered deterministically WITHOUT the
    // model (AC09). This case therefore asserts the provider wiring on a turn
    // whose read is not a proven absence; the absence wording itself is
    // covered by `tests/responses/read-grounding-wiring.test.ts`.
    const result = (await agent.onChatMessage({
      text: 'Como está minha situação financeira?',
      intentionId: 'intent-wiring-1',
      actorId: 'actor-1',
    })) as { text?: string };

    expect(result).toEqual({ text: 'resposta-mockada' });
    expect(mockedStreamText).toHaveBeenCalledTimes(1);
    const args = mockedStreamText.mock.calls[0]![0] as {
      system: string;
      messages: Array<{ role: string; content: string }>;
      tools: Record<string, unknown>;
      stopWhen: unknown;
    };
    // Persona + golden rule + skills + playbook travel in system.
    expect(args.system).toContain('Meu Ted');
    expect(args.system).toContain('REGRA DE OURO');
    expect(args.system).toContain('saldo-extrato:');
    expect(args.system).toContain('PLAYBOOK FINANCEIRO');
    expect(args.system).toContain('get_balance');
    // Tools are actually exposed to the model (not just mentioned).
    // A balance question curates reads; mutations stay out of a read turn.
    expect(Object.keys(args.tools)).toContain('get_balance');
    expect(Object.keys(args.tools)).toContain('list_recent_transactions');
    expect(Object.keys(args.tools)).not.toContain('create_expense');
    // Compacted context travels as messages (last turn ends the array).
    expect(args.messages[args.messages.length - 1]).toMatchObject({ role: 'user', content: 'Como está minha situação financeira?' });
    expect(args.stopWhen).toBeDefined();
  });

  it('curates mutation tools for a mutation turn', async () => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    (agent as unknown as { env: unknown }).env = {
      API_ORIGIN: 'https://api.example.test',
      AGENT_CONFIG_TOKEN: 'config-token-test',
      OPENCODE_ZEN_API_KEY: 'zen-key-test',
    };
    withDurableSql(agent);
    // Amount-less NON-interrogative mutations ("Lança um gasto no mercado
    // hoje") are answered deterministically by the missing-amount gate on
    // every channel — they never reach the provider. This interrogative
    // turn (asking HOW to register) is not gate-eligible, so it reaches
    // the provider and pins the mutation-tool curation.
    await agent.onChatMessage({
      text: 'Como faço para lançar um gasto no mercado hoje?',
      intentionId: 'intent-wiring-2',
      actorId: 'actor-1',
    });
    expect(mockedStreamText).toHaveBeenCalledTimes(1);
    const args = mockedStreamText.mock.calls[0]![0] as {
      system: string;
      tools: Record<string, unknown>;
    };
    expect(Object.keys(args.tools)).toContain('create_expense');
    expect(args.system).toContain('registros:');
  });

  it('sdk + codex provider: amount-less mutation turn answers deterministically without streamText or broker fetch', async () => {
    const brokerOrigin = 'https://codex-broker.test';
    const codexSnapshotBody = {
      ...snapshotBody,
      runtime: {
        ...snapshotBody.runtime,
        activeProviderId: 'openai-codex-subscription',
        activeModelId: 'openai-codex-subscription:gpt-5-codex',
      },
    };
    // Route-aware override for the Codex snapshot: the runtime snapshot
    // body answers the config/authority reads, LIST routes answer the shape
    // the API really declares, and ANY call to the broker origin is a
    // test failure signal (recorded, then answered so a bypass cannot
    // hide behind a fetch throw).
    vi.mocked(globalThis.fetch).mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.startsWith(brokerOrigin)) {
        return new Response(
          JSON.stringify({
            id: 'broker-should-not-be-called',
            model: 'gpt-5-codex',
            choices: [{ message: { role: 'assistant', content: 'broker-text' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 },
        );
      }
      const listRead = ['/accounts', '/transactions', '/categories', '/budgets', '/goals', '/payables', '/cards/statements']
        .some((path) => target.includes(path));
      return new Response(JSON.stringify(listRead ? { items: [], total: 0 } : codexSnapshotBody), { status: 200 });
    });
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    (agent as unknown as { env: unknown }).env = {
      API_ORIGIN: 'https://api.example.test',
      AGENT_CONFIG_TOKEN: 'config-token-test',
      CODEX_BROKER_ORIGIN: brokerOrigin,
      CODEX_BROKER_REQUEST_SIGNING_KEY: 'signing-key-test',
    };
    withDurableSql(agent);
    const result = (await agent.onChatMessage({
      text: 'comprei uma bicicleta parcela em 10 x',
      intentionId: 'intent-wiring-codex-gate',
      actorId: 'actor-1',
    })) as { text?: string };

    expect(result).toEqual({ text: 'Não identifiquei o valor a registrar. Informe o valor e a descrição.' });
    expect(mockedStreamText).not.toHaveBeenCalled();
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).startsWith(brokerOrigin)),
    ).toBe(false);
  });
});
