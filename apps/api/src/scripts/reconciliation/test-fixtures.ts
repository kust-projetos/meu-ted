import { createHash } from "node:crypto";
import type {
  CheckResult,
  Finding,
  ReconProvenance,
  TestFixtureExceptionSummary,
} from "./detectors.js";

/**
 * ADR-019 closed test-fixture exception (3 coverage gaps + 2 payables,
 * legacy layout only).
 *
 * Read-only allowlist: exact SHA-256 fingerprints of the frozen snapshot.
 * No production ids, amounts, dates, descriptions, or household ids live here.
 * Matching happens after the normal detectors; only exact fingerprints are
 * suppressed, and any missing/changed fingerprint raises a drift gate so
 * `--fail-on-drift` exits 1. New/changed rows are never silently accepted.
 *
 * Provenance is intentionally separate from ADR-017: this module carries its
 * own version (`adr-019-test-fixtures-v1`) and its own report section
 * (`report.testFixtures`), so ADR-017 reporting stays untouched.
 */
export const TEST_FIXTURE_EXCEPTION_VERSION = "adr-019-test-fixtures-v1";

export const EXPECTED_TEST_FIXTURE_COVERAGE = 3;
export const EXPECTED_TEST_FIXTURE_PAYABLES = 2;

/**
 * Opaque SHA-256 of the approved test-fixture household id (ADR-019).
 * The raw household id is never stored here; incoming `--household` values
 * are hashed and compared against this hash.
 */
export const APPROVED_TEST_FIXTURE_HOUSEHOLD_HASH =
  "a3a9e1ed9732cab28868127be00f1ce921acaefdd5c3b23a6e9e0072bd9c1a34";

export const hashTestFixtureScope = (householdId: string): string =>
  createHash("sha256").update(householdId, "utf8").digest("hex");

export const STATEMENT_COVERAGE_FINGERPRINTS: readonly string[] = [
  "2de99015874335b128da0cd29700514362266526941086c20764519d2825da55",
  "95375375ac14898f4da6bce40ac4128136e7faf0573015d97b8ffc15576061cf",
  "53f9423d09912f642391369a5de470cc1f149effe9b8ba30e0e46ac72cf62c80",
];

export const PAYABLE_PAYMENT_FINGERPRINTS: readonly string[] = [
  "6429d196ab2ca36873e9940be15a69419f4cd1a81185de6a1dc51116d6f484e5",
  "0ac4d5ffb88440f81529a5c12ae6fbfcf1f8980af32a8a86c88bbf02f47f6ec9",
];

export type TestFixtureAllowlist = {
  version: string;
  coverageFingerprints: ReadonlySet<string>;
  payableFingerprints: ReadonlySet<string>;
  expectedCoverage: number;
  expectedPayables: number;
  /** Opaque hash of the approved test-fixture household; defaults to the ADR-019 hash. */
  approvedHouseholdScopeHash?: string;
};

export const APPROVED_TEST_FIXTURE_ALLOWLIST: TestFixtureAllowlist = {
  version: TEST_FIXTURE_EXCEPTION_VERSION,
  coverageFingerprints: new Set(STATEMENT_COVERAGE_FINGERPRINTS),
  payableFingerprints: new Set(PAYABLE_PAYMENT_FINGERPRINTS),
  expectedCoverage: EXPECTED_TEST_FIXTURE_COVERAGE,
  expectedPayables: EXPECTED_TEST_FIXTURE_PAYABLES,
  approvedHouseholdScopeHash: APPROVED_TEST_FIXTURE_HOUSEHOLD_HASH,
};

export type StatementCoverageFixtureSource = {
  householdId: string;
  cycle: string;
  statementsPaidSum: number;
  paymentTxSumCents: number;
  statementCount: number;
};

export type PayableFixtureSource = {
  payableId: string;
  householdId: string;
  accountId: string;
  description: string;
  amountCents: number;
  status: string;
  paidDate: string | null;
  paidTransactionId: string | null;
  paidTxExists: boolean;
  paidTxDeleted: boolean;
  paymentTxCount: number;
};

const sha256Hex = (preimage: string): string =>
  createHash("sha256").update(preimage, "utf8").digest("hex");

/** Exact ordered format: statement_payment_coverage:household:cycle:paid_sum:tx_sum:count */
export const fingerprintStatementCoverage = (
  source: StatementCoverageFixtureSource,
): string =>
  sha256Hex(
    [
      "statement_payment_coverage",
      source.householdId,
      source.cycle,
      String(source.statementsPaidSum),
      String(source.paymentTxSumCents),
      String(source.statementCount),
    ].join(":"),
  );

/** Exact ordered format: payable_payment:id:household:account:description:amount:status:paid_date-or-empty:tx-or-empty:exists:deleted:count */
export const fingerprintPayablePayment = (
  source: PayableFixtureSource,
): string =>
  sha256Hex(
    [
      "payable_payment",
      source.payableId,
      source.householdId,
      source.accountId,
      source.description,
      String(source.amountCents),
      source.status,
      source.paidDate ?? "",
      source.paidTransactionId ?? "",
      String(source.paidTxExists),
      String(source.paidTxDeleted),
      String(source.paymentTxCount),
    ].join(":"),
  );

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const toCoverageSource = (
  value: unknown,
): StatementCoverageFixtureSource | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["householdId"] !== "string" ||
    typeof row["cycle"] !== "string" ||
    !isFiniteNumber(row["statementsPaidSum"]) ||
    !isFiniteNumber(row["paymentTxSumCents"]) ||
    !isFiniteNumber(row["statementCount"])
  ) {
    return null;
  }
  return {
    householdId: row["householdId"] as string,
    cycle: row["cycle"] as string,
    statementsPaidSum: row["statementsPaidSum"] as number,
    paymentTxSumCents: row["paymentTxSumCents"] as number,
    statementCount: row["statementCount"] as number,
  };
};

const toPayableSource = (value: unknown): PayableFixtureSource | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["payableId"] !== "string" ||
    typeof row["householdId"] !== "string" ||
    typeof row["accountId"] !== "string" ||
    typeof row["description"] !== "string" ||
    !isFiniteNumber(row["amountCents"]) ||
    typeof row["status"] !== "string" ||
    (typeof row["paidDate"] !== "string" && row["paidDate"] !== null) ||
    (typeof row["paidTransactionId"] !== "string" &&
      row["paidTransactionId"] !== null) ||
    typeof row["paidTxExists"] !== "boolean" ||
    typeof row["paidTxDeleted"] !== "boolean" ||
    !isFiniteNumber(row["paymentTxCount"])
  ) {
    return null;
  }
  return {
    payableId: row["payableId"] as string,
    householdId: row["householdId"] as string,
    accountId: row["accountId"] as string,
    description: row["description"] as string,
    amountCents: row["amountCents"] as number,
    status: row["status"] as string,
    paidDate: row["paidDate"] as string | null,
    paidTransactionId: row["paidTransactionId"] as string | null,
    paidTxExists: row["paidTxExists"] as boolean,
    paidTxDeleted: row["paidTxDeleted"] as boolean,
    paymentTxCount: row["paymentTxCount"] as number,
  };
};

const pushGate = (
  check: CheckResult,
  kind: "statement_payment_coverage" | "payable_payment",
  expected: number,
  matched: number,
  version: string,
): void => {
  const finding: Finding = {
    check: check.check,
    entity: "reconciliation",
    entityId: `test_fixture:${kind}`,
    kind: "test_fixture_count_mismatch",
    severity: "drift",
    expected,
    actual: matched,
    detail: { version },
  };
  check.findings.push(finding);
  check.counts.drifted += 1;
};

/**
 * Suppress exact allowlisted findings after the normal detectors ran.
 * Returns cloned checks (checked accounting preserved) plus the summary.
 * ADR-019 is legacy-only: the count gate applies to legacy global runs and
 * to the legacy approved test-fixture household (full 3+2 closed set),
 * while any unrelated household expects zero known exceptions (the
 * fixture set lives elsewhere, so its absence is not a failure).
 * Canonical runs always expect zero ADR-019 fixtures and never suppress:
 * legacy-only coverage rows are absent by layout (not drift), and any
 * canonical payment_coverage_gap/missing_payment_transaction finding stays
 * as active drift. Active drift still fails in every scope.
 *
 * Provenance is explicit (default `historical` = baseline compat): `fresh`
 * declares a database that never held the closed fixture set, so both
 * classes expect zero on every layout/scope. Never inferred from layout.
 */
export const applyTestFixtureExceptions = (
  checks: CheckResult[],
  sources: { coverages: unknown[]; payables: unknown[] },
  allowlist: TestFixtureAllowlist = APPROVED_TEST_FIXTURE_ALLOWLIST,
  householdScope?: string,
  layout: "legacy" | "canonical" = "legacy",
  provenance: ReconProvenance = "historical",
): { checks: CheckResult[]; summary: TestFixtureExceptionSummary } => {
  const next = checks.map((check) => ({
    ...check,
    findings: [...check.findings],
    counts: { ...check.counts },
  }));
  const byCheck = new Map(next.map((check) => [check.check, check]));

  const coverageByKey = new Map<string, StatementCoverageFixtureSource>();
  for (const raw of sources.coverages) {
    const source = toCoverageSource(raw);
    if (source !== null) {
      const key = `${source.householdId}|${source.cycle}`;
      if (!coverageByKey.has(key)) coverageByKey.set(key, source);
    }
  }
  const payableById = new Map<string, PayableFixtureSource>();
  for (const raw of sources.payables) {
    const source = toPayableSource(raw);
    if (source !== null && !payableById.has(source.payableId)) {
      payableById.set(source.payableId, source);
    }
  }

  const approvedScopeHash =
    allowlist.approvedHouseholdScopeHash ??
    APPROVED_TEST_FIXTURE_HOUSEHOLD_HASH;
  const isApprovedHouseholdScope =
    householdScope !== undefined &&
    hashTestFixtureScope(householdScope) === approvedScopeHash;
  const isCanonicalLayout = layout === "canonical";
  const isFresh = provenance === "fresh";
  const expectedCoverage =
    isFresh || isCanonicalLayout ||
    (householdScope !== undefined && !isApprovedHouseholdScope)
      ? 0
      : allowlist.expectedCoverage;
  const expectedPayables =
    isFresh || isCanonicalLayout ||
    (householdScope !== undefined && !isApprovedHouseholdScope)
      ? 0
      : allowlist.expectedPayables;

  const summary: TestFixtureExceptionSummary = {
    version: allowlist.version,
    coverage: { expected: expectedCoverage, matched: 0, recognized: [] },
    payables: { expected: expectedPayables, matched: 0, recognized: [] },
  };

  const statementPayment = byCheck.get("statement_payment");
  if (statementPayment !== undefined && !isCanonicalLayout) {
    const remaining: Finding[] = [];
    for (const finding of statementPayment.findings) {
      if (
        finding.severity !== "drift" ||
        finding.kind !== "payment_coverage_gap"
      ) {
        remaining.push(finding);
        continue;
      }
      const source = coverageByKey.get(finding.entityId);
      if (
        source !== undefined &&
        allowlist.coverageFingerprints.has(fingerprintStatementCoverage(source))
      ) {
        summary.coverage.matched += 1;
        summary.coverage.recognized.push({
          entity: finding.entity,
          kind: finding.kind,
          entityId: finding.entityId,
        });
        continue;
      }
      remaining.push(finding);
    }
    statementPayment.findings = remaining;
    statementPayment.counts.drifted = remaining.filter(
      (finding) => finding.severity !== "info",
    ).length;
  }

  const payablePayment = byCheck.get("payable_payment");
  if (payablePayment !== undefined && !isCanonicalLayout) {
    const remaining: Finding[] = [];
    for (const finding of payablePayment.findings) {
      if (
        finding.severity !== "drift" ||
        finding.kind !== "missing_payment_transaction"
      ) {
        remaining.push(finding);
        continue;
      }
      const source = payableById.get(finding.entityId);
      if (
        source !== undefined &&
        allowlist.payableFingerprints.has(fingerprintPayablePayment(source))
      ) {
        summary.payables.matched += 1;
        summary.payables.recognized.push({
          entity: finding.entity,
          kind: finding.kind,
          entityId: finding.entityId,
        });
        continue;
      }
      remaining.push(finding);
    }
    payablePayment.findings = remaining;
    payablePayment.counts.drifted = remaining.filter(
      (finding) => finding.severity !== "info",
    ).length;
  }

  if (
    statementPayment !== undefined &&
    !isCanonicalLayout &&
    summary.coverage.matched !== expectedCoverage
  ) {
    pushGate(
      statementPayment,
      "statement_payment_coverage",
      expectedCoverage,
      summary.coverage.matched,
      allowlist.version,
    );
  }
  if (
    payablePayment !== undefined &&
    !isCanonicalLayout &&
    summary.payables.matched !== expectedPayables
  ) {
    pushGate(
      payablePayment,
      "payable_payment",
      expectedPayables,
      summary.payables.matched,
      allowlist.version,
    );
  }

  return { checks: next, summary };
};
