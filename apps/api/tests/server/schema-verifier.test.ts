import { describe, expect, it } from 'vitest';
import { verifySchema } from '../../src/server/schema-verifier.js';
import { expectedMigrationManifest } from '../../src/read-models/sql/migrate.js';

const completeRows = [
  ['_migrations', 'version'],
  ['accounts', 'id'], ['accounts', 'household_id'],
  ['categories', 'id'], ['categories', 'household_id'],
  ['transactions', 'id'], ['transactions', 'household_id'],
  ['device_tokens', 'token'], ['device_tokens', 'household_id'],
  ['operation_records', 'id'], ['operation_records', 'workspace_id'], ['operation_records', 'actor_type'], ['operation_records', 'actor_id'], ['operation_records', 'status'],
  ['operation_records', 'lease_until'], ['operation_records', 'retry_until'], ['operation_records', 'retention_until'],
  ['audit_logs', 'operation_record_id'], ['audit_logs', 'workspace_id'], ['audit_logs', 'actor_type'], ['audit_logs', 'actor_id'], ['audit_logs', 'event_type'],
  ['accounts', 'institution_id'], ['accounts', 'card_product_id'],
  ['accounts', 'initial_balance_cents'],
].map(([table_name, column_name]) => ({ table_name, column_name }));

const legacyRows = [
  ['_migrations', 'version'],
  ['accounts', 'id'], ['accounts', 'household_id'],
  ['accounts', 'institution_id'], ['accounts', 'card_product_id'],
  ['categories', 'id'], ['categories', 'household_id'],
  ['transactions', 'id'], ['transactions', 'household_id'],
  ['device_tokens', 'token'], ['device_tokens', 'household_id'],
  ['operation_records', 'id'], ['operation_records', 'workspace_id'], ['operation_records', 'actor_type'], ['operation_records', 'actor_id'], ['operation_records', 'status'],
  ['operation_records', 'lease_until'], ['operation_records', 'retry_until'], ['operation_records', 'retention_until'],
  ['audit_logs', 'id'], ['audit_logs', 'household_id'], ['audit_logs', 'user_id'], ['audit_logs', 'action'], ['audit_logs', 'entity_type'], ['audit_logs', 'entity_id'], ['audit_logs', 'before_json'], ['audit_logs', 'after_json'],
].map(([table_name, column_name]) => ({ table_name, column_name }));

const fakePool = (rows: unknown[], migrationRows = expectedMigrationManifest(false), reject = false) => ({
  query: async (sql: string) => {
    if (reject) throw new Error('database unavailable');
    if (sql.includes('FROM _migrations')) return { rows: migrationRows };
    return { rows };
  },
}) as never;

describe('G0.4.5 — read-only schema verification', () => {
  it('accepts the required schema fingerprint', async () => {
    await expect(verifySchema(fakePool(completeRows))).resolves.toBe(true);
  });

  it('rejects a schema missing a required column', async () => {
    await expect(verifySchema(fakePool(completeRows.slice(0, -1)))).resolves.toBe(false);
  });

  it('accepts the documented legacy schema fingerprint', async () => {
    await expect(verifySchema(fakePool(legacyRows, expectedMigrationManifest(true)), true)).resolves.toBe(true);
  });

  it('fails closed when the legacy ledger is missing V064', async () => {
    const legacyManifest = expectedMigrationManifest(true);
    expect(legacyManifest.map(({ version }) => version)).not.toContain(55);
    expect(legacyManifest.map(({ version }) => version)).toContain(64);
    const vpsLedger = legacyManifest.filter(({ version }) => version <= 54);
    await expect(verifySchema(fakePool(legacyRows, vpsLedger), true)).resolves.toBe(false);
  });

  it('fails closed when schema query errors', async () => {
    await expect(verifySchema(fakePool([], [], true))).resolves.toBe(false);
  });

  it('rejects a schema whose migration ledger is stale', async () => {
    const stale = expectedMigrationManifest(false).slice(0, -1);
    await expect(verifySchema(fakePool(completeRows, stale))).resolves.toBe(false);
  });
});
