/**
 * Approval Tool Contract registry (SPEC §7.5) — canonical source of contract
 * for each mutable tool of the V2 approval protocol.
 *
 * Each entry carries exactly:
 * { tool, inputSchema, approvalRequired, executor }
 *
 * - inputSchema instances are REUSED from writes/types.ts (never duplicated).
 * - Reconciliation effects (affectedTargets) are intentionally absent: they
 *   belong to the separate Mutation Effects Registry (SPEC §15.1.1, T3.2).
 * - Propose-route validation wiring is out of scope here (T1.4); this module
 *   exposes only the registry plus lookup/validation helpers.
 */
import { z } from 'zod';
import type { MutationReceipt } from '@pi-finance/llm-contracts';
import {
  createAccountInputSchema,
  createExpenseInputSchema,
  createIncomeInputSchema,
  createTransferInputSchema,
} from '../writes/types.js';
import { isoDateSchema } from '../shared/iso-date.js';
import { DomainError } from '../writes/errors.js';
import type { WriteStore } from '../writes/store.js';
import type { CardStore } from '../cards/store.js';
import type { PayableStore } from '../payables/store.js';
import { buildTedReceipt } from '../reconciliation/effects-registry.js';
import { AUTOEXECUTION_ELIGIBLE_TOOLS } from './policy.js';

export const APPROVAL_TOOL_IDS = [
  'transactions.expense.create',
  'transactions.income.create',
  'cards.purchase.create',
  'cards.statement.pay',
  'transactions.transfer.create',
  'transactions.update',
  'accounts.create',
  'accounts.deactivate',
  'accounts.update',
  'categories.create',
  'categories.update',
  'categories.deactivate',
  'payables.create',
  'payables.pay',
] as const;

export type ApprovalToolId = (typeof APPROVAL_TOOL_IDS)[number];

export type ApprovalToolExecutionContext = {
  writes: WriteStore;
  cardStore?: CardStore;
  payableStore?: PayableStore;
  workspaceId: string;
  args: unknown;
  idempotencyKey: string;
  /**
   * Server-bound actor (from the persisted pending-operation record —
   * never from normalizedArgs). Carried into the keyed write so the
   * undo-eligible audit row attributes the correct actor.
   */
  actorId: string;
};

export type ApprovalToolResult = { status: 'succeeded'; operationId: string; receipt: MutationReceipt };

export type ApprovalToolExecutor = (
  ctx: ApprovalToolExecutionContext,
) => Promise<ApprovalToolResult>;

export type ApprovalToolContract = {
  tool: ApprovalToolId;
  inputSchema: z.ZodTypeAny;
  approvalRequired: true;
  authorizationPolicy: 'risk_based';
  autoExecutionEligible: boolean;
  executor: ApprovalToolExecutor;
};

export const createToolNotAllowedError = (): Error & { code: 'tool.not_allowed' } => {
  const error = new Error('tool.not_allowed') as Error & { code: 'tool.not_allowed' };
  error.code = 'tool.not_allowed';
  return error;
};

/**
 * Execution-outcome uncertainty (HIGH review finding): the trusted TED
 * executor performs a financial write and then builds/normalizes a receipt.
 * A failure at/after the write (writer throw after commit, response loss,
 * receipt-build failure) leaves the outcome UNKNOWN — the write may already
 * exist. This typed marker lets the pending-operation store keep the
 * operation `executing` (no `failed` persist, no `fail` audit, no retry)
 * until the lease reconciler re-runs the SAME persisted idempotencyKey.
 *
 * Stable safe surface: the code is a fixed protocol string and the message
 * carries no raw cause (never a stack, prompt, or driver text). Only the
 * trusted executor throws this; generic pre-write executor throws stay
 * plain errors and keep the existing deterministic `failed` path.
 */
export const APPROVAL_EXECUTION_UNCERTAIN_CODE = 'approval.execution_uncertain' as const;

export class ApprovalExecutionUncertainError extends Error {
  readonly code: typeof APPROVAL_EXECUTION_UNCERTAIN_CODE = APPROVAL_EXECUTION_UNCERTAIN_CODE;
  readonly statusCode = 409;
  constructor(
    message = 'Resultado da execução incerto; operação mantida em execução para reconciliação.',
  ) {
    super(message);
    this.name = 'ApprovalExecutionUncertainError';
  }
}

export const createApprovalExecutionUncertainError = (): ApprovalExecutionUncertainError =>
  new ApprovalExecutionUncertainError();

export const isApprovalExecutionUncertain = (error: unknown): boolean => {
  if (error instanceof ApprovalExecutionUncertainError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === APPROVAL_EXECUTION_UNCERTAIN_CODE;
};

const executeExpenseCreate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
  idempotencyKey,
  actorId,
}) => {
  const parsed = createExpenseInputSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_expense_arguments');
  // Fail-closed actor binding: the audit row must attribute a server-bound
  // actor — never an inferred or missing one. Pre-write deterministic
  // failure (not uncertainty): the writer never runs without it.
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  // The writer may throw AFTER the commit (or the response may be lost on
  // the way back): from here the outcome is uncertain, never a deterministic
  // pre-write failure. Map every writer throw to the typed marker with a
  // safe message — the raw cause must never reach the API response.
  //
  // T12c: DomainError is the ONE exception. WriteStore throws DomainError
  // only for pre-commit domain validation (every DomainError site in
  // createExpense/createIncome runs before the INSERT inside the same
  // transaction, so the rollback proves nothing was written). It rethrows
  // unchanged so pending-v2 persists `failed` with retry; any other error
  // (driver loss after commit, timeout, malformed record) may be post-write
  // and stays uncertain.
  let transaction: { id: string };
  try {
    // V2 execution audit: the explicit tool operation + server-bound actor
    // commit with the mutation in the keyed claim tx (undo-eligible).
    transaction = await writes.createExpense(workspaceId, parsed.data, {
      idempotencyKey,
      audit: { operation: 'transactions.expense.create', actorId },
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  const operationId = transaction.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('transactions.expense.create', operationId, { type: 'transaction', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

const executeIncomeCreate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
  idempotencyKey,
  actorId,
}) => {
  const parsed = createIncomeInputSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_income_arguments');
  // Fail-closed actor binding (same contract as the expense path).
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  // Same uncertainty contract as the expense path: any writer throw after
  // the write started is an unknown outcome, never a deterministic failure.
  // T12c: same DomainError carve-out — pre-commit validation with proven
  // rollback rethrows deterministic; anything else stays uncertain.
  let transaction: { id: string };
  try {
    // V2 execution audit: explicit tool operation + server-bound actor.
    transaction = await writes.createIncome(workspaceId, parsed.data, {
      idempotencyKey,
      audit: { operation: 'transactions.income.create', actorId },
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  const operationId = transaction.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('transactions.income.create', operationId, { type: 'transaction', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

export const createCardPurchaseArgsSchema = z
  .object({
    accountId: z.string().uuid(),
    /** TOTAL of the purchase — never a per-parcel amount. */
    amountCents: z.number().int().positive(),
    description: z.string().trim().min(1).max(240),
    date: isoDateSchema,
    categoryId: z.string().uuid().optional(),
    subcategoryId: z.string().uuid().optional(),
    notes: z.string().trim().max(500).optional(),
    /**
     * P3.5: optional parcel count (1–48). Absent or 1 keeps the exact P3.4
     * single-purchase path. 2–48 goes through `createCardInstallments` and
     * NEVER falls back to a silent 1x when the declared split cannot run.
     */
    installmentsTotal: z.number().int().min(1).max(48).optional(),
  })
  .strict()
  // Every parcel must carry at least one cent: a total below the declared
  // count would create zero-cent rows (and break replay snapshots).
  .refine(
    (value) => value.installmentsTotal === undefined || value.installmentsTotal <= value.amountCents,
    { message: 'amountCents must cover at least 1 cent per installment', path: ['installmentsTotal'] },
  );

export type CreateCardPurchaseArgs = z.infer<typeof createCardPurchaseArgsSchema>;

const executeCardPurchaseCreate: ApprovalToolExecutor = async ({
  writes: _writes,
  cardStore,
  workspaceId,
  args,
  idempotencyKey,
  actorId,
}) => {
  const parsed = createCardPurchaseArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_card_purchase_arguments');
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  const store = cardStore;
  if (!store) throw new Error('validation.card_store_unavailable');
  const metadata = {
    ...(parsed.data.categoryId ? { categoryId: parsed.data.categoryId } : {}),
    ...(parsed.data.subcategoryId ? { subcategoryId: parsed.data.subcategoryId } : {}),
    ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
  };
  const keyOption = idempotencyKey !== undefined ? { idempotencyKey } : undefined;
  const installmentsTotal = parsed.data.installmentsTotal;
  let transactions: { id: string }[];
  try {
    // P3.5: 2–48 parcels take the existing installment store path (one
    // transaction for the whole set). A declared split never degrades into a
    // silent single purchase: if this branch throws, the operation fails
    // closed instead of writing 1x.
    transactions = installmentsTotal !== undefined && installmentsTotal > 1
      ? await store.createCardInstallments(workspaceId, {
        accountId: parsed.data.accountId,
        description: parsed.data.description,
        totalAmountCents: parsed.data.amountCents,
        purchaseDate: parsed.data.date,
        installmentsTotal,
        ...metadata,
      }, keyOption)
      : await store.createCardPurchase(workspaceId, {
        accountId: parsed.data.accountId,
        amountCents: parsed.data.amountCents,
        description: parsed.data.description,
        date: parsed.data.date,
        ...metadata,
      }, keyOption);
  } catch (err) {
    const { DomainError } = await import('../writes/errors.js');
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  const first = Array.isArray(transactions) ? transactions[0] : (transactions as { id: string });
  if (!first || typeof first.id !== 'string') throw createApprovalExecutionUncertainError();
  const operationId = first.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('cards.purchase.create', operationId, { type: 'transaction', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

/**
 * P3.6 statement payment. The execution tuple is EXACT: the invoice id, the
 * payer account id and the amount in cents. There is no `amountCents:
 * "total"` sentinel — a total payment is proposed with the authoritative
 * remaining amount resolved by the reader, never by the executor.
 */
export const payStatementArgsSchema = z
  .object({
    statementId: z.string().uuid(),
    fromAccountId: z.string().uuid(),
    amountCents: z.number().int().positive(),
  })
  .strict();

export type PayStatementArgs = z.infer<typeof payStatementArgsSchema>;

const executeCardStatementPay: ApprovalToolExecutor = async ({
  cardStore,
  workspaceId,
  args,
  idempotencyKey,
}) => {
  const parsed = payStatementArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_statement_payment_arguments');
  const store = cardStore;
  if (!store) throw new Error('validation.card_store_unavailable');
  let statement: { id: string };
  try {
    // P3.6: the persisted Pending V2 key rides into the store. Debit,
    // statement update, card debt delta and the key commit atomically; a
    // reconcile re-run after a lost post-commit response replays the SAME
    // statement instead of paying twice.
    statement = await store.payStatement(
      workspaceId,
      parsed.data.statementId,
      { amountCents: parsed.data.amountCents, fromAccountId: parsed.data.fromAccountId },
      { idempotencyKey },
    );
  } catch (err) {
    // DomainError is pre-commit validation (already paid, overpay, credit-card
    // payer, unknown account/statement) with proven rollback — deterministic.
    // Anything else may be post-write and stays uncertain for lease recovery.
    const { DomainError } = await import('../writes/errors.js');
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  if (!statement || typeof statement.id !== 'string') throw createApprovalExecutionUncertainError();
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('cards.statement.pay', statement.id, { type: 'statement', id: statement.id });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId: statement.id,
    receipt,
  };
};

const executeTransferCreate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
  idempotencyKey,
  actorId,
}) => {
  const parsed = createTransferInputSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_transfer_arguments');
  // Fail-closed actor binding (same contract as the sibling transaction paths).
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  // ONE atomic transfer: the writer creates a single `transfer` row and moves
  // both balance legs inside the same transaction (never two independent
  // expense/income writes). T12c carve-out mirrors expense/income:
  // DomainError is pre-commit validation (same account, unknown/inactive
  // account, credit card, workspace lifecycle) and rethrows deterministic;
  // any other throw may be post-write and stays uncertain for lease recovery.
  let transaction: { id: string };
  try {
    transaction = await writes.createTransfer(workspaceId, parsed.data, {
      idempotencyKey,
      audit: { operation: 'transactions.transfer.create', actorId },
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  const operationId = transaction.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('transactions.transfer.create', operationId, { type: 'transaction', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

const executeAccountCreate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
  idempotencyKey,
  actorId,
}) => {
  const parsed = createAccountInputSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_account_arguments');
  // Fail-closed actor binding (same contract as the transaction paths).
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  // ADR-018 and workspace scoping ride on the existing write path
  // (createAccountInputSchema + WriteStore.createAccount) — never reinvented
  // here. T12c carve-out mirrors the transaction paths: DomainError is
  // pre-commit validation (duplicate name, credit_card negative) and
  // rethrows deterministic; anything else stays uncertain. ted-local.
  // account-idempotency: the write runs keyed on the pending operation's
  // persisted idempotencyKey (WriteStore dedup, same pending-v2 namespace
  // as transactions, no audit leg), so a reconcile re-run after an
  // uncertain outcome replays the original account instead of failing
  // closed on the duplicate-name guard.
  let account: { id: string };
  try {
    account = await writes.createAccount(workspaceId, parsed.data, { idempotencyKey });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  const operationId = account.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('accounts.create', operationId, { type: 'account', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

/**
 * V2-protocol envelope for `accounts.deactivate` (SPEC §7.5). Protocol-level,
 * NOT a WriteStore input shape (the writer takes only `(householdId, id)`),
 * so it lives here rather than in writes/types.ts:
 * - `accountId` is the ONLY execution key (UUID);
 * - `accountName`/`accountKind`/`balanceCents` are display-only snapshots
 *   for the approval card (hash-bound at propose, never read by the
 *   executor — a divergent name never redirects the mutation).
 * Strict: unknown fields fail closed at propose (422 approval.invalid_args).
 */
export const deactivateAccountArgsSchema = z
  .object({
    accountId: z.string().uuid(),
    accountName: z.string().trim().min(1).max(120).optional(),
    accountKind: z.string().trim().min(1).max(32).optional(),
    balanceCents: z.number().int().optional(),
  })
  .strict();

export type DeactivateAccountArgs = z.infer<typeof deactivateAccountArgsSchema>;

const executeAccountDeactivate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
  actorId,
}) => {
  const parsed = deactivateAccountArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_deactivate_arguments');
  // Fail-closed actor binding (same contract as the transaction paths).
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  // The ONLY execution key is the canonical accountId — display-only extras
  // (accountName/accountKind/balanceCents) are never consulted below.
  const accountId = parsed.data.accountId;
  // Deactivate converges (no duplicate-row class: the end state is one
  // inactive account), so no keyed-write machinery is needed — unlike
  // accounts.create, a reconcile re-run after an uncertain outcome must NOT
  // copy the create limitation (duplicate-name guard instead of dedup).
  // `not_found` after the attempt means the account is already inactive —
  // either by our own pre-TX2 write (crash window) or by a concurrent
  // same-effect path — so the intent is satisfied and the executor returns
  // success with the key id. Reachability bound: execute is gated by the
  // confirm presentation check (server-resolved account label, 409 when the
  // account is unknown) and the authorize route policy-blocks this
  // manual-only tool, so a never-existing id cannot arrive here through the
  // API. Any other DomainError (in_use, workspace lifecycle) rethrows
  // deterministic; non-domain throws stay uncertain for lease recovery.
  let deactivated: { id: string };
  try {
    deactivated = await writes.deactivateAccount(workspaceId, accountId);
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === 'not_found') {
        deactivated = { id: accountId };
      } else {
        throw err;
      }
    } else {
      throw createApprovalExecutionUncertainError();
    }
  }
  const operationId = deactivated.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('accounts.deactivate', operationId, { type: 'account', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

/**
 * V2-protocol envelope for `accounts.update` (rename-only, ADR-029).
 * Nome-only: alvo UUID autoritativo + novo nome (trim 1..120) + nome
 * canônico anterior como precondição exata. Strict: unknown fields fail
 * closed at propose (approval.invalid_args).
 */
export const renameAccountArgsSchema = z
  .object({
    accountId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    expectedName: z.string().trim().min(1).max(120),
  })
  .strict();

export type RenameAccountArgs = z.infer<typeof renameAccountArgsSchema>;

/**
 * V2-protocol envelope for `categories.create` (manual-only).
 * Strict subset of the writer shape (writes/types.ts): only `name`,
 * `kind` (`expense`|`income`) and optional `parentId`. Display-only
 * extras (icon/color/sortOrder/isDefault) are rejected at propose
 * (approval.invalid_args) — never invented, never defaulted.
 */
export const createCategoryArgsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(['expense', 'income']),
    parentId: z.string().uuid().optional(),
  })
  .strict();

export type CreateCategoryArgs = z.infer<typeof createCategoryArgsSchema>;

/**
 * V2-protocol envelope for `categories.update` (rename-only, name-only).
 * Strict: categoryId (UUID) + new name + expectedName precondition.
 */
export const renameCategoryArgsSchema = z
  .object({
    categoryId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    expectedName: z.string().trim().min(1).max(120),
  })
  .strict();

export type RenameCategoryArgs = z.infer<typeof renameCategoryArgsSchema>;

/** Manual-only deactivation, bound to the canonical category name at propose time. */
export const deactivateCategoryArgsSchema = z.object({
  categoryId: z.string().uuid(),
  expectedName: z.string().trim().min(1).max(120),
}).strict();

export type DeactivateCategoryArgs = z.infer<typeof deactivateCategoryArgsSchema>;

/** Manual-only, description-only transaction edit with an exact CAS value. */
export const editTransactionDescriptionArgsSchema = z.object({
  transactionId: z.string().uuid(),
  description: z.string().trim().min(1).max(240),
  expectedDescription: z.string().min(1).max(240).refine((value) => value.trim().length > 0),
}).strict();

const executeTransactionDescriptionUpdate: ApprovalToolExecutor = async ({ writes, workspaceId, args, idempotencyKey, actorId }) => {
  const parsed = editTransactionDescriptionArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_transaction_description_arguments');
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  let transaction: { id: string };
  try {
    transaction = await writes.editTransactionDescription(workspaceId, parsed.data, { idempotencyKey, actorId });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('transactions.update', transaction.id, { type: 'transaction', id: transaction.id });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return { status: 'succeeded', operationId: transaction.id, receipt };
};

const executeCategoryCreate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
  idempotencyKey,
  actorId,
}) => {
  const parsed = createCategoryArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_category_arguments');
  // Fail-closed actor binding (same contract as the sibling V2 paths).
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  // The write runs keyed on the pending operation's persisted idempotencyKey
  // (WriteStore dedup, same pending-v2 namespace as accounts.create — no
  // audit leg). A reconcile re-run after an uncertain outcome replays the
  // original category instead of failing closed on the duplicate-name guard.
  // T12c carve-out mirrors the sibling paths: DomainError is pre-commit
  // validation (duplicate name, foreign parent, kind mismatch) and rethrows
  // deterministic; anything else stays uncertain.
  let category: { id: string };
  try {
    category = await writes.createCategory(workspaceId, parsed.data, { idempotencyKey });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  const operationId = category.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('categories.create', operationId, { type: 'category', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

const executeCategoryUpdate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
  idempotencyKey,
}) => {
  const parsed = renameCategoryArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_rename_arguments');
  let category: { id: string };
  try {
    category = await writes.updateCategory(
      workspaceId,
      parsed.data.categoryId,
      { name: parsed.data.name },
      { idempotencyKey, expectedName: parsed.data.expectedName },
    );
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  const operationId = category.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('categories.update', operationId, { type: 'category', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

const executeCategoryDeactivate: ApprovalToolExecutor = async ({ writes, workspaceId, args, idempotencyKey }) => {
  const parsed = deactivateCategoryArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_deactivate_arguments');
  let category: { id: string };
  try {
    category = await writes.deactivateCategory(workspaceId, parsed.data.categoryId, {
      idempotencyKey,
      expectedName: parsed.data.expectedName,
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('categories.deactivate', category.id, { type: 'category', id: category.id });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return { status: 'succeeded', operationId: category.id, receipt };
};

const executeAccountUpdate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
  idempotencyKey,
  actorId,
}) => {
  const parsed = renameAccountArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_rename_arguments');
  // Fail-closed actor binding (same contract as the other V2 paths).
  if (typeof actorId !== 'string' || actorId.length === 0) throw new Error('validation.invalid_actor');
  // The write runs keyed on the pending operation's persisted idempotencyKey
  // with the atomic expectedName before-condition; a reconcile re-run after
  // an uncertain outcome replays the recorded rename instead of re-applying
  // it. T12c carve-out mirrors the sibling paths: DomainError is pre-commit
  // validation (not_found/invalid/name_conflict) and rethrows deterministic;
  // anything else stays uncertain. No audit leg (account tools never audit).
  let account: { id: string };
  try {
    // ADR-029: keyed payload carries tool+args so an update record can never
    // collide with a create record under the same pending-v2 namespace.
    account = await writes.updateAccount(
      workspaceId,
      parsed.data.accountId,
      { name: parsed.data.name },
      { idempotencyKey, expectedName: parsed.data.expectedName },
    );
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  const operationId = account.id;
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('accounts.update', operationId, { type: 'account', id: operationId });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return {
    status: 'succeeded' as const,
    operationId,
    receipt,
  };
};

/**
 * V2-protocol envelope for `payables.create` (V1 completion, manual-only).
 * Strict subset of the normal POST /payables create contract. The API
 * revalidates the account/category against the workspace at execution.
 */
export const createPayableArgsSchema = z
  .object({
    accountId: z.string().uuid(),
    description: z.string().trim().min(1).max(240),
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    dueDate: isoDateSchema,
    type: z.enum(['one_time', 'recurring']).optional(),
    frequency: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
    endDate: isoDateSchema.optional(),
    reminderDaysBefore: z.number().int().min(0).max(30).optional(),
    notes: z.string().optional(),
    categoryId: z.string().uuid().optional(),
  })
  .strict();

export type CreatePayableArgs = z.infer<typeof createPayableArgsSchema>;

/**
 * V2-protocol envelope for `payables.pay` (V1 completion, manual-only).
 * `payableId` is the ONLY execution key; `description`/`amountCents`/`dueDate`/
 * `accountId` are a hash-bound display snapshot resolved by the runtime from
 * the authoritative payable list, used by the approval card — the executor
 * never reads them.
 */
export const payPayableArgsSchema = z
  .object({
    payableId: z.string().uuid(),
    description: z.string().trim().min(1).max(240),
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    dueDate: isoDateSchema,
    accountId: z.string().uuid(),
    paidDate: isoDateSchema.optional(),
    prepayMonths: z.number().int().min(1).max(24).optional(),
  })
  .strict();

export type PayPayableArgs = z.infer<typeof payPayableArgsSchema>;

const executePayableCreate: ApprovalToolExecutor = async ({
  workspaceId,
  args,
  payableStore,
}) => {
  const parsed = createPayableArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_payable_create_arguments');
  if (!payableStore) throw new Error('validation.payable_store_unavailable');
  let payable: { id: string };
  try {
    payable = await payableStore.createPayable(workspaceId, {
      accountId: parsed.data.accountId,
      description: parsed.data.description,
      amountCents: parsed.data.amountCents,
      dueDate: parsed.data.dueDate,
      ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
      ...(parsed.data.frequency !== undefined ? { frequency: parsed.data.frequency } : {}),
      ...(parsed.data.endDate !== undefined ? { endDate: parsed.data.endDate } : {}),
      ...(parsed.data.reminderDaysBefore !== undefined ? { reminderDaysBefore: parsed.data.reminderDaysBefore } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      ...(parsed.data.categoryId !== undefined ? { categoryId: parsed.data.categoryId } : {}),
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('payables.create', payable.id, { type: 'payable', id: payable.id });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return { status: 'succeeded', operationId: payable.id, receipt };
};

const executePayablePay: ApprovalToolExecutor = async ({
  workspaceId,
  args,
  payableStore,
}) => {
  const parsed = payPayableArgsSchema.safeParse(args);
  if (!parsed.success) throw new Error('validation.invalid_payable_pay_arguments');
  if (!payableStore) throw new Error('validation.payable_store_unavailable');
  const snapshot = parsed.data;
  // The display snapshot is hash-bound to the proposal; it must still match
  // the authoritative payable before any money moves. A stale/forged card
  // fails closed instead of debiting a different bill/account.
  const payables = await payableStore.listPayables(workspaceId);
  const target = payables.find((payable) => payable.id === snapshot.payableId);
  if (!target) throw new DomainError('not_found', 'Conta a pagar não encontrada', 404);
  if (
    target.accountId !== snapshot.accountId ||
    target.amountCents !== snapshot.amountCents ||
    target.description !== snapshot.description ||
    target.dueDate !== snapshot.dueDate
  ) {
    throw new DomainError('validation.invalid', 'Os dados da conta a pagar mudaram; refaça a proposta.', 409);
  }
  // Already paid (concurrent/reconciled effect): the intent outcome is
  // satisfied — converge with the same entity id, never a second payment.
  if (target.status === 'paid') {
    let receipt: MutationReceipt;
    try {
      receipt = buildTedReceipt('payables.pay', target.id, { type: 'payable', id: target.id });
    } catch {
      throw createApprovalExecutionUncertainError();
    }
    return { status: 'succeeded', operationId: target.id, receipt };
  }
  let payable: { id: string };
  try {
    // The display snapshot never reaches the store: only the payable id and
    // the payment inputs execute.
    payable = await payableStore.markPayablePaid(workspaceId, snapshot.payableId, {
      ...(snapshot.paidDate !== undefined ? { paidDate: snapshot.paidDate } : {}),
      ...(snapshot.prepayMonths !== undefined ? { prepayMonths: snapshot.prepayMonths } : {}),
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw createApprovalExecutionUncertainError();
  }
  let receipt: MutationReceipt;
  try {
    receipt = buildTedReceipt('payables.pay', payable.id, { type: 'payable', id: payable.id });
  } catch {
    throw createApprovalExecutionUncertainError();
  }
  return { status: 'succeeded', operationId: payable.id, receipt };
};

const CONTRACTS: Record<ApprovalToolId, ApprovalToolContract> = {
  'cards.purchase.create': {
    tool: 'cards.purchase.create',
    inputSchema: createCardPurchaseArgsSchema,
    approvalRequired: true,
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: false,
    executor: executeCardPurchaseCreate,
  },
  'cards.statement.pay': {
    tool: 'cards.statement.pay',
    inputSchema: payStatementArgsSchema,
    approvalRequired: true,
    authorizationPolicy: 'risk_based',
    // Money movement is always human-confirmed; never auto-executed.
    autoExecutionEligible: false,
    executor: executeCardStatementPay,
  },
  'transactions.expense.create': {
    tool: 'transactions.expense.create',
    inputSchema: createExpenseInputSchema,
    approvalRequired: true, // Legacy declarative metadata; human confirmation is conditional via ADR-026.
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('transactions.expense.create'),
    executor: executeExpenseCreate,
  },
  'transactions.income.create': {
    tool: 'transactions.income.create',
    inputSchema: createIncomeInputSchema,
    approvalRequired: true, // Legacy declarative metadata; human confirmation is conditional via ADR-026.
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('transactions.income.create'),
    executor: executeIncomeCreate,
  },
  'transactions.transfer.create': {
    tool: 'transactions.transfer.create',
    inputSchema: createTransferInputSchema,
    approvalRequired: true, // Manual-only: internal transfers are never auto-executed.
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('transactions.transfer.create'),
    executor: executeTransferCreate,
  },
  'transactions.update': {
    tool: 'transactions.update',
    inputSchema: editTransactionDescriptionArgsSchema,
    approvalRequired: true,
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: false,
    executor: executeTransactionDescriptionUpdate,
  },
  'accounts.create': {
    tool: 'accounts.create',
    inputSchema: createAccountInputSchema,
    approvalRequired: true, // Manual-only: never auto-executed (not in AUTOEXECUTION_ELIGIBLE_TOOLS).
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('accounts.create'),
    executor: executeAccountCreate,
  },
  'accounts.deactivate': {
    tool: 'accounts.deactivate',
    inputSchema: deactivateAccountArgsSchema,
    approvalRequired: true, // Manual-only: never auto-executed (not in AUTOEXECUTION_ELIGIBLE_TOOLS).
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('accounts.deactivate'),
    executor: executeAccountDeactivate,
  },
  'accounts.update': {
    tool: 'accounts.update',
    inputSchema: renameAccountArgsSchema,
    approvalRequired: true, // Manual-only: never auto-executed (not in AUTOEXECUTION_ELIGIBLE_TOOLS).
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('accounts.update'),
    executor: executeAccountUpdate,
  },
  'categories.create': {
    tool: 'categories.create',
    inputSchema: createCategoryArgsSchema,
    approvalRequired: true, // Manual-only: never auto-executed (not in AUTOEXECUTION_ELIGIBLE_TOOLS).
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('categories.create'),
    executor: executeCategoryCreate,
  },
  'categories.update': {
    tool: 'categories.update',
    inputSchema: renameCategoryArgsSchema,
    approvalRequired: true, // Manual-only: never auto-executed (not in AUTOEXECUTION_ELIGIBLE_TOOLS).
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('categories.update'),
    executor: executeCategoryUpdate,
  },
  'categories.deactivate': {
    tool: 'categories.deactivate',
    inputSchema: deactivateCategoryArgsSchema,
    approvalRequired: true,
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('categories.deactivate'),
    executor: executeCategoryDeactivate,
  },
  'payables.create': {
    tool: 'payables.create',
    inputSchema: createPayableArgsSchema,
    approvalRequired: true, // Manual-only: payable creation is never auto-executed.
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: false,
    executor: executePayableCreate,
  },
  'payables.pay': {
    tool: 'payables.pay',
    inputSchema: payPayableArgsSchema,
    approvalRequired: true, // Manual-only: payable payment is never auto-executed.
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: false,
    executor: executePayablePay,
  },
};

export const getApprovalToolContract = (tool: string): ApprovalToolContract | undefined =>
  (CONTRACTS as Record<string, ApprovalToolContract>)[tool];

export const requireApprovalToolContract = (tool: string): ApprovalToolContract => {
  const contract = getApprovalToolContract(tool);
  if (!contract) throw createToolNotAllowedError();
  return contract;
};

export type ApprovalToolArgsValidation =
  | { success: true; data: unknown }
  | { success: false; code: 'tool.not_allowed' | 'validation.invalid_arguments'; issues?: unknown };

export const validateApprovalToolArgs = (
  tool: string,
  args: unknown,
): ApprovalToolArgsValidation => {
  const contract = getApprovalToolContract(tool);
  if (!contract) return { success: false, code: 'tool.not_allowed' };
  const parsed = contract.inputSchema.safeParse(args);
  if (!parsed.success) {
    return { success: false, code: 'validation.invalid_arguments', issues: parsed.error.issues };
  }
  return { success: true, data: parsed.data };
};
