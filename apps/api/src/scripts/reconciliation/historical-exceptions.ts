import { createHash } from "node:crypto";
import type {
  CheckResult,
  Finding,
  HistoricalExceptionSummary,
  ReconProvenance,
} from "./detectors.js";

/**
 * ADR-017 closed historical exception (pre-V033, 47 orphans + 8 drifts).
 *
 * Read-only allowlist: exact SHA-256 fingerprints of the frozen snapshot.
 * No production ids, amounts, dates, descriptions, or household ids live here.
 * Matching happens after the normal detectors; only exact fingerprints are
 * suppressed, and any missing/changed fingerprint raises a drift gate so
 * `--fail-on-drift` exits 1. New/changed rows are never silently accepted.
 */
export const HISTORICAL_EXCEPTION_VERSION = "adr-017-pre-v033-v1";

export const EXPECTED_ORPHAN_CARD_PURCHASES = 47;
export const EXPECTED_STATEMENT_TOTALS = 8;

/**
 * Opaque SHA-256 of the approved historical household id (ADR-017).
 * The raw household id is never stored here; incoming `--household` values
 * are hashed and compared against this hash.
 */
export const APPROVED_HISTORICAL_HOUSEHOLD_HASH =
  "a3a9e1ed9732cab28868127be00f1ce921acaefdd5c3b23a6e9e0072bd9c1a34";

export const hashHouseholdScope = (householdId: string): string =>
  createHash("sha256").update(householdId, "utf8").digest("hex");

export const ORPHAN_CARD_PURCHASE_FINGERPRINTS: readonly string[] = [
  "af2f04e5f429967fc7710346d9d3d140001d8bdb32aaa73d577626d2a7c4417c",
  "23804b319e2e73d75d665172319bcd56056a206697967777e308970b215f8731",
  "865553ab3a64add1bafaa896b337b5fdd984bfaf48a3e902023bec810a82d1c7",
  "243564b7b65d8f9faf3649ec302726b6014cdb99aaa1d2268613c2d850ec683e",
  "9c594ac6c4d6e7e8800bbf73688e2a09d8d83b7f95c15e6ba03b76a45c6a1b69",
  "2edd6b77b73e1658f7fe18eb8c194238cc3b2b875e4753367e7eb84624f44e6e",
  "6b79a3a597cf41e191e99b3aaaa7a7d6cbf677013d4e3af8417586ec560041f8",
  "e7714249635e40fcd1a816a511cd786de65c0c884adda37846f5d6541a7fded9",
  "cc691b6b7e0b61a4e905c32c54d1599ddb41e0c40d07d01e3a6de261769d6803",
  "c8efef2bd8fe7ac2035713720b480c54f5513827bb0faa9fae6b10d4debf7276",
  "2913f5a13c023547a64239880c7e996cf55d3f81f72d6e31e15e850afd575cce",
  "6e1fa923c4b21cd1e73cd95cc41761cb17c77c5ef20b7671e6760dbd16bb74f5",
  "f6827e491ddf98a4621fd881e87fd182b90ff6511cfdf2c8cfaf0ec1478c03ff",
  "39d8137dda5eaf97d40ee30c96f01d8e5d114bc236218182d43fc69a111ff4fa",
  "441f3a2ace08affe46c7b3a1441513f5bbca1604f9d54d780cfbbe02a02926e5",
  "f55cfcf20eb0a32d625ac58dfebd8dd308688f1e36f0a1e979cc0ffc9a864d5e",
  "f8b76110b05c6b84256cf30d65d58810257abafe70a02392a71ff09275b4410a",
  "5ef1f2da0d573eede7422064cda10e2dfec2fd8e22b5e7abb2fead0f0dc83aaf",
  "5c723cc34562efc92169370948eb6f2957fe080f95b96206cd947aef69a7151b",
  "d8b4153aa72f191fa8b819ea012f9cbebca714c68243aca4a7b626a2d62c868f",
  "8829defc7edd8cb6668e2a73c0f5be54e42865f133de39ecffeb165ec078f5fe",
  "1c508acac1ef3f4b80708767605fb2fd2287a5b8443531abe1ebb537fb580690",
  "f34d5d81a82740c3675b5f4a7c7fc7945c8edac98ae3694a441ee87a8c714b54",
  "c421b98eabc5de96963ebd4e8f02001c816e8e07c666dc68e88c820d9199d369",
  "16b7232ae2fdf6a48d88a2688b0611e39de005efde4987fc95f192da83ed579a",
  "b0d82ae8314dd99e999588bae9fefc74858e7985930601a8a8777e762f4f2922",
  "a2fddf1250ff3d3c666af55a7d391bbe9a442d3878b5dc46ae2e497ef7c52186",
  "5f19714f4a0a9cd8e3b4995058859a4ef6d92db84f509b3089213fa8edaedbc3",
  "81562cb5b48d951f4f8a3e343205b9bdb9fee51124bd97b4af730a8c10904a34",
  "f21fb70018f2762afd4d378a94ab98f995a0ca125c1a0cdab1920792f3fbe18d",
  "96e4a6f3a9f0f8f289ede49b46eaecd72f43e400d0ec99a2a1997c2ddc377570",
  "12bd314bd1aebac760d362f5083fbd77046eae89772a56b4017b8f1cd9a5c56d",
  "5446dddbd1eb662775665606c6a88e0142815f17911b9dc97db3d0b43638854a",
  "d22bf74fb7cc782a30e3d84a4455a16801874f2053875b01ed115488e2aed1e9",
  "6b190a40b614c4988d616bdf1b30e6737a4fcc9dc39aef7756122e3fc6373df4",
  "b02678bc532c47a0172c8390df49d1cdbe10218988329224ef58fd11482b6e58",
  "99e79a94f10e0ba4cede9a9c4c2a473a22806e34046a3a85589b0813dcf45f18",
  "ee9ccebb0f9989e8349eb57d06a814bd2faa7f52abc95b651fde4c9531bebdaa",
  "d3eea0ecf7abda74aba5a49dd8a4078a17ca33cdf9942d2d4d06e97e6974e0d8",
  "c37058b92df4cc73b1eac0fc30a47bb17e2e949674b6681998ae923ecfcf9654",
  "2e007ec5501057442ee143b3753a396b5ace6d0d566b989cac67d277589e5021",
  "fac6afa3eb8387ed56f172664b77742d9de2272d3cec7331db40f14c076d45f0",
  "250f1a1bb612c697f1bc746227fd1c71d6ac460c364229acb596515c65695c51",
  "4f6ecbc5b1ba73552a10369620483a2510510d639ae660d9fb166b1be78bf805",
  "80a83d64ef2b464894aa5e9dc7bcd1be12024440d57cdbfac59c9a0c8faeafdf",
  "ed82bfb68c565c5f08f14f191d6ebd5df4d6d9a2dc363d293ca086406a52fa01",
  "ee6d7bf23a6849611a7931627dc73fd4a38a7465e55e6c0b60c37df636565e5a",
];

export const STATEMENT_TOTAL_FINGERPRINTS: readonly string[] = [
  "57b80970e0fa71c7eab7d5393cf668b6b2eb3bc9fdc6c253a036109fc6851e38",
  "518de30484db50080df364a53284677b45b59771baa5c21e4385461469d9b09c",
  "736021ef51a132ae3e8ab3baa8d9875c1e39fd1c7ccd0d29393e927c55d99b6f",
  "15cef88beeb956817a50d44b6328c2ad481084d50fe63042d9180eb9e3ff8b7b",
  "2db1fa607ff7ac18b85f0639590efb81404edf9b84c8684afe862af20d1f3b47",
  "1c182e158cb5f74c0bea7f03adfe904b2a408ef8cab4c2e42d97360933cef64a",
  "b7a618d7698cff5a28db98656c413b52c4599f3c16fe83ef4f1555a40af06150",
  "08e241cbc5686a2c15d32409ba6a8d39fd254caa090f873f01e8760c4b80079a",
];

/**
 * Allowlist v2 — conscious `negative_credit_balance` exception (ADR-018 §17,
 * recorded 2026-09-22, dossier
 * `docs/reports/v4.1-finding-814332c4-dossier.md`).
 *
 * Justificativa (pt-BR, concisa): recompra real reclassificada em 2026-09-22
 * para o fluxo de cartão; dívida de cartão não paga representada fielmente no
 * ledger legacy; exceção consciente (ADR-018/§17).
 *
 * Hash-only, como a v1: nenhum production id, amount, date, description ou
 * household id vive aqui — apenas o fingerprint opaco abaixo, derivado do
 * formato exato
 * `negative_credit_balance:<accountId>:<householdId>:<storedCents>:<accountKind>`
 * via {@link fingerprintNegativeCreditBalance}. A v1 (47 orphans + 8
 * statements, ADR-017) segue congelada e intocada.
 */
export const HISTORICAL_EXCEPTION_VERSION_V2 =
  "adr-018-conscious-negative-credit-v2";

export const NEGATIVE_CREDIT_BALANCE_RECORDED_AT = "2026-09-22";

/** v1 scope never accepted negatives: expected count is zero. */
export const EXPECTED_NEGATIVE_CREDIT_BALANCES_V1 = 0;

/** v2 extends v1 with exactly one conscious negative_credit_balance entry. */
export const EXPECTED_NEGATIVE_CREDIT_BALANCES = 1;

export const NEGATIVE_CREDIT_BALANCE_FINGERPRINTS: readonly string[] = [
  "8bb7f9776e6fe931e76e80d55f5b72f0e60712567775d1643ad54273ad2674be",
];

export type HistoricalAllowlist = {
  version: string;
  orphanCardPurchaseFingerprints: ReadonlySet<string>;
  statementTotalFingerprints: ReadonlySet<string>;
  expectedOrphanCardPurchases: number;
  expectedStatementTotals: number;
  /** v2 negative_credit_balance fingerprints; v1 scope carries an empty set. */
  negativeCreditBalanceFingerprints: ReadonlySet<string>;
  /** v2 expects 1; v1 scope expects 0 (negatives never belonged to ADR-017). */
  expectedNegativeCreditBalances: number;
  /** Opaque hash of the approved historical household; defaults to the ADR-017 hash. */
  approvedHouseholdScopeHash?: string;
};

export const APPROVED_HISTORICAL_ALLOWLIST: HistoricalAllowlist = {
  version: HISTORICAL_EXCEPTION_VERSION,
  orphanCardPurchaseFingerprints: new Set(ORPHAN_CARD_PURCHASE_FINGERPRINTS),
  statementTotalFingerprints: new Set(STATEMENT_TOTAL_FINGERPRINTS),
  expectedOrphanCardPurchases: EXPECTED_ORPHAN_CARD_PURCHASES,
  expectedStatementTotals: EXPECTED_STATEMENT_TOTALS,
  negativeCreditBalanceFingerprints: new Set(),
  expectedNegativeCreditBalances: EXPECTED_NEGATIVE_CREDIT_BALANCES_V1,
  approvedHouseholdScopeHash: APPROVED_HISTORICAL_HOUSEHOLD_HASH,
};

/**
 * Approved v2 allowlist: v1 scope (47 orphans + 8 statements, ADR-017,
 * frozen) plus exactly one conscious `negative_credit_balance` entry
 * (ADR-018 §17, recorded 2026-09-22).
 */
export const APPROVED_HISTORICAL_ALLOWLIST_V2: HistoricalAllowlist = {
  version: HISTORICAL_EXCEPTION_VERSION_V2,
  orphanCardPurchaseFingerprints: new Set(ORPHAN_CARD_PURCHASE_FINGERPRINTS),
  statementTotalFingerprints: new Set(STATEMENT_TOTAL_FINGERPRINTS),
  expectedOrphanCardPurchases: EXPECTED_ORPHAN_CARD_PURCHASES,
  expectedStatementTotals: EXPECTED_STATEMENT_TOTALS,
  negativeCreditBalanceFingerprints: new Set(
    NEGATIVE_CREDIT_BALANCE_FINGERPRINTS,
  ),
  expectedNegativeCreditBalances: EXPECTED_NEGATIVE_CREDIT_BALANCES,
  approvedHouseholdScopeHash: APPROVED_HISTORICAL_HOUSEHOLD_HASH,
};

export type OrphanExceptionSource = {
  cardPurchaseId: string;
  householdId: string;
  statementId: string;
  accountId: string;
  amountCents: number;
  purchaseDate: string;
  description: string;
  transactionId: string | null;
};

export type StatementExceptionSource = {
  statementId: string;
  householdId: string;
  storedTotalCents: number;
  linkedSumCents: number;
  linkedCount: number;
  purchaseSumCents: number;
  purchaseCount: number;
};

const sha256Hex = (preimage: string): string =>
  createHash("sha256").update(preimage, "utf8").digest("hex");

/** Exact ordered format: orphan_card_purchase:id:household:statement:account:amount:date:description:tx-or-empty */
export const fingerprintOrphanCardPurchase = (
  source: OrphanExceptionSource,
): string =>
  sha256Hex(
    [
      "orphan_card_purchase",
      source.cardPurchaseId,
      source.householdId,
      source.statementId,
      source.accountId,
      String(source.amountCents),
      source.purchaseDate,
      source.description,
      source.transactionId ?? "",
    ].join(":"),
  );

/** Exact ordered format: statement_total:id:household:stored:linked:count:purchase_sum:purchase_count */
export const fingerprintStatementTotal = (
  source: StatementExceptionSource,
): string =>
  sha256Hex(
    [
      "statement_total",
      source.statementId,
      source.householdId,
      String(source.storedTotalCents),
      String(source.linkedSumCents),
      String(source.linkedCount),
      String(source.purchaseSumCents),
      String(source.purchaseCount),
    ].join(":"),
  );

export type NegativeCreditBalanceSource = {
  accountId: string;
  householdId: string;
  storedCents: number;
  accountKind: string | null;
};

/** Exact ordered format: negative_credit_balance:account:household:stored:kind-or-empty */
export const fingerprintNegativeCreditBalance = (
  source: NegativeCreditBalanceSource,
): string =>
  sha256Hex(
    [
      "negative_credit_balance",
      source.accountId,
      source.householdId,
      String(source.storedCents),
      source.accountKind ?? "",
    ].join(":"),
  );

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const toOrphanSource = (value: unknown): OrphanExceptionSource | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["cardPurchaseId"] !== "string" ||
    typeof row["householdId"] !== "string" ||
    typeof row["statementId"] !== "string" ||
    (typeof row["accountId"] !== "string" && row["accountId"] !== null) ||
    !isFiniteNumber(row["amountCents"]) ||
    typeof row["purchaseDate"] !== "string" ||
    typeof row["description"] !== "string" ||
    (typeof row["transactionId"] !== "string" && row["transactionId"] !== null)
  ) {
    return null;
  }
  if (row["accountId"] === null) return null;
  return {
    cardPurchaseId: row["cardPurchaseId"] as string,
    householdId: row["householdId"] as string,
    statementId: row["statementId"] as string,
    accountId: row["accountId"] as string,
    amountCents: row["amountCents"] as number,
    purchaseDate: row["purchaseDate"] as string,
    description: row["description"] as string,
    transactionId: row["transactionId"] as string | null,
  };
};

const toStatementSource = (value: unknown): StatementExceptionSource | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["statementId"] !== "string" ||
    typeof row["householdId"] !== "string" ||
    !isFiniteNumber(row["storedTotalCents"]) ||
    !isFiniteNumber(row["linkedSumCents"]) ||
    !isFiniteNumber(row["linkedCount"]) ||
    !isFiniteNumber(row["purchaseSumCents"]) ||
    !isFiniteNumber(row["purchaseCount"])
  ) {
    return null;
  }
  return {
    statementId: row["statementId"] as string,
    householdId: row["householdId"] as string,
    storedTotalCents: row["storedTotalCents"] as number,
    linkedSumCents: row["linkedSumCents"] as number,
    linkedCount: row["linkedCount"] as number,
    purchaseSumCents: row["purchaseSumCents"] as number,
    purchaseCount: row["purchaseCount"] as number,
  };
};

const toNegativeCreditSource = (
  value: unknown,
): NegativeCreditBalanceSource | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["accountId"] !== "string" ||
    typeof row["householdId"] !== "string" ||
    !isFiniteNumber(row["storedCents"]) ||
    (typeof row["accountKind"] !== "string" &&
      row["accountKind"] !== null &&
      row["accountKind"] !== undefined)
  ) {
    return null;
  }
  return {
    accountId: row["accountId"] as string,
    householdId: row["householdId"] as string,
    storedCents: row["storedCents"] as number,
    accountKind: (row["accountKind"] as string | null | undefined) ?? null,
  };
};

const pushGate = (
  check: CheckResult,
  kind: "orphan_card_purchase" | "statement_total" | "negative_credit_balance",
  expected: number,
  matched: number,
  version: string,
): void => {
  const finding: Finding = {
    check: check.check,
    entity: "reconciliation",
    entityId: `historical_exception:${kind}`,
    kind: "historical_exception_count_mismatch",
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
 * The count gate applies to global runs and to every household-scoped run:
 * the approved historical household must present the full 47+8 closed set
 * (v1, ADR-017) plus the v2 conscious negative_credit_balance entry
 * (ADR-018 §17), while any unrelated household expects zero known exceptions
 * (the historical set lives elsewhere, so its absence is not a failure).
 * Active drift still fails in every scope.
 *
 * Provenance is explicit (default `historical` = baseline compat): `fresh`
 * declares a database that never held the closed historical set, so all
 * three classes expect zero. Suppression still applies per fingerprint, but
 * any matched fingerprint under `fresh` trips the count gate fail-closed —
 * a scoped record, never a broad ignore. Never inferred from layout.
 */
export const applyHistoricalExceptions = (
  checks: CheckResult[],
  sources: {
    orphans: unknown[];
    statements: unknown[];
    negativeCreditBalances?: unknown[];
  },
  allowlist: HistoricalAllowlist = APPROVED_HISTORICAL_ALLOWLIST,
  householdScope?: string,
  provenance: ReconProvenance = "historical",
): { checks: CheckResult[]; summary: HistoricalExceptionSummary } => {
  const next = checks.map((check) => ({
    ...check,
    findings: [...check.findings],
    counts: { ...check.counts },
  }));
  const byCheck = new Map(next.map((check) => [check.check, check]));

  const orphanById = new Map<string, OrphanExceptionSource>();
  for (const raw of sources.orphans) {
    const source = toOrphanSource(raw);
    if (source !== null && !orphanById.has(source.cardPurchaseId)) {
      orphanById.set(source.cardPurchaseId, source);
    }
  }
  const statementById = new Map<string, StatementExceptionSource>();
  for (const raw of sources.statements) {
    const source = toStatementSource(raw);
    if (source !== null && !statementById.has(source.statementId)) {
      statementById.set(source.statementId, source);
    }
  }
  const negativeCreditByAccountId = new Map<
    string,
    NegativeCreditBalanceSource
  >();
  for (const raw of sources.negativeCreditBalances ?? []) {
    const source = toNegativeCreditSource(raw);
    if (source !== null && !negativeCreditByAccountId.has(source.accountId)) {
      negativeCreditByAccountId.set(source.accountId, source);
    }
  }

  const approvedScopeHash =
    allowlist.approvedHouseholdScopeHash ?? APPROVED_HISTORICAL_HOUSEHOLD_HASH;
  const isApprovedHouseholdScope =
    householdScope !== undefined &&
    hashHouseholdScope(householdScope) === approvedScopeHash;
  const isFresh = provenance === "fresh";
  const expectedOrphans = isFresh
    ? 0
    : householdScope === undefined || isApprovedHouseholdScope
      ? allowlist.expectedOrphanCardPurchases
      : 0;
  const expectedStatements = isFresh
    ? 0
    : householdScope === undefined || isApprovedHouseholdScope
      ? allowlist.expectedStatementTotals
      : 0;
  const expectedNegativeCreditBalances = isFresh
    ? 0
    : householdScope === undefined || isApprovedHouseholdScope
      ? allowlist.expectedNegativeCreditBalances
      : 0;

  const summary: HistoricalExceptionSummary = {
    version: allowlist.version,
    orphanCardPurchases: {
      expected: expectedOrphans,
      matched: 0,
      recognized: [],
    },
    statementTotals: {
      expected: expectedStatements,
      matched: 0,
      recognized: [],
    },
    negativeCreditBalances: {
      expected: expectedNegativeCreditBalances,
      matched: 0,
      recognized: [],
    },
  };

  const duplicates = byCheck.get("duplicates");
  if (duplicates !== undefined) {
    const remaining: Finding[] = [];
    for (const finding of duplicates.findings) {
      if (
        finding.severity !== "drift" ||
        finding.kind !== "orphan_card_purchase"
      ) {
        remaining.push(finding);
        continue;
      }
      const source = orphanById.get(finding.entityId);
      if (
        source !== undefined &&
        allowlist.orphanCardPurchaseFingerprints.has(
          fingerprintOrphanCardPurchase(source),
        )
      ) {
        summary.orphanCardPurchases.matched += 1;
        summary.orphanCardPurchases.recognized.push({
          entity: finding.entity,
          kind: finding.kind,
          entityId: finding.entityId,
        });
        continue;
      }
      remaining.push(finding);
    }
    duplicates.findings = remaining;
    duplicates.counts.drifted = remaining.filter(
      (finding) => finding.severity !== "info",
    ).length;
  }

  const statementTotal = byCheck.get("statement_total");
  if (statementTotal !== undefined) {
    const remaining: Finding[] = [];
    for (const finding of statementTotal.findings) {
      if (finding.severity !== "drift" || finding.kind !== "total_drift") {
        remaining.push(finding);
        continue;
      }
      const source = statementById.get(finding.entityId);
      if (
        source !== undefined &&
        allowlist.statementTotalFingerprints.has(
          fingerprintStatementTotal(source),
        )
      ) {
        summary.statementTotals.matched += 1;
        summary.statementTotals.recognized.push({
          entity: finding.entity,
          kind: finding.kind,
          entityId: finding.entityId,
        });
        continue;
      }
      remaining.push(finding);
    }
    statementTotal.findings = remaining;
    statementTotal.counts.drifted = remaining.filter(
      (finding) => finding.severity !== "info",
    ).length;
  }

  if (
    duplicates !== undefined &&
    summary.orphanCardPurchases.matched !== expectedOrphans
  ) {
    pushGate(
      duplicates,
      "orphan_card_purchase",
      expectedOrphans,
      summary.orphanCardPurchases.matched,
      allowlist.version,
    );
  }
  if (
    statementTotal !== undefined &&
    summary.statementTotals.matched !== expectedStatements
  ) {
    pushGate(
      statementTotal,
      "statement_total",
      expectedStatements,
      summary.statementTotals.matched,
      allowlist.version,
    );
  }

  const accountsBalance = byCheck.get("accounts_balance");
  if (accountsBalance !== undefined) {
    const remaining: Finding[] = [];
    for (const finding of accountsBalance.findings) {
      if (
        finding.severity !== "drift" ||
        finding.kind !== "negative_credit_balance"
      ) {
        remaining.push(finding);
        continue;
      }
      const source = negativeCreditByAccountId.get(finding.entityId);
      if (
        source !== undefined &&
        allowlist.negativeCreditBalanceFingerprints.has(
          fingerprintNegativeCreditBalance(source),
        )
      ) {
        summary.negativeCreditBalances.matched += 1;
        summary.negativeCreditBalances.recognized.push({
          entity: finding.entity,
          kind: finding.kind,
          entityId: finding.entityId,
        });
        continue;
      }
      remaining.push(finding);
    }
    accountsBalance.findings = remaining;
    accountsBalance.counts.drifted = remaining.filter(
      (finding) => finding.severity !== "info",
    ).length;
  }

  if (
    accountsBalance !== undefined &&
    summary.negativeCreditBalances.matched !== expectedNegativeCreditBalances
  ) {
    pushGate(
      accountsBalance,
      "negative_credit_balance",
      expectedNegativeCreditBalances,
      summary.negativeCreditBalances.matched,
      allowlist.version,
    );
  }

  return { checks: next, summary };
};
