import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getBetterAuthSessionContext, type createBetterAuth } from './better-auth.js';
import './request-context.js';
import type { ReconnectTokenStore } from './reconnect-tokens.js';
import type { ReconnectSocketRegistry } from './reconnect-sockets.js';
import type { WorkspaceAccessStore } from './workspace-access.js';
import { DomainError } from '../writes/errors.js';
import { createInMemoryIdempotencyStore, requireIdempotencyKey, type IdempotencyStore } from '../writes/idempotency.js';


export type {
  WorkspaceKind,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceStatus,
  WorkspaceStore,
  WorkspaceSummary,
} from './workspaces-store.js';
export type {
  AgentEmptyProof,
  DeleteConfirmation,
  DeleteReceipt,
  DeletionInventory,
} from './workspace-deletion.js';
export {
  WorkspaceError,
  createInMemoryWorkspaceStore,
} from './workspaces-store.js';
import {
  type WorkspaceStore,
  WorkspaceError,
} from './workspaces-store.js';

type BetterAuth = ReturnType<typeof createBetterAuth>;

const WORKSPACE_CREATE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// Workspace creation does not have a persistent workspace ID yet, but the
// Postgres idempotency store requires a valid UUID for operation_records.workspace_id.
// Derive a deterministic synthetic UUID from the authenticated user and creation namespace.
const getCreationSyntheticWorkspaceId = (authUserId: string): string => {
  const hash = createHash('sha256').update(`${WORKSPACE_CREATE_NAMESPACE}:workspace.create:${authUserId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

const workspaceId = z.string().uuid();
const workspaceParams = z.object({ householdId: workspaceId });
const memberParams = z.object({ householdId: workspaceId, userId: z.string().trim().min(1).max(200) });
const workspaceBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['personal', 'shared']).default('shared'),
});

// D2 (ADR-027): confirmação forte vinculada (UUID/ator/ação/versão/expiração).
// O `actor` NÃO vem do cliente: é injetado da sessão server-side no
// handler (nunca confiar em claim do cliente). `agentAttestation` segue no
// contrato de fio mas NUNCA é prova (string declarada é ignorada); o que
// conclui o delete é `agentProof` (FIX-WS-D2-R4: atestação HMAC emitida
// server-side pelo Agent, verificada com o segredo compartilhado —
// ausente/inválida → 409 workspace.agent_unverified, fail-closed).
const agentEmptyProofBody = z.object({
  workspaceId: workspaceId,
  inventoryVersion: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.object({
    sessions: z.number().int(),
    messages: z.number().int(),
    memories: z.number().int(),
    attachments: z.number().int(),
  }),
  expiresAt: z.string().datetime(),
  hmac: z.string().regex(/^[0-9a-f]{64}$/),
});

const deleteBody = z.object({
  confirmation: z.object({
    workspaceId: workspaceId,
    action: z.literal('workspace.delete'),
    inventoryVersion: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.string().datetime(),
    agentAttestation: z.enum(['unverified', 'verified-empty']),
    agentProof: agentEmptyProofBody.optional(),
  }),
  purge: z.boolean().optional(),
});

export const registerWorkspaceRoutes = (app: FastifyInstance, opts: {
  auth: BetterAuth;
  store: WorkspaceStore;
  workspaceAccess?: WorkspaceAccessStore;
  reconnectTokens?: ReconnectTokenStore;
  reconnectSockets?: ReconnectSocketRegistry;
  idempotency?: IdempotencyStore;
}): void => {

  const idempotency = opts.idempotency ?? createInMemoryIdempotencyStore();

  const session = async (request: FastifyRequest, reply: FastifyReply): Promise<{ userId: string; sessionId: string } | undefined> => {
    try {
      const context = await getBetterAuthSessionContext(opts.auth, new Headers(request.headers as Record<string, string>));
      if (!context) {
        await reply.code(401).send({ code: 'auth.missing_session', message: 'authenticated session required' });
        return undefined;
      }
      return { userId: context.userId, sessionId: context.sessionId };
    } catch {
      await reply.code(401).send({ code: 'auth.invalid_session', message: 'authenticated session required' });
      return undefined;
    }
  };

  const requireOwnerAccess = async (userId: string, householdId: string, reply: FastifyReply): Promise<boolean> => {
    if (!opts.workspaceAccess) return true;
    const access = await opts.workspaceAccess.resolve(userId, householdId);
    if (!access || access.role !== 'owner') {
      await reply.code(403).send({ code: 'workspace.forbidden', message: 'only an owner can manage this workspace' });
      return false;
    }
    return true;
  };

  const runIdempotent = async <T>(input: {
    request: FastifyRequest;
    reply: FastifyReply;
    userId: string;
    householdId: string;
    operation: string;
    payload: unknown;
    status: number;
    producer: () => Promise<T>;
  }): Promise<FastifyReply | undefined> => {
    let key: string;
    try {
      key = requireIdempotencyKey(input.request.headers);
    } catch (error) {
      return sendWorkspaceError(input.reply, error);
    }

    try {
      const result = await idempotency.lookupOrRecord(
        {
          workspaceId: input.householdId,
          actorType: 'user',
          actorId: input.userId,
          operation: input.operation,
          key,
        },
        input.payload,
        async () => ({ status: input.status, body: await input.producer() }),
      );
      if (result.replayed) input.reply.header('Idempotent-Replayed', 'true');
      return input.reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return sendWorkspaceError(input.reply, error);
    }
  };

  app.get('/workspaces', async (request, reply) => {
    const authSession = await session(request, reply);
    if (!authSession) return;
    const items = await opts.store.list(authSession.userId);
    return reply.send({ items, total: items.length });
  });

  app.post('/workspaces', async (request, reply) => {
    const authSession = await session(request, reply);
    if (!authSession) return;
    const authUserId = authSession.userId;
    const parsed = workspaceBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    return runIdempotent({
      request,
      reply,
      userId: authUserId,
      householdId: getCreationSyntheticWorkspaceId(authUserId),
      operation: 'workspace.create',
      payload: parsed.data,
      status: 201,
      producer: () => opts.store.create({ authUserId, ...parsed.data }),
    });
  });

  app.patch('/workspaces/:householdId', async (request, reply) => {
    const authSession = await session(request, reply);
    if (!authSession) return;
    const parsedParams = workspaceParams.safeParse(request.params);
    const parsedBody = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(request.body ?? {});
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({ code: 'validation.error', issues: [...(parsedParams.success ? [] : parsedParams.error.issues), ...(parsedBody.success ? [] : parsedBody.error.issues)] });
    }
    if (!await requireOwnerAccess(authSession.userId, parsedParams.data.householdId, reply)) return;
    return runIdempotent({
      request,
      reply,
      userId: authSession.userId,
      householdId: parsedParams.data.householdId,
      operation: 'workspace.rename',
      payload: { householdId: parsedParams.data.householdId, ...parsedBody.data },
      status: 200,
      producer: () => opts.store.rename({ authUserId: authSession.userId, householdId: parsedParams.data.householdId, name: parsedBody.data.name }),
    });
  });

  const registerStatusRoute = (status: 'active' | 'archived', operation: string) => {
    app.post(`/workspaces/:householdId/${status === 'archived' ? 'archive' : 'restore'}`, async (request, reply) => {
      const authSession = await session(request, reply);
      if (!authSession) return;
      const parsed = workspaceParams.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
      if (!await requireOwnerAccess(authSession.userId, parsed.data.householdId, reply)) return;
      return runIdempotent({
        request,
        reply,
        userId: authSession.userId,
        householdId: parsed.data.householdId,
        operation,
        payload: { householdId: parsed.data.householdId, status },
        status: 200,
        producer: () => opts.store.setStatus({ authUserId: authSession.userId, householdId: parsed.data.householdId, status }),
      });
    });
  };

  registerStatusRoute('archived', 'workspace.archive');
  registerStatusRoute('active', 'workspace.restore');

  // D2 (ADR-027) — inventário autoritativo de exclusão (owner-only).
  app.get('/workspaces/:householdId/deletion-inventory', async (request, reply) => {
    const authSession = await session(request, reply);
    if (!authSession) return;
    const parsed = workspaceParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    if (!await requireOwnerAccess(authSession.userId, parsed.data.householdId, reply)) return;
    try {
      const inventory = await opts.store.deletionInventory({
        authUserId: authSession.userId,
        householdId: parsed.data.householdId,
      });
      return reply.send(inventory);
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  // D2 (ADR-027) — delete SÓ-vazio, permanente, com confirmação forte.
  // `purge: true` (com-dados) recusa com 409 dedicado sem tocar nos dados.
  app.delete('/workspaces/:householdId', async (request, reply) => {
    const authSession = await session(request, reply);
    if (!authSession) return;
    const parsedParams = workspaceParams.safeParse(request.params);
    const parsedBody = deleteBody.safeParse(request.body ?? {});
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({ code: 'validation.error', issues: [...(parsedParams.success ? [] : parsedParams.error.issues), ...(parsedBody.success ? [] : parsedBody.error.issues)] });
    }
    if (!await requireOwnerAccess(authSession.userId, parsedParams.data.householdId, reply)) return;
    return runIdempotent({
      request,
      reply,
      userId: authSession.userId,
      householdId: parsedParams.data.householdId,
      operation: 'workspace.delete',
      payload: { householdId: parsedParams.data.householdId, ...parsedBody.data },
      status: 200,
      producer: () => opts.store.deleteEmpty({
        authUserId: authSession.userId,
        householdId: parsedParams.data.householdId,
        confirmation: { ...parsedBody.data.confirmation, actor: authSession.userId },
        purge: parsedBody.data.purge,
      }),
    });
  });

  app.get('/workspaces/:householdId/members', async (request, reply) => {
    const authSession = await session(request, reply);
    if (!authSession) return;
    const authUserId = authSession.userId;
    const parsed = workspaceParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      const items = await opts.store.listMembers({ authUserId, householdId: parsed.data.householdId });
      return reply.send({ items, total: items.length });
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.delete('/workspaces/:householdId/members/:userId', async (request, reply) => {
    const authSession = await session(request, reply);
    if (!authSession) return;
    const authUserId = authSession.userId;
    const parsed = memberParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    if (opts.workspaceAccess) {
      const access = await opts.workspaceAccess.resolve(authUserId, parsed.data.householdId);
      if (!access || access.role !== 'owner') {
        return reply.code(403).send({ code: 'workspace.forbidden', message: 'only an owner can remove an active member' });
      }
    }

    return runIdempotent({
      request,
      reply,
      userId: authUserId,
      householdId: parsed.data.householdId,
      operation: 'workspace.remove_member',
      payload: { householdId: parsed.data.householdId, memberUserId: parsed.data.userId },
      status: 204,
      producer: async () => {
        await opts.store.removeMember({ authUserId, householdId: parsed.data.householdId, memberUserId: parsed.data.userId });
        const removedSessions = opts.reconnectTokens?.sessionsForUser(parsed.data.userId) ?? [];
        opts.reconnectTokens?.invalidateUser(parsed.data.userId);
        opts.reconnectSockets?.closeSessions(removedSessions, 'workspace membership revoked');
      },
    });
  });


  app.post('/workspaces/:householdId/leave', async (request, reply) => {
    const authSession = await session(request, reply);
    if (!authSession) return;
    const authUserId = authSession.userId;
    const parsed = workspaceParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    return runIdempotent({
      request,
      reply,
      userId: authUserId,
      householdId: parsed.data.householdId,
      operation: 'workspace.leave',
      payload: { householdId: parsed.data.householdId },
      status: 204,
      producer: async () => {
        await opts.store.leave({ authUserId, householdId: parsed.data.householdId });
        opts.reconnectTokens?.invalidateSession(authSession.sessionId);
        opts.reconnectTokens?.invalidateUser(authUserId);
        opts.reconnectSockets?.closeSession(authSession.sessionId, 'workspace membership revoked');
      },
    });
  });
};

const sendWorkspaceError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof WorkspaceError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  if (error instanceof DomainError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  throw error;
};

export { createPostgresWorkspaceStore } from './workspaces-postgres.js';
