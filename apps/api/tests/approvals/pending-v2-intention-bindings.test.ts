/**
 * PR137-HARDEN round 4 P1-B (direction iii) — authoritative intentionId
 * bindings (`pending_operation_confirmation_intentions`, V060).
 *
 * The Agent binds intentionId BEFORE resolving the listing (durable frontier
 * independent of agent storage); confirm() binds intentionId→operationId
 * atomically (identical ⇒ idempotent proceed; divergent ⇒ 409
 * `approval.intention_conflict`, zero effect); execute() verifies the binding
 * when the caller carries one. A redelivery that lost every agent-side
 * marker (total agent-storage outage) can neither resolve-and-confirm a
 * later B (the agent fails closed on the pre-existing API sighting) nor push
 * B through confirm/execute under the old intention (409).
 *
 * In-memory half runs always; the real-PG half (migration V060 applied via
 * `runMigrations`, bind/confirm/divergence/concurrency/restart) is gated by
 * DATABASE_URL_TEST + DB_TEST_MARKER like the sibling postgres suites.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  createPostgresPendingOperationV2Store,
  type PendingIdentity,
} from '../../src/approvals/pending-v2.js';

const H = 'workspace-intent-1';
const IDENTITY: PendingIdentity = { workspaceId: H, actorId: 'actor-1', deviceId: 'device-1' };

const proposal = async (seed: string, key: string): Promise<PendingOperationV2> => {
  const base = {
    version: 2 as const,
    workspaceId: H, actorId: 'actor-1', deviceId: 'device-1',
    tool: 'transactions.expense.create',
    normalizedArgs: {
      description: `Lunch ${seed}`,
      amountCents: 1000,
      date: '2026-09-14',
      accountId: randomUUID(),
      categoryId: randomUUID(),
    },
    proposalHash: '', idempotencyKey: key,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    bindings: { workspaceId: H, actorId: 'actor-1', deviceId: 'device-1' },
  };
  return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
};

const seedOps = async (store: { propose(o: PendingOperationV2): Promise<{ id: string }> }) => {
  const a = await store.propose(await proposal('A', 'key-A'));
  const b = await store.propose(await proposal('B', 'key-B'));
  return { a: a.id, b: b.id };
};

describe('P1-B intention bindings (in-memory)', () => {
  it('bind is fresh once, then replays the stored instant (first writer wins)', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const first = await store.bindConfirmationIntention(IDENTITY, 'intent-1');
    expect(first.fresh).toBe(true);
    expect(first.operationId).toBeNull();
    const second = await store.bindConfirmationIntention(IDENTITY, 'intent-1');
    expect(second.fresh).toBe(false);
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.operationId).toBeNull();
  });

  it('bindings never cross identity legs', async () => {
    const store = createInMemoryPendingOperationV2Store();
    await store.bindConfirmationIntention(IDENTITY, 'intent-1');
    const foreign = await store.bindConfirmationIntention({ ...IDENTITY, actorId: 'actor-2' }, 'intent-1');
    expect(foreign.fresh).toBe(true);
  });

  it('confirm binds X→A; identical re-confirm proceeds; divergent X→B conflicts 409 with zero effect', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const { a, b } = await seedOps(store);
    const confirmed = await store.confirm(a, IDENTITY, undefined, { intentionId: 'intent-X' });
    expect(confirmed.status).toBe('confirmed');
    const bound = await store.bindConfirmationIntention(IDENTITY, 'intent-X');
    expect(bound.fresh).toBe(false);
    expect(bound.operationId).toBe(a);

    // Identical re-bind proceeds (recoverable confirm path).
    const again = await store.confirm(a, IDENTITY, undefined, { intentionId: 'intent-X' });
    expect(again.id).toBe(a);

    // Divergent: 409, and B is untouched (still proposed, no attestation).
    await expect(store.confirm(b, IDENTITY, undefined, { intentionId: 'intent-X' })).rejects.toMatchObject({
      code: 'approval.intention_conflict',
      statusCode: 409,
    });
    expect((await store.get(b, IDENTITY)).status).toBe('proposed');
  });

  it('concurrent racing confirms under one intention elect exactly one operation', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const { a, b } = await seedOps(store);
    const [left, right] = await Promise.allSettled([
      store.confirm(a, IDENTITY, undefined, { intentionId: 'intent-race' }),
      store.confirm(b, IDENTITY, undefined, { intentionId: 'intent-race' }),
    ]);
    const fulfilled = [left, right].filter((r) => r.status === 'fulfilled');
    const rejected = [left, right].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'approval.intention_conflict' });
    const bound = await store.bindConfirmationIntention(IDENTITY, 'intent-race');
    expect(bound.operationId).toBe(
      fulfilled[0].status === 'fulfilled' ? (fulfilled[0].value as { id: string }).id : undefined,
    );
  });

  it('execute verifies the binding: divergent intention refuses with zero effect, identical proceeds', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const { a, b } = await seedOps(store);
    const confirmedA = await store.confirm(a, IDENTITY, undefined, { intentionId: 'intent-X' });
    const attestationA = (confirmedA as { attestation?: string }).attestation!;
    const confirmedB = await store.confirm(b, IDENTITY);
    const attestationB = (confirmedB as { attestation?: string }).attestation!;
    const executor = async () => ({ status: 'succeeded', operationId: 'tx-1' });

    // B's attestation under X (bound to A): refused before the executor runs.
    let executed = 0;
    await expect(
      store.execute(attestationB, IDENTITY, async () => {
        executed += 1;
        return { status: 'succeeded', operationId: 'tx-1' };
      }, b, { intentionId: 'intent-X' }),
    ).rejects.toMatchObject({ code: 'approval.intention_conflict' });
    expect(executed).toBe(0);

    // A's attestation under X: proceeds.
    const done = await store.execute(attestationA, IDENTITY, executor, a, { intentionId: 'intent-X' });
    expect(done.status).toBe('succeeded');
  });
});

// Real Postgres — gated by DATABASE_URL_TEST + DB_TEST_MARKER.
const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);

if (!ENABLED) {
  console.log(
    '[pending-v2-intention-bindings] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — real PG proof skipped.',
  );
}

describe('P1-B intention bindings (real PG)', () => {
  let pool: { query: (...args: never[]) => Promise<{ rows: never[] }>; end: () => Promise<void> } | undefined;
  const workspaces = new Set<string>();

  afterAll(async () => {
    if (!pool) return;
    for (const ws of workspaces) {
      await pool.query(`DELETE FROM pending_operations WHERE workspace_id = $1`, [ws] as never[]).catch(() => undefined);
      await pool.query(`DELETE FROM pending_operation_confirmation_intentions WHERE workspace_id = $1`, [ws] as never[]).catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  });

  const itIfDatabase = ENABLED ? it : it.skip;

  itIfDatabase('V060 applied: bind → confirm binds X→A → divergent X→B 409 → restart (new store) keeps the binding', async () => {
    const { createPool } = await import('../../src/db/pool.js');
    const { requireTestDatabase } = await import('../../src/db/db-guard.js');
    const { runMigrations } = await import('../../src/read-models/sql/migrate.js');
    pool = createPool({ connectionString: DB_URL, max: 4 }) as unknown as typeof pool;
    await requireTestDatabase(pool as never, 'pending-v2-intention-bindings');
    // V060 (like every migration) applies idempotently; without it the
    // statements below fail — the migration IS the deploy contract.
    await runMigrations(pool as never);

    const ws = randomUUID();
    workspaces.add(ws);
    const identity: PendingIdentity = { workspaceId: ws, actorId: 'actor-1', deviceId: 'device-1' };
    const mkProposal = async (seed: string, key: string): Promise<PendingOperationV2> => {
      const base = {
        version: 2 as const,
        workspaceId: ws, actorId: 'actor-1', deviceId: 'device-1',
        tool: 'transactions.expense.create',
        normalizedArgs: {
          description: `Lunch ${seed}`,
          amountCents: 1000,
          date: '2026-09-14',
          accountId: randomUUID(),
          categoryId: randomUUID(),
        },
        proposalHash: '', idempotencyKey: key,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        bindings: { workspaceId: ws, actorId: 'actor-1', deviceId: 'device-1' },
      };
      return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
    };

    const store = createPostgresPendingOperationV2Store(pool as never);
    const a = (await store.propose(await mkProposal('A', 'pg-key-A'))).id;
    const b = (await store.propose(await mkProposal('B', 'pg-key-B'))).id;

    const first = await store.bindConfirmationIntention(identity, 'intent-pg');
    expect(first.fresh).toBe(true);
    expect(first.operationId).toBeNull();
    const replay = await store.bindConfirmationIntention(identity, 'intent-pg');
    expect(replay.fresh).toBe(false);
    expect(replay.firstSeenAt).toBe(first.firstSeenAt);

    // Confirm binds X→A atomically; divergent X→B is refused 409.
    const confirmed = await store.confirm(a, identity, undefined, { intentionId: 'intent-pg' });
    expect(confirmed.status).toBe('confirmed');
    await expect(store.confirm(b, identity, undefined, { intentionId: 'intent-pg' })).rejects.toMatchObject({
      code: 'approval.intention_conflict',
      statusCode: 409,
    });

    // Restart (nova instância, mesmo PG): o vínculo sobrevive — a redelivery
    // pós-restart encontra X→A e nunca confirma B.
    const restarted = createPostgresPendingOperationV2Store(pool as never);
    const rebound = await restarted.bindConfirmationIntention(identity, 'intent-pg');
    expect(rebound.fresh).toBe(false);
    expect(rebound.operationId).toBe(a);
    await expect(restarted.confirm(b, identity, undefined, { intentionId: 'intent-pg' })).rejects.toMatchObject({
      code: 'approval.intention_conflict',
    });

    // Corrida: duas confirmações concorrentes sob uma intenção nova elegem
    // exatamente uma operação (CAS no motor).
    const [left, right] = await Promise.allSettled([
      restarted.confirm(a, identity, undefined, { intentionId: 'intent-race' }),
      restarted.confirm(b, identity, undefined, { intentionId: 'intent-race' }),
    ]);
    expect([left, right].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect([left, right].filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
