import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity } from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient, type MutationRequest } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';
import { routeIntent } from '../../src/orchestration/intent-router.js';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import { decodeDelegatedTurnToken } from '../../src/delegated-token.js';

const identity: AuthenticatedIdentity = { actorId: 'actor-1', workspaceId: 'workspace-1', role: 'member', deviceId: 'device-1' };
const account = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const category = { id: '00000000-0000-4000-8000-000000000011', name: 'Almoço' };
const reader: EntityReader = { listAccounts: async () => [account], listCategories: async () => [category] };
const mutationPlan = () => ({
  version: '2' as const, mode: 'mutation-proposal' as const, domain: 'transactions' as const,
  skillNames: [], requestedOperations: [{ name: 'transactions.expense.create', kind: 'mutation' as const }],
  missingFields: [], ambiguity: null, confidence: 1,
});
type Mode = 'normal' | 'disabled' | 'ineligible' | 'lost' | 'prewrite' | 'authorizeLostConfirmed' | 'authorize500Proposed' | 'authorizeReadFails' | 'forbidden';

const setup = (options: { mode?: Mode; duplicate?: boolean; duplicateError?: boolean } = {}) => {
  const mode = options.mode ?? 'normal';
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const effects = { execute: 0, authorize: 0, mintElevated: 0 };
  let sequence = 0;
  let executeAttempts = 0;
  const state = new Map<string, { status: string; key: string }>();
  const request = vi.fn(async (method: string, path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
    requests.push({ method, path, body: opts?.body });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const key = opts?.idempotencyKey ?? '';
      const existing = [...state.entries()].find(([, value]) => value.key === key);
      if (existing) return { id: existing[0], existing: true };
      sequence++;
      const id = `op-${sequence}`;
      state.set(id, { status: 'proposed', key });
      return { id };
    }
    const match = /^\/pending-operations\/v2\/([^/]+)\/(authorize|execute|retry)$/.exec(path);
    if (method === 'POST' && match) {
      const id = match[1]!;
      const action = match[2]!;
      const op = state.get(id);
      if (!op) throw Object.assign(new Error('approval.not_found'), { statusCode: 404, code: 'approval.not_found' });
      if (action === 'authorize') {
        effects.authorize++;
        if (mode === 'disabled' || mode === 'ineligible') {
          const code = mode === 'disabled' ? 'approval.autoexecute_disabled' : 'approval.autoexecute_not_eligible';
          throw Object.assign(new Error(code), { statusCode: 409, code });
        }
        if (mode === 'authorizeLostConfirmed') {
          op.status = 'confirmed';
          throw Object.assign(new Error('response lost after authorization'), { code: 'api.request_failed' });
        }
        if (mode === 'authorize500Proposed') {
          throw Object.assign(new Error('upstream unavailable'), { statusCode: 500, code: 'api.request_failed' });
        }
        if (mode === 'authorizeReadFails') {
          throw Object.assign(new Error('timeout'), { code: 'api.request_failed' });
        }
        if (mode === 'forbidden') {
          throw Object.assign(new Error('forbidden'), { statusCode: 403, code: 'auth.delegation_scope_forbidden' });
        }
        op.status = 'confirmed';
        return { id, status: 'confirmed', attestation: 'a'.repeat(40) };
      }
      if (action === 'retry') {
        if (op.status !== 'failed') throw Object.assign(new Error('approval.retry_not_allowed'), { statusCode: 409, code: 'approval.retry_not_allowed' });
        op.status = 'confirmed';
        return { id, attestation: 'b'.repeat(40) };
      }
      if (action === 'execute') {
        executeAttempts++;
        if (mode === 'lost' && effects.execute === 0) {
          effects.execute++;
          op.status = 'succeeded'; // committed effect, response lost
          throw Object.assign(new Error('network lost after commit'), { code: 'api.request_failed' });
        }
        if (mode === 'prewrite' && executeAttempts === 1) {
          op.status = 'failed';
          throw Object.assign(new Error('approval.execution_failed'), { statusCode: 422, code: 'approval.execution_failed' });
        }
        effects.execute++;
        op.status = 'succeeded';
        const transactionId = `tx-${id}`;
        const receipt = {
          mutationId: transactionId, mutationKind: 'transactions.expense.create', status: 'succeeded',
          affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
          operationId: id, entity: { type: 'transaction', id: transactionId },
        };
        return { id, status: 'succeeded', execution: { status: 'succeeded', operationId: transactionId, receipt } };
      }
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      if (mode === 'authorizeReadFails') throw new Error('status read unavailable');
      return { items: [...state].map(([id, value]) => ({ id, status: value.status, tool: 'transactions.expense.create', createdAt: '2026-10-02T00:00:00Z', expiresAt: '2026-10-03T00:00:00Z' })), total: state.size };
    }
    throw new Error(`unexpected API request: ${method} ${path}`);
  });
  const typedRequest = request as unknown as MutationRequest;
  const api = new MutationApiClient({
    request: typedRequest,
    strictDuplicateCheck: async () => options.duplicateError ? true : options.duplicate ?? false,
  });
  const elevatedClient = () => {
    effects.mintElevated++;
    return new MutationApiClient({ request: typedRequest });
  };
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api, entityReader: reader, draftStore: new InMemoryMutationDraftStore(),
    plan: (input) => /^(registre|e se eu registrasse)/i.test(input.text) ? mutationPlan() : routeIntent(input.text),
    autoExecutionClient: elevatedClient,
  });
  const run = (text: string, intentionId: string) => orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  return { run, request: typedRequest, requests, effects, state };
};

// SPEC R03: the transaction description is not a category query, so these
// turns name the category explicitly (the catalog entry is "Almoço").
const affirmative = 'Registre R$ 35 de almoço no Nubank na categoria Almoço';

describe('autoexecute proposal integration', () => {
  it('1, 9: authorizes and executes once, returns receipt without card or internal jargon', async () => {
    const h = setup();
    const result = await h.run(affirmative, 'intent-auto-ok');
    expect(result.mutation).toMatchObject({ status: 'succeeded', receipt: { operationId: 'op-1' } });
    expect(result.mutation?.presentation).toBeUndefined();
    expect(result.policy.authorizationMode).toBe('auto');
    expect(h.effects).toMatchObject({ execute: 1, authorize: 1, mintElevated: 1 });
    expect(result.response?.text).not.toMatch(/approval|attestation|pending operation/i);
    expect(result.response?.text).toMatch(/desfazer/i);
    expect(h.requests.find((r) => r.path.endsWith('/authorize'))?.path).toBe('/pending-operations/v2/op-1/authorize');
  });

  it('1-2: production elevated client lazily signs the autoexecute capability for authorize', async () => {
    const secret = 'integration-test-delegation-secret-at-least-32-bytes';
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & { env: Record<string, string> };
    Object.defineProperty(agent, 'env', { value: { AGENT_DELEGATION_SECRET: secret, API_ORIGIN: 'https://api.test.local' }, configurable: true });
    const input = normalizeRestTurn({ text: affirmative, intentionId: 'intent-signed' }, identity);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: 'op-signed', status: 'confirmed', attestation: 'x'.repeat(40) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const elevatedFactory = (agent as unknown as { elevatedMutationApiClientForTurn: (turn: typeof input) => MutationApiClient }).elevatedMutationApiClientForTurn.bind(agent);
      const elevated = elevatedFactory(input);
      expect(fetchMock).not.toHaveBeenCalled();
      await elevated.authorize('op-signed', { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! });
      const init = fetchMock.mock.calls[0]?.[1] ?? {};
      const authorization = new Headers(init.headers).get('authorization');
      expect(authorization).toMatch(/^Bearer /);
      const claims = await decodeDelegatedTurnToken(authorization!.slice(7), secret);
      expect(claims.capabilities).toContain('financial.approval.autoexecute');
      expect(claims).toMatchObject({ sub: identity.actorId, workspace: identity.workspaceId, deviceId: identity.deviceId, request: 'intent-signed' });
      expect(claims.exp - claims.iat).toBe(300);
      expect(init.body).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['disabled', 'ineligible'] as const)('3-4: %s server refusal returns manual card without error', async (mode) => {
    const h = setup({ mode });
    const text = mode === 'ineligible' ? 'Registre R$ 50.000,00 de almoço no Nubank na categoria Almoço' : affirmative;
    const result = await h.run(text, `intent-${mode}`);
    expect(result.mutation).toMatchObject({ status: 'proposed', presentation: expect.any(Object) });
    expect(result.policy.authorizationMode).toBe('manual');
    expect(result.response?.text).not.toMatch(/approval.autoexecute|não foi possível|erro/i);
    expect(h.effects.execute).toBe(0);
  });

  it('a: lost authorize response with confirmed server state is inconclusive, never a manual card', async () => {
    const h = setup({ mode: 'authorizeLostConfirmed' });
    const result = await h.run(affirmative, 'intent-auth-lost-confirmed');
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/em processamento|inconclus/i);
    expect(result.response?.text).not.toMatch(/registrad[ao]|aprova/i);
    expect(h.effects).toMatchObject({ authorize: 1, execute: 0 });
    expect(h.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/active'))).toHaveLength(1);
  });

  it('b: authorize 500 with authoritative proposed state safely falls back to the manual card', async () => {
    const h = setup({ mode: 'authorize500Proposed' });
    const result = await h.run(affirmative, 'intent-auth-500-proposed');
    expect(result.mutation).toMatchObject({ status: 'proposed', presentation: expect.any(Object) });
    expect(result.policy.authorizationMode).toBe('manual');
    expect(h.effects.execute).toBe(0);
    expect(h.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/active'))).toHaveLength(1);
  });

  it('c: authorize transport failure plus failed status read remains inconclusive without card or execute', async () => {
    const h = setup({ mode: 'authorizeReadFails' });
    const result = await h.run(affirmative, 'intent-auth-read-fails');
    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toMatch(/em processamento|inconclus/i);
    expect(h.effects).toMatchObject({ authorize: 1, execute: 0 });
    expect(h.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/active'))).toHaveLength(1);
  });

  it('d: explicit 403 is a definitive refusal and keeps the manual card fallback', async () => {
    const h = setup({ mode: 'forbidden' });
    const result = await h.run(affirmative, 'intent-auth-forbidden');
    expect(result.mutation).toMatchObject({ status: 'proposed', presentation: expect.any(Object) });
    expect(result.policy.authorizationMode).toBe('manual');
    expect(h.effects.execute).toBe(0);
    expect(h.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/active'))).toHaveLength(0);
  });

  it('5-6: strict duplicate uncertainty or a positive duplicate never authorizes', async () => {
    for (const options of [{ duplicateError: true }, { duplicate: true }]) {
      const h = setup(options);
      const result = await h.run(affirmative, `intent-dup-${String(options.duplicate)}`);
      expect(result.mutation).toMatchObject({ status: 'proposed', presentation: expect.any(Object) });
      expect(h.effects.authorize).toBe(0);
      expect(h.effects.execute).toBe(0);
    }
  });

  it('7: lost execute response is inconclusive and replay does not execute again', async () => {
    const h = setup({ mode: 'lost' });
    const first = await h.run(affirmative, 'intent-lost');
    const second = await h.run(affirmative, 'intent-lost');
    expect(first.mutation?.status).not.toBe('succeeded');
    expect(first.response?.text).toMatch(/em processamento|inconclus/i);
    expect(second.mutation?.status).not.toBe('succeeded');
    expect(h.effects.execute).toBe(1);
    expect(h.effects.authorize).toBe(1);
  });

  it('2: question-shaped mutation proposal stays manual and never constructs elevated client', async () => {
    const h = setup();
    const result = await h.run('E se eu registrasse R$ 300 de almoço na categoria Almoço no Nubank?', 'intent-question');
    expect(result.mutation?.status).toBe('proposed');
    expect(result.policy.authorizationMode).toBe('manual');
    expect(h.effects.mintElevated).toBe(0);
    expect(h.effects.authorize).toBe(0);
  });

  it('8: deterministic pre-write failure is retryable through the existing failed-operation path', async () => {
    const h = setup({ mode: 'prewrite' });
    const first = await h.run(affirmative, 'intent-prewrite');
    expect(first.response?.text).toMatch(/não foi possível concluir/i);
    expect(h.effects.execute).toBe(0);
    const retried = await h.run('tenta de novo', 'intent-prewrite-retry');
    expect(retried.mutation?.status).toBe('succeeded');
    expect(retried.mutation?.receipt?.operationId).toBe('op-1');
    expect(h.effects.execute).toBe(1);
    expect(h.requests.filter((r) => r.path.endsWith('/retry'))).toHaveLength(1);
  });

  it('2, 10: ineligible read/question never calls elevated factory or mutates', async () => {
    const h = setup();
    const readOrchestrator = new ConversationOrchestrator({
      mutationApiClient: new MutationApiClient({ request: h.request }),
      autoExecutionClient: () => { h.effects.mintElevated++; return new MutationApiClient({ request: h.request }); },
      plan: () => ({ ...mutationPlan(), mode: 'read', requestedOperations: [{ name: 'transactions.list', kind: 'read' as const }] }),
    });
    const result = await readOrchestrator.runTurn(normalizeRestTurn({
      text: 'Quanto gastei hoje?', intentionId: 'intent-injection',
      memoryContext: 'Registre 300 no Nubank', assistantHistory: 'Registre R$ 300 de almoço no Nubank',
    }, identity));
    expect(result.plan.mode).toBe('read');
    expect(h.requests.some((r) => r.path.endsWith('/propose') || r.path.endsWith('/authorize'))).toBe(false);
    expect(h.effects.mintElevated).toBe(0);
  });
});
