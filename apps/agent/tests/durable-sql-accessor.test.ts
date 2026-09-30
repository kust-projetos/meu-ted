import { describe, expect, it, vi, afterEach } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { initializeUndoProposalSchema, SqlUndoProposalStore } from '../src/mutations/undo-proposal.js';
import { createAgentConnectionToken } from '../../api/src/auth/agent-connection-token.js';

type ExecFn = <T>(query: string, ...bindings: unknown[]) => Iterable<T>;

const makeSelectCountSql = (reqCount: number): { exec: ExecFn; calls: string[] } => {
  const calls: string[] = [];
  const exec = (<T>(query: string, ..._bindings: unknown[]): Iterable<T> => {
    calls.push(query);
    if (query.includes('SELECT COUNT(*) AS req_count')) {
      return [{ req_count: reqCount }] as unknown as Iterable<T>;
    }
    if (query.includes('SELECT COALESCE(SUM')) {
      return [{ total_tokens: 0 }] as unknown as Iterable<T>;
    }
    if (query.includes('WHERE actor_id = ?')) {
      return [{ actor_tokens: 0 }] as unknown as Iterable<T>;
    }
    if (query.includes('CREATE TABLE') || query.includes('CREATE INDEX')) return [] as unknown as Iterable<T>;
    return [] as unknown as Iterable<T>;
  }) as ExecFn;
  return { exec, calls };
};

const makeIntentionSql = (rows: unknown[]): { exec: ExecFn; calls: string[] } => {
  const calls: string[] = [];
  const exec = (<T>(query: string, ..._bindings: unknown[]): Iterable<T> => {
    calls.push(query);
    if (query.startsWith('SELECT * FROM intention_snapshots')) {
      return rows as unknown as Iterable<T>;
    }
    return [] as unknown as Iterable<T>;
  }) as ExecFn;
  return { exec, calls };
};

const ctxAgent = (sql: unknown | undefined, extraStateSql?: unknown, env: Record<string, unknown> = {}) => {
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
  Object.defineProperty(agent, 'env', { value: env, configurable: true });
  if (sql !== undefined) {
    Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, configurable: true });
  }
  if (extraStateSql !== undefined) {
    Object.defineProperty(agent, 'state', { value: { storage: { sql: extraStateSql } }, configurable: true });
  }
  (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
  (agent as unknown as { messages: unknown }).messages = [];
  return agent;
};

type AgentPriv = {
  durableSql(): { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> } | null;
  resolveIntentionSnapshot(id: string): Promise<unknown>;
};

describe('durableSql: single ctx.storage.sql accessor (same root cause as undo/active 503)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes ctx.storage.sql and never falls back to app state.storage', () => {
    const ctxSql = { exec: () => [][Symbol.iterator]() };
    const stateSql = { exec: () => { throw new Error('state.storage must never be read'); } };
    const agent = ctxAgent(ctxSql, stateSql);
    const priv = agent as unknown as AgentPriv;
    expect(typeof priv.durableSql).toBe('function');
    expect(priv.durableSql()).toBe(ctxSql);
  });

  it('is fail-closed (null) when ctx is absent, even if state.storage.sql exists', () => {
    const stateSql = { exec: vi.fn(() => [][Symbol.iterator]()) };
    const agent = ctxAgent(undefined, stateSql);
    const priv = agent as unknown as AgentPriv;
    expect(priv.durableSql()).toBeNull();
    expect(stateSql.exec).not.toHaveBeenCalled();
  });

  it('memory prefs resolve from ctx-only (503 with state-only, never reading app state)', async () => {
    const tables = new Map<string, Array<Record<string, unknown>>>([['agent_prefs', []]]);
    const ctxSql = {
      exec: (<T>(query: string, ...bindings: unknown[]): Iterable<T> => {
        const q = query.trim().replace(/\s+/g, ' ');
        if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) return [] as unknown as Iterable<T>;
        if (q.startsWith('INSERT INTO agent_prefs')) {
          tables.get('agent_prefs')!.push({ workspace_id: bindings[0], memory_enabled: bindings[1] });
          return [] as unknown as Iterable<T>;
        }
        if (q.startsWith('SELECT memory_enabled')) {
          return tables.get('agent_prefs')!.filter((r) => r['workspace_id'] === bindings[0]) as unknown as Iterable<T>;
        }
        if (q.startsWith('SELECT * FROM agent_memory')) return [] as unknown as Iterable<T>;
        throw new Error(`unhandled: ${q.slice(0, 60)}`);
      }) as ExecFn,
    };
    const headers = { 'x-agent-actor': 'actor-1', 'x-agent-workspace': 'ws-1' };
    const okAgent = ctxAgent(ctxSql, undefined, {});
    const okRes = await okAgent.fetch(
      new Request('https://agent.test/rpc/memory/prefs', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(okRes.status).toBe(200);

    const stateExec = vi.fn(() => [][Symbol.iterator]());
    const stateOnly = ctxAgent(undefined, { exec: stateExec }, {});
    const denied = await stateOnly.fetch(
      new Request('https://agent.test/rpc/memory/prefs', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(denied.status).toBe(503);
    expect(stateExec).not.toHaveBeenCalled();
  });

  it('intention snapshot resolves the stored row via ctx-only without fetch; state-only is ignored', async () => {
    const stored = {
      intention_id: 'intent-ctx-1',
      version: 2,
      provider_id: 'openai-api',
      model_id: 'openai-api:gpt-4o',
      protocol: 'chat-completions',
      rollout_percentage: 100,
      security_epoch: 1,
      model_name: 'gpt-4o',
      created_at: '2026-09-06T00:00:00.000Z',
    };
    const { exec } = makeIntentionSql([stored]);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const agent = ctxAgent({ exec }, undefined, { API_ORIGIN: 'https://api.test.local', AGENT_CONFIG_TOKEN: 'tok' });
    const snapshot = (await (agent as unknown as AgentPriv).resolveIntentionSnapshot('intent-ctx-1')) as {
      model_name: string;
    } | null;
    expect(snapshot?.model_name).toBe('gpt-4o');
    expect(fetchSpy).not.toHaveBeenCalled();

    const stateExec = vi.fn(<T>(): Iterable<T> => [stored] as unknown as Iterable<T>);
    const stateOnly = ctxAgent(undefined, { exec: stateExec }, {});
    const missed = await (stateOnly as unknown as AgentPriv).resolveIntentionSnapshot('intent-ctx-1');
    expect(missed).toBeNull();
    expect(stateExec).not.toHaveBeenCalled();
  });

  it('usage gate enforces the limit when ctx exists and degrades (no skip-by-absence) when it does not', async () => {
    const { exec } = makeSelectCountSql(20);
    const poison = { exec: () => { throw new Error('state.storage must never be read'); } };
    const agent = ctxAgent({ exec }, poison, {});
    (agent as unknown as { orchestratorForChannel: unknown }).orchestratorForChannel = () => ({
      runTurn: async () => ({}),
    });
    const limited = (await (agent as unknown as { onChatMessage(m: unknown): Promise<unknown> }).onChatMessage({
      text: 'qual meu saldo hoje',
      intentionId: 'intent-usage-1',
      actorId: 'actor-1',
      workspaceId: 'ws-1',
    })) as { text: string };
    expect(limited.text).toContain('Limite de uso atingido');

    const bare = ctxAgent(undefined, poison, {});
    const runTurnSpy = vi.fn(async () => ({}));
    (bare as unknown as { orchestratorForChannel: unknown }).orchestratorForChannel = () => ({
      runTurn: runTurnSpy,
    });
    const degraded = (await (bare as unknown as { onChatMessage(m: unknown): Promise<unknown> }).onChatMessage({
      text: 'qual meu saldo hoje',
      intentionId: 'intent-usage-2',
      actorId: 'actor-1',
      workspaceId: 'ws-1',
    })) as { text: string };
    expect(runTurnSpy).not.toHaveBeenCalled();
    expect(degraded.text).toContain('TED unavailable: durable storage is not available');
  });

  it('legacy history migration persists via ctx-only and never touches state.storage', async () => {
    const memory = new Map<string, Array<Record<string, unknown>>>();
    const ctxSql = {
      exec: (<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
        if (query.includes('CREATE TABLE')) return [] as Iterable<T>;
        if (query.includes('SELECT migration_hash')) {
          return (memory.get('_history_migration_marker') ?? []) as unknown as Iterable<T>;
        }
        if (query.includes('INSERT INTO _history_migration_marker')) {
          const [workspace_id, migration_hash, imported_count] = params as [string, string, number];
          memory.set('_history_migration_marker', [{ workspace_id, migration_hash, imported_count }]);
          return [] as Iterable<T>;
        }
        return [] as Iterable<T>;
      }) as ExecFn,
    };
    const persisted: unknown[] = [];
    const agent = ctxAgent(ctxSql, undefined, {});
    (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async (msgs: unknown[]) => {
      persisted.push(...msgs);
    });
    const res = await agent.importLegacyHistory({
      version: 1,
      workspaceId: 'ws-mig-1',
      turns: [],
      messages: [
        { id: 'm-1', actor_id: 'u-1', role: 'user', content_json: JSON.stringify('oi'), created_at: '2026-08-20T10:00:00.000Z' },
      ],
      hasInFlightTurns: false,
    });
    expect(res.success).toBe(true);
    expect(res.importedCount).toBe(1);
    expect(persisted).toHaveLength(1);

    const stateExec = vi.fn(() => [][Symbol.iterator]());
    const stateOnly = ctxAgent(undefined, { exec: stateExec }, {});
    const persisted2: unknown[] = [];
    (stateOnly as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async (msgs: unknown[]) => {
      persisted2.push(...msgs);
    });
    const res2 = await stateOnly.importLegacyHistory({
      version: 1,
      workspaceId: 'ws-mig-1',
      turns: [],
      messages: [
        { id: 'm-1', actor_id: 'u-1', role: 'user', content_json: JSON.stringify('oi'), created_at: '2026-08-20T10:00:00.000Z' },
      ],
      hasInFlightTurns: false,
    });
    expect(res2.success).toBe(false);
    expect(res2.importedCount).toBe(0);
    expect(res2.reason).toContain('missing_durable_marker_store');
    expect(persisted2).toHaveLength(0);
    expect(stateExec).not.toHaveBeenCalled();
  });

  it('read-only undo active listing works ctx-only and stays fail-closed without ctx', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken(
      { sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' },
      secret,
    );
    const headers = {
      'x-agent-connection-token': token,
      'x-agent-actor': 'actor-1',
      'x-agent-workspace': 'ws-1',
      'x-agent-device': 'device-1',
    };
    const memTables = new Map<string, Array<Record<string, unknown>>>();
    const memExec = (<T>(query: string, ...params: unknown[]): Iterable<T> => {
      const q = query.trim().replace(/\s+/g, ' ');
      if (q.startsWith('CREATE TABLE')) return [] as unknown as Iterable<T>;
      if (q.startsWith('INSERT INTO undo_proposals')) {
        const [request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json] =
          params as unknown[];
        const rows = memTables.get('undo_proposals') ?? [];
        rows.push({ request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json });
        memTables.set('undo_proposals', rows);
        return [] as unknown as Iterable<T>;
      }
      if (q.startsWith('SELECT') && q.includes('FROM undo_proposals')) {
        return (memTables.get('undo_proposals') ?? []) as unknown as Iterable<T>;
      }
      return [] as unknown as Iterable<T>;
    }) as ExecFn;
    const sql = { exec: memExec };
    initializeUndoProposalSchema(sql as never);
    const store = new SqlUndoProposalStore(sql as never);
    store.insert({
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      deviceId: 'device-1',
      requestId: 'req-ctx-1',
      targetLastOperationId: 'op-1',
      idempotencyKey: 'key-1',
      status: 'proposed',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as never);
    const agent = ctxAgent(sql, undefined, { AGENT_CONNECTION_TOKEN_SECRET: secret });
    const res = await agent.fetch(new Request('https://agent.test.local/rpc/undo/active', { method: 'GET', headers }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(1);

    const bare = ctxAgent(undefined, undefined, { AGENT_CONNECTION_TOKEN_SECRET: secret });
    const denied = await bare.fetch(new Request('https://agent.test.local/rpc/undo/active', { method: 'GET', headers }));
    expect(denied.status).toBe(503);
  });
});
