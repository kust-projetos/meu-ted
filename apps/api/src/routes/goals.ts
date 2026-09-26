import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import { DomainError } from '../writes/errors.js';
import { mapPgError } from '../db/sqlstate.js';
import { requireIdempotencyKey, httpIdempotencyPayload, type IdempotencyStore } from '../writes/idempotency.js';
import type { GoalStore } from '../goals/store.js';
import type { AuthResolver } from './auth.js';
import { isoDateSchema as isoDate } from '../shared/iso-date.js';
import { positiveMoneyCentsSchema } from '../shared/money.js';

export const createGoalSchema = z.object({
  name: z.string().trim().min(1),
  goalType: z.enum(['savings', 'purchase', 'debt_payoff', 'emergency_fund']),
  targetAmountCents: positiveMoneyCentsSchema,
  startDate: isoDate,
  targetDate: isoDate.optional(),
  description: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  notes: z.string().optional(),
});

export const contributeSchema = z.object({
  amountCents: positiveMoneyCentsSchema,
  contributionDate: isoDate.optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
});

const resolveAuth = (rt: AuthResolver) => async (req: FastifyRequest) => {
  if (req.authenticatedContext) return req.authenticatedContext;
  const t = req.headers[DEVICE_TOKEN_HEADER];
  return rt(Array.isArray(t) ? t[0] : t);
};
const handleErr = (err: unknown, reply: FastifyReply) => {
  if (err instanceof DomainError) return reply.code(err.statusCode).send({ code: err.code, message: err.message });
  if ((err as any).statusCode) { const e = err as any; return reply.code(e.statusCode).send({ code: e.code, message: e.message }); }
  const mapped = mapPgError(err);
  if (mapped) return reply.code(mapped.statusCode).send({ code: mapped.code, message: mapped.message });
  throw err;
};

import { createPendingApproval } from '../approvals/guard.js';
import type { ApprovalPolicy } from '../approvals/policy.js';
import type { PendingOperationStore } from '../approvals/pending.js';
import { attachMutationReceipt } from '../reconciliation/effects-registry.js';
import { runGoalMutation } from '../goals/keyed-mutations.js';

export const registerGoalRoutes = (
  app: FastifyInstance,
  opts: {
    goalStore: GoalStore;
    resolveToken: AuthResolver;
    idempotency: IdempotencyStore;
    approvalPolicy?: ApprovalPolicy;
    pendingStore?: PendingOperationStore;
  },
): void => {
  const resolve = resolveAuth(opts.resolveToken);

  app.get('/goals', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleErr(e, reply); }
    try { const items = await opts.goalStore.listGoals(ctx.householdId); return reply.send({ items, total: items.length }); }
    catch (e) { return handleErr(e, reply); }
  });

  app.post('/goals', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleErr(e, reply); }
    const p = createGoalSchema.safeParse(req.body ?? {}); if (!p.success) return reply.code(400).send({ code: 'validation.error', issues: p.error.issues });
    const rawKey = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    if (opts.approvalPolicy && opts.pendingStore) {
      const pending = await createPendingApproval(opts.approvalPolicy, opts.pendingStore, {
        householdId: ctx.householdId,
        requesterId: ctx.deviceId,
        operation: 'goal.create',
        payload: p.data,
        idempotencyKey: key ?? crypto.randomUUID(),
        amountCents: p.data.targetAmountCents,
        destructive: false,
      });
      if (pending) return reply.code(pending.status).send(pending.body);
    }
    const fn = async (claimTx?: unknown) => {
      // V4.1 Phase 3 (UOW2): the goal insert joins the claim tx.
      const g = await runGoalMutation(opts.goalStore, claimTx, ctx.householdId, 'create', {
        name: p.data.name, goalType: p.data.goalType, targetAmountCents: p.data.targetAmountCents, startDate: p.data.startDate,
        ...(p.data.targetDate ? { targetDate: p.data.targetDate } : {}),
        ...(p.data.description ? { description: p.data.description } : {}),
        ...(p.data.categoryId ? { categoryId: p.data.categoryId } : {}),
        ...(p.data.accountId ? { accountId: p.data.accountId } : {}),
        ...(p.data.notes ? { notes: p.data.notes } : {}),
      });
      return { status: 201 as const, body: attachMutationReceipt(g, 'goal.create', { type: 'goal', id: g.id }) };
    };
    try {
      const result = key
        ? await opts.idempotency.lookupOrRecord(ctx.householdId, key, httpIdempotencyPayload({ route: 'POST /goals' }, p.data), fn)
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) { return handleErr(e, reply); }
  });

  app.post('/goals/:id/contribute', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleErr(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const p = contributeSchema.safeParse(req.body ?? {}); if (!p.success) return reply.code(400).send({ code: 'validation.error', issues: p.error.issues });
    const rawKey = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    const fn = async (claimTx?: unknown) => {
      // V4.1 Phase 3 (UOW2): the atomic increment joins the claim tx.
      const c = await runGoalMutation(opts.goalStore, claimTx, ctx.householdId, 'contribute', {
        id: params.data.id,
        input: {
          amountCents: p.data.amountCents,
          ...(p.data.contributionDate ? { contributionDate: p.data.contributionDate } : {}),
          ...(p.data.source ? { source: p.data.source } : {}),
          ...(p.data.notes ? { notes: p.data.notes } : {}),
        },
      });
      return { status: 201 as const, body: attachMutationReceipt(c, 'goal.update', { type: 'goal', id: params.data.id }) };
    };
    try {
      const result = key
        ? await opts.idempotency.lookupOrRecord(ctx.householdId, key, httpIdempotencyPayload({ route: 'POST /goals/:id/contribute', resourceId: params.data.id }, { id: params.data.id, ...p.data }), fn)
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) { return handleErr(e, reply); }
  });

  app.post('/goals/:id/cancel', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleErr(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    try { const g = await opts.goalStore.cancelGoal(ctx.householdId, params.data.id); return reply.send(attachMutationReceipt(g, 'goal.delete', { type: 'goal', id: params.data.id })); }
    catch (e) { return handleErr(e, reply); }
  });

  app.patch('/goals/:id', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleErr(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const s = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      targetAmountCents: z.number().int().positive().optional(),
      targetDate: isoDate.optional(),
    }).refine((v) => v.name !== undefined || v.targetAmountCents !== undefined || v.targetDate !== undefined, { message: 'nenhum campo para atualizar' });
    const p = s.safeParse(req.body ?? {}); if (!p.success) return reply.code(400).send({ code: 'validation.error', issues: p.error.issues });
    const rawKey = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    const fn = async (claimTx?: unknown) => {
      const g = await runGoalMutation(opts.goalStore, claimTx, ctx.householdId, 'update', {
        id: params.data.id,
        patch: p.data as Parameters<typeof opts.goalStore.updateGoal>[2],
      });
      return { status: 200 as const, body: attachMutationReceipt(g, 'goal.update', { type: 'goal', id: params.data.id }) };
    };
    try {
      const result = key
        ? await opts.idempotency.lookupOrRecord(ctx.householdId, key, httpIdempotencyPayload({ route: 'PATCH /goals/:id', resourceId: params.data.id }, { id: params.data.id, ...p.data }), fn)
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) { return handleErr(e, reply); }
  });
};
