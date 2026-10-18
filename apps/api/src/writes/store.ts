/**
 * WriteStore — interface for mutating V1 financial data.
 *
 * Every method receives `householdId` server-derived from the device
 * token. The store enforces that the entity exists and belongs to the
 * household. House-rule invariants (e.g. "cannot deactivate account
 * with active transactions") live here so both backends share the
 * same behavior.
 */

import type { PoolClient } from 'pg';
import type { Account, Category, Transaction } from '../types/domain.js';
import type {
  CreateAccountInput,
  CreateCategoryInput,
  CreateExpenseInput,
  CreateIncomeInput,
  CreateTransferInput,
  DeleteCategoryInput,
  UpdateAccountInput,
  UpdateCategoryInput,
  UpdateTransactionInput,
} from './types.js';

export type { Transaction };

export type ApplyDefaultsResult = { created: number; skipped: number };

export type DeleteCategoryResult = {
  deletedCategoryIds: string[];
  movedTransactions: number;
  softDeletedTransactions: number;
};

/**
 * P1 (audit item 7): key-idempotent execution for V2 pending operations.
 *
 * When present, the mutation executes AT MOST ONCE per
 * (household, idempotencyKey): the first call executes and records
 * (key → result); concurrent or repeated calls with the same key and
 * payload return the recorded result without re-executing. Same key
 * with a different payload conflicts (409 idempotency.conflict).
 */
export type WriteIdempotencyOptions = {
  idempotencyKey?: string;
  /**
   * TED Pending-V2 execution audit (bounded, server-side only).
   *
   * When present, the keyed mutation commits claim + financial effect +
   * audit in ONE transaction. `operation` is a closed vocabulary (the two
   * V2 TED tools — never client-derived), `actorId` comes from the
   * server-persisted pending-operation record (never from normalizedArgs).
   * Absent → previous behavior (ledger + record only), unkeyed writes
   * never audit.
   */
  audit?: WriteAuditContext;
};

/**
 * Closed V2 execution-audit vocabulary: exactly the two TED approval tools
 * that execute through keyed writes. The undo reversal vocabulary matches
 * these ids 1:1, so no receipt-kind mapping is needed on this path.
 */
export type V2ToolAuditOperation = 'transactions.expense.create' | 'transactions.income.create';

export type WriteAuditContext = {
  operation: V2ToolAuditOperation;
  actorId: string;
};

export type WriteStore = {
  // accounts
  createAccount(householdId: string, input: CreateAccountInput): Promise<Account>;
  updateAccount(householdId: string, id: string, patch: UpdateAccountInput): Promise<Account>;
  deactivateAccount(householdId: string, id: string): Promise<Account>;

  // categories
  createCategory(householdId: string, input: CreateCategoryInput): Promise<Category>;
  updateCategory(householdId: string, id: string, patch: UpdateCategoryInput): Promise<Category>;
  deactivateCategory(householdId: string, id: string): Promise<Category>;
  /**
   * Hard-removes a macro (and its subs) from the active set. mode 'move'
   * reassigns every referencing transaction to destinationCategoryId;
   * mode 'cascade' (confirm:true required) soft-deletes them instead.
   * Never leaves a transaction pointing at a deactivated category.
   */
  deleteCategory(householdId: string, id: string, input: DeleteCategoryInput): Promise<DeleteCategoryResult>;
  /**
   * Applies the pt-BR default catalog to the household. Idempotent:
   * existing same-kind macros (case-insensitive name match) are reused
   * and counted as skipped with their subs.
   */
  applyCategoryDefaults(householdId: string): Promise<ApplyDefaultsResult>;

  // transactions
  createExpense(householdId: string, input: CreateExpenseInput, options?: WriteIdempotencyOptions): Promise<Transaction>;
  createIncome(householdId: string, input: CreateIncomeInput, options?: WriteIdempotencyOptions): Promise<Transaction>;
  createTransfer(householdId: string, input: CreateTransferInput): Promise<Transaction>;
  updateTransaction(householdId: string, id: string, patch: UpdateTransactionInput): Promise<Transaction>;
  softDeleteTransaction(householdId: string, id: string): Promise<Transaction>;
};

/**
 * T05/T06 — non-contractual client-bound account/category cores of the
 * canonical Postgres write store (see writes/postgres.ts, same member
 * pattern as WriteStoreMutationTxExtensions for transactions).
 *
 * Keyed route producers (see writes/keyed-mutations.ts runAccountMutation /
 * runCategoryMutation) duck-type these and run the effect on the open
 * idempotency claim client, so claim + financial effect + receipt/completion
 * commit atomically in ONE transaction. NOT part of `WriteStore` — existing
 * callers (in-memory, legacy) are unaffected; the dispatch falls back to
 * the plain methods without a claim client and fails closed
 * (`atomicMutationNotSupported`) with a claim client but no extension.
 */
export type WriteStoreAccountCategoryTxExtensions = {
  createAccountInTx(client: PoolClient, householdId: string, input: CreateAccountInput): Promise<Account>;
  updateAccountInTx(client: PoolClient, householdId: string, id: string, patch: UpdateAccountInput): Promise<Account>;
  deactivateAccountInTx(client: PoolClient, householdId: string, id: string): Promise<Account>;
  createCategoryInTx(client: PoolClient, householdId: string, input: CreateCategoryInput): Promise<Category>;
  updateCategoryInTx(client: PoolClient, householdId: string, id: string, patch: UpdateCategoryInput): Promise<Category>;
  deactivateCategoryInTx(client: PoolClient, householdId: string, id: string): Promise<Category>;
  applyCategoryDefaultsInTx(client: PoolClient, householdId: string): Promise<ApplyDefaultsResult>;
  deleteCategoryInTx(client: PoolClient, householdId: string, id: string, input: DeleteCategoryInput): Promise<DeleteCategoryResult>;
};
