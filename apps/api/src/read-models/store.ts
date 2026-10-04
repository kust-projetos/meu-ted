/**
 * In-memory read model store.
 *
 * V1 spec says: "If using demo/in-memory, encapsulate atrás de read-models
 * e cobrir com testes". This module is the seam: when real persistence
 * arrives, swap the bodies for a Postgres adapter that implements the
 * same shape.
 */

import { DEMO_ACCOUNTS, DEMO_CATEGORIES, DEMO_TRANSACTIONS, DEMO_HOUSEHOLD_ID } from './demo-data.js';
import type { Account, Category, Transaction, TransactionFilters } from '../types/domain.js';
import { transactionFiltersSchema, type ParsedTransactionFilters } from '../types/transactions.js';

/**
 * A08 (R08): availability opt-in for the account listing.
 *
 * `includeInactive` widens the READ to also return deactivated accounts
 * (`status = 'inactive'`). Absent/false is the historical active-only read,
 * byte for byte - the default never moves.
 */
export type ListAccountsOptions = {
  includeInactive?: boolean;
};

export type ReadModelStore = {
  listAccounts(householdId: string, options?: ListAccountsOptions): Promise<Account[]>;
  listCategories(householdId: string): Promise<Category[]>;
  listTransactions(
    householdId: string,
    filters: ParsedTransactionFilters,
  ): Promise<{ items: Transaction[]; total: number }>;
  listAllTransactions(householdId: string): Promise<Transaction[]>;
};

const inRange = (date: string, start: string | undefined, end: string | undefined): boolean => {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
};

const matchesQuery = (tx: Transaction, q: string | undefined): boolean => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return tx.description.toLowerCase().includes(needle);
};

export const createInMemoryReadModelStore = (seed?: {
  accounts?: Account[];
  categories?: Category[];
  transactions?: Transaction[];
  /** Soft-deleted transaction ids to filter from reads. */
  deletedTransactionIds?: Set<string>;
}): ReadModelStore => {
  const accounts = seed?.accounts ?? DEMO_ACCOUNTS;
  const categories = seed?.categories ?? DEMO_CATEGORIES;
  const transactions = seed?.transactions ?? DEMO_TRANSACTIONS;
  const deletedIds = seed?.deletedTransactionIds ?? new Set<string>();

  return {
    async listAccounts(householdId, options) {
      // A08: the availability filter is the ONLY thing `includeInactive`
      // relaxes. The workspace scope and the credit-card exclusion (cards are
      // served by the CardStore, never borrowed into this surface) hold in
      // both branches.
      const includeInactive = options?.includeInactive === true;
      return accounts.filter(
        (a) => a.householdId === householdId && (includeInactive || a.status === 'active') && a.kind !== 'credit_card',
      );
    },
    async listCategories(householdId) {
      return categories.filter((c) => c.householdId === householdId && c.status === 'active');
    },
    async listTransactions(householdId, filters) {
      const parsed: ParsedTransactionFilters = transactionFiltersSchema.parse(filters);
      // Build a clean object with only defined keys, to satisfy exactOptionalPropertyTypes.
      const clean: TransactionFilters = {};
      if (parsed.startDate !== undefined) clean.startDate = parsed.startDate;
      if (parsed.endDate !== undefined) clean.endDate = parsed.endDate;
      if (parsed.accountId !== undefined) clean.accountId = parsed.accountId;
      if (parsed.categoryId !== undefined) clean.categoryId = parsed.categoryId;
      if (parsed.kind !== undefined) clean.kind = parsed.kind;
      if (parsed.minAmountCents !== undefined) clean.minAmountCents = parsed.minAmountCents;
      if (parsed.maxAmountCents !== undefined) clean.maxAmountCents = parsed.maxAmountCents;
      if (parsed.query !== undefined) clean.query = parsed.query;

      const filtered = transactions
        .filter((t) => t.householdId === householdId)
        .filter((t) => !deletedIds.has(t.id))
        .filter((t) => inRange(t.date, clean.startDate, clean.endDate))
        .filter((t) => (clean.accountId ? t.accountId === clean.accountId : true))
        .filter((t) => (clean.categoryId ? t.categoryId === clean.categoryId : true))
        .filter((t) => (clean.kind ? t.kind === clean.kind : true))
        .filter((t) =>
          clean.minAmountCents !== undefined ? t.amountCents >= clean.minAmountCents : true,
        )
        .filter((t) =>
          clean.maxAmountCents !== undefined ? t.amountCents <= clean.maxAmountCents : true,
        )
        .filter((t) => matchesQuery(t, clean.query))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));

      const total = filtered.length;
      const items = filtered.slice(parsed.offset, parsed.offset + parsed.limit);
      return { items, total };
    },
    async listAllTransactions(householdId) {
      return transactions
        .filter((t) => t.householdId === householdId)
        .filter((t) => !deletedIds.has(t.id));
    },
  };
};

export const createInMemoryReadModelStoreFromState = (state: {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  deletedTransactions: Set<string>;
}): ReadModelStore => {
  return createInMemoryReadModelStore({
    accounts: state.accounts,
    categories: state.categories,
    transactions: state.transactions,
    deletedTransactionIds: state.deletedTransactions,
  });
};

export const DEMO_HOUSEHOLDS = [DEMO_HOUSEHOLD_ID] as const;
