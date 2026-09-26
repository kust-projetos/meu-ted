export type SchemaLayout = "legacy" | "canonical";

export type ReconScope = { householdId?: string };

export type ReconQuery = { text: string; values: unknown[] };

export const RECON_CHECKS = [
  "accounts_balance",
  "statement_total",
  "statement_payment",
  "statement_payment_coverage",
  "payable_payment",
  "goal_contribution",
  "card_purchase",
  "dup_idempotency",
  "dup_orphan_transactions",
  "dup_orphan_card_purchases",
  "dup_recurring_payables",
  "dup_recurring_purchases",
] as const;

export type ReconCheck = (typeof RECON_CHECKS)[number];

export const CHECKS_BY_LAYOUT: Record<SchemaLayout, ReconCheck[]> = {
  canonical: [
    "accounts_balance",
    "statement_total",
    "statement_payment",
    "statement_payment_coverage",
    "payable_payment",
    "goal_contribution",
    "card_purchase",
    "dup_idempotency",
    "dup_orphan_transactions",
    "dup_orphan_card_purchases",
    "dup_recurring_payables",
    "dup_recurring_purchases",
  ],
  legacy: [...RECON_CHECKS],
};

export const isSelectOnly = (sql: string): boolean => {
  const noComments = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const noStrings = noComments.replace(/'(?:[^']|'')*'/g, "''");
  const statements = noStrings
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (statements.length !== 1) return false;
  const body = statements[0] as string;
  if (!/^(SELECT|WITH)\b/i.test(body)) return false;
  return !/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|CALL|DO|PERFORM|EXECUTE|LISTEN|NOTIFY|COMMENT)\b/i.test(
    body,
  );
};

const scoped = (
  column: string,
  scope: ReconScope,
  values: unknown[],
): string => {
  if (scope.householdId === undefined) return "";
  values.push(scope.householdId);
  return ` AND ${column} = $${values.length}`;
};

const accountsBalance = (
  layout: SchemaLayout,
  scope: ReconScope,
): ReconQuery => {
  const values: unknown[] = [];
  if (layout === "canonical") {
    // V058 anchor + slice-2 debt legs. bank/cash derive as
    // initial_balance_cents + income − expense − transfer_out + transfer_in
    // (detectors.ts detectAccountsBalanceDrift). Statement-linked purchase
    // expenses stay excluded from the expense leg; they are projected
    // separately as card_purchase_cents because the card write path
    // (cards/postgres.ts) ADDS purchases to credit_card.balance_cents
    // (outstanding debt). card_paid_cents sums statements.paid_cents bound
    // to the account + household — the card credit leg of every payment,
    // including historical payments with no statement_payment_id link
    // (their coverage stays with the statement_payment_coverage check).
    // card_purchases is never summed: the ledger rows are the single
    // purchase source, so no double-count with the projection.
    //
    // Wrong-statement hardening: the debt leg counts ONLY expenses whose
    // statement_id resolves to a statement bound to the SAME account and
    // household (id + household + account join). A purchase linked to a
    // missing, foreign-household, or other-card statement lands in
    // card_invalid_cents instead, so it can never count as correctly linked
    // debt — detectors.ts raises invalid_statement_link for it (credit_card
    // rows; bank/cash keep the pinned statement-link exclusion verbatim).
    const validStatementLink = `EXISTS (SELECT 1 FROM statements s WHERE s.id = t.statement_id AND s.household_id = a.household_id AND s.account_id = a.id)`;
    return {
      text: `SELECT a.id AS account_id, a.household_id,
        a.kind AS account_kind,
        a.balance_cents AS stored_cents,
        a.initial_balance_cents AS initial_cents,
        COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'income' AND t.account_id = a.id), 0)::bigint AS income_cents,
        COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'expense' AND t.account_id = a.id AND t.statement_id IS NULL), 0)::bigint AS expense_cents,
        COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'transfer' AND t.transfer_to_account_id = a.id), 0)::bigint AS transfer_in_cents,
        COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'transfer' AND t.account_id = a.id), 0)::bigint AS transfer_out_cents,
        COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'expense' AND t.account_id = a.id AND t.statement_id IS NOT NULL AND ${validStatementLink}), 0)::bigint AS card_purchase_cents,
        COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'expense' AND t.account_id = a.id AND t.statement_id IS NOT NULL AND NOT (${validStatementLink})), 0)::bigint AS card_invalid_cents,
        COALESCE((SELECT SUM(s.paid_cents) FROM statements s WHERE s.account_id = a.id AND s.household_id = a.household_id), 0)::bigint AS card_paid_cents
      FROM accounts a
      LEFT JOIN transactions t ON t.household_id = a.household_id AND t.deleted_at IS NULL
      WHERE a.deleted_at IS NULL${scoped("a.household_id", scope, values)}
      GROUP BY a.id, a.household_id, a.kind, a.balance_cents, a.initial_balance_cents
      ORDER BY a.household_id, a.id`,
      values,
    };
  }
  return {
    text: `SELECT a.id AS account_id, a.household_id,
      CASE WHEN a.is_credit_card THEN 'credit_card' ELSE 'bank' END AS account_kind,
      (COALESCE(a.initial_balance_cents, 0)
        + COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'income' AND t.to_account_id = a.id), 0)
        - COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'expense' AND t.from_account_id = a.id), 0)
        - COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'transfer' AND t.from_account_id = a.id), 0)
        + COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'transfer' AND t.to_account_id = a.id), 0))::bigint AS stored_cents,
      a.initial_balance_cents AS initial_cents,
      COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'income' AND t.to_account_id = a.id), 0)::bigint AS income_cents,
      COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'expense' AND t.from_account_id = a.id), 0)::bigint AS expense_cents,
      COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'transfer' AND t.to_account_id = a.id), 0)::bigint AS transfer_in_cents,
      COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'transfer' AND t.from_account_id = a.id), 0)::bigint AS transfer_out_cents
    FROM accounts a
    LEFT JOIN transactions t ON t.household_id = a.household_id AND t.deleted_at IS NULL
    WHERE a.deleted_at IS NULL${scoped("a.household_id", scope, values)}
    GROUP BY a.id, a.household_id, a.is_credit_card, a.initial_balance_cents
    ORDER BY a.household_id, a.id`,
    values,
  };
};

const statementTotal = (scope: ReconScope): ReconQuery => {
  const values: unknown[] = [];
  return {
    text: `SELECT s.id AS statement_id, s.household_id,
      s.total_cents AS stored_total_cents,
      COALESCE(SUM(t.amount_cents), 0)::bigint AS linked_sum_cents,
      COUNT(t.id)::int AS linked_count,
      COALESCE(cp.purchase_sum_cents, 0)::bigint AS purchase_sum_cents,
      COALESCE(cp.purchase_count, 0)::int AS purchase_count
    FROM statements s
    LEFT JOIN transactions t ON t.statement_id = s.id AND t.household_id = s.household_id AND t.deleted_at IS NULL
    LEFT JOIN (
      SELECT statement_id,
        COALESCE(SUM(amount_cents), 0)::bigint AS purchase_sum_cents,
        COUNT(*)::int AS purchase_count
      FROM card_purchases
      WHERE deleted_at IS NULL
      GROUP BY statement_id
    ) cp ON cp.statement_id = s.id
    WHERE 1 = 1${scoped("s.household_id", scope, values)}
    GROUP BY s.id, s.household_id, s.total_cents, cp.purchase_sum_cents, cp.purchase_count
    ORDER BY s.household_id, s.id`,
    values,
  };
};

const statementPayment = (scope: ReconScope): ReconQuery => {
  const values: unknown[] = [];
  return {
    text: `SELECT s.id AS statement_id, s.household_id,
      s.cycle_year_month AS cycle, s.total_cents, s.paid_cents, s.status
    FROM statements s
    WHERE 1 = 1${scoped("s.household_id", scope, values)}
    ORDER BY s.household_id, s.id`,
    values,
  };
};

const statementPaymentCoverage = (
  layout: SchemaLayout,
  scope: ReconScope,
): ReconQuery => {
  const values: unknown[] = [];
  if (layout === "canonical") {
    // Canonical (V056) per-statement grain: payStatement writes a structured
    // origin (transactions.statement_payment_id → statements.id). Coverage
    // projects one row per statement and sums only the payment legs linked
    // DIRECTLY to that statement id — never via the cycle, never on the
    // free-text display description. A manual `Pagamento fatura {cycle}`
    // expense (no link) counts nowhere, and a payment linked to the wrong
    // same-cycle statement leaves BOTH statements gapped instead of masking
    // inside a household+cycle aggregate.
    return {
      text: `SELECT s.id AS statement_id, s.household_id, s.cycle_year_month AS cycle,
        s.paid_cents AS statements_paid_sum,
        (SELECT COALESCE(SUM(t.amount_cents), 0)::bigint
          FROM transactions t
          WHERE t.statement_payment_id = s.id
            AND t.household_id = s.household_id
            AND t.deleted_at IS NULL
            AND t.kind = 'expense') AS payment_tx_sum_cents,
        1::int AS statement_count
      FROM statements s
      WHERE 1 = 1${scoped("s.household_id", scope, values)}
      ORDER BY s.household_id, s.id`,
      values,
    };
  }
  // Legacy semantics preserved verbatim: the legacy payStatement writes
  // only `Pagamento fatura {cycle}` with no structured link, so legacy
  // coverage keeps matching on household + cycle description.
  return {
    text: `SELECT s.household_id, s.cycle_year_month AS cycle,
      SUM(s.paid_cents)::bigint AS statements_paid_sum,
      (SELECT COALESCE(SUM(t.amount_cents), 0)::bigint
        FROM transactions t
        WHERE t.household_id = s.household_id
          AND t.deleted_at IS NULL
          AND t.kind = 'expense'
          AND t.description = 'Pagamento fatura ' || s.cycle_year_month) AS payment_tx_sum_cents,
      COUNT(*)::int AS statement_count
    FROM statements s
    WHERE 1 = 1${scoped("s.household_id", scope, values)}
    GROUP BY s.household_id, s.cycle_year_month
    ORDER BY s.household_id, s.cycle_year_month`,
    values,
  };
};

const payablePaymentBase = (
  layout: SchemaLayout,
  scope: ReconScope,
): ReconQuery => {
  const values: unknown[] = [];
  const accountMatch =
    layout === "canonical"
      ? "t.account_id = p.account_id"
      : "t.from_account_id = p.account_id";
  const paidAmount =
    layout === "canonical"
      ? "p.paid_amount_cents AS paid_amount_cents"
      : "NULL::bigint AS paid_amount_cents";
  return {
    text: `SELECT p.id AS payable_id, p.household_id, p.status, p.amount_cents,
      ${paidAmount},
      p.paid_transaction_id,
      p.account_id::text AS account_id,
      p.description AS description,
      p.paid_date::text AS paid_date,
      EXISTS(SELECT 1 FROM transactions t WHERE t.id = p.paid_transaction_id AND t.household_id = p.household_id AND t.deleted_at IS NULL) AS paid_tx_exists,
      EXISTS(SELECT 1 FROM transactions t WHERE t.id = p.paid_transaction_id AND t.household_id = p.household_id AND t.deleted_at IS NOT NULL) AS paid_tx_deleted,
      (SELECT COUNT(*)::int FROM transactions t
        WHERE t.household_id = p.household_id
          AND t.kind = 'expense'
          AND t.deleted_at IS NULL
          AND t.amount_cents = p.amount_cents
          AND t.description = p.description
          AND ${accountMatch}
          AND (p.paid_date IS NULL OR t.date = p.paid_date)) AS payment_tx_count
    FROM accounts_payable p
    WHERE p.deleted_at IS NULL${scoped("p.household_id", scope, values)}
    ORDER BY p.household_id, p.id`,
    values,
  };
};

const goalContribution = (scope: ReconScope): ReconQuery => {
  const values: unknown[] = [];
  return {
    text: `SELECT g.id AS goal_id, g.household_id,
      g.current_amount_cents AS stored_current_cents,
      COALESCE(SUM(c.amount_cents), 0)::bigint AS contributions_sum_cents,
      COUNT(c.id)::int AS contribution_count
    FROM goals g
    LEFT JOIN goal_contributions c ON c.goal_id = g.id
    WHERE 1 = 1${scoped("g.household_id", scope, values)}
    GROUP BY g.id, g.household_id, g.current_amount_cents
    ORDER BY g.household_id, g.id`,
    values,
  };
};

const cardPurchase = (scope: ReconScope): ReconQuery => {
  const values: unknown[] = [];
  return {
    text: `SELECT cp.id AS card_purchase_id, cp.household_id, cp.statement_id,
      cp.account_id::text AS account_id,
      cp.amount_cents AS purchase_amount_cents,
      cp.description AS purchase_description,
      cp.date::text AS purchase_date,
      cp.transaction_id AS tx_id,
      t.amount_cents AS tx_amount_cents,
      t.description AS tx_description,
      t.date::text AS tx_date,
      COALESCE(t.deleted_at IS NOT NULL, false) AS tx_deleted
    FROM card_purchases cp
    LEFT JOIN transactions t ON t.id = cp.transaction_id AND t.household_id = cp.household_id
    WHERE cp.deleted_at IS NULL${scoped("cp.household_id", scope, values)}
    ORDER BY cp.household_id, cp.id`,
    values,
  };
};

export const DUP_IDEMPOTENCY_LEGACY_SCOPE_CAST = "$1::uuid";
export const DUP_IDEMPOTENCY_CANONICAL_SCOPE_CAST = "$1::text";

const dupIdempotency = (
  layout: SchemaLayout,
  scope: ReconScope,
): ReconQuery => {
  const values: unknown[] = [];
  if (layout === "canonical") {
    // F2 2026-09-26: the scope predicate carries an explicit ::text cast
    // (the outer query projects household_id::text AS scope) so PG never
    // has to infer the parameter type.
    const scopeFilter =
      scope.householdId === undefined
        ? ""
        : (() => {
            values.push(scope.householdId);
            return ` WHERE scope = ${DUP_IDEMPOTENCY_CANONICAL_SCOPE_CAST}`;
          })();
    return {
      text: `SELECT scope, key, array_agg(DISTINCT payload_hash) AS payload_hashes FROM (
        SELECT household_id::text AS scope, key, payload_hash FROM idempotency_keys
        UNION ALL
        SELECT workspace_id::text AS scope, idempotency_key AS key, payload_hash FROM operation_records
      ) u${scopeFilter}
      GROUP BY scope, key HAVING COUNT(DISTINCT payload_hash) > 1`,
      values,
    };
  }
  // F2 2026-09-26 regression fix: the legacy branch used to share the
  // canonical scopeFilter push above AND push again here, emitting
  // `WHERE household_id = $2` with two bound values — $1 stayed unbound
  // and untyped, so every legacy --household run failed with
  // `could not determine data type of parameter $1`. Each branch now binds
  // exactly once, with an explicit ::uuid cast on the uuid column.
  const legacyFilter =
    scope.householdId === undefined
      ? ""
      : (() => {
          values.push(scope.householdId);
          return ` WHERE household_id = ${DUP_IDEMPOTENCY_LEGACY_SCOPE_CAST}`;
        })();
  return {
    text: `SELECT household_id::text AS scope, key, array_agg(DISTINCT payload_hash) AS payload_hashes
    FROM idempotency_keys${legacyFilter}
    GROUP BY household_id, key HAVING COUNT(DISTINCT payload_hash) > 1`,
    values,
  };
};

const dupOrphanTransactions = (
  layout: SchemaLayout,
  scope: ReconScope,
): ReconQuery => {
  const values: unknown[] = [];
  if (layout === "canonical") {
    return {
      text: `SELECT t.id AS transaction_id, t.household_id, t.account_id::text AS account_ref, 'missing_account' AS reason
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id AND a.deleted_at IS NULL
      WHERE t.deleted_at IS NULL AND a.id IS NULL${scoped("t.household_id", scope, values)}
      ORDER BY t.household_id, t.id`,
      values,
    };
  }
  return {
    text: `SELECT t.id AS transaction_id, t.household_id,
      COALESCE(t.from_account_id::text, t.to_account_id::text, 'none') AS account_ref,
      CASE
        WHEN t.kind = 'income' THEN 'missing_to_account'
        WHEN t.kind = 'transfer' AND t.from_account_id IS NULL THEN 'missing_from_account'
        WHEN t.kind = 'transfer' THEN 'missing_transfer_counterparty'
        ELSE 'missing_from_account'
      END AS reason
    FROM transactions t
    LEFT JOIN accounts af ON af.id = t.from_account_id AND af.deleted_at IS NULL
    LEFT JOIN accounts at_to ON at_to.id = t.to_account_id AND at_to.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND (
      (t.kind = 'expense' AND (t.from_account_id IS NULL OR af.id IS NULL))
      OR (t.kind = 'income' AND (t.to_account_id IS NULL OR at_to.id IS NULL))
      OR (t.kind = 'transfer' AND (t.from_account_id IS NULL OR t.to_account_id IS NULL OR af.id IS NULL OR at_to.id IS NULL))
    )${scoped("t.household_id", scope, values)}
    ORDER BY t.household_id, t.id`,
    values,
  };
};

const dupOrphanCardPurchases = (scope: ReconScope): ReconQuery => {
  const values: unknown[] = [];
  return {
    text: `SELECT cp.id AS card_purchase_id, cp.household_id, cp.transaction_id
    FROM card_purchases cp
    LEFT JOIN transactions t ON t.id = cp.transaction_id AND t.household_id = cp.household_id
    WHERE cp.deleted_at IS NULL
      AND (cp.transaction_id IS NULL OR t.id IS NULL OR t.deleted_at IS NOT NULL)${scoped("cp.household_id", scope, values)}
    ORDER BY cp.household_id, cp.id`,
    values,
  };
};

const dupRecurringPayables = (scope: ReconScope): ReconQuery => {
  const values: unknown[] = [];
  return {
    text: `SELECT household_id, description, due_date::text AS due_date, COUNT(*)::int AS n, array_agg(id::text) AS ids
    FROM accounts_payable
    WHERE deleted_at IS NULL AND status IN ('pending', 'overdue')${scoped("household_id", scope, values)}
    GROUP BY household_id, description, due_date HAVING COUNT(*) > 1
    ORDER BY household_id, description, due_date`,
    values,
  };
};

const dupRecurringPurchases = (scope: ReconScope): ReconQuery => {
  const values: unknown[] = [];
  return {
    text: `SELECT household_id, account_id::text AS account_id, description, start_date::text AS start_date, COUNT(*)::int AS n, array_agg(id::text) AS ids
    FROM recurring_purchases
    WHERE status = 'active'${scoped("household_id", scope, values)}
    GROUP BY household_id, account_id, description, start_date HAVING COUNT(*) > 1
    ORDER BY household_id, description, start_date`,
    values,
  };
};

export const buildReconciliationQueries = (
  layout: SchemaLayout,
  scope: ReconScope = {},
): Record<ReconCheck, ReconQuery> => {
  const full: Record<ReconCheck, ReconQuery> = {
    accounts_balance: accountsBalance(layout, scope),
    statement_total: statementTotal(scope),
    statement_payment: statementPayment(scope),
    statement_payment_coverage: statementPaymentCoverage(layout, scope),
    payable_payment: payablePaymentBase(layout, scope),
    goal_contribution: goalContribution(scope),
    card_purchase: cardPurchase(scope),
    dup_idempotency: dupIdempotency(layout, scope),
    dup_orphan_transactions: dupOrphanTransactions(layout, scope),
    dup_orphan_card_purchases: dupOrphanCardPurchases(scope),
    dup_recurring_payables: dupRecurringPayables(scope),
    dup_recurring_purchases: dupRecurringPurchases(scope),
  };
  return full;
};
