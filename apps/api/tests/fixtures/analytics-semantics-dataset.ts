/**
 * G03 loader for `analytics-semantics.fixture.json` (spike A09).
 *
 * The fixture used to be evidence only: nothing imported it, so nothing
 * enforced it. This module is the seam that turns it into a real aggregation
 * dataset - the SAME loader feeds the store-backed suite (runs everywhere) and
 * the Postgres suite (CI "Postgres - integration tests"), so both prove the
 * same financial semantics.
 *
 * Two deliberate mappings, both declared here instead of hidden in tests:
 *
 * 1. **Household ids.** The fixture uses symbolic ids (`hh-a`/`hh-b`); the API
 *    derives the household from the token and `Transaction.householdId` is a
 *    UUID. Symbolic ids map to the shared seed households.
 * 2. **Optional/null columns.** The fixture writes `null` for absent columns
 *    (JSON has no `undefined`); the domain types are optional, so `null`
 *    becomes an absent key (`exactOptionalPropertyTypes`).
 *
 * `statementPaymentId` is NOT in the `Transaction` domain type, but it is a
 * real column (V056) and the in-memory card store already writes it with the
 * same cast (`cards/in-memory.ts:431`). G-A reads it exactly as the SQL source
 * reads `transactions.statement_payment_id`.
 */

import { readFileSync } from 'node:fs';
import type { Account, Category, Statement, Transaction } from '../../src/types/domain.js';
import { HOUSEHOLD_A, HOUSEHOLD_B } from './seed.js';

/** Transaction row plus the canonical statement-payment origin (V056). */
export type StatementPaymentTransaction = Transaction & { statementPaymentId?: string };

type FixtureAccount = {
  id: string;
  householdId: string;
  name: string;
  kind: 'bank' | 'cash' | 'credit_card';
  status: 'active' | 'inactive';
  creditLimitCents?: number;
};

type FixtureCategory = {
  id: string;
  householdId: string;
  name: string;
  kind: 'expense' | 'income';
  status: 'active' | 'inactive';
  parentId?: string | null;
};

type FixtureTransaction = {
  id: string;
  householdId: string;
  kind: 'expense' | 'income' | 'transfer';
  date: string;
  accountId: string;
  categoryId?: string | null;
  subcategoryId?: string | null;
  transferToAccountId?: string | null;
  statementId?: string | null;
  statementPaymentId?: string | null;
  amountCents: number;
  deletedAt?: string | null;
  note?: string;
};

type FixtureStatement = {
  id: string;
  householdId: string;
  accountId: string;
  cycleYearMonth: string;
  closingDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  status: 'open' | 'closed' | 'paid' | 'partial' | 'overdue' | 'cancelled';
};

type FixtureGenerated = {
  id: string;
  householdId: string;
  kind: 'expense' | 'income' | 'transfer';
  accountId: string;
  categoryId?: string | null;
  count: number;
  idPattern: string;
  dateFormula: string;
  amountCentsFormula: string;
  deletedAt?: string | null;
};

export type AnalyticsFixture = {
  meta: { id: string; status: string; purpose: string; boundaryContract: string };
  pageSize: { filterMax: number; analyticsStoreLoop: number };
  dataset: {
    accounts: FixtureAccount[];
    categories: FixtureCategory[];
    statements: FixtureStatement[];
    payablesNotCounted: Array<{ id: string; amountCents: number; status: string }>;
    transactions: FixtureTransaction[];
    generatedTransactions: FixtureGenerated[];
  };
  cases: Array<{
    id: string;
    question: string;
    readModelsUnderTest: string[];
    request: { path: string | null; query: Record<string, string> | null };
    expected: Record<string, unknown>;
    expectedDerivation: string;
    verdictToday: string;
  }>;
};

const FIXTURE_URL = new URL('./analytics-semantics.fixture.json', import.meta.url);

export const analyticsFixture: AnalyticsFixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as AnalyticsFixture;

const HOUSEHOLDS: Record<string, string> = { 'hh-a': HOUSEHOLD_A, 'hh-b': HOUSEHOLD_B };

/** Symbolic fixture household -> seed household UUID (both workspaces). */
export const householdOf = (fixtureHouseholdId: string): string => {
  const householdId = HOUSEHOLDS[fixtureHouseholdId];
  if (!householdId) throw new Error(`analytics fixture: unknown household ${fixtureHouseholdId}`);
  return householdId;
};

export const fixtureAccounts = (): Account[] =>
  analyticsFixture.dataset.accounts.map((account) => {
    const seeded: Account = {
      id: account.id,
      householdId: householdOf(account.householdId),
      name: account.name,
      kind: account.kind,
      // The fixture carries no balances: analytics reads account balances only
      // for netLiquidBalance/netWorth, which the fixture does not assert.
      balanceCents: 0,
      status: account.status,
    };
    if (account.creditLimitCents !== undefined) seeded.creditLimitCents = account.creditLimitCents;
    return seeded;
  });

export const fixtureCategories = (): Category[] =>
  analyticsFixture.dataset.categories.map((category) => {
    const seeded: Category = {
      id: category.id,
      householdId: householdOf(category.householdId),
      name: category.name,
      kind: category.kind,
      status: category.status,
    };
    if (category.parentId) seeded.parentId = category.parentId;
    return seeded;
  });

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * Materialises the fixture's generated rows (`iRange`, `dateFormula`,
 * `amountCentsFormula`). Only the two formulas the fixture declares are
 * supported, and they are read from the fixture text rather than hardcoded, so
 * a change in the fixture fails loudly here instead of silently drifting.
 */
const expandGenerated = (row: FixtureGenerated): FixtureTransaction[] => {
  const daysMatch = /(\d{4}-\d{2}-\d{2}) \+ \(\(i - 1\) mod (\d+)\) dias/.exec(row.dateFormula);
  if (!daysMatch) throw new Error(`analytics fixture: unreadable dateFormula "${row.dateFormula}"`);
  const [, start, moduloText] = daysMatch;
  const modulo = Number(moduloText);
  const amountMatch = /^(\d+) \+ i$/.exec(row.amountCentsFormula) ?? /^(\d+)$/.exec(row.amountCentsFormula);
  if (!amountMatch) throw new Error(`analytics fixture: unreadable amountCentsFormula "${row.amountCentsFormula}"`);
  const base = Number(amountMatch[1]);
  const variable = row.amountCentsFormula.endsWith('+ i');
  return Array.from({ length: row.count }, (_, index) => {
    const i = index + 1;
    return {
      id: row.idPattern.replace('{i:04d}', String(i).padStart(4, '0')),
      householdId: row.householdId,
      kind: row.kind,
      date: addDays(start as string, (i - 1) % modulo),
      accountId: row.accountId,
      categoryId: row.categoryId ?? null,
      amountCents: variable ? base + i : base,
      deletedAt: row.deletedAt ?? null,
    } satisfies FixtureTransaction;
  });
};

export const fixtureTransactions = (): StatementPaymentTransaction[] =>
  analyticsFixture.dataset.transactions
    .concat(analyticsFixture.dataset.generatedTransactions.flatMap(expandGenerated))
    .map((row) => {
      const seeded: StatementPaymentTransaction = {
        id: row.id,
        householdId: householdOf(row.householdId),
        kind: row.kind,
        // The fixture has no `description`; the domain requires one (and the
        // database CHECKs 1..240 chars). The id keeps it traceable.
        description: row.note ? `${row.note} (${row.id})`.slice(0, 240) : row.id,
        amountCents: row.amountCents,
        date: row.date,
        accountId: row.accountId,
      };
      if (row.categoryId) seeded.categoryId = row.categoryId;
      if (row.subcategoryId) seeded.subcategoryId = row.subcategoryId;
      if (row.transferToAccountId) seeded.transferToAccountId = row.transferToAccountId;
      if (row.statementPaymentId) seeded.statementPaymentId = row.statementPaymentId;
      return seeded;
    });

/** Ids the fixture marks as undone/soft-deleted (undo == softDeleteTransaction). */
export const fixtureSoftDeletedIds = (): string[] =>
  analyticsFixture.dataset.transactions.filter((row) => row.deletedAt).map((row) => row.id);

export const fixtureStatements = (): Statement[] =>
  analyticsFixture.dataset.statements.map((statement) => ({
    id: statement.id,
    householdId: householdOf(statement.householdId),
    accountId: statement.accountId,
    cycleYearMonth: statement.cycleYearMonth,
    closingDate: statement.closingDate,
    dueDate: statement.dueDate,
    totalCents: statement.totalCents,
    paidCents: statement.paidCents,
    status: statement.status,
  }));

/**
 * Independent re-derivation of `transactionCount` for the envelope: income and
 * expense rows that survive soft-delete inside the window. Transfers are NOT
 * counted (no aggregate sums them), so they never inflate the proof of rows.
 * Deliberately re-implemented here instead of calling production code, so the
 * envelope is checked against the fixture data, not against itself.
 */
export const expectedTransactionCount = (
  input: {
    householdId: string;
    from: string;
    to: string;
    accountId?: string;
    basis?: string;
    /** `category-breakdown` only reads rows of ONE kind that HAVE a category. */
    kind?: 'expense' | 'income';
    categorisedOnly?: boolean;
  },
): number =>
  fixtureTransactions().filter(
    (row) =>
      row.householdId === input.householdId &&
      row.kind !== 'transfer' &&
      (input.kind ? row.kind === input.kind : true) &&
      !fixtureSoftDeletedIds().includes(row.id) &&
      row.date >= input.from &&
      row.date <= input.to &&
      (input.accountId ? row.accountId === input.accountId : true) &&
      (input.basis === 'competencia' ? row.statementPaymentId === undefined : true) &&
      (input.categorisedOnly ? row.categoryId !== undefined : true),
  ).length;

export const fixtureCase = (id: string): AnalyticsFixture['cases'][number] => {
  const found = analyticsFixture.cases.find((entry) => entry.id === id);
  if (!found) throw new Error(`analytics fixture: unknown case ${id}`);
  return found;
};