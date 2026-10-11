/**
 * Phase 0.2.1 — RED: database without server-side marker must be rejected.
 *
 * Tests validateTestDatabase and requireTestDatabase from db-guard.ts.
 * Uses a fake pool to simulate Postgres responses without a real DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateTestDatabase, requireTestDatabase } from '../../src/db/db-guard.js';

/** Minimal fake that satisfies the DbPool interface enough for the guard. */
const fakePool = (queryResults: Record<string, unknown[]>) => {
  const client = {
    query: async (sql: string) => {
      // Match the query to return the right result
      if (sql.includes('information_schema.tables') && sql.includes('_test_marker')) {
        return { rows: queryResults.markerTable ?? [] };
      }
      if (sql.includes('_test_marker') && sql.includes('marker_value')) {
        return { rows: queryResults.markerValue ?? [], rowCount: queryResults.markerValue?.length ?? 0 };
      }
      if (sql.includes('current_database()')) {
        const rows = queryResults.currentDb as Array<{ current_database: string }> | undefined;
        return { rows: rows ?? [{ current_database: 'test_db' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return {
    connect: async () => client,
    options: queryResults.options as { host?: string } | undefined,
  } as unknown as import('../../src/db/pool.js').DbPool;
};

// Save original env vars
const originalEnv = { ...process.env };

describe('G0.2.1 — validateTestDatabase rejects when marker is missing', () => {
  beforeEach(() => {
    // Set marker expectation
    process.env.DB_TEST_MARKER = 'deadbeef-dead-beef-dead-beefdeadbeef';
    delete process.env.DATABASE_URL_TEST;
    process.env.DB_BLOCKED_NAMES = 'pi_financeiro,pi_financeiro_prod';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects when _test_marker table does not exist', async () => {
    const pool = fakePool({ markerTable: [{ exists: false }] });
    const result = await validateTestDatabase(pool);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('_test_marker');
  });

  it('rejects when marker value does not match', async () => {
    const pool = fakePool({
      markerTable: [{ exists: true }],
      markerValue: [{ marker_value: 'wrong-marker' }],
    });
    const result = await validateTestDatabase(pool);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('marker value mismatch');
  });

  it('rejects when marker table has no rows', async () => {
    const pool = fakePool({
      markerTable: [{ exists: true }],
      markerValue: [],
    });
    const result = await validateTestDatabase(pool);
    expect(result.allowed).toBe(false);
  });

  it('rejects when database name is in blocked list', async () => {
    const pool = fakePool({
      markerTable: [{ exists: true }],
      markerValue: [{ marker_value: 'deadbeef-dead-beef-dead-beefdeadbeef' }],
      currentDb: [{ current_database: 'pi_financeiro' }],
    });
    const result = await validateTestDatabase(pool);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('pi_financeiro');
  });

  it('allows when marker matches and DB is not blocked', async () => {
    const pool = fakePool({
      markerTable: [{ exists: true }],
      markerValue: [{ marker_value: 'deadbeef-dead-beef-dead-beefdeadbeef' }],
      currentDb: [{ current_database: 'test_db' }],
    });
    const result = await validateTestDatabase(pool);
    expect(result.allowed).toBe(true);
  });

  it('rejects via requireTestDatabase (throws)', async () => {
    const pool = fakePool({ markerTable: [{ exists: false }] });
    await expect(requireTestDatabase(pool, 'test_op')).rejects.toThrow('test_op');
  });

  it('requireTestDatabase does not throw when allowed', async () => {
    const pool = fakePool({
      markerTable: [{ exists: true }],
      markerValue: [{ marker_value: 'deadbeef-dead-beef-dead-beefdeadbeef' }],
      currentDb: [{ current_database: 'test_db' }],
    });
    await expect(requireTestDatabase(pool, 'migration')).resolves.toBeUndefined();
  });

  it('rejects when no marker configured and no DATABASE_URL_TEST opt-in', async () => {
    delete process.env.DB_TEST_MARKER;
    delete process.env.DATABASE_URL_TEST;
    const pool = fakePool({});
    const result = await validateTestDatabase(pool);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('DB_TEST_MARKER or DATABASE_URL_TEST');
  });

  it('TRUNCATE is blocked when marker is missing (end-to-end guard)', async () => {
    const pool = fakePool({ markerTable: [{ exists: false }] });
    await expect(requireTestDatabase(pool, 'truncate')).rejects.toThrow(/truncate.*_test_marker/);
  });
});

describe('G0.2.2 — protected production DB names are ALWAYS blocked', () => {
  beforeEach(() => {
    // Marker passes so the test reaches the database-name rule (Rule 2).
    process.env.DB_TEST_MARKER = 'deadbeef-dead-beef-dead-beefdeadbeef';
    delete process.env.DATABASE_URL_TEST;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('blocks pi_financeiro_canonical even when DB_BLOCKED_NAMES is customized without it', async () => {
    process.env.DB_BLOCKED_NAMES = 'some_other_test_db';
    const pool = fakePool({
      markerTable: [{ exists: true }],
      markerValue: [{ marker_value: 'deadbeef-dead-beef-dead-beefdeadbeef' }],
      currentDb: [{ current_database: 'pi_financeiro_canonical' }],
    });
    const result = await validateTestDatabase(pool);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('pi_financeiro_canonical');
  });

  it('blocks every protected production name even when DB_BLOCKED_NAMES is empty', async () => {
    process.env.DB_BLOCKED_NAMES = '';
    for (const name of ['pi_financeiro', 'pi_financeiro_prod', 'pi_financeiro_canonical']) {
      const pool = fakePool({
        markerTable: [{ exists: true }],
        markerValue: [{ marker_value: 'deadbeef-dead-beef-dead-beefdeadbeef' }],
        currentDb: [{ current_database: name }],
      });
      const result = await validateTestDatabase(pool);
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toContain(name);
    }
  });

  it('customized DB_BLOCKED_NAMES stays additive (custom names still block)', async () => {
    process.env.DB_BLOCKED_NAMES = 'shared_db,scratch';
    const pool = fakePool({
      markerTable: [{ exists: true }],
      markerValue: [{ marker_value: 'deadbeef-dead-beef-dead-beefdeadbeef' }],
      currentDb: [{ current_database: 'scratch' }],
    });
    const result = await validateTestDatabase(pool);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('scratch');
  });
});
