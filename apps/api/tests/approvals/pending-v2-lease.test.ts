/**
 * T2.4 — Execution lease + reconciliation of abandoned `executing`
 * operations (SPEC §11, H-05; ADR-013).
 *
 * Dual-store suite (in-memory always; Postgres gated by DATABASE_URL_TEST +
 * requireTestDatabase, same pattern as the sibling suites):
 *
 * - claim writes lease columns (coherence re-assertion; T2.3 landed it);
 * - execute on `executing` with a VALID lease → approval.execution_in_progress
 *   (never a duplicate execution);
 * - expired lease → reconcileExpiredExecuting renews the lease, bumps the
 *   attempt, and re-runs the SAME executor with the SAME persisted
 *   idempotencyKey (recovery, not a new approval) — 0 ou 1 efeito total;
 * - executor failure after renew → failed persisted, attempts incremented;
 * - terminal states + confirmed + proposed + failed → reconciler refuses
 *   (`confirmed` recovery is attestation re-emission, T2.2 — never lease);
 * - concurrent reconciles → single financial effect;
 * - attempt_count auditability across two attempts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  createPostgresPendingOperationV2Store,
  PENDING_V2_EXECUTION_LEASE_MS,
  resolvePendingV2LeaseMs,
  type PendingIdentity,
  type PendingOperationV2Record,
  type PendingOperationV2Store,
} from '../../src/approvals/pending-v2.js';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';

const newIdentity = (): PendingIdentity => ({
  workspaceId: randomUUID(),
  actorId: randomUUID(),
  deviceId: randomUUID(),
});

const proposeCanonical = async (store: PendingOperationV2Store, identity: PendingIdentity) => {
  const base = {
    version: 2 as const,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    deviceId: identity.deviceId,
    tool: 'transactions.expense.create',
    normalizedArgs: {
      description: 'Lease probe',
      amountCents: 4242,
      date: '2026-09-14',
      accountId: randomUUID(),
      categoryId: randomUUID(),
    },
    proposalHash: '',
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    bindings: {
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
    },
  };
  const proposalHash = await computePendingOperationV2Hash(base);
  return store.propose({ ...base, proposalHash });
};

/** Fake WriteStore keyed by idempotencyKey: same key → same receipt, no new effect. */
const createFakeWrites = () => {
  const receipts = new Map<string, string>();
  let effects = 0;
  const seenKeys: string[] = [];
  return {
    seenKeys,
    get effects() {
      return effects;
    },
    executor: async (operation: { idempotencyKey: string }) => {
      seenKeys.push(operation.idempotencyKey);
      const existing = receipts.get(operation.idempotencyKey);
      if (existing) return { status: 'succeeded', operationId: existing };
      effects += 1;
      const operationId = `mut-${operation.idempotencyKey}`;
      receipts.set(operation.idempotencyKey, operationId);
      return { status: 'succeeded', operationId };
    },
  };
};

const deferred = () => {
  let resolve!: (value: { status: string; operationId: string }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ status: string; operationId: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitForLeaseExpiry = async (
  store: PendingOperationV2Store,
  id: string,
  identity: PendingIdentity,
  timeoutMs = 5_000,
): Promise<PendingOperationV2Record> => {
  const started = Date.now();
  for (;;) {
    const record = await store.get(id, identity);
    if (record.executionLeaseExpiresAt && Date.parse(record.executionLeaseExpiresAt) <= Date.now()) return record;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for lease expiry');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/**
 * Postgres commits the TX1 claim asynchronously (connect + BEGIN + UPDATE +
 * COMMIT take tens of ms), while the in-memory store claims synchronously
 * before `execute()` returns. Polling here preserves the assertions' intent
 * ("claim committed → executing") without assuming sync visibility.
 */
const waitForClaim = async (
  store: PendingOperationV2Store,
  id: string,
  identity: PendingIdentity,
  timeoutMs = 5_000,
): Promise<PendingOperationV2Record> => {
  const started = Date.now();
  for (;;) {
    const record = await store.get(id, identity);
    if (record.status === 'executing') return record;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for claim');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function defineLeaseSuite(
  suiteName: string,
  makeStore: (opts?: { leaseMs?: number }) => PendingOperationV2Store,
  hooks: { trackWorkspace?: (workspaceId: string) => void } = {},
): void {
  describe(suiteName, () => {
    const identityOf = (): PendingIdentity => {
      const identity = newIdentity();
      hooks.trackWorkspace?.(identity.workspaceId);
      return identity;
    };

    it('claim writes lease columns with the configured window and attempt 1', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const done = await store.execute(confirmed.attestation!, id, async () => ({
        status: 'succeeded',
        operationId: randomUUID(),
      }));
      expect(done.status).toBe('succeeded');
      expect(done.executionClaimedAt).toBeTruthy();
      expect(done.executionLeaseExpiresAt).toBeTruthy();
      expect(Date.parse(done.executionLeaseExpiresAt!) - Date.parse(done.executionClaimedAt!)).toBe(
        PENDING_V2_EXECUTION_LEASE_MS,
      );
      expect(done.executionAttemptCount).toBe(1);
      expect(PENDING_V2_EXECUTION_LEASE_MS).toBe(60_000);
    });

    it('lease duration is configurable (store option), default stays 60s', async () => {
      expect(resolvePendingV2LeaseMs()).toBe(PENDING_V2_EXECUTION_LEASE_MS);
      expect(resolvePendingV2LeaseMs(5_000)).toBe(5_000);
      const store = makeStore({ leaseMs: 5_000 });
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const done = await store.execute(confirmed.attestation!, id, async () => ({
        status: 'succeeded',
        operationId: randomUUID(),
      }));
      expect(Date.parse(done.executionLeaseExpiresAt!) - Date.parse(done.executionClaimedAt!)).toBe(5_000);
    });

    it('executing with VALID lease: execute replay + reconciler → execution_in_progress, executor runs once', async () => {
      const store = makeStore();
      const writes = createFakeWrites();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const gate = deferred();
      const first = store.execute(confirmed.attestation!, id, () => gate.promise);
      // Claim committed: the operation is `executing` with a valid lease.
      const executing = await waitForClaim(store, saved.id, id);
      expect(executing.status).toBe('executing');
      expect(Date.parse(executing.executionLeaseExpiresAt!)).toBeGreaterThan(Date.now());
      // Same-attestation replay while in flight → in-progress, never a duplicate.
      let reran = false;
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          reran = true;
          return writes.executor({ idempotencyKey: saved.idempotencyKey });
        }),
      ).rejects.toMatchObject({ code: 'approval.execution_in_progress' });
      expect(reran).toBe(false);
      // Reconciler during a valid lease refuses without running its executor.
      let reconciled = false;
      await expect(
        store.reconcileExpiredExecuting(saved.id, id, async () => {
          reconciled = true;
          return writes.executor({ idempotencyKey: saved.idempotencyKey });
        }),
      ).rejects.toMatchObject({ code: 'approval.execution_in_progress' });
      expect(reconciled).toBe(false);
      expect(writes.effects).toBe(0);
      gate.resolve({ status: 'succeeded', operationId: randomUUID() });
      const done = await first;
      expect(done.status).toBe('succeeded');
      expect(done.executionAttemptCount).toBe(1);
    });

    it('expired lease: reconciler re-runs the SAME executor with the SAME idempotencyKey, single effect', async () => {
      const store = makeStore({ leaseMs: 40 });
      const writes = createFakeWrites();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const gate = deferred();
      const first = store.execute(confirmed.attestation!, id, async (op) => {
        await gate.promise;
        return writes.executor(op);
      });
      const abandoned = await waitForLeaseExpiry(store, saved.id, id);
      expect(abandoned.status).toBe('executing');
      expect(abandoned.executionAttemptCount).toBe(1);
      // Crash recovery: the late first executor must NOT duplicate the effect.
      const recovered = await store.reconcileExpiredExecuting(saved.id, id, writes.executor);
      expect(recovered.status).toBe('succeeded');
      expect(recovered.executionAttemptCount).toBe(2);
      expect(writes.seenKeys).toHaveLength(1);
      expect(writes.seenKeys[0]).toBe(saved.idempotencyKey);
      expect(writes.effects).toBe(1);
      // The abandoned attempt finally completes with the same key → dedup, no new effect.
      gate.resolve({ status: 'succeeded', operationId: `mut-${saved.idempotencyKey}` });
      const firstDone = await first;
      expect(firstDone.status).toBe('succeeded');
      expect(writes.effects).toBe(1);
      const final = await store.get(saved.id, id);
      expect(final.status).toBe('succeeded');
      expect(final.executionAttemptCount).toBe(2);
      // T3.2 (SPEC §15.1): mutation_id persists the receipt identity of the
      // persisted execution result — not the financial entity id.
      const finalExecution = final.execution as { operationId: string; receipt: { mutationId: string } };
      expect(finalExecution.operationId).toBe(`mut-${saved.idempotencyKey}`);
      expect(finalExecution.receipt).toBeTruthy();
      expect(final.mutationId).toBe(finalExecution.receipt.mutationId);
    });

    it('executor fails after renew → failed persisted, attempts incremented, sanitized code', async () => {
      const store = makeStore({ leaseMs: 40 });
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const gate = deferred();
      const first = store.execute(confirmed.attestation!, id, () => gate.promise);
      await waitForLeaseExpiry(store, saved.id, id);
      await expect(
        store.reconcileExpiredExecuting(saved.id, id, async () => {
          throw new Error('downstream outage: secret-prompt-content must not leak');
        }),
      ).rejects.toThrow('downstream outage');
      const failed = await store.get(saved.id, id);
      expect(failed.status).toBe('failed');
      expect(failed.executionAttemptCount).toBe(2);
      expect(failed.failureCode).toBe('executor.failed');
      gate.reject(new Error('late abandoned attempt must not resurrect'));
      await expect(first).rejects.toThrow();
    });

    it('reconciler refuses succeeded/cancelled/expired/confirmed/failed/proposed', async () => {
      const store = makeStore();
      const id = identityOf();
      const receipt = () => ({ status: 'succeeded', operationId: randomUUID() });
      const expectRefused = async (operationId: string, identity: PendingIdentity) => {
        let ran = false;
        await expect(
          store.reconcileExpiredExecuting(operationId, identity, async () => {
            ran = true;
            return receipt();
          }),
        ).rejects.toMatchObject({ code: 'approval.reconcile_not_allowed' });
        expect(ran).toBe(false);
      };

      const ok = await proposeCanonical(store, id);
      const okConfirmed = await store.confirm(ok.id, id);
      await store.execute(okConfirmed.attestation!, id, async () => receipt());
      await expectRefused(ok.id, id);

      const cancelId = identityOf();
      const toCancel = await proposeCanonical(store, cancelId);
      await store.cancel(toCancel.id, cancelId);
      await expectRefused(toCancel.id, cancelId);

      const expireId = identityOf();
      const toExpire = await proposeCanonical(store, expireId);
      await store.expire(toExpire.id, expireId);
      await expectRefused(toExpire.id, expireId);

      // `confirmed` recovery is attestation re-emission (T2.2) — NEVER lease.
      const confirmId = identityOf();
      const toConfirm = await proposeCanonical(store, confirmId);
      await store.confirm(toConfirm.id, confirmId);
      await expectRefused(toConfirm.id, confirmId);

      const failId = identityOf();
      const toFail = await proposeCanonical(store, failId);
      const failConfirmed = await store.confirm(toFail.id, failId);
      await expect(
        store.execute(failConfirmed.attestation!, failId, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await expectRefused(toFail.id, failId);

      const proposedId = identityOf();
      const proposed = await proposeCanonical(store, proposedId);
      await expectRefused(proposed.id, proposedId);
    });

    it('concurrent reconciles on an expired lease → single financial effect', async () => {
      // NOTE (postgres): the renew window must comfortably exceed one TX-R
      // roundtrip (~tens of ms locally). A 40ms window leaves the loser's
      // post-lock validity check racing TX latency; 500ms keeps the
      // serialization assertion deterministic while the expiry wait stays
      // fast. Assertions untouched.
      const store = makeStore({ leaseMs: 500 });
      const writes = createFakeWrites();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const gate = deferred();
      const first = store.execute(confirmed.attestation!, id, () => gate.promise);
      await waitForLeaseExpiry(store, saved.id, id);
      const outcomes = await Promise.allSettled([
        store.reconcileExpiredExecuting(saved.id, id, writes.executor),
        store.reconcileExpiredExecuting(saved.id, id, writes.executor),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
      expect(['approval.execution_in_progress', 'approval.reconcile_not_allowed']).toContain(reason.code);
      expect(writes.effects).toBe(1);
      gate.resolve({ status: 'succeeded', operationId: `mut-${saved.idempotencyKey}` });
      await first;
      expect(writes.effects).toBe(1);
      expect((await store.get(saved.id, id)).status).toBe('succeeded');
    });

    it('attempt_count is auditable across claim + reconcile', async () => {
      const store = makeStore({ leaseMs: 40 });
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      expect(saved.executionAttemptCount).toBe(0);
      const confirmed = await store.confirm(saved.id, id);
      const gate = deferred();
      const first = store.execute(confirmed.attestation!, id, () => gate.promise);
      await waitForClaim(store, saved.id, id);
      expect((await store.get(saved.id, id)).executionAttemptCount).toBe(1);
      await waitForLeaseExpiry(store, saved.id, id);
      const recovered = await store.reconcileExpiredExecuting(saved.id, id, async () => ({
        status: 'succeeded',
        operationId: randomUUID(),
      }));
      expect(recovered.executionAttemptCount).toBe(2);
      gate.resolve({ status: 'succeeded', operationId: randomUUID() });
      await first;
      expect((await store.get(saved.id, id)).executionAttemptCount).toBe(2);
    });
  });
}

defineLeaseSuite('pending-v2 execution lease (in-memory)', (opts) =>
  createInMemoryPendingOperationV2Store(opts),
);

describe('pending-v2 execution lease (in-memory) — single-timestamp claim regression', () => {
  it('claim derives claimedAt and lease expiry from one timestamp even when Date.now ticks +1ms', async () => {
    // Deterministic off-by-one race regression (in-memory only): the old
    // claim sampled the clock twice (`nowIso()` then `Date.now()`), so a
    // 1ms tick between the samples produced lease+1. Fake time pins
    // `new Date()` at FIXED while the `Date.now()` sample at claim observes
    // FIXED+1; the fixed claim must still yield exactly the configured
    // window from a single timestamp.
    const FIXED = Date.parse('2026-09-14T00:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(FIXED);
      const store = createInMemoryPendingOperationV2Store({ leaseMs: 5_000 });
      const id = newIdentity();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(FIXED + 1);
      try {
        const done = await store.execute(confirmed.attestation!, id, async () => ({
          status: 'succeeded',
          operationId: randomUUID(),
        }));
        expect(done.executionClaimedAt).toBe(new Date(FIXED + 1).toISOString());
        expect(Date.parse(done.executionLeaseExpiresAt!) - Date.parse(done.executionClaimedAt!)).toBe(5_000);
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

const DB_URL = process.env.DATABASE_URL_TEST;

if (!DB_URL) {
  console.log(
    '[pending-v2-lease] SKIP: DATABASE_URL_TEST is not set — Postgres half skipped. ' +
      'The in-memory half above still covers the lease.',
  );
  describe.skip('pending-v2 execution lease (postgres)', () => {});
} else {
  describe('pending-v2 execution lease (postgres)', () => {
    let pool: Pool;
    const workspaces = new Set<string>();

    beforeAll(async () => {
      pool = createPool({ connectionString: DB_URL, max: 8 });
      await requireTestDatabase(pool, 'pending-v2-lease');
    }, 30_000);

    afterAll(async () => {
      if (workspaces.size > 0) {
        await pool.query('DELETE FROM pending_operations WHERE workspace_id = ANY($1)', [[...workspaces]]);
      }
      await pool.end();
    });

    defineLeaseSuite(
      'pending-v2 execution lease (postgres)',
      (opts) => createPostgresPendingOperationV2Store(pool, opts),
      {
        trackWorkspace: (workspaceId: string) => {
          workspaces.add(workspaceId);
        },
      },
    );
  });
}
