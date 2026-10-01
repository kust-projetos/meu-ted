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

const ENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENT_WRONG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const createMemorySql = (): Sql & { tables: Map<string, Array<Record<string, unknown>>> } => {
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
    if (q.startsWith('UPDATE UNDO_PROPOSALS')) throw new Error('store mutation must never run during verify');
    throw new Error(`unsupported query in test shim: ${query}`);
  };
  return { exec, tables };
};

const baseIdentity = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };
const NOW = Date.parse('2026-09-19T12:00:00.000Z');

const seed = (store: SqlUndoProposalStore, overrides: Partial<UndoProposalRecord> & { requestId: string }): UndoProposalRecord => {
  const record: UndoProposalRecord = Object.freeze({
    requestId: overrides.requestId,
    workspaceId: overrides.workspaceId ?? baseIdentity.workspaceId,
    actorId: overrides.actorId ?? baseIdentity.actorId,
    deviceId: overrides.deviceId ?? baseIdentity.deviceId,
    targetLastOperationId: overrides.targetLastOperationId ?? 'op-fixed-1',
    idempotencyKey: overrides.idempotencyKey ?? `undo:ws-1:${overrides.requestId}`,
    status: overrides.status ?? 'proposed',
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(NOW + 9 * 60_000).toISOString(),
  });
  store.insert(record);
  return record;
};

const auditItem = (id: string, entityId: string, extra: Record<string, unknown> = {}) => ({
  id,
  workspaceId: 'ws-1',
  operation: 'transactions.expense.create',
  effectRef: entityId,
  metadata: { entityId },
  createdAt: new Date(NOW - 30_000).toISOString(),
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('closure-undo-verify: service readonly verify', () => {
  const setup = (auditImpl: (identity: typeof baseIdentity) => Promise<readonly unknown[]>, seedOverrides: Partial<UndoProposalRecord> & { requestId: string } = { requestId: 'req-verify-1' }) => {
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    seed(store, seedOverrides);
    const audit = vi.fn(auditImpl);
    const preview = vi.fn(async () => ({ id: 'should-never-be-used' }));
    const api = { undo: vi.fn(async () => ({ undone: true })) };
    const deps = { store, preview, api, audit, now: () => NOW } as unknown as ConstructorParameters<typeof UndoProposalService>[0];
    const service = new UndoProposalService(deps);
    return { store, service, audit, preview, api };
  };

  it('returns matches:true for the correct entity', async () => {
    const { service } = setup(async () => [auditItem('op-fixed-1', ENT_A)]);
    const out = await service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity });
    expect(out).toMatchObject({ requestId: 'req-verify-1', matches: true });
  });

  it('returns matches:false for a wrong entity', async () => {
    const { service } = setup(async () => [auditItem('op-fixed-1', ENT_A)]);
    const out = await service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_WRONG }, identity: baseIdentity });
    expect(out).toMatchObject({ matches: false });
  });

  it('compares the FIXED target, never the newest head (old proposal + new head => false)', async () => {
    const { service } = setup(
      async () => [auditItem('op-new-head', ENT_A), auditItem('op-fixed-1', ENT_B)],
      { requestId: 'req-verify-1', targetLastOperationId: 'op-fixed-1' },
    );
    const out = await service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity });
    expect(out).toMatchObject({ matches: false });
  });

  it('fails closed on binding mismatch for actor, workspace and device', async () => {
    const { service } = setup(async () => [auditItem('op-fixed-1', ENT_A)]);
    await expect(service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: { ...baseIdentity, actorId: 'other' } })).rejects.toMatchObject({ code: 'undo.binding_mismatch' });
    await expect(service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: { ...baseIdentity, workspaceId: 'ws-other' } })).rejects.toMatchObject({ code: 'undo.binding_mismatch' });
    await expect(service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: { ...baseIdentity, deviceId: 'other-device' } })).rejects.toMatchObject({ code: 'undo.binding_mismatch' });
  });

  it('expiry is readonly: fails closed without store writes', async () => {
    const expiredAt = new Date(NOW - 1_000).toISOString();
    const { service, store, audit, preview, api } = setup(async () => [auditItem('op-fixed-1', ENT_A)], { requestId: 'req-exp', targetLastOperationId: 'op-fixed-1', expiresAt: expiredAt });
    await expect(service.verify({ requestId: 'req-exp', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.expired' });
    expect(store.get('req-exp')?.status).toBe('proposed');
    expect(audit).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('successful verify never touches preview/api/store-mutations', async () => {
    const { service, audit, preview, api, store } = setup(async () => [auditItem('op-fixed-1', ENT_A)]);
    const before = store.get('req-verify-1');
    await service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toEqual(baseIdentity);
    expect(preview).not.toHaveBeenCalled();
    expect(api.undo).not.toHaveBeenCalled();
    expect(store.get('req-verify-1')).toEqual(before);
  });

  it('race: record changed during the audit await fails closed as target_changed', async () => {
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    seed(store, { requestId: 'req-race', targetLastOperationId: 'op-fixed-1' });
    const audit = vi.fn(async () => {
      // Concurrent writer swaps the fixed target at the storage level while
      // the audit read is in flight.
      sql.tables.get('undo_proposals')![0]!.target_last_operation_id = 'op-changed';
      return [auditItem('op-fixed-1', ENT_A)];
    });
    const preview = vi.fn(async () => ({ id: 'x' }));
    const api = { undo: vi.fn(async () => ({})) };
    const deps = { store, preview, api, audit, now: () => NOW } as unknown as ConstructorParameters<typeof UndoProposalService>[0];
    const service = new UndoProposalService(deps);
    await expect(service.verify({ requestId: 'req-race', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.target_changed' });
    expect(preview).not.toHaveBeenCalled();
    expect(api.undo).not.toHaveBeenCalled();
  });

  it('missing audit target fails closed', async () => {
    const { service } = setup(async () => [auditItem('op-other', ENT_A)]);
    await expect(service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.target_missing' });
  });

  it('conflicting entity sources fail closed as ambiguous', async () => {
    const { service } = setup(async () => [{ ...auditItem('op-fixed-1', ENT_A), effectRef: ENT_B }]);
    await expect(service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.target_ambiguous' });
  });

  it('resolves entity via effectRef and metadata.after.id fallbacks', async () => {
    const viaRef = setup(async () => [{ id: 'op-fixed-1', workspaceId: 'ws-1', operation: 'transactions.income.create', effectRef: ENT_A, metadata: {}, createdAt: new Date(NOW - 30_000).toISOString() }]);
    const outRef = await viaRef.service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity });
    expect(outRef).toMatchObject({ matches: true });

    const viaAfter = setup(async () => [{ id: 'op-fixed-1', workspaceId: 'ws-1', operation: 'transactions.transfer.create', metadata: { after: { id: ENT_A } }, createdAt: new Date(NOW - 30_000).toISOString() }]);
    const outAfter = await viaAfter.service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: ENT_A }, identity: baseIdentity });
    expect(outAfter).toMatchObject({ matches: true });
  });

  it('rejects invalid expectedEntity', async () => {
    const { service } = setup(async () => [auditItem('op-fixed-1', ENT_A)]);
    await expect(service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'account', id: ENT_A } as unknown as { type: 'transaction'; id: string }, identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.invalid_target' });
    await expect(service.verify({ requestId: 'req-verify-1', expectedEntity: { type: 'transaction', id: 'not-a-uuid' }, identity: baseIdentity })).rejects.toMatchObject({ code: 'undo.invalid_target' });
  });
});

describe('closure-undo-verify: RPC POST /rpc/undo/:id/verify-target', () => {
  const agentWithEnv = (env: Record<string, string | undefined>) => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: env, configurable: true });
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, configurable: true });
    (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
    (agent as unknown as { messages: unknown }).messages = [];
    return { agent, sql };
  };

  const seedRpc = (agent: FinanceChatAgent, overrides: Partial<UndoProposalRecord> & { requestId: string }) => {
    const store = (agent as unknown as { undoStoreForRequest(): SqlUndoProposalStore }).undoStoreForRequest()!;
    // RPC handlers run on the real clock: keep the seeded row live.
    seed(store, { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), ...overrides });
  };

  const rpcHeaders = (token: string) => ({
    'content-type': 'application/json',
    'x-agent-connection-token': token,
    'x-agent-actor': 'actor-1',
    'x-agent-workspace': 'ws-1',
    'x-agent-device': 'device-1',
  });

  it('200 true/false with a financial.read audit call; response carries no target/secret', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' }, secret);
    const { agent } = agentWithEnv({ API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' });
    seedRpc(agent, { requestId: 'proposal-v1', targetLastOperationId: 'op-fixed-1' });
    const seen: Array<{ url: string; auth: string }> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/audit-logs')) {
        seen.push({ url: href, auth: String((init?.headers as Record<string, string>)?.authorization ?? '') });
        return new Response(JSON.stringify({ items: [auditItem('op-fixed-1', ENT_A)] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const ok = await agent.fetch(new Request('https://agent.test.local/rpc/undo/proposal-v1/verify-target', {
      method: 'POST', headers: rpcHeaders(token), body: JSON.stringify({ expectedEntity: { type: 'transaction', id: ENT_A } }),
    }));
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as Record<string, unknown>;
    expect(okJson).toEqual({ requestId: 'proposal-v1', matches: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain('/audit-logs?limit=50');
    // Delegated token carries ONLY financial.read, device-bound.
    const [, payload] = seen[0]!.auth.replace('Bearer ', '').split('.');
    const claims = JSON.parse(Buffer.from(payload!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { capabilities: string[]; deviceId: string };
    expect(claims.capabilities).toEqual(['financial.read']);
    expect(claims.deviceId).toBe('device-1');

    const wrong = await agent.fetch(new Request('https://agent.test.local/rpc/undo/proposal-v1/verify-target', {
      method: 'POST', headers: rpcHeaders(token), body: JSON.stringify({ expectedEntity: { type: 'transaction', id: ENT_WRONG } }),
    }));
    expect(wrong.status).toBe(200);
    expect(((await wrong.json()) as { matches: boolean }).matches).toBe(false);
    fetchMock.mockRestore();
  });

  it('accepts inverted key order but rejects unknown extras (order-insensitive strict shape)', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' }, secret);
    const { agent } = agentWithEnv({ API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' });
    seedRpc(agent, { requestId: 'proposal-order', targetLastOperationId: 'op-fixed-1' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      if (String(url).includes('/audit-logs')) {
        return new Response(JSON.stringify({ items: [auditItem('op-fixed-1', ENT_A)] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected');
    });
    try {
      const headers = rpcHeaders(token);
      const inverted = await agent.fetch(new Request('https://agent.test.local/rpc/undo/proposal-order/verify-target', {
        method: 'POST', headers, body: JSON.stringify({ expectedEntity: { id: ENT_A, type: 'transaction' } }),
      }));
      expect(inverted.status).toBe(200);
      expect(((await inverted.json()) as { matches: boolean }).matches).toBe(true);

      const extra = await agent.fetch(new Request('https://agent.test.local/rpc/undo/proposal-order/verify-target', {
        method: 'POST', headers, body: JSON.stringify({ expectedEntity: { type: 'transaction', id: ENT_A, foo: 'bar' } }),
      }));
      expect(extra.status).toBe(400);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('strict body, unknown id, binding, spoofed gateway token and expiry fail closed', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken({ sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' }, secret);
    const { agent } = agentWithEnv({ API_ORIGIN: 'https://api.test.local', AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_DELEGATION_SECRET: 'delegation-secret' });
    seedRpc(agent, { requestId: 'proposal-s', targetLastOperationId: 'op-fixed-1' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      if (String(url).includes('/audit-logs')) {
        return new Response(JSON.stringify({ items: [auditItem('op-fixed-1', ENT_A)] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected');
    });
    const headers = rpcHeaders(token);
    const extra = await agent.fetch(new Request('https://agent.test.local/rpc/undo/proposal-s/verify-target', {
      method: 'POST', headers, body: JSON.stringify({ expectedEntity: { type: 'transaction', id: ENT_A }, actorId: 'forged' }),
    }));
    expect(extra.status).toBe(400);

    const unknown = await agent.fetch(new Request('https://agent.test.local/rpc/undo/nope/verify-target', {
      method: 'POST', headers, body: JSON.stringify({ expectedEntity: { type: 'transaction', id: ENT_A } }),
    }));
    expect(unknown.status).toBe(404);

    const mismatch = await agent.fetch(new Request('https://agent.test.local/rpc/undo/proposal-s/verify-target', {
      method: 'POST', headers: { ...headers, 'x-agent-actor': 'other' }, body: JSON.stringify({ expectedEntity: { type: 'transaction', id: ENT_A } }),
    }));
    expect(mismatch.status).toBe(403);

    const spoofed = await agent.fetch(new Request('https://agent.test.local/rpc/undo/proposal-s/verify-target', {
      method: 'POST', headers: { ...headers, 'x-agent-device': 'device-2' }, body: JSON.stringify({ expectedEntity: { type: 'transaction', id: ENT_A } }),
    }));
    expect(spoofed.status).toBe(403);
    vi.restoreAllMocks();
  });

  it('worker gateway forwards POST /rpc/undo/:id/verify-target with stamped identity', async () => {
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
        Response.json({ requestId: 'proposal-v1', matches: true }, { status: 200 }),
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
        new Request(`https://worker.test/agents/finance-chat-agent/${WS}/rpc/undo/proposal-v1/verify-target`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agent-connection-token': token },
          body: JSON.stringify({ expectedEntity: { type: 'transaction', id: ENT_A } }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(financeFetch).toHaveBeenCalledOnce();
      const forwarded = financeFetch.mock.calls[0]![0];
      expect(new URL(forwarded.url).pathname).toBe('/rpc/undo/proposal-v1/verify-target');
      expect(forwarded.headers.get('x-agent-actor')).toBe(ACTOR);
      expect(forwarded.headers.get('x-agent-workspace')).toBe(WS);
      expect(forwarded.headers.get('x-agent-device')).toBe(DEVICE);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
