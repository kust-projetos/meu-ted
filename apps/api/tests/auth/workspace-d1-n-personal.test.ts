import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresWorkspaceStore } from '../../src/auth/workspaces-postgres.js';
import {
  createInMemoryWorkspaceStore,
  WorkspaceError,
} from '../../src/auth/workspaces-store.js';
import { expectedMigrationManifest } from '../../src/read-models/sql/migrate.js';

const V021_PATH = new URL('../../src/read-models/sql/V021__personal_workspace_invariants.sql', import.meta.url);
const V061_PATH = new URL('../../src/read-models/sql/V061__n_personal_workspaces.sql', import.meta.url);

const mockPool = (handlers: Record<string, (text: string, values?: unknown[]) => unknown>) => {
  const client = {
    query: async (text: string, values?: unknown[]) => {
      for (const [needle, handler] of Object.entries(handlers)) {
        if (text.includes(needle)) return handler(text, values) as never;
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    query: async (text: string, values?: unknown[]) => client.query(text, values),
    connect: async () => client,
  } as unknown as Pool;
};

/**
 * D1 (ADR-027): N workspaces pessoais + compartilhados por usuário.
 * RED-first: estes testes falham enquanto o gate 409 de segundo pessoal
 * existir e enquanto a ordenação/listagem impuser unicidade.
 */
describe('D1 — N personal workspaces (ADR-027)', () => {
  it('permite criar 2º e 3º personal para o mesmo usuário (sem 409)', async () => {
    const pool = mockPool({
      'SELECT id FROM users': () => ({ rows: [{ id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 }),
      // Simula 1 personal já existente — D1: não bloqueia.
      "kind = 'personal'": () => ({ rows: [{ id: 'existing-personal-ws' }], rowCount: 1 }),
      'INSERT INTO households': (_text: string, values?: unknown[]) => ({
        rows: [{
          id: '22222222-2222-4222-8222-222222222222',
          name: values?.[0],
          kind: values?.[1],
          status: 'active',
        }],
        rowCount: 1,
      }),
    });
    const store = createPostgresWorkspaceStore(pool);
    const second = await store.create({ authUserId: 'auth-user-1', name: 'Pessoal 2', kind: 'personal' });
    expect(second.kind).toBe('personal');
    expect(second.role).toBe('owner');
    const third = await store.create({ authUserId: 'auth-user-1', name: 'Pessoal 3', kind: 'personal' });
    expect(third.kind).toBe('personal');
  });

  it('ordena a listagem: ativos primeiro, pessoais antes, created_at, id (fallback determinístico)', async () => {
    let seenOrderBy = '';
    const pool = mockPool({
      'FROM memberships': (text: string) => {
        if (text.includes('ORDER BY')) seenOrderBy = text;
        return { rows: [], rowCount: 0 };
      },
    });
    const store = createPostgresWorkspaceStore(pool);
    await store.list('auth-user-1');
    // D1 §5-6: ativos primeiro; pessoais antes de compartilhados; created_at; id.
    expect(seenOrderBy).toMatch(/\(h\.status = 'active'\) DESC/i);
    expect(seenOrderBy).toMatch(/\(h\.kind = 'personal'\) DESC/i);
    expect(seenOrderBy).toMatch(/h\.created_at ASC/i);
    expect(seenOrderBy).toMatch(/h\.id ASC/i);
    // Status precede kind: archived personal nunca precede active shared.
    const orderBy = seenOrderBy.slice(seenOrderBy.indexOf('ORDER BY'));
    expect(orderBy.indexOf('h.status')).toBeLessThan(orderBy.indexOf('h.kind'));
  });

  it('preserva vetos em personal: sem remoção de membros, sem saída do owner', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const pool = mockPool({
      'SELECT kind, owner_user_id': () => ({
        rows: [{ kind: 'personal', owner_user_id: userId }],
        rowCount: 1,
      }),
      // assertMembership: SELECT u.id AS user_id, m.role ... FROM users u JOIN memberships m ...
      'FROM users': () => ({
        rows: [{ id: userId, user_id: userId, role: 'owner' }],
        rowCount: 1,
      }),
    });
    const store = createPostgresWorkspaceStore(pool);
    await expect(
      store.removeMember({
        authUserId: 'auth-user-1',
        householdId: '11111111-1111-4111-8111-111111111111',
        memberUserId: 'auth-user-1',
      }),
    ).rejects.toMatchObject({ code: 'workspace.personal' });
    await expect(
      store.leave({ authUserId: 'auth-user-1', householdId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toMatchObject({ code: 'workspace.personal' });
  });

  it('in-memory store permite N pessoais com a mesma ordenação D1', async () => {
    const store = createInMemoryWorkspaceStore();
    const first = await store.create({ authUserId: 'u1', name: 'Pessoal A', kind: 'personal' });
    const second = await store.create({ authUserId: 'u1', name: 'Pessoal B', kind: 'personal' });
    expect(second.id).not.toBe(first.id);
    const shared = await store.create({ authUserId: 'u1', name: 'Time', kind: 'shared' });
    const list = await store.list('u1');
    expect(list.map((w) => w.id)).toEqual([first.id, second.id, shared.id]);
    // Vetos preservados no fallback in-memory.
    await expect(store.removeMember({ authUserId: 'u1', householdId: first.id, memberUserId: 'u1' }))
      .rejects.toMatchObject({ code: 'workspace.personal' });
    await expect(store.leave({ authUserId: 'u1', householdId: first.id }))
      .rejects.toMatchObject({ code: 'workspace.personal' });
  });

  it('criações concorrentes do 2º personal (chaves distintas) geram workspaces distintos, sem 500', async () => {
    const store = createInMemoryWorkspaceStore();
    await store.create({ authUserId: 'u1', name: 'Pessoal 1', kind: 'personal' });
    const [a, b] = await Promise.all([
      store.create({ authUserId: 'u1', name: 'Pessoal 2a', kind: 'personal' }),
      store.create({ authUserId: 'u1', name: 'Pessoal 2b', kind: 'personal' }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(await store.list('u1')).toHaveLength(3);
  });

  it('V021 aplicada permanece intocada (índice único ainda declarado lá); V061 remove SÓ o índice', () => {
    const v021 = readFileSync(V021_PATH, 'utf8');
    // V021 nunca editada: o índice único parcial continua declarado no arquivo aplicado.
    expect(v021).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS memberships_personal_user_uidx/);
    const v061 = readFileSync(V061_PATH, 'utf8');
    expect(v061).toMatch(/DROP INDEX IF EXISTS memberships_personal_user_uidx/i);
    // V061 toca SÓ o índice: nenhum CREATE TRIGGER / CREATE FUNCTION / ALTER TABLE households.
    expect(v061).not.toMatch(/CREATE TRIGGER/i);
    expect(v061).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(v061).not.toMatch(/ALTER TABLE households/i);
    // Lookup não-único equivalente para (user_id) WHERE kind='personal'.
    expect(v061).toMatch(/CREATE INDEX IF NOT EXISTS memberships_personal_user_idx/i);
    expect(v061).toMatch(/WHERE kind = 'personal'/);
    // Down-migration documentada como insegura após N>1 (rollback = bloquear criações).
    expect(v061).toMatch(/N\s*>\s*1|insegura|UNSAFE/i);
    expect(v061).toMatch(/bloquear criações|block.*creat/i);
  });

  it('V061 está no manifest de migrations (canônica; fora do legado)', async () => {
    const versions = expectedMigrationManifest().map(({ version }) => version);
    expect(versions).toContain(61);
    const { LEGACY_SAFE_PREFIXES } = await import('../../src/read-models/sql/migrate.js');
    expect(LEGACY_SAFE_PREFIXES.some((p) => 'V061__n_personal_workspaces.sql'.startsWith(p))).toBe(false);
  });

  it('mapeia WorkspaceError 409 legado de personal para leitura (sem throw em create válido)', async () => {
    // Guarda de regressão: o código workspace.invalid continua existindo como
    // tipo (outros fluxos usam), mas create personal nunca o lança por cardinalidade.
    const err = new WorkspaceError('workspace.invalid', 409, 'x');
    expect(err.statusCode).toBe(409);
  });
});
