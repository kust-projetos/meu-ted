/**
 * T2.3 — TX1 (claim) → executor OUTSIDE the transaction → TX2 (terminal
 * persist) (SPEC §10, H-04; ADR-013).
 *
 * Dual-store fault-injection suite (in-memory always; Postgres gated by
 * DATABASE_URL_TEST + requireTestDatabase, same pattern as the sibling
 * suites): a failure after attestation consumption must NEVER roll the
 * claim back — the DB stays `failed`, the attestation stays consumed, and
 * the old attestation is never valid again.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  createPostgresPendingOperationV2Store,
  PENDING_V2_EXECUTION_LEASE_MS,
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

const proposeCanonical = async (store: PendingOperationV2Store, identity: PendingIdentity) => {
  const base = {
    version: 2 as const,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    deviceId: identity.deviceId,
    tool: 'transactions.expense.create',
    normalizedArgs: {
      description: 'Claim split probe',
      amountCents: 999,
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

const succeededResult = () => ({ status: 'succeeded', operationId: randomUUID() });

function defineClaimSuite(
  suiteName: string,
  makeStore: () => PendingOperationV2Store,
  hooks: { trackWorkspace?: (workspaceId: string) => void; cleanup?: () => Promise<void> } = {},
): void {
  describe(suiteName, () => {
    const identityOf = (): PendingIdentity => {
      const identity = newIdentity();
      hooks.trackWorkspace?.(identity.workspaceId);
      return identity;
    };

    it('executor throws AFTER claim → DB stays failed, attestation stays consumed, old token never valid', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const issuedAt = confirmed.attestationIssuedAt;
      expect(issuedAt).toBeTruthy();
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          throw new Error('downstream outage: secret-prompt-content must not leak');
        }),
      ).rejects.toThrow('downstream outage');
      const failed = await store.get(saved.id, id);
      expect(failed.status).toBe('failed');
      // Claim columns committed by TX1 survive the executor failure (H-04).
      expect(failed.executionClaimedAt).toBeTruthy();
      expect(failed.executionLeaseExpiresAt).toBeTruthy();
      expect(Date.parse(failed.executionLeaseExpiresAt!)).toBeGreaterThan(Date.parse(failed.executionClaimedAt!));
      expect(failed.executionAttemptCount).toBe(1);
      expect(failed.attestationIssuedAt).toBe(issuedAt);
      // Sanitized failure code: never stack/prompt/content.
      expect(failed.failureCode).toBe('executor.failed');
      // The consumed attestation is never resurrected: replay rejects without
      // running the executor again.
      let reran = false;
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          reran = true;
          return succeededResult();
        }),
      ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
      expect(reran).toBe(false);
      expect((await store.get(saved.id, id)).status).toBe('failed');
    });

    it('executor success path writes succeeded with claim + mutation fields', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const executorResult = succeededResult();
      const done = await store.execute(confirmed.attestation!, id, async () => executorResult);
      expect(done.status).toBe('succeeded');
      expect(done.execution).toMatchObject({ status: 'succeeded', operationId: executorResult.operationId });
      // T3.2 (SPEC §15.1): mutation_id persists the RECEIPT identity, and the
      // execution result carries the receipt (additive envelope). Receipt
      // identity rule: operationId = pending id, entity.id = transaction id.
      const doneExecution = done.execution as { receipt: { mutationId: string; operationId: string; entity: { type: string; id: string } } };
      expect(doneExecution.receipt).toBeTruthy();
      expect(doneExecution.receipt.operationId).toBe(saved.id);
      expect(doneExecution.receipt.entity).toEqual({ type: 'transaction', id: executorResult.operationId });
      expect(done.mutationId).toBe(doneExecution.receipt.mutationId);
      expect(done.executionClaimedAt).toBeTruthy();
      expect(done.executionLeaseExpiresAt).toBeTruthy();
      expect(done.executionAttemptCount).toBe(1);
    });

    it('execute after cancel → attestation_replayed, executor never runs', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      await store.cancel(saved.id, id);
      let ran = false;
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          ran = true;
          return succeededResult();
        }),
      ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
      expect(ran).toBe(false);
    });

    it('execute after expire → attestation_replayed, executor never runs', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      await store.expire(saved.id, id);
      let ran = false;
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          ran = true;
          return succeededResult();
        }),
      ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
      expect(ran).toBe(false);
    });

    it('double execute with the same attestation → second is a replay rejection', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      let runs = 0;
      const done = await store.execute(confirmed.attestation!, id, async () => {
        runs += 1;
        return succeededResult();
      });
      expect(done.status).toBe('succeeded');
      await expect(
        store.execute(confirmed.attestation!, id, async () => {
          runs += 1;
          return succeededResult();
        }),
      ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
      expect(runs).toBe(1);
    });

    it('failure_code sanitization: protocol codes pass through, hostile codes collapse', async () => {
      const store = makeStore();
      const id = identityOf();
      const saved = await proposeCanonical(store, id);
      const confirmed = await store.confirm(saved.id, id);
      const hostile = Object.assign(new Error('stack: Error\n    at prompt(secret)'), {
        code: `x`.repeat(200),
      });
      await expect(store.execute(confirmed.attestation!, id, async () => { throw hostile; })).rejects.toThrow();
      const failed = await store.get(saved.id, id);
      expect(failed.status).toBe('failed');
      expect(failed.failureCode).toBe('executor.failed');

      const id2 = identityOf();
      const saved2 = await proposeCanonical(store, id2);
      const confirmed2 = await store.confirm(saved2.id, id2);
      const proto = Object.assign(new Error('declined'), { code: 'cards.declined' });
      await expect(store.execute(confirmed2.attestation!, id2, async () => { throw proto; })).rejects.toThrow('declined');
      expect((await store.get(saved2.id, id2)).failureCode).toBe('cards.declined');
    });

    it(`lease constant defaults to 60s (${PENDING_V2_EXECUTION_LEASE_MS}ms)`, () => {
      expect(PENDING_V2_EXECUTION_LEASE_MS).toBe(60_000);
    });
  });
}

defineClaimSuite('pending-v2 claim split (in-memory)', () => createInMemoryPendingOperationV2Store());

const DB_URL = process.env.DATABASE_URL_TEST;

if (!DB_URL) {
  console.log(
    '[pending-v2-claim] SKIP: DATABASE_URL_TEST is not set — Postgres half skipped. ' +
      'The in-memory half above still covers the claim split.',
  );
  describe.skip('pending-v2 claim split (postgres)', () => {});
} else {
  describe('pending-v2 claim split (postgres)', () => {
    let pool: Pool;
    const workspaces = new Set<string>();

    beforeAll(async () => {
      pool = createPool({ connectionString: DB_URL, max: 4 });
      await requireTestDatabase(pool, 'pending-v2-claim');
    }, 30_000);

    afterAll(async () => {
      if (workspaces.size > 0) {
        await pool.query('DELETE FROM pending_operations WHERE workspace_id = ANY($1)', [[...workspaces]]);
      }
      await pool.end();
    });

    defineClaimSuite(
      'pending-v2 claim split (postgres)',
      () => createPostgresPendingOperationV2Store(pool),
      {
        trackWorkspace: (workspaceId: string) => {
          workspaces.add(workspaceId);
        },
        cleanup: async () => {
          if (workspaces.size === 0) return;
          const ids = [...workspaces];
          workspaces.clear();
          await pool.query('DELETE FROM pending_operations WHERE workspace_id = ANY($1)', [ids]);
        },
      },
    );
  });
}
