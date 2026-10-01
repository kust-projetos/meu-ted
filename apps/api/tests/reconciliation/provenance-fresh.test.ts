/**
 * Reconciliation provenance (fresh vs historical) — RED-first.
 *
 * Context (2026-09-30 acceptance): a fresh canonical database (31 accounts,
 * no conversion, no archive-and-bootstrap) reports 31 balance drifts
 * (stored +10000c anchored at 0 — writer omitted the V058 anchor) plus 3
 * `historical_exception_count_mismatch` gates, because the global run
 * expects the closed ADR-017/ADR-018 historical set (47 orphans + 8
 * statements + 1 conscious negative) that a fresh database never holds.
 *
 * Contract under test:
 * - provenance is EXPLICIT (`--provenance=historical|fresh`), never inferred
 *   from the layout; default stays `historical` (baseline compat);
 * - `fresh` expects zero historical/test-fixture exceptions and raises no
 *   count gate on an empty fresh DB, but any allowlisted fingerprint that
 *   does surface under `fresh` still fails closed via the count gate
 *   (scoped record, never a broad ignore);
 * - default `historical` keeps legacy expectations verbatim: an incomplete
 *   fingerprint set keeps failing closed;
 * - fresh bank accounts (zero / positive / negative, ADR-018) reconcile
 *   green only when anchored (stored == initial + movements); the writer-bug
 *   shape (stored 10000, anchor 0, no movements) stays `balance_drift`.
 */
import { describe, expect, it } from "vitest";
import {
  buildReport,
  detectAccountsBalanceDrift,
  detectDuplicates,
  detectPayablePaymentDrift,
  detectStatementPaymentDrift,
  detectStatementTotalDrift,
} from "../../src/scripts/reconciliation/detectors.js";
import {
  APPROVED_HISTORICAL_ALLOWLIST_V2,
  applyHistoricalExceptions,
  fingerprintNegativeCreditBalance,
  fingerprintOrphanCardPurchase,
  hashHouseholdScope,
} from "../../src/scripts/reconciliation/historical-exceptions.js";
import type { HistoricalAllowlist } from "../../src/scripts/reconciliation/historical-exceptions.js";
import {
  APPROVED_TEST_FIXTURE_ALLOWLIST,
  applyTestFixtureExceptions,
  fingerprintPayablePayment,
  fingerprintStatementCoverage,
  hashTestFixtureScope,
} from "../../src/scripts/reconciliation/test-fixtures.js";
import {
  main,
  parseArgs,
  runReconciliation,
} from "../../src/scripts/reconciliation/run.js";
import type { ReconPool } from "../../src/scripts/reconciliation/run.js";

const emptyChecks = () => [
  detectAccountsBalanceDrift([]),
  detectStatementTotalDrift([]),
  detectDuplicates({
    payablePayments: [],
    idempotencyConflicts: [],
    orphanTransactions: [],
    orphanCardPurchases: [],
    recurringSuccessors: [],
  }),
];

describe("reconciliation provenance option (explicit fresh vs historical)", () => {
  it("defaults to historical for baseline compat", () => {
    expect(parseArgs([])).toEqual({
      schema: "auto",
      format: "json",
      failOnDrift: false,
      provenance: "historical",
    });
  });

  it("accepts --provenance=fresh and rejects unknown values", () => {
    expect(parseArgs(["--provenance=fresh"])).toMatchObject({
      provenance: "fresh",
    });
    expect(parseArgs(["--provenance=historical"])).toMatchObject({
      provenance: "historical",
    });
    expect(() => parseArgs(["--provenance=auto"])).toThrow();
    expect(() => parseArgs(["--provenance="])).toThrow();
  });

  it("fresh global empty DB expects zero historical exceptions (no count gate)", () => {
    const { checks, summary } = applyHistoricalExceptions(
      emptyChecks(),
      { orphans: [], statements: [], negativeCreditBalances: [] },
      APPROVED_HISTORICAL_ALLOWLIST_V2,
      undefined,
      "fresh",
    );
    expect(summary.orphanCardPurchases).toMatchObject({ expected: 0, matched: 0 });
    expect(summary.statementTotals).toMatchObject({ expected: 0, matched: 0 });
    expect(summary.negativeCreditBalances).toMatchObject({ expected: 0, matched: 0 });
    expect(
      checks.flatMap((c) => c.findings).filter((f) => f.kind === "historical_exception_count_mismatch"),
    ).toHaveLength(0);
  });

  it("default historical global empty DB keeps the 3 count gates (fail-closed, documents the 3 canonical findings)", () => {
    const { checks, summary } = applyHistoricalExceptions(
      emptyChecks(),
      { orphans: [], statements: [], negativeCreditBalances: [] },
      APPROVED_HISTORICAL_ALLOWLIST_V2,
    );
    expect(summary.orphanCardPurchases.expected).toBe(47);
    expect(summary.statementTotals.expected).toBe(8);
    expect(summary.negativeCreditBalances.expected).toBe(1);
    expect(
      checks.flatMap((c) => c.findings).filter((f) => f.kind === "historical_exception_count_mismatch"),
    ).toHaveLength(3);
  });

  it("fresh never broad-ignores: test fixtures expect zero on fresh", () => {
    const { summary } = applyTestFixtureExceptions(
      emptyChecks(),
      { coverages: [], payables: [] },
      APPROVED_TEST_FIXTURE_ALLOWLIST,
      undefined,
      "legacy",
      "fresh",
    );
    expect(summary.coverage).toMatchObject({ expected: 0, matched: 0 });
    expect(summary.payables).toMatchObject({ expected: 0, matched: 0 });
  });

  it("fresh anchored bank accounts reconcile green (zero/positive/negative)", () => {
    const result = detectAccountsBalanceDrift([
      {
        accountId: "fresh-zero", householdId: "h1", storedCents: 0,
        initialCents: 0, incomeCents: 0, expenseCents: 0,
        transferInCents: 0, transferOutCents: 0, accountKind: "bank",
      },
      {
        accountId: "fresh-pos", householdId: "h1", storedCents: 10_000,
        initialCents: 10_000, incomeCents: 0, expenseCents: 0,
        transferInCents: 0, transferOutCents: 0, accountKind: "bank",
      },
      {
        accountId: "fresh-neg", householdId: "h1", storedCents: -5_000,
        initialCents: -5_000, incomeCents: 0, expenseCents: 0,
        transferInCents: 0, transferOutCents: 0, accountKind: "bank",
      },
    ]);
    expect(result.counts).toEqual({ checked: 3, drifted: 0 });
    expect(result.findings).toHaveLength(0);
  });

  it("writer-bug shape stays balance_drift (stored 10000, anchor 0, no movements)", () => {
    const result = detectAccountsBalanceDrift([
      {
        accountId: "bug-shape", householdId: "h1", storedCents: 10_000,
        initialCents: 0, incomeCents: 0, expenseCents: 0,
        transferInCents: 0, transferOutCents: 0, accountKind: "bank",
      },
    ]);
    expect(result.counts.drifted).toBe(1);
    expect(result.findings[0]?.kind).toBe("balance_drift");
    expect(result.findings[0]?.expected).toBe(0);
    expect(result.findings[0]?.actual).toBe(10_000);
  });
});

describe("fresh provenance never masks a PRESENT fingerprint (fail-closed gates)", () => {
  const orphanSrc = {
    cardPurchaseId: "cp-fresh-present",
    householdId: "h1",
    statementId: "s1",
    accountId: "a1",
    amountCents: 500,
    purchaseDate: "2026-09-01",
    description: "Present under fresh",
    transactionId: null,
  };

  const negativeSrc = {
    accountId: "card-fresh-present",
    householdId: "h1",
    storedCents: -56_000,
    accountKind: "credit_card",
  };

  const freshAllowlist: HistoricalAllowlist = {
    version: "test-fresh-present-v1",
    orphanCardPurchaseFingerprints: new Set([
      fingerprintOrphanCardPurchase(orphanSrc),
    ]),
    statementTotalFingerprints: new Set(),
    expectedOrphanCardPurchases: 1,
    expectedStatementTotals: 0,
    negativeCreditBalanceFingerprints: new Set([
      fingerprintNegativeCreditBalance(negativeSrc),
    ]),
    expectedNegativeCreditBalances: 1,
    approvedHouseholdScopeHash: hashHouseholdScope("h1"),
  };

  it("matched historical orphan under fresh => matched 1, expected 0, count-mismatch gate, drift > 0", () => {
    const checks = [
      detectDuplicates({
        payablePayments: [],
        idempotencyConflicts: [],
        orphanTransactions: [],
        orphanCardPurchases: [
          {
            cardPurchaseId: orphanSrc.cardPurchaseId,
            householdId: orphanSrc.householdId,
            transactionId: null,
          },
        ],
        recurringSuccessors: [],
      }),
      detectStatementTotalDrift([]),
      detectAccountsBalanceDrift([]),
    ];
    const { checks: out, summary } = applyHistoricalExceptions(
      checks,
      { orphans: [orphanSrc], statements: [] },
      freshAllowlist,
      undefined,
      "fresh",
    );
    expect(summary.orphanCardPurchases).toMatchObject({
      expected: 0,
      matched: 1,
    });
    const gates = out
      .flatMap((c) => c.findings)
      .filter((f) => f.kind === "historical_exception_count_mismatch");
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ expected: 0, actual: 1 });
    const report = buildReport(out, {
      schema: "canonical",
      generatedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(report.totals.drifted).toBeGreaterThan(0);
  });

  it("matched historical negative_credit_balance under fresh => matched 1, expected 0, gate, drift > 0", () => {
    const checks = [
      detectAccountsBalanceDrift([
        {
          accountId: negativeSrc.accountId,
          householdId: negativeSrc.householdId,
          storedCents: negativeSrc.storedCents,
          initialCents: 0,
          incomeCents: 0,
          expenseCents: 56_000,
          transferInCents: 0,
          transferOutCents: 0,
          accountKind: "credit_card",
        },
      ]),
      detectStatementTotalDrift([]),
      detectDuplicates({
        payablePayments: [],
        idempotencyConflicts: [],
        orphanTransactions: [],
        orphanCardPurchases: [],
        recurringSuccessors: [],
      }),
    ];
    const { checks: out, summary } = applyHistoricalExceptions(
      checks,
      { orphans: [], statements: [], negativeCreditBalances: [negativeSrc] },
      freshAllowlist,
      undefined,
      "fresh",
    );
    expect(summary.negativeCreditBalances).toMatchObject({
      expected: 0,
      matched: 1,
    });
    const gates = out
      .flatMap((c) => c.findings)
      .filter((f) => f.kind === "historical_exception_count_mismatch");
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ expected: 0, actual: 1 });
    const report = buildReport(out, {
      schema: "canonical",
      generatedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(report.totals.drifted).toBeGreaterThan(0);
  });

  it("matched test-fixture fingerprints under fresh+legacy => matched 1/1, expected 0/0, gates, drift > 0", () => {
    const coverageSrc = {
      householdId: "h-test",
      cycle: "2026-09",
      statementsPaidSum: 72_360,
      paymentTxSumCents: 0,
      statementCount: 1,
    };
    const payableSrc = {
      payableId: "p-fresh-present",
      householdId: "h-test",
      accountId: "a1",
      description: "Rent",
      amountCents: 100_000,
      status: "paid",
      paidDate: "2026-09-10",
      paidTransactionId: "t-missing",
      paidTxExists: false,
      paidTxDeleted: true,
      paymentTxCount: 0,
    };
    const allowlist = {
      version: "test-fresh-fixture-present-v1",
      coverageFingerprints: new Set([
        fingerprintStatementCoverage(coverageSrc),
      ]),
      payableFingerprints: new Set([fingerprintPayablePayment(payableSrc)]),
      expectedCoverage: 1,
      expectedPayables: 1,
      approvedHouseholdScopeHash: hashTestFixtureScope("h-test"),
    };
    const checks = [
      detectStatementPaymentDrift([], [coverageSrc]),
      detectPayablePaymentDrift([
        {
          payableId: payableSrc.payableId,
          householdId: payableSrc.householdId,
          status: payableSrc.status,
          amountCents: payableSrc.amountCents,
          paidAmountCents: payableSrc.amountCents,
          paidTransactionId: payableSrc.paidTransactionId,
          paidTxExists: payableSrc.paidTxExists,
          paidTxDeleted: payableSrc.paidTxDeleted,
          paymentTxCount: payableSrc.paymentTxCount,
        },
      ]),
    ];
    const { checks: out, summary } = applyTestFixtureExceptions(
      checks,
      { coverages: [coverageSrc], payables: [payableSrc] },
      allowlist,
      undefined,
      "legacy",
      "fresh",
    );
    expect(summary.coverage).toMatchObject({ expected: 0, matched: 1 });
    expect(summary.payables).toMatchObject({ expected: 0, matched: 1 });
    const gates = out
      .flatMap((c) => c.findings)
      .filter((f) => f.kind === "test_fixture_count_mismatch");
    expect(gates).toHaveLength(2);
    for (const gate of gates) {
      expect(gate).toMatchObject({ expected: 0, actual: 1 });
    }
    const report = buildReport(out, {
      schema: "legacy",
      generatedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(report.totals.drifted).toBeGreaterThan(0);
  });
});

describe("CLI wiring: runReconciliation with fake pool + --fail-on-drift exit mapping", () => {
  const accountRow = (stored: number, initial: number) => ({
    account_id: "acc-cli",
    household_id: "h1",
    stored_cents: stored,
    initial_cents: initial,
    income_cents: 0,
    expense_cents: 0,
    transfer_in_cents: 0,
    transfer_out_cents: 0,
    account_kind: "bank",
    card_purchase_cents: 0,
    card_paid_cents: 0,
    card_invalid_cents: 0,
  });

  const fakePool = (stored: number, initial: number): ReconPool => ({
    query: async (text: string) => {
      if (text.includes("card_paid_cents")) {
        return { rows: [accountRow(stored, initial)] };
      }
      return { rows: [] };
    },
  });

  const exitFor = (
    failOnDrift: boolean,
    drifted: number,
  ): number => (failOnDrift && drifted > 0 ? 1 : 0);

  it("drifted fresh report maps to exit 1 under --fail-on-drift (writer-bug shape)", async () => {
    const opts = parseArgs(["--provenance=fresh", "--fail-on-drift"]);
    if ("help" in opts) throw new Error("unexpected help");
    const report = await runReconciliation(
      fakePool(10_000, 0),
      "canonical",
      undefined,
      opts.provenance,
    );
    expect(report.provenance).toBe("fresh");
    expect(report.totals.drifted).toBeGreaterThan(0);
    expect(
      report.checks
        .flatMap((c) => c.findings)
        .some((f) => f.kind === "balance_drift"),
    ).toBe(true);
    // No historical count gates on an empty fresh DB: only the real drift.
    expect(
      report.checks
        .flatMap((c) => c.findings)
        .filter((f) => f.kind === "historical_exception_count_mismatch"),
    ).toHaveLength(0);
    expect(exitFor(opts.failOnDrift, report.totals.drifted)).toBe(1);
  });

  it("clean fresh report maps to exit 0 under --fail-on-drift (anchored account)", async () => {
    const opts = parseArgs(["--provenance=fresh", "--fail-on-drift"]);
    if ("help" in opts) throw new Error("unexpected help");
    const report = await runReconciliation(
      fakePool(5_000, 5_000),
      "canonical",
      undefined,
      opts.provenance,
    );
    expect(report.totals.drifted).toBe(0);
    expect(exitFor(opts.failOnDrift, report.totals.drifted)).toBe(0);
  });

  it("main() without a connection string exits 2 without touching any pool (no PG)", async () => {
    await expect(main([], {})).resolves.toBe(2);
    await expect(main(["--bogus"], {})).resolves.toBe(2);
  });
});
