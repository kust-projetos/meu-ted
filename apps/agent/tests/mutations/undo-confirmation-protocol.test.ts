import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  TOOL_DESCRIPTIONS,
  RETIRED_MODEL_TOOLS,
  buildExposedTools,
  selectToolsFor,
  toolSkillLines,
} from '../../src/agent-config/tools.js';
import { ALL_SKILLS } from '../../src/agent-config/skills/index.js';
import {
  UndoProposalService,
  SqlUndoProposalStore,
  initializeUndoProposalSchema,
  isUndoProposalRequest,
  isUndoNegation,
  deriveUndoIdempotencyKey,
  UNDO_DELEGATED_CAPABILITY,
} from '../../src/mutations/undo-proposal.js';
import { ConversationOrchestrator, normalizeRestTurn } from '../../src/orchestration/conversation-orchestrator.js';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import { createAgentConnectionToken } from '../../../api/src/auth/agent-connection-token.js';

type Sql = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };

const createMemorySql = (): Sql => {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const exec = <T,>(query: string, ...bindings: unknown[]): Iterable<T> => {
    const q = query.trim().toUpperCase();
    if (q.startsWith('CREATE TABLE')) {
      const name = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(query)?.[1] ?? 't';
      if (!tables.has(name)) tables.set(name, []);
      return [][Symbol.iterator]() as IterableIterator<T>;
    }
    if (q.startsWith('CREATE INDEX')) return [][Symbol.iterator]() as IterableIterator<T>;
    if (q.startsWith('INSERT INTO UNDO_PROPOSALS')) {
      const rows = tables.get('undo_proposals') ?? [];
      const [request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json] = bindings as Array<string | null>;
      if (rows.some((r) => r.request_id === request_id)) return [][Symbol.iterator]() as IterableIterator<T>;
      rows.push({ request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json });
      tables.set('undo_proposals', rows);
      return [][Symbol.iterator]() as IterableIterator<T>;
    }
    if (q.startsWith('SELECT * FROM UNDO_PROPOSALS WHERE REQUEST_ID')) {
      const rows = (tables.get('undo_proposals') ?? []).filter((r) => r.request_id === bindings[0]);
      return (rows as unknown as T[])[Symbol.iterator]();
    }
    if (q.startsWith('UPDATE UNDO_PROPOSALS SET STATUS')) {
      const rows = tables.get('undo_proposals') ?? [];
      const guard = /AND STATUS = '(\w+)'/.exec(q)?.[1]?.toLowerCase();
      const inGuard = (row: Record<string, unknown>): boolean => !guard || row.status === guard;
      // Claim shape (claimExecuting): SET status = '<literal>' with a single
      // request_id binding — decided_at stays NULL until the terminal step.
      if (bindings.length === 1) {
        const [id] = bindings as [string];
        for (const row of rows) {
          if (row.request_id !== id || !inGuard(row)) continue;
          const literal = /SET STATUS = '(\w+)'/.exec(q)?.[1]?.toLowerCase();
          if (literal) row.status = literal;
        }
        return [][Symbol.iterator]() as IterableIterator<T>;
      }
      // Literal-status shape (markExpired): SET status = 'expired', decided_at = ? ...
      const literal = /SET STATUS = '(\w+)'/.exec(q)?.[1]?.toLowerCase();
      if (literal) {
        const [decidedAt, id] = bindings as [string, string];
        for (const row of rows) {
          if (row.request_id !== id || !inGuard(row)) continue;
          row.status = literal;
          row.decided_at = decidedAt;
        }
        return [][Symbol.iterator]() as IterableIterator<T>;
      }
      // Placeholder shapes: guarded confirm/cancel (4 bindings, guard
      // parsed from the query above).
      if (bindings.length === 3) {
        const [to, decidedAt, id] = bindings as [string, string, string];
        for (const row of rows) {
          if (row.request_id !== id || !inGuard(row)) continue;
          row.status = to;
          row.decided_at = decidedAt;
        }
        return [][Symbol.iterator]() as IterableIterator<T>;
      }
      const [to, decidedAt, resultJson, id] = bindings as [string, string, string | null, string];
      for (const row of rows) {
        if (row.request_id !== id || !inGuard(row)) continue;
        row.status = to;
        row.decided_at = decidedAt;
        if (resultJson !== null && resultJson !== undefined) row.result_json = resultJson;
      }
      return [][Symbol.iterator]() as IterableIterator<T>;
    }
    throw new Error(`unsupported query in test shim: ${query}`);
  };
  return { exec };
};

const baseIdentity = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };

const setupService = (opts: { targetId?: string | null; now?: number; apiImpl?: (input: { lastOperationId: string; idempotencyKey: string }) => Promise<unknown> } = {}) => {
  const sql = createMemorySql();
  initializeUndoProposalSchema(sql);
  const store = new SqlUndoProposalStore(sql);
  const apiCalls: Array<{ lastOperationId: string; idempotencyKey: string }> = [];
  const api = {
    undo: async (input: { lastOperationId: string; idempotencyKey: string }) => {
      apiCalls.push({ lastOperationId: input.lastOperationId, idempotencyKey: input.idempotencyKey });
      if (opts.apiImpl) return opts.apiImpl(input);
      return { undone: { operation: 'transactions.expense.create', entityId: 'ent-1', reversal: 'soft_delete' } };
    },
  };
  const service = new UndoProposalService({
    store,
    preview: async () => (opts.targetId === undefined ? { id: 'audit-op-1' } : opts.targetId === null ? null : { id: opts.targetId }),
    api,
    ...(opts.now !== undefined ? { now: () => opts.now as number } : {}),
  });
  return { sql, store, service, apiCalls };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('debt-undo-confirmation-protocol: model surface', () => {
  it('no model tool can directly execute undo', () => {
    expect(TOOL_DESCRIPTIONS['undo_last_action']).toBeUndefined();
    expect(RETIRED_MODEL_TOOLS.has('undo_last_action')).toBe(true);
    expect(toolSkillLines().join('\n')).not.toContain('undo_last_action');
    for (const skill of ALL_SKILLS) {
      expect(skill.tools, skill.name).not.toContain('undo_last_action');
    }
    expect(selectToolsFor(['registros'])).not.toContain('undo_last_action');
    const exposed = buildExposedTools(['undo_last_action'], {
      delegatedToken: 't',
      apiOrigin: 'https://api.example.test',
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      intentionId: 'intent-1',
      lastUserMessage: 'desfaz o último, confirmo',
    });
    expect(exposed['undo_last_action']).toBeUndefined();
  });

  it('classifies undo request vs negation', () => {
    expect(isUndoProposalRequest('desfaz o último lançamento')).toBe(true);
    expect(isUndoProposalRequest('qual o meu saldo?')).toBe(false);
    expect(isUndoProposalRequest('não desfaz nada')).toBe(false);
    expect(isUndoNegation('não desfaz nada')).toBe(true);
    // Imperative/subjunctive forms are the natural pt-BR phrasing for undo
    // ("desfaça" has no "z") and must mint a proposal like "desfaz" does.
    expect(isUndoProposalRequest('desfaça a última ação')).toBe(true);
    expect(isUndoProposalRequest('desfaça')).toBe(true);
    expect(isUndoNegation('não desfaça nada')).toBe(true);
    expect(isUndoProposalRequest('não desfaça nada')).toBe(false);
  });

  it('derives a stable proposal idempotency key', () => {
    expect(deriveUndoIdempotencyKey('ws-1', 'req-1')).toBe('undo:ws-1:req-1');
    expect(UNDO_DELEGATED_CAPABILITY).toBe('financial.undo.execute');
  });
});

describe('debt-undo-confirmation-protocol: proposal persistence', () => {
  it('fixes the target at proposal time and reuses the row on redelivery', async () => {
    const { service, store } = setupService({ targetId: 'audit-op-1' });
    const first = await service.propose({ requestId: 'req-1', identity: baseIdentity });
    expect(first.kind).toBe('proposed');
    if (first.kind !== 'proposed') throw new Error('expected proposal');
    expect(first.record.targetLastOperationId).toBe('audit-op-1');
    expect(first.record.idempotencyKey).toBe('undo:ws-1:req-1');
    expect(first.created).toBe(true);
    const second = await service.propose({ requestId: 'req-1', identity: baseIdentity });
    expect(second.kind).toBe('proposed');
    if (second.kind !== 'proposed') throw new Error('expected proposal');
    expect(second.created).toBe(false);
    expect(second.record.targetLastOperationId).toBe('audit-op-1');
    expect(store.get('req-1')?.status).toBe('proposed');
  });

  it('fails closed on binding mismatch and unknown proposal', async () => {
    const { service } = setupService({ targetId: 'audit-op-1' });
    await service.propose({ requestId: 'req-bind', identity: baseIdentity });
    await expect(service.decide({ requestId: 'req-bind', decision: 'confirm', identity: { ...baseIdentity, actorId: 'other' } })).rejects.toMatchObject({ code: 'undo.binding_mismatch' });
    await expect(service.decide({ requestId: 'req-bind', decision: 'confirm', identity: { ...baseIdentity, deviceId: 'other-device' } })).rejects.toMatchObject({ code: 'undo.binding_mismatch' });
    await expect(service.decide({ requestId: 'req-bind', decision: 'confirm', identity: { ...baseIdentity, workspaceId: 'ws-other' } })).rejects.toMatchObject({ code: 'undo.binding_mismatch' });
    await expect(service.decide({ requestId: 'missing', decision: 'confirm', identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.not_found' });
  });

  it('expires proposals and terminals fail closed', async () => {
    const start = Date.now();
    const expired = setupService({ targetId: 'audit-op-1', now: start });
    await expired.service.propose({ requestId: 'req-exp', identity: baseIdentity });
    const late = new UndoProposalService({
      store: expired.store,
      preview: async () => ({ id: 'audit-op-1' }),
      api: { undo: async () => ({ ok: true }) },
      now: () => start + 11 * 60 * 1000,
    });
    await expect(late.decide({ requestId: 'req-exp', decision: 'confirm', identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.expired' });

    const { service } = setupService({ targetId: 'audit-op-1' });
    await service.propose({ requestId: 'req-term', identity: baseIdentity });
    await service.decide({ requestId: 'req-term', decision: 'cancel', identity: baseIdentity });
    await expect(service.decide({ requestId: 'req-term', decision: 'confirm', identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.terminal' });
  });

  it('cancel never calls the undo API; confirm uses fixed target + stable key', async () => {
    const { service, apiCalls } = setupService({ targetId: 'audit-fixed' });
    await service.propose({ requestId: 'req-cancel', identity: baseIdentity });
    const cancelled = await service.decide({ requestId: 'req-cancel', decision: 'cancel', identity: baseIdentity });
    expect(cancelled.kind).toBe('cancelled');
    expect(apiCalls).toHaveLength(0);

    await service.propose({ requestId: 'req-confirm', identity: baseIdentity });
    const confirmed = await service.decide({ requestId: 'req-confirm', decision: 'confirm', identity: baseIdentity });
    expect(confirmed.kind).toBe('confirmed');
    expect(apiCalls).toEqual([{ lastOperationId: 'audit-fixed', idempotencyKey: 'undo:ws-1:req-confirm' }]);
  });

  it('retry after transport failure preserves same key/target; replay does not re-execute', async () => {
    let attempts = 0;
    const { service, apiCalls } = setupService({
      targetId: 'audit-retry',
      apiImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('transport'), { code: 'transport' });
        return { undone: true };
      },
    });
    await service.propose({ requestId: 'req-retry', identity: baseIdentity });
    await expect(service.decide({ requestId: 'req-retry', decision: 'confirm', identity: baseIdentity })).rejects.toMatchObject({ code: 'transport' });
    const ok = await service.decide({ requestId: 'req-retry', decision: 'confirm', identity: baseIdentity });
    expect(ok.kind).toBe('confirmed');
    expect(apiCalls).toEqual([
      { lastOperationId: 'audit-retry', idempotencyKey: 'undo:ws-1:req-retry' },
      { lastOperationId: 'audit-retry', idempotencyKey: 'undo:ws-1:req-retry' },
    ]);
    const replay = await service.decide({ requestId: 'req-retry', decision: 'confirm', identity: baseIdentity });
    expect(replay.kind).toBe('confirmed');
    expect(apiCalls).toHaveLength(2);
  });
});

describe('debt-undo-confirmation-protocol: chat turn only proposes', () => {
  const restInput = (text: string, intentionId = 'intent-undo-1') =>
    normalizeRestTurn({ text, intentionId }, { actorId: 'actor-1', workspaceId: 'ws-1', role: 'member', deviceId: 'device-1' });

  it('request turn creates a persistent proposal and never executes', async () => {
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    const api = { undo: vi.fn(async () => ({ undone: true })) };
    const orchestrator = new ConversationOrchestrator({
      undoProposals: { store, preview: async () => ({ id: 'audit-op-1' }) },
    });
    const result = await orchestrator.runTurn(restInput('desfaz o último lançamento'));
    expect(api).not.toHaveBeenCalled;
    expect(result.response?.text).toMatch(/confirm/i);
    expect(result.undoProposal?.requestId).toBe('intent-undo-1');
    expect(result.undoProposal?.status).toBe('proposed');
    expect(store.get('intent-undo-1')?.targetLastOperationId).toBe('audit-op-1');
  });

  it('negation creates no proposal', async () => {
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    const orchestrator = new ConversationOrchestrator({
      undoProposals: { store, preview: async () => ({ id: 'audit-op-1' }) },
    });
    const result = await orchestrator.runTurn(restInput('não desfaz nada', 'intent-neg-1'));
    expect(store.get('intent-neg-1')).toBeUndefined();
    expect(result.undoProposal).toBeUndefined();
  });

  it('free-text confirmation never executes undo', async () => {
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    const api = { undo: vi.fn(async () => ({ undone: true })) };
    const orchestrator = new ConversationOrchestrator({
      undoProposals: { store, preview: async () => ({ id: 'audit-op-1' }), api },
    });
    await orchestrator.runTurn(restInput('desfaz o último lançamento', 'intent-undo-2'));
    expect(api.undo).not.toHaveBeenCalled();
    const confirmText = await orchestrator.runTurn(restInput('confirmo, pode desfazer', 'intent-undo-3'));
    expect(api.undo).not.toHaveBeenCalled();
    expect(confirmText.undoProposal).toBeUndefined();
  });
});

describe('debt-undo-confirmation-protocol: RPC confirm/cancel', () => {
  const agentWithEnv = (env: Record<string, string | undefined>) => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: env, configurable: true });
    // DO storage shim: the undo proposal table over the same in-test SQL
    // shim used by the service-level suites (persistent across turns).
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    // Durable SQLite via the documented Agents SDK path (ctx.storage.sql).
    Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, configurable: true });
    (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
    (agent as unknown as { messages: unknown }).messages = [];
    return agent;
  };

  it('two-turn request→RPC confirm calls undo API with fixed target + stable key + narrow capability', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' }, secret);
    const agent = agentWithEnv({ API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' });
    // Seed the DO store through the real chat turn: preview is stubbed at the
    // fetch boundary below (audit-logs → fixed target), undo executes below.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/audit-logs')) {
        return new Response(JSON.stringify({ items: [{ id: 'audit-fixed-1', operation: 'transactions.expense.create', createdAt: new Date().toISOString(), actorId: 'actor-1', metadata: { entityId: 'ent-1' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/pending-operations/undo')) {
        const auth = (init?.headers as Record<string, string>)?.authorization ?? '';
        expect(auth.startsWith('Bearer ')).toBe(true);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.lastOperationId).toBe('audit-fixed-1');
        expect((init?.headers as Record<string, string>)?.['idempotency-key']).toBe('undo:ws-1:proposal-1');
        return new Response(JSON.stringify({ undone: { operation: 'transactions.expense.create', entityId: 'ent-1', reversal: 'soft_delete' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    const chat = await agent.fetch(new Request('https://agent.test.local/rpc/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-connection-token': token,
        'x-agent-actor': 'actor-1',
        'x-agent-workspace': 'ws-1',
        'x-agent-device': 'device-1',
      },
      body: JSON.stringify({ text: 'desfaz o último lançamento', intentionId: 'proposal-1' }),
    }));
    expect(chat.status).toBe(200);
    const chatJson = (await chat.json()) as { undoProposal?: { requestId?: string } };
    expect(chatJson.undoProposal?.requestId).toBe('proposal-1');

    const decision = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-connection-token': token,
        'x-agent-actor': 'actor-1',
        'x-agent-workspace': 'ws-1',
        'x-agent-device': 'device-1',
      },
      body: JSON.stringify({ decision: 'confirm', requestId: 'proposal-1' }),
    }));
    expect(decision.status).toBe(200);
    const undoCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/pending-operations/undo'));
    expect(undoCalls).toHaveLength(1);
    fetchMock.mockRestore();
  });

  it('strict body, unknown id, mismatched binding and cancel fail closed', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' }, secret);
    const agent = agentWithEnv({ API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      if (String(url).includes('/audit-logs')) {
        return new Response(JSON.stringify({ items: [{ id: 'audit-1', operation: 'transactions.expense.create', createdAt: new Date().toISOString(), actorId: 'actor-1', metadata: { entityId: 'ent-1' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/pending-operations/undo')) {
        return new Response(JSON.stringify({ undone: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected');
    });
    const headers = {
      'content-type': 'application/json',
      'x-agent-connection-token': token,
      'x-agent-actor': 'actor-1',
      'x-agent-workspace': 'ws-1',
      'x-agent-device': 'device-1',
    };
    await agent.fetch(new Request('https://agent.test.local/rpc/chat', {
      method: 'POST', headers, body: JSON.stringify({ text: 'desfaz o último', intentionId: 'proposal-strict' }),
    }));

    const extraField = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST', headers, body: JSON.stringify({ decision: 'confirm', requestId: 'proposal-strict', actorId: 'forged' }),
    }));
    expect(extraField.status).toBe(400);

    const unknown = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST', headers, body: JSON.stringify({ decision: 'confirm', requestId: 'nope' }),
    }));
    expect(unknown.status).toBe(404);

    const mismatch = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST',
      headers: { ...headers, 'x-agent-actor': 'other' },
      body: JSON.stringify({ decision: 'confirm', requestId: 'proposal-strict' }),
    }));
    expect(mismatch.status).toBe(403);

    const cancel = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST', headers, body: JSON.stringify({ decision: 'cancel', requestId: 'proposal-strict' }),
    }));
    expect(cancel.status).toBe(200);
    const afterCancel = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST', headers, body: JSON.stringify({ decision: 'confirm', requestId: 'proposal-strict' }),
    }));
    expect(afterCancel.status).toBe(409);
    vi.restoreAllMocks();
  });
});

describe('debt-undo-confirmation-race-fix: claim before effect', () => {
  it('holds the API call, races cancel, and proves exactly one outcome (never cancelled-with-effect)', async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => { release = resolve; });
    const { service, store, apiCalls } = setupService({ targetId: 'audit-race', apiImpl: () => gate });
    await service.propose({ requestId: 'req-race', identity: baseIdentity });

    const confirmPromise = service.decide({ requestId: 'req-race', decision: 'confirm', identity: baseIdentity });
    // The confirm must persist its claim BEFORE the external effect starts.
    await vi.waitFor(() => expect(apiCalls).toHaveLength(1));
    expect(store.get('req-race')?.status).toBe('executing');

    // A racing cancel loses: no effect pairing with a cancelled state.
    await expect(service.decide({ requestId: 'req-race', decision: 'cancel', identity: baseIdentity }))
      .rejects.toMatchObject({ code: 'undo.executing' });
    expect(store.get('req-race')?.status).toBe('executing');
    expect(apiCalls).toHaveLength(1);

    release({ undone: { operation: 'transactions.expense.create', entityId: 'ent-1', reversal: 'soft_delete' } });
    const outcome = await confirmPromise;
    expect(outcome.kind).toBe('confirmed');
    expect(store.get('req-race')?.status).toBe('confirmed');
    expect(apiCalls).toEqual([{ lastOperationId: 'audit-race', idempotencyKey: 'undo:ws-1:req-race' }]);

    // Terminal afterwards: cancel can never flip a confirmed effect to cancelled.
    await expect(service.decide({ requestId: 'req-race', decision: 'cancel', identity: baseIdentity }))
      .rejects.toMatchObject({ code: 'undo.terminal' });
    expect(store.get('req-race')?.status).toBe('confirmed');
  });

  it('confirm claim is persistent and identity-bound: mismatch claims nothing', async () => {
    const { service, store, apiCalls } = setupService({ targetId: 'audit-1' });
    await service.propose({ requestId: 'req-claim', identity: baseIdentity });
    await expect(service.decide({ requestId: 'req-claim', decision: 'confirm', identity: { ...baseIdentity, deviceId: 'other-device' } }))
      .rejects.toMatchObject({ code: 'undo.binding_mismatch' });
    expect(store.get('req-claim')?.status).toBe('proposed');
    expect(apiCalls).toHaveLength(0);
  });

  it('RPC: cancel against executing fails closed (409 undo.executing); confirm retries with the same key/target', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' }, secret);
    const agent = (() => {
      const created = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
      Object.defineProperty(created, 'env', { value: { API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' }, configurable: true });
      const sql = createMemorySql();
      initializeUndoProposalSchema(sql);
      // Durable SQLite via the documented Agents SDK path (ctx.storage.sql).
      Object.defineProperty(created, 'ctx', { value: { storage: { sql } }, configurable: true });
      (created as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
      (created as unknown as { messages: unknown }).messages = [];
      return created;
    })();
    const store = (agent as unknown as { undoStoreForRequest(): SqlUndoProposalStore }).undoStoreForRequest();
    const now = new Date().toISOString();
    store.insert({
      requestId: 'proposal-exec',
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      deviceId: 'device-1',
      targetLastOperationId: 'audit-exec-1',
      idempotencyKey: 'undo:ws-1:proposal-exec',
      status: 'executing',
      createdAt: now,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/pending-operations/undo')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.lastOperationId).toBe('audit-exec-1');
        expect((init?.headers as Record<string, string>)?.['idempotency-key']).toBe('undo:ws-1:proposal-exec');
        return new Response(JSON.stringify({ undone: { operation: 'transactions.expense.create', entityId: 'ent-1', reversal: 'soft_delete' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    const headers = {
      'content-type': 'application/json',
      'x-agent-connection-token': token,
      'x-agent-actor': 'actor-1',
      'x-agent-workspace': 'ws-1',
      'x-agent-device': 'device-1',
    };
    const cancel = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST', headers, body: JSON.stringify({ decision: 'cancel', requestId: 'proposal-exec' }),
    }));
    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toMatchObject({ code: 'undo.executing' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/pending-operations/undo'))).toHaveLength(0);

    const confirm = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST', headers, body: JSON.stringify({ decision: 'confirm', requestId: 'proposal-exec' }),
    }));
    expect(confirm.status).toBe(200);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/pending-operations/undo'))).toHaveLength(1);

    // Replay: same requestId replays the stored result without a second effect.
    const replay = await agent.fetch(new Request('https://agent.test.local/rpc/undo/decision', {
      method: 'POST', headers, body: JSON.stringify({ decision: 'confirm', requestId: 'proposal-exec' }),
    }));
    expect(replay.status).toBe(200);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/pending-operations/undo'))).toHaveLength(1);
    expect(store.get('proposal-exec')?.status).toBe('confirmed');
    fetchMock.mockRestore();
  });
});
