/**
 * Card store — interface for credit card read/write operations.
 *
 * Separated from WriteStore because card operations (statements,
 * installments, recurring purchases) are a distinct domain from
 * expense/income/transfer CRUD.
 */

import type { Account, Statement, StatementDetail, RecurringPurchase } from '../types/domain.js';

export type CardStore = {
  /** List credit-card accounts for a household (kind='credit_card'). */
  listCreditCardAccounts(householdId: string): Promise<Account[]>;

  /** List statements, optionally filtered by accountId. */
  listStatements(householdId: string, accountId?: string, opts?: {
    status?: string;
    limit?: number;
  }): Promise<Statement[]>;
  /** List recurring card purchases, optionally filtered by account and status. */
  listRecurringPurchases(householdId: string, opts?: {
    accountId?: string;
    status?: RecurringPurchase['status'];
  }): Promise<RecurringPurchase[]>;

  /** Get a statement with its purchases. */
  getStatementDetail(householdId: string, statementId: string): Promise<StatementDetail | null>;

  /** Register a single purchase on a credit card. Returns the created transaction. */
  createCardPurchase(householdId: string, input: {
    accountId: string;
    description: string;
    amountCents: number;
    date: string;
    categoryId?: string;
    subcategoryId?: string;
    notes?: string;
    installmentNumber?: number;
    installmentsTotal?: number;
  }, options?: { idempotencyKey?: string }): Promise<import('../types/domain.js').Transaction[]>;

  /**
   * Register all installments of a purchase at once (single transaction).
   * `totalAmountCents` is always the TOTAL of the purchase; the store owns the
   * exact split. With `options.idempotencyKey` the whole set is claimed under
   * one key (P3.5): a retry/reconcile replays the same transactions, a
   * different payload under the same key conflicts and writes nothing.
   */
  createCardInstallments(householdId: string, input: {
    accountId: string;
    description: string;
    totalAmountCents: number;
    purchaseDate: string;
    installmentsTotal: number;
    categoryId?: string;
    subcategoryId?: string;
    notes?: string;
  }, options?: { idempotencyKey?: string }): Promise<import('../types/domain.js').Transaction[]>;

  /** Create a recurring purchase on a credit card. */
  createRecurringPurchase(householdId: string, input: {
    accountId: string;
    description: string;
    amountCents: number;
    frequency: 'monthly' | 'quarterly' | 'yearly';
    startDate: string;
    endDate?: string;
    categoryId?: string;
  }): Promise<RecurringPurchase>;

  /**
   * Pay (total or partial) a credit card statement.
   *
   * With `options.idempotencyKey` the debit, the statement update, the card
   * debt delta and the recorded key commit in ONE transaction: a retry /
   * reconcile with the same key + same payload replays the original
   * statement instead of paying twice; a divergent payload conflicts.
   */
  payStatement(householdId: string, statementId: string, input: {
    amountCents: number;
    fromAccountId: string;
  }, options?: { idempotencyKey?: string }): Promise<Statement>;

  /** Create a credit card account. */
  createCard(householdId: string, input: {
    name: string;
    creditLimitCents: number;
    closingDay: number;
    dueDay: number;
  }): Promise<Account>;

  /** Update a credit card account (name, limit, closingDay, dueDay). */
  updateCard(householdId: string, id: string, input: {
    name?: string;
    creditLimitCents?: number;
    closingDay?: number;
    dueDay?: number;
  }): Promise<Account>;

  /** Update a purchase on a statement. Returns updated statement detail. */
  updatePurchase(householdId: string, purchaseId: string, input: {
    description?: string;
    amountCents?: number;
    date?: string;
    categoryId?: string;
  }): Promise<StatementDetail>;

  /** Cancel a purchase on an open statement (auditável via soft-delete). Idempotente. */
  cancelPurchase(householdId: string, purchaseId: string): Promise<void>;
};
