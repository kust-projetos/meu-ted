/**
 * Subscription routes — minimal CRUD (GET/POST/cancel).
 *
 * Registered under /subscriptions/*. Requires X-Device-Token header.
 * Idempotency-key supported for POST endpoints.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import { DomainError } from '../writes/errors.js';
import { requireIdempotencyKey, httpIdempotencyPayload, type IdempotencyStore } from '../writes/idempotency.js';
import type { SubscriptionStore } from '../subscriptions/store.js';
import type { AuthResolver } from './auth.js';

// ── Input schemas ────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amountCents: z.number().int().positive(),
  cycle: z.enum(['monthly', 'yearly', 'weekly']),
  day: z.number().int().min(1).max(31),
  paymentMethod: z.string().trim().min(1).max(60),
});

const listQuerySchema = z.object({
  status: z.enum(['active', 'cancelled']).optional(),
});

// ── Helpers ──────────────────────────────────────────────────────

const resolveAuth = (resolveToken: AuthResolver) => async (req: FastifyRequest) => {
  if (req.authenticatedContext) return req.authenticatedContext;
  const token = req.headers[DEVICE_TOKEN_HEADER];
  return resolveToken(Array.isArray(token) ? token[0] : token);
};

const handleError = (err: unknown, reply: FastifyReply) => {
  if (err instanceof DomainError) {
    return reply.code(err.statusCode).send({ code: err.code, message: err.message });
  }
  if ((err as { statusCode?: number }).statusCode) {
    const e = err as { statusCode: number; code: string; message: string };
    return reply.code(e.statusCode).send({ code: e.code, message: e.message });
  }
  throw err;
};

// ── Registration ─────────────────────────────────────────────────

import { createPendingApproval } from '../approvals/guard.js';
import type { ApprovalPolicy } from '../approvals/policy.js';
import type { PendingOperationStore } from '../approvals/pending.js';
import { attachMutationReceipt } from '../reconciliation/effects-registry.js';
import { runSubscriptionMutation } from '../subscriptions/keyed-mutations.js';

export const registerSubscriptionRoutes = (
  app: FastifyInstance,
  opts: {
    subscriptionStore: SubscriptionStore;
    resolveToken: AuthResolver;
    idempotency: IdempotencyStore;
    approvalPolicy?: ApprovalPolicy;
    pendingStore?: PendingOperationStore;
  },
): void => {
  const resolve = resolveAuth(opts.resolveToken);

  // GET /subscriptions — list active subscriptions
  app.get('/subscriptions', async (req, reply) => {
    let ctx;
    try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      const items = await opts.subscriptionStore.listSubscriptions(ctx.householdId, parsed.data.status);
      return reply.code(200).send({ items, total: items.length });
    } catch (e) { return handleError(e, reply); }
  });

  // POST /subscriptions — create a subscription
  app.post('/subscriptions', async (req, reply) => {
    let ctx;
    try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    const rawKey = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    if (opts.approvalPolicy && opts.pendingStore) {
      const pending = await createPendingApproval(opts.approvalPolicy, opts.pendingStore, {
        householdId: ctx.householdId,
        requesterId: ctx.deviceId,
        operation: 'subscription.create',
        payload: parsed.data,
        idempotencyKey: key ?? crypto.randomUUID(),
        amountCents: parsed.data.amountCents,
        destructive: false,
      });
      if (pending) return reply.code(pending.status).send(pending.body);
    }
    const fn = async (claimTx?: unknown) => {
      // V4.1 Phase 3 (UOW2): the subscription insert joins the claim tx
      // (canonical store; legacy has no InTx extension → plain fallback).
      const sub = await runSubscriptionMutation(opts.subscriptionStore, claimTx, ctx.householdId, 'create', parsed.data);
      return { status: 201 as const, body: attachMutationReceipt(sub, 'subscription.create', { type: 'subscription', id: sub.id }) };
    };
    try {
      const result = key
        ? await opts.idempotency.lookupOrRecord(ctx.householdId, key, httpIdempotencyPayload({ route: 'POST /subscriptions' }, parsed.data), fn)
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) { return handleError(e, reply); }
  });

  // POST /subscriptions/:id/cancel — cancel a subscription
  app.post('/subscriptions/:id/cancel', async (req, reply) => {
    let ctx;
    try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    try {
      const sub = await opts.subscriptionStore.cancelSubscription(ctx.householdId, params.data.id);
      return reply.code(200).send(attachMutationReceipt(sub, 'subscription.delete', { type: 'subscription', id: params.data.id }));
    } catch (e) { return handleError(e, reply); }
  });

  // PATCH /subscriptions/:id — update a subscription
  const updateSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    amountCents: z.number().int().positive().optional(),
    cycle: z.enum(['monthly', 'yearly', 'weekly']).optional(),
    day: z.number().int().min(1).max(31).optional(),
    paymentMethod: z.string().trim().min(1).max(60).optional(),
  }).refine((v) => v.name !== undefined || v.amountCents !== undefined || v.cycle !== undefined || v.day !== undefined || v.paymentMethod !== undefined, { message: 'nenhum campo para atualizar' });

  app.patch('/subscriptions/:id', async (req, reply) => {
    let ctx;
    try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    try {
      const sub = await opts.subscriptionStore.updateSubscription(ctx.householdId, params.data.id, parsed.data as Parameters<typeof opts.subscriptionStore.updateSubscription>[2]);
      return reply.code(200).send(attachMutationReceipt(sub, 'subscription.update', { type: 'subscription', id: params.data.id }));
    } catch (e) { return handleError(e, reply); }
  });
};
