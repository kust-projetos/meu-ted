import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { DatabaseSync } from 'node:sqlite';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import {
  buildDraftRecord,
  initializeMutationDraftSchema,
  SqlMutationDraftStore,
} from '../src/mutations/mutation-draft.js';
import { initializeUsageSchema, initializeUsageAttemptSchema } from '../src/safety/usage-policy.js';

const WORKSPACE = 'workspace-cancel-draft-rest';
const ACTOR = 'actor-cancel-draft-rest';
const DEVICE = 'device-cancel-draft-rest';
const CONFIG_TOKEN = 'test-only-config-token';

const makeHarness = (draftStates: Array<{ actor: string; conversation: string; status: 'active' | 'expired'; intention: string }>) => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...bindings as never[]) as T[];
      }
      statement.run(...bindings as never[]);
      return [] as T[];
    },
    transactionSync<T>(fn: () => T): T { return fn(); },
  };
  initializeUsageSchema(sql as never);
  initializeUsageAttemptSchema(sql as never);
  initializeMutationDraftSchema(sql as never);

  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: UIMessage[];
    persistMessages: (messages: UIMessage[]) => Promise<void>;
  };
  agent.messages = persisted;
  agent.persistMessages = vi.fn(async (messages: UIMessage[]) => { persisted.push(...messages); });
  Object.defineProperty(agent, 'ctx', { value: { storage: { sql, transactionSync: sql.transactionSync } }, configurable: true });
  Object.defineProperty(agent, 'state', { value: { storage: {} }, configurable: true });
  Object.defineProperty(agent, 'env', { value: {
    API_ORIGIN: 'https://api.test.local',
    AGENT_DELEGATION_SECRET: 'test-only-delegation-secret',
    AGENT_CONFIG_TOKEN: CONFIG_TOKEN,
  }, configurable: true });
  Object.defineProperty(agent, 'resolveIntentionSnapshot', { value: async () => ({
    intention_id: 'test-cancel-draft', version: 1, provider_id: 'opencode-zen', model_id: 'opencode-zen:test-model',
    protocol: 'chat-completions', rollout_percentage: 100, security_epoch: 1,
    fallback_provider_id: null, fallback_model_id: null, model_name: 'test-model', fallback_model_name: null,
    created_at: new Date().toISOString(),
  }), configurable: true });
  Object.defineProperty(agent, 'readOpenSessionOrThrow', { value: () => null, configurable: true });

  const now = Date.now();
  const store = new SqlMutationDraftStore(sql as never);
  for (const [index, item] of draftStates.entries()) {
    const draft = buildDraftRecord({
      workspaceId: WORKSPACE,
      actorId: item.actor,
      deviceId: DEVICE,
      conversationId: item.conversation,
      intentionId: item.intention,
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 1234, description: `test draft ${index}`, date: new Date(now).toISOString().slice(0, 10) },
      missingFields: ['accountId'],
      question: 'Qual conta devo usar?',
      nowMs: item.status === 'expired' ? now - 16 * 60_000 : now,
    });
    store.getOrCreate(draft);
  }

  const requests: Request[] = [];
  const unrelatedPending = { id: 'pending-card-unrelated', status: 'proposed', tool: 'cards.create' };
  let cancelWrites = 0;
  const relay = vi.fn(async () => { throw new Error('relay must not be called for explicit draft cancellation'); });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(String(input), init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/internal/agent/llm-config')) {
      if (request.headers.get('x-agent-config-token') !== CONFIG_TOKEN) return Response.json({ code: 'agent.config_unauthorized' }, { status: 401 });
      return Response.json({ runtime: {
        singleton: 'active', version: 1, securityEpoch: 1,
        activeProviderId: 'opencode-zen', activeModelId: 'opencode-zen:test-model', activeProtocol: 'chat-completions',
        activeRolloutPercentage: 100, activeRolloutMode: 'all', fallbackProviderId: null, fallbackModelId: null, updatedBy: null,
      }, activeProvider: null, activeModel: null, fallbackProvider: null, fallbackModel: null, activeDisabled: false, fallbackDisabled: false });
    }
    if (url.pathname.endsWith('/internal/agent/llm-relay')) return relay();
    if (url.pathname.endsWith('/pending-operations/v2/active')) return Response.json({ items: [unrelatedPending], total: 1 });
    if (/\/pending-operations\/v2\/[^/]+\/(cancel|execute)$/.test(url.pathname)) {
      cancelWrites += 1;
      return Response.json({ id: unrelatedPending.id, status: 'cancelled' });
    }
    throw new Error(`unexpected upstream request: ${request.method} ${url.pathname}`);
  });
  return { agent, db, sql, requests, relay, unrelatedPending, get cancelWrites() { return cancelWrites; } };
};

const chat = (text: string, intentionId: string) => new Request('https://agent.test.local/rpc/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-agent-actor': ACTOR, 'x-agent-workspace': WORKSPACE, 'x-agent-device': DEVICE },
  body: JSON.stringify({ text, intentionId }),
});

describe('FinanceChatAgent real REST entrypoint — explicit draft cancellation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('discards only the owned active draft, preserves foreign/private drafts and unrelated pending operations, and never calls planner/relay', async () => {
    const h = makeHarness([
      { actor: ACTOR, conversation: '', status: 'active', intention: 'owned-active' },
      { actor: 'another-actor', conversation: '', status: 'active', intention: 'foreign-active' },
      { actor: ACTOR, conversation: 'another-private-conversation', status: 'active', intention: 'private-active' },
    ]);
    const response = await h.agent.fetch(chat('cancele o rascunho', 'cancel-owned-active'));
    const body = await response.json() as { status?: string; output?: string; response?: { text?: string } };
    expect(response.status).toBe(200);
    expect(body.status).toBe('completed');
    expect(body.response?.text ?? body.output).toMatch(/rascunho|pendente/i);
    expect(body.response?.text ?? body.output).not.toMatch(/operação cancelada|lançamento cancelado/i);
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.requests.some((request) => new URL(request.url).pathname.endsWith('/pending-operations/v2/active'))).toBe(false);
    expect(h.requests.some((request) => /\/(?:propose|cancel|execute)(?:\/|$)/.test(new URL(request.url).pathname))).toBe(false);
    expect(h.cancelWrites).toBe(0);
    expect(h.unrelatedPending.status).toBe('proposed');
    const rows = [...h.sql.exec<{ last_intention_id: string; actor_id: string; conversation_id: string | null; resolved_args_json: string; status: string }>(
      'SELECT last_intention_id, actor_id, conversation_id, resolved_args_json, status FROM mutation_drafts ORDER BY last_intention_id',
    )];
    expect(rows.find((row) => JSON.parse(row.resolved_args_json).description === 'test draft 0')?.status).toBe('discarded');
    expect(rows.find((row) => row.last_intention_id === 'foreign-active')?.status).toBe('active');
    expect(rows.find((row) => row.last_intention_id === 'private-active')?.status).toBe('active');
    h.db.close();
  });

  it('negated cancellation leaves the draft untouched; compound cancel-plus-create only asks a clarification', async () => {
    for (const [text, expectedStatus] of [['não cancele o rascunho', 'active'], ['cancele o rascunho e crie uma despesa', 'active']] as const) {
      const h = makeHarness([{ actor: ACTOR, conversation: '', status: 'active', intention: 'protected-draft' }]);
      const response = await h.agent.fetch(chat(text, `cancel-guard-${expectedStatus}`));
      const body = await response.json() as { status?: string; output?: string; response?: { text?: string } };
      expect(response.status).toBe(200);
      expect(body.status).toBe('completed');
      expect(body.response?.text ?? body.output).toBeTruthy();
      expect(h.relay).not.toHaveBeenCalled();
      expect(h.requests.some((request) => new URL(request.url).pathname.endsWith('/pending-operations/v2/active'))).toBe(false);
      expect(h.requests.some((request) => /\/(?:propose|cancel|execute)(?:\/|$)/.test(new URL(request.url).pathname))).toBe(false);
      expect(h.cancelWrites).toBe(0);
      const [draft] = [...h.sql.exec<{ status: string }>('SELECT status FROM mutation_drafts')];
      expect(draft?.status).toBe(expectedStatus);
      h.db.close();
    }
  });

  it('expired and absent drafts return honest no-op without planner, relay, pending listing, or financial writes', async () => {
    for (const states of [
      [{ actor: ACTOR, conversation: '', status: 'expired' as const, intention: 'expired-draft' }],
      [],
    ]) {
      const h = makeHarness(states);
      const response = await h.agent.fetch(chat('cancele o rascunho', 'cancel-no-active-draft'));
      const body = await response.json() as { status?: string; output?: string; response?: { text?: string } };
      expect(response.status).toBe(200);
      expect(body.status).toBe('completed');
      expect(body.response?.text ?? body.output).toMatch(/nenhum|nenhuma|não há|nao ha/i);
      expect(body.response?.text ?? body.output).not.toMatch(/cancelad[ao]|registrad[ao]/i);
      expect(h.relay).not.toHaveBeenCalled();
      expect(h.requests.some((request) => new URL(request.url).pathname.endsWith('/pending-operations/v2/active'))).toBe(false);
      expect(h.requests.some((request) => /\/(?:propose|cancel|execute)(?:\/|$)/.test(new URL(request.url).pathname))).toBe(false);
      h.db.close();
    }
  });
});
