// SPIKE 05D — Postgres helper + synthetic seed (DB ted_spike_05d ONLY).
//
// All rows here are SYNTHETIC experiment data with UUIDs copied from the
// frozen fixture spike-05/fixtures/synthetic-case-35-mercado.json (which in
// turn copies apps/api/tests/fixtures/seed.ts — never modified, never real).
// This module NEVER touches ted_local / pi_financeiro / postgres: every
// connection targets SPIKE05D_DATABASE_URL, and the bridge-pg refuses any URL
// mentioning a non-spike database name.
//
// Seed is idempotent (ON CONFLICT DO NOTHING). Households A/B, accounts
// Itaú/Nubank (+Bradesco B for scoping reads), categories Mercado/Aluguel/
// Salário (+Mercado B). No transactions are seeded: the ledger starts empty
// and every effect in the tests comes from the real Pending V2 executor.

import { createRequire } from 'node:module';

const apiRequire = createRequire('D:/projetos/pi-financeiro/apps/api/package.json');
const { Pool } = apiRequire('pg');

export const HOUSEHOLD_A = '00000000-0000-4000-8000-00000000000a';
export const HOUSEHOLD_B = '00000000-0000-4000-8000-00000000000b';
export const ACCOUNT_ITAU = '11111111-1111-4111-8111-111111111111';
export const ACCOUNT_NUBANK = '11111111-1111-4111-8111-111111111112';
export const ACCOUNT_BRADESCO_B = '11111111-1111-4111-8111-111111111113';
export const CATEGORY_MERCADO = '22222222-2222-4222-8222-222222222221';
export const CATEGORY_ALUGUEL = '22222222-2222-4222-8222-222222222222';
export const CATEGORY_SALARIO = '22222222-2222-4222-8222-222222222223';

export function assertSpikeDatabaseUrl(url) {
  const refuse = () => {
    // Never echo the URL: it may carry the synthetic local password.
    throw new Error('refusing non-spike database (only ted_spike_05d)');
  };
  let parsed = null;
  try {
    parsed = new URL(String(url));
  } catch {
    refuse();
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') refuse();
  if (parsed.hostname !== '127.0.0.1') refuse();
  if (parsed.port !== '5433') refuse();
  if (parsed.pathname !== '/ted_spike_05d') refuse();
  if (parsed.search !== '' || parsed.hash !== '') refuse();
  if (parsed.username !== 'postgres') refuse();
  if (parsed.password !== '' && parsed.password !== 'postgres') refuse();
}

export function spikeDbUrl() {
  const url = (process.env.SPIKE05D_DATABASE_URL || '').trim();
  if (!url) throw new Error('SPIKE05D_DATABASE_URL is required (never hardcoded)');
  assertSpikeDatabaseUrl(url);
  return url;
}

export function spikePool() {
  return new Pool({ connectionString: spikeDbUrl() });
}

export function yesterdayUTC(nowMs = Date.now()) {
  return new Date(nowMs - 24 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function ensureSeed05d(pool) {
  await pool.query(
    `INSERT INTO accounts (id, household_id, name, kind, balance_cents, status)
     VALUES
       ($1::uuid, $2::uuid, 'Itaú', 'bank', 100000, 'active'),
       ($3::uuid, $2::uuid, 'Nubank', 'bank', 50000, 'active'),
       ($4::uuid, $5::uuid, 'Bradesco', 'bank', 99999, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [ACCOUNT_ITAU, HOUSEHOLD_A, ACCOUNT_NUBANK, ACCOUNT_BRADESCO_B, HOUSEHOLD_B],
  );
  await pool.query(
    `INSERT INTO categories (id, household_id, name, kind, status)
     VALUES
       ($1::uuid, $2::uuid, 'Mercado', 'expense', 'active'),
       ($3::uuid, $2::uuid, 'Aluguel', 'expense', 'active'),
       ($4::uuid, $2::uuid, 'Salário', 'income', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [CATEGORY_MERCADO, HOUSEHOLD_A, CATEGORY_ALUGUEL, CATEGORY_SALARIO],
  );
}

// Scoped reset for ONE test scope: removes prior-run rows for the given
// idempotency keys / intention ids / descriptions. Household-scoped deletes
// are safe: this DB holds synthetic spike rows only.
export async function resetScope05d(pool, { keys = [], intentions = [], descriptions = [] } = {}) {
  if (keys.length > 0) {
    await pool.query(`DELETE FROM pending_operations WHERE workspace_id = $1 AND idempotency_key = ANY($2)`, [HOUSEHOLD_A, keys]);
    // V2 execution records live namespaced (`pending-v2:<key>`) in the same
    // table (pending-idempotency.ts); HTTP-layer records (if any) use the raw
    // key. Both must go or a re-run replays a deleted transaction id.
    const namespaced = keys.map((k) => `pending-v2:${k}`);
    await pool.query(`DELETE FROM idempotency_keys WHERE household_id = $1 AND (key = ANY($2) OR key = ANY($3))`, [HOUSEHOLD_A, keys, namespaced]);
  }
  if (intentions.length > 0) {
    await pool.query(
      `DELETE FROM pending_operation_confirmation_intentions WHERE workspace_id = $1 AND actor_id = $2 AND device_id = $3 AND intention_id = ANY($4)`,
      [HOUSEHOLD_A, 'dev-device-1', 'dev-device-1', intentions],
    );
  }
  if (descriptions.length > 0) {
    await pool.query(`DELETE FROM transactions WHERE household_id = $1 AND description = ANY($2)`, [HOUSEHOLD_A, descriptions]);
  }
}

export async function countTx05d(pool, { description, accountId, date }) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE household_id = $1 AND description = $2 AND account_id = $3::uuid AND date = $4::date AND deleted_at IS NULL`,
    [HOUSEHOLD_A, description, accountId, date],
  );
  return r.rows[0].n;
}

export async function getTx05d(pool, id) {
  const r = await pool.query(`SELECT id, household_id, kind, description, amount_cents, date, account_id, category_id FROM transactions WHERE id = $1::uuid`, [id]);
  return r.rows[0] ?? null;
}

export async function getPending05d(pool, id) {
  const r = await pool.query(`SELECT id, execution_status, idempotency_key, proposal_hash FROM pending_operations WHERE id = $1::uuid`, [id]);
  return r.rows[0] ?? null;
}
