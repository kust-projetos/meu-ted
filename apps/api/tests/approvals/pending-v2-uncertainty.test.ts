/**
 * Approval execution-uncertainty (HIGH review finding): a financial write
 * followed by response/receipt uncertainty must NEVER persist `failed`.
 *
 * The executor may have committed before the failure (writer throw after
 * commit, response loss, malformed post-write result, receipt normalization
 * failure). Persisting `failed` would let the user propose again and risk a
 * duplicate booking. The operation stays `executing` (no `fail` audit, no
 * retry) until the lease reconciler re-runs the SAME persisted
 * idempotencyKey, which dedups to exactly one financial effect.
 *
 * RED-first: these scenarios currently persist `failed` with
 * `approval.incomplete_result` (or `executor.failed`) and enable retry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  createPostgresPendingOperationV2Store,
  type PendingIdentity,
  type PendingOperationV2Store,
} from '../../src/approvals/pending-v2.js';
import {
  APPROVAL_EXECUTION_UNCERTAIN_CODE,
  createApprovalExecutionUncertainError,
  requireApprovalToolContract,
} from '../../src/approvals/tool-registry.js';
import type { WriteStore } from '../../src/writes/store.js';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';

const newIdentity = (): PendingIdentity => ({
  workspaceId: randomUUID(),
  actorId: randomUUID(),
  deviceId: randomUUID(),
});

const buildCanonicalProposal = async (identity: PendingIdentity, key = randomUUID()): Promise<PendingOperationV2> => {
  const base = {
    version: 2 as const,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    deviceId: identity.deviceId,
    tool: 'transactions.expense.create',
    normalizedArgs: {
      description: 'Uncertainty probe',
      amountCents: 4242,
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

/** Fake WriteStore keyed by idempotencyKey: same key → same tx id, no new effect. */
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

const failEventsFor = (store: PendingOperationV2Store, operationId: string): number =>
  store.audit.filter((event) => event.operationId === operationId && event.event === 'fail').length;

function defineUncertaintySuite(
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

    it('post-write uncertainty throw keeps executing, blocks retry, reconciles with the same key to one effect', async () => {
      const store = makeStore({ leaseMs: 40 });
      const writes = createFakeWrites();
      const id = identityOf();
      const key = randomUUID();
      const saved = await store.propose(await buildCanonicalProposal(id, key));
      const confirmed = await store.confirm(saved.id, id);

      // Attempt 1: the financial effect lands, then the response is lost —
      // the writer can no longer say whether the commit happened.
      let firstRuns = 0;
      await expect(
        store.execute(confirmed.attestation!, id, async (op) => {
          firstRuns += 1;
          await writes.executor(op);
          throw createApprovalExecutionUncertainError();
        }),
      ).rejects.toMatchObject({ code: APPROVAL_EXECUTION_UNCERTAIN_CODE });
      expect(firstRuns).toBe(1);
      expect(writes.effects).toBe(1);

      // Uncertain outcome: still executing, no failure code, no fail audit,
      // retry unavailable (a new proposal path would risk a duplicate).
      const uncertain = await store.get(saved.id, id);
      expect(uncertain.status).toBe('executing');
      expect(uncertain.failureCode).toBeUndefined();
      expect(failEventsFor(store, saved.id)).toBe(0);
      await expect(store.retry(saved.id, id)).rejects.toMatchObject({ code: 'approval.retry_not_allowed' });

      // Lease recovery re-runs the SAME persisted idempotencyKey: dedup keeps
      // exactly one financial effect and resolves with a canonical receipt.
      await waitForLeaseExpiry(store, saved.id, id);
      const recovered = await store.reconcileExpiredExecuting(saved.id, id, writes.executor);
      expect(recovered.status).toBe('succeeded');
      expect(writes.seenKeys).toEqual([key, key]);
      expect(writes.effects).toBe(1);
      const execution = recovered.execution as {
        operationId: string;
        receipt: { mutationId: string; operationId: string; entity: { type: string; id: string } };
      };
      expect(execution.receipt.operationId).toBe(saved.id);
      expect(execution.receipt.entity).toEqual({ type: 'transaction', id: `mut-${key}` });
      expect(recovered.mutationId).toBe(execution.receipt.mutationId);
    });

    it('malformed post-write result stays executing and never becomes retryable failed', async () => {
      const store = makeStore({ leaseMs: 40 });
      const writes = createFakeWrites();
      const id = identityOf();
      const key = randomUUID();
      const saved = await store.propose(await buildCanonicalProposal(id, key));
      const confirmed = await store.confirm(saved.id, id);

      // The executor wrote, then returned a malformed result — the write may
      // already exist, so this is uncertainty, not a recoverable failure.
      await expect(
        store.execute(confirmed.attestation!, id, async (op) => {
          await writes.executor(op);
          return { ok: true };
        }),
      ).rejects.toMatchObject({ code: APPROVAL_EXECUTION_UNCERTAIN_CODE });
      expect(writes.effects).toBe(1);

      const uncertain = await store.get(saved.id, id);
      expect(uncertain.status).toBe('executing');
      expect(uncertain.failureCode).toBeUndefined();
      expect(failEventsFor(store, saved.id)).toBe(0);
      await expect(store.retry(saved.id, id)).rejects.toMatchObject({ code: 'approval.retry_not_allowed' });

      await waitForLeaseExpiry(store, saved.id, id);
      const recovered = await store.reconcileExpiredExecuting(saved.id, id, writes.executor);
      expect(recovered.status).toBe('succeeded');
      expect(writes.effects).toBe(1);
    });

    it('deterministic pre-write executor throw still persists failed and allows retry', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await store.propose(await buildCanonicalProposal(id));
      const confirmed = await store.confirm(saved.id, id);
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          throw new Error('downstream outage before any write');
        }),
      ).rejects.toThrow('downstream outage before any write');
      const failed = await store.get(saved.id, id);
      expect(failed.status).toBe('failed');
      expect(failed.failureCode).toBe('executor.failed');
      expect(failEventsFor(store, saved.id)).toBe(1);
      const retried = await store.retry(saved.id, id);
      expect(retried.status).toBe('confirmed');
      expect(retried.attestation).toBeTruthy();
    });

    it('trusted TED executor maps a writer failure after commit to uncertainty, never to a raw error', async () => {
      const contract = requireApprovalToolContract('transactions.expense.create');
      const seen: string[] = [];
      const failingWrites = {
        createExpense: async (_workspaceId: string, _args: unknown, opts: { idempotencyKey: string }) => {
          seen.push(opts.idempotencyKey);
          throw new Error('connection lost after commit: secret-prompt-content must not leak');
        },
      };
      await expect(
        contract.executor({
          writes: failingWrites as unknown as WriteStore,
          workspaceId: randomUUID(),
          args: {
            description: 'Lunch',
            amountCents: 1000,
            date: '2026-09-14',
            accountId: randomUUID(),
            categoryId: randomUUID(),
          },
          idempotencyKey: 'k-uncertain',
          actorId: 'actor-1',
        }),
      ).rejects.toMatchObject({ code: APPROVAL_EXECUTION_UNCERTAIN_CODE });
      expect(seen).toEqual(['k-uncertain']);
    });

    it('trusted TED executor keeps deterministic validation errors (no uncertainty broadening)', async () => {
      const contract = requireApprovalToolContract('transactions.expense.create');
      await expect(
        contract.executor({
          writes: {} as unknown as WriteStore,
          workspaceId: randomUUID(),
          args: {},
          idempotencyKey: 'k-validation',
        }),
      ).rejects.toThrow('validation.invalid_expense_arguments');
    });
  });
}

defineUncertaintySuite(
  'pending-v2 execution uncertainty (in-memory)',
  (opts) => createInMemoryPendingOperationV2Store(opts),
);

const DB_URL = process.env.DATABASE_URL_TEST;

if (!DB_URL) {
  console.log(
    '[pending-v2-uncertainty] SKIP: DATABASE_URL_TEST is not set — Postgres half skipped. ' +
      'The in-memory half above still covers execution uncertainty.',
  );
  describe.skip('pending-v2 execution uncertainty (postgres)', () => {});
} else {
  describe('pending-v2 execution uncertainty (postgres)', () => {
    let pool: Pool;
    const workspaces = new Set<string>();

    beforeAll(async () => {
      pool = createPool({ connectionString: DB_URL, max: 4 });
      await requireTestDatabase(pool, 'pending-v2-uncertainty');
    }, 30_000);

    afterAll(async () => {
      if (workspaces.size > 0) {
        await pool.query('DELETE FROM pending_operations WHERE workspace_id = ANY($1)', [[...workspaces]]);
      }
      await pool.end();
    });

    defineUncertaintySuite(
      'pending-v2 execution uncertainty (postgres)',
      (opts) => createPostgresPendingOperationV2Store(pool, opts),
      {
        trackWorkspace: (workspaceId: string) => {
          workspaces.add(workspaceId);
        },
      },
    );
  });
}
