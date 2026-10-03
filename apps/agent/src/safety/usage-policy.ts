export type UsagePolicy = {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequestsPerWindow: number;
  windowSeconds: number;
  dailyBudget: number;
  actorDailyBudget: number;
};

/**
 * FIX-AGENT-QUOTA-SIZING — budget units are RELAY LEG reservations, not chat
 * turns: before each dispatch every relay leg reserves
 * `estimateTokens(system + prompt) + maxOutputTokens`, with the transmitted
 * payload bounded at 7 900 system chars + 15 000 prompt chars (estimated
 * input ≈ 5 725) plus the 2 000 max-output reservation — up to ≈ 7 725 tokens
 * per leg. A single user turn can hold several legs (primary, fallback,
 * grounding correction) and a dispatched failure retains the full reservation
 * (unchanged policy), so the previous 10 000 / 20 000 budgets were exhausted
 * by 1–2 user turns and every later turn answered 429
 * `agent.quota_exceeded`. 200 000 ≈ 25 worst-case legs per actor per day and
 * 400 000 per workspace: still a hard anti-DoS bound, and successful legs
 * reconcile downward to real usage in `finalizeUsageAttempt`, so the counted
 * day is bounded by actual consumption, not by the reservation ceiling.
 */
export const DEFAULT_POLICY: UsagePolicy = {
  maxInputTokens: 2000,
  maxOutputTokens: 2000,
  maxRequestsPerWindow: 20,
  windowSeconds: 60,
  dailyBudget: 400_000,
  actorDailyBudget: 200_000,
};

export const estimateTokens = (text: string): number => {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
};

export const initializeUsageSchema = (sql: { exec(query: string): unknown }): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      intention_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_actor ON usage_ledger(actor_id);
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_created ON usage_ledger(created_at);
  `);
};

export const checkUsageLimit = (
  sql: { exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> },
  actorId: string,
  estimatedInputTokens: number,
  policy: UsagePolicy = DEFAULT_POLICY,
): { allowed: boolean; reason?: string } => {
  if (estimatedInputTokens > policy.maxInputTokens) {
    return {
      allowed: false,
      reason: `Message exceeds maximum allowed input token limit of ${policy.maxInputTokens} (estimated: ${estimatedInputTokens})`,
    };
  }

  // 1. Rate limit check: requests within the sliding window
  const windowSecs = policy.windowSeconds ?? 60;
  const rateRows = [...sql.exec<{ req_count: number }>(`
    SELECT COUNT(*) AS req_count
    FROM usage_ledger
    WHERE datetime(created_at) >= datetime('now', '-${windowSecs} seconds')
  `)];
  const currentRequests = Number(rateRows[0]?.req_count ?? 0);
  if (currentRequests >= policy.maxRequestsPerWindow) {
    return {
      allowed: false,
      reason: `Rate limit exceeded: ${currentRequests}/${policy.maxRequestsPerWindow} requests in the last ${windowSecs}s`,
    };
  }

  // 2. Aggregate workspace daily budget check (past 24h)
  const workspaceRows = [...sql.exec<{ total_tokens: number }>(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
    FROM usage_ledger
    WHERE datetime(created_at) >= datetime('now', '-1 day')
  `)];
  const totalWorkspaceUsed = Number(workspaceRows[0]?.total_tokens ?? 0);
  if (totalWorkspaceUsed + estimatedInputTokens > policy.dailyBudget) {
    return {
      allowed: false,
      reason: `Daily token budget of ${policy.dailyBudget} exceeded (used: ${totalWorkspaceUsed}, attempted: ${estimatedInputTokens})`,
    };
  }

  // 3. Actor sub-limit check (past 24h)
  const actorRows = [...sql.exec<{ actor_tokens: number }>(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS actor_tokens
    FROM usage_ledger
    WHERE actor_id = ? AND datetime(created_at) >= datetime('now', '-1 day')
  `, actorId)];
  const totalActorUsed = Number(actorRows[0]?.actor_tokens ?? 0);
  if (totalActorUsed + estimatedInputTokens > policy.actorDailyBudget) {
    return {
      allowed: false,
      reason: `Actor daily token budget of ${policy.actorDailyBudget} exceeded (used: ${totalActorUsed}, attempted: ${estimatedInputTokens})`,
    };
  }

  return { allowed: true };
};

export const recordUsage = (
  sql: { exec(query: string, ...params: unknown[]): unknown },
  actorId: string,
  intentionId: string,
  inputTokens: number,
  outputTokens: number,
  costCents = 0,
): void => {
  sql.exec(
    `INSERT INTO usage_ledger (actor_id, intention_id, input_tokens, output_tokens, cost_cents, created_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    actorId,
    intentionId,
    inputTokens,
    outputTokens,
    costCents,
  );
};

// ---------------------------------------------------------------------------
// Per-provider-attempt usage reservations (transport-independent primitives).
//
// Policy (user-approved): every provider transport dispatch counts. Reserve
// estimated full input + max output before dispatch, reconcile to reliable
// success usage, retain the full reservation after dispatched failures or
// unknown usage, and never count a proven pre-dispatch rejection.
// ---------------------------------------------------------------------------

export type UsageAttemptState = 'reserved' | 'settled' | 'not_dispatched';

export type UsageAttemptRow = {
  attempt_id: string;
  actor_id: string;
  intention_id: string;
  reserve_input_tokens: number;
  reserve_output_tokens: number;
  state: UsageAttemptState;
  counted_input_tokens: number;
  counted_output_tokens: number;
  created_at: string;
  updated_at: string;
};

export type UsageAttemptStorage = {
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T>;
  transactionSync<T>(fn: () => T): T;
};

export type ReserveUsageAttemptInput = {
  actorId: string;
  intentionId: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  attemptId?: string;
};

export type ReserveUsageAttemptResult = { allowed: boolean; attemptId?: string; reason?: string };

/** Upper bound for reservation inputs (overflow guard, not an estimate). */
export const MAX_USAGE_TOKENS_PER_FIELD = 1_000_000;

/** Saturating value for reliable overflow actuals: blocks future budgets instead of undercounting. */
export const SATURATING_USAGE_TOKENS = Number.MAX_SAFE_INTEGER;

const isValidReservationCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= MAX_USAGE_TOKENS_PER_FIELD;

const isSafeNonNegativeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && (value as number) >= 0;

const isOverflowTokenCount = (value: unknown): boolean =>
  typeof value === 'number' &&
  ((value as number) === Number.POSITIVE_INFINITY ||
    (Number.isInteger(value as number) && (value as number) >= 0 && !Number.isSafeInteger(value as number)));

const generateAttemptId = (): string => {
  try {
    const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/** Additive schema: never touches the legacy `usage_ledger` table. */
export const initializeUsageAttemptSchema = (sql: { exec(query: string): unknown }): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS usage_attempts (
      attempt_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      intention_id TEXT NOT NULL,
      reserve_input_tokens INTEGER NOT NULL,
      reserve_output_tokens INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'reserved',
      counted_input_tokens INTEGER NOT NULL,
      counted_output_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_attempts_actor ON usage_attempts(actor_id);
    CREATE INDEX IF NOT EXISTS idx_usage_attempts_created ON usage_attempts(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_attempts_state ON usage_attempts(state);
  `);
};

export const getUsageAttempt = (
  sql: { exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> },
  attemptId: string,
): UsageAttemptRow | null => {
  const rows = [...sql.exec<UsageAttemptRow>(`SELECT * FROM usage_attempts WHERE attempt_id = ? LIMIT 1`, attemptId)];
  return rows[0] ?? null;
};

/**
 * Atomically checks budgets and inserts a `reserved` attempt row.
 * `transactionSync` is required (Cloudflare `ctx.storage.transactionSync`);
 * without it the call fails closed BEFORE any SQL budget read or insert, so
 * there is no non-atomic direct-run fallback. The callback is short and fully
 * synchronous (no awaits). A duplicate `attemptId` never returns a fresh
 * dispatch authorization.
 */
export const reserveUsageAttempt = (
  storage: UsageAttemptStorage,
  input: ReserveUsageAttemptInput,
  policy: UsagePolicy = DEFAULT_POLICY,
): ReserveUsageAttemptResult => {
  const tx = (storage as { transactionSync?: unknown }).transactionSync;
  if (typeof tx !== 'function') {
    return { allowed: false, reason: 'Usage reservation requires transactionSync for an atomic check-and-reserve' };
  }
  const { actorId, intentionId, estimatedInputTokens, maxOutputTokens } = input;
  if (typeof actorId !== 'string' || actorId.length === 0) {
    return { allowed: false, reason: 'Invalid actor id for usage reservation' };
  }
  if (typeof intentionId !== 'string' || intentionId.length === 0) {
    return { allowed: false, reason: 'Invalid intention id for usage reservation' };
  }
  if (!isValidReservationCount(estimatedInputTokens) || !isValidReservationCount(maxOutputTokens)) {
    return { allowed: false, reason: 'Invalid token counts for usage reservation: expected bounded nonnegative integers' };
  }
  if (estimatedInputTokens > policy.maxInputTokens) {
    return {
      allowed: false,
      reason: `Message exceeds maximum allowed input token limit of ${policy.maxInputTokens} (estimated: ${estimatedInputTokens})`,
    };
  }
  if (maxOutputTokens > policy.maxOutputTokens) {
    return {
      allowed: false,
      reason: `Message exceeds maximum allowed output token limit of ${policy.maxOutputTokens} (reserved: ${maxOutputTokens})`,
    };
  }
  const candidateId = input.attemptId && input.attemptId.length > 0 ? input.attemptId : generateAttemptId();
  const reservationTokens = estimatedInputTokens + maxOutputTokens;
  const windowSecs = policy.windowSeconds ?? 60;

  const run = (): ReserveUsageAttemptResult => {
    const existing = [...storage.exec<UsageAttemptRow>(`SELECT 1 FROM usage_attempts WHERE attempt_id = ?`, candidateId)];
    if (existing.length > 0) {
      return { allowed: false, reason: `Duplicate usage attempt id: ${candidateId}`, attemptId: candidateId };
    }

    const legacyRate = [...storage.exec<{ req_count: number }>(`
      SELECT COUNT(*) AS req_count
      FROM usage_ledger
      WHERE datetime(created_at) >= datetime('now', '-${windowSecs} seconds')
    `)];
    const attemptRate = [...storage.exec<{ attempt_count: number }>(`
      SELECT COUNT(*) AS attempt_count
      FROM usage_attempts
      WHERE state != 'not_dispatched' AND datetime(created_at) >= datetime('now', '-${windowSecs} seconds')
    `)];
    const currentRequests = Number(legacyRate[0]?.req_count ?? 0) + Number(attemptRate[0]?.attempt_count ?? 0);
    if (currentRequests >= policy.maxRequestsPerWindow) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${currentRequests}/${policy.maxRequestsPerWindow} requests in the last ${windowSecs}s`,
      };
    }

    const legacyWorkspace = [...storage.exec<{ total_tokens: number }>(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM usage_ledger
      WHERE datetime(created_at) >= datetime('now', '-1 day')
    `)];
    const attemptWorkspace = [...storage.exec<{ attempt_tokens: number }>(`
      SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN counted_input_tokens + counted_output_tokens ELSE reserve_input_tokens + reserve_output_tokens END), 0) AS attempt_tokens
      FROM usage_attempts
      WHERE state != 'not_dispatched' AND datetime(created_at) >= datetime('now', '-1 day')
    `)];
    const workspaceUsed = Number(legacyWorkspace[0]?.total_tokens ?? 0) + Number(attemptWorkspace[0]?.attempt_tokens ?? 0);
    if (workspaceUsed + reservationTokens > policy.dailyBudget) {
      return {
        allowed: false,
        reason: `Daily token budget of ${policy.dailyBudget} exceeded (used: ${workspaceUsed}, attempted: ${reservationTokens})`,
      };
    }

    const legacyActor = [...storage.exec<{ actor_tokens: number }>(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS actor_tokens
      FROM usage_ledger
      WHERE actor_id = ? AND datetime(created_at) >= datetime('now', '-1 day')
    `, actorId)];
    const attemptActor = [...storage.exec<{ attempt_tokens: number }>(`
      SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN counted_input_tokens + counted_output_tokens ELSE reserve_input_tokens + reserve_output_tokens END), 0) AS attempt_tokens
      FROM usage_attempts
      WHERE state != 'not_dispatched' AND actor_id = ? AND datetime(created_at) >= datetime('now', '-1 day')
    `, actorId)];
    const actorUsed = Number(legacyActor[0]?.actor_tokens ?? 0) + Number(attemptActor[0]?.attempt_tokens ?? 0);
    if (actorUsed + reservationTokens > policy.actorDailyBudget) {
      return {
        allowed: false,
        reason: `Actor daily token budget of ${policy.actorDailyBudget} exceeded (used: ${actorUsed}, attempted: ${reservationTokens})`,
      };
    }

    // The duplicate `attemptId` is already rejected by the SELECT above inside
    // the same atomic transaction: any INSERT exception is an operational
    // storage failure and must propagate (never masquerade as a duplicate).
    storage.exec(
      `INSERT INTO usage_attempts (attempt_id, actor_id, intention_id, reserve_input_tokens, reserve_output_tokens, state, counted_input_tokens, counted_output_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      candidateId,
      actorId,
      intentionId,
      estimatedInputTokens,
      maxOutputTokens,
      'reserved',
      estimatedInputTokens,
      maxOutputTokens,
    );
    return { allowed: true, attemptId: candidateId };
  };

  if (typeof storage.transactionSync === 'function') return storage.transactionSync(run);
  return { allowed: false, reason: 'Usage reservation requires transactionSync for an atomic check-and-reserve' };
};

export type FinalizeUsageAttemptActual = {
  inputTokens: number;
  outputTokens: number;
};

export type FinalizeUsageAttemptResult = {
  row: UsageAttemptRow | null;
  transitioned: boolean;
};

const resolveCountedTokens = (
  current: UsageAttemptRow,
  actual: FinalizeUsageAttemptActual | null | undefined,
  reliable: boolean,
): { countedIn: number; countedOut: number } => {
  if (reliable && actual !== null && actual !== undefined) {
    const inSafe = isSafeNonNegativeInt(actual.inputTokens);
    const outSafe = isSafeNonNegativeInt(actual.outputTokens);
    // Reliable safe integers are recorded verbatim, even above the
    // reservation and above the 1M reservation bound. No invented tokens.
    if (inSafe && outSafe) return { countedIn: actual.inputTokens, countedOut: actual.outputTokens };
    const inOverflow = isOverflowTokenCount(actual.inputTokens);
    const outOverflow = isOverflowTokenCount(actual.outputTokens);
    // Reliable overflow (e.g. Infinity or integer-valued counts beyond
    // MAX_SAFE_INTEGER) saturates to block future reservations rather than
    // undercounting with the smaller reservation.
    if ((inSafe || inOverflow) && (outSafe || outOverflow)) {
      return {
        countedIn: inSafe ? actual.inputTokens : SATURATING_USAGE_TOKENS,
        countedOut: outSafe ? actual.outputTokens : SATURATING_USAGE_TOKENS,
      };
    }
  }
  return { countedIn: current.reserve_input_tokens, countedOut: current.reserve_output_tokens };
};

/**
 * Settles a `reserved` attempt. Reliable, safe-nonnegative-integer actuals
 * reconcile the counted tokens verbatim (even above the reservation);
 * reliable overflow saturates instead of undercounting; absent, malformed,
 * or untrusted usage conservatively keeps the full reservation (dispatched
 * failures included). The conditional `UPDATE ... WHERE state = 'reserved'
 * RETURNING *` is the sole definition of the transition winner: only the
 * caller whose UPDATE returns a row reports `{ transitioned: true }`. A
 * caller whose UPDATE returns no row lost the race (including concurrent
 * same-value transitions) and gets `{ transitioned: false }` with the
 * current persisted row, never a false success.
 */
export const finalizeUsageAttempt = (
  sql: { exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> },
  attemptId: string,
  actual?: FinalizeUsageAttemptActual | null,
  opts?: { reliable?: boolean },
): FinalizeUsageAttemptResult => {
  const current = getUsageAttempt(sql, attemptId);
  if (!current) return { row: null, transitioned: false };
  if (current.state !== 'reserved') return { row: current, transitioned: false };
  const reliable = opts?.reliable === true;
  const { countedIn, countedOut } = resolveCountedTokens(current, actual, reliable);
  const updated = [
    ...sql.exec<UsageAttemptRow>(
      `UPDATE usage_attempts SET state = 'settled', counted_input_tokens = ?, counted_output_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE attempt_id = ? AND state = 'reserved' RETURNING *`,
      countedIn,
      countedOut,
      attemptId,
    ),
  ];
  if (updated.length > 0) return { row: updated[0], transitioned: true };
  const persisted = getUsageAttempt(sql, attemptId);
  if (!persisted) return { row: null, transitioned: false };
  return { row: persisted, transitioned: false };
};

export type ReleaseUsageAttemptProof =
  | { kind: 'pre_dispatch' }
  | { kind: 'relay_confirmed_not_dispatched'; reliable: true };

const isValidReleaseProof = (proof: unknown): proof is ReleaseUsageAttemptProof => {
  if (typeof proof !== 'object' || proof === null) return false;
  const kind = (proof as { kind?: unknown }).kind;
  if (kind === 'pre_dispatch') return true;
  if (kind === 'relay_confirmed_not_dispatched') {
    return (proof as { reliable?: unknown }).reliable === true;
  }
  return false;
};

/**
 * Releases a `reserved` attempt only with explicit proof that dispatch never
 * happened (`pre_dispatch`, or trusted `relay_confirmed_not_dispatched`).
 * Timeout/unknown results are NOT proofs: callers holding them must
 * finalize (retaining the reservation), never release. The conditional
 * `UPDATE ... WHERE state = 'reserved' RETURNING *` is the sole definition
 * of the release winner: only the caller whose UPDATE returns a row reports
 * `{ released: true }`. Lost races (including concurrent same-proof
 * releases), settled rows, unknown ids, and missing/invalid proofs report
 * `{ released: false }` with the actual persisted state, never a false
 * success.
 */
export const releaseUsageAttempt = (
  sql: { exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> },
  attemptId: string,
  proof: ReleaseUsageAttemptProof,
): { released: boolean; state?: UsageAttemptState; reason?: string } => {
  if (!isValidReleaseProof(proof)) {
    const current = typeof attemptId === 'string' && attemptId.length > 0 ? getUsageAttempt(sql, attemptId) : null;
    return {
      released: false,
      state: current?.state,
      reason: 'Usage release requires explicit pre-dispatch proof (pre_dispatch or trusted relay_confirmed_not_dispatched)',
    };
  }
  const current = getUsageAttempt(sql, attemptId);
  if (!current) return { released: false };
  if (current.state !== 'reserved') return { released: false, state: current.state };
  const updated = [
    ...sql.exec<UsageAttemptRow>(
      `UPDATE usage_attempts SET state = 'not_dispatched', counted_input_tokens = 0, counted_output_tokens = 0, updated_at = CURRENT_TIMESTAMP WHERE attempt_id = ? AND state = 'reserved' RETURNING *`,
      attemptId,
    ),
  ];
  if (updated.length > 0 && updated[0]?.state === 'not_dispatched') {
    return { released: true, state: 'not_dispatched' };
  }
  const persisted = getUsageAttempt(sql, attemptId);
  return { released: false, state: persisted?.state ?? current.state };
};
