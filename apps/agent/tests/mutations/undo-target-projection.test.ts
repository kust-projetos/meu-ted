/**
 * FIX-172 (Agent): display-safe projection of the fixed undo target.
 *
 * The execution binding stays 100% server-side (requestId → target fixed at
 * proposal time; the RPC decides from the fixed preview, never from client
 * input). The projection below is DISPLAY-ONLY: the same 5 fields as the PWA
 * `undoTargetSchema`, derived from the authoritative preview, persisted with
 * the proposal, and emitted on both real paths (turn relay + active list).
 * A client tampering with the display can never change the executed target
 * (the decision path never reads it).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeUndoProposalSchema,
  SqlUndoProposalStore,
  UndoProposalService,
  sanitizeUndoTargetDisplay,
  recordDisplayTarget,
  type UndoProposalRecord,
  type UndoTargetDisplay,
} from '../../src/mutations/undo-proposal.js';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import { createAgentConnectionToken } from '../../../api/src/auth/agent-connection-token.js';

type Sql = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };

type MemoryTables = Map<string, Array<Record<string, unknown>>>;

/**
 * In-memory shim modeling BOTH storages:
 * - modern: `target_json` column present (fresh DDL or migrated);
 * - legacy: column absent AND the 12-column INSERT fails with
 *   `no such column` (proves the preservative fallback), ALTER unsupported.
 */
const createMemorySql = (opts: { legacy?: boolean } = {}): Sql & { tables: MemoryTables } => {
  const tables: MemoryTables = new Map();
  const columns = new Set(['request_id', 'workspace_id', 'actor_id', 'device_id', 'target_last_operation_id', 'idempotency_key', 'status', 'created_at', 'expires_at', 'decided_at', 'result_json']);
  const exec = <T,>(query: string, ...bindings: unknown[]): Iterable<T> => {
    const q = query.trim().toUpperCase();
    if (q.startsWith('CREATE TABLE')) {
      const name = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(query)?.[1] ?? 't';
      if (!tables.has(name)) tables.set(name, []);
      if (!opts.legacy && name === 'undo_proposals') columns.add('target_json');
      return [][Symbol.iterator]() as IterableIterator<T>;
    }
    if (q.startsWith('CREATE INDEX')) return [][Symbol.iterator]() as IterableIterator<T>;
    if (q.startsWith('PRAGMA TABLE_INFO')) {
      if (opts.legacy) throw new Error('unsupported query in test shim: PRAGMA');
      return ([...columns].map((name) => ({ name })) as unknown as T[])[Symbol.iterator]();
    }
    if (q.startsWith('ALTER TABLE UNDO_PROPOSALS ADD COLUMN')) {
      if (opts.legacy) throw new Error('unsupported query in test shim: ALTER');
      columns.add('target_json');
      return [][Symbol.iterator]() as IterableIterator<T>;
    }
    if (q.startsWith('INSERT INTO UNDO_PROPOSALS')) {
      const wantsTarget = /TARGET_JSON/.test(q);
      if (wantsTarget && !columns.has('target_json')) {
        throw new Error('no such column: target_json');
      }
      const rows = tables.get('undo_proposals') ?? [];
      const cells = bindings as Array<string | null>;
      const [request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json] = cells;
      if (rows.some((r) => r.request_id === request_id)) return [][Symbol.iterator]() as IterableIterator<T>;
      const row: Record<string, unknown> = { request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json };
      if (wantsTarget) row.target_json = cells[11] ?? null;
      rows.push(row);
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
  return { exec, tables };
};

const baseIdentity = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };
const NOW = Date.parse('2026-09-19T12:00:00.000Z');

const DISPLAY: UndoTargetDisplay = Object.freeze({
  kind: 'Despesa',
  description: 'Mercado',
  amountCents: 85000,
  accountLabel: 'Nubank',
  occurredOn: '2026-09-14',
});

const setupService = (opts: {
  previewTarget?: UndoTargetDisplay | null;
  now?: number;
  legacy?: boolean;
  apiImpl?: (input: { lastOperationId: string; idempotencyKey: string }) => Promise<unknown>;
} = {}) => {
  const sql = createMemorySql({ ...(opts.legacy ? { legacy: true } : {}) });
  initializeUndoProposalSchema(sql);
  const store = new SqlUndoProposalStore(sql);
  const apiCalls: Array<{ lastOperationId: string; idempotencyKey: string }> = [];
  const service = new UndoProposalService({
    store,
    preview: async () => ({ id: 'audit-op-1', ...(opts.previewTarget === undefined || opts.previewTarget === null ? {} : { target: opts.previewTarget }) }),
    api: {
      undo: async (input: { lastOperationId: string; idempotencyKey: string }) => {
        apiCalls.push({ lastOperationId: input.lastOperationId, idempotencyKey: input.idempotencyKey });
        if (opts.apiImpl) return opts.apiImpl(input);
        return { undone: true };
      },
    },
    now: () => opts.now ?? NOW,
  });
  return { sql, store, service, apiCalls };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FIX-172 Agent: sanitizeUndoTargetDisplay (display-only allowlist)', () => {
  it('keeps an allowlisted full projection, frozen', () => {
    const clean = sanitizeUndoTargetDisplay({ ...DISPLAY });
    expect(clean).toEqual({ ...DISPLAY });
    expect(Object.isFrozen(clean)).toBe(true);
    expect(Object.keys(clean ?? {}).sort()).toEqual(['accountLabel', 'amountCents', 'description', 'kind', 'occurredOn']);
  });

  it('drops blank optionals but keeps the target when a description survives', () => {
    expect(sanitizeUndoTargetDisplay({ kind: '  ', description: 'Mercado', accountLabel: '', occurredOn: '   ' })).toEqual({
      description: 'Mercado',
    });
  });

  it('is undefined for non-objects', () => {
    expect(sanitizeUndoTargetDisplay(null)).toBeUndefined();
    expect(sanitizeUndoTargetDisplay(undefined)).toBeUndefined();
    expect(sanitizeUndoTargetDisplay('Mercado')).toBeUndefined();
    expect(sanitizeUndoTargetDisplay([])).toBeUndefined();
  });

  it('is undefined without a displayable description (fail-closed to the legacy shape)', () => {
    expect(sanitizeUndoTargetDisplay({})).toBeUndefined();
    expect(sanitizeUndoTargetDisplay({ kind: 'Despesa', amountCents: 85000 })).toBeUndefined();
    expect(sanitizeUndoTargetDisplay({ description: '   ', amountCents: 85000 })).toBeUndefined();
    expect(sanitizeUndoTargetDisplay({ description: 42 })).toBeUndefined();
  });

  it('is undefined on a non-finite amount', () => {
    expect(sanitizeUndoTargetDisplay({ description: 'Mercado', amountCents: Number.NaN })).toBeUndefined();
    expect(sanitizeUndoTargetDisplay({ description: 'Mercado', amountCents: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(sanitizeUndoTargetDisplay({ description: 'Mercado', amountCents: '85000' })).toBeUndefined();
  });

  it('fails the whole projection wholesale on smuggled keys (never forwards ids/keys)', () => {
    expect(sanitizeUndoTargetDisplay({ ...DISPLAY, targetLastOperationId: 'audit-op-1' })).toBeUndefined();
    expect(sanitizeUndoTargetDisplay({ ...DISPLAY, idempotencyKey: 'undo:ws-1:req-1' })).toBeUndefined();
    expect(sanitizeUndoTargetDisplay({ ...DISPLAY, requestId: 'req-1' })).toBeUndefined();
    expect(sanitizeUndoTargetDisplay({ ...DISPLAY, operationId: 'op-1' })).toBeUndefined();
  });
});

describe('FIX-172 Agent: propose persists the fixed display projection', () => {
  it('turn-path source: preview target is stored canonically and re-exposed', async () => {
    const { store, service } = setupService({ previewTarget: { ...DISPLAY } });
    const outcome = await service.propose({ requestId: 'req-target-1', identity: baseIdentity });
    expect(outcome.kind).toBe('proposed');
    if (outcome.kind !== 'proposed') throw new Error('expected proposal');

    const stored = store.get('req-target-1');
    expect(stored?.targetJson).toBe(JSON.stringify({ ...DISPLAY }));
    expect(recordDisplayTarget(stored as UndoProposalRecord)).toEqual({ ...DISPLAY });

    const summaries = service.listActive(baseIdentity);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      requestId: 'req-target-1',
      status: 'proposed',
      expiresAt: expect.any(String),
      target: { ...DISPLAY },
    });
  });

  it('preview without descriptives stores nothing and emits no target key', async () => {
    const { store, service } = setupService();
    const outcome = await service.propose({ requestId: 'req-plain-1', identity: baseIdentity });
    expect(outcome.kind).toBe('proposed');

    expect(store.get('req-plain-1')?.targetJson).toBeUndefined();
    const summaries = service.listActive(baseIdentity);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty('target');
    expect(Object.keys(summaries[0] as Record<string, unknown>).sort()).toEqual(['expiresAt', 'requestId', 'status']);
  });

  it('redelivery keeps the ORIGINAL fixed target (later previews never move it)', async () => {
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    const first = new UndoProposalService({
      store,
      preview: async () => ({ id: 'audit-op-1', target: { ...DISPLAY } }),
      api: { undo: async () => ({ ok: true }) },
      now: () => NOW,
    });
    await first.propose({ requestId: 'req-fixed', identity: baseIdentity });

    const second = new UndoProposalService({
      store,
      preview: async () => ({ id: 'audit-op-OTHER', target: { description: 'Outro', amountCents: 1 } }),
      api: { undo: async () => ({ ok: true }) },
      now: () => NOW,
    });
    const outcome = await second.propose({ requestId: 'req-fixed', identity: baseIdentity });
    expect(outcome.kind).toBe('proposed');
    if (outcome.kind !== 'proposed') throw new Error('expected proposal');
    expect(outcome.created).toBe(false);
    expect(outcome.record.targetLastOperationId).toBe('audit-op-1');
    expect(recordDisplayTarget(outcome.record)).toEqual({ ...DISPLAY });
  });
});

describe('FIX-172 Agent: active-list path emits the stored projection without secrets', () => {
  it('attaches the display target and leaks no fixed-target material', async () => {
    const { service } = setupService({ previewTarget: { ...DISPLAY } });
    await service.propose({ requestId: 'req-list-1', identity: baseIdentity });

    const items = service.listActive(baseIdentity);
    expect(items).toHaveLength(1);
    expect(items[0]?.target).toEqual({ ...DISPLAY });

    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('audit-op-1');
    expect(serialized).not.toContain('undo:ws-1');
    expect(serialized).not.toContain('targetLastOperationId');
    expect(serialized).not.toContain('idempotencyKey');
  });

  it('a tampered/corrupt stored projection sanitizes to absent (row otherwise intact)', async () => {
    const { sql, store, service } = setupService({ previewTarget: { ...DISPLAY } });
    await service.propose({ requestId: 'req-tamper', identity: baseIdentity });

    const rows = sql.tables.get('undo_proposals') ?? [];
    const row = rows.find((r) => r.request_id === 'req-tamper');
    expect(row).toBeDefined();
    row!.target_json = JSON.stringify({ description: 'Mercado', targetLastOperationId: 'audit-op-EVIL', idempotencyKey: 'undo:ws-1:evil' });

    const items = service.listActive(baseIdentity);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('target');
    // The fixed binding columns are untouched by display tampering.
    expect(store.get('req-tamper')?.targetLastOperationId).toBe('audit-op-1');

    // Garbage is equally fail-closed.
    row!.target_json = 'not-json{{{';
    expect(service.listActive(baseIdentity)[0]).not.toHaveProperty('target');
  });
});

describe('FIX-172 Agent: decide never consults the display (tampering cannot move execution)', () => {
  it('confirm executes the FIXED target + stable key despite a tampered display', async () => {
    const { sql, service, apiCalls } = setupService({ previewTarget: { ...DISPLAY } });
    await service.propose({ requestId: 'req-exec', identity: baseIdentity });

    const rows = sql.tables.get('undo_proposals') ?? [];
    rows.find((r) => r.request_id === 'req-exec')!.target_json = JSON.stringify({
      description: 'ADULTERADO',
      amountCents: 1,
    });

    const outcome = await service.decide({ requestId: 'req-exec', decision: 'confirm', identity: baseIdentity });
    expect(outcome.kind).toBe('confirmed');
    expect(apiCalls).toEqual([{ lastOperationId: 'audit-op-1', idempotencyKey: 'undo:ws-1:req-exec' }]);
  });
});

describe('FIX-172 Agent: legacy storage without the display column stays fully operational', () => {
  it('propose + listActive + decide work with no target key anywhere', async () => {
    const { store, service, apiCalls } = setupService({ previewTarget: { ...DISPLAY }, legacy: true });
    const outcome = await service.propose({ requestId: 'req-legacy', identity: baseIdentity });
    expect(outcome.kind).toBe('proposed');

    expect(store.get('req-legacy')?.targetJson).toBeUndefined();
    const items = service.listActive(baseIdentity);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('target');

    const decided = await service.decide({ requestId: 'req-legacy', decision: 'confirm', identity: baseIdentity });
    expect(decided.kind).toBe('confirmed');
    expect(apiCalls).toEqual([{ lastOperationId: 'audit-op-1', idempotencyKey: 'undo:ws-1:req-legacy' }]);
  });

  it('migration is idempotent and preserves pre-existing rows', () => {
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    store.insert(
      Object.freeze({
        requestId: 'req-old',
        workspaceId: 'ws-1',
        actorId: 'actor-1',
        deviceId: 'device-1',
        targetLastOperationId: 'audit-op-1',
        idempotencyKey: 'undo:ws-1:req-old',
        status: 'proposed',
        createdAt: new Date(NOW - 60_000).toISOString(),
        expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
      }) as UndoProposalRecord,
    );
    expect(store.get('req-old')?.targetJson).toBeUndefined();
  });
});

describe('FIX-172 Agent: RPC GET /rpc/undo/active emits the display target without secrets', () => {
  it('items carry target; fixed-target material never crosses', async () => {
    const secret = 'connection-secret';
    const token = await createAgentConnectionToken(
      { sub: 'actor-1', workspace: 'ws-1', role: 'member', deviceId: 'device-1' },
      secret,
    );
    const sql = createMemorySql();
    initializeUndoProposalSchema(sql);
    const store = new SqlUndoProposalStore(sql);
    const liveExpiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
    store.insert(
      Object.freeze({
        requestId: 'req-rpc-target',
        workspaceId: 'ws-1',
        actorId: 'actor-1',
        deviceId: 'device-1',
        targetLastOperationId: 'audit-op-1',
        idempotencyKey: 'undo:ws-1:req-rpc-target',
        status: 'proposed',
        createdAt: new Date(Date.now()).toISOString(),
        expiresAt: liveExpiresAt,
        targetJson: JSON.stringify({ ...DISPLAY }),
      }) as UndoProposalRecord,
    );
    store.insert(
      Object.freeze({
        requestId: 'req-rpc-plain',
        workspaceId: 'ws-1',
        actorId: 'actor-1',
        deviceId: 'device-1',
        targetLastOperationId: 'audit-op-2',
        idempotencyKey: 'undo:ws-1:req-rpc-plain',
        status: 'proposed',
        createdAt: new Date(Date.now()).toISOString(),
        expiresAt: liveExpiresAt,
      }) as UndoProposalRecord,
    );

    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'env', { value: { AGENT_CONNECTION_TOKEN_SECRET: secret }, configurable: true });
    Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, configurable: true });
    (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
    (agent as unknown as { messages: unknown }).messages = [];

    const response = await agent.fetch(
      new Request('https://agent.test.local/rpc/undo/active', {
        method: 'GET',
        headers: {
          'x-agent-connection-token': token,
          'x-agent-actor': 'actor-1',
          'x-agent-workspace': 'ws-1',
          'x-agent-device': 'device-1',
        },
      }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(json.total).toBe(2);
    const withTarget = json.items.find((item) => item.requestId === 'req-rpc-target');
    expect(withTarget?.target).toEqual({ ...DISPLAY });
    const plain = json.items.find((item) => item.requestId === 'req-rpc-plain');
    expect(plain).not.toHaveProperty('target');
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('audit-op-1');
    expect(serialized).not.toContain('audit-op-2');
    expect(serialized).not.toContain('undo:ws-1');
    expect(serialized).not.toContain('targetLastOperationId');
    expect(serialized).not.toContain('idempotencyKey');
  });
});

describe('FIX-P1-UX-R3 MEDIUM Agent: legacy fallback against REAL SQLite', () => {
  /**
   * Minimal `UndoSql` adapter over REAL `node:sqlite` (same shape as the DO
   * storage shim and the mutation-draft SQLite tests): SELECT/PRAGMA read via
   * `.all()`, everything else runs via `.run()`.
   */
  const createRealSql = (): { db: DatabaseSync; sql: Sql } => {
    const db = new DatabaseSync(':memory:');
    const sql: Sql = {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        const statement = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
          return statement.all(...(bindings as never[])) as T[];
        }
        statement.run(...(bindings as never[]));
        return [] as T[];
      },
    };
    return { db, sql };
  };

  const LEGACY_DDL = `
    CREATE TABLE undo_proposals (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      target_last_operation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      result_json TEXT
    );
  `;

  const legacyRecord = (requestId: string): UndoProposalRecord =>
    Object.freeze({
      requestId,
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      deviceId: 'device-1',
      targetLastOperationId: 'audit-op-1',
      idempotencyKey: `undo:ws-1:${requestId}`,
      status: 'proposed' as const,
      createdAt: new Date(NOW - 60_000).toISOString(),
      expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
      targetJson: JSON.stringify({ ...DISPLAY }),
    }) as UndoProposalRecord;

  it('documents the REAL SQLite missing-column message and the fallback honors it', () => {
    const { db, sql } = createRealSql();
    db.exec(LEGACY_DDL);

    // Pin the real engine wording: this is the exact failure the 12-column
    // INSERT raises on a legacy table — NOT the fabricated `no such column`
    // the in-memory shim throws.
    let realMessage = '';
    try {
      sql.exec(
        `INSERT INTO undo_proposals (request_id, workspace_id, actor_id, device_id, target_last_operation_id, idempotency_key, status, created_at, expires_at, decided_at, result_json, target_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'req-probe',
        'ws-1',
        'actor-1',
        'device-1',
        'audit-op-1',
        'undo:ws-1:req-probe',
        'proposed',
        new Date(NOW).toISOString(),
        new Date(NOW + 9 * 60_000).toISOString(),
        null,
        null,
        JSON.stringify({ ...DISPLAY }),
      );
    } catch (error) {
      realMessage = String((error as Error)?.message ?? error);
    }
    expect(realMessage).toMatch(/has no column named target_json/i);

    // And the store fallback must accept that real wording (not just the
    // fabricated `no such column`): the proposal persists in legacy shape.
    const store = new SqlUndoProposalStore(sql);
    expect(() =>
      store.insert(legacyRecord('req-legacy-real')),
    ).not.toThrow();
    expect(store.get('req-legacy-real')?.targetJson).toBeUndefined();
  });

  it('real migration adds target_json and preserves pre-existing legacy rows', () => {
    const { sql } = createRealSql();
    sql.exec(LEGACY_DDL);
    const store = new SqlUndoProposalStore(sql);
    store.insert(legacyRecord('req-old-real'));

    // Additive migration over the legacy table (PRAGMA detect + ALTER).
    initializeUndoProposalSchema(sql);
    initializeUndoProposalSchema(sql);

    const columns = [
      ...sql.exec<Record<string, unknown>>(`PRAGMA table_info(undo_proposals)`),
    ].map((row) => String(row.name ?? ''));
    expect(columns).toContain('target_json');
    // Pre-existing row survives with no projection (never invented).
    expect(store.get('req-old-real')?.targetJson).toBeUndefined();

    // New proposals persist the fixed display projection after migration.
    store.insert(legacyRecord('req-new-real'));
    expect(store.get('req-new-real')?.targetJson).toBe(JSON.stringify({ ...DISPLAY }));
  });
});
