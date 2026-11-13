// SPIKE 05D — idempotent synthetic seed runner (DB ted_spike_05d ONLY).
//
// Usage: SPIKE05D_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/ted_spike_05d \
//   node experiments/ted-runtime/spike-05d/scripts/seed-05d.mjs
//
// Inserts the frozen synthetic accounts/categories (fixture UUIDs) with
// ON CONFLICT DO NOTHING. Safe to re-run. Refuses non-spike database names.

import { spikePool, ensureSeed05d } from './db-05d.mjs';

const pool = spikePool();
try {
  await ensureSeed05d(pool);
  const accounts = await pool.query(`SELECT id, name, kind FROM accounts WHERE household_id = '00000000-0000-4000-8000-00000000000a' ORDER BY name`);
  const categories = await pool.query(`SELECT id, name, kind FROM categories WHERE household_id = '00000000-0000-4000-8000-00000000000a' ORDER BY name`);
  console.log(JSON.stringify({ ok: true, accounts: accounts.rows, categories: categories.rows }));
} finally {
  await pool.end();
}
