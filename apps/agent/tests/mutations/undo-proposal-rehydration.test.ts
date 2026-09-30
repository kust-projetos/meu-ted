import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  initializeUndoProposalSchema,
  SqlUndoProposalStore,
  UndoProposalService,
  type UndoProposalRecord,
} from '../../src/mutations/undo-proposal.js';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import worker from '../../src/worker.js';
import { createAgentConnectionToken } from '../../../api/src/auth/agent-connection-token.js';

type Sql = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };

/** Same in-memory shim as the protocol suite, plus the bound-list SELECT. */
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
    if (q.startsWith('SELECT * FROM UNDO_PROPOSALS WHERE WORKSPACE_ID')) {
      const [workspaceId, actorId, deviceId] = bindings as [string, string, string];
      const rows = (tables.get('undo_proposals') ?? []).filter(
        (r) => r.workspace_id === workspaceId && r.actor_id === actorId && r.device_id === deviceId,
      );
      return (rows as unknown as T[])[Symbol.iterator]();
    }
    if (q.startsWith('UPDATE UNDO_PROPOSALS SET STATUS')) {
      const rows = tables.get('undo_proposals') ?? [];
      const guard = /AND STATUS = '(\w+)'/.exec(q)?.[1]?.toLowerCase();
      const inGuard = (row: Record<string, unknown>): boolean => !guard || row.status === guard;
      if (bindings.length === 1) {
        const [id] = bindings as [string];
        for (const row of rows) {
          if (row.request_id !== id || !inGuard(row)) continue;
          const literal = /SET STATUS = '(\w+)'/.exec(q)?.[1]?.toLowerCase();
          if (literal) row.status = literal;
        }
        return [][Symbol.iterator]() as IterableIterator<T>;
      }
      const literal = /SET STATUS = '(\w+)'/.exec(q)?.[1]?.toLowerCase();
      if (literal && bindings.length === 2) {
        const [decidedAt, id] = bindings as [string, string];
        for (const row of rows) {
          if (row.request_id !== id || !inGuard(row)) continue;
          row.status = literal;
          row.decided_at = decidedAt;
        }
        return [][Symbol.iterator]() as IterableIterator<T>;
      }
      throw new Error(`unsupported update shape: ${query}`);
    }
    throw new Error(`unsupported query in test shim: ${query}`);
  };
  return { exec };
};

const baseIdentity = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };
const NOW = Date.parse('2026-09-19T12:00:00.000Z');

const seed = (
  store: SqlUndoProposalStore,
  overrides: Partial<UndoProposalRecord> & { requestId: string },
): void => {
  store.insert(
    Object.freeze({
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      deviceId: 'device-1',
      targetLastOperationId: 'audit-op-1',
      idempotencyKey: `undo:ws-1:${overrides.requestId}`,
      status: 'proposed',
      createdAt: new Date(NOW - 60_000).toISOString(),
      expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
      ...overrides,
    }) as UndoProposalRecord,
  );
};

const setupService = () => {
  const sql = createMemorySql();
  initializeUndoProposalSchema(sql);
  const store = new SqlUndoProposalStore(sql);
  const api = { undo: vi.fn(async () => ({ undone: true })) };
  const service = new UndoProposalService({
    store,
    preview: async () => ({ id: 'audit-op-1' }),
    api,
    now: () => NOW,
  });
  return { store, service, api };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('debt-undo-proposal-rehydration: service listActive', () => {
  it('reload lists identity-bound active summaries with no target/key fields', () => {
    const { store, service, api } = setupService();
    seed(store, { requestId: 'req-reload-1' });
    seed(store, { requestId: 'req-reload-2', status: 'executing' });

    const items = service.listActive(baseIdentity);

    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        { requestId: 'req-reload-1', status: 'proposed', expiresAt: expect.any(String) },
        { requestId: 'req-reload-2', status: 'executing', expiresAt: expect.any(String) },
      ]),
    );
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['expiresAt', 'requestId', 'status']);
    }
    // Rehydration is read-only: listing never executes undo.
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('a different actor, device or workspace lists nothing', () => {
    const { store, service } = setupService();
    seed(store, { requestId: 'req-bound' });

    expect(service.listActive({ ...baseIdentity, actorId: 'other' })).toEqual([]);
    expect(service.listActive({ ...baseIdentity, deviceId: 'other-device' })).toEqual([]);
    expect(service.listActive({ ...baseIdentity, workspaceId: 'ws-other' })).toEqual([]);
    // The row itself is untouched by foreign listings.
    expect(store.get('req-bound')?.status).toBe('proposed');
  });

  it('expired proposals are omitted and marked expired; terminals are omitted', () => {
    const { store, service } = setupService();
    seed(store, { requestId: 'req-stale', expiresAt: new Date(NOW - 1_000).toISOString() });
    seed(store, { requestId: 'req-done', status: 'confirmed' });
    seed(store, { requestId: 'req-cancelled', status: 'cancelled' });
    seed(store, { requestId: 'req-live' });

    const items = service.listActive(baseIdentity);

    expect(items.map((item) => item.requestId)).toEqual(['req-live']);
    expect(store.get('req-stale')?.status).toBe('expired');
    expect(store.get('req-done')?.status).toBe('confirmed');
  });
});

describe('debt-undo-proposal-rehydration: RPC GET /rpc/undo/active', () => {
  it('returns bound summaries, never targets/keys, and never decides', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken(
      { sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' },
      secret,
    );
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    // RPC path uses the real clock (no `now` injection in production): seed
    // relative to Date.now() so the rows are live when listed.
    const liveExpiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
    seed(store, { requestId: 'req-rpc-1', expiresAt: liveExpiresAt });
    seed(store, { requestId: 'req-rpc-2', status: 'executing', expiresAt: liveExpiresAt });
    seed(store, { requestId: 'req-foreign', workspaceId: 'ws-other', actorId: 'actor-1', deviceId: 'device-1', expiresAt: liveExpiresAt });
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { AGENT_CONNECTION_TOKEN_SECRET: secret }, configurable: true });
    // Swap the DO storage to the seeded shim via the documented Agents SDK
    // path (ctx.storage.sql). No state.storage is provided: production has
    // no such property (Agent `state` is app data), so a ctx-only agent is
    // the realistic runtime shape.
    Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, configurable: true });
    (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
    (agent as unknown as { messages: unknown }).messages = [];

    const headers = {
      'x-agent-connection-token': token,
      'x-agent-actor': 'actor-1',
      'x-agent-workspace': 'ws-1',
      'x-agent-device': 'device-1',
    };
    const response = await agent.fetch(
      new Request('https://agent.test.local/rpc/undo/active', { method: 'GET', headers }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(json.total).toBe(2);
    expect(json.items.map((item) => item.requestId).sort()).toEqual(['req-rpc-1', 'req-rpc-2']);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('audit-op-1');
    expect(serialized).not.toContain('undo:ws-1');
    expect(serialized).not.toContain('targetLastOperationId');
    expect(serialized).not.toContain('idempotencyKey');
    // Read-only: statuses are unchanged, no decision happened.
    expect(store.get('req-rpc-1')?.status).toBe('proposed');
    expect(store.get('req-rpc-2')?.status).toBe('executing');
  });

  it('requires identity and isolates workspaces', async () => {
    const secret = 'connection-secret';
    // Deviceless token: the connection-binding check passes without a
    // device, so the handler's own 401 on missing identity is exercised.
    const devicelessToken = await createAgentConnectionToken(
      { sub: 'actor-1', workspace: 'ws-1', role: 'member' },
      secret,
    );
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { AGENT_CONNECTION_TOKEN_SECRET: secret }, configurable: true });
    // Realistic runtime shape: durable SQLite via ctx.storage.sql.
    Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, configurable: true });
    (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
    (agent as unknown as { messages: unknown }).messages = [];

    const noDevice = await agent.fetch(
      new Request('https://agent.test.local/rpc/undo/active', {
        method: 'GET',
        headers: {
          'x-agent-connection-token': devicelessToken,
          'x-agent-actor': 'actor-1',
          'x-agent-workspace': 'ws-1',
        },
      }),
    );
    expect(noDevice.status).toBe(401);

    // A caller bound to another actor cannot see the proposal.
    const otherToken = await createAgentConnectionToken(
      { sub: 'other', workspace: 'ws-1', role: 'member', deviceId: 'device-1' },
      secret,
    );
    const foreign = await agent.fetch(
      new Request('https://agent.test.local/rpc/undo/active', {
        method: 'GET',
        headers: {
          'x-agent-connection-token': otherToken,
          'x-agent-actor': 'other',
          'x-agent-workspace': 'ws-1',
          'x-agent-device': 'device-1',
        },
      }),
    );
    expect(foreign.status).toBe(200);
    expect(((await foreign.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('fails closed with 503 when ctx SQLite is unavailable (no state.storage fallback)', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken(
      { sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' },
      secret,
    );
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { AGENT_CONNECTION_TOKEN_SECRET: secret }, configurable: true });
    // No ctx at all: the handler must fail closed, never read app `state`.
    (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
    (agent as unknown as { messages: unknown }).messages = [];

    const headers = {
      'x-agent-connection-token': token,
      'x-agent-actor': 'actor-1',
      'x-agent-workspace': 'ws-1',
      'x-agent-device': 'device-1',
    };
    const response = await agent.fetch(
      new Request('https://agent.test.local/rpc/undo/active', { method: 'GET', headers }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'agent.persistence_unavailable' });
  });

  it('draft and undo stores resolve from ctx.storage.sql (identical SDK accessor)', async () => {
    // Accessor-binding proof only (schema semantics are covered by the
    // store-level suites): a permissive stub is enough for construction.
    const sql = { exec: () => [][Symbol.iterator]() };
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: {}, configurable: true });
    Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, configurable: true });
    type AgentStores = {
      undoStoreForRequest(): SqlUndoProposalStore | undefined;
      draftStoreForRequest(): unknown;
    };
    const stores = agent as unknown as AgentStores;
    expect(stores.undoStoreForRequest()).toBeInstanceOf(SqlUndoProposalStore);
    expect(stores.draftStoreForRequest()).not.toBeUndefined();

    const bare = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(bare, 'env', { value: {}, configurable: true });
    const bareStores = bare as unknown as AgentStores;
    expect(bareStores.undoStoreForRequest()).toBeUndefined();
    expect(bareStores.draftStoreForRequest()).toBeUndefined();
  });

  it('worker gateway forwards GET /rpc/undo/active with stamped identity', async () => {
    const WS = '11111111-1111-4111-8111-111111111111';
    const ACTOR = 'user-real';
    const DEVICE = 'device-binding-1';
    const CONNECTION_SECRET = 'test-connection-secret-32-chars-minimum!!';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/internal/workspace-alias/')) {
        return new Response(JSON.stringify({ canonicalHouseholdId: WS }), { status: 200 });
      }
      if (u.includes('/internal/agent/consume-token')) {
        return new Response(JSON.stringify({ ok: true, consumed: true }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const financeFetch = vi.fn<(request: Request) => Promise<Response>>(async () =>
        Response.json({ items: [], total: 0 }, { status: 200 }),
      );
      const env = {
        API_ORIGIN: 'https://api.example.test',
        AGENT_CONNECTION_TOKEN_SECRET: CONNECTION_SECRET,
        AGENT_AUTH_SERVICE_TOKEN: 'test-service-token-32-chars-minimum!!',
        FINANCE_CHAT_AGENT: {
          idFromName: vi.fn((n: string) => ({ n })),
          get: vi.fn(() => ({ fetch: financeFetch })),
        },
      } as unknown as Parameters<typeof worker.fetch>[1];
      const token = await createAgentConnectionToken(
        { sub: ACTOR, workspace: WS, role: 'owner', deviceId: DEVICE },
        CONNECTION_SECRET,
        Date.now(),
      );
      const res = await worker.fetch(
        new Request(`https://worker.test/agents/finance-chat-agent/${WS}/rpc/undo/active`, {
          method: 'GET',
          headers: { 'x-agent-connection-token': token },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(financeFetch).toHaveBeenCalledOnce();
      const forwarded = financeFetch.mock.calls[0]![0];
      expect(new URL(forwarded.url).pathname).toBe('/rpc/undo/active');
      expect(forwarded.headers.get('x-agent-actor')).toBe(ACTOR);
      expect(forwarded.headers.get('x-agent-workspace')).toBe(WS);
      expect(forwarded.headers.get('x-agent-device')).toBe(DEVICE);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
