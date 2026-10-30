import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import type { ReadModelStore } from '../read-models/store.js';
import type { WriteStore } from '../writes/store.js';
import { createAccountInputSchema, updateAccountInputSchema } from '../writes/types.js';
import { DomainError } from '../writes/errors.js';
import { requireIdempotencyKey, httpIdempotencyPayload, type IdempotencyStore } from '../writes/idempotency.js';
import type { AuthResolver } from './auth.js';
import { createPendingApproval } from '../approvals/guard.js';
import type { ApprovalPolicy } from '../approvals/policy.js';
import type { PendingOperationStore } from '../approvals/pending.js';
import { attachMutationReceipt } from '../reconciliation/effects-registry.js';
import { runAccountMutation } from '../writes/keyed-mutations.js';

/**
 * A08: opt-in widening flags are a CLOSED two-value enum on the wire, never
 * `Boolean(raw)` — `Boolean('false')` is `true`, which would silently turn an
 * explicit "off" into the widest read. Query params arrive as strings, so the
 * contract is the string form (`kind` uses the same shape), and anything
 * outside the enum is rejected with `validation.error`: a typo fails loudly
 * instead of quietly widening or quietly hiding.
 */
export const accountQuerySchema = z.object({
  kind: z.enum(['bank', 'cash', 'credit_card']).optional(),
  /** Also return deactivated accounts (`true`). Default: active only. */
  includeInactive: z.enum(['true', 'false']).optional(),
});
const querySchema = accountQuerySchema;

export const registerAccountRoutes = (
  app: FastifyInstance,
  opts: {
    store: ReadModelStore;
    writes: WriteStore;
    resolveToken: AuthResolver;
    idempotency?: IdempotencyStore;
    approvalPolicy?: ApprovalPolicy;
    pendingStore?: PendingOperationStore;
  },
): void => {
  const resolve = async (req: import('fastify').FastifyRequest) => {
    if (req.authenticatedContext) return req.authenticatedContext;
    const token = req.headers[DEVICE_TOKEN_HEADER];
    return opts.resolveToken(Array.isArray(token) ? token[0] : token);
  };
  const handleError = (err: unknown, reply: import('fastify').FastifyReply) => {
    if (err instanceof DomainError) return reply.code(err.statusCode).send({ code: err.code, message: err.message });
    if ((err as { statusCode?: number }).statusCode) {
      const e = err as { statusCode: number; code: string; message: string };
      return reply.code(e.statusCode).send({ code: e.code, message: e.message });
    }
    throw err;
  };

  // T05 single-tx: the producer receives the open claim client and runs the
  // effect on it (runAccountMutation), so claim + effect + completion commit
  // together. Replays return the ORIGINAL status + body with
  // `Idempotent-Replayed: true`.
  const runIdempotent = async <T extends { status: number; body: unknown }>(req: import('fastify').FastifyRequest, householdId: string, payload: unknown, producer: (claimTx?: unknown) => Promise<T>, route: string, resourceId?: string): Promise<{ response: T; replayed: boolean }> => {
    const raw = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    if (raw === undefined) return { response: await producer(), replayed: false };
    const key = requireIdempotencyKey(req.headers);
    const store = opts.idempotency;
    if (!store) return { response: await producer(), replayed: false };
    const enveloped = httpIdempotencyPayload(resourceId !== undefined ? { route, resourceId } : { route }, payload);
    return store.lookupOrRecord(householdId, key, enveloped, producer);
  };

  app.get('/accounts', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      // A08: the opt-in reaches the store only when explicitly true; the read
      // stays workspace-scoped through `ctx.householdId` in both branches.
      let items = await opts.store.listAccounts(ctx.householdId, { includeInactive: parsed.data.includeInactive === 'true' });
      if (parsed.data.kind) items = items.filter((a) => a.kind === parsed.data.kind);
      return reply.code(200).send({ items, total: items.length });
    } catch (e) { return handleError(e, reply); }
  });
  app.get('/accounts/:id', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const account = (await opts.store.listAccounts(ctx.householdId)).find((item) => item.id === params.data.id);
    if (!account) return reply.code(404).send({ code: 'not_found', message: 'Conta não encontrada.' });
    return reply.code(200).send(account);
  });


  app.post('/accounts', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const parsed = createAccountInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
try {
      const result = await runIdempotent(req, ctx.householdId, parsed.data, async (claimTx) => {
        const created = await runAccountMutation(opts.writes, claimTx, ctx.householdId, 'create', parsed.data);
        return { status: 201 as const, body: attachMutationReceipt(created, 'account.create', { type: 'account', id: created.id }) };
      }, 'POST /accounts');
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      // P2 replay compat: pre-upgrade records stored the legacy `{status:200}`
      // envelope while the external contract always answered 201. A stored
      // 200 on this create route replays as the original 201 (fresh records
      // already store 201, so only legacy replays are affected).
      const storedStatus: number = result.response.status;
      return reply.code(storedStatus === 200 ? 201 : storedStatus).send(result.response.body);
    }
    catch (e) { return handleError(e, reply); }
  });

  app.patch('/accounts/:id', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const parsed = updateAccountInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
try {
      const result = await runIdempotent(req, ctx.householdId, { id: params.data.id, ...parsed.data }, async (claimTx) => {
        const updated = await runAccountMutation(opts.writes, claimTx, ctx.householdId, 'update', { id: params.data.id, patch: parsed.data });
        return { status: 200 as const, body: attachMutationReceipt(updated, 'account.update', { type: 'account', id: params.data.id }) };
      }, 'PATCH /accounts/:id', params.data.id);
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    }
    catch (e) { return handleError(e, reply); }
  });

  app.post('/accounts/:id/deactivate', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    // P3 (2026-10-30): deactivate is a financial mutation and must require an
    // Idempotency-Key unconditionally, like transactions/categories. Missing
    // key fails closed (400 idempotency.required) instead of executing without
    // idempotency. The approval path reuses the caller-provided key (no random
    // fallback) so the pending record stays bound to the original intent.
    const key = requireIdempotencyKey(req.headers);
    if (opts.approvalPolicy && opts.pendingStore) {
      const pending = await createPendingApproval(opts.approvalPolicy, opts.pendingStore, {
        householdId: ctx.householdId,
        requesterId: ctx.deviceId,
        operation: 'account.deactivate',
        payload: { id: params.data.id },
        idempotencyKey: key,
        destructive: true,
      });
      if (pending) return reply.code(pending.status).send(pending.body);
    }
try {
      const result = await runIdempotent(req, ctx.householdId, { id: params.data.id }, async (claimTx) => {
        const deactivated = await runAccountMutation(opts.writes, claimTx, ctx.householdId, 'deactivate', { id: params.data.id });
        return { status: 200 as const, body: attachMutationReceipt(deactivated, 'account.delete', { type: 'account', id: params.data.id }) };
      }, 'POST /accounts/:id/deactivate', params.data.id);
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    }
    catch (e) { return handleError(e, reply); }
  });
};
