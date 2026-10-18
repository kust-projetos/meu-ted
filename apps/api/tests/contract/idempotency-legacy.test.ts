import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresIdempotencyStore } from '../../src/writes/postgres.js';

describe('G2 — legacy idempotency audit boundary', () => {
  it('writes the operation record and legacy audit row in one transaction', async () => {
    const sql: string[] = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        sql.push(text);
        if (text.includes('SELECT id FROM users')) {
          // No user found for device-1 -> should result in NULL user_id, not error
          return { rowCount: 0, rows: [] };
        }
        if (text.includes('INSERT INTO operation_records')) {
          // Canonical operation_records carries actor_type/actor_id per V016+T09; household_id/request_payload were never columns here.
          const offender = text.includes('household_id') ? 'household_id' : text.includes('request_payload') ? 'request_payload' : null;
          if (offender) {
            throw new Error(`column "${offender}" of relation "operation_records" does not exist`);
          }
          if (text.includes('ON CONFLICT (workspace_id, idempotency_key) DO NOTHING')) {
            return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001', status: 'processing', response: null, effect_ref: null }] };
          }
          return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001' }] };
        }
        if (text.includes('INSERT INTO audit_logs') && text.includes('operation_record_id')) {
          throw new Error('column "operation_record_id" of relation "audit_logs" does not exist');
        }
        if (text.includes('SELECT status, response, payload_hash')) return { rowCount: 0, rows: [] };
        if (text.includes('UPDATE operation_records')) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;

    const result = await createPostgresIdempotencyStore({ pool, legacy: true }).lookupOrRecord(
      { workspaceId: '00000000-0000-4000-8000-0000000000a1', actorType: 'device', actorId: 'device-1', operation: 'accounts.create', key: 'k1' },
      { name: 'Conta' },
      async () => ({ accountId: '00000000-0000-4000-8000-000000000002' }),
    );

    expect(result.replayed).toBe(false);
    const operationInsert = sql.find((statement) => statement.includes('INSERT INTO operation_records'));
    expect(operationInsert).toContain('workspace_id');
    expect(operationInsert).toContain('actor_id');
    expect(operationInsert).toContain('actor_type');
    expect(operationInsert).toContain('payload_hash');
    expect(operationInsert).toContain('status');
    expect(operationInsert).toContain('lease_until');
    expect(operationInsert).toContain('retry_until');
    expect(operationInsert).toContain('retention_until');
    expect(operationInsert).toContain('ON CONFLICT (workspace_id, idempotency_key) DO NOTHING');
    expect(operationInsert).not.toContain('household_id');
    expect(operationInsert).not.toContain('request_payload');
    const auditInsert = sql.find((statement) => statement.includes('INSERT INTO audit_logs'));
    expect(auditInsert).toContain('household_id');
    expect(auditInsert).toContain('user_id');
    expect(auditInsert).toContain('action');
    expect(auditInsert).toContain('entity_type');
    expect(auditInsert).toContain('entity_id');
    expect(auditInsert).toContain('before_json');
    expect(auditInsert).toContain('after_json');
    expect(auditInsert).not.toContain('operation_record_id');
    expect(auditInsert).not.toContain('workspace_id');
  });

  it('resolves actorId that is users.id directly (FK ok)', async () => {
    const captured: Array<{ text: string; values?: unknown[] }> = [];
    const expectedUserId = 'adbb7007-7b8d-4cf3-8c86-e1057c43f4ff';
    const client = {
      async query(text: string, values?: unknown[]) {
        captured.push({ text, values });
        if (text.includes('SELECT id FROM users')) {
          // Simulate that actorId matches users.id directly
          if (values?.[0] === expectedUserId) return { rowCount: 1, rows: [{ id: expectedUserId }] };
          return { rowCount: 0, rows: [] };
        }
        if (text.includes('INSERT INTO operation_records')) {
          return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001', status: 'processing', response: null, effect_ref: null }] };
        }
        if (text.includes('UPDATE operation_records')) return { rowCount: 1, rows: [] };
        if (text.includes('INSERT INTO audit_logs')) {
          // Verify that the audit insert uses the resolved users.id, not the raw actorId
          const userIdParam = values?.[2];
          if (userIdParam !== expectedUserId) throw new Error(`audit_logs.user_id should be ${expectedUserId} but was ${String(userIdParam)}`);
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const result = await createPostgresIdempotencyStore({ pool, legacy: true }).lookupOrRecord(
      { workspaceId: '00000000-0000-4000-8000-0000000000a1', actorType: 'user', actorId: expectedUserId, operation: 'invites.create', key: 'k2' },
      { email: 'a@example.com' },
      async () => ({ inviteId: 'inv-1' }),
    );
    expect(result.replayed).toBe(false);
  });

  it('resolves actorId that is Better-Auth auth_user_id to users.id', async () => {
    const authUserId = 'WUCGTzoQ7LRRe8eftJjFyKowx96Ryrbs';
    const resolvedUserId = 'adbb7007-7b8d-4cf3-8c86-e1057c43f4ff';
    const captured: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        captured.push({ text, values });
        if (text.includes('SELECT id FROM users')) {
          if (values?.[0] === authUserId) return { rowCount: 1, rows: [{ id: resolvedUserId }] };
          return { rowCount: 0, rows: [] };
        }
        if (text.includes('INSERT INTO operation_records')) {
          return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001', status: 'processing', response: null, effect_ref: null }] };
        }
        if (text.includes('UPDATE operation_records')) return { rowCount: 1, rows: [] };
        if (text.includes('INSERT INTO audit_logs')) {
          const userIdParam = values?.[2];
          if (userIdParam !== resolvedUserId) throw new Error(`expected resolved user_id ${resolvedUserId} but got ${String(userIdParam)}`);
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const result = await createPostgresIdempotencyStore({ pool, legacy: true }).lookupOrRecord(
      { workspaceId: '00000000-0000-4000-8000-0000000000a1', actorType: 'user', actorId: authUserId, operation: 'invites.create', key: 'k3' },
      { email: 'b@example.com' },
      async () => ({ inviteId: 'inv-2' }),
    );
    expect(result.replayed).toBe(false);
  });

  it('falls back to NULL user_id when actorId cannot be resolved (no FK violation)', async () => {
    const unknownActor = 'WUCGTzoQ7LRRe8eftJjFyKowx96Ryrbs_unknown';
    const client = {
      async query(text: string, values?: unknown[]) {
        if (text.includes('SELECT id FROM users')) {
          return { rowCount: 0, rows: [] };
        }
        if (text.includes('INSERT INTO operation_records')) {
          return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001', status: 'processing', response: null, effect_ref: null }] };
        }
        if (text.includes('UPDATE operation_records')) return { rowCount: 1, rows: [] };
        if (text.includes('INSERT INTO audit_logs')) {
          const userIdParam = values?.[2];
          if (userIdParam !== null) throw new Error(`expected NULL user_id for unresolved actor, got ${String(userIdParam)}`);
          // Simulate that inserting NULL does not violate FK
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const result = await createPostgresIdempotencyStore({ pool, legacy: true }).lookupOrRecord(
      { workspaceId: '00000000-0000-4000-8000-0000000000a1', actorType: 'user', actorId: unknownActor, operation: 'workspaces.create', key: 'k4' },
      { name: 'Ws' },
      async () => ({ id: 'ws-1' }),
    );
    expect(result.replayed).toBe(false);
  });
});

describe('G2b — synthetic scope household FK safety', () => {
  it('writes audit_logs.household_id = NULL when the scope is a synthetic id (no households row) — regression 23503', async () => {
    const captured: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        captured.push({ text, values });
        if (text.includes('SELECT id FROM households')) return { rowCount: 0, rows: [] };
        if (text.includes('SELECT id FROM users')) return { rowCount: 0, rows: [] };
        if (text.includes('INSERT INTO operation_records')) {
          return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001', status: 'processing', response: null, effect_ref: null }] };
        }
        if (text.includes('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
        if (text.includes('UPDATE operation_records')) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;

    const synthetic = '11111111-2222-4333-8444-555555555555';
    await createPostgresIdempotencyStore({ pool, legacy: true }).lookupOrRecord(
      { workspaceId: synthetic, actorType: 'user', actorId: 'user-1', operation: 'workspace.create', key: 'k-synthetic' },
      { name: 'Teste' },
      async () => ({ id: 'ws-1' }),
    );

    const audit = captured.find((c) => c.text.includes('INSERT INTO audit_logs'))!;
    // $2 = household_id param -> must be null for a synthetic scope (FK-safe)
    expect(audit.values?.[1]).toBeNull();
    const householdSelect = captured.find((c) => c.text.includes('SELECT id FROM households'));
    expect(householdSelect?.values?.[0]).toBe(synthetic);
  });

  it('writes audit_logs.household_id = real household when the scope exists', async () => {
    const captured: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        captured.push({ text, values });
        if (text.includes('SELECT id FROM households')) return { rowCount: 1, rows: [{ id: '550e8400-e29b-41d4-a716-446655440000' }] };
        if (text.includes('SELECT id FROM users')) return { rowCount: 0, rows: [] };
        if (text.includes('INSERT INTO operation_records')) {
          return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001', status: 'processing', response: null, effect_ref: null }] };
        }
        if (text.includes('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
        if (text.includes('UPDATE operation_records')) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;

    await createPostgresIdempotencyStore({ pool, legacy: true }).lookupOrRecord(
      { workspaceId: '550e8400-e29b-41d4-a716-446655440000', actorType: 'user', actorId: 'user-1', operation: 'transactions.expense.create', key: 'k-real' },
      { amountCents: 100 },
      async () => ({ transactionId: 'tx-1' }),
    );

    const audit = captured.find((c) => c.text.includes('INSERT INTO audit_logs'))!;
    expect(audit.values?.[1]).toBe('550e8400-e29b-41d4-a716-446655440000');
  });
});
