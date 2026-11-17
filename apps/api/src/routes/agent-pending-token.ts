import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeCompareTokens } from '../auth/safe-compare.js';
import { createDelegatedTurnToken } from '../auth/delegated-token.js';
import type { WorkspaceAccessStore } from '../auth/workspace-access.js';
import { resolveCanonicalHouseholdId } from '../auth/workspace-alias.js';

const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  actorId: z.string().uuid(),
  deviceId: z.string().min(1).max(128).refine((v) => !/[\s\x00-\x1f\x7f]/.test(v)),
  requestId: z.string().min(1).max(240),
}).strict();

export const registerAgentPendingTokenRoutes = (
  app: FastifyInstance,
  deps: {
    pendingMintServiceToken?: string | undefined;
    delegationSecret?: string | undefined;
    workspaceAccess?: WorkspaceAccessStore | undefined;
    pool?: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> } | null;
  },
): void => {
  app.post('/auth/agent/pending-token', async (req, reply) => {
    const configured = deps.pendingMintServiceToken?.trim();
    if (!configured || configured.length < 32) return reply.code(503).send({ code: 'auth.service_unavailable' });
    const custom = req.headers['x-agent-pending-service-token'];
    const auth = req.headers.authorization;
    const provided = (typeof custom === 'string' ? custom : Array.isArray(custom) ? custom[0] : undefined)
      ?? (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined);
    if (!provided || !safeCompareTokens(provided, configured)) {
      return reply.code(401).send({ code: 'auth.invalid_service_token' });
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error' });
    if (!deps.delegationSecret || !deps.workspaceAccess) {
      return reply.code(503).send({ code: 'auth.service_unavailable' });
    }
    try {
      const input = parsed.data;
      const workspace = await resolveCanonicalHouseholdId(deps.pool, input.workspaceId);
      if (workspace !== input.workspaceId) return reply.code(403).send({ code: 'auth.workspace_forbidden' });
      const access = await deps.workspaceAccess.resolve(input.actorId, workspace);
      if (!access || access.status && access.status !== 'active') return reply.code(403).send({ code: 'auth.workspace_forbidden' });
      const result = deps.pool
        ? await deps.pool.query(
            `SELECT device_id FROM device_tokens WHERE device_id = $1 AND household_id = $2 AND user_id = $3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
            [input.deviceId, workspace, access.userId],
          )
        : null;
      if (!result || result.rowCount !== 1) return reply.code(403).send({ code: 'auth.device_forbidden' });
      const capabilities = [
        'financial.read', 'financial.approval.read', 'financial.approval.propose',
        'financial.approval.confirm', 'financial.approval.cancel', 'financial.approval.retry',
        'financial.approval.reconcile', 'financial.approval.execute', 'financial.undo.execute',
      ];
      const token = await createDelegatedTurnToken({
        actorId: access.userId, workspaceId: access.householdId, role: access.role,
        capabilities, requestId: input.requestId, deviceId: input.deviceId,
      }, deps.delegationSecret);
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { exp: number };
      return reply.send({ token, expiresAt: new Date(payload.exp * 1000).toISOString() });
    } catch {
      return reply.code(403).send({ code: 'auth.workspace_forbidden' });
    }
  });
};
