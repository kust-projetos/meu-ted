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
  hashInventoryCounts,
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

// FIX-WS-D2-R3 item 3: segredo HMAC explícito de teste (nunca default
// embutido no produto; sem ele, emissão/verificação recusam fail-closed).
const TEST_HMAC_SECRET = 'test-only-workspace-deletion-hmac-secret';

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
  // profiles NÃO entra na prova (scaffolding owned removido pela
  // operação — ver INVENTORY_SELECT): manter fora da shape mockada.
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
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    expect(inventory.workspaceId).toBe(WS_ID);
    expect(inventory.empty).toBe(true);
    expect(inventory.inventoryVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(inventory.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(inventory.purgeBlocked).toBe(true);
  });

  it('vazio sem prova server-side BLOQUEIA (fail-closed, sem prova = sem delete)', async () => {
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
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    // Mesmo vazio e com confirmação vinculada válida, `verified-empty`
    // declarado no body é forjado: sem prova HMAC server-side, bloqueia.
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
      agentAttestation: 'verified-empty',
    });
    await expect(
      store.deleteEmpty({
        authUserId: 'auth-user-1',
        householdId: WS_ID,
        confirmation,
      }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified', statusCode: 409 });
    // Barreira de concorrência e vínculo continuam verificados antes do
    // bloqueio: a linha é travada e o inventário final é recomputado sob
    // o lock (FOR UPDATE presente), mas NENHUM efeito ocorre.
    expect(seen.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(seen.some((sql) => /INTO workspace_tombstones|INTO workspace_closure_log|SET status = 'deleted'/.test(sql))).toBe(false);
  });

  it('vazio COM depósito server-side válido conclui (FIX-WS-D2-R5: handle opaco)', async () => {
    const seen: string[] = [];
    const depositId = '22222222-2222-4222-8222-222222222222';
    const pool = withInventoryProbe(
      {
        // Depósito server-side (a prova HMAC nunca cruza o browser).
        'INTO workspace_empty_attestations': () => ({ rows: [{ id: depositId }], rowCount: 1 }),
        // Consumo single-use sob o lock do delete.
        'UPDATE workspace_empty_attestations': () => ({ rows: [{ id: depositId }], rowCount: 1 }),
        'INTO workspace_tombstones': () => ({ rows: [], rowCount: 1 }),
        'INTO workspace_closure_log': () => ({ rows: [], rowCount: 1 }),
        "SET status = 'deleted'": () => ({ rows: [], rowCount: 1 }),
      },
      seen,
    );
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    expect(inventory.empty).toBe(true);
    // Depósito white-box do lado Agent (o Agent real deposita com o
    // mesmo segredo compartilhado): contagens zeradas, vinculada à
    // versão. O browser recebe SÓ o handle opaco.
    const { signAgentEmptyProof } = await import('../../src/auth/workspace-deletion.js');
    const proof = signAgentEmptyProof(
      {
        workspaceId: WS_ID,
        inventoryVersion: inventory.inventoryVersion,
        counts: { sessions: 0, messages: 0, memories: 0, attachments: 0 },
      },
      TEST_HMAC_SECRET,
    );
    const { attestationId } = await store.depositEmptyAttestation({ proof });
    expect(attestationId).toBe(depositId);
    const receipt = await store.deleteEmpty({
      authUserId: 'auth-user-1',
      householdId: WS_ID,
      confirmation: buildDeleteConfirmation({
        workspaceId: WS_ID,
        actor: 'auth-user-1',
        inventoryVersion: inventory.inventoryVersion,
        expiresAt: inventory.expiresAt,
        agentAttestation: 'unverified',
        attestationId,
      }),
    });
    expect(receipt.id).toBe(WS_ID);
    expect(seen.some((sql) => sql.includes('INTO workspace_tombstones'))).toBe(true);
    expect(seen.some((sql) => sql.includes("SET status = 'deleted'"))).toBe(true);
    // Scaffolding owned removido pela operação (achado live 16/10:
    // profile auto-provisionado nunca bloqueia a prova de vazio).
    expect(seen.some((sql) => sql.includes('DELETE FROM profiles'))).toBe(true);
  });

  it('prova adulterada recusa NO DEPÓSITO; handle desconhecido recusa sem efeito', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen);
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    const { signAgentEmptyProof } = await import('../../src/auth/workspace-deletion.js');
    const proof = signAgentEmptyProof(
      {
        workspaceId: WS_ID,
        inventoryVersion: inventory.inventoryVersion,
        counts: { sessions: 0, messages: 0, memories: 0, attachments: 0 },
      },
      TEST_HMAC_SECRET,
    );
    // HMAC forjado nunca vira depósito (fail-closed, sem registrar).
    await expect(
      store.depositEmptyAttestation({ proof: { ...proof, hmac: 'f'.repeat(64) } }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified', statusCode: 409 });
    expect(seen.some((sql) => sql.includes('INTO workspace_empty_attestations'))).toBe(false);
    // Handle desconhecido no delete: recusa sem efeito.
    await expect(
      store.deleteEmpty({
        authUserId: 'auth-user-1',
        householdId: WS_ID,
        confirmation: buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: inventory.expiresAt,
          agentAttestation: 'unverified',
          attestationId: '33333333-3333-4333-8333-333333333333',
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified', statusCode: 409 });
    expect(seen.some((sql) => /INTO workspace_tombstones|INTO workspace_closure_log|SET status = 'deleted'/.test(sql))).toBe(false);
  });

  it('com-dados recusa com 409 workspace.not_empty e não toca nos dados', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen, { ...zeroInventoryRow(), accounts: '2' });
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    expect(inventory.empty).toBe(false);
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
      agentAttestation: 'verified-empty',
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
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
      agentAttestation: 'verified-empty',
    });
    await expect(
      store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation, purge: true }),
    ).rejects.toMatchObject({ code: 'workspace.purge_blocked', statusCode: 409 });
    expect(seen.some((sql) => /UPDATE households|DELETE FROM|INTO workspace_tombstones/.test(sql))).toBe(false);
  });

  it('confirmação expirada ou divergente é recusada sem tocar nos dados', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen);
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
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
          agentAttestation: 'verified-empty',
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
          agentAttestation: 'verified-empty',
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
          agentAttestation: 'verified-empty',
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
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
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
          agentAttestation: 'verified-empty',
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
    // Restore de tombstone também é recusado: delete é permanente.
    await expect(
      store.setStatus({ authUserId: 'auth-user-1', householdId: WS_ID, status: 'active' }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
  });

  it('in-memory store espelha delete-vazio + tombstone (paridade de contrato)', async () => {
    const store = createInMemoryWorkspaceStore(undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
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
          agentAttestation: 'verified-empty',
          expiresAt: inventory.expiresAt,
        }),
        purge: true,
      }),
    ).rejects.toMatchObject({ code: 'workspace.purge_blocked' });
    // Sem prova HMAC server-side, o delete bloqueia — mesmo com
    // `verified-empty` declarado pelo cliente.
    await expect(
      store.deleteEmpty({
        authUserId: 'u1',
        householdId: created.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: created.id,
          actor: 'u1',
          inventoryVersion: inventory.inventoryVersion,
          agentAttestation: 'verified-empty',
          expiresAt: inventory.expiresAt,
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified', statusCode: 409 });
    // Sem efeito: segue listado e ativo.
    expect((await store.list('u1')).map((w) => w.id)).toContain(created.id);
    // Com depósito server-side válido (FIX-WS-D2-R5), conclui com tombstone.
    const { signAgentEmptyProof } = await import('../../src/auth/workspace-deletion.js');
    const proof = signAgentEmptyProof(
      {
        workspaceId: created.id,
        inventoryVersion: inventory.inventoryVersion,
        counts: { sessions: 0, messages: 0, memories: 0, attachments: 0 },
      },
      TEST_HMAC_SECRET,
    );
    const { attestationId } = await store.depositEmptyAttestation({ proof });
    const receipt = await store.deleteEmpty({
      authUserId: 'u1',
      householdId: created.id,
      confirmation: buildDeleteConfirmation({
        workspaceId: created.id,
        actor: 'u1',
        inventoryVersion: inventory.inventoryVersion,
        agentAttestation: 'unverified',
        expiresAt: inventory.expiresAt,
        attestationId,
      }),
    });
    expect(receipt.id).toBe(created.id);
    expect((await store.list('u1')).map((w) => w.id)).not.toContain(created.id);
    // Tombstone é terminal para delete posterior.
    await expect(
      store.deleteEmpty({
        authUserId: 'u1',
        householdId: created.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: created.id,
          actor: 'u1',
          inventoryVersion: inventory.inventoryVersion,
          agentAttestation: 'unverified',
          expiresAt: inventory.expiresAt,
          attestationId,
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
  });

  it('verifyDeleteConfirmation é pura e fail-closed (vínculo + barreira + TTL limitado)', () => {
    const version = createHash('sha256').update('inv').digest('hex');
    const forged = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: version,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      agentAttestation: 'verified-empty',
    });
    // FIX-WS-D2-R3 item 1: sem emissor server-side, NENHUM valor de
    // atestação conclui — a barreira precede até a validação temporal
    // (as checagens de TTL/expiração seguem no código como defesa em
    // profundidade para quando o emissor existir).
    expect(() =>
      verifyDeleteConfirmation(forged, { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: version }),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
    // Ação errada (vínculo, antes da barreira).
    expect(() =>
      verifyDeleteConfirmation({ ...forged, action: 'workspace.purge' as never }, { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: version }),
    ).toThrow(expect.objectContaining({ code: 'workspace.confirmation_invalid' }));
    // Expiração além do TTL máximo: a barreira fail-closed precede a
    // validação temporal enquanto não há emissor server-side.
    expect(() =>
      verifyDeleteConfirmation(
        { ...forged, expiresAt: new Date(Date.now() + DELETION_INVENTORY_TTL_MS * 10).toISOString() },
        { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: version },
      ),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
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
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const error = await store
      .deleteEmpty({
        authUserId: 'auth-user-1',
        householdId: WS_ID,
        confirmation: buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          inventoryVersion: randomUUID().replace(/-/g, ''),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          agentAttestation: 'verified-empty',
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

  it('FIX-WS-D2-R2 item 1 (HIGH cross-store): unverified BLOQUEIA o delete, sem tocar nos dados', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen);
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    expect(inventory.agentAttestation).toBe('unverified');
    // Confirmação de resto válida (versão + expiração), mas sem atestação.
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
      agentAttestation: 'unverified',
    });
    await expect(
      store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified', statusCode: 409 });
    // Nenhum efeito: sem tombstone, sem closure, sem flip de status.
    expect(seen.some((sql) => /INTO workspace_tombstones|INTO workspace_closure_log|SET status = 'deleted'/.test(sql))).toBe(false);
  });

  it('FIX-WS-D2-R2 item 5 (MEDIUM confirmação): replay com expiresAt adulterado diverge e recusa', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen);
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    // Replay: mesma versão, expiração re-carimbada AINDA VÁLIDA na janela
    // (o ataque renova a validade reemitindo `expiresAt`; sem vínculo, a
    // versão casaria e o delete prosseguiria). A expiração é imutável por
    // vínculo: versão cobre contagens + expiração inventariada.
    const tamperedExpiresAt = new Date(Date.parse(inventory.expiresAt) - 5 * 60 * 1000).toISOString();
    expect(Date.parse(tamperedExpiresAt)).toBeGreaterThan(Date.now());
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: tamperedExpiresAt,
      agentAttestation: 'verified-empty',
    });
    await expect(
      store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation }),
    ).rejects.toMatchObject({ code: 'workspace.confirmation_invalid' });
    expect(seen.some((sql) => /INTO workspace_tombstones|INTO workspace_closure_log|SET status = 'deleted'/.test(sql))).toBe(false);
  });

  it('FIX-WS-D2-R2 item 4 (HIGH header): rename sobre archived recusa pelo path, sem header', async () => {
    // Store-level, sem header algum: o lifecycle vale pelo workspace
    // efetivamente mutado (path), nunca pelo header opcional.
    const pool = mockPool({
      'FROM users': () => membershipOwner(),
      'FROM households': () => ({
        rows: [{ id: WS_ID, name: 'Arquivado', kind: 'shared', status: 'archived' }],
        rowCount: 1,
      }),
    });
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    await expect(
      store.rename({ authUserId: 'auth-user-1', householdId: WS_ID, name: 'Novo nome' }),
    ).rejects.toMatchObject({ code: 'workspace.archived', statusCode: 403 });
  });

  it('FIX-WS-D2-R2 item 3 (HIGH restore): restore é serializado sob lock com UPDATE condicional', async () => {
    const seen: string[] = [];
    const pool = mockPool(
      {
        'FROM users': () => membershipOwner(),
        'FROM households': () => ({
          rows: [{ id: WS_ID, name: 'Arquivado', kind: 'shared', status: 'archived' }],
          rowCount: 1,
        }),
        'FROM workspace_tombstones': () => ({ rows: [], rowCount: 0 }),
        "SET status = $1": () => ({
          rows: [{ id: WS_ID, name: 'Arquivado', kind: 'shared', status: 'active' }],
          rowCount: 1,
        }),
      },
      seen,
    );
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const restored = await store.setStatus({ authUserId: 'auth-user-1', householdId: WS_ID, status: 'active' });
    expect(restored.status).toBe('active');
    // Restore travou a linha (FOR UPDATE), consultou o tombstone
    // (proibição autoritativa) e flipou com UPDATE condicional.
    expect(seen.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(seen.some((sql) => sql.includes('workspace_tombstones'))).toBe(true);
    expect(seen.some((sql) => sql.includes("status <> 'deleted'"))).toBe(true);
  });

  it('FIX-WS-D2-R2 item 3 (HIGH restore): restore-vs-delete concorrente — delete venceu, restore recusa', async () => {
    const pool = mockPool({
      'FROM users': () => membershipOwner(),
      // O delete concorrente já flipou para deleted antes do restore.
      'FROM households': () => ({
        rows: [{ id: WS_ID, name: 'Vazio', kind: 'shared', status: 'deleted' }],
        rowCount: 1,
      }),
    });
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    await expect(
      store.setStatus({ authUserId: 'auth-user-1', householdId: WS_ID, status: 'active' }),
    ).rejects.toMatchObject({ code: 'workspace.deleted', statusCode: 410 });
  });
});

describe('FIX-WS-D2-R3 (residuais REVIEW-WS-D2-R2) — RED first', () => {
  it('R3 item 1 (HIGH atestação): verified-empty declarado no body é FORJADO — delete bloqueia sem prova server-side', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen);
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    expect(inventory.empty).toBe(true);
    // Workspace vazio, confirmação "perfeita" com atestação declarada pelo
    // cliente: sem emissor server-side, a string é indistinguível de
    // falsificação — o delete NUNCA conclui (fail-closed).
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
      agentAttestation: 'verified-empty',
    });
    await expect(
      store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified', statusCode: 409 });
    expect(seen.some((sql) => /INTO workspace_tombstones|INTO workspace_closure_log|SET status = 'deleted'/.test(sql))).toBe(false);
  });

  it('R3 item 1 (HIGH atestação): verifyDeleteConfirmation é fail-closed mesmo com verified-empty', () => {
    const version = createHash('sha256').update('inv').digest('hex');
    const forged = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: version,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      agentAttestation: 'verified-empty',
    });
    expect(() =>
      verifyDeleteConfirmation(forged, { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: version }),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
  });

  it('R3 item 3 (MEDIUM expiração): adulteração CONJUNTA expiração+hash recusa (confirmation_invalid)', async () => {
    const seen: string[] = [];
    const pool = withInventoryProbe({}, seen);
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    // Ataque: expiração re-carimbada (ainda na janela) + versão
    // RECOMPUTADA pelo atacante com o algoritmo público sobre as
    // contagens vazias (trivialmente adivinháveis). Sem segredo
    // server-side, o vínculo casa e o delete prosseguiria.
    const tamperedExpiresAt = new Date(Date.parse(inventory.expiresAt) - 5 * 60 * 1000).toISOString();
    expect(Date.parse(tamperedExpiresAt)).toBeGreaterThan(Date.now());
    const zeroCounts: Record<string, number> = {};
    for (const [key, value] of Object.entries(zeroInventoryRow())) zeroCounts[key] = Number(value);
    // Atacante sem o segredo: HMAC com segredo errado (ou o SHA-256
    // público antigo) nunca casa com a emissão do servidor.
    const forgedVersion = hashInventoryCounts(WS_ID, zeroCounts, tamperedExpiresAt, 'attacker-without-secret');
    const confirmation = buildDeleteConfirmation({
      workspaceId: WS_ID,
      actor: 'auth-user-1',
      inventoryVersion: forgedVersion,
      expiresAt: tamperedExpiresAt,
      agentAttestation: 'verified-empty',
    });
    await expect(
      store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation }),
    ).rejects.toMatchObject({ code: 'workspace.confirmation_invalid' });
    expect(seen.some((sql) => /INTO workspace_tombstones|INTO workspace_closure_log|SET status = 'deleted'/.test(sql))).toBe(false);
  });
});
