import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { DatabaseSync } from 'node:sqlite';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { decodeDelegatedTurnToken } from '../src/delegated-token.js';
import { buildDraftRecord, initializeMutationDraftSchema, SqlMutationDraftStore } from '../src/mutations/mutation-draft.js';
import { initializeUsageSchema, initializeUsageAttemptSchema } from '../src/safety/usage-policy.js';

const WORKSPACE = 'public-qa-workspace';
const ACTOR = 'public-qa-actor';
const DEVICE = 'public-qa-device';
const ACCOUNT_ID = '270d9848-d205-4328-afcd-db0c770fe8a5';
const CATEGORY_ID = 'dfb6e6f7-269d-4f6a-8478-e25d1cc09e01';
const ACCOUNT_NAME = 'QA Conta Descricao';
const LONG_ACCOUNT_NAME = 'QA Conta Descricao Alimentação';
const ACCOUNT_ID_LONG = '3c0c65b1-43da-48d6-9798-891b6c9e9b8f';
const ACCOUNT_ID_HOMONYM = '4c0c65b1-43da-48d6-9798-891b6c9e9b8f';
const CATEGORY_NAME = 'Alimentação';
const SECRET = 'agent-test-secret';
const TEST_CONFIG_TOKEN = 'test-config-token';
const RELAY_REPLY = 'O lançamento está pronto para revisão.';
const ORIGINAL = 'Gastei R$ 12,34 em QA Compra Solar na conta QA Conta Descricao';

const createHarness = (options: { seedDraft?: boolean; accounts?: { id: string; name: string }[]; original?: string; categoriesInitiallyAvailable?: boolean } = {}) => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) return stmt.all(...bindings as never[]) as T[];
      stmt.run(...bindings as never[]);
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
    AGENT_DELEGATION_SECRET: SECRET,
    // Test-only config authority: authorizeTurn must exercise the same
    // authenticated runtime-snapshot path as the REST gate-A harness.
    AGENT_CONFIG_TOKEN: TEST_CONFIG_TOKEN,
  }, configurable: true });
  Object.defineProperty(agent, 'resolveIntentionSnapshot', { value: async () => ({
    intention_id: 'intent-expense-category-slot', version: 1, provider_id: 'opencode-zen', model_id: 'opencode-zen:zen-free-model',
    protocol: 'chat-completions', rollout_percentage: 100, security_epoch: 1, fallback_provider_id: null,
    fallback_model_id: null, model_name: 'zen-free-model', fallback_model_name: null, created_at: new Date().toISOString(),
  }), configurable: true });
  const store = new SqlMutationDraftStore(sql);
  const original = options.original ?? ORIGINAL;
  const draft = options.seedDraft === false ? undefined : buildDraftRecord({
    workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE,
    intentionId: 'origin-expense-category-slot', tool: 'transactions.expense.create',
    resolvedArgs: { kind: 'expense', amountCents: 1234, description: original, date: '2026-10-23', categoryQuery: CATEGORY_NAME },
    missingFields: ['accountId', 'categoryId'], question: 'Qual conta e categoria devo usar?', nowMs: Date.now() - 1_000,
  });
  if (draft) {
    store.getOrCreate(draft);
    store.update(draft.draftId, { originMessages: ['origin-expense-category-slot'], lastIntentionId: 'origin-expense-category-slot' });
  }

  const requests: Request[] = [];
  const proposals = new Map<string, { id: string; body: Record<string, unknown> }>();
  let proposalCount = 0;
  let categoriesAvailable = options.categoriesInitiallyAvailable ?? true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(String(input), init);
    requests.push(req);
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.endsWith('/accounts')) {
      const accounts = options.accounts ?? [{ id: ACCOUNT_ID, name: ACCOUNT_NAME }, { id: ACCOUNT_ID_HOMONYM, name: CATEGORY_NAME }];
      return Response.json({ items: accounts.map((account) => ({ ...account, householdId: WORKSPACE, kind: 'bank', status: 'active', balanceCents: 100000 })), total: accounts.length, limit: 200, offset: 0 });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/categories')) return Response.json({ items: categoriesAvailable ? [{
      id: CATEGORY_ID, householdId: WORKSPACE, name: CATEGORY_NAME, kind: 'expense', status: 'active',
    }] : [], total: categoriesAvailable ? 1 : 0, limit: 200, offset: 0 });
    if (req.method === 'GET' && url.pathname.endsWith('/pending-operations/v2/active')) return Response.json({ items: [...proposals.values()].map(({ id, body }) => ({ id, status: 'proposed', tool: body.tool, normalizedArgs: body.normalizedArgs })), total: proposals.size });
    if (req.method === 'POST' && url.pathname.endsWith('/pending-operations/v2/propose')) {
      const body = await req.clone().json() as Record<string, unknown>;
      const key = req.headers.get('idempotency-key');
      if (!key) return Response.json({ code: 'validation.idempotency_key_required' }, { status: 400 });
      const existing = proposals.get(key);
      if (existing) return Response.json({ id: existing.id, existing: true, operation: { id: existing.id } });
      const id = `pending-expense-${++proposalCount}`;
      proposals.set(key, { id, body });
      return Response.json({ id, existing: false, summary: original, operation: { id } }, { status: 201 });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/internal/agent/llm-config')) {
      if (req.headers.get('x-agent-config-token') !== TEST_CONFIG_TOKEN) {
        return Response.json({ code: 'agent.config_unauthorized' }, { status: 401 });
      }
      return Response.json({
        runtime: { singleton: 'active', version: 3, securityEpoch: 1, activeProviderId: 'opencode-zen', activeModelId: 'opencode-zen:zen-1', activeProtocol: 'chat-completions', activeRolloutPercentage: 100, activeRolloutMode: 'all', fallbackProviderId: null, fallbackModelId: null, updatedBy: null },
        activeProvider: null, activeModel: null, fallbackProvider: null, fallbackModel: null, activeDisabled: false, fallbackDisabled: false,
      });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/internal/agent/llm-relay')) {
      return Response.json({ text: RELAY_REPLY, providerAttempted: true });
    }
    throw new Error(`unexpected upstream request: ${req.method} ${url.pathname}`);
  });
  return { agent, db, requests, proposals, store, draft, original, setCategoriesAvailable: (value: boolean) => { categoriesAvailable = value; } };
};

const chat = (text: string, intentionId: string) => new Request('https://agent.test.local/rpc/chat', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-actor': ACTOR, 'x-agent-workspace': WORKSPACE, 'x-agent-device': DEVICE },
  body: JSON.stringify({ text, intentionId }),
});

const chatWithoutDevice = (text: string, intentionId: string) => new Request('https://agent.test.local/rpc/chat', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-actor': ACTOR, 'x-agent-workspace': WORKSPACE },
  body: JSON.stringify({ text, intentionId }),
});

describe('FinanceChatAgent REST expense category/account slot recovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('category answer preserves the original account slot and proposes one manual expense with exact scoped IDs', async () => {
    const h = createHarness();
    expect(h.store.get(h.draft!.draftId)?.revision).toBe(1);
    expect(h.store.get(h.draft!.draftId)?.originMessages).toContain('origin-expense-category-slot');
    const response = await h.agent.fetch(chat(CATEGORY_NAME, 'category-answer-1'));
    const result = await response.json() as { pendingOperation?: { status?: string; operation?: string } };

    expect(response.status).toBe(200);
    expect(result.pendingOperation).toMatchObject({ status: 'proposed' });
    expect(h.proposals.size).toBe(1);
    const proposal = h.requests.find((req) => new URL(req.url).pathname.endsWith('/pending-operations/v2/propose'))!;
    const payload = await proposal.clone().json() as { tool: string; normalizedArgs: Record<string, unknown> };
    const bearer = proposal.headers.get('authorization');
    expect(bearer).toMatch(/^Bearer /);
    const claims = await decodeDelegatedTurnToken(bearer!.slice('Bearer '.length), SECRET);
    expect(claims.sub).toBe(ACTOR);
    expect(claims.workspace).toBe(WORKSPACE);
    expect(claims.deviceId).toBe(DEVICE);
    expect(payload.tool).toBe('transactions.expense.create');
    expect(payload.normalizedArgs).toMatchObject({ amountCents: 1234, accountId: ACCOUNT_ID, categoryId: CATEGORY_ID });
    expect(String(payload.normalizedArgs.description)).toBe(ORIGINAL);
    expect(h.store.listActive({ workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE }, Date.now())).toHaveLength(0);
    expect(h.requests.filter((req) => /\/(?:confirm|execute)(?:\/|$)/.test(new URL(req.url).pathname))).toHaveLength(0);
    expect(h.requests.filter((req) => req.method !== 'GET')).toHaveLength(1);
    h.db.close();
  });

  it('missing device binding never proposes from the same active draft', async () => {
    const h = createHarness();
    const response = await h.agent.fetch(chatWithoutDevice(ACCOUNT_NAME, 'account-answer-no-device'));
    expect([200, 503]).toContain(response.status);
    expect(h.proposals.size).toBe(0);
    expect(h.requests.some((req) => new URL(req.url).pathname.endsWith('/pending-operations/v2/propose'))).toBe(false);
    h.db.close();
  });

  it('fresh REST conversation keeps original account across the category question and bare answer', async () => {
    const h = createHarness({ seedDraft: false, categoriesInitiallyAvailable: false });
    const first = await h.agent.fetch(chat(ORIGINAL, 'fresh-expense-original'));
    const firstBody = await first.json() as { pendingOperation?: unknown; clarification?: unknown };
    expect(first.status).toBe(200);
    expect(firstBody.pendingOperation).toBeUndefined();
    expect(h.proposals.size).toBe(0);
    expect(h.store.listActive({ workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE }, Date.now())).toHaveLength(1);

    h.setCategoriesAvailable(true);
    const second = await h.agent.fetch(chat(CATEGORY_NAME, 'fresh-expense-category'));
    const secondBody = await second.clone().json();
    expect(second.status).toBe(200);
    expect(h.proposals.size, JSON.stringify({ secondBody, draft: h.store.listActive({ workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE }, Date.now()) })).toBe(1);
    const request = h.requests.find((req) => new URL(req.url).pathname.endsWith('/pending-operations/v2/propose'))!;
    const payload = await request.clone().json() as { tool: string; normalizedArgs: Record<string, unknown> };
    expect(payload).toMatchObject({ tool: 'transactions.expense.create', normalizedArgs: { amountCents: 1234, accountId: ACCOUNT_ID, categoryId: CATEGORY_ID, description: 'QA Compra Solar na conta QA Conta Descricao' } });
    expect(h.requests.some((req) => /\/(?:confirm|execute)(?:\/|$)/.test(new URL(req.url).pathname))).toBe(false);
    h.db.close();
  });

  it('category homonym cannot redirect the proposal away from the originally named account', async () => {
    const h = createHarness();
    await h.agent.fetch(chat(CATEGORY_NAME, 'category-answer-homonym'));
    expect(h.proposals.size).toBe(1);
    const request = h.requests.find((req) => new URL(req.url).pathname.endsWith('/pending-operations/v2/propose'))!;
    const payload = await request.clone().json() as { normalizedArgs: Record<string, unknown> };
    expect(payload.normalizedArgs.accountId).toBe(ACCOUNT_ID);
    h.db.close();
  });

  it('ambiguous longer account name with a shorter homonym clarifies without prefix fallback', async () => {
    const original = `Gastei R$ 12,34 em QA Compra Solar na conta ${LONG_ACCOUNT_NAME}`;
    const h = createHarness({ original, accounts: [{ id: ACCOUNT_ID, name: ACCOUNT_NAME }, { id: ACCOUNT_ID_LONG, name: LONG_ACCOUNT_NAME }, { id: ACCOUNT_ID_HOMONYM, name: CATEGORY_NAME }] });
    const response = await h.agent.fetch(chat(CATEGORY_NAME, 'category-answer-long-name'));
    const body = await response.json() as { output?: string };
    expect(h.proposals.size).toBe(0);
    expect(h.requests.some((req) => new URL(req.url).pathname.endsWith('/pending-operations/v2/propose'))).toBe(false);
    expect(body.output).toMatch(/qual conta|conta.*QA Conta Descricao/i);
    expect(h.store.listActive({ workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE }, Date.now())[0]?.missingFields).toContain('accountId');
    h.db.close();
  });

  it('short original account remains the selected exact name despite a longer account ending in category name', async () => {
    const h = createHarness({ accounts: [{ id: ACCOUNT_ID, name: ACCOUNT_NAME }, { id: ACCOUNT_ID_LONG, name: LONG_ACCOUNT_NAME }, { id: ACCOUNT_ID_HOMONYM, name: CATEGORY_NAME }] });
    await h.agent.fetch(chat(CATEGORY_NAME, 'category-answer-short-name'));
    expect(h.proposals.size).toBe(1);
    const request = h.requests.find((req) => new URL(req.url).pathname.endsWith('/pending-operations/v2/propose'))!;
    const payload = await request.clone().json() as { normalizedArgs: Record<string, unknown> };
    expect(payload.normalizedArgs.accountId).toBe(ACCOUNT_ID);
    h.db.close();
  });

  it('unknown longer account mention does not fall through to a shorter account', async () => {
    const original = `Gastei R$ 12,34 em QA Compra Solar na conta ${ACCOUNT_NAME} Extra`;
    const h = createHarness({ original, accounts: [{ id: ACCOUNT_ID, name: ACCOUNT_NAME }, { id: ACCOUNT_ID_HOMONYM, name: CATEGORY_NAME }] });
    await h.agent.fetch(chat(CATEGORY_NAME, 'category-answer-unknown-longer'));
    expect(h.proposals.size).toBe(0);
    const active = h.store.listActive({ workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE }, Date.now());
    expect(active).toHaveLength(1);
    expect(active[0]!.missingFields).toContain('accountId');
    h.db.close();
  });
});
