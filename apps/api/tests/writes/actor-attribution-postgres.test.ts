/**
 * T09 (fatia FÁTICA) — RED: autoria do ator autenticado em novos records.
 *
 * Defeito provado: callsites financeiros usam a forma string de
 * `lookupOrRecord(householdId, key, payload, producer)` — sem ator. O
 * `authenticatedContext` da sessão (actorId/actorType server-side) é
 * descartado e o Postgres persiste `actor_id='device'` genérico
 * (canônico) mesmo quando a sessão tem ator identificado.
 *
 * GREEN (mesma fatia): 5º parâmetro opcional tipado
 * `IdempotencyActorContext` na forma string — só sessão autenticada,
 * nunca body — persistido em `operation_records.actor_id/actor_type`
 * e no `audit_logs` canônico do fresh claim. Sem migration (colunas já
 * existem via V013/V016), sem mudar chave composta (replay/hash
 * preservados), sem tocar eleição FIX-188 do undo.
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import {
  createInMemoryIdempotencyStore,
  httpIdempotencyPayload,
} from '../../src/writes/idempotency.js';
import type { IdempotencyActorContext } from '../../src/writes/idempotency.js';
import { createPostgresIdempotencyStore } from '../../src/writes/postgres.js';
import { createExpenseInputSchema } from '../../src/writes/types.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[actor-attribution-postgres] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are required — Postgres proofs skipped.',
  );
}

const sessionActor = (): IdempotencyActorContext => ({
  actorId: `user-${randomUUID()}`,
  actorType: 'user',
});

describe('T09 — actor attribution is never read from the body', () => {
  it('expense schema strips a smuggled actorId (server-side context only)', () => {
    const parsed = createExpenseInputSchema.safeParse({
      description: '-mercado',
      amountCents: 1500,
      date: '2026-10-18',
      accountId: randomUUID(),
      categoryId: randomUUID(),
      actorId: 'attacker-user',
      actor_id: 'attacker-user',
      actorType: 'user',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('actorId' in parsed.data).toBe(false);
      expect('actor_id' in parsed.data).toBe(false);
      expect('actorType' in parsed.data).toBe(false);
    }
  });

  it('in-memory: explicit actor never changes the composite key (replay stable)', async () => {
    const store = createInMemoryIdempotencyStore();
    const household = randomUUID();
    const key = `t09-${randomUUID()}`;
    const payload = { op: 'expense.create', amountCents: 1500 };
    const first = await store.lookupOrRecord(household, key, payload, async () => ({ ok: true }));
    expect(first.replayed).toBe(false);
    const actor = sessionActor();
    const second = await store.lookupOrRecord(household, key, payload, async () => ({ ok: false }), actor);
    expect(second.replayed).toBe(true);
    expect(second.response).toEqual({ ok: true });
  });
});

describeIfDb('T09 — postgres persists the authenticated session actor (pool max:4)', () => {
  let pool: Pool;
  const households: string[] = [];

  beforeAll(async () => {
    pool = createPool({ connectionString: DB_URL!, max: 4 });
    await requireTestDatabase(pool, 'actor-attribution-postgres');
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool && households.length > 0) {
      await pool
        .query(
          'DELETE FROM audit_logs WHERE operation_record_id IN (SELECT id FROM operation_records WHERE workspace_id = ANY($1))',
          [households],
        )
        .catch(() => undefined);
      await pool.query('DELETE FROM operation_records WHERE workspace_id = ANY($1)', [households]).catch(() => undefined);
    }
    await pool?.end();
  });

  it('fresh record carries the session actor, not generic device', async () => {
    const household = randomUUID();
    households.push(household);
    const store = createPostgresIdempotencyStore({ pool });
    const actor = sessionActor();
    const key = `t09-actor-${randomUUID()}`;
    const payload = httpIdempotencyPayload({ route: 'POST /transactions/expense' }, { amountCents: 1500 });

    const result = await store.lookupOrRecord(household, key, payload, async () => ({ ok: true }), actor);
    expect(result.replayed).toBe(false);

    const record = await pool.query<{ id: string; actor_id: string; actor_type: string; payload_hash: string }>(
      'SELECT id, actor_id, actor_type, payload_hash FROM operation_records WHERE workspace_id = $1 AND idempotency_key = $2',
      [household, key],
    );
    expect(record.rowCount).toBe(1);
    // RED antes do fix: persiste 'device' genérico (ator da sessão descartado).
    expect(record.rows[0]!.actor_id).toBe(actor.actorId);
    expect(record.rows[0]!.actor_type).toBe('user');

    const audit = await pool.query<{ actor_id: string; actor_type: string }>(
      'SELECT actor_id, actor_type FROM audit_logs WHERE operation_record_id = $1',
      [record.rows[0]!.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.actor_id).toBe(actor.actorId);
    expect(audit.rows[0]!.actor_type).toBe('user');
  });

  it('replay keeps the original actor and response (no history rewrite)', async () => {
    const household = randomUUID();
    households.push(household);
    const store = createPostgresIdempotencyStore({ pool });
    const firstActor = sessionActor();
    const key = `t09-replay-${randomUUID()}`;
    const payload = httpIdempotencyPayload({ route: 'POST /transactions/expense' }, { amountCents: 2000 });

    const first = await store.lookupOrRecord(household, key, payload, async () => ({ ok: true, n: 1 }), firstActor);
    expect(first.replayed).toBe(false);

    const otherActor = sessionActor();
    const second = await store.lookupOrRecord(household, key, payload, async () => ({ ok: false, n: 2 }), otherActor);
    expect(second.replayed).toBe(true);
    expect(second.response).toEqual({ ok: true, n: 1 });

    const record = await pool.query<{ actor_id: string }>(
      'SELECT actor_id FROM operation_records WHERE workspace_id = $1 AND idempotency_key = $2',
      [household, key],
    );
    expect(record.rows[0]!.actor_id).toBe(firstActor.actorId);
  });

  it('payload hash is identical with or without the explicit actor', async () => {
    const household = randomUUID();
    households.push(household);
    const store = createPostgresIdempotencyStore({ pool });
    const payload = httpIdempotencyPayload({ route: 'POST /transactions/expense' }, { amountCents: 3000 });

    await store.lookupOrRecord(household, `t09-hash-a-${randomUUID()}`, payload, async () => ({ ok: true }));
    await store.lookupOrRecord(
      household,
      `t09-hash-b-${randomUUID()}`,
      payload,
      async () => ({ ok: true }),
      sessionActor(),
    );

    const hashes = await pool.query<{ payload_hash: string }>(
      'SELECT payload_hash FROM operation_records WHERE workspace_id = $1 ORDER BY created_at',
      [household],
    );
    expect(hashes.rowCount).toBe(2);
    expect(hashes.rows[0]!.payload_hash).toBe(hashes.rows[1]!.payload_hash);
  });
});
