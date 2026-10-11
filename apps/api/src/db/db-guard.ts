/**
 * Phase 0.2 — Database test safety guard.
 *
 * Before any destructive operation (migration, truncate, seed),
 * validates that the connected database is NOT production by checking:
 * 1. A server-side marker table exists with expected UUID.
 * 2. current_database() is not a protected/blocked name.
 * 3. Known production hosts are blocked as defense-in-depth.
 *
 * RED: database without expected server-side marker must be rejected
 * before migration/truncation.
 */

import type { DbPool } from './pool.js';

/**
 * Production database names that are ALWAYS blocked for destructive test
 * operations, no matter how `DB_BLOCKED_NAMES` is customized. Customizing the
 * env list can ADD blocked names; it can never REMOVE these protections —
 * `pi_financeiro_canonical` is the current production database (canonical
 * schema server) and must stay unreachable even if an operator narrows the
 * env list or leaves it empty.
 */
const PROTECTED_DB_NAMES: ReadonlySet<string> = new Set([
  'pi_financeiro',
  'pi_financeiro_prod',
  'pi_financeiro_canonical',
]);

/** Resolve marker from env at call time (testable). */
const getExpectedMarker = (): string | undefined => process.env.DB_TEST_MARKER?.trim();

/** Resolve blocked DB names from env at call time. */
const getBlockedDbNames = (): Set<string> =>
  new Set(
    (process.env.DB_BLOCKED_NAMES ?? 'pi_financeiro,pi_financeiro_prod')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Resolve blocked hosts from env at call time. */
const getBlockedHosts = (): Set<string> =>
  new Set(
    (process.env.DB_BLOCKED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Validates that this database is safe for destructive operations.
 *
 * Rule 1 (primary): DB must contain a `_test_marker` table with
 * a matching `marker_value` UUID. Set via DB_TEST_MARKER env.
 *
 * Rule 2 (defense-in-depth): database name must not be a protected
 * production name nor appear in the blocked list. The protected set is
 * unconditional; `DB_BLOCKED_NAMES` customization is strictly additive.
 *
 * Rule 3 (defense-in-depth): host must not be in the blocked list.
 */
export const validateTestDatabase = async (pool: DbPool): Promise<GuardResult> => {
  const expectedMarker = getExpectedMarker();
  const blockedDbNames = getBlockedDbNames();
  const blockedHosts = getBlockedHosts();

  // Rule 1: server-side marker
  if (expectedMarker) {
    try {
      // Use a fresh connection to avoid transaction contamination
      const client = await pool.connect();
      try {
        // Check if marker table exists
        const tableCheck = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = '_test_marker'
          ) AS exists`,
        );
        if (!tableCheck.rows[0]?.exists) {
          return { allowed: false, reason: 'Test marker table _test_marker not found. Refusing destructive operation.' };
        }
        // Check marker value
        const markerCheck = await client.query<{ marker_value: string }>(
          `SELECT marker_value FROM _test_marker LIMIT 1`,
        );
        if (markerCheck.rowCount === 0 || markerCheck.rows[0]!.marker_value !== expectedMarker) {
          return { allowed: false, reason: 'Test marker value mismatch. Refusing destructive operation.' };
        }
      } finally {
        client.release();
      }
    } catch (err) {
      return { allowed: false, reason: `Test marker check failed: ${(err as Error).message}` };
    }
  } else {
    // No marker configured → only allow if explicitly opted in via DATABASE_URL_TEST
    if (!process.env.DATABASE_URL_TEST) {
      return { allowed: false, reason: 'DB_TEST_MARKER or DATABASE_URL_TEST not set. Refusing destructive operation.' };
    }
  }

  // Rule 2: check database name
  try {
    const client = await pool.connect();
    try {
      const dbCheck = await client.query<{ current_database: string }>(
        `SELECT current_database()`,
      );
      const dbName = dbCheck.rows[0]?.current_database;
      if (dbName) {
        if (PROTECTED_DB_NAMES.has(dbName)) {
          return { allowed: false, reason: `Database name '${dbName}' is a protected production database. Refusing destructive operation.` };
        }
        if (blockedDbNames.has(dbName)) {
          return { allowed: false, reason: `Database name '${dbName}' is in the blocked list. Refusing destructive operation.` };
        }
      }
    } finally {
      client.release();
    }
  } catch {
    // If we can't check, fail safe
    return { allowed: false, reason: 'Could not verify database name. Refusing destructive operation.' };
  }

  // Rule 3: check host
  const host = (pool as unknown as { options?: { host?: string } }).options?.host;
  if (host && blockedHosts.has(host)) {
    return { allowed: false, reason: `Host '${host}' is in the blocked list. Refusing destructive operation.` };
  }

  return { allowed: true };
};

/**
 * Quick check: is destructive operation safe?
 * Throws if not allowed. Use before migrations, truncation, or seeding.
 */
export const requireTestDatabase = async (pool: DbPool, operation: string): Promise<void> => {
  const result = await validateTestDatabase(pool);
  if (!result.allowed) {
    throw new Error(`[${operation}] ${result.reason}`);
  }
};
