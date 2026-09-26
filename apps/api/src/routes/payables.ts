import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DEVICE_TOKEN_HEADER } from "../auth/device-token.js";
import type { PayableStore } from "../payables/store.js";
import { DomainError } from "../writes/errors.js";
import { mapPgError } from "../db/sqlstate.js";
import { requireIdempotencyKey, httpIdempotencyPayload, type IdempotencyStore } from "../writes/idempotency.js";
import type { AuthResolver } from "./auth.js";
import { isoDateSchema as isoDate } from "../shared/iso-date.js";
import { positiveMoneyCentsSchema } from "../shared/money.js";

const IDEMPOTENCY_HEADER = "idempotency-key";

const resolveAuth =
  (resolveToken: AuthResolver) => async (req: FastifyRequest) => {
    if (req.authenticatedContext) return req.authenticatedContext;
    const token = req.headers[DEVICE_TOKEN_HEADER];
    return resolveToken(Array.isArray(token) ? token[0] : token);
  };
const handleError = (err: unknown, reply: FastifyReply) => {
  if (err instanceof DomainError)
    return reply
      .code(err.statusCode)
      .send({ code: err.code, message: err.message });
  if ((err as { statusCode?: number }).statusCode) {
    const e = err as { statusCode: number; code: string; message: string };
    return reply.code(e.statusCode).send({ code: e.code, message: e.message });
  }
  const mapped = mapPgError(err);
  if (mapped) return reply.code(mapped.statusCode).send({ code: mapped.code, message: mapped.message });
  throw err;
};
const querySchema = z.object({
  status: z.enum(["pending", "paid", "overdue", "cancelled"]).optional(),
  type: z.enum(["one_time", "recurring"]).optional(),
  dueWithinDays: z.coerce.number().int().min(0).max(365).optional(),
});
const autoCreateQuery = z.object({
  daysAhead: z.coerce.number().int().min(0).max(90).default(30),
});


const createSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().trim().min(1).max(240),
  amountCents: positiveMoneyCentsSchema,
  dueDate: isoDate,
  type: z.enum(["one_time", "recurring"]).optional(),
  frequency: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  endDate: isoDate.optional(),
  reminderDaysBefore: z.number().int().min(0).max(30).optional(),
  notes: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  templateName: z.string().optional(),
});

const paySchema = z
  .object({
    paidDate: isoDate.optional(),
    prepayMonths: z.number().int().min(1).max(24).optional(),
  })
  // V4.1 Task 2.x (D3): payment always creates the expense transaction —
  // the createTransaction:false escape hatch is rejected, not ignored.
  .strict();

const unpaySchema = z
  .object({
    // V4.1 REVIEWFIX F2 (D4): the linked paidTransactionId is REQUIRED —
    // a caller that does not present it is rejected (4xx) instead of
    // reversing an unverified financial effect. A mismatch is 409.
    paidTransactionId: z.string().uuid(),
  })
  .strict();

const cancelSchema = z.object({ reason: z.string().optional() });

const templateSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).max(240),
  amountCents: positiveMoneyCentsSchema,
  frequency: z.enum(["monthly", "quarterly", "yearly"]),
  dayOfMonth: z.number().int().min(1).max(31),
  reminderDaysBefore: z.number().int().min(0).max(30).optional(),
  notes: z.string().optional(),
});

const fromTemplateSchema = z.object({
  templateId: z.string().uuid().optional(),
  templateName: z.string().optional(),
  dueDate: isoDate,
  amountOverrideCents: positiveMoneyCentsSchema.optional(),
});

const notificationSchema = z.object({
  chatId: z.string().min(1),
  notificationType: z.enum([
    "overdue_reminder",
    "due_today_reminder",
    "upcoming_reminder",
    "daily_summary",
    "weekly_summary",
  ]),
  enabled: z.boolean(),
  scheduleHour: z.number().int().min(0).max(23).optional(),
  scheduleMinute: z.number().int().min(0).max(59).optional(),
  scheduleWindowMinutes: z.number().int().min(1).max(1440).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  thresholdDays: z.number().int().min(0).max(90).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

export const payableQuerySchema = querySchema;
export const createPayableSchema = createSchema;
export const payPayableSchema = paySchema;
export const cancelPayableSchema = cancelSchema;
export const payableTemplateSchema = templateSchema;
export const payableFromTemplateSchema = fromTemplateSchema;
export { notificationSchema, autoCreateQuery };

import { createPendingApproval } from '../approvals/guard.js';
import type { ApprovalPolicy } from '../approvals/policy.js';
import type { PendingOperationStore } from '../approvals/pending.js';
import { attachMutationReceipt } from '../reconciliation/effects-registry.js';
import { runPayableMutation, runPayableBulkMutation } from '../payables/keyed-mutations.js';

export const registerPayableRoutes = (
  app: FastifyInstance,
  opts: {
    payableStore: PayableStore;
    resolveToken: AuthResolver;
    idempotency: IdempotencyStore;
    approvalPolicy?: ApprovalPolicy;
    pendingStore?: PendingOperationStore;
  },
): void => {
  const resolve = resolveAuth(opts.resolveToken);

  // GET /payables
  app.get("/payables", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const q = querySchema.safeParse(req.query);
    if (!q.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: q.error.issues });
    try {
      const f: { status?: string; type?: string; dueWithinDays?: number } = {};
      if (q.data.status) f.status = q.data.status;
      if (q.data.type) f.type = q.data.type;
      if (q.data.dueWithinDays !== undefined)
        f.dueWithinDays = q.data.dueWithinDays;
      const items = await opts.payableStore.listPayables(ctx.householdId, f);
      return reply.code(200).send({ items, total: items.length });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /payables
  app.post("/payables", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    const rawKey = req.headers[IDEMPOTENCY_HEADER] ?? req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    const fn = async (claimTx?: unknown) => {
      if (parsed.data.templateName) {
        // V4.1 Phase 3 (UOW2): the effect joins the idempotency claim tx.
        const p = await runPayableMutation(opts.payableStore, claimTx, ctx.householdId, 'createWithTemplate', {
          payable: {
            accountId: parsed.data.accountId,
            description: parsed.data.description,
            amountCents: parsed.data.amountCents,
            dueDate: parsed.data.dueDate,
            ...(parsed.data.type ? { type: parsed.data.type } : {}),
            ...(parsed.data.frequency ? { frequency: parsed.data.frequency } : {}),
            ...(parsed.data.endDate ? { endDate: parsed.data.endDate } : {}),
            ...(parsed.data.reminderDaysBefore !== undefined
              ? { reminderDaysBefore: parsed.data.reminderDaysBefore }
              : {}),
            ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
            ...(parsed.data.categoryId
              ? { categoryId: parsed.data.categoryId }
              : {}),
          },
          template: {
            accountId: parsed.data.accountId,
            name: parsed.data.templateName,
            description: parsed.data.description,
            amountCents: parsed.data.amountCents,
            frequency: parsed.data.frequency ?? "monthly",
            dayOfMonth: new Date(`${parsed.data.dueDate}T00:00:00`).getUTCDate(),
            ...(parsed.data.reminderDaysBefore !== undefined
              ? { reminderDaysBefore: parsed.data.reminderDaysBefore }
              : {}),
            ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
          },
        });
        return { status: 201 as const, body: attachMutationReceipt(p, 'payable.create', { type: 'payable', id: (p as { id: string }).id }) };
      }

      const payableInput = {
        accountId: parsed.data.accountId,
        description: parsed.data.description,
        amountCents: parsed.data.amountCents,
        dueDate: parsed.data.dueDate,
        ...(parsed.data.type ? { type: parsed.data.type } : {}),
        ...(parsed.data.frequency ? { frequency: parsed.data.frequency } : {}),
        ...(parsed.data.endDate ? { endDate: parsed.data.endDate } : {}),
        ...(parsed.data.reminderDaysBefore !== undefined
          ? { reminderDaysBefore: parsed.data.reminderDaysBefore }
          : {}),
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.categoryId
          ? { categoryId: parsed.data.categoryId }
          : {}),
      };
      const p = await runPayableMutation(opts.payableStore, claimTx, ctx.householdId, 'create', payableInput);
      return { status: 201 as const, body: attachMutationReceipt(p, 'payable.create', { type: 'payable', id: p.id }) };
    };

    try {
      const result = key
        ? await opts.idempotency.lookupOrRecord(
            ctx.householdId,
            key,
            httpIdempotencyPayload({ route: 'POST /payables' }, parsed.data),
            fn,
          )
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /payables/:id/pay
  app.post("/payables/:id/pay", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: params.error.issues });
    const parsed = paySchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    const rawKeyPay = req.headers[IDEMPOTENCY_HEADER] ?? req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKeyPay !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    const fn = async (claimTx?: unknown) => {
      // V4.1 Phase 3 (UOW2): the pay effect joins the idempotency claim tx —
      // lock, guards, payment transaction and payable update commit together.
      const p = await runPayableMutation(opts.payableStore, claimTx, ctx.householdId, 'pay', {
        id: params.data.id,
        input: {
          ...(parsed.data.paidDate ? { paidDate: parsed.data.paidDate } : {}),
          ...(parsed.data.prepayMonths !== undefined
            ? { prepayMonths: parsed.data.prepayMonths }
            : {}),
        },
      });
      return { status: 200 as const, body: attachMutationReceipt(p, 'payable.pay', { type: 'payable', id: params.data.id }) };
    };
    try {
      const result = key
        ? await opts.idempotency.lookupOrRecord(
            ctx.householdId,
            key,
            // Finding 1: the hashed payload embeds the route resource id —
            // same key+body on a different payable id must conflict, not replay.
            httpIdempotencyPayload({ route: 'POST /payables/:id/pay', resourceId: params.data.id }, { id: params.data.id, ...parsed.data }),
            fn,
          )
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /payables/:id/unpay — undo payment
  app.post("/payables/:id/unpay", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: params.error.issues });
    const parsedUnpay = unpaySchema.safeParse(req.body ?? {});
    if (!parsedUnpay.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsedUnpay.error.issues });
    try {
      const p = await opts.payableStore.undoPayablePayment(
        ctx.householdId,
        params.data.id,
        { expectedPaidTransactionId: parsedUnpay.data.paidTransactionId },
      );
      return reply.code(200).send(attachMutationReceipt(p, 'payable.payment.undo', { type: 'payable', id: params.data.id }));
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // PATCH /payables/:id — update editable fields
  const updateSchema = z.object({
    description: z.string().trim().min(1).max(120).optional(),
    amountCents: positiveMoneyCentsSchema.optional(),
    dueDate: isoDate
      .optional(),
    accountId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
  });

  app.patch("/payables/:id", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: params.error.issues });
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    const rawKey = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    if (opts.approvalPolicy && opts.pendingStore) {
      const pending = await createPendingApproval(opts.approvalPolicy, opts.pendingStore, {
        householdId: ctx.householdId,
        requesterId: ctx.deviceId,
        operation: 'payable.update',
        payload: { id: params.data.id, ...parsed.data },
        idempotencyKey: key ?? crypto.randomUUID(),
        ...(parsed.data.amountCents !== undefined ? { amountCents: parsed.data.amountCents } : {}),
        destructive: false,
      });
      if (pending) return reply.code(pending.status).send(pending.body);
    }
    // V4.1 Phase 3 (UOW2): keyed PATCH joins the idempotency claim tx like
    // every other keyed mutation (replay returns the original receipt).
    const fn = async (claimTx?: unknown) => {
      const p = await runPayableMutation(opts.payableStore, claimTx, ctx.householdId, 'update', {
        id: params.data.id,
        patch: parsed.data,
      });
      return { status: 200 as const, body: attachMutationReceipt(p, 'payable.update', { type: 'payable', id: params.data.id }) };
    };
    try {
      const result = key
        ? await opts.idempotency.lookupOrRecord(
            ctx.householdId,
            key,
            httpIdempotencyPayload({ route: 'PATCH /payables/:id', resourceId: params.data.id }, { id: params.data.id, ...parsed.data }),
            fn,
          )
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /payables/:id/cancel
  app.post("/payables/:id/cancel", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: params.error.issues });
    const parsed = cancelSchema.safeParse(req.body ?? {});
    try {
      const p = await opts.payableStore.cancelPayable(
        ctx.householdId,
        params.data.id,
        parsed.data?.reason,
      );
      return reply.code(200).send(attachMutationReceipt(p, 'payable.delete', { type: 'payable', id: params.data.id }));
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /payables/refresh-status
  app.post("/payables/refresh-status", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    let key: string;
    try {
      key = requireIdempotencyKey(req.headers);
    } catch (e) {
      return handleError(e, reply);
    }
    const fn = async (claimTx?: unknown) => {
      // V4.1 DEBT-CODER-BULKTX: the whole recompute joins the claim tx, so a
      // keyed retry never leaves a torn bulk effect behind.
      const updated = await runPayableBulkMutation(opts.payableStore, claimTx, ctx.householdId, 'refresh', {});
      // FIX-P1 (SPEC §15.1): bulk status recompute mutates payable effects →
      // payable.update receipt, built inside the idempotent producer so keyed
      // replays preserve the mutationId. No single entity: bulk result.
      // The key is mandatory: missing/blank returns 400 via handleError.
      return { status: 200 as const, body: attachMutationReceipt({ updated, updatedCount: updated.length }, 'payable.update') };
    };
    try {
      const result = await opts.idempotency.lookupOrRecord(
        ctx.householdId,
        key,
        httpIdempotencyPayload({ route: 'POST /payables/refresh-status' }, req.query ?? {}),
        fn,
      );
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /payables/auto-create-from-templates
  app.post("/payables/auto-create-from-templates", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = autoCreateQuery.safeParse(req.query ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    let key: string;
    try {
      key = requireIdempotencyKey(req.headers);
    } catch (e) {
      return handleError(e, reply);
    }
    const fn = async (claimTx?: unknown) => {
      // V4.1 DEBT-CODER-BULKTX: every row of the batch joins the claim tx —
      // claim + all rows + completion commit atomically (all-or-nothing).
      const created = await runPayableBulkMutation(opts.payableStore, claimTx, ctx.householdId, 'autoCreate', {
        daysAhead: parsed.data.daysAhead,
      });
      // FIX-P1 (SPEC §15.1): bulk payable creation → payable.create receipt,
      // built inside the idempotent producer so keyed replays preserve the
      // mutationId. Bulk result carries no single entity.
      // The key is mandatory: missing/blank returns 400 via handleError.
      return { status: 201 as const, body: attachMutationReceipt({ created, createdCount: created.length }, 'payable.create') };
    };
    try {
      const result = await opts.idempotency.lookupOrRecord(
        ctx.householdId,
        key,
        httpIdempotencyPayload({ route: 'POST /payables/auto-create-from-templates' }, parsed.data),
        fn,
      );
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) {
      return handleError(e, reply);
    }
  });

  app.get("/payables/templates", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    try {
      const items = await opts.payableStore.listTemplates(ctx.householdId);
      return reply.code(200).send({ items, total: items.length });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /payables/templates
  app.post("/payables/templates", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = templateSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    const rawKey = req.headers[IDEMPOTENCY_HEADER] ?? req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = rawKey !== undefined ? requireIdempotencyKey(req.headers) : undefined;
    const fn = async (claimTx?: unknown) => {
      // V4.1 Phase 3 (UOW2): the template insert joins the claim tx.
      const t = await runPayableMutation(opts.payableStore, claimTx, ctx.householdId, 'createTemplate', {
        accountId: parsed.data.accountId,
        name: parsed.data.name,
        description: parsed.data.description,
        amountCents: parsed.data.amountCents,
        frequency: parsed.data.frequency,
        dayOfMonth: parsed.data.dayOfMonth,
        ...(parsed.data.reminderDaysBefore !== undefined
          ? { reminderDaysBefore: parsed.data.reminderDaysBefore }
          : {}),
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      });
      // FIX-P1 (SPEC §15.1): a new template feeds future payables in the
      // payables domain → payable.create receipt, built inside the idempotent
      // producer so keyed replays preserve the mutationId.
      return { status: 201 as const, body: attachMutationReceipt(t, 'payable.create', { type: 'payable-template', id: t.id }) };
    };
    try {
      const result = key
        ? await opts.idempotency.lookupOrRecord(
            ctx.householdId,
            key,
            httpIdempotencyPayload({ route: 'POST /payables/templates' }, parsed.data),
            fn,
          )
        : { response: await fn(), replayed: false };
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /payables/from-template
  app.post("/payables/from-template", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = fromTemplateSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    let key: string;
    try {
      key = requireIdempotencyKey(req.headers);
    } catch (e) {
      return handleError(e, reply);
    }
    const fn = async (claimTx?: unknown) => {
      // V4.1 Phase 3 (UOW2): template lookup + payable insert join the claim tx.
      const p = await runPayableMutation(opts.payableStore, claimTx, ctx.householdId, 'fromTemplate',
        {
          dueDate: parsed.data.dueDate,
          ...(parsed.data.templateId
            ? { templateId: parsed.data.templateId }
            : {}),
          ...(parsed.data.templateName
            ? { templateName: parsed.data.templateName }
            : {}),
          ...(parsed.data.amountOverrideCents !== undefined
            ? { amountOverrideCents: parsed.data.amountOverrideCents }
            : {}),
        },
      );
      // FIX-P1 (SPEC §15.1): instantiating a payable from a template creates
      // a payable → payable.create receipt, built inside the idempotent
      // producer so keyed replays preserve the mutationId.
      // The key is mandatory: missing/blank returns 400 via handleError.
      return { status: 201 as const, body: attachMutationReceipt(p, 'payable.create', { type: 'payable', id: p.id }) };
    };
    try {
      const result = await opts.idempotency.lookupOrRecord(
        ctx.householdId,
        key,
        httpIdempotencyPayload({ route: 'POST /payables/from-template' }, parsed.data),
        fn,
      );
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(result.response.status).send(result.response.body);
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // GET /payables/reminders
  app.get("/payables/reminders", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    try {
      const items = await opts.payableStore.listReminders(ctx.householdId);
      return reply.code(200).send({ items, total: items.length });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // GET /notifications
  app.get("/notifications", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    try {
      const items = await opts.payableStore.listNotifications(ctx.householdId);
      return reply.code(200).send({ items, total: items.length });
    } catch (e) {
      return handleError(e, reply);
    }
  });

  // POST /notifications
  app.post("/notifications", async (req, reply) => {
    let ctx: Awaited<ReturnType<typeof resolve>>;
    try {
      ctx = await resolve(req);
    } catch (e) {
      return handleError(e, reply);
    }
    const parsed = notificationSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: "validation.error", issues: parsed.error.issues });
    try {
      const n = await opts.payableStore.configureNotification(ctx.householdId, {
        chatId: parsed.data.chatId,
        notificationType: parsed.data.notificationType,
        enabled: parsed.data.enabled,
        ...(parsed.data.scheduleHour !== undefined
          ? { scheduleHour: parsed.data.scheduleHour }
          : {}),
        ...(parsed.data.scheduleMinute !== undefined
          ? { scheduleMinute: parsed.data.scheduleMinute }
          : {}),
        ...(parsed.data.scheduleWindowMinutes !== undefined
          ? { scheduleWindowMinutes: parsed.data.scheduleWindowMinutes }
          : {}),
        ...(parsed.data.daysOfWeek
          ? { daysOfWeek: parsed.data.daysOfWeek }
          : {}),
        ...(parsed.data.thresholdDays !== undefined
          ? { thresholdDays: parsed.data.thresholdDays }
          : {}),
        ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
      });
      // FIX-P1 (SPEC §15.1): notification configuration is a supported write
      // owned by the payables domain (reminders feed off payables) → a normal
      // payable.update receipt, never a PendingOperation (no operationId).
      return reply.code(201).send(attachMutationReceipt(n, 'payable.update', { type: 'notification', id: n.id }));
    } catch (e) {
      return handleError(e, reply);
    }
  });
};
