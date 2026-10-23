import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { DatabaseSync } from 'node:sqlite';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { pendingOperationOutcomeSchema } from '@pi-finance/llm-contracts';
import { decodeDelegatedTurnToken } from '../src/delegated-token.js';
import { initializeUsageSchema, initializeUsageAttemptSchema } from '../src/safety/usage-policy.js';
import { buildDraftRecord, initializeMutationDraftSchema, SqlMutationDraftStore } from '../src/mutations/mutation-draft.js';

const WORKSPACE = 'workspace-rest-deactivate';
const ACTOR = 'actor-rest-deactivate';
const DEVICE = 'device-rest-deactivate';
const CATEGORY_ID = '6295137c-fd8f-499e-8c2b-a1dc228a3881';
const CATEGORY_NAME = 'Jade';
const SECRET = 'agent-test-secret';
const CONVERSATION = 'conversation-rest-deactivate';
const PRIVATE_CONVERSATION_A = 'conversation-private-A';
const LEGACY_OPERATION_ID = '25e294b2-3819-4762-bc70-9c59cb997174';
const PRIVATE_OPERATION_ID = '6295137c-fd8f-499e-8c2b-a1dc228a3882';
const FOREIGN_OPERATION_ID = '6295137c-fd8f-499e-8c2b-a1dc228a3883';

const createSqlShim = () => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...(bindings as never[])) as T[];
      }
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
    transactionSync<T>(fn: () => T): T { return fn(); },
  };
  initializeUsageSchema(sql as never);
  initializeUsageAttemptSchema(sql as never);
  initializeMutationDraftSchema(sql as never);
  return { db, sql };
};

const createTestAgent = () => {
  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: UIMessage[];
    persistMessages: (messages: UIMessage[]) => Promise<void>;
  };
  agent.messages = persisted;
  agent.persistMessages = vi.fn(async (messages: UIMessage[]) => { persisted.push(...messages); });
  const { db, sql } = createSqlShim();
  Object.defineProperty(agent, 'ctx', { value: { storage: { sql, transactionSync: sql.transactionSync } }, writable: true, configurable: true });
  Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
  Object.defineProperty(agent, 'env', {
    value: { API_ORIGIN: 'https://api.test.local', AGENT_DELEGATION_SECRET: SECRET },
    writable: true, configurable: true,
  });
  Object.defineProperty(agent, 'resolveIntentionSnapshot', { value: async () => ({
    intention_id: 'intent-rest-deactivate', version: 1, provider_id: 'opencode-zen', model_id: 'opencode-zen:zen-free-model',
    protocol: 'chat-completions', rollout_percentage: 100, security_epoch: 1, fallback_provider_id: null,
    fallback_model_id: null, model_name: 'zen-free-model', fallback_model_name: null, created_at: new Date().toISOString(),
  }), writable: true, configurable: true });
  return { agent, db, sql, persisted };
};

const makeChatRequest = (text: string, intentionId: string, withDevice = true) => new Request('https://agent.test.local/rpc/chat', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-agent-actor': ACTOR,
    'x-agent-workspace': WORKSPACE,
    ...(withDevice ? { 'x-agent-device': DEVICE } : {}),
  },
  body: JSON.stringify({ text, intentionId }),
});

const makeLegacyHistoryHarness = (options: { openSession?: boolean; sessionId?: string; transactionUpdate?: boolean } = {}) => {
  const { agent, sql } = createTestAgent();
  const api = makeStatefulApi();
  const intentionId = '1904d196-d9b4-4364-91f9-a4a10b493b7e';
  const draftStore = new SqlMutationDraftStore(sql);
  const txId = '11018a76-4247-4f76-b2a6-d338798c6a9b';
  const tool = options.transactionUpdate ? 'transactions.update' : 'categories.deactivate';
  const resolvedArgs = options.transactionUpdate
    ? { kind: 'transaction-description' as const, amountCents: 0, description: 'QA Mercado Solar', date: '', transactionId: txId, expectedDescription: 'QA Compra Solar' }
    : { kind: 'category-deactivate' as const, amountCents: 0, description: CATEGORY_NAME, date: '', categoryId: CATEGORY_ID, expectedName: CATEGORY_NAME };
  const draft = buildDraftRecord({
    workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE,
    intentionId, tool,
    resolvedArgs,
    missingFields: [], question: 'confirmar categoria',
  });
  draftStore.getOrCreate(draft);
  draftStore.update(draft.draftId, { status: 'consumed', proposalId: LEGACY_OPERATION_ID });
  const foreignIntent = 'intent-foreign-public-message';
  const foreignVisibleDraft = buildDraftRecord({
    workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE,
    intentionId: foreignIntent, tool: 'categories.deactivate',
    resolvedArgs: { kind: 'category-deactivate', amountCents: 0, description: CATEGORY_NAME, date: '', categoryId: CATEGORY_ID, expectedName: CATEGORY_NAME },
    missingFields: [], question: 'current actor own proposal',
  });
  draftStore.getOrCreate(foreignVisibleDraft);
  draftStore.update(foreignVisibleDraft.draftId, { status: 'consumed', proposalId: FOREIGN_OPERATION_ID });
  const privateIntention = 'intent-private-hidden-proposal';
  const privateDraft = buildDraftRecord({
    workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE, conversationId: CONVERSATION,
    intentionId: privateIntention, tool: 'categories.deactivate',
    resolvedArgs: { kind: 'category-deactivate', amountCents: 0, description: CATEGORY_NAME, date: '', categoryId: CATEGORY_ID, expectedName: CATEGORY_NAME },
    missingFields: [], question: 'private proposal',
  });
  draftStore.getOrCreate(privateDraft);
  draftStore.update(privateDraft.draftId, { status: 'consumed', proposalId: 'hidden-private-proposal' });
  const privateIntentionA = 'intent-private-A-proposal';
  const privateDraftA = buildDraftRecord({
    workspaceId: WORKSPACE, actorId: ACTOR, deviceId: DEVICE, conversationId: PRIVATE_CONVERSATION_A,
    intentionId: privateIntentionA, tool: 'categories.deactivate',
    resolvedArgs: { kind: 'category-deactivate', amountCents: 0, description: CATEGORY_NAME, date: '', categoryId: CATEGORY_ID, expectedName: CATEGORY_NAME },
    missingFields: [], question: 'private A proposal',
  });
  draftStore.getOrCreate(privateDraftA);
  draftStore.update(privateDraftA.draftId, { status: 'consumed', proposalId: PRIVATE_OPERATION_ID });
  const beforeRows = [...sql.exec<{ status: string; proposal_id: string | null }>('SELECT status, proposal_id FROM mutation_drafts')];
  agent.messages = [{
    id: 'assistant-conflicting-link', role: 'assistant', parts: [{ type: 'text', text: 'Outro contexto antigo.' }],
    metadata: { actorId: 'ted', workspaceId: WORKSPACE, visibility: 'workspace', ownerActorId: ACTOR, conversationId: CONVERSATION, intentionId: 'intent-conflicting-context', createdAt: '2026-10-20T00:00:00.000Z', pendingProposal: { operationId: LEGACY_OPERATION_ID, tool: 'categories.deactivate', expectedContext: { tool: 'categories.deactivate', entityId: '6295137c-fd8f-499e-8c2b-a1dc228a3882' } } },
  }, {
    id: 'assistant-old-proposal', role: 'assistant', parts: [{ type: 'text', text: 'Proposta de atualização.' }],
    metadata: { actorId: 'ted', workspaceId: WORKSPACE, visibility: 'workspace', ownerActorId: ACTOR, conversationId: '', intentionId, createdAt: new Date().toISOString() },
  }, {
    id: 'assistant-foreign-public-shared-intention', role: 'assistant', parts: [{ type: 'text', text: 'Mensagem pública de outro ator.' }],
    metadata: { actorId: 'ted', workspaceId: WORKSPACE, visibility: 'workspace', ownerActorId: 'actor-foreign', conversationId: '', intentionId: foreignIntent, createdAt: new Date().toISOString() },
  }, {
    id: 'assistant-missing-actor-provenance', role: 'assistant', parts: [{ type: 'text', text: 'Mensagem sem atribuição.' }],
    metadata: { workspaceId: WORKSPACE, visibility: 'workspace', ownerActorId: ACTOR, conversationId: '', intentionId: foreignIntent, createdAt: new Date().toISOString() },
  }, {
    id: 'assistant-private-A-proposal', role: 'assistant', parts: [{ type: 'text', text: 'Proposta privada A.' }],
    metadata: { actorId: 'ted', workspaceId: WORKSPACE, visibility: 'private', ownerActorId: ACTOR, conversationId: PRIVATE_CONVERSATION_A, intentionId: privateIntentionA, createdAt: new Date().toISOString() },
  }, {
    id: 'assistant-collective-private-intention', role: 'assistant', parts: [{ type: 'text', text: 'Mensagem coletiva com intenção coincidente.' }],
    metadata: { actorId: 'ted', workspaceId: WORKSPACE, visibility: 'workspace', ownerActorId: ACTOR, conversationId: '', intentionId: privateIntentionA, createdAt: new Date().toISOString() },
  }, {
    id: 'assistant-private-missing-conversation', role: 'assistant', parts: [{ type: 'text', text: 'Privado sem contexto.' }],
    metadata: { actorId: 'ted', workspaceId: WORKSPACE, visibility: 'private', ownerActorId: ACTOR, conversationId: '', intentionId: privateIntentionA, createdAt: new Date().toISOString() },
  }, {
    id: 'assistant-unknown-visibility', role: 'assistant', parts: [{ type: 'text', text: 'Audience desconhecida.' }],
    metadata: { actorId: 'ted', workspaceId: WORKSPACE, visibility: 'not-a-known-audience', ownerActorId: ACTOR, conversationId: '', intentionId, createdAt: new Date().toISOString() },
  }, {
    id: 'assistant-missing-workspace-provenance', role: 'assistant', parts: [{ type: 'text', text: 'Sem provenance de workspace.' }],
    metadata: { actorId: 'ted', visibility: 'workspace', ownerActorId: ACTOR, conversationId: '', intentionId, createdAt: new Date().toISOString() },
  }, {
    id: 'assistant-private-proposal', role: 'assistant', parts: [{ type: 'text', text: 'Privado.' }],
    metadata: { actorId: 'ted', workspaceId: WORKSPACE, visibility: 'private', ownerActorId: 'another-actor', conversationId: CONVERSATION, intentionId: privateIntention, createdAt: new Date().toISOString() },
  }, {
    id: 'user-text-contains-id', role: 'user', parts: [{ type: 'text', text: 'hidden-private-proposal' }],
      metadata: { actorId: ACTOR, workspaceId: WORKSPACE, visibility: 'workspace', ownerActorId: ACTOR, conversationId: '', createdAt: new Date().toISOString() },
    }] as unknown as UIMessage[];
  (agent as unknown as { readOpenSessionOrThrow: () => { conversationId: string } | null }).readOpenSessionOrThrow = () => options.openSession === false ? null : ({ conversationId: options.sessionId ?? CONVERSATION });
  return {
    agent, sql, api, beforeRows,
    loadHistory: () => agent.fetch(new Request('https://agent.test.local/rpc/history', {
      method: 'GET', headers: { 'x-agent-actor': ACTOR, 'x-agent-workspace': WORKSPACE, 'x-agent-device': DEVICE },
    })),
  };
};

const makeStatefulApi = () => {
  const requests: Request[] = [];
  const proposals = new Map<string, { id: string; body: Record<string, unknown> }>();
  let proposalSequence = 0;
  let outcomeOverride: unknown;
  let failOutcomeRead = false;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(String(input), init);
    requests.push(request);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === 'GET' && url.pathname.endsWith('/outcome')) {
      const operationId = url.pathname.split('/').at(-2)!;
      if (failOutcomeRead) throw new Error('private API transport details');
      const body = outcomeOverride !== undefined ? outcomeOverride : {
        operationId, tool: 'categories.deactivate', status: 'succeeded',
        expectedContext: { tool: 'categories.deactivate', entityId: CATEGORY_ID },
        receipt: { mutationId: 'mutation-category-deactivate-legacy', mutationKind: 'categories.deactivate', status: 'succeeded', affectedTargets: ['categories', 'transactions'], operationId, entity: { type: 'category', id: CATEGORY_ID } },
      };
      return Response.json(body);
    }
    if (method === 'GET' && url.pathname.endsWith('/categories')) {
      return Response.json({ items: [{ id: CATEGORY_ID, name: CATEGORY_NAME, kind: 'expense', status: 'active' }] });
    }
    if (method === 'GET' && url.pathname.endsWith('/pending-operations/v2/active')) {
      return Response.json({ items: [...proposals.values()].map(({ id, body }) => ({
        id, status: 'proposed', tool: body.tool, normalizedArgs: body.normalizedArgs,
      })), total: proposals.size });
    }
    if (method === 'POST' && url.pathname.endsWith('/pending-operations/v2/propose')) {
      const key = request.headers.get('idempotency-key');
      if (!key) return Response.json({ code: 'validation.idempotency_key_required' }, { status: 400 });
      const body = await request.clone().json() as Record<string, unknown>;
      const existing = proposals.get(key);
      if (existing) return Response.json({ id: existing.id, existing: true, operation: { id: existing.id } }, { status: 200 });
      const id = `pending-category-deactivate-${++proposalSequence}`;
      proposals.set(key, { id, body });
      return Response.json({ id, existing: false, summary: 'desativar categoria', operation: { id } }, { status: 201 });
    }
    if (method === 'GET' && url.pathname.endsWith('/internal/agent/llm-config')) {
      return Response.json({ runtime: {
        singleton: 'active', version: 3, securityEpoch: 1, activeProviderId: 'opencode-zen', activeModelId: 'opencode-zen:zen-1',
        activeProtocol: 'chat-completions', activeRolloutPercentage: 100, activeRolloutMode: 'all',
        fallbackProviderId: null, fallbackModelId: null, updatedBy: null,
      }, activeProvider: null, activeModel: null, fallbackProvider: null, fallbackModel: null, activeDisabled: false, fallbackDisabled: false });
    }
    throw new Error(`unexpected upstream request: ${method} ${url.pathname}`);
  });
  return { requests, proposals, fetch, setOutcome: (value: unknown) => { outcomeOverride = value; }, failOutcome: () => { failOutcomeRead = true; } };
};

const writeEndpointRequests = (requests: Request[]) => requests.filter((request) => {
  const path = new URL(request.url).pathname;
  return request.method !== 'GET' && /(?:pending-operations|mutations|accounts|categories|transactions|budgets|goals|payables|cards)/i.test(path);
});

describe('FinanceChatAgent REST entrypoint — categories.deactivate', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('authenticated fresh request creates exactly one strict manual proposal and never confirms/executes it', async () => {
    const { agent, sql } = createTestAgent();
    const api = makeStatefulApi();
    const response = await agent.fetch(makeChatRequest(`desative a categoria ${CATEGORY_NAME}`, 'intent-category-deactivate-rest'));
    const body = await response.json() as { status?: unknown; pendingOperation?: { status?: unknown; operation?: unknown } };

    expect(response.status).toBe(200);
    expect(body.status).toBe('completed');
    expect(body.pendingOperation, JSON.stringify({ body, requests: api.requests.map((request) => [request.method, new URL(request.url).pathname]) })).toMatchObject({ status: 'proposed', operation: 'categories.deactivate' });
    expect(api.proposals.size).toBe(1);
    const proposalRequest = api.requests.find((request) => new URL(request.url).pathname.endsWith('/pending-operations/v2/propose'))!;
    expect(proposalRequest).toBeDefined();
    const proposalBody = await proposalRequest.clone().json() as Record<string, unknown>;
    expect(proposalBody.tool).toBe('categories.deactivate');
    expect(proposalBody.normalizedArgs).toEqual({ categoryId: CATEGORY_ID, expectedName: CATEGORY_NAME });
    const persistedDrafts = [...sql.exec<{ proposal_idempotency_key: string }>('SELECT proposal_idempotency_key FROM mutation_drafts')];
    expect(persistedDrafts).toHaveLength(1);
    const draftKey = persistedDrafts[0]!.proposal_idempotency_key;
    expect(draftKey).toBeTruthy();
    expect(proposalRequest.headers.get('idempotency-key')).toBe(draftKey);
    const authorization = proposalRequest.headers.get('authorization');
    expect(authorization).toMatch(/^Bearer /);
    const claims = await decodeDelegatedTurnToken(authorization!.slice('Bearer '.length), SECRET);
    expect(claims.sub).toBe(ACTOR);
    expect(claims.workspace).toBe(WORKSPACE);
    expect(claims.deviceId).toBe(DEVICE);
    expect(api.requests.some((request) => /\/(?:confirm|execute)(?:\/|$)/.test(new URL(request.url).pathname))).toBe(false);
    expect(writeEndpointRequests(api.requests)).toHaveLength(1);
    expect(writeEndpointRequests(api.requests)[0]!.url).toContain('/pending-operations/v2/propose');
  });

  it('missing-target fragment then exact name creates one card, without a separate autoexecution path', async () => {
    const { agent, sql } = createTestAgent();
    const api = makeStatefulApi();
    const first = await agent.fetch(makeChatRequest('desative categoria', 'intent-category-deactivate-fragment'));
    const firstBody = await first.json() as { pendingOperation?: unknown };
    expect(first.status).toBe(200);
    expect(firstBody.pendingOperation).toBeUndefined();
    expect(api.proposals.size).toBe(0);

    const second = await agent.fetch(makeChatRequest(CATEGORY_NAME, 'intent-category-deactivate-target'));
    const secondBody = await second.json() as { pendingOperation?: { status?: unknown; operation?: unknown } };
    expect(second.status).toBe(200);
    expect(secondBody.pendingOperation).toMatchObject({ status: 'proposed', operation: 'categories.deactivate' });
    expect(api.proposals.size).toBe(1);
    const proposal = [...api.proposals.values()][0]!;
    expect(proposal.body.normalizedArgs).toEqual({ categoryId: CATEGORY_ID, expectedName: CATEGORY_NAME });
    const proposalRequest = api.requests.find((request) => new URL(request.url).pathname.endsWith('/pending-operations/v2/propose'))!;
    const key = proposalRequest.headers.get('idempotency-key');
    expect(key).toBeTruthy();
    expect([...sql.exec<{ proposal_idempotency_key: string }>('SELECT proposal_idempotency_key FROM mutation_drafts')].map((row) => row.proposal_idempotency_key)).toContain(key);
    expect(api.requests.some((request) => /\/(?:confirm|execute)(?:\/|$)/.test(new URL(request.url).pathname))).toBe(false);
    expect(writeEndpointRequests(api.requests)).toHaveLength(1);
  });

  it('without an authenticated device sends no upstream mutation writes', async () => {
    const { agent, sql } = createTestAgent();
    const api = makeStatefulApi();
    const response = await agent.fetch(makeChatRequest(`desative a categoria ${CATEGORY_NAME}`, 'intent-category-deactivate-no-device', false));
    expect(response.status).toBe(200);
    const body = await response.json() as { output?: unknown };
    expect(String(body.output ?? '')).toMatch(/dispositivo|sessão/i);
    expect(String(body.output ?? '')).not.toMatch(/privad|visibilidade|outra conversa/i);
    expect(api.proposals).toHaveLength(0);
    expect(writeEndpointRequests(api.requests)).toHaveLength(0);
    expect(api.requests.some((request) => /\/(?:propose|confirm|execute|retry|cancel)(?:\/|$)/.test(new URL(request.url).pathname))).toBe(false);
    expect([...sql.exec('SELECT draft_id FROM mutation_drafts')]).toHaveLength(0);
  });

  it('enriches visible legacy history from the exact consumed intention draft, without writing on GET', async () => {
    const { sql, api, beforeRows, loadHistory } = makeLegacyHistoryHarness();
    const history = await loadHistory();
    const body = await history.json() as { items: Array<{ id: string; proposalOperationId?: string; proposalTool?: string; terminalOutcome?: { status?: string; operationId?: string } }> };

    expect(history.status).toBe(200);
    const oldProposalMessage = body.items.find((item) => item.id === 'assistant-old-proposal');
    const mismatchedMessage = body.items.find((item) => item.id === 'assistant-conflicting-link');
    expect(oldProposalMessage).toMatchObject({
      proposalOperationId: LEGACY_OPERATION_ID,
      proposalTool: 'categories.deactivate',
      terminalOutcome: { operationId: LEGACY_OPERATION_ID, status: 'succeeded' },
    });
    expect(mismatchedMessage?.proposalOperationId).toBe(LEGACY_OPERATION_ID);
    expect(mismatchedMessage?.terminalOutcome).toBeUndefined();
    expect(body.items).toHaveLength(9);
    expect(body.items.some((item) => item.proposalOperationId === 'hidden-private-proposal')).toBe(false);
    expect(body.items.some((item) => item.id === 'assistant-private-proposal')).toBe(false);
    expect(body.items.some((item) => item.id === 'assistant-private-A-proposal')).toBe(false);
    expect(body.items.find((item) => item.id === 'assistant-collective-private-intention')?.proposalOperationId).toBeUndefined();
    for (const id of ['assistant-private-missing-conversation', 'assistant-unknown-visibility', 'assistant-missing-workspace-provenance']) {
      expect(body.items.find((item) => item.id === id)?.proposalOperationId).toBeUndefined();
      expect(body.items.find((item) => item.id === id)?.terminalOutcome).toBeUndefined();
    }
    expect(api.requests.filter((request) => new URL(request.url).pathname.endsWith('/outcome')).map((request) => new URL(request.url).pathname)).toEqual([`/pending-operations/v2/${LEGACY_OPERATION_ID}/outcome`]);
    expect([...sql.exec<{ status: string; proposal_id: string | null }>('SELECT status, proposal_id FROM mutation_drafts')]).toEqual(beforeRows);
  });

  it('recovers the exact target for a legacy transactions.update history outcome without writing on GET', async () => {
    const { sql, api, beforeRows, loadHistory } = makeLegacyHistoryHarness({ transactionUpdate: true });
    const operationId = LEGACY_OPERATION_ID;
    const txId = '11018a76-4247-4f76-b2a6-d338798c6a9b';
    const receipt = { mutationId: 'mutation-update-history-test', mutationKind: 'transactions.update', status: 'succeeded', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'], operationId, entity: { type: 'transaction', id: txId } };
    api.setOutcome({ operationId, tool: 'transactions.update', status: 'succeeded', expectedContext: { tool: 'transactions.update', entityId: txId }, receipt });
    const response = await loadHistory();
    const body = await response.json() as { items: Array<Record<string, any>> };
    const item = body.items.find((candidate) => candidate.id === 'assistant-old-proposal');
    expect(item).toMatchObject({ proposalOperationId: operationId, proposalTool: 'transactions.update', terminalOutcome: { operationId, status: 'succeeded', expectedContext: { entityId: txId } } });
    expect(api.requests.filter((request) => new URL(request.url).pathname.endsWith('/outcome'))).toHaveLength(1);
    expect(api.requests.every((request) => request.method === 'GET')).toBe(true);
    expect([...sql.exec<{ status: string; proposal_id: string | null }>('SELECT status, proposal_id FROM mutation_drafts')]).toEqual(beforeRows);
  });

  it('rejects malformed/nonterminal DTOs and binds each terminal result to the exact history context', async () => {
    const { api, loadHistory } = makeLegacyHistoryHarness();
    const operationId = LEGACY_OPERATION_ID;
    const tool = 'categories.deactivate';
    const receipt = { mutationId: 'mutation-history-test', mutationKind: tool, status: 'succeeded', affectedTargets: ['categories', 'transactions'], operationId, entity: { type: 'category', id: CATEGORY_ID } };
    const success = { operationId, tool, status: 'succeeded', receipt, expectedContext: { tool, entityId: CATEGORY_ID } };
    const projection = async (body?: unknown, fail = false) => {
      if (fail) api.failOutcome();
      else api.setOutcome(body);
      const response = await loadHistory();
      const history = await response.json() as { items: Array<{ id: string; terminalOutcome?: { status?: string; failureCode?: string } }> };
      return history.items.find((item) => item.id === 'assistant-old-proposal')?.terminalOutcome;
    };

    for (const malformed of [
      { operationId, tool, status: 'proposed' },
      { operationId, tool, status: 'confirmed' },
      { operationId, tool, status: 'executing' },
      { ...success, status: 'proposed' },
      { ...success, status: 'unknown-terminal' },
      { operationId, tool },
      { ...success, operationId: '00000000-0000-4000-8000-000000000099' },
      { ...success, tool: 'accounts.deactivate' },
      { ...success, expectedContext: { tool, entityId: '6295137c-fd8f-499e-8c2b-a1dc228a3882' } },
      { ...success, expectedContext: { tool, entityId: CATEGORY_ID, untrusted: true } },
      { operationId, tool, status: 'cancelled', expectedContext: { tool, entityId: '6295137c-fd8f-499e-8c2b-a1dc228a3882' } },
      { operationId, tool, status: 'failed', failureCode: 'raw-error' },
      { operationId, tool: 'accounts.deactivate', status: 'failed', failureCode: 'in_use' },
    ]) {
      expect(await projection(malformed), JSON.stringify(malformed)).toBeUndefined();
    }

    const genericFailure = { operationId, tool, status: 'failed' };
    expect(pendingOperationOutcomeSchema.safeParse(genericFailure).success).toBe(true);
    expect(await projection(genericFailure)).toEqual({ operationId, tool, status: 'failed' });
    expect(await projection({ operationId, tool, status: 'failed', failureCode: 'in_use' })).toEqual({ operationId, tool, status: 'failed', failureCode: 'in_use' });
    expect(await projection({ operationId, tool, status: 'cancelled' })).toEqual({ operationId, tool, status: 'cancelled' });
    expect(await projection({ operationId, tool, status: 'expired' })).toEqual({ operationId, tool, status: 'expired' });
    expect(await projection({ operationId, tool, status: 'unverified' })).toEqual({ operationId, tool, status: 'unverified' });
    expect(await projection(undefined, true)).toBeUndefined();
  });

  it('uses the global public draft context even when no session is open', async () => {
    const { api, loadHistory } = makeLegacyHistoryHarness({ openSession: false });
    const operationId = LEGACY_OPERATION_ID;

    const response = await loadHistory();
    const body = await response.json() as { items: Array<{ id: string; proposalOperationId?: string; terminalOutcome?: { status?: string; operationId?: string } }> };
    const oldProposalMessage = body.items.find((item) => item.id === 'assistant-old-proposal');
    expect(oldProposalMessage?.terminalOutcome).toMatchObject({ operationId, status: 'succeeded' });
    const privateProposal = body.items.find((item) => item.id === 'assistant-private-A-proposal');
    expect(privateProposal).toBeDefined();
    expect(privateProposal?.proposalOperationId).toBe(PRIVATE_OPERATION_ID);
    expect(api.requests.some((request) => new URL(request.url).pathname === `/pending-operations/v2/${PRIVATE_OPERATION_ID}/outcome`)).toBe(true);
    expect(privateProposal?.terminalOutcome).toMatchObject({ operationId: PRIVATE_OPERATION_ID, status: 'succeeded' });
    expect(api.requests.filter((request) => new URL(request.url).pathname.endsWith('/outcome'))).toHaveLength(2);
  });

  it('uses the exact owned private conversation context and never promotes its intention into collective history', async () => {
    const { api, loadHistory } = makeLegacyHistoryHarness({ sessionId: PRIVATE_CONVERSATION_A });
    const response = await loadHistory();
    const body = await response.json() as { items: Array<{ id: string; proposalOperationId?: string; terminalOutcome?: { status?: string; operationId?: string } }> };
    const privateProposal = body.items.find((item) => item.id === 'assistant-private-A-proposal');
    const collectiveMessage = body.items.find((item) => item.id === 'assistant-collective-private-intention');

    expect(privateProposal).toMatchObject({
      proposalOperationId: PRIVATE_OPERATION_ID,
      terminalOutcome: { operationId: PRIVATE_OPERATION_ID, status: 'succeeded' },
    });
    expect(collectiveMessage?.proposalOperationId).toBeUndefined();
    expect(collectiveMessage?.terminalOutcome).toBeUndefined();
    expect(api.requests.filter((request) => new URL(request.url).pathname.endsWith('/outcome')).map((request) => new URL(request.url).pathname)).toContain(`/pending-operations/v2/${PRIVATE_OPERATION_ID}/outcome`);
  });

  it('does not bind another actor’s visible public assistant message to the current actor draft', async () => {
    const { api, loadHistory } = makeLegacyHistoryHarness();
    const response = await loadHistory();
    const body = await response.json() as { items: Array<{ id: string; proposalOperationId?: string; terminalOutcome?: unknown }> };
    for (const id of ['assistant-foreign-public-shared-intention', 'assistant-missing-actor-provenance']) {
      const message = body.items.find((item) => item.id === id);
      expect(message).toBeDefined(); // visibility behavior is unchanged
      expect(message?.proposalOperationId).toBeUndefined();
      expect(message?.terminalOutcome).toBeUndefined();
    }
    expect(api.requests.some((request) => new URL(request.url).pathname === `/pending-operations/v2/${FOREIGN_OPERATION_ID}/outcome`)).toBe(false);
  });
});
