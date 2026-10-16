import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { createBetterAuth } from '../../src/auth/better-auth.js';
import { createInMemoryWorkspaceStore } from '../../src/auth/workspaces-store.js';
import { registerWorkspaceRoutes } from '../../src/auth/workspaces-http.js';
import { signAgentEmptyProof } from '../../src/auth/workspace-deletion.js';

/**
 * FIX-WS-D2-R5 — rota interna de depósito (`POST
 * /internal/agent/empty-attestations`): server-to-server Agent→API, sem
 * cruzar o browser. Auth em duas camadas (service token + owner
 * revalidado); retorna SÓ o handle opaco. O delete HTTP aceita SÓ o
 * handle — prova HMAC no fio é ignorada (strip, nunca verificada).
 */

const TEST_HMAC_SECRET = 'test-only-workspace-deletion-hmac-secret';
const SERVICE_TOKEN = 'test-only-agent-service-token-32-chars!!';

const auth = {
  api: {
    getSession: async () => ({
      user: { id: 'auth-user-1', email: 'owner@example.com' },
      session: { id: 'session-1' },
    }),
  },
} as unknown as ReturnType<typeof createBetterAuth>;

const ownerAccess = {
  // O depósito identifica o dono pelo actor do Agent (claim da chamada
  // server-to-server); o delete identifica pela sessão Better Auth. O
  // stub reconhece ambos como owner do workspace de teste.
  resolve: async (userId: string, householdId: string) =>
    userId === 'actor-owner-1' || userId === 'auth-user-1'
      ? { userId, householdId, role: 'owner' as const, kind: 'shared' as const }
      : undefined,
};

const setup = async () => {
  const app = Fastify({ logger: false });
  const store = createInMemoryWorkspaceStore(undefined, { deletionHmacSecret: TEST_HMAC_SECRET });
  registerWorkspaceRoutes(app, { auth, store, workspaceAccess: ownerAccess, agentServiceToken: SERVICE_TOKEN });
  await app.ready();
  const created = await store.create({ authUserId: 'auth-user-1', name: 'Vazio', kind: 'shared' });
  const inventory = await store.deletionInventory({ authUserId: 'auth-user-1', householdId: created.id });
  const proof = signAgentEmptyProof(
    {
      workspaceId: created.id,
      inventoryVersion: inventory.inventoryVersion,
      counts: { sessions: 0, messages: 0, memories: 0, attachments: 0 },
    },
    TEST_HMAC_SECRET,
  );
  return { app, store, created, inventory, proof };
};

describe('R5 — rota interna de depósito (server-to-server)', () => {
  it('sem service token, indisponível fail-closed (401, nunca deposita)', async () => {
    const { app, proof } = await setup();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/agent/empty-attestations',
        payload: { actorId: 'actor-owner-1', proof },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'auth.invalid_service_token' });
    } finally {
      await app.close();
    }
  });

  it('não-owner é recusado (403) antes de qualquer registro', async () => {
    const { app, proof } = await setup();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/agent/empty-attestations',
        headers: { 'x-agent-service-token': SERVICE_TOKEN },
        payload: { actorId: 'actor-member-9', proof },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'workspace.forbidden' });
    } finally {
      await app.close();
    }
  });

  it('depósito válido retorna SÓ o handle opaco (201, sem conteúdo/HMAC)', async () => {
    const { app, proof } = await setup();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/agent/empty-attestations',
        headers: { 'x-agent-service-token': SERVICE_TOKEN },
        payload: { actorId: 'actor-owner-1', proof },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['attestationId']);
      expect(body['attestationId']).toMatch(/^[0-9a-f-]{36}$/i);
      const leaked = JSON.stringify(body);
      expect(leaked).not.toContain('hmac');
      expect(leaked).not.toContain('sessions');
    } finally {
      await app.close();
    }
  });

  it('prova forjada recusa no depósito (409, sem registrar)', async () => {
    const { app, proof } = await setup();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/agent/empty-attestations',
        headers: { 'x-agent-service-token': SERVICE_TOKEN },
        payload: { actorId: 'actor-owner-1', proof: { ...proof, hmac: 'f'.repeat(64) } },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'workspace.agent_unverified' });
    } finally {
      await app.close();
    }
  });

  it('delete HTTP ponta a ponta com o handle; prova HMAC no fio é ignorada', async () => {
    const { app, created, inventory, proof } = await setup();
    try {
      const deposited = await app.inject({
        method: 'POST',
        url: '/internal/agent/empty-attestations',
        headers: { 'x-agent-service-token': SERVICE_TOKEN },
        payload: { actorId: 'actor-owner-1', proof },
      });
      expect(deposited.statusCode).toBe(201);
      const { attestationId } = deposited.json() as { attestationId: string };
      // R4 legado no fio (prova HMAC no body do delete): o servidor
      // ignora — sem handle, bloqueia fail-closed.
      const legacy = await app.inject({
        method: 'DELETE',
        url: `/workspaces/${created.id}`,
        headers: { 'idempotency-key': 'del-legacy-1' },
        payload: {
          confirmation: {
            workspaceId: created.id,
            action: 'workspace.delete',
            inventoryVersion: inventory.inventoryVersion,
            expiresAt: inventory.expiresAt,
            agentAttestation: 'verified-empty',
            agentProof: proof,
          },
        },
      });
      expect(legacy.statusCode).toBe(409);
      expect(legacy.json()).toMatchObject({ code: 'workspace.agent_unverified' });
      // Com o handle opaco, conclui.
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/workspaces/${created.id}`,
        headers: { 'idempotency-key': 'del-r5-1' },
        payload: {
          confirmation: {
            workspaceId: created.id,
            action: 'workspace.delete',
            inventoryVersion: inventory.inventoryVersion,
            expiresAt: inventory.expiresAt,
            agentAttestation: 'unverified',
            attestationId,
          },
        },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ id: created.id });
    } finally {
      await app.close();
    }
  });
});
