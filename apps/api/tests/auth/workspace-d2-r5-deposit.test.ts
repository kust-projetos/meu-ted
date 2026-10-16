import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresWorkspaceStore } from '../../src/auth/workspaces-postgres.js';
import {
  createInMemoryWorkspaceStore,
} from '../../src/auth/workspaces-store.js';
import {
  buildDeleteConfirmation,
  signAgentEmptyProof,
  verifyDeleteConfirmation,
  type AgentEmptyProof,
} from '../../src/auth/workspace-deletion.js';

/**
 * FIX-WS-D2-R5 — depósito server-side da prova Agent→API: o browser
 * recebe SÓ o handle opaco (UUID); conteúdo, contagens e HMAC nunca
 * cruzam o browser. O delete aceita SÓ o handle e resolve tudo
 * server-side (workspace + versão vinculada + expiração + não-consumido).
 *
 * RED first: `depositEmptyAttestation`/`attestationId` não existem.
 */

const TEST_HMAC_SECRET = 'test-only-workspace-deletion-hmac-secret';
const WS_ID = '11111111-1111-4111-8111-111111111111';
const VERSION = 'a'.repeat(64);
const ZERO = { sessions: 0, messages: 0, memories: 0, attachments: 0 };

const validProofFor = (workspaceId: string, inventoryVersion: string, secret = TEST_HMAC_SECRET): AgentEmptyProof =>
  signAgentEmptyProof({ workspaceId, inventoryVersion, counts: { ...ZERO } }, secret);

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

const membershipOwner = () => ({
  rows: [{ id: 'owner-1', user_id: 'owner-1', role: 'owner' }],
  rowCount: 1,
});

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

describe('R5 — handle opaco do depósito (domínio puro)', () => {
  it('confirmação sem handle bloqueia fail-closed (nada cruza o browser)', () => {
    expect(() =>
      verifyDeleteConfirmation(
        buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          inventoryVersion: VERSION,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          agentAttestation: 'verified-empty',
        }),
        { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: VERSION },
      ),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
  });

  it('handle malformado (não-UUID) bloqueia fail-closed', () => {
    expect(() =>
      verifyDeleteConfirmation(
        buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          inventoryVersion: VERSION,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          agentAttestation: 'verified-empty',
          attestationId: 'not-a-uuid',
        }),
        { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: VERSION },
      ),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
  });

  it('handle UUID válido passa na validação pura (o conteúdo resolve no store)', () => {
    expect(() =>
      verifyDeleteConfirmation(
        buildDeleteConfirmation({
          workspaceId: WS_ID,
          actor: 'auth-user-1',
          inventoryVersion: VERSION,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          agentAttestation: 'unverified',
          attestationId: randomUUID(),
        }),
        { workspaceId: WS_ID, actor: 'auth-user-1', inventoryVersion: VERSION },
      ),
    ).not.toThrow();
  });
});

describe('R5 — depósito e consumo no store in-memory', () => {
  const setup = async () => {
    const store = createInMemoryWorkspaceStore(undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const created = await store.create({ authUserId: 'u1', name: 'Vazio', kind: 'shared' });
    const inventory = await store.deletionInventory({ authUserId: 'u1', householdId: created.id });
    return { store, created, inventory };
  };
  const confirmationFor = (workspaceId: string, inventory: { inventoryVersion: string; expiresAt: string }, attestationId: string) =>
    buildDeleteConfirmation({
      workspaceId,
      actor: 'u1',
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
      agentAttestation: 'unverified',
      attestationId,
    });

  it('depósito válido retorna SÓ o handle opaco (sem conteúdo/HMAC/contagens)', async () => {
    const { store, created, inventory } = await setup();
    const deposited = await store.depositEmptyAttestation({
      proof: validProofFor(created.id, inventory.inventoryVersion),
    });
    expect(Object.keys(deposited)).toEqual(['attestationId']);
    expect(deposited.attestationId).toMatch(/^[0-9a-f-]{36}$/i);
    const leaked = JSON.stringify(deposited);
    expect(leaked).not.toContain('hmac');
    expect(leaked).not.toContain('sessions');
  });

  it('delete com handle válido conclui; sem handle ou com handle inexistente bloqueia', async () => {
    const { store, created, inventory } = await setup();
    await expect(
      store.deleteEmpty({
        authUserId: 'u1',
        householdId: created.id,
        confirmation: confirmationFor(created.id, inventory, randomUUID()),
      }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
    const { attestationId } = await store.depositEmptyAttestation({
      proof: validProofFor(created.id, inventory.inventoryVersion),
    });
    const receipt = await store.deleteEmpty({
      authUserId: 'u1',
      householdId: created.id,
      confirmation: confirmationFor(created.id, inventory, attestationId),
    });
    expect(receipt.id).toBe(created.id);
  });

  it('prova adulterada é recusada NO DEPÓSITO (nada é registrado)', async () => {
    const { store, created, inventory } = await setup();
    const proof = validProofFor(created.id, inventory.inventoryVersion);
    await expect(
      store.depositEmptyAttestation({ proof: { ...proof, hmac: 'f'.repeat(64) } }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
  });

  it('depósito de outro workspace recusa sem consumir (o legítimo segue válido)', async () => {
    const store = createInMemoryWorkspaceStore(undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const wsA = await store.create({ authUserId: 'u1', name: 'A', kind: 'shared' });
    const wsB = await store.create({ authUserId: 'u1', name: 'B', kind: 'shared' });
    const invA = await store.deletionInventory({ authUserId: 'u1', householdId: wsA.id });
    const invB = await store.deletionInventory({ authUserId: 'u1', householdId: wsB.id });
    const { attestationId } = await store.depositEmptyAttestation({
      proof: validProofFor(wsA.id, invA.inventoryVersion),
    });
    // Handle de A usado no delete de B: recusa, sem consumir.
    await expect(
      store.deleteEmpty({
        authUserId: 'u1',
        householdId: wsB.id,
        confirmation: confirmationFor(wsB.id, invB, attestationId),
      }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
    // O depósito legítimo segue intacto: delete de A conclui.
    const receipt = await store.deleteEmpty({
      authUserId: 'u1',
      householdId: wsA.id,
      confirmation: confirmationFor(wsA.id, invA, attestationId),
    });
    expect(receipt.id).toBe(wsA.id);
  });

  it('sem segredo, depósito e delete são indisponíveis fail-closed', async () => {
    const store = createInMemoryWorkspaceStore(undefined, {});
    const created = await store.create({ authUserId: 'u1', name: 'Vazio', kind: 'shared' });
    await expect(
      store.depositEmptyAttestation({ proof: validProofFor(created.id, VERSION, TEST_HMAC_SECRET) }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
  });
});

describe('R5 — consumo single-use no store postgres (mock-pool)', () => {
  const baseHandlers = () => ({
    'FROM users': () => membershipOwner(),
    'FROM households': () => ({
      rows: [{ id: WS_ID, name: 'Vazio', kind: 'shared', status: 'active' }],
      rowCount: 1,
    }),
    'FROM pending_operations': () => ({ rows: [zeroInventoryRow()], rowCount: 1 }),
  });

  it('handle reutilizado recusa sem efeito (segundo consumo encontra consumed_at)', async () => {
    const seen: string[] = [];
    let consumeCalls = 0;
    const pool = mockPool(
      {
        ...baseHandlers(),
        'INTO workspace_empty_attestations': () => ({ rows: [{ id: randomUUID() }], rowCount: 1 }),
        // Primeiro consumo OK; reuso encontra a linha já consumida.
        'UPDATE workspace_empty_attestations': () => {
          consumeCalls += 1;
          return consumeCalls === 1
            ? { rows: [{ id: 'deposit-1' }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        },
        'INTO workspace_tombstones': () => ({ rows: [], rowCount: 1 }),
        'INTO workspace_closure_log': () => ({ rows: [], rowCount: 1 }),
        "SET status = 'deleted'": () => ({ rows: [], rowCount: 1 }),
      },
      seen,
    );
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: WS_ID });
    const { attestationId } = await store.depositEmptyAttestation({
      proof: validProofFor(WS_ID, inventory.inventoryVersion),
    });
    const confirmation = () =>
      buildDeleteConfirmation({
        workspaceId: WS_ID,
        actor: 'auth-user-1',
        inventoryVersion: inventory.inventoryVersion,
        expiresAt: inventory.expiresAt,
        agentAttestation: 'unverified',
        attestationId,
      });
    const receipt = await store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation: confirmation() });
    expect(receipt.id).toBe(WS_ID);
    // Mesmo handle, workspace ainda ativo no mock: o consumo falha.
    await expect(
      store.deleteEmpty({ authUserId: 'auth-user-1', householdId: WS_ID, confirmation: confirmation() }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified', statusCode: 409 });
    expect(seen.filter((sql) => sql.includes('UPDATE workspace_empty_attestations'))).toHaveLength(2);
  });

  it('depósito para workspace inexistente recusa 404 sem registrar', async () => {
    const seen: string[] = [];
    const pool = mockPool(
      {
        // Nenhuma household: depósito não registra.
        'FROM households': () => ({ rows: [], rowCount: 0 }),
      },
      seen,
    );
    const store = createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
    await expect(
      store.depositEmptyAttestation({ proof: validProofFor(WS_ID, VERSION) }),
    ).rejects.toMatchObject({ code: 'workspace.not_found' });
    expect(seen.some((sql) => sql.includes('INTO workspace_empty_attestations'))).toBe(false);
  });
});
