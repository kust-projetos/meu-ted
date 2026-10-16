import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresWorkspaceStore } from '../../src/auth/workspaces-postgres.js';

describe('Postgres workspace store unit tests', () => {
  it('creates a shared workspace with owner_user_id set to the active user id (V022 invariant)', async () => {
    const executedQueries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        executedQueries.push({ text, values });
        if (text.includes('SELECT id FROM users')) {
          return { rows: [{ id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 };
        }
        if (text.includes('INSERT INTO households')) {
          return {
            rows: [{
              id: '11111111-1111-4111-8111-111111111111',
              name: values?.[0],
              kind: values?.[1],
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = {
      query: async (text: string, values?: unknown[]) => client.query(text, values),
      connect: async () => client,
    } as unknown as Pool;

    const store = createPostgresWorkspaceStore(pool);
    const result = await store.create({
      authUserId: 'auth-user-1',
      name: 'Shared Family',
      kind: 'shared',
    });

    expect(result).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Shared Family',
      kind: 'shared',
      role: 'owner',
      status: 'active',
    });

    const householdInsert = executedQueries.find((q) => q.text.includes('INSERT INTO households'));
    expect(householdInsert).toBeDefined();
    // V022 requires owner_user_id (3rd param) to be the user's UUID, NEVER null!
    expect(householdInsert?.values?.[2]).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('allows creating a second personal workspace (D1 N-personal, ADR-027)', async () => {
    const client = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('SELECT id FROM users')) {
          return { rows: [{ id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 };
        }
        if (text.includes('INSERT INTO households')) {
          return {
            rows: [{
              id: '22222222-2222-4222-8222-222222222222',
              name: values?.[0],
              kind: values?.[1],
              status: 'active',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = {
      query: async (text: string, values?: unknown[]) => client.query(text, values),
      connect: async () => client,
    } as unknown as Pool;

    const store = createPostgresWorkspaceStore(pool);
    // Even with an existing personal workspace, D1 allows another one —
    // the store must not issue a 409 cardinality refusal.
    const result = await store.create({
      authUserId: 'auth-user-1',
      name: 'My Personal 2',
      kind: 'personal',
    });
    expect(result.kind).toBe('personal');
    expect(result.role).toBe('owner');
  });
});
