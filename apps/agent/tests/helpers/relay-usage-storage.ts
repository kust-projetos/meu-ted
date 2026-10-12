/**
 * Shared in-memory Durable Object storage mock for relay usage-attempt tests.
 *
 * Models `ctx.storage` with a permissive `sql.exec` (empty ledgers read
 * zero, every unrelated table is a no-op miss) plus a synchronous
 * `transactionSync` that runs the callback inline. Attempt rows are tracked
 * in a Map so tests can assert reserve/finalize/release transitions. The
 * idempotent confirmation binding (`mutation_confirmations`) is modeled
 * faithfully (immutable CAS + tombstone reads + reserved-only settle)
 * because the financial confirmation path is fail-closed without it.
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

export type ConfirmationRow = {
  workspace_id: string;
  actor_id: string;
  device_id: string;
  intention_id: string;
  operation_id: string;
  receipt_json: string | null;
  created_at: string;
  expires_at: string;
  status: string;
};

// Review round 4 P1-A3: presentation binding row mirror.
export type PresentationRow = {
  workspace_id: string;
  actor_id: string;
  device_id: string;
  operation_id: string;
  presented_at: string;
  expires_at: string;
};

export const createRelayUsageStorage = (): RelayUsageTestStorage => {
  const legacy: LegacyRow[] = [];
  const attempts = new Map<string, AttemptRow>();
  const confirmations = new Map<string, ConfirmationRow>();
  // Review round 4 P1-A3: presentation binding mirror (first-wins). The
  // separator is a visible pipe (test shim only — production keys use NUL).
  const presentations = new Map<string, PresentationRow>();
  const presentationKey = (workspaceId: string, actorId: string, deviceId: string, operationId: string): string =>
    [workspaceId, actorId, deviceId, operationId].join('|');
  let transactionSyncCalls = 0;

  const confirmationKey = (workspaceId: string, actorId: string, deviceId: string, intentionId: string): string =>
    `${workspaceId}\u0000${actorId}\u0000${deviceId}\u0000${intentionId}`;

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
    // PR137-HARDEN: the idempotent confirmation binding is load-bearing for
    // the financial confirmation path (fail-closed without it), so the mock
    // models it faithfully instead of no-op missing: immutable CAS
    // (`DO NOTHING` + `RETURNING` verdict), first-sighting sentinels
    // (`noteConfirmationSighted`: 7-binding INSERT with `NULL` receipt and
    // `'reserved'` status literals), sentinel adoption (9-binding conditional UPDATE),
    // receipt-strip hygiene (single-binding UPDATE), tombstone reads (no
    // delete on expiry), and the reserved-only settle transition.
    if (q.startsWith('INSERT INTO mutation_confirmations')) {
      // P1-A/B round 3 (P2-C): the sighting INSERT carries 7 bindings with
      // `receipt_json = NULL` and `status = 'reserved'` as SQL LITERALS
      // (`VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'reserved')`), while the claim
      // INSERT carries 9 explicit bindings. Map by binding count exactly like
      // `memory-sql.ts` maps literals — never by position-assumption: the old
      // 8-position read shifted `created_at`/`expires_at` (timestamp became
      // receipt, expiry became createdAt, `expires_at` undefined).
      if (params.length === 7) {
        const [workspace_id, actor_id, device_id, intention_id, operation_id, created_at, expires_at] =
          params as [string, string, string, string, string, string, string];
        const key = confirmationKey(workspace_id, actor_id, device_id, intention_id);
        if (confirmations.has(key)) return [] as unknown as Iterable<T>;
        const row: ConfirmationRow = {
          workspace_id,
          actor_id,
          device_id,
          intention_id,
          operation_id,
          receipt_json: null,
          created_at,
          expires_at,
          status: 'reserved',
        };
        confirmations.set(key, row);
        return (q.includes('RETURNING') ? [{ ...row }] : []) as unknown as Iterable<T>;
      }
      // Claim carries 9 (explicit status). Same PK, same conflict.
      const [workspace_id, actor_id, device_id, intention_id, operation_id, receipt_json, created_at, expires_at] =
        params as [string, string, string, string, string, string | null, string, string];
      const status = params.length > 8 ? (params[8] as string) : 'reserved';
      const key = confirmationKey(workspace_id, actor_id, device_id, intention_id);
      if (confirmations.has(key)) return [] as unknown as Iterable<T>;
      const row: ConfirmationRow = {
        workspace_id,
        actor_id,
        device_id,
        intention_id,
        operation_id,
        receipt_json,
        created_at,
        expires_at,
        status,
      };
      confirmations.set(key, row);
      return (q.includes('RETURNING') ? [{ ...row }] : []) as unknown as Iterable<T>;
    }
    if (q.startsWith('SELECT * FROM mutation_confirmations WHERE')) {
      const [workspace_id, actor_id, device_id, intention_id] = params as [string, string, string, string];
      const row = confirmations.get(confirmationKey(workspace_id, actor_id, device_id, intention_id));
      return (row ? [{ ...row }] : []) as unknown as Iterable<T>;
    }
    if (q.startsWith('UPDATE mutation_confirmations SET receipt_json = NULL')) {
      // P1-3 (policy a) receipt-strip hygiene: never deletes the binding.
      const pruneBefore = params[0] as string;
      for (const row of confirmations.values()) {
        if (row.receipt_json !== null && row.expires_at <= pruneBefore) row.receipt_json = null;
      }
      return [] as unknown as Iterable<T>;
    }
    if (q.startsWith('UPDATE mutation_confirmations SET')) {
      if (params.length === 7) {
        // Settle: SET receipt_json = ?, status = ? WHERE identity + op + reserved.
        const [receipt_json, status, workspace_id, actor_id, device_id, intention_id, operation_id] =
          params as [string | null, string, string, string, string, string, string];
        const key = confirmationKey(workspace_id, actor_id, device_id, intention_id);
        const row = confirmations.get(key);
        if (!row || row.operation_id !== operation_id || row.status !== 'reserved') {
          return [] as unknown as Iterable<T>;
        }
        row.receipt_json = receipt_json;
        row.status = status;
        return (q.includes('RETURNING') ? [{ ...row }] : []) as unknown as Iterable<T>;
      }
      // Adoption: SET operation_id = ?, receipt_json = ?, expires_at = ?,
      // status = ? WHERE identity + `operation_id = ''` + reserved.
      const [operation_id, receipt_json, expires_at, status, workspace_id, actor_id, device_id, intention_id, expected_op] =
        params as [string, string | null, string, string, string, string, string, string, string];
      const key = confirmationKey(workspace_id, actor_id, device_id, intention_id);
      const row = confirmations.get(key);
      if (!row || row.operation_id !== expected_op || row.status !== 'reserved') {
        return [] as unknown as Iterable<T>;
      }
      row.operation_id = operation_id;
      row.receipt_json = receipt_json;
      row.expires_at = expires_at;
      row.status = status;
      return (q.includes('RETURNING') ? [{ ...row }] : []) as unknown as Iterable<T>;
    }
    if (q.startsWith('DELETE FROM mutation_confirmations WHERE expires_at <=')) {
      const pruneBefore = params[0] as string;
      for (const [key, row] of confirmations) {
        if (row.expires_at <= pruneBefore) confirmations.delete(key);
      }
      return [] as unknown as Iterable<T>;
    }
    // Review round 4 P1-A3: presentation binding (first-wins + read +
    // retention prune), faithful like the confirmations above — the
    // financial confirmation path is fail-closed without it.
    if (q.startsWith('INSERT INTO mutation_confirmation_presentations')) {
      const [workspace_id, actor_id, device_id, operation_id, presented_at, expires_at] =
        params as [string, string, string, string, string, string];
      const key = presentationKey(workspace_id, actor_id, device_id, operation_id);
      if (!presentations.has(key)) {
        presentations.set(key, { workspace_id, actor_id, device_id, operation_id, presented_at, expires_at });
      }
      return [] as unknown as Iterable<T>;
    }
    if (q.startsWith('SELECT * FROM mutation_confirmation_presentations WHERE')) {
      // Round 5 entry snapshot: 3-leg listing (no operation_id) enumerates
      // the identity's present-set; 4-leg fetch reads one record back.
      if (params.length === 3) {
        const [workspace_id, actor_id, device_id] = params as [string, string, string];
        return [...presentations.values()]
          .filter((row) => row.workspace_id === workspace_id && row.actor_id === actor_id && row.device_id === device_id)
          .map((row) => ({ ...row })) as unknown as Iterable<T>;
      }
      const [workspace_id, actor_id, device_id, operation_id] = params as [string, string, string, string];
      const row = presentations.get(presentationKey(workspace_id, actor_id, device_id, operation_id));
      return (row ? [{ ...row }] : []) as unknown as Iterable<T>;
    }
    if (q.startsWith('DELETE FROM mutation_confirmation_presentations WHERE')) {
      const pruneBefore = params[0] as string;
      for (const [key, row] of presentations) {
        if (row.expires_at <= pruneBefore) presentations.delete(key);
      }
      return [] as unknown as Iterable<T>;
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
