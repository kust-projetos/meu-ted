import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import {
  normalizeSdkTurn,
  type TurnPlan,
} from '../../src/orchestration/conversation-orchestrator.js';
import * as apiClient from '../../src/tools/api-client.js';

/**
 * REVIEW-P1: a pergunta generativa sobre o conteúdo do anexo chamava o
 * provider comum — no caminho SDK isso constrói tools (leituras+recall) e
 * roda `streamText` com `stopWhen: stepCountIs(5)`: a consulta podia
 * executar tools antes do grounding. O caminho de inferência para consultas
 * ao conteúdo é explicitamente SEM tools (uma única inferência, zero tools).
 */
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn(() => ({
      text: Promise.resolve('stream-text-mock-nunca-usado-aqui'),
      finishReason: Promise.resolve('stop'),
      totalUsage: Promise.resolve({ totalTokens: 1 }),
    })),
    generateText: vi.fn(async () => ({ text: 'O áudio informa o conteúdo transcrito acima.' })),
  };
});

const { streamText, generateText } = await import('ai');
const mockedStreamText = streamText as unknown as ReturnType<typeof vi.fn>;
const mockedGenerateText = generateText as unknown as ReturnType<typeof vi.fn>;

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

const identity = {
  actorId: 'actor-toolfree',
  workspaceId: 'workspace-toolfree',
  role: 'member' as const,
  deviceId: null as string | null,
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

const NOTICE = '[transcrição do anexo de áudio (STT): conteúdo do usuário, possivelmente com erros de reconhecimento]';
const TRANSCRIPT = 'o total da compra deu quarenta e dois reais e cinquenta centavos valor 42,50 R$ pago no cartao';

const createTestAgent = () => {
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
  (agent as unknown as { env: unknown }).env = {
    API_ORIGIN: 'https://api.example.test',
    AGENT_CONFIG_TOKEN: 'config-token-test',
    OPENCODE_ZEN_API_KEY: 'zen-key-test',
  };
  Object.defineProperty(agent, 'ctx', {
    value: { storage: { sql: makeDurableSql() } },
    writable: true,
    configurable: true,
  });
  (agent as unknown as { messages: unknown }).messages = [];
  (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
  return agent;
};

const contentSdkInput = (typedText: string, intentionId: string) => {
  const composed = `${NOTICE}\n${typedText}\n${TRANSCRIPT}`;
  return normalizeSdkTurn({ text: composed, intentionId }, identity, {
    typedText,
    hasAttachmentData: true,
    attachmentTexts: [TRANSCRIPT],
  });
};

const contentPlan = {
  version: '2',
  mode: 'read',
  domain: 'general',
  skillNames: [],
  requestedOperations: [],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
} as const satisfies TurnPlan;

describe('attachment-content-query REVIEW-P1: inferência sem tools', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('provideContentQueryResponse faz UMA inferência sem tools (streamText nunca)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const target = String(url);
      const listRead = ['/accounts', '/transactions', '/categories', '/budgets', '/goals', '/payables', '/cards/statements']
        .some((path) => target.includes(path));
      return new Response(JSON.stringify(listRead ? { items: [], total: 0 } : snapshotBody), { status: 200 });
    });
    const agent = createTestAgent();
    const text = await (agent as unknown as {
      provideContentQueryResponse: (input: ReturnType<typeof contentSdkInput>, plan: TurnPlan) => Promise<string>;
    }).provideContentQueryResponse(contentSdkInput('o que diz o áudio?', 'intent-toolfree-direct'), contentPlan);

    expect(text).toContain('O áudio informa');
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    const args = mockedGenerateText.mock.calls[0]![0] as Record<string, unknown>;
    expect('tools' in args).toBe(false);
    expect(mockedStreamText).not.toHaveBeenCalled();
  });

  it('turno integrado via orchestratorForChannel não executa tool nem leitura financeira', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const target = String(url);
      const listRead = ['/accounts', '/transactions', '/categories', '/budgets', '/goals', '/payables', '/cards/statements']
        .some((path) => target.includes(path));
      return new Response(JSON.stringify(listRead ? { items: [], total: 0 } : snapshotBody), { status: 200 });
    });
    const agent = createTestAgent();
    const productionReads = vi.spyOn(apiClient, 'requestPiApiJson');
    const orchestrator = (agent as unknown as {
      orchestratorForChannel: () => { runTurn: (input: never) => Promise<{ response?: { text: string } }> };
    }).orchestratorForChannel();

    const result = await orchestrator.runTurn(
      contentSdkInput('o que diz o áudio?', 'intent-toolfree-wired') as never,
    );

    expect(result.response?.text).toContain('O áudio informa');
    // Zero tools: o caminho com tools (streamText) nunca roda; a única
    // inferência é tool-free (generateText sem `tools`).
    expect(mockedStreamText).not.toHaveBeenCalled();
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    expect('tools' in (mockedGenerateText.mock.calls[0]![0] as Record<string, unknown>)).toBe(false);
    // Zero leituras financeiras: o envelope é vazio e o grounding valida só
    // contra o bloco admitido do anexo.
    expect(productionReads).not.toHaveBeenCalled();
  });
});
