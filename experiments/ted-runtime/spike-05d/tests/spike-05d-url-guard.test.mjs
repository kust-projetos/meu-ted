// SPIKE 05D — URL guard unit test (pure, no DB, 0 connections/effects).
//
// Pins the strict SPIKE05D_DATABASE_URL allowlist: only
// 127.0.0.1:5433/ted_spike_05d (postgres user, synthetic local password)
// passes; every divergent db/host/port is refused with a typed error
// BEFORE any connection. Covers reviewer finding 05D-REV-01 P1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSpikeDatabaseUrl } from '../scripts/db-05d.mjs';

const VALID = 'postgresql://postgres:postgres@127.0.0.1:5433/ted_spike_05d';

test('05D URL guard: valid spike URL passes, divergent db/host/port refused typed', () => {
  assert.doesNotThrow(() => assertSpikeDatabaseUrl(VALID), 'canonical spike URL must pass');
  const bad = [
    'postgresql://postgres:postgres@127.0.0.1:5433/ted_local',
    'postgresql://postgres:postgres@127.0.0.1:5433/pi_financeiro',
    'postgresql://postgres:postgres@db.example.com:5433/ted_spike_05d',
    'postgresql://postgres:postgres@127.0.0.1:5432/ted_spike_05d',
    'postgresql://postgres:postgres@127.0.0.1:5433/ted_spike_05d_x',
  ];
  assert.equal(bad.length, 5);
  for (const url of bad) {
    assert.throws(
      () => assertSpikeDatabaseUrl(url),
      /refusing non-spike database/,
      'must refuse before connecting',
    );
  }
});
