import { describe, expect, it } from "vitest";
import {
  buildCanonicalConversionPreflight,
  buildPostMigrationV055Gate,
  isSelectOnly,
  PREFLIGHT_QUERIES,
  runCanonicalConversionPreflight,
} from "../../src/scripts/canonical-conversion-preflight.js";
import { EXPECTED_ORPHAN_CARD_PURCHASES } from "../../src/scripts/reconciliation/historical-exceptions.js";

const cleanEvidence = () => ({
  legacyAccounts: 0,
  orphanTransactions: 0,
  orphanCardPurchasesInvalid: 0,
  orphanCardPurchasesNull: 0,
  duplicateCategories: 0,
  duplicateStatements: 0,
  usersMissingEmail: 0,
  membershipsUnresolved: 0,
  invitesUnresolved: 0,
  unlinkedStatementPayments: 0,
});

describe("canonical conversion preflight", () => {
  it("allows a clean legacy snapshot while reporting bank defaults and unlinked payments", () => {
    const report = buildCanonicalConversionPreflight({
      ...cleanEvidence(),
      legacyAccounts: 3,
      unlinkedStatementPayments: 4,
    });

    expect(report.ready).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({ code: "legacy_accounts_default_to_bank", blocker: false, count: 3 }),
      expect.objectContaining({ code: "unlinked_statement_payments", blocker: false, count: 4 }),
    ]);
  });

  it("blocks all ambiguous or invalid entities without proposing repairs", () => {
    const report = buildCanonicalConversionPreflight({
      ...cleanEvidence(),
      orphanTransactions: 2,
      orphanCardPurchasesInvalid: 1,
      duplicateCategories: 3,
      duplicateStatements: 4,
      usersMissingEmail: 5,
      membershipsUnresolved: 6,
      invitesUnresolved: 7,
    });

    expect(report.ready).toBe(false);
    expect(report.findings.filter((finding) => finding.blocker)).toHaveLength(7);
    expect(report.findings.every((finding) => finding.repair === undefined)).toBe(true);
  });

  it("uses SELECT-only queries for every database observation", () => {
    for (const query of Object.values(PREFLIGHT_QUERIES)) {
      expect(isSelectOnly(query)).toBe(true);
    }
  });

  it("blocks a converted clone until V055 has the card-only constraint", () => {
    expect(
      buildPostMigrationV055Gate({
        legacyBalanceConstraintPresent: true,
        cardOnlyConstraintPresent: false,
      }).ready,
    ).toBe(false);
    expect(
      buildPostMigrationV055Gate({
        legacyBalanceConstraintPresent: false,
        cardOnlyConstraintPresent: true,
      }).ready,
    ).toBe(true);
  });

  it("collects every query before returning a blocking report", async () => {
    const seen: string[] = [];
    const report = await runCanonicalConversionPreflight(async (query) => {
      seen.push(query);
      return [{ count: query === PREFLIGHT_QUERIES.orphanTransactions ? 1 : 0 }];
    });

    expect(seen).toHaveLength(Object.keys(PREFLIGHT_QUERIES).length);
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "orphan_transactions", blocker: true, count: 1 }),
    );
  });

  it("FIX-1: resolves memberships against users.id with a Better-Auth fallback (no TEXT=UUID comparison)", () => {
    // Regression: the old query joined `u.auth_user_id = m.user_id`, which
    // fails on post-V020 schemas where memberships.user_id is UUID
    // (`operator does not exist: text = uuid`). The effective-schema query
    // reads the reference as text in both eras and matches either identity.
    const sql = PREFLIGHT_QUERIES.membershipsUnresolved;
    expect(sql).toContain("u.id::text");
    expect(sql).toContain("u.auth_user_id");
    expect(sql).toContain("to_jsonb(m)");
    expect(sql).not.toMatch(/\bm\.user_id\b/);
  });

  it("FIX-1: resolves invites with the mapper's invited_by-first precedence and guards empty inviters", () => {
    // Regression: the old query referenced `i.invited_by_user_id`, which
    // does not exist post-V020 (real column: `invited_by` UUID).
    // Precedence mirrors mapping.ts (`row['invited_by'] ??
    // row['invited_by_user_id']`); the NULL/empty guard preserves the old
    // `IS NOT NULL` semantics for optional inviters.
    const sql = PREFLIGHT_QUERIES.invitesUnresolved;
    expect(sql).toContain("u.id::text");
    expect(sql).toContain("u.auth_user_id");
    expect(sql.indexOf("'invited_by'")).toBeGreaterThan(-1);
    expect(sql.indexOf("'invited_by'")).toBeLessThan(sql.indexOf("'invited_by_user_id'"));
    expect(sql).not.toMatch(/\bi\.invited_by(_user_id)?\b/);
    expect(sql).toContain("IS NOT NULL");
  });

  it("FIX-2: pins the registered ADR-017 orphan exception size", () => {
    expect(EXPECTED_ORPHAN_CARD_PURCHASES).toBe(47);
  });

  it("FIX-2: recognizes exactly the registered ADR-017 NULL set as a non-blocking historical exception", () => {
    const report = buildCanonicalConversionPreflight({
      ...cleanEvidence(),
      orphanCardPurchasesNull: EXPECTED_ORPHAN_CARD_PURCHASES,
    });

    expect(report.ready).toBe(true);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "orphan_card_purchases_historical",
        blocker: false,
        count: EXPECTED_ORPHAN_CARD_PURCHASES,
      }),
    );
  });

  it("FIX-2: blocks when the active NULL set grows beyond the registered exception (one extra NULL)", () => {
    const report = buildCanonicalConversionPreflight({
      ...cleanEvidence(),
      orphanCardPurchasesNull: EXPECTED_ORPHAN_CARD_PURCHASES + 1,
    });

    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "orphan_card_purchases_unexpected_nulls",
        blocker: true,
        count: EXPECTED_ORPHAN_CARD_PURCHASES + 1,
      }),
    );
  });

  it("FIX-2: blocks when the active NULL set shrinks below the registered exception (changed set)", () => {
    const report = buildCanonicalConversionPreflight({
      ...cleanEvidence(),
      orphanCardPurchasesNull: EXPECTED_ORPHAN_CARD_PURCHASES - 1,
    });

    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "orphan_card_purchases_unexpected_nulls",
        blocker: true,
        count: EXPECTED_ORPHAN_CARD_PURCHASES - 1,
      }),
    );
  });

  it("FIX-2: blocks invalid non-NULL card-purchase references (missing/wrong-household/deleted)", () => {
    const report = buildCanonicalConversionPreflight({
      ...cleanEvidence(),
      orphanCardPurchasesInvalid: 1,
    });

    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "orphan_card_purchases", blocker: true, count: 1 }),
    );
  });
});
