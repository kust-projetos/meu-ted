import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import type { ReadModelStore } from '../read-models/store.js';
import type { WriteStore } from '../writes/store.js';
import type { CardStore } from '../cards/store.js';
import type { IdempotencyStore } from '../writes/idempotency.js';
import { createExpenseInputSchema, createIncomeInputSchema, createTransferInputSchema, updateTransactionInputSchema } from '../writes/types.js';
import type { CreateExpenseInput, CreateIncomeInput } from '../writes/types.js';
import { runTransactionMutation } from '../writes/keyed-mutations.js';
import { runCardMutation } from '../cards/keyed-mutations.js';
import { DomainError } from '../writes/errors.js';
import { mapPgError } from '../db/sqlstate.js';
import { requireIdempotencyKey, httpIdempotencyPayload } from '../writes/idempotency.js';
import { attachMutationReceipt } from '../reconciliation/effects-registry.js';
import type { AuthResolver } from './auth.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Origin-aware body for expense/income (item 10/B2).
 *
 * Cards and bank accounts share the same id space, but the client must name
 * the origin exactly once: `accountId` (Conta) XOR `cardId` (Cartão).
 * Both set (ambiguous origin) or neither set (missing origin) is a 422 —
 * a semantic error, not a malformed body (400).
 */
const originBodyExtension = {
  accountId: z.string().uuid().optional(),
  cardId: z.string().uuid().optional(),
};
const expenseOriginSchema = createExpenseInputSchema.extend(originBodyExtension).extend({
  accountId: z.string().uuid().optional(),
});
const incomeOriginSchema = createIncomeInputSchema.extend(originBodyExtension).extend({
  accountId: z.string().uuid().optional(),
});

type OriginResolution =
  | { ok: true; accountId: string; fromCard: boolean }
  | { ok: false; code: 'validation.origin_conflict' | 'validation.origin_required'; message: string };

const resolveOrigin = (body: { accountId?: string | undefined; cardId?: string | undefined }): OriginResolution => {
  const hasAccount = body.accountId !== undefined;
  const hasCard = body.cardId !== undefined;
  if (hasAccount && hasCard) {
    return { ok: false, code: 'validation.origin_conflict', message: 'informe conta OU cartão, nunca ambos' };
  }
  if (!hasAccount && !hasCard) {
    return { ok: false, code: 'validation.origin_required', message: 'informe a conta ou o cartão de origem' };
  }
  return { ok: true, accountId: (body.accountId ?? body.cardId) as string, fromCard: hasCard };
};

export const registerTransactionWriteRoutes = (
  app: FastifyInstance,
  opts: { store: ReadModelStore; writes: WriteStore; resolveToken: AuthResolver; idempotency: IdempotencyStore; cardStore?: CardStore },
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
    const mapped = mapPgError(err);
    if (mapped) return reply.code(mapped.statusCode).send({ code: mapped.code, message: mapped.message });
    throw err;
  };

  const runIdempotent = async <T>(
    req: import('fastify').FastifyRequest,
    householdId: string,
    identity: { route: string; resourceId?: string; origin?: string },
    payload: unknown,
    producer: (claimTx?: unknown) => Promise<T>,
  ): Promise<T> => {
    const raw = req.headers[IDEMPOTENCY_HEADER] ?? req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    if (raw === undefined) return producer(undefined);
    const key = requireIdempotencyKey(req.headers);
    if (!opts.idempotency) return producer(undefined);
    return (await opts.idempotency.lookupOrRecord(householdId, key, httpIdempotencyPayload(identity, payload), producer)).response;
  };
  const idemKey = (req: import('fastify').FastifyRequest): string | undefined => {
    const raw = req.headers[IDEMPOTENCY_HEADER] ?? req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    if (raw === undefined) return undefined;
    return requireIdempotencyKey(req.headers);
  };

  const postHandler = (path: string, schema: z.ZodTypeAny, producer: (ctx: { householdId: string }, input: any, claimTx?: unknown) => Promise<{ status: number; body: unknown }>) => {
    app.post(path, async (req, reply) => {
      let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
      const key = idemKey(req);
      const fn = async (claimTx?: unknown) => producer(ctx, parsed.data, claimTx);
      try {
        const result = key && opts.idempotency ? await opts.idempotency.lookupOrRecord(ctx.householdId, key, httpIdempotencyPayload({ route: `POST ${path}` }, parsed.data), fn) : { response: await fn(), replayed: false };
        if (result.replayed) reply.header('Idempotent-Replayed', 'true');
        return reply.code(result.response.status).send(result.response.body);
      } catch (e) { return handleError(e, reply); }
    });
  };

  const originPostHandler = (
    path: string,
    schema: typeof expenseOriginSchema | typeof incomeOriginSchema,
    strict: typeof createExpenseInputSchema | typeof createIncomeInputSchema,
    producer: (ctx: { householdId: string }, input: { accountId: string } & Record<string, unknown>, origin: Extract<OriginResolution, { ok: true }>, claimTx?: unknown) => Promise<{ status: number; body: unknown }>,
  ) => {
    app.post(path, async (req, reply) => {
      let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
      const origin = resolveOrigin(parsed.data);
      if (!origin.ok) return reply.code(422).send({ code: origin.code, message: origin.message });
      const { cardId: _cardId, ...rest } = parsed.data;
      const normalized = strict.safeParse({ ...rest, accountId: origin.accountId });
      if (!normalized.success) return reply.code(400).send({ code: 'validation.error', issues: normalized.error.issues });
      const key = idemKey(req);
      const fn = async (claimTx?: unknown) => producer(ctx, normalized.data as { accountId: string } & Record<string, unknown>, origin, claimTx);
      try {
        // Origin identity is captured BEFORE normalization from the
        // caller-provided key (cardId vs accountId + its value) so the same
        // raw key + cardId=X vs accountId=X (same UUID value) conflicts
        // instead of falsely replaying the normalized { accountId: X } body.
        const originIdentity = origin.fromCard
          ? `card:${String((parsed.data as { cardId?: unknown }).cardId ?? origin.accountId)}`
          : `account:${String((parsed.data as { accountId?: unknown }).accountId ?? origin.accountId)}`;
        const result = key && opts.idempotency ? await opts.idempotency.lookupOrRecord(ctx.householdId, key, httpIdempotencyPayload({ route: `POST ${path}`, origin: originIdentity }, normalized.data), fn) : { response: await fn(), replayed: false };
        if (result.replayed) reply.header('Idempotent-Replayed', 'true');
        return reply.code(result.response.status).send(result.response.body);
      } catch (e) { return handleError(e, reply); }
    });
  };

  originPostHandler('/transactions/expense', expenseOriginSchema, createExpenseInputSchema, async (ctx, input, origin, claimTx) => {
    // H-01: a card origin preserves the invoice path — a 1x purchase goes
    // through the CardStore (statement + card_purchases link), never through
    // the plain balance expense. Single-tx response shape is preserved.
    // V4.1 Phase 4 (fail-closed atomicity): the card purchase joins the open
    // idempotency claim tx via runCardMutation('purchase') — claim + effect +
    // completion commit together; a PG store without `createCardPurchaseInTx`
    // fails closed with `idempotency.atomic_mutation_not_supported` (never a
    // plain fallback that would commit outside the claim tx and lose the
    // crash gap).
    if (origin.fromCard) {
      if (!opts.cardStore) {
        throw new DomainError('unsupported', 'compras no cartão indisponíveis neste ambiente.', 503);
      }
      const txs = (await runCardMutation(opts.cardStore, claimTx, ctx.householdId, 'purchase', {
        accountId: origin.accountId,
        description: String(input['description'] ?? ''),
        amountCents: Number(input['amountCents']),
        date: String(input['date'] ?? ''),
        ...(input['categoryId'] ? { categoryId: String(input['categoryId']) } : {}),
        ...(input['subcategoryId'] ? { subcategoryId: String(input['subcategoryId']) } : {}),
        ...(input['notes'] ? { notes: String(input['notes']) } : {}),
      })) as import('../types/domain.js').Transaction[];
      const first = txs[0];
      if (!first) throw new DomainError('unsupported', 'compra no cartão não retornou lançamento.', 500);
      return { status: 201, body: attachMutationReceipt(first, 'transaction.create', { type: 'transaction', id: first.id }) };
    }
    const tx = await runTransactionMutation(opts.writes, claimTx, ctx.householdId, 'expense', input as unknown as CreateExpenseInput);
    return { status: 201, body: attachMutationReceipt(tx, 'transaction.create', { type: 'transaction', id: tx.id }) };
  });

  originPostHandler('/transactions/income', incomeOriginSchema, createIncomeInputSchema, async (ctx, input, origin, claimTx) => {
    // H-01: income on a card is rejected at the boundary (422).
    if (origin.fromCard) {
      return {
        status: 422,
        body: { code: 'validation.origin_card_income', message: 'receita não pode usar cartão de crédito.' },
      };
    }
    const tx = await runTransactionMutation(opts.writes, claimTx, ctx.householdId, 'income', input as unknown as CreateIncomeInput);
    return { status: 201, body: attachMutationReceipt(tx, 'transaction.create', { type: 'transaction', id: tx.id }) };
  });

  postHandler('/transfers', createTransferInputSchema, async (ctx, input, claimTx) => {
    const tx = await runTransactionMutation(opts.writes, claimTx, ctx.householdId, 'transfer', input);
    return { status: 201, body: attachMutationReceipt(tx, 'transfer.create', { type: 'transaction', id: tx.id }) };
  });

  app.patch('/transactions/:id', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    const parsed = updateTransactionInputSchema.safeParse(req.body ?? {});
    // V4.1 SPEC §9.7: unknown fields are a semantic contract violation
    // (422, like origin_conflict), not a malformed body (400).
    if (!parsed.success) {
      const unknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
      if (unknown) {
        return reply.code(422).send({
          code: 'validation.unknown_fields',
          message: 'campos não suportados no PATCH de lançamento.',
          issues: parsed.error.issues,
        });
      }
      return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    }
    try { return reply.code(200).send(await runIdempotent(req, ctx.householdId, { route: 'PATCH /transactions/:id', resourceId: params.data.id }, { id: params.data.id, ...parsed.data }, async (claimTx) => attachMutationReceipt(await runTransactionMutation(opts.writes, claimTx, ctx.householdId, 'update', { id: params.data.id, patch: parsed.data }), 'transaction.update', { type: 'transaction', id: params.data.id }))); }
    catch (e) { return handleError(e, reply); }
  });

  app.delete('/transactions/:id', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (e) { return handleError(e, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    try {
      // T3.2 (SPEC §15.1): 200 with the soft-deleted entity + a
      // registry-derived transaction.delete receipt. The receipt is built
      // inside the idempotent producer so replays preserve the mutationId;
      // 204 cannot carry a body. Second delete still 404s (tombstone kept).
      const deleted = await runIdempotent(req, ctx.householdId, { route: 'DELETE /transactions/:id', resourceId: params.data.id }, { id: params.data.id }, async (claimTx) =>
        attachMutationReceipt(await runTransactionMutation(opts.writes, claimTx, ctx.householdId, 'softDelete', { id: params.data.id }), 'transaction.delete', { type: 'transaction', id: params.data.id }),
      );
      return reply.code(200).send(deleted);
    }
    catch (e) { return handleError(e, reply); }
  });
};
