import pg from "pg";
import { EXPECTED_ORPHAN_CARD_PURCHASES } from "./reconciliation/historical-exceptions.js";
import { isSelectOnly as isReconSelectOnly } from "./reconciliation/sql.js";

export const PREFLIGHT_QUERIES = {
  legacyAccounts: `SELECT COUNT(*)::int AS count FROM accounts WHERE deleted_at IS NULL`,
  orphanTransactions: `SELECT COUNT(*)::int AS count
    FROM transactions t
    LEFT JOIN accounts af ON af.id = t.from_account_id AND af.household_id = t.household_id AND af.deleted_at IS NULL
    LEFT JOIN accounts at_to ON at_to.id = t.to_account_id AND at_to.household_id = t.household_id AND at_to.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND (
      (t.kind = 'expense' AND (t.from_account_id IS NULL OR af.id IS NULL)) OR
      (t.kind = 'income' AND (t.to_account_id IS NULL OR at_to.id IS NULL)) OR
      (t.kind = 'transfer' AND (t.from_account_id IS NULL OR t.to_account_id IS NULL OR af.id IS NULL OR at_to.id IS NULL))
    )`,
  // ADR-017 policy (see buildCanonicalConversionPreflight below): only
  // non-NULL references that are missing, cross-household, or deleted
  // block here. Active NULLs are counted separately and gated against the
  // registered historical exception. This mirrors the importer, which
  // blocks invalid non-NULL references but preserves NULL
  // (import.ts `orphan_card_purchase_transactions`, mapper preserves NULL).
  orphanCardPurchasesInvalid: `SELECT COUNT(*)::int AS count
    FROM card_purchases cp
    LEFT JOIN transactions t ON t.id = cp.transaction_id AND t.household_id = cp.household_id
    WHERE cp.deleted_at IS NULL AND cp.transaction_id IS NOT NULL AND (t.id IS NULL OR t.deleted_at IS NOT NULL)`,
  // Active purchases with no linked transaction. Tolerated ONLY when the
  // count matches the registered ADR-017 exception exactly (see below);
  // any other nonzero count blocks as `orphan_card_purchases_unexpected_nulls`.
  orphanCardPurchasesNull: `SELECT COUNT(*)::int AS count
    FROM card_purchases cp
    WHERE cp.deleted_at IS NULL AND cp.transaction_id IS NULL`,
  duplicateCategories: `SELECT COUNT(*)::int AS count FROM (
    SELECT household_id, kind, parent_id, lower(name)
    FROM categories
    WHERE active = true AND deleted_at IS NULL
    GROUP BY household_id, kind, parent_id, lower(name)
    HAVING COUNT(*) > 1
  ) duplicates`,
  duplicateStatements: `SELECT COUNT(*)::int AS count FROM (
    SELECT household_id, account_id, cycle_year_month
    FROM statements
    GROUP BY household_id, account_id, cycle_year_month
    HAVING COUNT(*) > 1
  ) duplicates`,
  usersMissingEmail: `SELECT COUNT(*)::int AS count FROM users WHERE email IS NULL OR btrim(email) = ''`,
  // FIX (dry-run gate 2026-09-26): the old query joined
  // `u.auth_user_id = m.user_id`, which fails on post-V020 schemas where
  // memberships.user_id is UUID (`operator does not exist: text = uuid`)
  // and misses rows that resolve via the application id. The reference is
  // read as text through `to_jsonb` so the SAME query works whether
  // memberships.user_id is UUID (V020+) or TEXT (V017 legacy), and it
  // matches either identity with the mapper's precedence
  // (mapping.ts `resolveAppUserId`: application users.id first, then the
  // Better-Auth auth_user_id mapping).
  membershipsUnresolved: `SELECT COUNT(*)::int AS count
    FROM (SELECT (to_jsonb(m) ->> 'user_id') AS member_ref FROM memberships m) AS refs
    LEFT JOIN users u ON u.id::text = refs.member_ref OR u.auth_user_id = refs.member_ref
    WHERE u.id IS NULL`,
  // FIX (dry-run gate 2026-09-26): the old query referenced
  // `i.invited_by_user_id`, which does not exist post-V020 (real column:
  // `invited_by` UUID). Both column names are read through `to_jsonb`
  // (a missing key yields NULL instead of `undefined column`), with the
  // mapper's precedence (`row['invited_by'] ?? row['invited_by_user_id']`,
  // mapping.ts `mapInviteRow`). The NULL/empty guard preserves the old
  // optional-inviter semantics.
  invitesUnresolved: `SELECT COUNT(*)::int AS count
    FROM (SELECT COALESCE((to_jsonb(i) ->> 'invited_by'), (to_jsonb(i) ->> 'invited_by_user_id')) AS inviter FROM invites i) AS refs
    LEFT JOIN users u ON u.id::text = refs.inviter OR u.auth_user_id = refs.inviter
    WHERE refs.inviter IS NOT NULL AND refs.inviter <> '' AND u.id IS NULL`,
  unlinkedStatementPayments: `SELECT COUNT(*)::int AS count
    FROM statements s
    WHERE s.status = 'paid' AND s.paid_cents > 0`,
} as const;

export const isSelectOnly = isReconSelectOnly;

export type CanonicalConversionEvidence = {
  [K in keyof typeof PREFLIGHT_QUERIES]: number;
};

export type CanonicalConversionFinding = {
  code: string;
  blocker: boolean;
  count: number;
  repair?: never;
};

export type CanonicalConversionPreflight = {
  ready: boolean;
  findings: CanonicalConversionFinding[];
};

export const buildPostMigrationV055Gate = (evidence: {
  legacyBalanceConstraintPresent: boolean;
  cardOnlyConstraintPresent: boolean;
}): CanonicalConversionPreflight => {
  const findings: CanonicalConversionFinding[] = [];
  if (evidence.legacyBalanceConstraintPresent) {
    findings.push({ code: "v055_legacy_balance_constraint_present", blocker: true, count: 1 });
  }
  if (!evidence.cardOnlyConstraintPresent) {
    findings.push({ code: "v055_card_only_constraint_missing", blocker: true, count: 1 });
  }
  return { ready: findings.length === 0, findings };
};

export type ReadOnlyQuery = (query: string) => Promise<Array<{ count: unknown }>>;

const blocker = (code: string, count: number): CanonicalConversionFinding | null =>
  count > 0 ? { code, blocker: true, count } : null;

export const buildCanonicalConversionPreflight = (
  evidence: CanonicalConversionEvidence,
): CanonicalConversionPreflight => {
  // ADR-017 closed historical exception (pre-V033, 47 orphans): active
  // NULL-transaction purchases are the approved frozen state, NOT
  // corruption — but ONLY as the exact registered set. Recognition here is
  // count-locked against the registry's EXPECTED_ORPHAN_CARD_PURCHASES
  // (reconciliation/historical-exceptions.ts, allowlist
  // `adr-017-pre-v033-v1`): exact-fingerprint matching is impossible on an
  // anonymized clone because the scrub sets every card_purchases
  // description to 'anon' (scripts/anonymize-pg-copy.sql Step 2), while
  // counts, PKs, FKs, amounts, and dates are preserved. Fewer OR more than
  // the registered size means the set changed (relink, new orphan) and
  // blocks per the ADR-017 invariant ("nova ou alterada é erro/gate").
  // Row-identity verification stays with the reconciliation CLI
  // (`applyHistoricalExceptions` exact fingerprints on non-anonymized
  // data); this gate keeps the converter fail-closed without weakening it.
  const nullOrphans =
    evidence.orphanCardPurchasesNull === EXPECTED_ORPHAN_CARD_PURCHASES
      ? {
          code: "orphan_card_purchases_historical",
          blocker: false,
          count: evidence.orphanCardPurchasesNull,
        }
      : null;
  const findings = [
    evidence.legacyAccounts > 0
      ? { code: "legacy_accounts_default_to_bank", blocker: false, count: evidence.legacyAccounts }
      : null,
    blocker("orphan_transactions", evidence.orphanTransactions),
    blocker("orphan_card_purchases", evidence.orphanCardPurchasesInvalid),
    evidence.orphanCardPurchasesNull > 0 && evidence.orphanCardPurchasesNull !== EXPECTED_ORPHAN_CARD_PURCHASES
      ? {
          code: "orphan_card_purchases_unexpected_nulls",
          blocker: true,
          count: evidence.orphanCardPurchasesNull,
        }
      : null,
    nullOrphans,
    blocker("duplicate_categories", evidence.duplicateCategories),
    blocker("duplicate_statements", evidence.duplicateStatements),
    blocker("users_missing_email", evidence.usersMissingEmail),
    blocker("memberships_unresolved", evidence.membershipsUnresolved),
    blocker("invites_unresolved", evidence.invitesUnresolved),
    evidence.unlinkedStatementPayments > 0
      ? { code: "unlinked_statement_payments", blocker: false, count: evidence.unlinkedStatementPayments }
      : null,
  ].filter((finding): finding is CanonicalConversionFinding => finding !== null);

  return { ready: !findings.some((finding) => finding.blocker), findings };
};

export const runCanonicalConversionPreflight = async (
  query: ReadOnlyQuery,
): Promise<CanonicalConversionPreflight> => {
  const entries = await Promise.all(
    Object.entries(PREFLIGHT_QUERIES).map(async ([name, text]) => {
      const rows = await query(text);
      const count = Number(rows[0]?.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`canonical conversion preflight returned an invalid count for ${name}`);
      }
      return [name, count] as const;
    }),
  );
  return buildCanonicalConversionPreflight(
    Object.fromEntries(entries) as CanonicalConversionEvidence,
  );
};

export const main = async (
  env: Record<string, string | undefined>,
): Promise<number> => {
  const connectionString = env.DATABASE_URL?.trim() || env.DATABASE_URL_TEST?.trim();
  if (!connectionString) {
    process.stderr.write("canonical conversion preflight: DATABASE_URL (or DATABASE_URL_TEST) is not set\n");
    return 2;
  }
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    options: "-c default_transaction_read_only=on",
  });
  try {
    const report = await runCanonicalConversionPreflight(
      async (text) => (await pool.query(text)).rows as Array<{ count: unknown }>,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ready ? 0 : 1;
  } catch (error) {
    process.stderr.write(`canonical conversion preflight failed: ${(error as Error).message}\n`);
    return 2;
  } finally {
    await pool.end();
  }
};

const invokedAsCli =
  process.argv[1] !== undefined &&
  /canonical-conversion-preflight\.(ts|js)$/.test(process.argv[1]);

if (invokedAsCli) {
  void main(process.env as Record<string, string | undefined>).then((code) => {
    process.exitCode = code;
  });
}
