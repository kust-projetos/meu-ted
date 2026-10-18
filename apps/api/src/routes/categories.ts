import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import type { ReadModelStore } from '../read-models/store.js';
import type { WriteStore } from '../writes/store.js';
import { createCategoryInputSchema, deleteCategoryInputSchema, updateCategoryInputSchema } from '../writes/types.js';
import { buildCategoryTree } from '../categories/tree.js';
import { DomainError } from '../writes/errors.js';
import { requireIdempotencyKey, httpIdempotencyPayload, type IdempotencyStore } from '../writes/idempotency.js';
import type { AuthResolver } from './auth.js';
import { createPendingApproval } from '../approvals/guard.js';
import type { ApprovalPolicy } from '../approvals/policy.js';
import type { PendingOperationStore } from '../approvals/pending.js';
import { attachMutationReceipt } from '../reconciliation/effects-registry.js';
import { runCategoryMutation } from '../writes/keyed-mutations.js';

export const categoryQuerySchema = z.object({ kind: z.enum(['expense', 'income']).optional() });
const querySchema = categoryQuerySchema;

export const registerCategoryRoutes = (
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
  // effect on it (runCategoryMutation), so claim + effect + completion commit
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

  app.get('/categories', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      let items = await opts.store.listCategories(ctx.householdId);
      if (parsed.data.kind) items = items.filter((c) => c.kind === parsed.data.kind);
      return reply.code(200).send({ items, total: items.length });
    } catch (e) { return handleError(e, reply); }
  });

  // GET /categories/tree — canonical macro/sub tree contract (item 11).
  // Nodes: { id, name, icon, kind: 'macro'|'sub', type: 'expense'|'income',
  //          parentId?, isDefault?, subcategories?: [{id,name,icon,kind:'sub',parentId}] }.
  app.get('/categories/tree', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      let items = await opts.store.listCategories(ctx.householdId);
      if (parsed.data.kind) items = items.filter((c) => c.kind === parsed.data.kind);
      const tree = buildCategoryTree(items);
      return reply.code(200).send({ items: tree, total: tree.length });
    } catch (e) { return handleError(e, reply); }
  });

  // POST /categories/apply-defaults — idempotent pt-BR template application.
  // T06: keyed through the claim tx (runCategoryMutation 'applyDefaults') so
  // concurrent same-key applications converge on one recorded receipt.
  app.post('/categories/apply-defaults', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    try {
      const outcome = await runIdempotent(req, ctx.householdId, {}, async (claimTx) => {
        const result = await runCategoryMutation(opts.writes, claimTx, ctx.householdId, 'applyDefaults', {});
        // FIX-P1 (SPEC §15.1): template application creates categories →
        // category.create receipt (bulk: no single entity). Never a
        // PendingOperation for this normal write (no operationId).
        return { status: 200 as const, body: attachMutationReceipt({ ok: true, ...result }, 'category.create') };
      }, 'POST /categories/apply-defaults');
      if (outcome.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(outcome.response.status).send(outcome.response.body);
    } catch (e) { return handleError(e, reply); }
  });

  app.post('/categories', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const parsed = createCategoryInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      const result = await runIdempotent(req, ctx.householdId, parsed.data, async (claimTx) => {
        const created = await runCategoryMutation(opts.writes, claimTx, ctx.householdId, 'create', parsed.data);
        return { status: 201 as const, body: attachMutationReceipt(created, 'category.create', { type: 'category', id: created.id }) };
      }, 'POST /categories');
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

  app.patch('/categories/:id', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const parsed = updateCategoryInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      const result = await runIdempotent(req, ctx.householdId, { id: params.data.id, ...parsed.data }, async (claimTx) => {
        const updated = await runCategoryMutation(opts.writes, claimTx, ctx.householdId, 'update', { id: params.data.id, patch: parsed.data });
        return { status: 200 as const, body: attachMutationReceipt(updated, 'category.update', { type: 'category', id: params.data.id }) };
      }, 'PATCH /categories/:id', params.data.id);
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    }
    catch (e) { return handleError(e, reply); }
  });

  app.post('/categories/:id/deactivate', async (req, reply) => {    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const rawKey = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    if (opts.approvalPolicy && opts.pendingStore) {
      const pending = await createPendingApproval(opts.approvalPolicy, opts.pendingStore, {
        householdId: ctx.householdId,
        requesterId: ctx.deviceId,
        operation: 'category.deactivate',
        payload: { id: params.data.id },
        idempotencyKey: key ?? crypto.randomUUID(),
        destructive: true,
      });
      if (pending) return reply.code(pending.status).send(pending.body);
    }
    try {
      const result = await runIdempotent(req, ctx.householdId, { id: params.data.id }, async (claimTx) => {
        const deactivated = await runCategoryMutation(opts.writes, claimTx, ctx.householdId, 'deactivate', { id: params.data.id });
        return { status: 200 as const, body: attachMutationReceipt(deactivated, 'category.delete', { type: 'category', id: params.data.id }) };
      }, 'POST /categories/:id/deactivate', params.data.id);
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    }
    catch (e) { return handleError(e, reply); }
  });

  // POST /categories/:id/delete — macro removal with record destination.
  // { mode: 'move', destinationCategoryId } reassigns every referencing
  // transaction (category + cleared sub refs); { mode: 'cascade', confirm: true }
  // soft-deletes them instead. Subs of a macro are always removed together.
  // T06: keyed through the claim tx (runCategoryMutation 'delete').
  app.post('/categories/:id/delete', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const parsed = deleteCategoryInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      const payload = { id: params.data.id, ...parsed.data };
      const outcome = await runIdempotent(req, ctx.householdId, payload, async (claimTx) => {
        const result = await runCategoryMutation(opts.writes, claimTx, ctx.householdId, 'delete', { id: params.data.id, input: parsed.data });
        return { status: 200 as const, body: attachMutationReceipt({ ok: true, ...result }, 'category.delete', { type: 'category', id: params.data.id }) };
      }, 'POST /categories/:id/delete', params.data.id);
      if (outcome.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(outcome.response.status).send(outcome.response.body);
    } catch (e) { return handleError(e, reply); }
  });
};
