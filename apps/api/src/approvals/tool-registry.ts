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
import type { z } from 'zod';
import type { MutationReceipt } from '@pi-finance/llm-contracts';
import { createAccountInputSchema, createExpenseInputSchema, createIncomeInputSchema } from '../writes/types.js';
import { DomainError } from '../writes/errors.js';
import type { WriteStore } from '../writes/store.js';
import { buildTedReceipt } from '../reconciliation/effects-registry.js';
import { AUTOEXECUTION_ELIGIBLE_TOOLS } from './policy.js';

export const APPROVAL_TOOL_IDS = [
  'transactions.expense.create',
  'transactions.income.create',
  'accounts.create',
] as const;

export type ApprovalToolId = (typeof APPROVAL_TOOL_IDS)[number];

export type ApprovalToolExecutionContext = {
  writes: WriteStore;
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

const executeAccountCreate: ApprovalToolExecutor = async ({
  writes,
  workspaceId,
  args,
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
  // rethrows deterministic; anything else stays uncertain. NOTE: account
  // writes carry no idempotencyKey (WriteStore.createAccount takes no
  // keyed options), so a reconcile re-run after an uncertain outcome fails
  // closed on the duplicate-name guard instead of deduping to one row.
  let account: { id: string };
  try {
    account = await writes.createAccount(workspaceId, parsed.data);
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

const CONTRACTS: Record<ApprovalToolId, ApprovalToolContract> = {
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
  'accounts.create': {
    tool: 'accounts.create',
    inputSchema: createAccountInputSchema,
    approvalRequired: true, // Manual-only: never auto-executed (not in AUTOEXECUTION_ELIGIBLE_TOOLS).
    authorizationPolicy: 'risk_based',
    autoExecutionEligible: AUTOEXECUTION_ELIGIBLE_TOOLS.has('accounts.create'),
    executor: executeAccountCreate,
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
