import pg from "pg";
import {
  buildReport,
  detectAccountsBalanceDrift,
  detectCardPurchaseDrift,
  detectDuplicates,
  detectGoalContributionDrift,
  detectPayablePaymentDrift,
  detectStatementPaymentDrift,
  detectStatementTotalDrift,
  toSafeNumber,
} from "./detectors.js";
import type {
  AccountBalanceRow,
  CardPurchaseRow,
  CentsValue,
  CheckResult,
  CyclePaymentRow,
  DuplicatesInput,
  GoalContributionRow,
  PayablePaymentRow,
  ReconReport,
  StatementPaymentRow,
  StatementTotalRow,
} from "./detectors.js";
import {
  APPROVED_HISTORICAL_ALLOWLIST_V2,
  applyHistoricalExceptions,
} from "./historical-exceptions.js";
import {
  APPROVED_TEST_FIXTURE_ALLOWLIST,
  applyTestFixtureExceptions,
} from "./test-fixtures.js";
import {
  buildReconciliationQueries,
  CHECKS_BY_LAYOUT,
  isSelectOnly,
} from "./sql.js";
import type { ReconCheck, ReconQuery, SchemaLayout } from "./sql.js";

export type ReconCliOptions = {
  schema: "auto" | SchemaLayout;
  householdId?: string;
  format: "json" | "text";
  failOnDrift: boolean;
};

type Row = Record<string, unknown>;

const num = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Exact money keeper for the accounts_balance check: pg BIGINT money arrives
 * as a decimal string and must NEVER pass through Number() (precision loss
 * past 2^53-1 hides drift). bigint/string/number values flow through
 * verbatim for detectors.ts to parse exactly; anything else (including a
 * NULL stored leg) fails closed instead of silently substituting 0.
 */
const cents = (value: unknown, what: string): CentsValue => {
  if (
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  throw new Error(
    `reconciliation: ${what} is missing or not a money value (${String(value)}): refusing to substitute 0`,
  );
};

const optCents = (value: unknown, what: string): CentsValue | undefined => {
  if (value === null || value === undefined) return undefined;
  return cents(value, what);
};

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
};

const reqStr = (value: unknown, fallback = ""): string =>
  str(value) ?? fallback;

export const parseArgs = (argv: string[]): ReconCliOptions | { help: true } => {
  const opts: ReconCliOptions = {
    schema: "auto",
    format: "json",
    failOnDrift: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--fail-on-drift") opts.failOnDrift = true;
    else if (arg.startsWith("--schema=")) {
      const value = arg.slice("--schema=".length);
      if (value !== "auto" && value !== "legacy" && value !== "canonical") {
        throw new Error(
          `invalid --schema: ${value} (expected auto, legacy or canonical)`,
        );
      }
      opts.schema = value;
    } else if (
      arg.startsWith("--household=") ||
      arg.startsWith("--workspace=")
    ) {
      const value = arg.slice(arg.indexOf("=") + 1).trim();
      if (!value) throw new Error("household scope cannot be empty");
      opts.householdId = value;
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value !== "json" && value !== "text") {
        throw new Error(`invalid --format: ${value} (expected json or text)`);
      }
      opts.format = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
};

export const printHelp = (): string =>
  [
    "reconciliation — read-only financial reconciliation report",
    "",
    "Usage: pnpm reconciliation [--schema=auto|legacy|canonical] [--household=<uuid>] [--format=json|text] [--fail-on-drift]",
    "",
    "Only SELECT statements are executed. The connection sets default_transaction_read_only.",
    "Exit 0 normally, 1 when --fail-on-drift is set and any drift finding exists, 2 on usage or runtime errors.",
  ].join("\n");

export const probeSchemaLayout = async (
  query: (text: string) => Promise<Row[]>,
): Promise<SchemaLayout> => {
  const rows = await query(
    `SELECT
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'balance_cents') AS has_balance,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'account_id') AS has_account_id`,
  );
  const first = rows[0];
  return first?.["has_balance"] === true && first?.["has_account_id"] === true
    ? "canonical"
    : "legacy";
};

export const resolveSchemaLayout = (
  opts: ReconCliOptions,
): SchemaLayout | "auto" => opts.schema;

const mapRows = {
  accounts_balance: (rows: Row[]): AccountBalanceRow[] =>
    rows.map((r) => {
      const row: AccountBalanceRow = {
        accountId: reqStr(r["account_id"]),
        householdId: reqStr(r["household_id"]),
        storedCents: cents(r["stored_cents"], "stored_cents"),
        initialCents:
          r["initial_cents"] === null || r["initial_cents"] === undefined
            ? null
            : cents(r["initial_cents"], "initial_cents"),
        incomeCents: cents(r["income_cents"], "income_cents"),
        expenseCents: cents(r["expense_cents"], "expense_cents"),
        transferInCents: cents(r["transfer_in_cents"], "transfer_in_cents"),
        transferOutCents: cents(r["transfer_out_cents"], "transfer_out_cents"),
        accountKind: str(r["account_kind"]),
      };
      // Slice-2 debt legs: projected by the canonical query only. Absent
      // on the legacy layout (stays undefined) so the detector keeps the
      // legacy derivation there verbatim.
      const cardPurchase = optCents(
        r["card_purchase_cents"],
        "card_purchase_cents",
      );
      if (cardPurchase !== undefined) row.cardPurchaseCents = cardPurchase;
      const cardPaid = optCents(r["card_paid_cents"], "card_paid_cents");
      if (cardPaid !== undefined) row.cardPaidCents = cardPaid;
      const cardInvalid = optCents(
        r["card_invalid_cents"],
        "card_invalid_cents",
      );
      if (cardInvalid !== undefined) row.cardInvalidCents = cardInvalid;
      return row;
    }),
  statement_total: (rows: Row[]): StatementTotalRow[] =>
    rows.map((r) => ({
      statementId: reqStr(r["statement_id"]),
      householdId: reqStr(r["household_id"]),
      storedTotalCents: num(r["stored_total_cents"]),
      linkedSumCents: num(r["linked_sum_cents"]),
      linkedCount: num(r["linked_count"]),
      purchaseSumCents: num(r["purchase_sum_cents"]),
      purchaseCount: num(r["purchase_count"]),
    })),
  statement_payment: (rows: Row[]): StatementPaymentRow[] =>
    rows.map((r) => ({
      statementId: reqStr(r["statement_id"]),
      householdId: reqStr(r["household_id"]),
      cycle: reqStr(r["cycle"]),
      totalCents: num(r["total_cents"]),
      paidCents: num(r["paid_cents"]),
      status: reqStr(r["status"]),
    })),
  statement_payment_coverage: (rows: Row[]): CyclePaymentRow[] =>
    rows.map((r) => ({
      householdId: reqStr(r["household_id"]),
      cycle: reqStr(r["cycle"]),
      statementsPaidSum: num(r["statements_paid_sum"]),
      paymentTxSumCents: num(r["payment_tx_sum_cents"]),
      statementCount: num(r["statement_count"]),
      // Canonical per-statement grain projects s.id AS statement_id;
      // legacy cycle aggregates carry no statement_id (stays undefined).
      ...(r["statement_id"] === null || r["statement_id"] === undefined
        ? {}
        : { statementId: reqStr(r["statement_id"]) }),
    })),
  payable_payment: (rows: Row[]): PayablePaymentRow[] =>
    rows.map((r) => ({
      payableId: reqStr(r["payable_id"]),
      householdId: reqStr(r["household_id"]),
      status: reqStr(r["status"]),
      amountCents: num(r["amount_cents"]),
      paidAmountCents:
        r["paid_amount_cents"] === null || r["paid_amount_cents"] === undefined
          ? null
          : num(r["paid_amount_cents"]),
      paidTransactionId: str(r["paid_transaction_id"]),
      paidTxExists: r["paid_tx_exists"] === true,
      paidTxDeleted: r["paid_tx_deleted"] === true,
      paymentTxCount: num(r["payment_tx_count"]),
      accountId: str(r["account_id"]),
      description: str(r["description"]),
      paidDate: str(r["paid_date"]),
    })),
  goal_contribution: (rows: Row[]): GoalContributionRow[] =>
    rows.map((r) => ({
      goalId: reqStr(r["goal_id"]),
      householdId: reqStr(r["household_id"]),
      storedCurrentCents: num(r["stored_current_cents"]),
      contributionsSumCents: num(r["contributions_sum_cents"]),
      contributionCount: num(r["contribution_count"]),
    })),
  card_purchase: (rows: Row[]): CardPurchaseRow[] =>
    rows.map((r) => ({
      cardPurchaseId: reqStr(r["card_purchase_id"]),
      householdId: reqStr(r["household_id"]),
      statementId: reqStr(r["statement_id"]),
      accountId: str(r["account_id"]),
      purchaseAmountCents: num(r["purchase_amount_cents"]),
      purchaseDescription: reqStr(r["purchase_description"]),
      purchaseDate: reqStr(r["purchase_date"]),
      txId: str(r["tx_id"]),
      txAmountCents:
        r["tx_amount_cents"] === null || r["tx_amount_cents"] === undefined
          ? null
          : num(r["tx_amount_cents"]),
      txDescription: str(r["tx_description"]),
      txDate: str(r["tx_date"]),
      txDeleted: r["tx_deleted"] === true,
    })),
};

export type ReconPool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }>;
};

const fetchCheckRows = async (
  pool: ReconPool,
  query: ReconQuery,
): Promise<Row[]> => {
  if (!isSelectOnly(query.text))
    throw new Error("refusing to run a non-SELECT reconciliation query");
  const result = await pool.query(query.text, query.values);
  return result.rows;
};

export const runReconciliation = async (
  pool: ReconPool,
  layout: SchemaLayout,
  householdId?: string,
): Promise<ReconReport> => {
  const scope = householdId === undefined ? {} : { householdId };
  const queries = buildReconciliationQueries(layout, scope);
  const order = CHECKS_BY_LAYOUT[layout];
  const fetched = new Map<ReconCheck, Row[]>();
  for (const check of order) {
    fetched.set(check, await fetchCheckRows(pool, queries[check]));
  }
  const rowsOf = (check: ReconCheck): Row[] => fetched.get(check) ?? [];
  const payableRows = mapRows.payable_payment(rowsOf("payable_payment"));
  const statementRows = mapRows.statement_total(rowsOf("statement_total"));
  const cardRows = mapRows.card_purchase(rowsOf("card_purchase"));
  const balanceRows = mapRows.accounts_balance(rowsOf("accounts_balance"));
  const coverageRows = mapRows.statement_payment_coverage(
    rowsOf("statement_payment_coverage"),
  );
  const checks: CheckResult[] = [
    detectAccountsBalanceDrift(balanceRows, householdId),
    detectStatementTotalDrift(statementRows, householdId),
    detectStatementPaymentDrift(
      mapRows.statement_payment(rowsOf("statement_payment")),
      coverageRows,
      householdId,
    ),
    detectPayablePaymentDrift(payableRows, householdId),
    detectGoalContributionDrift(
      mapRows.goal_contribution(rowsOf("goal_contribution")),
      householdId,
    ),
    detectCardPurchaseDrift(cardRows, householdId),
    detectDuplicates(buildDuplicatesInput(rowsOf, payableRows), householdId),
  ];
  // ADR-017 closed exception: exact fingerprint matches leave the active
  // drift set and are reported separately; any missing/changed fingerprint
  // (global and household-scoped runs) raises a drift gate so --fail-on-drift exits 1.
  const { checks: adjustedChecks, summary: historicalSummary } =
    applyHistoricalExceptions(
      checks,
      {
        orphans: cardRows.map((row) => ({
          cardPurchaseId: row.cardPurchaseId,
          householdId: row.householdId,
          statementId: row.statementId,
          accountId: row.accountId,
          amountCents: row.purchaseAmountCents,
          purchaseDate: row.purchaseDate,
          description: row.purchaseDescription,
          transactionId: row.txId,
        })),
        statements: statementRows.map((row) => ({
          statementId: row.statementId,
          householdId: row.householdId,
          storedTotalCents: row.storedTotalCents,
          linkedSumCents: row.linkedSumCents,
          linkedCount: row.linkedCount,
          purchaseSumCents: row.purchaseSumCents,
          purchaseCount: row.purchaseCount,
        })),
        negativeCreditBalances: balanceRows.map((row) => ({
          accountId: row.accountId,
          householdId: row.householdId,
          // Exact-to-safe bridge for the hash-only fingerprint: safe values
          // convert exactly (the approved entry is small); unsafe/invalid
          // values become NaN, which the matcher ignores so they stay drift.
          storedCents: toSafeNumber(row.storedCents),
          accountKind: row.accountKind ?? null,
        })),
      },
      APPROVED_HISTORICAL_ALLOWLIST_V2,
      householdId,
    );
  // ADR-019 closed exception (legacy layout only): exact fingerprint matches
  // leave the active drift set and are reported separately under
  // `report.testFixtures`; any missing/changed fixture in a legacy run
  // (global or approved household-scoped) raises a drift gate so
  // --fail-on-drift exits 1. Canonical runs expect zero ADR-019 fixtures
  // and never suppress: canonical coverage rows are now fetched by layout,
  // and any canonical payment_coverage_gap/missing_payment_transaction
  // finding stays as active drift. ADR-017 provenance is untouched.
  const { checks: finalChecks, summary: testFixtureSummary } =
    applyTestFixtureExceptions(
      adjustedChecks,
      {
        coverages: coverageRows.map((row) => ({
          householdId: row.householdId,
          cycle: row.cycle,
          statementsPaidSum: row.statementsPaidSum,
          paymentTxSumCents: row.paymentTxSumCents,
          statementCount: row.statementCount,
        })),
        payables: payableRows.map((row) => ({
          payableId: row.payableId,
          householdId: row.householdId,
          accountId: row.accountId,
          description: row.description,
          amountCents: row.amountCents,
          status: row.status,
          paidDate: row.paidDate,
          paidTransactionId: row.paidTransactionId,
          paidTxExists: row.paidTxExists,
          paidTxDeleted: row.paidTxDeleted,
          paymentTxCount: row.paymentTxCount,
        })),
      },
      APPROVED_TEST_FIXTURE_ALLOWLIST,
      householdId,
      layout,
    );
  const report: ReconReport = buildReport(finalChecks, {
    schema: layout,
    generatedAt: new Date().toISOString(),
    ...(householdId === undefined ? {} : { householdScope: householdId }),
  });
  report.historicalExceptions = historicalSummary;
  report.testFixtures = testFixtureSummary;
  return report;
};

const buildDuplicatesInput = (
  rowsOf: (check: ReconCheck) => Row[],
  payableRows: PayablePaymentRow[],
): DuplicatesInput => {
  const input: DuplicatesInput = {
    payablePayments: payableRows.map((r) => ({
      payableId: r.payableId,
      householdId: r.householdId,
      livePaymentTxCount: r.paymentTxCount,
    })),
    idempotencyConflicts: rowsOf("dup_idempotency").map((r) => ({
      scope: reqStr(r["scope"]),
      key: reqStr(r["key"]),
      payloadHashes: Array.isArray(r["payload_hashes"])
        ? (r["payload_hashes"] as unknown[]).map(String)
        : [],
    })),
    orphanTransactions: rowsOf("dup_orphan_transactions").map((r) => ({
      transactionId: reqStr(r["transaction_id"]),
      householdId: reqStr(r["household_id"]),
      accountRef: reqStr(r["account_ref"]),
      reason: reqStr(r["reason"]),
    })),
    orphanCardPurchases: rowsOf("dup_orphan_card_purchases").map((r) => ({
      cardPurchaseId: reqStr(r["card_purchase_id"]),
      householdId: reqStr(r["household_id"]),
      transactionId: str(r["transaction_id"]),
    })),
    recurringSuccessors: [
      ...rowsOf("dup_recurring_payables").map((r) => ({
        kind: "payable" as const,
        householdId: reqStr(r["household_id"]),
        key: `${reqStr(r["description"])}|${reqStr(r["due_date"])}`,
        count: num(r["n"]),
        ids: Array.isArray(r["ids"]) ? (r["ids"] as unknown[]).map(String) : [],
      })),
      ...rowsOf("dup_recurring_purchases").map((r) => ({
        kind: "recurring_purchase" as const,
        householdId: reqStr(r["household_id"]),
        key: `${reqStr(r["account_id"])}|${reqStr(r["description"])}|${reqStr(r["start_date"])}`,
        count: num(r["n"]),
        ids: Array.isArray(r["ids"]) ? (r["ids"] as unknown[]).map(String) : [],
      })),
    ],
  };
  return input;
};

export const formatTextReport = (report: ReconReport): string => {
  const lines = [
    `reconciliation schema=${report.schema} checked=${report.totals.checked} drifted=${report.totals.drifted} info=${report.totals.info}`,
  ];
  if (report.historicalExceptions !== undefined) {
    const historical = report.historicalExceptions;
    lines.push(
      `historical-exceptions version=${historical.version} orphans=${historical.orphanCardPurchases.matched}/${historical.orphanCardPurchases.expected} statements=${historical.statementTotals.matched}/${historical.statementTotals.expected} negatives=${historical.negativeCreditBalances.matched}/${historical.negativeCreditBalances.expected}`,
    );
  }
  if (report.testFixtures !== undefined) {
    const fixtures = report.testFixtures;
    lines.push(
      `test-fixtures version=${fixtures.version} coverage=${fixtures.coverage.matched}/${fixtures.coverage.expected} payables=${fixtures.payables.matched}/${fixtures.payables.expected}`,
    );
  }
  for (const check of report.checks) {
    lines.push(
      `- ${check.check}: checked=${check.counts.checked} drifted=${check.counts.drifted}`,
    );
    for (const finding of check.findings) {
      const expected =
        finding.expected === undefined
          ? ""
          : ` expected=${String(finding.expected)}`;
      const actual =
        finding.actual === undefined ? "" : ` actual=${String(finding.actual)}`;
      lines.push(
        `  [${finding.severity}] ${finding.kind} ${finding.entity}:${finding.entityId}${expected}${actual}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

export const createReconPool = (connectionString: string): pg.Pool =>
  new pg.Pool({
    connectionString,
    max: 2,
    options: "-c default_transaction_read_only=on",
  });

export const main = async (
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> => {
  let opts: ReconCliOptions;
  try {
    const parsed = parseArgs(argv);
    if ("help" in parsed) {
      process.stdout.write(`${printHelp()}\n`);
      return 0;
    }
    opts = parsed;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n${printHelp()}\n`);
    return 2;
  }
  const connectionString =
    env["DATABASE_URL"]?.trim() || env["DATABASE_URL_TEST"]?.trim();
  if (!connectionString) {
    process.stderr.write(
      "error: DATABASE_URL (or DATABASE_URL_TEST) is not set; nothing to do.\n",
    );
    return 2;
  }
  if (opts.schema === "auto" && env["DB_SCHEMA"] === "legacy")
    opts = { ...opts, schema: "legacy" };
  const pool = createReconPool(connectionString);
  try {
    let layout: SchemaLayout | "auto" =
      opts.schema === "auto" ? "auto" : opts.schema;
    if (layout === "auto") {
      layout = await probeSchemaLayout(
        async (text) => (await pool.query(text)).rows as Row[],
      );
    }
    const report = await runReconciliation(pool, layout, opts.householdId);
    if (opts.format === "text") process.stdout.write(formatTextReport(report));
    else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return opts.failOnDrift && report.totals.drifted > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`reconciliation failed: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await pool.end();
  }
};

const invokedAsCli =
  process.argv[1] !== undefined &&
  /reconciliation[/\\]run\.(ts|js)$/.test(process.argv[1]);

if (invokedAsCli) {
  void main(
    process.argv.slice(2),
    process.env as Record<string, string | undefined>,
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(
        `reconciliation failed: ${(err as Error).message}\n`,
      );
      process.exitCode = 1;
    },
  );
}
