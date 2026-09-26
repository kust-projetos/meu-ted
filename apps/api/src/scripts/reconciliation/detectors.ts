export type Severity = "drift" | "info";

export type CheckName =
  | "accounts_balance"
  | "statement_total"
  | "statement_payment"
  | "payable_payment"
  | "goal_contribution"
  | "card_purchase"
  | "duplicates";

export type Finding = {
  check: CheckName;
  entity: string;
  entityId: string;
  kind: string;
  severity: Severity;
  expected?: number | string;
  actual?: number | string;
  detail?: Record<string, number | string | boolean | null>;
};

export type CheckResult = {
  check: CheckName;
  findings: Finding[];
  counts: { checked: number; drifted: number };
  workspaceScope?: string;
};

/**
 * Money arrives from pg as a BIGINT decimal string, a safe JS integer, or a
 * bigint. `number` past 2^53-1 is already rounded on arrival, so it is
 * rejected (fail-closed `invalid_balance_input`) instead of computed on.
 * Exact decimal strings stay exact end-to-end and are reported back as
 * decimal strings only when they exceed the safe-integer range (JSON-safe:
 * findings never carry a bigint, so `JSON.stringify(report)` cannot throw).
 */
export type CentsValue = number | string | bigint;

const PG_BIGINT_MIN = -(2n ** 63n);
const PG_BIGINT_MAX = 2n ** 63n - 1n;
const MAX_SAFE_CENTS = 9007199254740991n;

const INT_RE = /^-?\d+$/;

export const parseCentsExact = (value: CentsValue): bigint | null => {
  let text: string;
  if (typeof value === "bigint") {
    text = value.toString();
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
    if (!INT_RE.test(text)) return null;
  } else {
    return null;
  }
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    return null;
  }
  if (parsed < PG_BIGINT_MIN || parsed > PG_BIGINT_MAX) return null;
  return parsed;
};

/** JSON-safe money: a number while exactly representable, else a decimal string. */
export const formatCents = (value: bigint): number | string =>
  value <= MAX_SAFE_CENTS && value >= -MAX_SAFE_CENTS
    ? Number(value)
    : value.toString();

/**
 * Exact cents for fingerprint/legacy numeric consumers: the safe-integer
 * number, or NaN when the value is invalid or exceeds the safe range (the
 * fingerprint matchers ignore NaN, so unsafe values stay drift — fail-closed).
 */
export const toSafeNumber = (value: CentsValue): number => {
  const parsed = parseCentsExact(value);
  if (parsed === null) return NaN;
  if (parsed > MAX_SAFE_CENTS || parsed < -MAX_SAFE_CENTS) return NaN;
  return Number(parsed);
};

export type AccountBalanceRow = {
  accountId: string;
  householdId: string;
  storedCents: CentsValue;
  initialCents: CentsValue | null;
  incomeCents: CentsValue;
  expenseCents: CentsValue;
  transferInCents: CentsValue;
  transferOutCents: CentsValue;
  /** Account kind ('bank' | 'cash' | 'credit_card'); absent stays permissive. */
  accountKind?: string | null;
  /**
   * Slice-2 debt legs, projected by the canonical accounts_balance query:
   * live linked card-purchase expenses and SUM(statements.paid_cents) for
   * the account. Present only on the canonical layout; when EITHER leg is
   * absent (legacy layout, older callers) a credit_card row falls back to
   * the legacy income/expense derivation so legacy behavior stays verbatim.
   */
  cardPurchaseCents?: CentsValue | undefined;
  cardPaidCents?: CentsValue | undefined;
  /**
   * Canonical invalid-link leg: live statement-linked expenses whose
   * statement_id resolves to NO same account+household statement (missing,
   * foreign-household, or other-card statement). Excluded from the debt leg
   * so a wrong link can never count as correctly linked debt; a nonzero leg
   * raises `invalid_statement_link` (credit_card rows only — bank/cash keep
   * the pinned statement-link exclusion verbatim).
   */
  cardInvalidCents?: CentsValue | undefined;
};

export type StatementTotalRow = {
  statementId: string;
  householdId: string;
  storedTotalCents: number;
  linkedSumCents: number;
  linkedCount: number;
  /** Aggregate of live card_purchases for this statement (ADR-017 fingerprint). */
  purchaseSumCents?: number;
  /** Count of live card_purchases for this statement (ADR-017 fingerprint). */
  purchaseCount?: number;
};

export type StatementPaymentRow = {
  statementId: string;
  householdId: string;
  cycle: string;
  totalCents: number;
  paidCents: number;
  status: string;
};

export type CyclePaymentRow = {
  householdId: string;
  cycle: string;
  statementsPaidSum: number;
  paymentTxSumCents: number;
  statementCount: number;
  /**
   * Canonical per-statement grain (V056 follow-up): when present, this row
   * covers ONE statement id (payment legs linked directly via
   * transactions.statement_payment_id). Absent = legacy household+cycle
   * aggregate. Canonical rows always carry it; legacy rows never do.
   */
  statementId?: string;
};

export type PayablePaymentRow = {
  payableId: string;
  householdId: string;
  status: string;
  amountCents: number;
  paidAmountCents: number | null;
  paidTransactionId: string | null;
  paidTxExists: boolean;
  paidTxDeleted: boolean;
  paymentTxCount: number;
  /** Owning account (ADR-019 fingerprint); SELECT-only projection. */
  accountId?: string | null;
  /** Payable description (ADR-019 fingerprint); SELECT-only projection. */
  description?: string | null;
  /** Paid date ISO text or null (ADR-019 fingerprint); SELECT-only projection. */
  paidDate?: string | null;
};

export type GoalContributionRow = {
  goalId: string;
  householdId: string;
  storedCurrentCents: number;
  contributionsSumCents: number;
  contributionCount: number;
};

export type CardPurchaseRow = {
  cardPurchaseId: string;
  householdId: string;
  statementId: string;
  /** Owning account (ADR-017 fingerprint); may be absent on legacy-unbackfilled rows. */
  accountId?: string | null;
  purchaseAmountCents: number;
  purchaseDescription: string;
  purchaseDate: string;
  txId: string | null;
  txAmountCents: number | null;
  txDescription: string | null;
  txDate: string | null;
  txDeleted: boolean;
};

export type DuplicatesInput = {
  payablePayments: Array<{
    payableId: string;
    householdId: string;
    livePaymentTxCount: number;
  }>;
  idempotencyConflicts: Array<{
    scope: string;
    key: string;
    payloadHashes: string[];
  }>;
  orphanTransactions: Array<{
    transactionId: string;
    householdId: string;
    accountRef: string;
    reason: string;
  }>;
  orphanCardPurchases: Array<{
    cardPurchaseId: string;
    householdId: string;
    transactionId: string | null;
  }>;
  recurringSuccessors: Array<{
    kind: "payable" | "recurring_purchase";
    householdId: string;
    key: string;
    count: number;
    ids: string[];
  }>;
};

export type ReconReport = {
  generatedAt: string;
  schema: string;
  checks: CheckResult[];
  totals: { checked: number; drifted: number; info: number };
  householdScope?: string;
  /** Closed ADR-017 historical exception, when evaluated by the CLI runner. */
  historicalExceptions?: HistoricalExceptionSummary;
  /** Closed ADR-019 test-fixture exception, when evaluated by the CLI runner. */
  testFixtures?: TestFixtureExceptionSummary;
};

export type TestFixtureExceptionClassSummary = {
  expected: number;
  matched: number;
  recognized: Array<{ entity: string; kind: string; entityId: string }>;
};

export type TestFixtureExceptionSummary = {
  version: string;
  coverage: TestFixtureExceptionClassSummary;
  payables: TestFixtureExceptionClassSummary;
};

export type HistoricalExceptionClassSummary = {
  expected: number;
  matched: number;
  recognized: Array<{ entity: string; kind: string; entityId: string }>;
};

export type HistoricalExceptionSummary = {
  version: string;
  orphanCardPurchases: HistoricalExceptionClassSummary;
  statementTotals: HistoricalExceptionClassSummary;
  negativeCreditBalances: HistoricalExceptionClassSummary;
};

const emptyResult = (
  check: CheckName,
  workspaceScope?: string,
): CheckResult => {
  const result: CheckResult = {
    check,
    findings: [],
    counts: { checked: 0, drifted: 0 },
  };
  if (workspaceScope !== undefined) result.workspaceScope = workspaceScope;
  return result;
};

const pushDrift = (
  result: CheckResult,
  finding: Omit<Finding, "check" | "severity"> & { severity?: Severity },
): void => {
  result.findings.push({
    ...finding,
    check: result.check,
    severity: finding.severity ?? "drift",
  });
  if (finding.severity !== "info") result.counts.drifted += 1;
};

export const detectAccountsBalanceDrift = (
  rows: AccountBalanceRow[],
  workspaceScope?: string,
): CheckResult => {
  const result = emptyResult("accounts_balance", workspaceScope);
  const flagNegativeCredit = (row: AccountBalanceRow, stored: bigint): void => {
    // V055 domain rule: only credit_card rows must stay non-negative, so a
    // negative stored balance on a credit card is drift even when it matches
    // the ledger derivation. Bank/cash (and unknown kinds) stay permissive.
    if (stored < 0n && row.accountKind === "credit_card") {
      pushDrift(result, {
        entity: "accounts",
        entityId: row.accountId,
        kind: "negative_credit_balance",
        actual: formatCents(stored),
        detail: { account_kind: row.accountKind },
      });
    }
  };
  for (const row of rows) {
    result.counts.checked += 1;
    // Exact parse first: any non-integer, unsafe-number, or out-of-range leg
    // fails closed as drift instead of silently rounding past 2^53.
    const stored = parseCentsExact(row.storedCents);
    const initial =
      row.initialCents === null
        ? ("unanchored" as const)
        : parseCentsExact(row.initialCents);
    const income = parseCentsExact(row.incomeCents);
    const expense = parseCentsExact(row.expenseCents);
    const transferIn = parseCentsExact(row.transferInCents);
    const transferOut = parseCentsExact(row.transferOutCents);
    const cardPurchase =
      row.cardPurchaseCents === undefined
        ? undefined
        : parseCentsExact(row.cardPurchaseCents);
    const cardPaid =
      row.cardPaidCents === undefined
        ? undefined
        : parseCentsExact(row.cardPaidCents);
    const cardInvalid =
      row.cardInvalidCents === undefined
        ? undefined
        : parseCentsExact(row.cardInvalidCents);
    const badField =
      stored === null
        ? "stored_cents"
        : initial === null
          ? "initial_cents"
          : income === null
            ? "income_cents"
            : expense === null
              ? "expense_cents"
              : transferIn === null
                ? "transfer_in_cents"
                : transferOut === null
                  ? "transfer_out_cents"
                  : cardPurchase === null
                    ? "card_purchase_cents"
                    : cardPaid === null
                      ? "card_paid_cents"
                      : cardInvalid === null
                        ? "card_invalid_cents"
                        : null;
    if (badField !== null) {
      pushDrift(result, {
        entity: "accounts",
        entityId: row.accountId,
        kind: "invalid_balance_input",
        detail: { field: badField },
      });
      continue;
    }
    // Unreachable when badField is null (every null leg was reported above);
    // these guards only narrow the parsed legs to bigint for the compiler.
    if (
      stored === null ||
      income === null ||
      expense === null ||
      transferIn === null ||
      transferOut === null
    ) {
      continue;
    }
    if (cardPurchase === null || cardPaid === null || cardInvalid === null) {
      continue;
    }
    if (initial === "unanchored") {
      // Negative-balance rule (user-approved): a negative stored balance
      // is legitimate for bank/cash, so an unanchored row is always info
      // (never drift) regardless of sign — except credit cards, which must
      // stay non-negative (flagNegativeCredit below).
      pushDrift(result, {
        entity: "accounts",
        entityId: row.accountId,
        kind: "unanchored_basis",
        severity: "info",
        actual: formatCents(stored),
      });
      flagNegativeCredit(row, stored);
      continue;
    }
    // Unreachable (reported as initial_cents above); narrows initial to bigint.
    if (initial === null) {
      continue;
    }
    // Wrong-statement debt (credit cards only): the invalid leg is excluded
    // from the derivation below, and any nonzero amount is its own drift so
    // it can never hide inside a matching balance.
    if (
      row.accountKind === "credit_card" &&
      cardInvalid !== undefined &&
      cardInvalid !== 0n
    ) {
      pushDrift(result, {
        entity: "accounts",
        entityId: row.accountId,
        kind: "invalid_statement_link",
        actual: formatCents(cardInvalid),
      });
    }
    const derived =
      row.accountKind === "credit_card" &&
      cardPurchase !== undefined &&
      cardPaid !== undefined
        ? // Slice-2 debt (ADR-018): initial + linked purchases − paid.
          // card_purchases is never an input (no double-count); payments
          // without a statement_payment_id link still count via paid_cents.
          // Wrong-statement expenses stay out (cardInvalidCents, flagged
          // above) instead of counting as correctly linked debt.
          initial + cardPurchase - cardPaid
        : initial + income - expense - transferOut + transferIn;
    if (stored !== derived) {
      pushDrift(result, {
        entity: "accounts",
        entityId: row.accountId,
        kind: "balance_drift",
        expected: formatCents(derived),
        actual: formatCents(stored),
        detail: {
          initial_cents: formatCents(initial),
          income_cents: formatCents(income),
          expense_cents: formatCents(expense),
          transfer_in_cents: formatCents(transferIn),
          transfer_out_cents: formatCents(transferOut),
          ...(row.accountKind === "credit_card" &&
          cardPurchase !== undefined &&
          cardPaid !== undefined
            ? {
                card_purchase_cents: formatCents(cardPurchase),
                card_paid_cents: formatCents(cardPaid),
              }
            : {}),
        },
      });
    }
    // Negative-balance rule (user-approved): a stored balance that matches
    // the ledger derivation is coherent even when negative — no finding,
    // except on credit cards, which must stay non-negative (V055).
    flagNegativeCredit(row, stored);
  }
  return result;
};

export const detectStatementTotalDrift = (
  rows: StatementTotalRow[],
  workspaceScope?: string,
): CheckResult => {
  const result = emptyResult("statement_total", workspaceScope);
  for (const row of rows) {
    result.counts.checked += 1;
    if (row.storedTotalCents !== row.linkedSumCents) {
      pushDrift(result, {
        entity: "statements",
        entityId: row.statementId,
        kind: "total_drift",
        expected: row.linkedSumCents,
        actual: row.storedTotalCents,
        detail: { linked_count: row.linkedCount },
      });
    }
  }
  return result;
};

export const detectStatementPaymentDrift = (
  statements: StatementPaymentRow[],
  cyclePayments: CyclePaymentRow[] = [],
  workspaceScope?: string,
): CheckResult => {
  const result = emptyResult("statement_payment", workspaceScope);
  for (const row of statements) {
    result.counts.checked += 1;
    if (row.paidCents < 0) {
      pushDrift(result, {
        entity: "statements",
        entityId: row.statementId,
        kind: "negative_paid",
        actual: row.paidCents,
      });
      continue;
    }
    if (row.paidCents > row.totalCents) {
      pushDrift(result, {
        entity: "statements",
        entityId: row.statementId,
        kind: "overpaid",
        expected: row.totalCents,
        actual: row.paidCents,
      });
      continue;
    }
    if (row.status === "paid" && row.paidCents < row.totalCents) {
      pushDrift(result, {
        entity: "statements",
        entityId: row.statementId,
        kind: "status_mismatch",
        expected: row.totalCents,
        actual: row.paidCents,
        detail: { status: row.status },
      });
    } else if (
      row.totalCents > 0 &&
      row.paidCents >= row.totalCents &&
      row.status !== "paid"
    ) {
      pushDrift(result, {
        entity: "statements",
        entityId: row.statementId,
        kind: "status_mismatch",
        expected: row.totalCents,
        actual: row.paidCents,
        detail: { status: row.status },
      });
    } else if (
      row.paidCents === 0 &&
      (row.status === "partial" ||
        (row.status === "paid" && row.totalCents > 0))
    ) {
      pushDrift(result, {
        entity: "statements",
        entityId: row.statementId,
        kind: "status_mismatch",
        expected: 0,
        actual: row.paidCents,
        detail: { status: row.status },
      });
    }
  }
  for (const cycle of cyclePayments) {
    result.counts.checked += 1;
    // Canonical per-statement grain: the payment legs counted are exactly
    // those linked to this statement id, so a cross-link to another
    // same-cycle statement gaps BOTH sides instead of masking in a total.
    if (cycle.statementId !== undefined) {
      if (cycle.paymentTxSumCents !== cycle.statementsPaidSum) {
        pushDrift(result, {
          entity: "statements",
          entityId: cycle.statementId,
          kind: "payment_coverage_gap",
          expected: cycle.statementsPaidSum,
          actual: cycle.paymentTxSumCents,
          detail: { cycle: cycle.cycle },
        });
      }
      continue;
    }
    if (cycle.paymentTxSumCents !== cycle.statementsPaidSum) {
      pushDrift(result, {
        entity: "statement_cycle",
        entityId: `${cycle.householdId}|${cycle.cycle}`,
        kind: "payment_coverage_gap",
        expected: cycle.statementsPaidSum,
        actual: cycle.paymentTxSumCents,
        detail: { statement_count: cycle.statementCount },
      });
    }
  }
  return result;
};

export const detectPayablePaymentDrift = (
  rows: PayablePaymentRow[],
  workspaceScope?: string,
): CheckResult => {
  const result = emptyResult("payable_payment", workspaceScope);
  for (const row of rows) {
    result.counts.checked += 1;
    if (row.status === "paid") {
      if (
        row.paidTransactionId === null ||
        !row.paidTxExists ||
        row.paidTxDeleted
      ) {
        pushDrift(result, {
          entity: "accounts_payable",
          entityId: row.payableId,
          kind: "missing_payment_transaction",
          detail: {
            linked: row.paidTransactionId ?? "none",
            deleted: row.paidTxDeleted,
          },
        });
      }
      if (
        row.paidAmountCents !== null &&
        row.paidAmountCents !== row.amountCents
      ) {
        pushDrift(result, {
          entity: "accounts_payable",
          entityId: row.payableId,
          kind: "paid_amount_mismatch",
          expected: row.amountCents,
          actual: row.paidAmountCents,
        });
      }
      if (row.paymentTxCount > 1) {
        pushDrift(result, {
          entity: "accounts_payable",
          entityId: row.payableId,
          kind: "multiple_payments",
          expected: 1,
          actual: row.paymentTxCount,
        });
      }
    } else if (
      row.status !== "cancelled" &&
      row.paymentTxCount > 0 &&
      row.paidTxExists &&
      !row.paidTxDeleted
    ) {
      pushDrift(result, {
        entity: "accounts_payable",
        entityId: row.payableId,
        kind: "unexpected_payment_transaction",
        detail: { status: row.status },
      });
    }
  }
  return result;
};

export const detectGoalContributionDrift = (
  rows: GoalContributionRow[],
  workspaceScope?: string,
): CheckResult => {
  const result = emptyResult("goal_contribution", workspaceScope);
  for (const row of rows) {
    result.counts.checked += 1;
    if (row.storedCurrentCents !== row.contributionsSumCents) {
      pushDrift(result, {
        entity: "goals",
        entityId: row.goalId,
        kind: "contribution_drift",
        expected: row.contributionsSumCents,
        actual: row.storedCurrentCents,
        detail: { contribution_count: row.contributionCount },
      });
    }
  }
  return result;
};

export const detectCardPurchaseDrift = (
  rows: CardPurchaseRow[],
  workspaceScope?: string,
): CheckResult => {
  const result = emptyResult("card_purchase", workspaceScope);
  for (const row of rows) {
    result.counts.checked += 1;
    if (row.txId === null || row.txAmountCents === null || row.txDeleted)
      continue;
    if (row.purchaseAmountCents !== row.txAmountCents) {
      pushDrift(result, {
        entity: "card_purchases",
        entityId: row.cardPurchaseId,
        kind: "purchase_amount_mismatch",
        expected: row.txAmountCents,
        actual: row.purchaseAmountCents,
      });
    }
    if (
      row.txDescription !== null &&
      row.purchaseDescription !== row.txDescription
    ) {
      pushDrift(result, {
        entity: "card_purchases",
        entityId: row.cardPurchaseId,
        kind: "purchase_description_mismatch",
        expected: row.txDescription,
        actual: row.purchaseDescription,
      });
    }
    if (row.txDate !== null && row.purchaseDate !== row.txDate) {
      pushDrift(result, {
        entity: "card_purchases",
        entityId: row.cardPurchaseId,
        kind: "purchase_date_mismatch",
        expected: row.txDate,
        actual: row.purchaseDate,
      });
    }
  }
  return result;
};

export const detectDuplicates = (
  input: DuplicatesInput,
  workspaceScope?: string,
): CheckResult => {
  const result = emptyResult("duplicates", workspaceScope);
  for (const row of input.payablePayments) {
    result.counts.checked += 1;
    if (row.livePaymentTxCount > 1) {
      pushDrift(result, {
        entity: "accounts_payable",
        entityId: row.payableId,
        kind: "multiple_payable_payments",
        expected: 1,
        actual: row.livePaymentTxCount,
      });
    }
  }
  for (const row of input.idempotencyConflicts) {
    result.counts.checked += 1;
    if (new Set(row.payloadHashes).size > 1) {
      pushDrift(result, {
        entity: "idempotency_keys",
        entityId: `${row.scope}|${row.key}`,
        kind: "divergent_idempotency_payload",
        detail: { distinct_hashes: new Set(row.payloadHashes).size },
      });
    }
  }
  for (const row of input.orphanTransactions) {
    result.counts.checked += 1;
    pushDrift(result, {
      entity: "transactions",
      entityId: row.transactionId,
      kind: "orphan_transaction",
      detail: { account_ref: row.accountRef, reason: row.reason },
    });
  }
  for (const row of input.orphanCardPurchases) {
    result.counts.checked += 1;
    pushDrift(result, {
      entity: "card_purchases",
      entityId: row.cardPurchaseId,
      kind: "orphan_card_purchase",
      detail: { transaction_id: row.transactionId ?? "null" },
    });
  }
  for (const row of input.recurringSuccessors) {
    result.counts.checked += 1;
    if (row.count > 1) {
      pushDrift(result, {
        entity:
          row.kind === "payable" ? "accounts_payable" : "recurring_purchases",
        entityId: row.ids.join(","),
        kind: "duplicated_recurring_successor",
        expected: 1,
        actual: row.count,
        detail: { group: row.key },
      });
    }
  }
  return result;
};

export const buildReport = (
  checks: CheckResult[],
  meta: { schema: string; generatedAt: string; householdScope?: string },
): ReconReport => {
  const totals = { checked: 0, drifted: 0, info: 0 };
  for (const check of checks) {
    totals.checked += check.counts.checked;
    totals.drifted += check.counts.drifted;
    totals.info += check.findings.filter((f) => f.severity === "info").length;
  }
  const report: ReconReport = {
    generatedAt: meta.generatedAt,
    schema: meta.schema,
    checks,
    totals,
  };
  if (meta.householdScope !== undefined)
    report.householdScope = meta.householdScope;
  return report;
};
