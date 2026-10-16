import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresWorkspaceStore } from '../../src/auth/workspaces-postgres.js';
import {
  createInMemoryWorkspaceStore,
  WorkspaceError,
} from '../../src/auth/workspaces-store.js';
import {
  DELETION_CONFIRM_ACTION,
  DELETION_INVENTORY_TTL_MS,
  buildDeleteConfirmation,
  isArchivedMutationAllowed,
  verifyDeleteConfirmation,
} from '../../src/auth/workspace-deletion.js';
import { expectedMigrationManifest } from '../../src/read-models/sql/migrate.js';

const V062_PATH = new URL('../../src/read-models/sql/V062__workspace_delete_tombstone.sql', import.meta.url);

type Handler = (text: string, values?: unknown[]) => unknown;

const mockPool = (handlers: Record<string, Handler>, seen: string[] = []) => {
  const route = async (text: string, values?: unknown[]) => {
    seen.push(text);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (text.includes(needle)) return handler(text, values) as never;
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: route, release: () => undefined };
  return {
    query: route,
    connect: async () => client,
  } as unknown as Pool;
};

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const WS_ID = '11111111-1111-4111-8111-111111111111';

const membershipOwner = () => ({
  rows: [{ id: OWNER_ID, user_id: OWNER_ID, role: 'owner' }],
  rowCount: 1,
});

/** All-zero inventory row (empty workspace), memberships = owner only. */
const zeroInventoryRow = () => ({
  accounts: '0',
  categories: '0',
  transactions: '0',
  statements: '0',
  recurring_purchases: '0',
  accounts_payable: '0',
  payable_templates: '0',
  notification_configs: '0',
  budgets: '0',
  goals: '0',
  goal_contributions: '0',
  subscriptions: '0',
  profiles: '0',
  card_purchases: '0',
  push_subscriptions: '0',
  pending_operations_v1: '0',
  pending_operations_v2: '0',
  operation_records_processing: '0',
  confirmation_intentions: '0',
  invites: '0',
  ownership_transfers: '0',
  memberships_active: '1',
});

// The inventory probe is the only SELECT touching pending_operations; route it by table name.
const withInventoryProbe = (
  handlers: Record<string, Handler>,
  seen: string[] = [],
  row: Record<string, string> = zeroInventoryRow(),
) =>
  mockPool(
    {
      'FROM users': () => membershipOwner(),
      'FROM households': () => ({
        rows: [{ id: WS_ID, name: 'Vazio', kind: 'shared', status: 'active' }],
        rowCount: 1,
      }),
      'FROM pending_operations': () => ({ rows: [row], rowCount: 1 }),
      ...handlers,
    },
    seen,
  );

/**
 * D2 (ADR-027): archive autoritativo + delete só-vazio + purge bloqueado.
 * RED-first: estes testes falham antes da Fatia 2 existir.
 */
describe('D2 — delete só-vazio (ADR-027)', () => {
  it('inventário de workspace vazio retorna empty:true com versão e expiração', async () => {
    const pool = withInventoryProbe({});
    const store = createPostgresWorkspaceStore(pool);
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    expect(inventory.workspaceId).toBe(WS_ID);
    expect(inventory.empty).toBe(true);
    expect(inventory.inventoryVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(inventory.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(inventory.purgeBlocked).toBe(true);
  });

  it('vazio deleta: tombstone + status deleted, com barreira FOR UPDATE', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe(
      {
        // tombstone insert
        'INTO workspace_tombstones': () => ({ rows: [], rowCount: 1 }),
        // closure log insert
        'INTO workspace_closure_log': () => ({ rows: [], rowCount: 1 }),
        // status flip
        "SET status = 'deleted'": () => ({ rows: [], rowCount: 1 }),
      },
      seen,
    );
    const store = createPostgresWorkspaceStore(pool);
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
    });
    const receipt = await store.deleteEmpty({
      authUserId: 'auth-user-1',
      householdId: WS_ID,
      confirmation,
    });
    expect(receipt.id).toBe(WS_ID);
    expect(receipt.inventoryVersion).toBe(inventory.inventoryVersion);
    // Barreira de concorrência: a linha é travada antes do inventário final.
    expect(seen.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    // Tombstone anti-reuso gravado; status vira deleted (linha preservada).
    expect(seen.some((sql) => sql.includes('workspace_tombstones'))).toBe(true);
    expect(seen.some((sql) => sql.includes('workspace_closure_log'))).toBe(true);
    expect(seen.some((sql) => sql.includes("'deleted'"))).toBe(true);
  });

  it('com-dados recusa com 409 workspace.not_empty e não toca nos dados', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen, { ...zeroInventoryRow(), accounts: '2' });
    const store = createPostgresWorkspaceStore(pool);
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    expect(inventory.empty).toBe(false);
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
    });
    await expect(
      store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation }),
    ).rejects.toMatchObject({ code: 'workspace.not_empty', statusCode: 409 });
    // Nenhum UPDATE/DELETE/INSERT de dados: só leitura do inventário.
    expect(seen.some((sql) => /UPDATE households|DELETE FROM|INTO workspace_tombstones/.test(sql))).toBe(false);
  });

  it('purge com-dados PERMANECE BLOQUEADO (409 dedicado, nunca executa)', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen);
    const store = createPostgresWorkspaceStore(pool);
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
    });
    await expect(
      store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation, purge: true }),
    ).rejects.toMatchObject({ code: 'workspace.purge_blocked', statusCode: 409 });
    expect(seen.some((sql) => /UPDATE households|DELETE FROM|INTO workspace_tombstones/.test(sql))).toBe(false);
  });

  it('confirmação expirada ou divergente é recusada sem tocar nos dados', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen);
    const store = createPostgresWorkspaceStore(pool);
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    // Expirada.
    await expect(
      store.deleteEmpty({
        authUserId: 'auth-user-1',
        householdId: WS_ID,
        confirmation: {
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          action: DELETION_CONFIRM_ACTION,
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ code: 'workspace.confirmation_invalid' });
    // Versão divergente (dados mudaram entre inventário e delete).
    await expect(
      store.deleteEmpty({
        authUserId: 'auth-user-1',
        householdId: WS_ID,
        confirmation: buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          inventoryVersion: '0'.repeat(64),
          expiresAt: inventory.expiresAt,
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.confirmation_invalid' });
    // Ator divergente.
    await expect(
      store.deleteEmpty({
        authUserId: 'auth-user-1',
        householdId: WS_ID,
        confirmation: buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-outro',
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: inventory.expiresAt,
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.confirmation_invalid' });
    expect(seen.some((sql) => /UPDATE households|DELETE FROM|INTO workspace_tombstones/.test(sql))).toBe(false);
  });

  it('tombstone bloqueia reuso: segundo delete e re-create no mesmo id recusam', async () => {
    const pool = mockPool({
      'FROM users': () => membershipOwner(),
      // A linha já está deleted (primeiro delete concluiu).
      'FROM households': () => ({
        rows: [{ id: WS_ID, name: 'Vazio', kind: 'shared', status: 'deleted' }],
        rowCount: 1,
      }),
    });
    const store = createPostgresWorkspaceStore(pool);
    await expect(
      store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
    await expect(
      store.deleteEmpty({
        authUserId: 'auth-user-1',
        householdId: WS_ID,
        confirmation: buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          inventoryVersion: 'f'.repeat(64),
          expiresAt: new Date(Date.now() + DELETION_INVENTORY_TTL_MS).toISOString(),
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
    // Restore de tombstone também é recusado: delete é permanente.
    await expect(
      store.setStatus({ authUserId: 'auth-user-1', householdId: WS_ID, status: 'active' }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
  });

  it('in-memory store espelha delete-vazio + tombstone (paridade de contrato)', async () => {
    const store = createInMemoryWorkspaceStore();
    const created = await store.create({ authUserId: 'u1', name: 'Vazio', kind: 'shared' });
    const inventory = await store.deletionInventory({ authUserId: 'u1', householdId: created.id });
    expect(inventory.empty).toBe(true);
    // Purge recusado num workspace vivo, antes de qualquer efeito.
    await expect(
      store.deleteEmpty({
        authUserId: 'u1',
        householdId: created.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: created.id,
          actor: 'u1',
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: inventory.expiresAt,
        }),
        purge: true,
      }),
    ).rejects.toMatchObject({ code: 'workspace.purge_blocked' });
    const receipt = await store.deleteEmpty({
      authUserId: 'u1',
      householdId: created.id,
      confirmation: buildDeleteConfirmation({
        workspaceId: created.id,
        actor: 'u1',
        inventoryVersion: inventory.inventoryVersion,
        expiresAt: inventory.expiresAt,
      }),
    });
    expect(receipt.id).toBe(created.id);
    expect(await store.list('u1')).toEqual([]);
    await expect(
      store.deleteEmpty({
        authUserId: 'u1',
        householdId: created.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: created.id,
          actor: 'u1',
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: inventory.expiresAt,
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
  });

  it('verifyDeleteConfirmation é pura e fail-closed (ação vinculada, TTL limitado)', () => {
    const version = createHash('sha256').update('inv').digest('hex');
    const valid = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: version,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(() =>
      verifyDeleteConfirmation(valid, { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: version }),
    ).not.toThrow();
    // Ação errada.
    expect(() =>
      verifyDeleteConfirmation({ ...valid, action: 'workspace.purge' as never }, { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: version }),
    ).toThrow(expect.objectContaining({ code: 'workspace.confirmation_invalid' }));
    // Expiração além do TTL máximo (relógio do cliente não estende a janela).
    expect(() =>
      verifyDeleteConfirmation(
        { ...valid, expiresAt: new Date(Date.now() + DELETION_INVENTORY_TTL_MS * 10).toISOString() },
        { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: version },
      ),
    ).toThrow(expect.objectContaining({ code: 'workspace.confirmation_invalid' }));
    expect(DELETION_CONFIRM_ACTION).toBe('workspace.delete');
  });

  it('freeze de archived: plano financeiro bloqueia mutação, gestão permite restore/delete', () => {
    // O gate só é consultado quando o status já é archived (caller-side);
    // workspaces ativos nunca passam por ele.
    // Leituras sempre passam.
    expect(isArchivedMutationAllowed('GET', '/transactions')).toBe(true);
    // Plano financeiro congela.
    expect(isArchivedMutationAllowed('POST', '/transactions')).toBe(false);
    expect(isArchivedMutationAllowed('PATCH', '/accounts/123')).toBe(false);
    expect(isArchivedMutationAllowed('DELETE', '/transactions/123')).toBe(false);
    // Gestão do lifecycle continua operável sobre archived.
    expect(isArchivedMutationAllowed('POST', `/workspaces/${WS_ID}/restore`)).toBe(true);
    expect(isArchivedMutationAllowed('POST', `/workspaces/${WS_ID}/archive`)).toBe(true);
    expect(isArchivedMutationAllowed('DELETE', `/workspaces/${WS_ID}`)).toBe(true);
    expect(isArchivedMutationAllowed('GET', `/workspaces/${WS_ID}/deletion-inventory`)).toBe(true);
    // Saída e revogação (redução de acesso) continuam possíveis.
    expect(isArchivedMutationAllowed('POST', `/workspaces/${WS_ID}/leave`)).toBe(true);
    expect(isArchivedMutationAllowed('DELETE', `/workspaces/${WS_ID}/members/alguem`)).toBe(true);
    // Renomear/transferir/convidar congelam junto com o financeiro.
    expect(isArchivedMutationAllowed('PATCH', `/workspaces/${WS_ID}`)).toBe(false);
    expect(isArchivedMutationAllowed('POST', `/workspaces/${WS_ID}/ownership-transfers`)).toBe(false);
    expect(isArchivedMutationAllowed('POST', `/workspaces/${WS_ID}/invites/x/resend`)).toBe(false);
  });

  it('V062 cria log de fechamento + tombstone sem tocar em dados (aditiva)', () => {
    const sql = readFileSync(V062_PATH, 'utf8');
    expect(sql).toMatch(/workspace_closure_log/i);
    expect(sql).toMatch(/workspace_tombstone/i);
    expect(sql).toMatch(/'deleted'/);
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM/i);
    expect(expectedMigrationManifest().map(({ version }) => version)).toContain(62);
  });

  it('concorrência: segundo delete após tombstone recusa sem reescrever (410 Gone)', async () => {
    const pool = mockPool({
      'FROM users': () => membershipOwner(),
      'FROM households': () => ({
        rows: [{ id: WS_ID, name: 'Vazio', kind: 'shared', status: 'deleted' }],
        rowCount: 1,
      }),
    });
    const store = createPostgresWorkspaceStore(pool);
    const error = await store
      .deleteEmpty({
        authUserId: 'auth-user-1',
        householdId: WS_ID,
        confirmation: buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          inventoryVersion: randomUUID().replace(/-/g, ''),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      })
      .catch((cause) => cause as WorkspaceError);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.code).toBe('workspace.deleted');
    expect(error.statusCode).toBe(410);
  });

  it('device path: archived e deleted recusam via access.status; legado fail-open', async () => {
    const { resolveAuthorizedDevice } = await import('../../src/auth/device-access.js');
    const device = { deviceId: 'dev-1', userId: 'auth-user-1', householdId: WS_ID };
    const tokenStore = { resolve: async () => device };
    const accessFor = (status?: 'active' | 'archived' | 'deleted') => ({
      resolve: async () => ({
        userId: OWNER_ID,
        householdId: WS_ID,
        role: 'owner' as const,
        kind: 'shared' as const,
        ...(status ? { status } : {}),
      }),
    });
    const archivedStore = {
      list: async () => [{ id: WS_ID, name: 'A', kind: 'shared' as const, role: 'owner' as const, status: 'archived' as const }],
    };
    // Status autoritativo presente: archived e deleted recusam com 403.
    await expect(
      resolveAuthorizedDevice({ tokenStore, workspaceAccess: accessFor('archived'), workspaceStore: archivedStore }, 'tok', WS_ID),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      resolveAuthorizedDevice({ tokenStore, workspaceAccess: accessFor('deleted'), workspaceStore: { list: async () => [] } }, 'tok', WS_ID),
    ).rejects.toMatchObject({ statusCode: 403 });
    // Legado (status ausente): archived na lista ainda recusa (pré-D2).
    await expect(
      resolveAuthorizedDevice({ tokenStore, workspaceAccess: accessFor(), workspaceStore: archivedStore }, 'tok', WS_ID),
    ).rejects.toMatchObject({ statusCode: 403 });
    // Ativo continua autorizando.
    const activeStore = {
      list: async () => [{ id: WS_ID, name: 'A', kind: 'shared' as const, role: 'owner' as const, status: 'active' as const }],
    };
    const authorized = await resolveAuthorizedDevice(
      { tokenStore, workspaceAccess: accessFor('active'), workspaceStore: activeStore },
      'tok',
      WS_ID,
    );
    expect(authorized.workspaceId).toBe(WS_ID);
  });

  it('workspaceAccess.resolve retorna o status do households (oráculo do freeze)', async () => {
    const { createPostgresWorkspaceAccessStore } = await import('../../src/auth/workspace-access.js');
    let seenSql = '';
    const pool = {
      query: async (text: string) => {
        seenSql = text;
        return { rows: [{ user_id: OWNER_ID, household_id: WS_ID, role: 'owner', kind: 'shared', status: 'archived' }] };
      },
    } as never;
    const access = await createPostgresWorkspaceAccessStore(pool).resolve('auth-user-1', WS_ID);
    expect(seenSql).toMatch(/h\.status/);
    expect(access?.status).toBe('archived');
  });
});
