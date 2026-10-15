/**
 * Command boundary — isolates the write side of the AppState provider.
 *
 * Every UI mutation (create/update/delete/pay) is wrapped by `createCommands`,
 * which enforces the offline invariant: when `online === false`, a command
 * throws `OfflineWriteError` immediately — zero network request and zero
 * optimistic state mutation. When `online === true`, the command delegates
 * to the `api` (endpoints module) and dispatches `CLEAR_WRITE_ERROR` on
 * success so a stale prior write error does not linger.
 *
 * Client command ID lifecycle (V4.1 Tasks 3.8-3.9, SPEC §10.5): the
 * idempotency key is a per-INTENT command id, not a per-HTTP-attempt id.
 * Each command invocation stamps exactly one id onto the logical command
 * (caller-provided ids win verbatim) BEFORE the first attempt, and the
 * guarded executor reuses that SAME id on automatic retries after network
 * drops, timeouts, 5xx and `idempotency.in_progress` (unknown outcome, same
 * key replay). Definitive 4xx rejections — including every other 409
 * (domain refusals, divergent-payload idempotency conflicts, FIX-184) — are
 * never blind-retried: they propagate to the existing
 * error handling. A manual retry after an unknown outcome reuses the id by
 * passing it back via the input's `idempotencyKey` (or the trailing
 * `CommandIdOptions` on id-only commands); a retry after a definitive
 * result is a new intent and mints a new id.
 *
 * The factory preserves the original endpoint signatures verbatim
 * ("preserve idempotency argument unchanged") so call-sites can swap the
 * provider's inline `endpoints.x(...)` for `commands.x(...)` with no
 * argument-shape changes; id-only commands accept an optional trailing
 * `CommandIdOptions` for intent-id reuse (additive, backwards compatible).
 */
import type { AppStateAction } from "./state-reducer";
import type {
  Account, Budget, Category, Goal, Payable, Subscription, Transaction, CardStatement,
} from "./types";
import type { ReceiptCarryingItems, DeletedTransaction } from "@/lib/api/endpoints";
import * as endpoints from "@/lib/api/endpoints";
import {
  ensureCommandId,
  attachCommandId,
  newCommandId,
  isRetryableMutationError,
  MAX_COMMAND_ATTEMPTS,
} from "@/lib/api/command-id";

/**
 * Thrown by every command when the session cannot reach the API.
 * Carries no payload — callers match by `instanceof` (or `name`)
 * to distinguish offline from network/server errors.
 */
export class OfflineWriteError extends Error {
  constructor(methodName: string) {
    super(`${methodName} blocked: offline (no API or no token)`);
    this.name = "OfflineWriteError";
  }
}

export interface CommandsContext {
  /** Whether writes are currently permitted (API configured + token present). */
  online: boolean;
  /** Auth token captured at command-creation time; null/undefined when offline. */
  token: string | undefined;
  /** Reducer dispatch (used to clear stale write errors on success). */
  dispatch: (action: AppStateAction) => void;
  /** Endpoints module — the real network side. */
  api: typeof endpoints;
  /** Optional dirty-track callback: call before write, run its return on success. */
  trackWrite?: () => () => void;
}

export interface TransactionCreateInput {
  description: string;
  amountCents: number;
  date: string;
  categoryId: string;
  accountId: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface TransactionUpdateInput {
  description?: string;
  date?: string;
  amountCents?: number;
  accountId?: string;
  categoryId?: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface TransferInput {
  description: string;
  amountCents: number;
  date: string;
  fromAccountId: string;
  toAccountId: string;
  idempotencyKey?: string;
}

export interface PayableInput {
  accountId: string;
  description: string;
  amountCents: number;
  dueDate: string;
  categoryId?: string;
  idempotencyKey?: string;
}

export interface PayableUpdateInput {
  description?: string;
  amountCents?: number;
  dueDate?: string;
  accountId?: string;
  categoryId?: string;
  idempotencyKey?: string;
}

export interface BudgetInput {
  categoryId: string;
  name: string;
  amountCents: number;
  period: "monthly" | "quarterly" | "yearly";
  startDate: string;
  idempotencyKey?: string;
}

export interface BudgetUpdateInput {
  amountCents?: number;
  alertThreshold?: number;
  idempotencyKey?: string;
}

export interface GoalInput {
  name: string;
  goalType: "savings" | "purchase" | "debt_payoff" | "emergency_fund";
  targetAmountCents: number;
  startDate: string;
  idempotencyKey?: string;
}

export interface GoalUpdateInput {
  name?: string;
  targetAmountCents?: number;
  targetDate?: string;
  idempotencyKey?: string;
}

export interface AccountInput {
  name: string;
  kind: "bank" | "cash" | "credit_card";
  initialBalanceCents: number;
  idempotencyKey?: string;
}

export interface CategoryInput {
  name: string;
  kind: "expense" | "income";
  parentId?: string;
  icon?: string | null;
  color?: string | null;
  idempotencyKey?: string;
}

export interface CategoryUpdateInput {
  name?: string;
  icon?: string | null;
  color?: string | null;
  idempotencyKey?: string;
}

export type CategoryDeleteInput =
  | { mode: "move"; destinationCategoryId: string; idempotencyKey?: string }
  | { mode: "cascade"; confirm: true; idempotencyKey?: string };

export interface CategoryDeleteResult {
  ok: boolean;
  deletedCategoryIds: string[];
  movedTransactions: number;
  softDeletedTransactions: number;
}

/**
 * Optional trailing argument on id-only commands (V4.1 Task 3.9): lets a
 * manual retry after an unknown outcome reuse the original intent's command
 * id instead of minting a new one. Omit it for a new intent.
 */
export interface CommandIdOptions {
  idempotencyKey?: string;
}

export interface CategoryDefaultsResult {
  ok: boolean;
  created: number;
  skipped: number;
}

export interface CardInput {
  name: string;
  creditLimitCents: number;
  closingDay: number;
  dueDay: number;
  idempotencyKey?: string;
}

export interface CardUpdateInput {
  name?: string;
  creditLimitCents?: number;
  closingDay?: number;
  dueDay?: number;
  idempotencyKey?: string;
}

export interface SubscriptionInput {
  name: string;
  amountCents: number;
  cycle: "monthly" | "yearly" | "weekly";
  day: number;
  paymentMethod: string;
  idempotencyKey?: string;
}

export interface SubscriptionUpdateInput {
  name?: string;
  amountCents?: number;
  cycle?: "monthly" | "yearly" | "weekly";
  day?: number;
  paymentMethod?: string;
  idempotencyKey?: string;
}

export interface PayStatementInput {
  amountCents: number;
  fromAccountId: string;
  idempotencyKey?: string;
}

export interface InstallmentsInput {
  accountId: string;
  description: string;
  totalAmountCents: number;
  purchaseDate: string;
  installmentsTotal: number;
  categoryId?: string;
  subcategoryId?: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface CardPurchaseInput {
  accountId: string;
  description: string;
  amountCents: number;
  date: string;
  categoryId?: string;
  subcategoryId?: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface ProfileInput {
  name?: string;
  email?: string;
  phone?: string;
  avatarColor?: string;
  greetingStyle?: "auto" | "minimal" | "verbose";
  idempotencyKey?: string;
}

/**
 * The full command surface. The provider exposes a subset via the AppState
 * facade; this object is the canonical write seam.
 */
export interface Commands {
  // ── Transactions (create / update / delete / transfer) ─────────
  createExpenseTransaction(input: TransactionCreateInput): Promise<Transaction>;
  createIncomeTransaction(input: TransactionCreateInput): Promise<Transaction>;
  updateTransaction(id: string, input: TransactionUpdateInput): Promise<Transaction>;
  deleteTransaction(id: string, options?: CommandIdOptions): Promise<DeletedTransaction>;
  createTransfer(input: TransferInput): Promise<Transaction>;

  // ── Accounts (create / update / deactivate) ────────────────────
  addAccount(input: AccountInput): Promise<Account>;
  updateAccount(id: string, input: { name: string }): Promise<Account>;
  deactivateAccount(id: string, options?: CommandIdOptions): Promise<void>;

  // ── Categories (create / update / deactivate) ──────────────────
  addCategory(input: CategoryInput): Promise<Category>;
  updateCategory(id: string, input: CategoryUpdateInput): Promise<Category>;
  deactivateCategory(id: string, options?: CommandIdOptions): Promise<void>;
  deleteCategory(id: string, input: CategoryDeleteInput): Promise<CategoryDeleteResult>;
  applyCategoryDefaults(options?: CommandIdOptions): Promise<CategoryDefaultsResult>;

  // ── Cards (credit) ─────────────────────────────────────────────
  createCard(input: CardInput): Promise<Account>;
  updateCard(id: string, input: CardUpdateInput): Promise<Account>;

  // ── Payables (create / markPaid / undo / cancel / update) ──────
  createPayable(input: PayableInput): Promise<Payable>;
  markPayablePaid(id: string, paidDate: string, options?: CommandIdOptions): Promise<Payable>;
  undoPayablePayment(id: string, paidTransactionId: string, options?: CommandIdOptions): Promise<Payable>;
  cancelPayable(id: string, options?: CommandIdOptions): Promise<Payable>;
  updatePayable(id: string, input: PayableUpdateInput): Promise<Payable>;

  // ── Budgets (create / update) ──────────────────────────────────
  createBudget(input: BudgetInput): Promise<Budget>;
  updateBudget(id: string, input: BudgetUpdateInput): Promise<Budget>;

  // ── Goals (create / contribute / cancel / update) ──────────────
  createGoal(input: GoalInput): Promise<Goal>;
  contributeToGoal(id: string, input: { amountCents: number }): Promise<Goal>;
  cancelGoal(id: string, options?: CommandIdOptions): Promise<Goal>;
  updateGoal(id: string, input: GoalUpdateInput): Promise<Goal>;

  // ── Subscriptions (create / cancel / update) ───────────────────
  addSubscription(input: SubscriptionInput): Promise<Subscription>;
  cancelSubscription(id: string, options?: CommandIdOptions): Promise<Subscription>;
  updateSubscription(id: string, input: SubscriptionUpdateInput): Promise<Subscription>;

  // ── Statements / Installments ──────────────────────────────────
  // FIX-P1: the card-write values carry the server receipt additively
  // (ReceiptCarryingItems) and are returned untouched, so the existing
  // `reconcileAfterWrite` mechanism (extractMutationReceipt → receipt wins,
  // mutationKind fallback) consumes the real receipt with no API change.
  payStatement(statementId: string, input: PayStatementInput): Promise<CardStatement>;
  createInstallments(input: InstallmentsInput): Promise<ReceiptCarryingItems<Transaction>>;
  createCardPurchase(input: CardPurchaseInput): Promise<ReceiptCarryingItems<Transaction>>;

  // ── Profile patch ──────────────────────────────────────────────
  patchProfile(input: ProfileInput): Promise<unknown>;
}

/**
 * Wrap a network call so it short-circuits to `OfflineWriteError` when the
 * session is offline, and clears any stale write error on success.
 *
 * V4.1 Task 3.9: the same logical command (already carrying its intent
 * command id — see the `ensureCommandId` / `commandId` bindings in
 * `buildCommands`) is re-attempted on retryable failures (network drop,
 * timeout, 5xx, `idempotency.in_progress` — FIX-184), bounded by
 * MAX_COMMAND_ATTEMPTS. Definitive 4xx rejections and definitive
 * idempotency/domain 409 conflicts propagate untouched to the existing error
 * handling — a manual retry after a definitive result is a new intent.
 *
 * Finding 2: the intent's command id is attached to the surfaced error once
 * automatic retries are exhausted (see `attachCommandId`), so a manual retry
 * after an unknown outcome can reuse it via the input's `idempotencyKey`
 * (or the trailing `CommandIdOptions` on id-only commands) — read it back
 * with `getFailedCommandId`.
 */
function guarded<T>(
  methodName: string,
  ctx: CommandsContext,
  fn: () => Promise<T>,
  commandId?: string,
): Promise<T> {
  if (!ctx.online) return Promise.reject(attachCommandId(new OfflineWriteError(methodName), commandId));
  // Track dirty state — cleanup on success, retain on failure
  const cleanup = ctx.trackWrite?.();
  const attempt = (retriesLeft: number): Promise<T> =>
    fn().then(
      (value) => {
        ctx.dispatch({ type: "CLEAR_WRITE_ERROR" });
        cleanup?.();
        return value;
      },
      (e) => {
        // On failure: do NOT cleanup — retain dirty state so the UI knows
        // there's a pending/incomplete write. The user must retry or cancel.
        // Retryable unknown-outcome failures re-run the SAME command closure,
        // which already carries the intent's command id (no new id minted).
        // FIX-184: the retry policy is authoritative in
        // `isRetryableMutationError` — definitive 409s (domain refusals,
        // divergent-payload idempotency conflicts) are never retryable there,
        // while `idempotency.in_progress` (unknown outcome) replays the same
        // key. No separate 409 gate: status alone must never decide.
        if (retriesLeft > 0 && isRetryableMutationError(e)) {
          return attempt(retriesLeft - 1);
        }
        throw attachCommandId(e, commandId);
      },
    );
  return attempt(MAX_COMMAND_ATTEMPTS - 1);
}

/**
 * Build the full command surface bound to the given context (online/token/
 * dispatch/api). The returned object is the canonical seam for all UI writes;
 * the provider composes it with optimistic React-state mutation and rollback.
 *
 * Every command is wrapped with an in-flight double-submit guard: while a
 * mutation is pending, an identical re-invocation (same command + same
 * arguments) reuses the same promise instead of firing a duplicate write.
 */
export function createCommands(ctx: CommandsContext): Commands {
  const inflightWrites = new Map<string, Promise<unknown>>();
  const impl = buildCommands(ctx);
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(impl)) {
    wrapped[name] = (...args: unknown[]) => {
      const dedupeKey = `${name}:${JSON.stringify(args)}`;
      const pending = inflightWrites.get(dedupeKey);
      if (pending) return pending;
      const promise = (fn as (...a: unknown[]) => Promise<unknown>)(...args)
        .finally(() => {
          inflightWrites.delete(dedupeKey);
        });
      inflightWrites.set(dedupeKey, promise);
      return promise;
    };
  }
  return wrapped as unknown as Commands;
}

function buildCommands(ctx: CommandsContext): Commands {
  const a = ctx.api;
  return {
    // ── Transactions ─────────────────────────────────────────────
    createExpenseTransaction(input) {
      // Task 3.8: the command id is created ONCE here, at the intent
      // boundary — before the first attempt — so every automatic retry of
      // this logical command reuses it (Task 3.9).
      const command = ensureCommandId(input);
      return guarded("createExpenseTransaction", ctx, () =>
        a.createExpenseTransaction(command),
        command.idempotencyKey,
      );
    },
    createIncomeTransaction(input) {
      const command = ensureCommandId(input);
      return guarded("createIncomeTransaction", ctx, () =>
        a.createIncomeTransaction(command),
        command.idempotencyKey,
      );
    },
    updateTransaction(id, input) {
      const command = ensureCommandId(input);
      return guarded("updateTransaction", ctx, () =>
        a.updateTransaction(id, command),
        command.idempotencyKey,
      );
    },
    deleteTransaction(id, options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("deleteTransaction", ctx, () => a.deleteTransaction(id, commandId), commandId);
    },
    createTransfer(input) {
      const command = ensureCommandId(input);
      return guarded("createTransfer", ctx, () => a.createTransfer(command), command.idempotencyKey);
    },

    // ── Accounts ─────────────────────────────────────────────────
    addAccount(input) {
      const command = ensureCommandId(input);
      return guarded("addAccount", ctx, () => a.addAccount(command), command.idempotencyKey);
    },
    updateAccount(id, input) {
      const command = ensureCommandId(input);
      return guarded("updateAccount", ctx, () => a.updateAccount(id, command), command.idempotencyKey);
    },
    deactivateAccount(id, options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("deactivateAccount", ctx, () => a.deactivateAccount(id, commandId), commandId);
    },

    // ── Categories ───────────────────────────────────────────────
    addCategory(input) {
      const command = ensureCommandId(input);
      return guarded("addCategory", ctx, () => a.addCategory(command), command.idempotencyKey);
    },
    updateCategory(id, input) {
      const command = ensureCommandId(input);
      return guarded("updateCategory", ctx, () => a.updateCategory(id, command), command.idempotencyKey);
    },
    deactivateCategory(id, options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("deactivateCategory", ctx, () => a.deactivateCategory(id, commandId), commandId);
    },
    deleteCategory(id, input) {
      const command = ensureCommandId(input);
      return guarded("deleteCategory", ctx, () => a.deleteCategory(id, command), command.idempotencyKey);
    },
    applyCategoryDefaults(options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("applyCategoryDefaults", ctx, () => a.applyCategoryDefaults(commandId), commandId);
    },

    // ── Cards ────────────────────────────────────────────────────
    createCard(input) {
      const command = ensureCommandId(input);
      return guarded("createCard", ctx, () => a.createCard(command), command.idempotencyKey);
    },
    updateCard(id, input) {
      const command = ensureCommandId(input);
      return guarded("updateCard", ctx, () => a.updateCard(id, command), command.idempotencyKey);
    },

    // ── Payables ─────────────────────────────────────────────────
    createPayable(input) {
      const command = ensureCommandId(input);
      return guarded("createPayable", ctx, () => a.createPayable(command), command.idempotencyKey);
    },
    markPayablePaid(id, paidDate, options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("markPayablePaid", ctx, () =>
        a.markPayablePaid(id, paidDate, commandId),
        commandId,
      );
    },
    undoPayablePayment(id, paidTransactionId, options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("undoPayablePayment", ctx, () =>
        a.undoPayablePayment(id, paidTransactionId, commandId),
        commandId,
      );
    },
    cancelPayable(id, options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("cancelPayable", ctx, () => a.cancelPayable(id, undefined, commandId), commandId);
    },
    updatePayable(id, input) {
      const command = ensureCommandId(input);
      return guarded("updatePayable", ctx, () => a.updatePayable(id, command), command.idempotencyKey);
    },

    // ── Budgets ──────────────────────────────────────────────────
    createBudget(input) {
      const command = ensureCommandId(input);
      return guarded("createBudget", ctx, () => a.createBudget(command), command.idempotencyKey);
    },
    updateBudget(id, input) {
      const command = ensureCommandId(input);
      return guarded("updateBudget", ctx, () => a.updateBudget(id, command), command.idempotencyKey);
    },

    // ── Goals ────────────────────────────────────────────────────
    createGoal(input) {
      const command = ensureCommandId(input);
      return guarded("createGoal", ctx, () => a.createGoal(command), command.idempotencyKey);
    },
    contributeToGoal(id, input) {
      const command = ensureCommandId(input);
      return guarded("contributeToGoal", ctx, () =>
        a.contributeToGoal(id, command),
        command.idempotencyKey,
      );
    },
    cancelGoal(id, options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("cancelGoal", ctx, () => a.cancelGoal(id, commandId), commandId);
    },
    updateGoal(id, input) {
      const command = ensureCommandId(input);
      return guarded("updateGoal", ctx, () => a.updateGoal(id, command), command.idempotencyKey);
    },

    // ── Subscriptions ────────────────────────────────────────────
    addSubscription(input) {
      const command = ensureCommandId(input);
      return guarded("addSubscription", ctx, () => a.addSubscription(command), command.idempotencyKey);
    },
    cancelSubscription(id, options) {
      const commandId = options?.idempotencyKey ?? newCommandId();
      return guarded("cancelSubscription", ctx, () => a.cancelSubscription(id, commandId), commandId);
    },
    updateSubscription(id, input) {
      const command = ensureCommandId(input);
      return guarded("updateSubscription", ctx, () =>
        a.updateSubscription(id, command),
        command.idempotencyKey,
      );
    },

    // ── Statements / Installments ───────────────────────────────
    payStatement(statementId, input) {
      const command = ensureCommandId(input);
      return guarded("payStatement", ctx, () =>
        a.payStatement(statementId, command),
        command.idempotencyKey,
      );
    },
    createInstallments(input) {
      const command = ensureCommandId(input);
      return guarded("createInstallments", ctx, () =>
        a.createInstallments(command),
        command.idempotencyKey,
      );
    },
    createCardPurchase(input) {
      const command = ensureCommandId(input);
      return guarded("createCardPurchase", ctx, () =>
        a.createCardPurchase(command),
        command.idempotencyKey,
      );
    },

    // ── Profile ──────────────────────────────────────────────────
    patchProfile(input) {
      const command = ensureCommandId(input);
      return guarded("patchProfile", ctx, () => a.patchProfile(command), command.idempotencyKey);
    },
  };
}
