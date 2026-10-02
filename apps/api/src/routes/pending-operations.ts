import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_TOKEN_HEADER } from '../auth/device-token.js';
import type { AuthResolver } from './auth.js';
import { DomainError, domainErrors } from '../writes/errors.js';
import { requireIdempotencyKey } from '../writes/idempotency.js';
import { computePendingOperationV2Hash, isActionablePendingOperationPresentation, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import { validateApprovalToolArgs } from '../approvals/tool-registry.js';
import { buildPendingOperationPresentation } from '../approvals/presentation.js';
import type { ReadModelStore } from '../read-models/store.js';
import { PendingOperationV2Error, PENDING_V2_MAX_TTL_MS, type PendingExecutor, type PendingOperationExecutor, type PendingOperationStore, type PendingOperationV2Store } from '../approvals/pending.js';
import { createInMemoryPendingOperationStore } from '../approvals/pending.js';
import type { UndoService } from '../approvals/undo.js';
import { createApprovalPolicy, type ApprovalPolicy } from '../approvals/policy.js';
import { getTedRiskBasedAutoexecute } from '../approvals/authorization-config.js';
import { buildObservabilityEvent } from '../audit/events.js';

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

export const registerPendingOperationRoutes = (app: FastifyInstance, opts: { store?: PendingOperationStore; resolveToken: AuthResolver; executor?: PendingOperationExecutor; undoService?: UndoService; v2Store?: PendingOperationV2Store; v2Executor?: PendingExecutor; v2Only?: boolean; readModel?: Pick<ReadModelStore, 'listAccounts' | 'listCategories'>; approvalPolicy?: ApprovalPolicy }): void => {
  // Phase 7 (V4.1 Task 7.3): the V1 store is optional. Production
  // composition (server/index.ts, v2Only) wires no V1 store at all — the
  // default below only serves dev/test compositions that still mount V1
  // for the Agent's generated V1 tools.
  const { resolveToken, executor, undoService, v2Store, v2Executor } = opts;
  const approvalPolicy = opts.approvalPolicy ?? createApprovalPolicy();
  const store = opts.store ?? createInMemoryPendingOperationStore();
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
      let categories: Array<{ id: string; name: string }>;
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
      const accountLabel = accountId !== undefined ? accountLabels.get(accountId) : undefined;
      const categoryLabel = categoryId !== undefined ? categoryLabels.get(categoryId) : undefined;
      const labelWarnings: string[] = [];
      if (accountId !== undefined && accountLabel === undefined) {
        labelWarnings.push('Dados da conta indisponíveis no momento');
      }
      if (categoryId !== undefined && categoryLabel === undefined) {
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
        if (opts.readModel) {
          try {
            const [accounts, categories] = await Promise.all([
              opts.readModel.listAccounts(ctx.householdId),
              opts.readModel.listCategories(ctx.householdId),
            ]);
            for (const account of accounts) accountLabels.set(account.id, account.name);
            for (const category of categories) categoryLabels.set(category.id, category.name);
          } catch {
            // Honest omission below (no labels) — never a 500.
          }
        }
        const items = records.map((record) => {
          const args = (record.normalizedArgs ?? {}) as Record<string, unknown>;
          const accountId = typeof args.accountId === 'string' ? args.accountId : undefined;
          const categoryId = typeof args.categoryId === 'string' ? args.categoryId : undefined;
          const accountLabel = accountId !== undefined ? accountLabels.get(accountId) : undefined;
          const categoryLabel = categoryId !== undefined ? categoryLabels.get(categoryId) : undefined;
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
          const presentation = buildPendingOperationPresentation({
            id: record.id,
            status: record.status,
            tool: record.tool,
            normalizedArgs: record.normalizedArgs,
            expiresAt: record.expiresAt,
            ...(accountLabel !== undefined ? { accountLabel } : {}),
            ...(categoryLabel !== undefined ? { categoryLabel } : {}),
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
      const body = z.object({}).strict().safeParse(req.body ?? {});
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
        return reply.send(await v2Store.confirm(params.data.id, identity(ctx), authorization));
      } catch (error) { return handleError(error, reply, true); }
    };
    app.post('/pending-operations/v2/:id/confirm', confirm);
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
    app.get('/pending-operations/v2/:id', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.read)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); try { return reply.send(await v2Store.get(params.data.id, identity(ctx))); } catch (error) { return handleError(error, reply, true); } });
    app.get('/pending-operations/v2/:id/status', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.read)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); try { return reply.send(await v2Store.get(params.data.id, identity(ctx))); } catch (error) { return handleError(error, reply, true); } });
    const reject = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.cancel)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); try { return reply.send(await v2Store.cancel(params.data.id, identity(ctx))); } catch (error) { return handleError(error, reply, true); } };
    app.post('/pending-operations/v2/:id/reject', reject);
    app.post('/pending-operations/v2/:id/cancel', reject);
    app.post('/pending-operations/v2/:id/execute', async (req, reply) => { if (!requireV2Capability(req, reply, V2_APPROVAL_CAPABILITIES.execute)) return; let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); } const params = idSchema.safeParse(req.params); if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues }); const body = z.object({ attestation: z.string().min(32) }).strict().safeParse(req.body ?? {}); if (!body.success) return reply.code(400).send({ code: 'validation.error', issues: body.error.issues }); if (!v2Executor) return reply.code(501).send({ code: 'unsupported', message: 'Executor V2 não configurado.' }); try { return reply.send(await v2Store.execute(body.data.attestation, identity(ctx), v2Executor, params.data.id)); } catch (error) { return handleError(error, reply, true); } });
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

  if (opts.v2Only) return;

  app.get('/pending-operations/details', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
    const query = pendingIdentitySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: 'validation.error', issues: query.error.issues });

    try {
      if (query.data.chatId !== undefined) {
        // Phase 7 (V4.1 Task 7.7): bridge context decommissioned — no
        // request can carry a validated bridge binding anymore, so the
        // chatId-scoped dual path fails closed. Use pendingOperationId.
        return reply.code(403).send({ code: 'auth.context_chat_mismatch', message: 'chatId does not match the authenticated bridge context' });
      }
      return reply.send({ operation: await store.get(query.data.pendingOperationId!, ctx.householdId) });
    } catch (error) { return handleError(error, reply); }
  });

  app.get('/pending-operations', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
    const query = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: 'validation.error', issues: query.error.issues });
    try {
      const items = await store.list(ctx.householdId, query.data.status);
      return reply.send({ items, total: items.length });
    } catch (error) { return handleError(error, reply); }
  });

  app.get('/pending-operations/:id', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    try { return reply.send(await store.get(params.data.id, ctx.householdId)); }
    catch (error) { return handleError(error, reply); }
  });

  app.post('/pending-operations/approve', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
    const query = pendingIdentitySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: 'validation.error', issues: query.error.issues });
    try {
      const pendingId = query.data.pendingOperationId;
      if (query.data.chatId !== undefined) {
        // Phase 7 (V4.1 Task 7.7): bridge context decommissioned — the
        // chatId-scoped dual path fails closed. Use pendingOperationId.
        return reply.code(403).send({ code: 'auth.context_chat_mismatch', message: 'chatId does not match the authenticated bridge context' });
      }
      return reply.send(await store.approve(pendingId!, ctx.householdId, ctx.actorId, executor));
    } catch (error) { return handleError(error, reply, true); }
  });

  app.post('/pending-operations/reject', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
    const query = pendingIdentitySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: 'validation.error', issues: query.error.issues });
    try {
      const pendingId = query.data.pendingOperationId;
      if (query.data.chatId !== undefined) {
        // Phase 7 (V4.1 Task 7.7): bridge context decommissioned — the
        // chatId-scoped dual path fails closed. Use pendingOperationId.
        return reply.code(403).send({ code: 'auth.context_chat_mismatch', message: 'chatId does not match the authenticated bridge context' });
      }
      return reply.send(await store.reject(pendingId!, ctx.householdId, ctx.actorId));
    } catch (error) { return handleError(error, reply, true); }
  });

  app.post('/pending-operations/:id/approve', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    try { return reply.send(await store.approve(params.data.id, ctx.householdId, ctx.actorId, executor)); }
catch (error) { return handleError(error, reply, true); }
  });

  app.post('/pending-operations/:id/reject', async (req, reply) => {
    let ctx; try { ctx = await resolve(req); } catch (error) { return handleError(error, reply); }
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'validation.error', issues: params.error.issues });
    try { return reply.send(await store.reject(params.data.id, ctx.householdId, ctx.actorId)); }
catch (error) { return handleError(error, reply, true); }
  });
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
