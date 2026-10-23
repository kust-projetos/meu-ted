import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import type { AuthResolver } from './auth.js';
import { DomainError, domainErrors } from '../writes/errors.js';
import { requireIdempotencyKey } from '../writes/idempotency.js';
import { computePendingOperationV2Hash, isActionablePendingOperationPresentation, mutationReceiptSchema, pendingOperationOutcomeSchema, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import { getApprovalToolContract, validateApprovalToolArgs, type ApprovalToolId } from '../approvals/tool-registry.js';
import { buildPendingOperationPresentation } from '../approvals/presentation.js';
import { buildTedReceipt } from '../reconciliation/effects-registry.js';
import type { ReadModelStore } from '../read-models/store.js';
import { PendingOperationV2Error, PENDING_V2_MAX_TTL_MS, type PendingExecutor, type PendingOperationExecutor, type PendingOperationStore, type PendingOperationV2Store } from '../approvals/pending.js';
import type { UndoService } from '../approvals/undo.js';
import { createApprovalPolicy, type ApprovalPolicy } from '../approvals/policy.js';
import { getTedRiskBasedAutoexecute } from '../approvals/authorization-config.js';
import { buildObservabilityEvent } from '../audit/events.js';

// PR-1 (retire-pending-v1): the V1 routes that consumed this identity are
// retired, but the schema stays exported — the OpenAPI agent-tools contract
// still lists the retired V1 tools until the agent regen follow-up, and
// `tests/contract/agent-tools-authoritative-all.test.ts` validates it.
export const pendingIdentitySchema = z.object({
  pendingOperationId: z.string().uuid().optional(),
  chatId: z.string().trim().min(1).max(240).optional(),
}).refine((value) => Boolean(value.pendingOperationId) !== Boolean(value.chatId), {
  message: 'pendingOperationId or chatId is required, but not both',
  path: ['pendingOperationId'],
});

export const V2_APPROVAL_CAPABILITIES = {
  propose: 'financial.approval.propose',
  read: 'financial.approval.read',
  confirm: 'financial.approval.confirm',
  execute: 'financial.approval.execute',
  reconcile: 'financial.approval.reconcile',
  retry: 'financial.approval.retry',
  cancel: 'financial.approval.cancel',
  authorize: 'financial.approval.autoexecute',
} as const;

export const registerPendingOperationRoutes = (app: FastifyInstance, opts: { store?: PendingOperationStore; resolveToken: AuthResolver; executor?: PendingOperationExecutor; undoService?: UndoService; v2Store?: PendingOperationV2Store; v2Executor?: PendingExecutor; v2Only?: boolean; readModel?: Pick<ReadModelStore, 'listAccounts' | 'listCategories'> & Partial<Pick<ReadModelStore, 'listAllTransactions'>>; approvalPolicy?: ApprovalPolicy }): void => {
  // PR-1 (retire-pending-v1): the registration is unconditionally V2-only.
  // `store`, `executor` and `v2Only` are deprecated no-ops retained so
  // existing call sites keep compiling; the V1 routes are gone, so these
  // opts have no effect. Full removal is a follow-up with the agent
  // OpenAPI regen (the contract still lists the retired V1 tools).
  const { resolveToken, undoService, v2Store, v2Executor } = opts;
  const approvalPolicy = opts.approvalPolicy ?? createApprovalPolicy();
  const resolve = async (req: import('fastify').FastifyRequest): Promise<{ householdId: string; actorId: string; deviceId: string }> => {
    if (req.authenticatedContext) return req.authenticatedContext;
    const token = req.headers[DEVICE_TOKEN_HEADER];
    const resolved = await resolveToken(Array.isArray(token) ? token[0] : token);
    return { ...resolved, actorId: resolved.deviceId };
  };
  const handleError = (error: unknown, reply: import('fastify').FastifyReply, forbiddenOnMissing = false) => {
    if (error instanceof DomainError) {
      if (forbiddenOnMissing && error.code === 'approval.not_found') {
        return reply.code(403).send({ code: 'approval.forbidden', message: 'Operação pendente fora do workspace do ator.' });
      }
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (error instanceof PendingOperationV2Error) {
      // forbiddenOnMissing applies to V2 errors too: the V2 store raises
      // approval.not_found as PendingOperationV2Error (404), and scoped
      // routes (get/confirm/execute/reconcile/...) must answer a foreign
      // or unknown id with 403 — never a 404 existence leak.
      if (forbiddenOnMissing && (error.code === 'approval.not_found' || error.code === 'approval.binding_mismatch')) {
        return reply.code(403).send({ code: 'approval.forbidden', message: 'Operação pendente fora do workspace do ator.' });
      }
      const body: Record<string, unknown> = { code: error.code, message: error.message };
      if (error.details !== undefined) body.details = error.details;
      return reply.code(error.statusCode).send(body);
    }
    throw error;
  };

  // V2 authoritative proposal/confirmation surface. Identity is always taken
  // from authenticatedContext; body fields cannot select workspace/actor/device.
  if (v2Store) {
    const identity = (ctx: { householdId: string; actorId: string; deviceId: string }) => ({ workspaceId: ctx.householdId, actorId: ctx.actorId, deviceId: ctx.deviceId });
    const idSchema = z.object({ id: z.string().uuid() });
    const requireV2Capability = (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, capability: string): boolean => {
      if (!req.delegatedTurn || !req.delegatedTurn.capabilities.includes(capability)) {
        reply.code(403).send({ code: 'auth.delegation_scope_forbidden', message: 'Capability de approval delegada obrigatória.' });
        return false;
      }
      return true;
    };
    // FIX-API-ACTIONABLE-PRESENTATION-GATE (plan item 4, all channels): a
    // `proposed` Confirm and a `failed` Retry execute only when a
    // server-derived presentation is actionable. The presentation is rebuilt
    // here from the STORED hash-bound normalizedArgs (same resolved
    // workspace+actor/device identity that the store will check) plus the
    // CURRENT server read-model labels via buildPendingOperationPresentation,
    // and must satisfy the shared isActionablePendingOperationPresentation
    // predicate. No client-supplied `presentation` is read — confirm/retry
    // take no body — and block responses carry no attestation/proposal
    // authority material. On block: no store call, no attestation, no
    // status transition (409 approval.not_actionable for an absent/
    // unactionable projection; 503 approval.presentation_unavailable when
    // the read model itself fails, never echoing driver text).
    //
    // TOCTOU bound: the label lookup runs outside the store's row lock, so
    // labels may change between this check and the confirm/retry commit.
    // What stays immutable is what executes: the store still enforces its
    // atomic status/hash/binding check under lock (FOR UPDATE), and the
    // financial args are the persisted hash-bound normalizedArgs — the gate
    // proves the operation WAS displayable with full context at check time,
    // never that a human actually viewed the card.
    const requireActionablePresentation = async (
      id: string,
      ctx: { householdId: string; actorId: string; deviceId: string },
      expectedStatus: 'proposed' | 'failed',
      reply: import('fastify').FastifyReply,
    ): Promise<boolean> => {
      let record;
      try {
        record = await v2Store.get(id, identity(ctx));
      } catch (error) {
        // Same identity/household semantics as the store call itself: a
        // foreign or unknown id maps to 403 via forbiddenOnMissing (no
        // existence leak), never to a gate error.
        handleError(error, reply, true);
        return false;
      }
      // Recovery/idempotent paths bypass the fresh-display gate: an already
      // `confirmed` confirm re-emits attestation (§9/H-03 recovery even when
      // the display projection is gone); any other non-expected status
      // delegates to the store for its authoritative transition error
      // (expired/not_pending/retry_not_allowed). Only the first
      // proposed→confirm and failed→retry transitions require actionability.
      // `executing`/`succeeded`/reconciliation are never gated here.
      if (record.status !== expectedStatus) return true;
      if (!opts.readModel) {
        reply.code(409).send({ code: 'approval.not_actionable', message: 'Operação sem apresentação acionável para confirmação.' });
        return false;
      }
      let accounts: Array<{ id: string; name: string }>;
       let categories: Array<{ id: string; name: string; kind?: string; parentId?: string | null }>;
       let transactionTarget: { id:string; amountCents:number; date:string; accountId:string; accountName:string } | undefined;
      try {
        [accounts, categories] = await Promise.all([
          opts.readModel.listAccounts(ctx.householdId),
          opts.readModel.listCategories(ctx.householdId),
        ]);
      } catch {
        // Safe retryable server error: no driver text, no transition.
        reply.code(503).send({ code: 'approval.presentation_unavailable', message: 'Dados de apresentação indisponíveis no momento.' });
        return false;
      }
      const accountLabels = new Map(accounts.map((account) => [account.id, account.name]));
      const categoryLabels = new Map(categories.map((category) => [category.id, category.name]));
      const storedArgs = (record.normalizedArgs ?? {}) as Record<string, unknown>;
      const accountId = typeof storedArgs.accountId === 'string' ? storedArgs.accountId : undefined;
       const categoryId = typeof storedArgs.categoryId === 'string' ? storedArgs.categoryId : undefined;
       const categoryTarget = categoryId !== undefined ? categories.find((category) => category.id === categoryId) : undefined;
       const categoryParent = categoryTarget?.parentId ? categories.find((category) => category.id === categoryTarget.parentId) : undefined;
      // categories.create names its parent `parentId` (not `categoryId`):
      // resolve the same display label map so the card shows the real parent.
      const categoryParentId = record.tool === 'categories.create' && typeof storedArgs.parentId === 'string' ? storedArgs.parentId : undefined;
      const accountLabel = accountId !== undefined ? accountLabels.get(accountId) : undefined;
       const categoryLabel = categoryId !== undefined ? categoryLabels.get(categoryId) : categoryParentId !== undefined ? categoryLabels.get(categoryParentId) : undefined;
       if (record.tool === 'transactions.update') {
         const transactionId = typeof storedArgs.transactionId === 'string' ? storedArgs.transactionId : '';
         const expectedDescription = typeof storedArgs.expectedDescription === 'string' ? storedArgs.expectedDescription : '';
         if (!opts.readModel.listAllTransactions) {
           reply.code(503).send({ code:'approval.presentation_unavailable', message:'Dados de apresentação indisponíveis no momento.' });
           return false;
         }
         try {
           const target = (await opts.readModel.listAllTransactions(ctx.householdId)).find((row)=>row.id===transactionId && row.description===expectedDescription && (row.kind==='expense'||row.kind==='income'));
           const accountName = target ? accountLabels.get(target.accountId) : undefined;
           if (target && accountName) transactionTarget={id:target.id,amountCents:target.amountCents,date:target.date,accountId:target.accountId,accountName};
         } catch {
           reply.code(503).send({ code:'approval.presentation_unavailable', message:'Dados de apresentação indisponíveis no momento.' });
           return false;
         }
       }
      const labelWarnings: string[] = [];
      if (accountId !== undefined && accountLabel === undefined) {
        labelWarnings.push('Dados da conta indisponíveis no momento');
      }
      if (categoryId !== undefined && categoryLabel === undefined) {
        labelWarnings.push('Dados da categoria indisponíveis no momento');
      }
      if (categoryParentId !== undefined && categoryLabel === undefined) {
        labelWarnings.push('Dados da categoria indisponíveis no momento');
      }
      const presentation = buildPendingOperationPresentation({
        id: record.id,
        status: record.status,
        tool: record.tool,
        normalizedArgs: record.normalizedArgs,
        expiresAt: record.expiresAt,
        ...(accountLabel !== undefined ? { accountLabel } : {}),
         ...(categoryLabel !== undefined ? { categoryLabel } : {}),
         ...(transactionTarget ? { transactionTarget } : {}),
         ...(record.tool === 'categories.deactivate' && categoryTarget?.kind ? { categoryKind: categoryTarget.kind } : {}),
         ...(record.tool === 'categories.deactivate' && categoryParent ? { categoryParentLabel: { id: categoryParent.id, name: categoryParent.name } } : {}),
        ...(labelWarnings.length > 0 ? { warnings: labelWarnings } : {}),
      });
      if (!presentation || !isActionablePendingOperationPresentation(presentation)) {
        reply.code(409).send({ code: 'approval.not_actionable', message: 'Operação sem apresentação acionável para confirmação.' });
        return false;
      }
      return true;
    };
    const proposeV2 = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.propose)) return;
      let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
      try {
        const key = requireIdempotencyKey(req.headers as Record<string, unknown>);
        const body = z.object({ tool: z.string().min(1), normalizedArgs: z.record(z.unknown()), expiresAt: z.string().datetime({ offset: true }).optional() }).strict().safeParse(req.body ?? {});
        if (!body.success) return reply.code(400).send({ code: 'validation.error', issues: body.error.issues });
        // SPEC §7.4: validate against the registry contract for the requested
        // tool BEFORE persisting (the store re-validates as defense-in-depth).
        const checked = validateApprovalToolArgs(body.data.tool, body.data.normalizedArgs);
        if (!checked.success && checked.code === 'tool.not_allowed') return reply.code(403).send({ code: 'tool.not_allowed', message: 'Ferramenta não permitida no protocolo de aprovação.' });
        if (!checked.success) return reply.code(422).send({ code: 'approval.invalid_args', message: 'Argumentos inválidos para a ferramenta de aprovação.', details: checked.issues });
        // ADR-029 rename gate: replay-first + mutable target/name validation.
        // Same key + same proposal hash returns the EXISTING record before
        // any mutable read (a post-rename retry replays instead of failing
        // on the stale expectedName); only a genuinely new proposal runs the
        // mutable checks (target active bank/cash, current name exact).
        if (body.data.tool === 'accounts.update') {
          const draftHash = await computePendingOperationV2Hash({
            tool: body.data.tool,
            normalizedArgs: checked.data as PendingOperationV2['normalizedArgs'],
            workspaceId: ctx.householdId,
            actorId: ctx.actorId,
            deviceId: ctx.deviceId,
          });
          const replay = await v2Store.findByIdempotencyKey(ctx.householdId, key);
          if (replay) {
            if (replay.proposalHash !== draftHash) {
              return reply.code(409).send({ code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' });
            }
            const existingRecord = await v2Store.get(replay.id, identity(ctx));
            return reply.code(200).send({ ...existingRecord, existing: true });
          }
          // Round rename-2: replay race — esta tentativa observou chave
          // ausente, mas um vencedor pode ter commitado a MESMA proposta
          // antes da validação mutável. Antes de responder o erro mutável,
          // re-consulta: vencedor com mesmo hash → replay (via get, com
          // binding de identidade — nunca replay de outro ator); hash
          // divergente → conflict; sem vencedor → o erro original.
          const replayAfterMutableError = async () => {
            const winner = await v2Store.findByIdempotencyKey(ctx.householdId, key);
            if (!winner) return null;
            if (winner.proposalHash !== draftHash) {
              return { status: 409 as const, body: { code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' } };
            }
            const winnerRecord = await v2Store.get(winner.id, identity(ctx));
            return { status: 200 as const, body: { ...winnerRecord, existing: true } };
          };
          // New proposal: validate the rename preconditions against the
          // CURRENT read model before persisting (the executor re-checks
          // atomically under row lock — this gate only fails fast).
          // Without a read model the route cannot validate: the atomic
          // executor check remains the authority (fail-closed at execute).
          if (opts.readModel) {
            const renameArgs = checked.data as { accountId: string; name: string; expectedName: string };
            const targets = await opts.readModel.listAccounts(ctx.householdId);
            // The read model serves active bank/cash only (cards live in the
            // CardStore, inactive are filtered): absence uniformly means
            // "not renameable here" — no existence oracle beyond that.
            const target = targets.find((account) => account.id === renameArgs.accountId);
            // Round rename-2: replay race — re-consulta a chave antes de
            // responder o erro mutável (detalhes no bloco replayAfterMutableError).
            if (!target) {
              const late = await replayAfterMutableError();
              if (late) return reply.code(late.status).send(late.body);
              return reply.code(404).send({ code: 'not_found', message: 'Conta não encontrada.' });
            }
            if (target.name !== renameArgs.expectedName) {
              const late = await replayAfterMutableError();
              if (late) return reply.code(late.status).send(late.body);
              return reply.code(409).send({ code: 'account.name_conflict', message: 'Nome atual da conta divergiu do esperado; outra renomeação venceu.' });
            }
          }
        }
        // categories.create parent gate (R7-F6): replay-first + hash-bound
        // auth BEFORE the mutable check, parity with `accounts.update`
        // above. Same key + same proposal hash returns the EXISTING record
        // before any mutable read (a post-propose retry replays instead of
        // failing on a parent that left the read model); only a genuinely
        // new proposal runs the mutable checks (parent exists + kind match).
        if (body.data.tool === 'categories.create') {
          const draftHash = await computePendingOperationV2Hash({
            tool: body.data.tool,
            normalizedArgs: checked.data as PendingOperationV2['normalizedArgs'],
            workspaceId: ctx.householdId,
            actorId: ctx.actorId,
            deviceId: ctx.deviceId,
          });
          const replay = await v2Store.findByIdempotencyKey(ctx.householdId, key);
          if (replay) {
            if (replay.proposalHash !== draftHash) {
              return reply.code(409).send({ code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' });
            }
            const existingRecord = await v2Store.get(replay.id, identity(ctx));
            return reply.code(200).send({ ...existingRecord, existing: true });
          }
          // Replay race: esta tentativa observou chave ausente, mas um
          // vencedor pode ter commitado a MESMA proposta antes da validação
          // mutável. Antes de responder o erro mutável, re-consulta:
          // vencedor com mesmo hash → replay (via get, com binding de
          // identidade — nunca replay de outro ator); hash divergente →
          // conflict; sem vencedor → o erro original.
          const replayAfterMutableError = async () => {
            const winner = await v2Store.findByIdempotencyKey(ctx.householdId, key);
            if (!winner) return null;
            if (winner.proposalHash !== draftHash) {
              return { status: 409 as const, body: { code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' } };
            }
            const winnerRecord = await v2Store.get(winner.id, identity(ctx));
            return { status: 200 as const, body: { ...winnerRecord, existing: true } };
          };
          // Fail fast on unknown parent or kind mismatch using the CURRENT
          // read model. Without a read model the atomic writer check remains
          // the authority (fail-closed at execute). Unknown parent maps to
          // 404 (no existence oracle beyond "not creatable here"); kind
          // mismatch maps to 422.
          if (opts.readModel) {
            const categoryArgs = checked.data as { name: string; kind: 'expense' | 'income'; parentId?: string };
            if (categoryArgs.parentId !== undefined) {
              const categories = await opts.readModel.listCategories(ctx.householdId);
              const parent = categories.find((category) => category.id === categoryArgs.parentId);
              if (!parent) {
                const late = await replayAfterMutableError();
                if (late) return reply.code(late.status).send(late.body);
                return reply.code(404).send({ code: 'not_found', message: 'Categoria pai não encontrada.' });
              }
              const parentKind = (parent as { kind?: unknown }).kind;
              if (parentKind !== categoryArgs.kind) {
                const late = await replayAfterMutableError();
                if (late) return reply.code(late.status).send(late.body);
                return reply.code(422).send({ code: 'approval.invalid_args', message: 'Categoria pai de tipo diferente.', details: [] });
              }
            }
          }
        }
        // categories.update (name-only) rename gate: replay-first + hash-bound
        // auth BEFORE the mutable check, parity with `accounts.update` above.
        // Same key + same proposal hash returns the EXISTING record before
        // any mutable read (a post-rename retry replays instead of failing
        // on the stale expectedName); only a genuinely new proposal runs the
        // mutable checks (target is a category of THIS workspace, current
        // name exact).
        if (body.data.tool === 'categories.update') {
          const draftHash = await computePendingOperationV2Hash({
            tool: body.data.tool,
            normalizedArgs: checked.data as PendingOperationV2['normalizedArgs'],
            workspaceId: ctx.householdId,
            actorId: ctx.actorId,
            deviceId: ctx.deviceId,
          });
          const replay = await v2Store.findByIdempotencyKey(ctx.householdId, key);
          if (replay) {
            if (replay.proposalHash !== draftHash) {
              return reply.code(409).send({ code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' });
            }
            const existingRecord = await v2Store.get(replay.id, identity(ctx));
            return reply.code(200).send({ ...existingRecord, existing: true });
          }
          // Replay race: esta tentativa observou chave ausente, mas um
          // vencedor pode ter commitado a MESMA proposta antes da validação
          // mutável. Antes de responder o erro mutável, re-consulta:
          // vencedor com mesmo hash → replay (via get, com binding de
          // identidade — nunca replay de outro ator); hash divergente →
          // conflict; sem vencedor → o erro original.
          const replayAfterMutableError = async () => {
            const winner = await v2Store.findByIdempotencyKey(ctx.householdId, key);
            if (!winner) return null;
            if (winner.proposalHash !== draftHash) {
              return { status: 409 as const, body: { code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' } };
            }
            const winnerRecord = await v2Store.get(winner.id, identity(ctx));
            return { status: 200 as const, body: { ...winnerRecord, existing: true } };
          };
          // New proposal: validate the rename preconditions against the
          // CURRENT read model before persisting (the executor re-checks
          // atomically under row lock — this gate only fails fast).
          // Without a read model the route cannot validate: the atomic
          // executor check remains the authority (fail-closed at execute).
          if (opts.readModel) {
            const renameArgs = checked.data as { categoryId: string; name: string; expectedName: string };
            // The read model serves THIS household's categories only: an
            // unknown id, another workspace's id, or a non-category id is
            // uniformly "not renameable here" — no existence oracle.
            const categories = await opts.readModel.listCategories(ctx.householdId);
            const target = categories.find((category) => category.id === renameArgs.categoryId);
            if (!target) {
              const late = await replayAfterMutableError();
              if (late) return reply.code(late.status).send(late.body);
              return reply.code(404).send({ code: 'not_found', message: 'Categoria não encontrada.' });
            }
            if (target.name !== renameArgs.expectedName) {
              const late = await replayAfterMutableError();
              if (late) return reply.code(late.status).send(late.body);
              return reply.code(409).send({ code: 'category.name_conflict', message: 'Nome atual da categoria divergiu do esperado; outra renomeação venceu.' });
            }
          }
        }
        // Description-only transaction edit: replay is resolved before any
        // mutable read, so a committed edit with a lost response replays even
        // though expectedDescription is now stale. New proposals must bind to
        // a current transaction in this workspace and its exact description.
        if (body.data.tool === 'transactions.update') {
          const draftHash = await computePendingOperationV2Hash({
            tool: body.data.tool,
            normalizedArgs: checked.data as PendingOperationV2['normalizedArgs'],
            workspaceId: ctx.householdId,
            actorId: ctx.actorId,
            deviceId: ctx.deviceId,
          });
          const replay = await v2Store.findByIdempotencyKey(ctx.householdId, key);
          if (replay) {
            if (replay.proposalHash !== draftHash) return reply.code(409).send({ code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' });
            const existingRecord = await v2Store.get(replay.id, identity(ctx));
            return reply.code(200).send({ ...existingRecord, existing: true });
          }
          const replayAfterMutableError = async () => {
            const winner = await v2Store.findByIdempotencyKey(ctx.householdId, key);
            if (!winner) return null;
            if (winner.proposalHash !== draftHash) return { status: 409 as const, body: { code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' } };
            const winnerRecord = await v2Store.get(winner.id, identity(ctx));
            return { status: 200 as const, body: { ...winnerRecord, existing: true } };
          };
          if (!opts.readModel?.listAllTransactions) return reply.code(503).send({ code: 'read_model.unavailable', message: 'Não foi possível validar o lançamento.' });
          const args = checked.data as { transactionId: string; description: string; expectedDescription: string };
          let transactions;
          try { transactions = await opts.readModel.listAllTransactions(ctx.householdId); }
          catch { return reply.code(503).send({ code: 'read_model.unavailable', message: 'Não foi possível validar o lançamento.' }); }
          const target = transactions.find((transaction) => transaction.id === args.transactionId);
          if (!target) {
            const late = await replayAfterMutableError();
            if (late) return reply.code(late.status).send(late.body);
            return reply.code(404).send({ code: 'not_found', message: 'Lançamento não encontrado.' });
          }
          if (target.description !== args.expectedDescription) {
            const late = await replayAfterMutableError();
            if (late) return reply.code(late.status).send(late.body);
            return reply.code(409).send({ code: 'transaction.description_conflict', message: 'A descrição mudou; atualize a proposta.' });
          }
          if (target.kind !== 'expense' && target.kind !== 'income') return reply.code(422).send({ code:'approval.invalid_args', message:'A descrição de transferências não pode ser alterada por este fluxo.' });
          if (target.description === args.description) return reply.code(422).send({ code:'approval.invalid_args', message:'A nova descrição precisa ser diferente da atual.' });
        }
        if (body.data.tool === 'categories.deactivate') {
          const draftHash = await computePendingOperationV2Hash({
            tool: body.data.tool,
            normalizedArgs: checked.data as PendingOperationV2['normalizedArgs'],
            workspaceId: ctx.householdId,
            actorId: ctx.actorId,
            deviceId: ctx.deviceId,
          });
          const replay = await v2Store.findByIdempotencyKey(ctx.householdId, key);
          if (replay) {
            if (replay.proposalHash !== draftHash) {
              return reply.code(409).send({ code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' });
            }
            const existingRecord = await v2Store.get(replay.id, identity(ctx));
            return reply.code(200).send({ ...existingRecord, existing: true });
          }
          const replayAfterMutableError = async () => {
            const winner = await v2Store.findByIdempotencyKey(ctx.householdId, key);
            if (!winner) return null;
            if (winner.proposalHash !== draftHash) {
              return { status: 409 as const, body: { code: 'idempotency.conflict', message: 'Chave de idempotência já utilizada com proposta diferente.' } };
            }
            const winnerRecord = await v2Store.get(winner.id, identity(ctx));
            return { status: 200 as const, body: { ...winnerRecord, existing: true } };
          };
          if (opts.readModel) {
            const { categoryId, expectedName } = checked.data as { categoryId: string; expectedName: string };
            const categories = await opts.readModel.listCategories(ctx.householdId);
            const target = categories.find((category) => category.id === categoryId);
            if (!target) {
              const late = await replayAfterMutableError();
              if (late) return reply.code(late.status).send(late.body);
              return reply.code(404).send({ code: 'not_found', message: 'Categoria não encontrada.' });
            }
            if (target.name !== expectedName) {
              const late = await replayAfterMutableError();
              if (late) return reply.code(late.status).send(late.body);
              return reply.code(409).send({ code: 'category.name_conflict', message: 'Nome atual da categoria divergiu do esperado.' });
            }
          }
        }
        // P2 TTL (route half): authoritative server time — createdAt is
        // always now (the body carries no createdAt), and a user-supplied
        // expiresAt is clamped to createdAt + PENDING_V2_MAX_TTL_MS (the
        // store re-enforces the same ceiling as defense-in-depth). A
        // birth-expired request fails fast here, never reaching the store.
        const nowMs = Date.now();
        const requestedExpiresMs = body.data.expiresAt !== undefined ? Date.parse(body.data.expiresAt) : Number.NaN;
        const effectiveExpiresAt = Number.isNaN(requestedExpiresMs)
          ? new Date(nowMs + PENDING_V2_MAX_TTL_MS).toISOString()
          : new Date(Math.min(requestedExpiresMs, nowMs + PENDING_V2_MAX_TTL_MS)).toISOString();
        if (Date.parse(effectiveExpiresAt) <= nowMs) return reply.code(409).send({ code: 'approval.expired', message: 'A proposta já expirou.' });
        const base = { version: 2 as const, ...identity(ctx), tool: body.data.tool, normalizedArgs: checked.data as PendingOperationV2['normalizedArgs'], proposalHash: '', idempotencyKey: key, createdAt: new Date(nowMs).toISOString(), expiresAt: effectiveExpiresAt, bindings: identity(ctx) };
        const operation = { ...base, proposalHash: await computePendingOperationV2Hash(base) };
        const result = await v2Store.propose(operation);
        // SPEC §7.7: same key + same payload replays the existing operation.
        if (result.existing) return reply.code(200).send(result);
        return reply.code(201).send(result);
      } catch (error) { return handleError(error, reply); }
    };
    app.post('/pending-operations/v2/propose', proposeV2);
    app.post('/pending-operations/v2', proposeV2);
    // T1.5 (SPEC §8.3): Agent-only authoritative listing. Identity comes
    // exclusively from the authenticated context — the PWA never declares
    // which operations it believes are pending. Lean projection: enough for
    // disambiguation (amount/description/date/account), never authority
    // material (no attestation, no full normalizedArgs). Registered before
    // the `/:id` GETs so the static segment can never be read as an id.
    // FIX-P1 (presentation rehydration): each item carries the canonical
    // `PendingOperationPresentation` derived SERVER-side from the STORED
    // hash-bound normalizedArgs via buildPendingOperationPresentation —
    // never from client input. Account/category display labels resolve
    // server-side from the authoritative workspace-scoped read model
    // (omitted honestly when unresolvable); the presentation is optional
    // (absent when the stored args are incomplete) and never carries
    // attestation/hash/token/args.
    app.get('/pending-operations/v2/active', async (req, reply) => {
      if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.read)) return;
      let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
      try {
        const records = await v2Store.listActive(identity(ctx));
        // Display-only label maps, bulk-loaded once per request from the
        // authoritative read model. A lookup failure empties the maps —
        // the listing itself never fails for a display-only enrichment.
        const accountLabels = new Map<string, string>();
        const categoryLabels = new Map<string, string>();
        const categoryRows = new Map<string, { id: string; name: string; kind?: string; parentId?: string | null }>();
        const transactionRows = new Map<string, import('../types/domain.js').Transaction>();
        if (opts.readModel) {
          try {
             const [accounts, categories] = await Promise.all([
              opts.readModel.listAccounts(ctx.householdId),
              opts.readModel.listCategories(ctx.householdId),
             ]);
             for (const account of accounts) accountLabels.set(account.id, account.name);
             for (const category of categories) {
               categoryLabels.set(category.id, category.name);
               categoryRows.set(category.id, category);
            }
          } catch {
            // Honest omission below (no labels) — never a 500.
          }
          if (records.some((record)=>record.tool==='transactions.update') && opts.readModel.listAllTransactions) {
            try {
              const transactions=await opts.readModel.listAllTransactions(ctx.householdId);
              for (const transaction of transactions) transactionRows.set(transaction.id,transaction);
            } catch { /* no target context: description card remains degraded/non-actionable */ }
          }
        }
        const items = records.map((record) => {
          const args = (record.normalizedArgs ?? {}) as Record<string, unknown>;
          const accountId = typeof args.accountId === 'string' ? args.accountId : undefined;
          const categoryId = typeof args.categoryId === 'string' ? args.categoryId : undefined;
          const categoryTarget = categoryId !== undefined ? categoryRows.get(categoryId) : undefined;
          const transactionId = typeof args.transactionId === 'string' ? args.transactionId : undefined;
          const transaction = transactionId ? transactionRows.get(transactionId) : undefined;
          const transactionAccountName = transaction ? accountLabels.get(transaction.accountId) : undefined;
          const transactionContextMatches = record.tool === 'transactions.update' && transaction && transaction.description === args.expectedDescription && (transaction.kind === 'expense' || transaction.kind === 'income');
          const categoryParent = categoryTarget?.parentId ? categoryRows.get(categoryTarget.parentId) : undefined;
          const categoryParentId = record.tool === 'categories.create' && typeof args.parentId === 'string' ? args.parentId : undefined;
          const accountLabel = accountId !== undefined ? accountLabels.get(accountId) : undefined;
          const categoryLabel = categoryId !== undefined ? categoryLabels.get(categoryId) : categoryParentId !== undefined ? categoryLabels.get(categoryParentId) : undefined;
          // V3-FIX-CARD-FAILCLOSED: label ids carried by the stored args but
          // missing from the read-model maps degrade honestly — the card
          // fails closed on these warnings instead of offering Confirm.
          const labelWarnings: string[] = [];
          if (accountId !== undefined && accountLabel === undefined) {
            labelWarnings.push('Dados da conta indisponíveis no momento');
          }
          if (categoryId !== undefined && categoryLabel === undefined) {
            labelWarnings.push('Dados da categoria indisponíveis no momento');
          }
          if (categoryParentId !== undefined && categoryLabel === undefined) {
            labelWarnings.push('Dados da categoria indisponíveis no momento');
          }
          const presentation = buildPendingOperationPresentation({
            id: record.id,
            status: record.status,
            tool: record.tool,
            normalizedArgs: record.normalizedArgs,
            expiresAt: record.expiresAt,
            ...(accountLabel !== undefined ? { accountLabel } : {}),
            ...(categoryLabel !== undefined ? { categoryLabel } : {}),
            ...(transactionContextMatches && transactionAccountName ? { transactionTarget:{id:transaction.id,amountCents:transaction.amountCents,date:transaction.date,accountId:transaction.accountId,accountName:transactionAccountName} } : {}),
            ...(record.tool === 'categories.deactivate' && categoryTarget?.kind ? { categoryKind: categoryTarget.kind } : {}),
            ...(record.tool === 'categories.deactivate' && categoryParent ? { categoryParentLabel: { id: categoryParent.id, name: categoryParent.name } } : {}),
            ...(labelWarnings.length > 0 ? { warnings: labelWarnings } : {}),
          });
          return {
            id: record.id,
            status: record.status,
            tool: record.tool,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            ...(typeof args.amountCents === 'number' ? { amountCents: args.amountCents } : {}),
            ...(typeof args.description === 'string' ? { description: args.description } : {}),
            ...(typeof args.date === 'string' ? { date: args.date } : {}),
            ...(typeof args.accountId === 'string' ? { accountId: args.accountId } : {}),
            ...(typeof args.categoryId === 'string' ? { categoryId: args.categoryId } : {}),
            ...(record.status === 'failed' && record.tool === 'categories.deactivate' && record.failureCode === 'in_use' ? { failureCode: 'in_use' } : {}),
            ...(presentation ? { presentation } : {}),
          };
        });
        return reply.send({ items, total: items.length });
      } catch (error) { return handleError(error, reply); }
    });
    const confirm = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.confirm)) return;
      let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
      const params = idSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
      const body = z.object({ intentionId: z.string().trim().min(1).max(240).optional() }).strict().safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ code: 'validation.error', issues: body.error.issues });
      try {
        if (!(await requireActionablePresentation(params.data.id, ctx, 'proposed', reply))) return;
        const record = await v2Store.get(params.data.id, identity(ctx));
        const args = record.normalizedArgs as Record<string, unknown>;
        const decision = approvalPolicy.evaluateMutation({ tool: record.tool, ...(typeof args.amountCents === 'number' ? { amountCents: args.amountCents } : {}), workspaceId: ctx.householdId, destructive: false, complete: true, ambiguousEntity: false, duplicateSuspected: false, explicitIntent: true });
        const authorization = decision.reason === 'high_value'
          ? { mode: 'manual' as const, reason: 'high_value', riskTier: 'high' as const }
          : decision.reason === 'destructive'
            ? { mode: 'manual' as const, reason: 'destructive', riskTier: 'destructive' as const }
            : { mode: 'manual' as const, reason: 'policy_required', riskTier: decision.risk };
        // Review round 4 P1-B: the caller's intentionId binds atomically
        // inside confirm (identical ⇒ idempotent proceed; divergent ⇒ 409
        // `approval.intention_conflict`, zero effect). Absent ⇒ legacy path.
        return reply.send(await v2Store.confirm(
          params.data.id,
          identity(ctx),
          authorization,
          ...(body.data.intentionId !== undefined ? [{ intentionId: body.data.intentionId } as const] : []),
        ));
      } catch (error) { return handleError(error, reply, true); }
    };
    app.post('/pending-operations/v2/:id/confirm', confirm);
    // Review round 4 P1-B (direction iii): authoritative intention bind,
    // called by the Agent BEFORE resolving the listing. First durable writer
    // wins; repeats return the stored instant (`fresh: false`) with any
    // operation already bound — the agent fails closed on a pre-existing
    // sighting with a fresh local history (post-outage redelivery) and
    // refuses a divergent target before the transport. Same confirm
    // capability: marking an intent is part of confirming, never a read.
    app.post('/pending-operations/v2/confirmation-intentions/bind', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.confirm)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const body = z.object({ intentionId: z.string().trim().min(1).max(240) }).strict().safeParse(req.body ?? {}); if (!body.success) return reply.code(400).send({ code: 'validation.error', issues: body.error.issues }); try { return reply.send(await v2Store.bindConfirmationIntention(identity(ctx), body.data.intentionId)); } catch (error) { return handleError(error, reply, true); } });
    app.post('/pending-operations/v2/:id/authorize', async (req, reply) => {
      if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.authorize)) return;
      let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
      const params = idSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
      const body = z.object({}).strict().safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ code: 'validation.error', issues: body.error.issues });
      const mode = getTedRiskBasedAutoexecute();
      if (mode === 'off') return reply.code(409).send({ code: 'approval.autoexecute_disabled' });
      try {
        const operationIdentity = identity(ctx);
        const record = await v2Store.get(params.data.id, operationIdentity);
        if (record.status !== 'proposed') {
          return reply.send(await v2Store.authorize(params.data.id, operationIdentity, { mode: 'auto', reason: 'explicit_low_risk', riskTier: 'low' }));
        }
        const args = record.normalizedArgs as Record<string, unknown>;
        // Stored args are registry-schema validated; V2 eligible tools are non-destructive; ambiguity/duplicate signals arrive in a later phase; explicit intent is bound to this server-side narrow capability (Agent guard is PR C).
        const decision = approvalPolicy.evaluateMutation({ tool: record.tool, ...(typeof args.amountCents === 'number' ? { amountCents: args.amountCents } : {}), workspaceId: ctx.householdId, destructive: false, complete: true, ambiguousEntity: false, duplicateSuspected: false, explicitIntent: true });
        const emitDecision = (eventType: 'mutation.authorization.evaluated' | 'mutation.autoauthorized' | 'mutation.autoexecute.blocked') => {
          try {
            const event = buildObservabilityEvent(eventType, { tool: record.tool, risk: decision.risk, decision: decision.action, reason: decision.reason });
            console.info(JSON.stringify(event));
          } catch { /* Observability is best-effort and never changes authorization. */ }
        };
        if (mode === 'shadow') {
          emitDecision('mutation.authorization.evaluated');
          return reply.code(409).send({ code: 'approval.autoexecute_disabled' });
        }
        if (decision.action !== 'auto_execute') {
          emitDecision('mutation.autoexecute.blocked');
          return reply.code(409).send({ code: 'approval.autoexecute_not_eligible', details: { decision: { action: decision.action, risk: decision.risk, reason: decision.reason } } });
        }
        emitDecision('mutation.autoauthorized');
        return reply.send(await v2Store.authorize(params.data.id, operationIdentity, { mode: 'auto', reason: 'explicit_low_risk', riskTier: 'low' }));
      } catch (error) { return handleError(error, reply, true); }
    });
    app.get('/pending-operations/v2/:id/outcome', async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.read)) return;
      let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
      const params = idSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
      if (!v2Store.getForRead) return reply.code(503).send({ code: 'approval.outcome_unavailable' });
      try {
        const record = await v2Store.getForRead(params.data.id, identity(ctx));
        const base = { operationId: record.id, tool: record.tool };
        if (record.status !== 'succeeded') {
          const observed = pendingOperationOutcomeSchema.safeParse({
            ...base,
            status: record.status,
            ...(record.status === 'failed' && record.tool === 'categories.deactivate' && record.failureCode === 'in_use' ? { failureCode: 'in_use' } : {}),
          });
          return reply.send(observed.success ? observed.data : { ...base, status: 'unverified' });
        }
        const rawReceipt = record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)
          ? (record.execution as Record<string, unknown>).receipt
          : undefined;
        const execution = record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)
          ? record.execution as Record<string, unknown>
          : undefined;
        const parsed = mutationReceiptSchema.safeParse(rawReceipt);
        const entity = parsed.success ? parsed.data.entity : undefined;
        const expectedEntityType = record.tool.startsWith('categories.') ? 'category'
          : record.tool.startsWith('accounts.') ? 'account' : 'transaction';
        let canonical: ReturnType<typeof buildTedReceipt> | undefined;
        if (parsed.success && entity && parsed.data.operationId === record.id && getApprovalToolContract(record.tool)) {
          try { canonical = buildTedReceipt(record.tool as ApprovalToolId, record.id, { type: expectedEntityType, id: entity.id }); } catch { /* malformed stored success remains unverified */ }
        }
        const args = record.normalizedArgs as Record<string, unknown>;
        const expectedTarget = record.tool === 'transactions.update'
          ? args.transactionId
          : record.tool === 'categories.deactivate' || record.tool === 'categories.update'
          ? args.categoryId
          : record.tool === 'accounts.deactivate' || record.tool === 'accounts.update'
            ? args.accountId
            : undefined;
        const canonicalMatch = parsed.success && canonical && entity &&
          parsed.data.status === 'succeeded' &&
          typeof record.mutationId === 'string' && parsed.data.mutationId === record.mutationId &&
          parsed.data.mutationKind === canonical.mutationKind &&
          JSON.stringify(parsed.data.affectedTargets) === JSON.stringify(canonical.affectedTargets) &&
          parsed.data.operationId === canonical.operationId &&
          entity.type === expectedEntityType &&
          parsed.data.entity?.type === canonical.entity?.type &&
          parsed.data.entity?.id === canonical.entity?.id &&
          execution?.status === 'succeeded' && execution.operationId === entity.id &&
          (expectedTarget === undefined || expectedTarget === entity.id);
        if (!canonicalMatch || !parsed.success || !entity) return reply.send({ ...base, status: 'unverified' });
        const outcome = pendingOperationOutcomeSchema.safeParse({
          ...base,
          status: 'succeeded',
          receipt: parsed.data,
          expectedContext: { tool: record.tool, ...(expectedTarget !== undefined ? { entityId: expectedTarget as string } : {}) },
        });
        return reply.send(outcome.success ? outcome.data : { ...base, status: 'unverified' });
      } catch (error) {
        if (error instanceof PendingOperationV2Error || error instanceof DomainError) return handleError(error, reply, true);
        return reply.code(503).send({ code: 'approval.outcome_unavailable' });
      }
    });
    app.get('/pending-operations/v2/:id', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.read)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); try { return reply.send(await v2Store.get(params.data.id, identity(ctx))); } catch (error) { return handleError(error, reply, true); } });
    app.get('/pending-operations/v2/:id/status', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.read)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); try { return reply.send(await v2Store.get(params.data.id, identity(ctx))); } catch (error) { return handleError(error, reply, true); } });
    const reject = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.cancel)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); try { return reply.send(await v2Store.cancel(params.data.id, identity(ctx))); } catch (error) { return handleError(error, reply, true); } };
    app.post('/pending-operations/v2/:id/reject', reject);
    app.post('/pending-operations/v2/:id/cancel', reject);
    app.post('/pending-operations/v2/:id/execute', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.execute)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); const body = z.object({ attestation: z.string().min(32), intentionId: z.string().trim().min(1).max(240).optional() }).strict().safeParse(req.body ?? {}); if (!body.success) return reply.code(400).send({ code: 'validation.error', issues: body.error.issues }); if (!v2Executor) return reply.code(501).send({ code: 'unsupported', message: 'Executor V2 não configurado.' }); try { return reply.send(await v2Store.execute(body.data.attestation, identity(ctx), v2Executor, params.data.id, ...(body.data.intentionId !== undefined ? [{ intentionId: body.data.intentionId } as const] : []))); } catch (error) { return handleError(error, reply, true); } });
    app.post('/pending-operations/v2/:id/retry', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.retry)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); try { if (!(await requireActionablePresentation(params.data.id, ctx, 'failed', reply))) return; return reply.send(await v2Store.retry(params.data.id, identity(ctx))); } catch (error) { return handleError(error, reply, true); } });
    // T6.1 (audit remediation, SPEC §11): controlled crash-recovery entry
    // point — same Agent-only auth/capability model as the sibling V2 routes.
    // Identity comes exclusively from the authenticated context; a foreign
    // workspace's id maps to 403 via forbiddenOnMissing (no existence leak).
    // Valid lease → 409 approval.execution_in_progress; terminal/confirmed →
    // 409 approval.reconcile_not_allowed; expired lease → executor re-runs
    // with the SAME persisted idempotencyKey (0/1 effect at the WriteStore).
    app.post('/pending-operations/v2/:id/reconcile', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.reconcile)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); if (!v2Executor) return reply.code(501).send({ code: 'unsupported', message: 'Executor V2 não configurado.' }); try { return reply.send(await v2Store.reconcileExpiredExecuting(params.data.id, identity(ctx), v2Executor)); } catch (error) { return handleError(error, reply, true); } });
    app.post('/pending-operations/v2/:id/expire', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.cancel)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); try { return reply.send(await v2Store.expire(params.data.id, identity(ctx))); } catch (error) { return handleError(error, reply, true); } });
  }

  // PR-1 (retire-pending-v1): V1 routes removed — GET /details, /, /:id
  // and POST /approve, /reject, /:id/approve, /:id/reject are unmounted.
  // The Agent model surface never used them (RETIRED_MODEL_TOOLS) and
  // production already served V2-only; only /undo below is kept.
  //
  // Single-registration guard: the production boot composes registerRoutes
  // (which already mounts /undo with the real undoService) and a second
  // registerPendingOperationRoutes call with v2Only on the SAME app. PR-1
  // dropped the `if (opts.v2Only) return;` early-return, so /undo registered
  // twice and boot crashed (FST_ERR_DUPLICATED_ROUTE). The first
  // registration wins — the second call (server/index.ts) wires no
  // undoService, so skipping it also preserves the real handler.
  if (app.hasRoute({ method: 'POST', url: '/pending-operations/undo' })) return;
  app.post('/pending-operations/undo', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
    try {
      // debt-undo-confirmation-protocol: delegated callers must carry the
      // NARROW undo capability. Device-token callers (no delegatedTurn)
      // keep the legacy path unchanged.
      if (req.delegatedTurn && !req.delegatedTurn.capabilities.includes('financial.undo.execute')) {
        return reply.code(403).send({ code: 'auth.delegation_scope_forbidden', message: 'Capability de undo delegada obrigatória.' });
      }
      if (!undoService) throw domainErrors.unsupported('undo');
      const idempotencyKey = requireIdempotencyKey(req.headers as Record<string, unknown>);
      const bodySchema = z.object({ lastOperationId: z.string().uuid().optional() });
      const parsed = bodySchema.safeParse((req.body as unknown) ?? {});
      if (!parsed.success) return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
      const result = await undoService.undo(ctx.householdId, ctx.actorId, idempotencyKey, parsed.data.lastOperationId);
      return reply.code(200).send(result);
    } catch (error) { return handleError(error, reply); }
  });
};
