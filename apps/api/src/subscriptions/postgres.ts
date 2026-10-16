/**
 * Postgres implementation of SubscriptionStore.
 *
 * Expects a `subscriptions` table with columns matching the Subscription
 * domain type.
 */

import type { Pool, PoolClient } from 'pg';
import type { Subscription } from '../types/domain.js';
import { withTransaction } from '../db/pool.js';
import { assertWorkspaceWritableInTx } from '../auth/workspace-lifecycle-guard.js';
import { domainErrors } from '../writes/errors.js';
import type { CreateSubscriptionInput, SubscriptionStore, } from './store.js';

type Row = Record<string, unknown>;

const mapSubscription = (r: Row): Subscription => {
  const cancelledAt = r['cancelled_at'] != null ? (r['cancelled_at'] as Date).toISOString() : undefined;
  const base: Subscription = {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    name: r['name'] as string,
    amountCents: Number(r['amount_cents']),
    cycle: r['cycle'] as Subscription['cycle'],
    day: Number(r['day']),
    paymentMethod: r['payment_method'] as string,
    status: r['status'] as Subscription['status'],
    createdAt: (r['created_at'] as Date).toISOString(),
  };
  if (cancelledAt) (base as any).cancelledAt = cancelledAt;
  return base;
};

/**
 * V4.1 Phase 3 (UOW2) — client-bound subscription-creation core (no
 * transaction handling). The plain method runs it in its own transaction;
 * the keyed route producer (see subscriptions/keyed-mutations.ts) runs it
 * on the open idempotency claim client, so claim + effect + completion
 * commit atomically in ONE transaction.
 */
export const createSubscriptionInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateSubscriptionInput,
): Promise<Subscription> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  const res = await client.query<Row>(
    `INSERT INTO subscriptions (id, household_id, name, amount_cents, cycle, day, payment_method, status, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'active', NOW())
     RETURNING id, household_id, name, amount_cents, cycle, day, payment_method, status, created_at, cancelled_at`,
    [householdId, input.name, input.amountCents, input.cycle, input.day, input.paymentMethod],
  );
  return mapSubscription(res.rows[0]!);
};

export const createPostgresSubscriptionStore = (pool: Pool): SubscriptionStore => {  const query = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> => {
    const res = await pool.query<R>(text, values);
    return res.rows;
  };

  const store: SubscriptionStore = {
    async listSubscriptions(householdId, status) {
      const values: unknown[] = [householdId];
      const statusClause = status ? ` AND status = $2` : '';
      if (status) values.push(status);
      const rows = await query<Row>(
        `SELECT id, household_id, name, amount_cents, cycle, day, payment_method,
                status, created_at, cancelled_at
           FROM subscriptions
          WHERE household_id = $1
            AND deleted_at IS NULL${statusClause}
          ORDER BY created_at DESC`,
        values,
      );
      return rows.map(mapSubscription);
    },

    async createSubscription(householdId, input) {
      return withTransaction(pool, (client) => createSubscriptionInTx(client, householdId, input));
    },

    async cancelSubscription(householdId, id) {
      return withTransaction(pool, async (client) => {
        // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
        await assertWorkspaceWritableInTx(client, householdId);
        const existing = await client.query<Row>(
          `SELECT id, household_id, name, amount_cents, cycle, day, payment_method, status, created_at, cancelled_at
             FROM subscriptions
            WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
          [id, householdId],
        );
        if (existing.rowCount === 0) throw domainErrors.notFound('Assinatura');
        const sub = mapSubscription(existing.rows[0]!);
        if (sub.status !== 'active') throw domainErrors.invalid('status', 'assinatura não está ativa');

        const res = await client.query<Row>(
          `UPDATE subscriptions
              SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND household_id = $2
            RETURNING id, household_id, name, amount_cents, cycle, day, payment_method, status, created_at, cancelled_at`,
          [id, householdId],
        );
        return mapSubscription(res.rows[0]!);
      });
    },

    async getSubscription(householdId, id) {
      const rows = await query<Row>(
        `SELECT id, household_id, name, amount_cents, cycle, day, payment_method, status, created_at, cancelled_at
           FROM subscriptions
          WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
        [id, householdId],
      );
      if (rows.length === 0) return null;
      return mapSubscription(rows[0]!);
    },

    async updateSubscription(householdId, id, input) {
      return withTransaction(pool, async (client) => {
        // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
        await assertWorkspaceWritableInTx(client, householdId);
        const existing = await client.query<Row>(
          `SELECT id FROM subscriptions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`,
          [id, householdId],
        );
        if (existing.rowCount === 0) throw domainErrors.notFound('Assinatura');

        const sets: string[] = [];
        const params: unknown[] = [];
        // Keys id/householdId are unshifted as $1/$2 below, so the first
        // field placeholder must be $3 (was: idx = 1 → $2, misbinding
        // every PATCH and supplying one param too many).
        let idx = 2;
        if (input.name !== undefined) { sets.push(`name = $${++idx}`); params.push(input.name); }
        if (input.amountCents !== undefined) { sets.push(`amount_cents = $${++idx}`); params.push(input.amountCents); }
        if (input.cycle !== undefined) { sets.push(`cycle = $${++idx}`); params.push(input.cycle); }
        if (input.day !== undefined) { sets.push(`day = $${++idx}`); params.push(input.day); }
        if (input.paymentMethod !== undefined) { sets.push(`payment_method = $${++idx}`); params.push(input.paymentMethod); }
        if (sets.length === 0) throw domainErrors.invalid('body', 'nenhum campo para atualizar');

        params.unshift(id, householdId);
        const res = await client.query<Row>(
          `UPDATE subscriptions SET ${sets.join(', ')}, updated_at = NOW()
            WHERE id = $1 AND household_id = $2
            RETURNING id, household_id, name, amount_cents, cycle, day, payment_method, status, created_at, cancelled_at`,
          params,
        );
        return mapSubscription(res.rows[0]!);
      });
    },
  };
  // V4.1 Phase 3 (UOW2): expose the client-bound core as a non-contractual
  // extension (see SubscriptionStoreTxExtensions in
  // subscriptions/keyed-mutations.ts). The declared factory return type
  // stays SubscriptionStore.
  return Object.assign(store, {
    createSubscriptionInTx,
  });
};
