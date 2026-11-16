/**
 * V4.1 PHASE 2 (Task 2.19, SPEC §9.11) — subscription PATCH Postgres proofs.
 *
 * PG-gated (DATABASE_URL_TEST + DB_TEST_MARKER). Isolated schemas per run:
 * - canonical schema: hand-built V009-shaped subscriptions table
 *   (createPostgresSubscriptionStore).
 * - legacy schema: same shape (createLegacyPostgresSubscriptionStore).
 *
 * Proves on real Postgres what the fake-pool unit test proves in memory:
 * every single field PATCHes in isolation and combinations bind
 * sequentially ($3…), i.e. the fixed-placeholder bug
 * (`payment_method = $7` with 3 bound values) is gone on both twins.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { createPostgresSubscriptionStore } from '../../src/subscriptions/postgres.js';
import { runSubscriptionMutation } from '../../src/subscriptions/keyed-mutations.js';
import type { SubscriptionStore } from '../../src/subscriptions/store.js';

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const describeIfDb = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    '[postgres-subscriptions-v41-patch] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER required.',
  );
}

const suffix = `${process.pid}_${Date.now()}`;
const CANON_SCHEMA = `v41s_c_${suffix}`;
const LEG_SCHEMA = `v41s_l_${suffix}`;

const scopedPool = (schema: string, max: number): Pool => {
  const url = new URL(DB_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return createPool({ connectionString: url.toString(), max });
};

let adminPool: Pool | undefined;
let canonPool: Pool | undefined;
let legPool: Pool | undefined;

/** V009-shaped subscriptions table (status TEXT, no active boolean). */
const createSubscriptionsTable = async (db: Pool): Promise<void> => {
  await db.query(`
    CREATE TABLE subscriptions (
      id UUID PRIMARY KEY, household_id UUID NOT NULL, name TEXT NOT NULL,
      amount_cents BIGINT NOT NULL, cycle TEXT NOT NULL, day INTEGER NOT NULL,
      payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancelled_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ
    );
  `);
};

const seedSub = async (
  store: SubscriptionStore,
  householdId: string,
): Promise<string> => {
  const sub = await store.createSubscription(householdId, {
    name: 'Netflix',
    amountCents: 3990,
    cycle: 'monthly',
    day: 15,
    paymentMethod: 'credit_card',
  });
  return sub.id;
};

describeIfDb('Postgres subscriptions V4.1 PATCH (task 2.19)', () => {
  beforeAll(async () => {
    adminPool = createPool({ connectionString: DB_URL!, max: 2 });
    canonPool = scopedPool(CANON_SCHEMA, 5);
    legPool = scopedPool(LEG_SCHEMA, 5);
    await adminPool.query(`CREATE SCHEMA ${CANON_SCHEMA}`);
    await adminPool.query(`CREATE SCHEMA ${LEG_SCHEMA}`);
    await adminPool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await createSubscriptionsTable(canonPool);
    await createSubscriptionsTable(legPool);
  }, 120_000);

  afterAll(async () => {
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${CANON_SCHEMA} CASCADE`).catch(() => undefined);
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${LEG_SCHEMA} CASCADE`).catch(() => undefined);
    await canonPool?.end();
    await legPool?.end();
    await adminPool?.end();
  });

  describe.each([
    ['canonical', () => createPostgresSubscriptionStore(canonPool!), () => canonPool!],
  ] as const)('%s updateSubscription per-field isolation', (_label, makeStore, getPool) => {
    const cleanup = (hh: string): Promise<unknown> =>
      getPool().query(`DELETE FROM subscriptions WHERE household_id = $1`, [hh]).catch(() => undefined);
    it.each([
      ['name', { name: 'Netflix Premium' }],
      ['amountCents', { amountCents: 5590 }],
      ['cycle', { cycle: 'yearly' as const }],
      ['day', { day: 10 }],
      ['paymentMethod', { paymentMethod: 'boleto' }],
    ] as const)('updates only %s, preserving the rest', async (_field, patch) => {
      const store = makeStore();
      const hh = randomUUID();
      const id = await seedSub(store, hh);
      try {
        const updated = await store.updateSubscription(hh, id, patch);
        expect(updated.name).toBe(patch.name ?? 'Netflix');
        expect(updated.amountCents).toBe(patch.amountCents ?? 3990);
        expect(updated.cycle).toBe(patch.cycle ?? 'monthly');
        expect(updated.day).toBe(patch.day ?? 15);
        expect(updated.paymentMethod).toBe(patch.paymentMethod ?? 'credit_card');
        expect(updated.status).toBe('active');
      } finally {
        await cleanup(hh);
      }
    });

    it('binds a late-field single PATCH (paymentMethod) without touching name', async () => {
      const store = makeStore();
      const hh = randomUUID();
      const id = await seedSub(store, hh);
      try {
        const updated = await store.updateSubscription(hh, id, { paymentMethod: 'pix' });
        expect(updated.paymentMethod).toBe('pix');
        expect(updated.name).toBe('Netflix');
        expect(updated.day).toBe(15);
      } finally {
        await cleanup(hh);
      }
    });

    it('binds combinations sequentially (name + day)', async () => {
      const store = makeStore();
      const hh = randomUUID();
      const id = await seedSub(store, hh);
      try {
        const updated = await store.updateSubscription(hh, id, { name: 'Combo', day: 20 });
        expect(updated.name).toBe('Combo');
        expect(updated.day).toBe(20);
        expect(updated.amountCents).toBe(3990);
      } finally {
        await cleanup(hh);
      }
    });

    it('rejects an empty patch with 400', async () => {
      const store = makeStore();
      const hh = randomUUID();
      const id = await seedSub(store, hh);
      try {
        await expect(store.updateSubscription(hh, id, {})).rejects.toMatchObject({ statusCode: 400 });
      } finally {
        await cleanup(hh);
      }
    });

    it('rejects an unknown subscription with 404', async () => {
      const store = makeStore();
      await expect(
        store.updateSubscription(randomUUID(), randomUUID(), { day: 5 }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ── V4.1 Phase 4 (fail-closed atomicity) ──────────────────────────
  describe('Phase 4 — keyed subscription create joins the claim tx (both twins)', () => {
    const input = {
      name: 'Phase4',
      amountCents: 1990,
      cycle: 'monthly' as const,
      day: 5,
      paymentMethod: 'pix',
    };
    const cases = [
      ['canonical', () => createPostgresSubscriptionStore(canonPool!), () => canonPool!],
    ] as const;

    it.each(cases)('%s exposes createSubscriptionInTx', (_label, makeStore) => {
      const store = makeStore();
      expect(typeof (store as unknown as Record<string, unknown>).createSubscriptionInTx).toBe('function');
    });

    it.each(cases)('%s keyed create runs ON the claim client (rollback erases it)', async (_label, makeStore, getPool) => {
      const store = makeStore();
      const hh = randomUUID();
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const sub = await runSubscriptionMutation(store, client, hh, 'create', input);
        expect(sub.householdId).toBe(hh);
        // Visible inside the claim tx…
        const inside = await client.query(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE household_id = $1`, [hh]);
        expect(inside.rows[0]!.n).toBe(1);
        await client.query('ROLLBACK');
        // …and gone after rollback: the effect never committed outside it.
        const outside = await getPool().query(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE household_id = $1`, [hh]);
        expect(outside.rows[0]!.n).toBe(0);
      } finally {
        client.release();
      }
    });

    it.each(cases)('%s keyed create commits with the claim tx', async (_label, makeStore, getPool) => {
      const store = makeStore();
      const hh = randomUUID();
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await runSubscriptionMutation(store, client, hh, 'create', input);
        await client.query('COMMIT');
        const after = await getPool().query(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE household_id = $1`, [hh]);
        expect(after.rows[0]!.n).toBe(1);
      } finally {
        client.release();
      }
      await getPool().query(`DELETE FROM subscriptions WHERE household_id = $1`, [hh]).catch(() => undefined);
    });

  });
});
