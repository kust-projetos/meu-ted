import { describe, expect, it } from 'vitest';
import {
  checkUsageLimit,
  estimateTokens,
  finalizeUsageAttempt,
  getUsageAttempt,
  initializeUsageAttemptSchema,
  initializeUsageSchema,
  recordUsage,
  releaseUsageAttempt,
  reserveUsageAttempt,
  type UsagePolicy,
} from '../src/safety/usage-policy.js';

describe('Usage Policy & Token Budget (Task 5 & 7)', () => {
  const createMockSql = () => {
    const rows: Array<{ actor_id: string; intention_id: string; input_tokens: number; output_tokens: number; cost_cents: number; created_at: string }> = [];
    return {
      exec: <T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
        if (query.includes('CREATE TABLE') || query.includes('CREATE INDEX')) {
          return [] as Iterable<T>;
        }
        if (query.includes('INSERT INTO usage_ledger')) {
          const [actor_id, intention_id, input_tokens, output_tokens, cost_cents] = params as [string, string, number, number, number];
          rows.push({
            actor_id,
            intention_id,
            input_tokens,
            output_tokens,
            cost_cents,
            created_at: new Date().toISOString(),
          });
          return [] as Iterable<T>;
        }
        if (query.includes('SELECT COUNT(*) AS req_count')) {
          return [{ req_count: rows.length }] as unknown as Iterable<T>;
        }
        if (query.includes('WHERE actor_id = ?')) {
          const actorId = params[0] as string;
          const sum = rows.filter((r) => r.actor_id === actorId).reduce((acc, r) => acc + r.input_tokens + r.output_tokens, 0);
          return [{ actor_tokens: sum }] as unknown as Iterable<T>;
        }
        if (query.includes('SELECT COALESCE(SUM')) {
          const sum = rows.reduce((acc, r) => acc + r.input_tokens + r.output_tokens, 0);
          return [{ total_tokens: sum }] as unknown as Iterable<T>;
        }
        return [] as Iterable<T>;
      },
    };
  };

  it('estimates tokens based on text length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('enforces single turn input token limits', () => {
    const sql = createMockSql();
    const policy: UsagePolicy = {
      maxInputTokens: 500,
      maxOutputTokens: 500,
      maxRequestsPerWindow: 10,
      windowSeconds: 60,
      dailyBudget: 5000,
      actorDailyBudget: 2500,
    };

    // Within limit
    expect(checkUsageLimit(sql, 'user-1', 400, policy)).toEqual({ allowed: true });

    // Exceeds single turn limit
    const res = checkUsageLimit(sql, 'user-1', 600, policy);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('exceeds maximum allowed input token limit');
  });

  it('enforces aggregate daily token budget', () => {
    const sql = createMockSql();
    initializeUsageSchema(sql);

    const policy: UsagePolicy = {
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxRequestsPerWindow: 20,
      windowSeconds: 60,
      dailyBudget: 2000,
      actorDailyBudget: 1500,
    };

    // First request: 800 input + 800 output = 1600 tokens recorded
    recordUsage(sql, 'user-1', 'intent-1', 800, 800);

    // Attempt next request of 500 tokens: 1600 + 500 = 2100 > 2000 budget
    const check = checkUsageLimit(sql, 'user-1', 500, policy);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Daily token budget of 2000 exceeded');
  });

  it('enforces actor sub-budget within daily limit', () => {
    const sql = createMockSql();
    initializeUsageSchema(sql);

    const policy: UsagePolicy = {
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxRequestsPerWindow: 20,
      windowSeconds: 60,
      dailyBudget: 10000,
      actorDailyBudget: 1000,
    };

    // Actor 1 records 800 tokens
    recordUsage(sql, 'user-1', 'intent-1', 400, 400);

    // Actor 1 tries 300 tokens: 800 + 300 = 1100 > 1000 actor sub-budget
    const check = checkUsageLimit(sql, 'user-1', 300, policy);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Actor daily token budget of 1000 exceeded');
  });
});

describe('Usage attempt ledger (per-provider-attempt reservations)', () => {
  type AttemptRow = {
    attempt_id: string;
    actor_id: string;
    intention_id: string;
    reserve_input_tokens: number;
    reserve_output_tokens: number;
    state: string;
    counted_input_tokens: number;
    counted_output_tokens: number;
    created_at: string;
    updated_at: string;
  };
  type LegacyRow = { actor_id: string; intention_id: string; input_tokens: number; output_tokens: number; created_at: string };

  const generousPolicy: UsagePolicy = {
    maxInputTokens: 2000,
    maxOutputTokens: 2000,
    maxRequestsPerWindow: 20,
    windowSeconds: 60,
    dailyBudget: 20000,
    actorDailyBudget: 10000,
  };

  const createAttemptSql = () => {
    const legacy: LegacyRow[] = [];
    const attempts = new Map<string, AttemptRow>();
    const nowIso = () => new Date().toISOString();
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
        const [attempt_id, actor_id, intention_id, reserve_in, reserve_out, state, counted_in, counted_out] = params as [
          string, string, string, number, number, string, number, number,
        ];
        if (attempts.has(attempt_id)) throw new Error(`UNIQUE constraint failed: usage_attempts.attempt_id (${attempt_id})`);
        attempts.set(attempt_id, {
          attempt_id, actor_id, intention_id,
          reserve_input_tokens: reserve_in, reserve_output_tokens: reserve_out,
          state, counted_input_tokens: counted_in, counted_output_tokens: counted_out,
          created_at: nowIso(), updated_at: nowIso(),
        });
        return [] as unknown as Iterable<T>;
      }
      if (q.startsWith('SELECT 1 FROM usage_attempts') || q.startsWith('SELECT * FROM usage_attempts WHERE attempt_id')) {
        const row = attempts.get(params[0] as string);
        return (row ? [row] : []) as unknown as Iterable<T>;
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
        return (onlyActor ? [{ attempt_tokens: sum }] : [{ attempt_tokens: sum }]) as unknown as Iterable<T>;
      }
      if (q.startsWith('UPDATE usage_attempts SET')) {
        const norm = q;
        const wantsReturning = norm.includes('RETURNING');
        const attemptId = params[params.length - 1] as string;
        const row = attempts.get(attemptId);
        if (!row) return [] as unknown as Iterable<T>;
        if (norm.includes("state = 'settled'")) {
          if (row.state !== 'reserved') return [] as unknown as Iterable<T>;
          row.state = 'settled';
          row.counted_input_tokens = params[0] as number;
          row.counted_output_tokens = params[1] as number;
          row.updated_at = nowIso();
          if (wantsReturning) return [{ ...row }] as unknown as Iterable<T>;
        } else if (norm.includes("state = 'not_dispatched'")) {
          if (row.state === 'reserved') {
            row.state = 'not_dispatched';
            row.counted_input_tokens = 0;
            row.counted_output_tokens = 0;
            row.updated_at = nowIso();
            if (wantsReturning) return [{ ...row }] as unknown as Iterable<T>;
          }
        }
        return [] as unknown as Iterable<T>;
      }
      if (q.includes('SELECT COUNT(*) AS req_count')) {
        return [{ req_count: legacy.length }] as unknown as Iterable<T>;
      }
      if (q.includes('WHERE actor_id = ?')) {
        const actorId = params[0] as string;
        const sum = legacy.filter((r) => r.actor_id === actorId).reduce((acc, r) => acc + r.input_tokens + r.output_tokens, 0);
        return [{ actor_tokens: sum }] as unknown as Iterable<T>;
      }
      if (q.includes('SELECT COALESCE(SUM')) {
        const sum = legacy.reduce((acc, r) => acc + r.input_tokens + r.output_tokens, 0);
        return [{ total_tokens: sum }] as unknown as Iterable<T>;
      }
      return [] as unknown as Iterable<T>;
    }) as <T = Record<string, unknown>>(query: string, ...params: unknown[]) => Iterable<T>;
    const storage = {
      exec,
      transactionSync: <T>(fn: () => T): T => {
        transactionSyncCalls += 1;
        return fn();
      },
      __state: { legacy, attempts },
      __transactionSyncCalls: () => transactionSyncCalls,
    };
    return storage;
  };

  it('creates the additive attempt table without touching the legacy ledger', () => {
    const storage = createAttemptSql();
    initializeUsageSchema(storage);
    initializeUsageAttemptSchema(storage);
    expect(storage.__state.legacy).toHaveLength(0);
    const res = reserveUsageAttempt(storage, {
      actorId: 'actor-1', intentionId: 'intent-1', estimatedInputTokens: 100, maxOutputTokens: 50,
    }, generousPolicy);
    expect(res.allowed).toBe(true);
    expect(res.attemptId).toBeTruthy();
    // Legacy ledger untouched by the reservation path.
    expect(storage.__state.legacy).toHaveLength(0);
    const row = getUsageAttempt(storage, res.attemptId!);
    expect(row?.state).toBe('reserved');
    expect(row && 'cost_cents' in (row as object)).toBe(false);
  });

  it('reserves estimated input + max output and runs the check atomically in transactionSync', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    const res = reserveUsageAttempt(storage, {
      actorId: 'actor-1', intentionId: 'intent-1', estimatedInputTokens: 120, maxOutputTokens: 80,
    }, generousPolicy);
    expect(res.allowed).toBe(true);
    expect(storage.__transactionSyncCalls()).toBe(1);
    const row = getUsageAttempt(storage, res.attemptId!);
    expect(row?.reserve_input_tokens).toBe(120);
    expect(row?.reserve_output_tokens).toBe(80);
    expect(row?.counted_input_tokens).toBe(120);
    expect(row?.counted_output_tokens).toBe(80);
  });

  it('rejects over-limit input/output and non-integer or negative values without inventing tokens', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    expect(reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 2001, maxOutputTokens: 10,
    }, generousPolicy).allowed).toBe(false);
    expect(reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 10, maxOutputTokens: 2001,
    }, generousPolicy).allowed).toBe(false);
    expect(reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: -5, maxOutputTokens: 10,
    }, generousPolicy).allowed).toBe(false);
    expect(reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 10.5, maxOutputTokens: 10,
    }, generousPolicy).allowed).toBe(false);
    expect(reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: Number.NaN, maxOutputTokens: 10,
    }, generousPolicy).allowed).toBe(false);
    expect(storage.__state.attempts.size).toBe(0);
  });

  it('duplicate attemptId never returns a fresh dispatch authorization', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    const first = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 50, maxOutputTokens: 50, attemptId: 'attempt-dup-1',
    }, generousPolicy);
    expect(first.allowed).toBe(true);
    const second = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 50, maxOutputTokens: 50, attemptId: 'attempt-dup-1',
    }, generousPolicy);
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/duplicate/i);
    expect(storage.__state.attempts.size).toBe(1);
  });

  it('counts legacy ledger plus active reservations against budgets and the 60s window', () => {
    const storage = createAttemptSql();
    initializeUsageSchema(storage);
    initializeUsageAttemptSchema(storage);
    recordUsage(storage, 'actor-1', 'legacy-1', 9000, 9000);
    // Workspace used 18000; reserving 100+100=200 fits (18200 <= 20000).
    const ok = reserveUsageAttempt(storage, {
      actorId: 'actor-2', intentionId: 'i-1', estimatedInputTokens: 100, maxOutputTokens: 100,
    }, generousPolicy);
    expect(ok.allowed).toBe(true);
    // Now 18200 used; reserving 2000 would exceed the 20000 workspace budget.
    const over = reserveUsageAttempt(storage, {
      actorId: 'actor-2', intentionId: 'i-2', estimatedInputTokens: 1000, maxOutputTokens: 1000,
    }, generousPolicy);
    expect(over.allowed).toBe(false);
    expect(over.reason).toMatch(/budget/i);

    const tightWindow: UsagePolicy = { ...generousPolicy, maxRequestsPerWindow: 1 };
    const windowed = reserveUsageAttempt(storage, {
      actorId: 'actor-9', intentionId: 'i-9', estimatedInputTokens: 5, maxOutputTokens: 5,
    }, tightWindow);
    expect(windowed.allowed).toBe(false);
    expect(windowed.reason).toMatch(/rate limit/i);
  });

  it('finalizes with reliable actuals and conservatively keeps the reservation otherwise', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    const r1 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300,
    }, generousPolicy);
    const settled = finalizeUsageAttempt(storage, r1.attemptId!, { inputTokens: 120, outputTokens: 40 }, { reliable: true });
    expect(settled.transitioned).toBe(true);
    expect(settled.row?.state).toBe('settled');
    expect(settled.row?.counted_input_tokens).toBe(120);
    expect(settled.row?.counted_output_tokens).toBe(40);

    // Dispatched failure / unknown usage retains the full reservation.
    const r2 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300,
    }, generousPolicy);
    const failed = finalizeUsageAttempt(storage, r2.attemptId!, null, { reliable: false });
    expect(failed.transitioned).toBe(true);
    expect(failed.row?.state).toBe('settled');
    expect(failed.row?.counted_input_tokens).toBe(200);
    expect(failed.row?.counted_output_tokens).toBe(300);

    // Malformed and untrusted actuals also keep the reservation.
    const r3 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300,
    }, generousPolicy);
    const malformed = finalizeUsageAttempt(storage, r3.attemptId!, { inputTokens: -1, outputTokens: 1.5 }, { reliable: true });
    expect(malformed.row?.counted_input_tokens).toBe(200);
    expect(malformed.row?.counted_output_tokens).toBe(300);
    const r4 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300,
    }, generousPolicy);
    const untrusted = finalizeUsageAttempt(storage, r4.attemptId!, { inputTokens: 10, outputTokens: 10 }, { reliable: false });
    expect(untrusted.row?.counted_input_tokens).toBe(200);
    expect(untrusted.row?.counted_output_tokens).toBe(300);
  });

  it('pre-dispatch release refunds attempt and budget but the attemptId stays single-use', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    const policy: UsagePolicy = { ...generousPolicy, dailyBudget: 500, actorDailyBudget: 500 };
    const r1 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 200, attemptId: 'attempt-rel-1',
    }, policy);
    expect(r1.allowed).toBe(true);
    const released = releaseUsageAttempt(storage, 'attempt-rel-1', { kind: 'pre_dispatch' });
    expect(released.released).toBe(true);
    expect(getUsageAttempt(storage, 'attempt-rel-1')?.state).toBe('not_dispatched');
    // Budget refunded: a full 250+250 reservation now fits in the 500 budget.
    const r2 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i2', estimatedInputTokens: 250, maxOutputTokens: 250,
    }, policy);
    expect(r2.allowed).toBe(true);
    // The released attemptId can never authorize again.
    const replay = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 200, attemptId: 'attempt-rel-1',
    }, policy);
    expect(replay.allowed).toBe(false);
  });

  it('reserve requires transactionSync and performs no SQL without it', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    let execCalls = 0;
    const countingExec = (<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
      execCalls += 1;
      return (storage.exec as (q: string, ...p: unknown[]) => Iterable<T>)(query, ...params);
    }) as typeof storage.exec;
    const noTx = { exec: countingExec } as unknown as Parameters<typeof reserveUsageAttempt>[0];
    const res = reserveUsageAttempt(noTx, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 50, maxOutputTokens: 50,
    }, generousPolicy);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/transactionSync/i);
    expect(res.attemptId).toBeUndefined();
    expect(execCalls).toBe(0);
    expect(storage.__state.attempts.size).toBe(0);
  });

  it('release requires explicit proof and never releases settled rows', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    const r1 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 50, maxOutputTokens: 50, attemptId: 'proof-1',
    }, generousPolicy);
    expect(r1.allowed).toBe(true);
    // Missing proof: closed failure, reservation stays accounted.
    const missing = releaseUsageAttempt(storage, 'proof-1', undefined as unknown as { kind: 'pre_dispatch' });
    expect(missing.released).toBe(false);
    expect(getUsageAttempt(storage, 'proof-1')?.state).toBe('reserved');
    // Timeout/unknown is not a proof: must not release.
    const timeout = releaseUsageAttempt(storage, 'proof-1', { kind: 'timeout' } as unknown as { kind: 'pre_dispatch' });
    expect(timeout.released).toBe(false);
    expect(getUsageAttempt(storage, 'proof-1')?.state).toBe('reserved');
    // Trusted relay confirmation releases.
    const relay = releaseUsageAttempt(storage, 'proof-1', { kind: 'relay_confirmed_not_dispatched', reliable: true });
    expect(relay.released).toBe(true);
    expect(getUsageAttempt(storage, 'proof-1')?.state).toBe('not_dispatched');

    // Settled rows can never be released, even with valid proof.
    const r2 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 60, maxOutputTokens: 60, attemptId: 'proof-2',
    }, generousPolicy);
    expect(r2.allowed).toBe(true);
    const fin = finalizeUsageAttempt(storage, 'proof-2', { inputTokens: 10, outputTokens: 10 }, { reliable: true });
    expect(fin.transitioned).toBe(true);
    expect(fin.row?.state).toBe('settled');
    const afterSettled = releaseUsageAttempt(storage, 'proof-2', { kind: 'pre_dispatch' });
    expect(afterSettled.released).toBe(false);
    expect(afterSettled.state).toBe('settled');
    expect(getUsageAttempt(storage, 'proof-2')?.state).toBe('settled');
  });

  it('competing finalize/release transitions are conditional and report persisted state', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    const r1 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300, attemptId: 'race-1',
    }, generousPolicy);
    expect(r1.allowed).toBe(true);
    const first = finalizeUsageAttempt(storage, 'race-1', { inputTokens: 120, outputTokens: 40 }, { reliable: true });
    expect(first.transitioned).toBe(true);
    expect(first.row?.counted_input_tokens).toBe(120);
    // Stale second finalize never overwrites and reports the winner.
    const second = finalizeUsageAttempt(storage, 'race-1', { inputTokens: 10, outputTokens: 10 }, { reliable: true });
    expect(second.transitioned).toBe(false);
    expect(second.row?.state).toBe('settled');
    expect(second.row?.counted_input_tokens).toBe(120);
    expect(second.row?.counted_output_tokens).toBe(40);
    // Release after settle is a no-op with actual state.
    const relAfter = releaseUsageAttempt(storage, 'race-1', { kind: 'pre_dispatch' });
    expect(relAfter.released).toBe(false);
    expect(relAfter.state).toBe('settled');

    // Release wins the race: later finalize cannot resurrect it.
    const r2 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300, attemptId: 'race-2',
    }, generousPolicy);
    expect(r2.allowed).toBe(true);
    const rel = releaseUsageAttempt(storage, 'race-2', { kind: 'pre_dispatch' });
    expect(rel.released).toBe(true);
    const finAfter = finalizeUsageAttempt(storage, 'race-2', { inputTokens: 50, outputTokens: 50 }, { reliable: true });
    expect(finAfter.transitioned).toBe(false);
    expect(finAfter.row?.state).toBe('not_dispatched');
    expect(finAfter.row?.counted_input_tokens).toBe(0);
  });

  it('competing same-value finalizations and releases report exactly one winner', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    // Same-value finalize race: both callers reconcile to the full reservation.
    const r1 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300, attemptId: 'race-same-1',
    }, generousPolicy);
    expect(r1.allowed).toBe(true);
    const staleReserved = { ...getUsageAttempt(storage, 'race-same-1')! };
    expect(staleReserved.state).toBe('reserved');
    const first = finalizeUsageAttempt(storage, 'race-same-1', null, { reliable: false });
    expect(first.transitioned).toBe(true);
    // Second caller holds a stale pre-write snapshot (both read 'reserved'
    // before either UPDATE). Its conditional UPDATE affects 0 rows, but the
    // persisted row matches its target values.
    let staleFinalizeSelects = 0;
    const staleFinalizeExec = (<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
      const q = query.trim().replace(/\s+/g, ' ');
      if (q.startsWith('SELECT * FROM usage_attempts WHERE attempt_id') && staleFinalizeSelects === 0) {
        staleFinalizeSelects += 1;
        return [{ ...staleReserved }] as unknown as Iterable<T>;
      }
      return (storage.exec as (qq: string, ...pp: unknown[]) => Iterable<T>)(query, ...params);
    }) as typeof storage.exec;
    const second = finalizeUsageAttempt({ exec: staleFinalizeExec }, 'race-same-1', null, { reliable: false });
    expect(second.transitioned).toBe(false);
    expect(second.row?.state).toBe('settled');
    expect(second.row?.counted_input_tokens).toBe(200);
    expect(second.row?.counted_output_tokens).toBe(300);
    expect([first.transitioned, second.transitioned].filter(Boolean)).toHaveLength(1);

    // Same-proof release race: two pre_dispatch releases, one stale reader.
    const r2 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300, attemptId: 'race-same-2',
    }, generousPolicy);
    expect(r2.allowed).toBe(true);
    const staleReleaseReserved = { ...getUsageAttempt(storage, 'race-same-2')! };
    const relFirst = releaseUsageAttempt(storage, 'race-same-2', { kind: 'pre_dispatch' });
    expect(relFirst.released).toBe(true);
    let staleReleaseSelects = 0;
    const staleReleaseExec = (<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
      const q = query.trim().replace(/\s+/g, ' ');
      if (q.startsWith('SELECT * FROM usage_attempts WHERE attempt_id') && staleReleaseSelects === 0) {
        staleReleaseSelects += 1;
        return [{ ...staleReleaseReserved }] as unknown as Iterable<T>;
      }
      return (storage.exec as (qq: string, ...pp: unknown[]) => Iterable<T>)(query, ...params);
    }) as typeof storage.exec;
    const relSecond = releaseUsageAttempt({ exec: staleReleaseExec }, 'race-same-2', { kind: 'pre_dispatch' });
    expect(relSecond.released).toBe(false);
    expect(relSecond.state).toBe('not_dispatched');
    expect([relFirst.released, relSecond.released].filter(Boolean)).toHaveLength(1);
  });

  it('reliable actuals above reserve and above 1M are recorded, overflow saturates', () => {
    const storage = createAttemptSql();
    initializeUsageAttemptSchema(storage);
    const bigBudget: UsagePolicy = {
      ...generousPolicy,
      dailyBudget: Number.MAX_SAFE_INTEGER,
      actorDailyBudget: Number.MAX_SAFE_INTEGER,
      maxRequestsPerWindow: 1000,
    };
    // Above the reservation but well-formed: must be recorded, not clamped.
    const r1 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300, attemptId: 'actual-1',
    }, bigBudget);
    expect(r1.allowed).toBe(true);
    const big = finalizeUsageAttempt(storage, 'actual-1', { inputTokens: 5000, outputTokens: 100 }, { reliable: true });
    expect(big.transitioned).toBe(true);
    expect(big.row?.counted_input_tokens).toBe(5000);
    expect(big.row?.counted_output_tokens).toBe(100);

    // Large-but-valid counts above the old 1M bound are recorded, never replaced by the smaller reservation.
    const r2 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300, attemptId: 'actual-2',
    }, bigBudget);
    expect(r2.allowed).toBe(true);
    const huge = finalizeUsageAttempt(storage, 'actual-2', { inputTokens: 2500000, outputTokens: 10 }, { reliable: true });
    expect(huge.transitioned).toBe(true);
    expect(huge.row?.counted_input_tokens).toBe(2500000);

    // Unsafe overflow saturates to block future reservations instead of undercounting.
    const r3 = reserveUsageAttempt(storage, {
      actorId: 'a', intentionId: 'i', estimatedInputTokens: 200, maxOutputTokens: 300, attemptId: 'actual-3',
    }, bigBudget);
    expect(r3.allowed).toBe(true);
    const saturated = finalizeUsageAttempt(storage, 'actual-3', { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 10 }, { reliable: true });
    expect(saturated.transitioned).toBe(true);
    expect(saturated.row?.counted_input_tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(saturated.row && saturated.row.counted_input_tokens > 200).toBe(true);
  });
});
