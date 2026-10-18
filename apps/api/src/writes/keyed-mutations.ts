/**
 * V4.1 Phase 3 Tasks 3.2–3.3 — keyed transaction-mutation dispatch.
 *
 * Single-transaction rule (SPEC §10.1–§10.2): when the idempotency layer
 * hands a route producer the open claim transaction client, the financial
 * effect MUST run on that same client — claim + effect + receipt/completion
 * commit together, and any failure rolls everything back. Without a claim
 * client (no `Idempotency-Key` header, or a store without transactions)
 * the plain `WriteStore` methods keep their own boundary: behavior unchanged.
 *
 * Both Postgres write stores (canonical `writes/postgres.ts`, legacy
 * `writes/legacy-postgres.ts`) expose the same `*InTx` member names (see
 * `WriteStoreMutationTxExtensions`); this module duck-types them so routes
 * stay schema-agnostic. In-memory stores have no transaction client, so the
 * synchronous producer call inside the in-memory claim IS the one phase.
 */

import type { PoolClient } from 'pg';
import type { Account, Category, Transaction } from '../types/domain.js';
import type { ApplyDefaultsResult, DeleteCategoryResult, WriteStore } from './store.js';
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
import type { WriteStoreMutationTxExtensions } from './postgres.js';
import type { WriteStoreAccountCategoryTxExtensions } from './store.js';
import { domainErrors } from './errors.js';

/** True when `tx` is an open Postgres claim transaction client. */
export const isTxClient = (tx: unknown): tx is PoolClient =>
  typeof tx === 'object' &&
  tx !== null &&
  typeof (tx as { query?: unknown }).query === 'function';

type SoftDeleteTxExtension = {
  softDeleteTransactionInTx(client: PoolClient, householdId: string, id: string): Promise<Transaction>;
};

const txExtensions = (writes: WriteStore): Partial<WriteStoreMutationTxExtensions & SoftDeleteTxExtension> =>
  writes as unknown as Partial<WriteStoreMutationTxExtensions & SoftDeleteTxExtension>;

export async function runTransactionMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'expense',
  input: CreateExpenseInput,
): Promise<Transaction>;
export async function runTransactionMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'income',
  input: CreateIncomeInput,
): Promise<Transaction>;
export async function runTransactionMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'transfer',
  input: CreateTransferInput,
): Promise<Transaction>;
export async function runTransactionMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'update',
  input: { id: string; patch: UpdateTransactionInput },
): Promise<Transaction>;
export async function runTransactionMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'softDelete',
  input: { id: string },
): Promise<Transaction>;
export async function runTransactionMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'expense' | 'income' | 'transfer' | 'update' | 'softDelete',
  input: CreateExpenseInput | CreateIncomeInput | CreateTransferInput | { id: string; patch?: UpdateTransactionInput },
): Promise<Transaction> {
  if (isTxClient(claimTx)) {
    const ext = txExtensions(writes);
    // V4.1 Phase 4 (fail-closed): with an open claim tx the effect MUST run
    // on that client. A missing `*InTx` extension is an invariant error —
    // never a plain fallback (the effect would commit outside the claim tx).
    switch (op) {
      case 'expense':
        if (typeof ext.createExpenseInTx === 'function') {
          return ext.createExpenseInTx(claimTx, householdId, input as CreateExpenseInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'income':
        if (typeof ext.createIncomeInTx === 'function') {
          return ext.createIncomeInTx(claimTx, householdId, input as CreateIncomeInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'transfer':
        if (typeof ext.createTransferInTx === 'function') {
          return ext.createTransferInTx(claimTx, householdId, input as CreateTransferInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'update':
        if (typeof ext.updateTransactionInTx === 'function') {
          const { id, patch } = input as { id: string; patch: UpdateTransactionInput };
          return ext.updateTransactionInTx(claimTx, householdId, id, patch);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'softDelete':
        if (typeof ext.softDeleteTransactionInTx === 'function') {
          return ext.softDeleteTransactionInTx(claimTx, householdId, (input as { id: string }).id);
        }
        throw domainErrors.atomicMutationNotSupported();
    }
  }
  switch (op) {
    case 'expense':
      return writes.createExpense(householdId, input as CreateExpenseInput);
    case 'income':
      return writes.createIncome(householdId, input as CreateIncomeInput);
    case 'transfer':
      return writes.createTransfer(householdId, input as CreateTransferInput);
    case 'update': {
      const { id, patch } = input as { id: string; patch: UpdateTransactionInput };
      return writes.updateTransaction(householdId, id, patch);
    }
    case 'softDelete':
      return writes.softDeleteTransaction(householdId, (input as { id: string }).id);
  }
}

const accountCategoryTxExtensions = (
  writes: WriteStore,
): Partial<WriteStoreAccountCategoryTxExtensions> =>
  writes as unknown as Partial<WriteStoreAccountCategoryTxExtensions>;

/**
 * T05 — keyed account-mutation dispatch (same single-transaction rule as
 * runTransactionMutation): with an open claim client the effect MUST run on
 * that client; without one the plain `WriteStore` methods keep their own
 * boundary (behavior unchanged).
 */
export async function runAccountMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'create',
  input: CreateAccountInput,
): Promise<Account>;
export async function runAccountMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'update',
  input: { id: string; patch: UpdateAccountInput },
): Promise<Account>;
export async function runAccountMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'deactivate',
  input: { id: string },
): Promise<Account>;
export async function runAccountMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'create' | 'update' | 'deactivate',
  input: CreateAccountInput | { id: string; patch?: UpdateAccountInput },
): Promise<Account> {
  if (isTxClient(claimTx)) {
    const ext = accountCategoryTxExtensions(writes);
    // Fail-closed: a missing `*InTx` extension with an open claim tx is an
    // invariant error — never a plain fallback (the effect would commit
    // outside the claim tx).
    switch (op) {
      case 'create':
        if (typeof ext.createAccountInTx === 'function') {
          return ext.createAccountInTx(claimTx, householdId, input as CreateAccountInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'update':
        if (typeof ext.updateAccountInTx === 'function') {
          const { id, patch } = input as { id: string; patch: UpdateAccountInput };
          return ext.updateAccountInTx(claimTx, householdId, id, patch);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'deactivate':
        if (typeof ext.deactivateAccountInTx === 'function') {
          return ext.deactivateAccountInTx(claimTx, householdId, (input as { id: string }).id);
        }
        throw domainErrors.atomicMutationNotSupported();
    }
  }
  switch (op) {
    case 'create':
      return writes.createAccount(householdId, input as CreateAccountInput);
    case 'update': {
      const { id, patch } = input as { id: string; patch: UpdateAccountInput };
      return writes.updateAccount(householdId, id, patch);
    }
    case 'deactivate':
      return writes.deactivateAccount(householdId, (input as { id: string }).id);
  }
}

/**
 * T05/T06 — keyed category-mutation dispatch (same single-transaction rule):
 * create/update/deactivate (T05) plus applyDefaults + delete (T06).
 */
export async function runCategoryMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'create',
  input: CreateCategoryInput,
): Promise<Category>;
export async function runCategoryMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'update',
  input: { id: string; patch: UpdateCategoryInput },
): Promise<Category>;
export async function runCategoryMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'deactivate',
  input: { id: string },
): Promise<Category>;
export async function runCategoryMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'applyDefaults',
  input: Record<string, never>,
): Promise<ApplyDefaultsResult>;
export async function runCategoryMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'delete',
  input: { id: string; input: DeleteCategoryInput },
): Promise<DeleteCategoryResult>;
export async function runCategoryMutation(
  writes: WriteStore,
  claimTx: unknown,
  householdId: string,
  op: 'create' | 'update' | 'deactivate' | 'applyDefaults' | 'delete',
  input:
    | CreateCategoryInput
    | { id: string; patch?: UpdateCategoryInput; input?: DeleteCategoryInput }
    | Record<string, never>,
): Promise<Category | ApplyDefaultsResult | DeleteCategoryResult> {
  if (isTxClient(claimTx)) {
    const ext = accountCategoryTxExtensions(writes);
    // Fail-closed: same invariant as runAccountMutation above.
    switch (op) {
      case 'create':
        if (typeof ext.createCategoryInTx === 'function') {
          return ext.createCategoryInTx(claimTx, householdId, input as CreateCategoryInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'update':
        if (typeof ext.updateCategoryInTx === 'function') {
          const { id, patch } = input as { id: string; patch: UpdateCategoryInput };
          return ext.updateCategoryInTx(claimTx, householdId, id, patch);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'deactivate':
        if (typeof ext.deactivateCategoryInTx === 'function') {
          return ext.deactivateCategoryInTx(claimTx, householdId, (input as { id: string }).id);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'applyDefaults':
        if (typeof ext.applyCategoryDefaultsInTx === 'function') {
          return ext.applyCategoryDefaultsInTx(claimTx, householdId);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'delete':
        if (typeof ext.deleteCategoryInTx === 'function') {
          const { id, input: deleteInput } = input as { id: string; input: DeleteCategoryInput };
          return ext.deleteCategoryInTx(claimTx, householdId, id, deleteInput);
        }
        throw domainErrors.atomicMutationNotSupported();
    }
  }
  switch (op) {
    case 'create':
      return writes.createCategory(householdId, input as CreateCategoryInput);
    case 'update': {
      const { id, patch } = input as { id: string; patch: UpdateCategoryInput };
      return writes.updateCategory(householdId, id, patch);
    }
    case 'deactivate':
      return writes.deactivateCategory(householdId, (input as { id: string }).id);
    case 'applyDefaults':
      return writes.applyCategoryDefaults(householdId);
    case 'delete': {
      const { id, input: deleteInput } = input as { id: string; input: DeleteCategoryInput };
      return writes.deleteCategory(householdId, id, deleteInput);
    }
  }
}
