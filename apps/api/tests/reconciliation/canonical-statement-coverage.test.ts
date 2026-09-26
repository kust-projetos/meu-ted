import { describe, expect, it } from "vitest";
import {
  buildReconciliationQueries,
  CHECKS_BY_LAYOUT,
  isSelectOnly,
} from "../../src/scripts/reconciliation/sql.js";
import { runReconciliation } from "../../src/scripts/reconciliation/run.js";
import type { ReconPool } from "../../src/scripts/reconciliation/run.js";
import {
  applyTestFixtureExceptions,
  fingerprintStatementCoverage,
} from "../../src/scripts/reconciliation/test-fixtures.js";
import { detectStatementPaymentDrift } from "../../src/scripts/reconciliation/detectors.js";

type Row = Record<string, unknown>;

const makePool = (routes: {
  statementRows: Row[];
  coverageRows: Row[];
}): ReconPool => ({
  query: async (text: string) => {
    if (text.includes("statements_paid_sum")) return { rows: routes.coverageRows };
    // The canonical accounts_balance query embeds an `s.paid_cents`
    // subquery (card_paid_cents leg), so route it before the statement
    // branch: it must see no rows here, never statement-shaped rows.
    if (text.includes("AS account_id")) return { rows: [] };
    if (text.includes("s.paid_cents")) return { rows: routes.statementRows };
    return { rows: [] };
  },
});

describe("canonical statement_payment_coverage wiring", () => {
  it("includes coverage in CHECKS_BY_LAYOUT canonical (cutover gap closed)", () => {
    expect(CHECKS_BY_LAYOUT.canonical).toContain("statement_payment_coverage");
    expect(CHECKS_BY_LAYOUT.legacy).toContain("statement_payment_coverage");
  });

  it("derives canonical coverage from the structured payment link, SELECT-only", () => {
    const queries = buildReconciliationQueries("canonical", {});
    const coverage = queries.statement_payment_coverage;
    expect(isSelectOnly(coverage.text)).toBe(true);
    // Canonical payStatement writes transactions.statement_payment_id (V056);
    // the query must join statements to those transactions on the FK —
    // never on the free-text `Pagamento fatura {cycle}` description, so a
    // manual expense with the same text cannot satisfy coverage.
    expect(coverage.text).toMatch(/statements_paid_sum/);
    expect(coverage.text).toMatch(/statement_payment_id/);
    expect(coverage.text).toMatch(/cycle_year_month/);
    expect(coverage.text).not.toMatch(/Pagamento fatura/);
    // Only columns present in the canonical schema (V001/V004/V056).
    expect(coverage.text).not.toMatch(/from_account_id|to_account_id/);
  });

  it("keeps legacy coverage on description matching (semantics unchanged)", () => {
    const queries = buildReconciliationQueries("legacy", {});
    const coverage = queries.statement_payment_coverage;
    expect(isSelectOnly(coverage.text)).toBe(true);
    expect(coverage.text).toMatch(/Pagamento fatura/);
  });

  it("surfaces a canonical coverage gap as active drift (RED before fix, GREEN after)", async () => {
    const pool = makePool({
      statementRows: [
        {
          statement_id: "s1",
          household_id: "h-canon",
          cycle: "2026-08",
          total_cents: 3000,
          paid_cents: 3000,
          status: "paid",
        },
      ],
      coverageRows: [
        {
          household_id: "h-canon",
          cycle: "2026-08",
          statements_paid_sum: 3000,
          payment_tx_sum_cents: 0,
          statement_count: 1,
        },
      ],
    });
    const report = await runReconciliation(pool, "canonical", "h-canon");
    const statementPayment = report.checks.find((c) => c.check === "statement_payment");
    expect(
      statementPayment?.findings.some(
        (f) => f.kind === "payment_coverage_gap" && f.entityId === "h-canon|2026-08",
      ),
    ).toBe(true);
    expect(report.totals.drifted).toBeGreaterThan(0);
    // ADR-019 expects zero fixtures on canonical runs.
    expect(report.testFixtures?.coverage).toMatchObject({ expected: 0, matched: 0 });
  });

  it("passes valid canonical coverage with zero drift", async () => {
    const pool = makePool({
      statementRows: [
        {
          statement_id: "s1",
          household_id: "h-canon",
          cycle: "2026-08",
          total_cents: 3000,
          paid_cents: 3000,
          status: "paid",
        },
      ],
      coverageRows: [
        {
          household_id: "h-canon",
          cycle: "2026-08",
          statements_paid_sum: 3000,
          payment_tx_sum_cents: 3000,
          statement_count: 1,
        },
      ],
    });
    const report = await runReconciliation(pool, "canonical", "h-canon");
    const statementPayment = report.checks.find((c) => c.check === "statement_payment");
    expect(
      (statementPayment?.findings ?? []).filter((f) => f.kind === "payment_coverage_gap"),
    ).toHaveLength(0);
    expect(report.totals.drifted).toBe(0);
  });

  it("never suppresses canonical coverage findings via ADR-019 fixtures", () => {
    const source = {
      householdId: "h-canon",
      cycle: "2026-08",
      statementsPaidSum: 3000,
      paymentTxSumCents: 0,
      statementCount: 1,
    };
    const checks = [
      detectStatementPaymentDrift([], [
        {
          householdId: source.householdId,
          cycle: source.cycle,
          statementsPaidSum: source.statementsPaidSum,
          paymentTxSumCents: source.paymentTxSumCents,
          statementCount: source.statementCount,
        },
      ]),
    ];
    const allowlist = {
      version: "canonical-coverage-never-suppress-v1",
      coverageFingerprints: new Set([fingerprintStatementCoverage(source)]),
      payableFingerprints: new Set<string>(),
      expectedCoverage: 1,
      expectedPayables: 0,
    };
    const { checks: next, summary } = applyTestFixtureExceptions(
      checks,
      { coverages: [source], payables: [] },
      allowlist,
      undefined,
      "canonical",
    );
    const statementPayment = next.find((c) => c.check === "statement_payment");
    expect(
      statementPayment?.findings.some(
        (f) => f.kind === "payment_coverage_gap" && f.entityId === "h-canon|2026-08",
      ),
    ).toBe(true);
    expect(summary.coverage).toMatchObject({ expected: 0, matched: 0 });
  });
});
