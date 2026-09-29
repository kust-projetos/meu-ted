/**
 * T6.1 — Consolidated §25.4 fault-injection suite (SPEC §25.4).
 *
 * Every NAMED fault class gets its own scenario — recovery mechanisms differ
 * per state, so there are NO generic "restart" tests (§25.4 preamble). The
 * scenarios COMPOSE the helpers/patterns of the sibling suites
 * (pending-v2-contract / -claim / -lease / -idempotency) instead of
 * duplicating their assertions; each mapping below names the PRIMARY
 * coverage that stays authoritative there:
 *
 * - response loss                  → §9 confirm re-emission: confirm twice →
 *                                    NEW attestation, single execution
 *                                    (primary: contract H-03 suite).
 * - transport timeout on confirm   → same §9 recovery path as response loss,
 *                                    deterministic sequential sequencing
 *                                    (primary: contract H-03 suite).
 * - executor failure               → TX1 claim stands; failed persisted with
 *                                    sanitized code; attestation consumed
 *                                    (deterministic pre-write throws only).
 * - post-write uncertainty          → typed uncertainty, malformed result,
 *                                    or receipt-normalization failure keeps
 *                                    `executing` (no fail audit, no retry);
 *                                    lease recovery re-runs the SAME key
 *                                    (primary:
 *                                    pending-v2-uncertainty.test.ts).
 * - API crash after claim (lease)  → lease expiry → reconciler → SAME
 *                                    idempotencyKey → 0/1 effect; late TX2
 *                                    of the abandoned attempt cannot
 *                                    overwrite status/receipt/mutationId
 *                                    (T6.1 guard; primary:
 *                                    pending-v2-lease.test.ts).
 * - PostgreSQL failure during      → Postgres-only connect-fault injection:
 *   claim / TX2                      mid-transaction failure leaves the
 *                                    operation RECOVERABLE (executing with
 *                                    lease, or confirmed with a claimable
 *                                    attestation) — never
 *                                    confirmed-with-consumed-attestation,
 *                                    never a ghost mutation (§25.4).
 * - double submit                  → same key twice → ONE operation, ONE
 *                                    effect (§7.7; primary:
 *                                    pending-v2-idempotency.test.ts).
 * - handoff A–E at the API         → §25.3.2 A/B/D/E boundary contract:
 *   boundary                         same-key propose replay → same op;
 *                                    divergent payload → idempotency.conflict
 *                                    (primary: pending-v2-idempotency.test.ts).
 *
 * Dual-store (in-memory always; Postgres gated by DATABASE_URL_TEST +
 * requireTestDatabase, same pattern as the sibling suites — explicit skip
 * report without the env, never silent).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  createPostgresPendingOperationV2Store,
  type PendingIdentity,
  type PendingOperationV2Store,
} from '../../src/approvals/pending-v2.js';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';

const newIdentity = (): PendingIdentity => ({
  workspaceId: randomUUID(),
  actorId: randomUUID(),
  deviceId: randomUUID(),
});

/** Canonical expense proposal with an EXPLICIT idempotency key (§7.7). */
const buildCanonicalProposal = async (identity: PendingIdentity, key = randomUUID()): Promise<PendingOperationV2> => {
  const base = {
    version: 2 as const,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    deviceId: identity.deviceId,
    tool: 'transactions.expense.create',
    normalizedArgs: {
      description: 'Fault probe',
      amountCents: 777,
      date: '2026-09-14',
      accountId: randomUUID(),
      categoryId: randomUUID(),
    },
    proposalHash: '',
    idempotencyKey: key,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    bindings: {
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
    },
  };
  return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
};

const proposeCanonical = async (store: PendingOperationV2Store, identity: PendingIdentity, key?: string) => {
  const operation = await buildCanonicalProposal(identity, key);
  return store.propose(operation);
};

const succeededResult = () => ({ status: 'succeeded', operationId: randomUUID() });

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

/**
 * Postgres commits the TX1 claim asynchronously; polling preserves the
 * assertions' intent without assuming sync visibility (same pattern as the
 * sibling lease suite).
 */
const waitForClaim = async (
  store: PendingOperationV2Store,
  id: string,
  identity: PendingIdentity,
  timeoutMs = 5_000,
): Promise<void> => {
  const started = Date.now();
  for (;;) {
    if ((await store.get(id, identity)).status === 'executing') return;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for claim');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const waitForLeaseExpiry = async (
  store: PendingOperationV2Store,
  id: string,
  identity: PendingIdentity,
  timeoutMs = 5_000,
): Promise<void> => {
  const started = Date.now();
  for (;;) {
    const record = await store.get(id, identity);
    if (record.executionLeaseExpiresAt && Date.parse(record.executionLeaseExpiresAt) <= Date.now()) return;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for lease expiry');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function definePendingV2FaultSuite(
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

    it('response loss: confirm twice → NEW attestation, single execution (§9, H-03)', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const lost = await store.confirm(saved.id, id); // response lost mid-flight
      // Snapshot BEFORE the recovery confirm: the in-memory store returns the
      // live record, so reading lost.attestation after rotation would observe
      // the NEW token (same aliasing contract suite H-03 guards against).
      const lostToken = lost.attestation!;
      const recovered = await store.confirm(saved.id, id); // same recovery path
      expect(recovered.status).toBe('confirmed');
      expect(recovered.attestation).toBeTruthy();
      // Re-emission, not echo: the lost attestation was rotated away.
      expect(recovered.attestation).not.toBe(lostToken);
      // Exactly one execution through the recovered attestation.
      let runs = 0;
      const done = await store.execute(recovered.attestation!, id, async () => {
        runs += 1;
        return succeededResult();
      });
      expect(done.status).toBe('succeeded');
      expect(runs).toBe(1);
      // A replay of the recovered attestation never executes again.
      await expect(
        store.execute(recovered.attestation!, id, async () => {
          runs += 1;
          return succeededResult();
        }),
      ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
      expect(runs).toBe(1);
    });

    it('transport timeout on confirm: committed confirm + lost response → same §9 recovery (deterministic)', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const timedOut = await store.confirm(saved.id, id); // caller gave up; response lost in flight
      // The confirm COMMITTED even though the caller never saw the response.
      expect((await store.get(saved.id, id)).status).toBe('confirmed');
      // Snapshot the in-flight token before the retry (live-record aliasing,
      // same as the H-03 suite).
      const timedOutToken = timedOut.attestation!;
      // Deterministic re-confirm (no races): a fresh attestation is issued.
      const retried = await store.confirm(saved.id, id);
      expect(retried.status).toBe('confirmed');
      expect(retried.attestation).toBeTruthy();
      expect(retried.attestation).not.toBe(timedOutToken);
      const done = await store.execute(retried.attestation!, id, async () => succeededResult());
      expect(done.status).toBe('succeeded');
      expect((await store.get(saved.id, id)).status).toBe('succeeded');
    });

    it('executor failure: claim committed → throw → failed persisted, attestation consumed (§25.4)', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          throw new Error('downstream outage: secret-prompt-content must not leak');
        }),
      ).rejects.toThrow('downstream outage');
      const failed = await store.get(saved.id, id);
      // TX1 stands, TX2 (failure) committed: RECOVERABLE terminal state.
      expect(failed.status).toBe('failed');
      expect(failed.failureCode).toBe('executor.failed');
      expect(failed.executionAttemptCount).toBe(1);
      expect(failed.executionClaimedAt).toBeTruthy();
      expect(failed.executionLeaseExpiresAt).toBeTruthy();
      // The consumed attestation is never resurrected.
      let reran = false;
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          reran = true;
          return succeededResult();
        }),
      ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
      expect(reran).toBe(false);

      // Same fault class, post-write uncertainty variant: a malformed executor
      // result may already have written, so it keeps `executing` for lease
      // recovery (typed uncertainty) — never a retryable `failed`.
      const id2 = identityOf();
      const saved2 = await proposeCanonical(store, id2);
      const confirmed2 = await store.confirm(saved2.id, id2);
      await expect(store.execute(confirmed2.attestation!, id2, async () => ({ ok: true })))
        .rejects.toMatchObject({ code: 'approval.execution_uncertain' });
      const uncertain2 = await store.get(saved2.id, id2);
      expect(uncertain2.status).toBe('executing');
      expect(uncertain2.failureCode).toBeUndefined();
      await expect(store.retry(saved2.id, id2)).rejects.toMatchObject({ code: 'approval.retry_not_allowed' });
    });

    it('API crash after claim: lease expires → reconciler → same idempotencyKey → 0/1 effect (H-05)', async () => {
      const store = makeStore({ leaseMs: 40 });
      const writes = createFakeWrites();
      const id = identityOf();
      const key = randomUUID();
      const saved = await proposeCanonical(store, id, key);
      const confirmed = await store.confirm(saved.id, id);
      const gate = deferred();
      const crashed = store.execute(confirmed.attestation!, id, async (op) => {
        await gate.promise; // "crashed" attempt never finalizes
        return writes.executor(op);
      });
      await waitForClaim(store, saved.id, id);
      await waitForLeaseExpiry(store, saved.id, id);

      // Recovery: SAME executor surface, SAME persisted idempotencyKey.
      const recovered = await store.reconcileExpiredExecuting(saved.id, id, writes.executor);
      expect(recovered.status).toBe('succeeded');
      expect(recovered.executionAttemptCount).toBe(2);
      expect(writes.seenKeys).toEqual([key]);
      expect(writes.effects).toBe(1);
      const recoveryMutationId = (recovered.execution as { receipt: { mutationId: string } }).receipt.mutationId;
      expect(recovered.mutationId).toBe(recoveryMutationId);

      // The abandoned attempt lands LATE with the same key → dedup, and the
      // T6.1 stale-TX2 guard keeps the recovery's status/receipt/mutationId.
      gate.resolve({ status: 'succeeded', operationId: `mut-${key}` });
      const late = await crashed;
      expect(late.status).toBe('succeeded');
      expect(writes.effects).toBe(1);
      const final = await store.get(saved.id, id);
      expect(final.status).toBe('succeeded');
      expect(final.mutationId).toBe(recoveryMutationId);
      expect((final.execution as { receipt: { mutationId: string } }).receipt.mutationId).toBe(recoveryMutationId);
    });

    it('double submit: same key twice → one operation, one effect (§7.7)', async () => {
      const store = makeStore();
      const writes = createFakeWrites();
      const id = identityOf();
      const key = randomUUID();
      const operation = await buildCanonicalProposal(id, key);
      const first = await store.propose(operation);
      const second = await store.propose(operation); // double click / double message
      expect(second.id).toBe(first.id);
      expect(second.existing).toBe(true);
      const confirmed = await store.confirm(first.id, id);
      const done = await store.execute(confirmed.attestation!, id, writes.executor);
      expect(done.status).toBe('succeeded');
      expect(writes.seenKeys).toEqual([key]);
      expect(writes.effects).toBe(1);
    });

    it('handoff A–E at the API boundary: same-key propose replay → same op; divergent payload → idempotency.conflict (§25.3.2)', async () => {
      const store = makeStore();
      const id = identityOf();
      const key = randomUUID();
      // Cases A/B/E resolve through the SAME proposalIdempotencyKey: a
      // replayed propose (lost response, agent crash, in-flight cancel)
      // lands on the SAME PendingOperation.
      const operation = await buildCanonicalProposal(id, key);
      const first = await store.propose(operation);
      const replay = await store.propose(operation);
      expect(replay.id).toBe(first.id);
      expect(replay.existing).toBe(true);
      // Case D (concurrent/divergent propose): the SAME key with a divergent
      // payload is a deterministic fingerprint conflict, never a second op.
      const divergent = await buildCanonicalProposal(id, key);
      const divergentPayload = {
        ...divergent,
        normalizedArgs: { ...divergent.normalizedArgs, amountCents: 999 },
      };
      divergentPayload.proposalHash = await computePendingOperationV2Hash(divergentPayload);
      await expect(store.propose(divergentPayload)).rejects.toMatchObject({ code: 'idempotency.conflict' });
      // Exactly one operation for the key, and it executes exactly once.
      const confirmed = await store.confirm(first.id, id);
      const done = await store.execute(confirmed.attestation!, id, async () => succeededResult());
      expect(done.status).toBe('succeeded');
    });
  });
}

definePendingV2FaultSuite(
  'pending-v2 fault injection §25.4 (in-memory)',
  (opts) => createInMemoryPendingOperationV2Store(opts),
);

const DB_URL = process.env.DATABASE_URL_TEST;

if (!DB_URL) {
  console.log(
    '[pending-v2-fault] SKIP: DATABASE_URL_TEST is not set — Postgres half skipped. ' +
      'The in-memory half above still covers the fault classes.',
  );
  describe.skip('pending-v2 fault injection §25.4 (postgres)', () => {});
} else {
  /**
   * Deterministic mid-transaction PostgreSQL failure injection: replaces the
   * pool's connect() so the Nth `withTransaction` roundtrip fails. ONLY the
   * store's transaction calls run inside the window (restored in `finally`),
   * so `pool.query` users are never affected. Returns the restore function.
   */
  const injectConnectFailure = (pool: Pool, failingCall: number): (() => void) => {
    const original = pool.connect.bind(pool);
    let calls = 0;
    (pool as unknown as { connect: typeof original }).connect = ((
      ...args: unknown[]
    ): Promise<PoolClient> | undefined => {
      const callback = args.find((arg) => typeof arg === 'function') as
        | ((err: Error | null, client?: PoolClient) => void)
        | undefined;
      if (callback) return (original as (...cbArgs: unknown[]) => unknown)(...args);
      calls += 1;
      if (calls === failingCall) return Promise.reject(new Error('injected PostgreSQL outage'));
      return (original as () => Promise<PoolClient>)();
    }) as typeof original;
    return () => {
      (pool as unknown as { connect: typeof original }).connect = original;
    };
  };

  describe('pending-v2 fault injection §25.4 (postgres)', () => {
    let pool: Pool;
    const workspaces = new Set<string>();

    beforeAll(async () => {
      pool = createPool({ connectionString: DB_URL, max: 4 });
      await requireTestDatabase(pool, 'pending-v2-fault');
    }, 30_000);

    afterAll(async () => {
      if (workspaces.size > 0) {
        await pool.query('DELETE FROM pending_operations WHERE workspace_id = ANY($1)', [[...workspaces]]);
      }
      await pool.end();
    });

    definePendingV2FaultSuite(
      'pending-v2 fault injection §25.4 (postgres)',
      (opts) => createPostgresPendingOperationV2Store(pool, opts),
      {
        trackWorkspace: (workspaceId: string) => {
          workspaces.add(workspaceId);
        },
      },
    );

    it('PostgreSQL failure during claim (TX1): operation stays confirmed with a claimable attestation — no ghost', async () => {
      const store = createPostgresPendingOperationV2Store(pool);
      const identity = newIdentity();
      workspaces.add(identity.workspaceId);
      const saved = await proposeCanonical(store, identity);
      const confirmed = await store.confirm(saved.id, identity);
      let ran = false;
      const restore = injectConnectFailure(pool, 1); // the NEXT transaction (TX1 claim) fails
      try {
        await expect(
          store.execute(confirmed.attestation!, identity, async () => {
            ran = true;
            return succeededResult();
          }),
        ).rejects.toThrow('injected PostgreSQL outage');
      } finally {
        restore();
      }
      expect(ran).toBe(false);
      // Mid-transaction failure: the claim rolled back — the operation stays
      // `confirmed` with an UNCONSUMED attestation (recoverable), never a
      // confirmed-with-consumed-attestation hybrid.
      const probe = await pool.query<{ execution_status: string; attestation_consumed_at: string | null; execution_attempt_count: string }>(
        'SELECT execution_status, attestation_consumed_at, execution_attempt_count FROM pending_operations WHERE id = $1',
        [saved.id],
      );
      expect(probe.rows[0]!.execution_status).toBe('confirmed');
      expect(probe.rows[0]!.attestation_consumed_at).toBeNull();
      expect(Number(probe.rows[0]!.execution_attempt_count)).toBe(0);
      // Recovery: the SAME attestation claims and executes exactly once.
      const done = await store.execute(confirmed.attestation!, identity, async () => {
        ran = true;
        return succeededResult();
      });
      expect(done.status).toBe('succeeded');
      expect(ran).toBe(true);
      expect((await store.get(saved.id, identity)).status).toBe('succeeded');
    });

    it('PostgreSQL failure during TX2 (success persist): operation stays executing-with-lease — recoverable, no ghost mutation', async () => {
      const store = createPostgresPendingOperationV2Store(pool, { leaseMs: 40 });
      const writes = createFakeWrites();
      const identity = newIdentity();
      workspaces.add(identity.workspaceId);
      const key = randomUUID();
      const saved = await proposeCanonical(store, identity, key);
      const confirmed = await store.confirm(saved.id, identity);
      const restore = injectConnectFailure(pool, 2); // call 1 = TX1 claim, call 2 = TX2 persist
      try {
        await expect(
          store.execute(confirmed.attestation!, identity, writes.executor),
        ).rejects.toThrow('injected PostgreSQL outage');
      } finally {
        restore();
      }
      // TX1 committed, TX2 rolled back: RECOVERABLE executing-with-lease.
      // No terminal success, no receipt, no mutationId — no ghost mutation.
      const probe = await pool.query<{
        execution_status: string;
        execution_result: unknown;
        mutation_id: string | null;
        execution_attempt_count: string;
      }>('SELECT execution_status, execution_result, mutation_id, execution_attempt_count FROM pending_operations WHERE id = $1', [saved.id]);
      expect(probe.rows[0]!.execution_status).toBe('executing');
      expect(probe.rows[0]!.execution_result).toBeNull();
      expect(probe.rows[0]!.mutation_id).toBeNull();
      expect(Number(probe.rows[0]!.execution_attempt_count)).toBe(1);
      await waitForLeaseExpiry(store, saved.id, identity);
      // Reconciler re-runs the SAME key: the WriteStore dedups attempt 1's
      // write, so the total financial effect stays 0/1.
      const recovered = await store.reconcileExpiredExecuting(saved.id, identity, writes.executor);
      expect(recovered.status).toBe('succeeded');
      expect(recovered.executionAttemptCount).toBe(2);
      expect(writes.seenKeys).toEqual([key, key]);
      expect(writes.effects).toBe(1);
      expect((await store.get(saved.id, identity)).mutationId).toBeTruthy();
    });
  });
}
