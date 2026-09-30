/**
 * Shared in-memory Durable Object storage mock for relay usage-attempt tests.
 *
 * Models `ctx.storage` with a permissive `sql.exec` (empty ledgers read
 * zero, every unrelated table is a no-op miss) plus a synchronous
 * `transactionSync` that runs the callback inline. Attempt rows are tracked
 * in a Map so tests can assert reserve/finalize/release transitions.
 */
export type AttemptRowState = 'reserved' | 'settled' | 'not_dispatched';

export type AttemptRow = {
  attempt_id: string;
  actor_id: string;
  intention_id: string;
  reserve_input_tokens: number;
  reserve_output_tokens: number;
  state: AttemptRowState;
  counted_input_tokens: number;
  counted_output_tokens: number;
  created_at: string;
  updated_at: string;
};

export type LegacyRow = {
  actor_id: string;
  intention_id: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
};

export type RelayUsageTestStorage = {
  exec: <T = Record<string, unknown>>(query: string, ...params: unknown[]) => Iterable<T>;
  transactionSync: <T>(fn: () => T) => T;
  __state: { legacy: LegacyRow[]; attempts: Map<string, AttemptRow> };
  __transactionSyncCalls: () => number;
};

const nowIso = (): string => new Date().toISOString();

export const createRelayUsageStorage = (): RelayUsageTestStorage => {
  const legacy: LegacyRow[] = [];
  const attempts = new Map<string, AttemptRow>();
  let transactionSyncCalls = 0;

  const exec = (<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
    const q = query.trim().replace(/\s+/g, ' ');
    if (q.includes('CREATE TABLE') || q.includes('CREATE INDEX')) return [] as unknown as Iterable<T>;
    if (q.startsWith('INSERT INTO usage_ledger')) {
      const [actor_id, intention_id, input_tokens, output_tokens] = params as [string, string, number, number];
      legacy.push({ actor_id, intention_id, input_tokens, output_tokens, created_at: nowIso() });
      return [] as unknown as Iterable<T>;
    }
    if (q.startsWith('INSERT INTO usage_attempts')) {
      const [attempt_id, actor_id, intention_id, reserve_in, reserve_out, state, counted_in, counted_out] =
        params as [string, string, string, number, number, AttemptRowState, number, number];
      if (attempts.has(attempt_id)) {
        throw new Error(`UNIQUE constraint failed: usage_attempts.attempt_id (${attempt_id})`);
      }
      attempts.set(attempt_id, {
        attempt_id,
        actor_id,
        intention_id,
        reserve_input_tokens: reserve_in,
        reserve_output_tokens: reserve_out,
        state,
        counted_input_tokens: counted_in,
        counted_output_tokens: counted_out,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return [] as unknown as Iterable<T>;
    }
    if (q.startsWith('SELECT 1 FROM usage_attempts') || q.startsWith('SELECT * FROM usage_attempts WHERE attempt_id')) {
      const row = attempts.get(params[0] as string);
      return (row ? [{ ...row }] : []) as unknown as Iterable<T>;
    }
    if (q.includes('FROM usage_attempts') && q.includes('COUNT(*)')) {
      const active = [...attempts.values()].filter((r) => r.state !== 'not_dispatched').length;
      return [{ attempt_count: active }] as unknown as Iterable<T>;
    }
    if (q.includes('FROM usage_attempts') && q.includes('SUM(')) {
      const onlyActor = q.includes('actor_id = ?');
      const actorId = onlyActor ? (params[0] as string) : null;
      const sum = [...attempts.values()]
        .filter((r) => r.state !== 'not_dispatched')
        .filter((r) => (actorId === null ? true : r.actor_id === actorId))
        .reduce((acc, r) => {
          if (r.state === 'settled') return acc + r.counted_input_tokens + r.counted_output_tokens;
          return acc + r.reserve_input_tokens + r.reserve_output_tokens;
        }, 0);
      return [{ attempt_tokens: sum }] as unknown as Iterable<T>;
    }
    if (q.startsWith('UPDATE usage_attempts SET')) {
      const attemptId = params[params.length - 1] as string;
      const row = attempts.get(attemptId);
      if (!row) return [] as unknown as Iterable<T>;
      if (q.includes("state = 'settled'")) {
        if (row.state !== 'reserved') return [] as unknown as Iterable<T>;
        row.state = 'settled';
        row.counted_input_tokens = params[0] as number;
        row.counted_output_tokens = params[1] as number;
        row.updated_at = nowIso();
        return q.includes('RETURNING') ? ([{ ...row }] as unknown as Iterable<T>) : ([] as unknown as Iterable<T>);
      }
      if (q.includes("state = 'not_dispatched'")) {
        if (row.state !== 'reserved') return [] as unknown as Iterable<T>;
        row.state = 'not_dispatched';
        row.counted_input_tokens = 0;
        row.counted_output_tokens = 0;
        row.updated_at = nowIso();
        return q.includes('RETURNING') ? ([{ ...row }] as unknown as Iterable<T>) : ([] as unknown as Iterable<T>);
      }
      return [] as unknown as Iterable<T>;
    }
    if (q.includes('SELECT COUNT(*) AS req_count')) {
      return [{ req_count: legacy.length }] as unknown as Iterable<T>;
    }
    if (q.includes('WHERE actor_id = ?')) {
      const actorId = params[0] as string;
      const sum = legacy
        .filter((r) => r.actor_id === actorId)
        .reduce((acc, r) => acc + r.input_tokens + r.output_tokens, 0);
      return [{ actor_tokens: sum }] as unknown as Iterable<T>;
    }
    if (q.includes('SELECT COALESCE(SUM')) {
      const sum = legacy.reduce((acc, r) => acc + r.input_tokens + r.output_tokens, 0);
      return [{ total_tokens: sum }] as unknown as Iterable<T>;
    }
    // Unrelated tables (intention snapshots, drafts, undo, memory): miss / no-op.
    return [] as unknown as Iterable<T>;
  }) as <T = Record<string, unknown>>(query: string, ...params: unknown[]) => Iterable<T>;

  return {
    exec,
    transactionSync: <T>(fn: () => T): T => {
      transactionSyncCalls += 1;
      return fn();
    },
    __state: { legacy, attempts },
    __transactionSyncCalls: () => transactionSyncCalls,
  };
};

/** Defines `ctx.storage` ({ sql, transactionSync }) on a prototype-built agent. */
export const attachRelayUsageStorage = (
  agent: object,
  storage: RelayUsageTestStorage = createRelayUsageStorage(),
): RelayUsageTestStorage => {
  Object.defineProperty(agent, 'ctx', {
    value: { storage: { sql: { exec: storage.exec }, transactionSync: storage.transactionSync } },
    writable: true,
    configurable: true,
  });
  return storage;
};
