import type { DbPool } from '../../db/pool.js';
import { applyMigrationTimeouts } from '../../db/pool.js';
import { requireTestDatabase } from '../../db/db-guard.js';
import { ARCHIVE_SCHEMA } from './archive-and-bootstrap.js';

/**
 * M3 canonical converter: balance recomputation (pure computation core).
 *
 * After the M2 import every canonical account lands with `balance_cents = 0`
 * and the V058 `initial_balance_cents` anchor backfilled from the archive.
 * This module recomputes the materialized balance, mirroring EXACTLY the
 * canonical write-path balance semantics after the slice-1 debt change
 * (ADR-018: `credit_card.balance_cents` is outstanding debt, nonnegative):
 *
 * - bank/cash (unchanged): `initial + income − expense − transfer_out +
 *   transfer_in`, mirroring `writes/postgres.ts` (`createIncomeInTx` adds,
 *   `createExpenseInTx` subtracts, `createTransferInTx` moves source→dest).
 *   A statement-payment expense (`statement_payment_id`, `statement_id`
 *   NULL) debits the payer exactly like a plain expense — the payer leg of
 *   `cards/postgres.ts` payStatementInTx. Statement-linked (`statement_id`)
 *   expenses stay excluded here, as before.
 * - credit_card (debt): `initial + SUM(live linked card-purchase expense
 *   transactions) − SUM(statements.paid_cents for the card)`, mirroring
 *   `cards/postgres.ts`: `createCardPurchaseInTx` / installments /
 *   PATCH-amount delta add to the card, cancel subtracts, and
 *   `payStatementInTx` subtracts the payment while adding it to
 *   `statements.paid_cents`. The canonical reconciliation
 *   (`reconciliation/sql.ts` accounts_balance) projects the same two legs
 *   (`card_purchase_cents`, `card_paid_cents`) and `detectors.ts`
 *   derives identically, so the two agree by construction.
 *
 * Consequences, all fail-closed (`BalanceError`, BEFORE any write):
 * - `card_purchases` is NEVER summed: the ledger transaction rows are the
 *   single source of purchases (no double-count with the projection).
 * - Historical statement payments with no `statement_payment_id` link are
 *   still represented, via `statements.paid_cents` (the payment-coverage
 *   detector stays separate and unchanged).
 * - Any other ledger movement touching a card (plain/unlinked expense,
 *   income, transfer in either leg, a payment row pointed at a card) is an
 *   orphan under the debt model: the write path never creates it, so this
 *   module refuses to guess instead of silently mis-deriving.
 * - A statement bound to an unknown account, to another household, to a
 *   non-card account, or carrying a negative paid amount is an orphan too.
 * - A card expense whose `statement_id` resolves to no same-card,
 *   same-household statement (missing id, foreign household, or a statement
 *   billed to another card) is an orphan too: it is rejected here, and the
 *   canonical reconciliation excludes it from the debt leg while raising
 *   `invalid_statement_link`, so it can never count as correctly linked debt.
 *
 * Domain rule (ADR-018 / V055): `bank`/`cash` results may be negative (no
 * clamp); a negative `credit_card` result fails closed BEFORE any write,
 * mirroring `assertCardDebtAllowed` in the write path.
 */

export class BalanceError extends Error {
  constructor(detail: string) {
    super(`cannot compute canonical balances: ${detail}`);
    this.name = 'BalanceError';
  }
}

/**
 * FINDING-2: money moves as bigint end-to-end. pg BIGINT money arrives as
 * a string; parsing through `number` silently loses precision past
 * 2^53-1. Every amount/anchor is parsed to bigint, summed in bigint, and
 * range-checked against the PostgreSQL BIGINT span before any write, with
 * writes bound as exact decimal strings.
 */
export const PG_BIGINT_MIN = -(2n ** 63n);
export const PG_BIGINT_MAX = 2n ** 63n - 1n;
/**
 * JSON boundary (reviewer P2): the converter sums in exact bigint up to the
 * PostgreSQL BIGINT span, but JSON clients consume `credit_card` debt as a
 * JS Number. Debt outside the safe-integer range would round on the wire,
 * so computed credit_card debt above 2^53-1 fails closed BEFORE any write.
 * bank/cash keep the BIGINT-only rule (ADR-018: they may be negative and
 * are not advertised as JSON-safe debt here).
 */
export const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

const MONEY_RE = /^-?\d+$/;

export const parseMoney = (value: unknown, what: string): bigint => {
  let text: string;
  if (typeof value === 'bigint') {
    text = value.toString();
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new BalanceError(`${what} is not a safe integer (${String(value)}): pass pg BIGINT money as a string`);
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new BalanceError(`${what} is not an exact integer (${String(value)})`);
  }
  if (!MONEY_RE.test(text)) {
    throw new BalanceError(`${what} is not an exact integer (${String(value)})`);
  }
  const parsed = BigInt(text);
  if (parsed < PG_BIGINT_MIN || parsed > PG_BIGINT_MAX) {
    throw new BalanceError(`${what} (${text}) exceeds the PostgreSQL BIGINT range`);
  }
  return parsed;
};

export type BalanceAccountInput = {
  id: string;
  householdId: string;
  kind: string;
  /** Anchor backfilled from the legacy origin; NULL/undefined means 0 (column DEFAULT 0). */
  initialBalanceCents: number | string | bigint | null | undefined;
};

export type BalanceTransactionInput = {
  id?: string | undefined;
  householdId: string;
  kind: 'income' | 'expense' | 'transfer' | string;
  accountId: string;
  transferToAccountId?: string | null | undefined;
  amountCents: number | string | bigint;
  /** Card-purchase link: rows carrying it have no balance effect (see header). */
  statementId?: string | null | undefined;
  /** Payment link: unresolvable here — fails closed (see header). */
  statementPaymentId?: string | null | undefined;
  deletedAt?: string | Date | null | undefined;
  deleted?: boolean | undefined;
};

export type AccountBalanceComputation = {
  accountId: string;
  householdId: string;
  kind: string;
  initial: bigint;
  income: bigint;
  expense: bigint;
  transferIn: bigint;
  transferOut: bigint;
  /** Debt leg: live linked card-purchase expenses (credit_card only). */
  cardPurchases: bigint;
  /** Debt leg: SUM(statements.paid_cents) for the card (credit_card only). */
  cardPaid: bigint;
  computed: bigint;
};

const isPresent = (value: unknown): boolean =>
  value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');

export type BalanceStatementInput = {
  id: string;
  householdId: string;
  /** Card account this statement bills (must be a known same-household credit_card). */
  accountId: string;
  /** Cumulative paid amount; the card credit leg of every payment. */
  paidCents: number | string | bigint;
};

/* ------------------------------------------------------------------ */
/* F2 inert-deleted-card: skip paid=0 statements on soft-deleted cards */
/*                                                                     */
/* readCanonicalState reads live accounts (deleted_at IS NULL) but ALL */
/* statements (no deleted_at column). A statement billing a            */
/* soft-deleted card therefore hits computeCanonicalBalances as        */
/* "unknown account" and fails closed. On the anonymized dump 5 such   */
/* statements exist, all paid=0 with no live ledger linkage.           */
/*                                                                     */
/* The skip below applies ONLY to BALANCE CALCULATION (never to        */
/* import/archive): a statement is excluded from the debt legs ONLY    */
/* when ALL hold — the billed account exists as a same-household       */
/* soft-deleted credit_card, paid_cents is exactly 0, no live          */
/* transaction links the statement, no live card_purchase links it,    */
/* and no live movement touches the deleted account (either ledger     */
/* leg or card_purchases). Anything else stays fail-closed with the    */
/* pre-existing unknown/orphan refusal. Evidence maps are keyed by id  */
/* only (no PII); a missing evidence entry fails closed.               */
/* ------------------------------------------------------------------ */

export type BalanceDeletedAccountInput = {
  id: string;
  householdId: string;
  kind: string;
};

export type InertDeletedCardEvidence = {
  /** Live transactions with statement_id = statement.id. */
  liveTransactionsLinked: number;
  /** Live card_purchases rows with statement_id = statement.id. */
  livePurchasesLinked: number;
  /** Live transactions touching the deleted account (either leg). */
  liveAccountTransactions: number;
  /** Live card_purchases rows touching the deleted account. */
  liveAccountPurchases: number;
};

export type InertStatementFilterResult = {
  kept: BalanceStatementInput[];
  skippedIds: string[];
};

const isInertEvidence = (evidence: InertDeletedCardEvidence | undefined, statementId: string): boolean => {
  if (!evidence) {
    throw new BalanceError(
      `statement '${statementId}' bills no live account: missing inert evidence, refusing to guess`,
    );
  }
  return (
    evidence.liveTransactionsLinked === 0 &&
    evidence.livePurchasesLinked === 0 &&
    evidence.liveAccountTransactions === 0 &&
    evidence.liveAccountPurchases === 0
  );
};

export const filterInertDeletedCardStatements = (
  statements: BalanceStatementInput[],
  liveAccountsById: Map<string, { householdId: string }> | Map<string, BalanceAccountInput>,
  deletedAccountsById: Map<string, BalanceDeletedAccountInput>,
  evidenceByStatementId: Map<string, InertDeletedCardEvidence>,
): InertStatementFilterResult => {
  const kept: BalanceStatementInput[] = [];
  const skippedIds: string[] = [];
  for (const statement of statements) {
    if (liveAccountsById.has(statement.accountId)) {
      kept.push(statement);
      continue;
    }
    const deleted = deletedAccountsById.get(statement.accountId);
    if (!deleted) {
      throw new BalanceError(
        `statement '${statement.id}' bills unknown account '${statement.accountId}': refusing to guess which card it credits`,
      );
    }
    if (deleted.householdId !== statement.householdId) {
      throw new BalanceError(
        `statement '${statement.id}' household mismatch (row holds another household's payment): refusing to credit across households`,
      );
    }
    if (deleted.kind !== 'credit_card') {
      throw new BalanceError(
        `statement '${statement.id}' bills non-card account '${deleted.id}' (kind '${deleted.kind}'): refusing to derive card debt from it`,
      );
    }
    const paid = parseMoney(statement.paidCents, `paid amount of statement '${statement.id}'`);
    if (paid !== 0n) {
      throw new BalanceError(
        `statement '${statement.id}' bills soft-deleted card '${deleted.id}' with nonzero paid_cents: refusing to skip a statement that still credits debt`,
      );
    }
    const evidence = evidenceByStatementId.get(statement.id);
    if (!isInertEvidence(evidence, statement.id)) {
      const e = evidence as InertDeletedCardEvidence;
      throw new BalanceError(
        `statement '${statement.id}' bills soft-deleted card '${deleted.id}' with live linkage (tx ${e.liveTransactionsLinked}, purchases ${e.livePurchasesLinked}, account tx ${e.liveAccountTransactions}, account purchases ${e.liveAccountPurchases}): refusing to skip`,
      );
    }
    skippedIds.push(statement.id);
  }
  return { kept, skippedIds };
};

export const computeCanonicalBalances = (
  accounts: BalanceAccountInput[],
  transactions: BalanceTransactionInput[],
  statements: BalanceStatementInput[] = [],
): AccountBalanceComputation[] => {
  const byId = new Map<string, AccountBalanceComputation>();
  for (const account of accounts) {
    if (!isPresent(account.id)) throw new BalanceError('account without id');
    if (!isPresent(account.householdId)) throw new BalanceError(`account '${String(account.id)}' without household`);
    if (byId.has(account.id)) throw new BalanceError(`duplicate account '${account.id}'`);
    const initial = account.initialBalanceCents === null || account.initialBalanceCents === undefined
      ? 0n
      : parseMoney(account.initialBalanceCents, `initial balance of account '${account.id}'`);
    byId.set(account.id, {
      accountId: account.id,
      householdId: account.householdId,
      kind: account.kind,
      initial,
      income: 0n,
      expense: 0n,
      transferIn: 0n,
      transferOut: 0n,
      cardPurchases: 0n,
      cardPaid: 0n,
      computed: initial,
    });
  }
  // Debt leg (slice 2): bind every statement to its card BEFORE the ledger
  // walk, fail-closed on orphans. The paid sum is applied after the walk so
  // the per-account detail keeps purchases and payments as separate legs.
  // The id-keyed map below also anchors the per-transaction link check in
  // the ledger walk: a card expense must resolve to a statement bound to the
  // SAME card and household, never to a missing, foreign, or other-card id.
  const paidByAccount = new Map<string, bigint>();
  const statementsById = new Map<string, BalanceStatementInput>();
  const seenStatements = new Set<string>();
  for (const statement of statements) {
    if (!isPresent(statement.id)) throw new BalanceError('statement without id');
    if (seenStatements.has(statement.id)) throw new BalanceError(`duplicate statement '${statement.id}'`);
    seenStatements.add(statement.id);
    const card = byId.get(statement.accountId);
    if (!card) {
      throw new BalanceError(
        `statement '${statement.id}' bills unknown account '${statement.accountId}': refusing to guess which card it credits`,
      );
    }
    if (statement.householdId !== card.householdId) {
      throw new BalanceError(
        `statement '${statement.id}' household mismatch (row holds another household's payment): refusing to credit across households`,
      );
    }
    if (card.kind !== 'credit_card') {
      throw new BalanceError(
        `statement '${statement.id}' bills non-card account '${card.accountId}' (kind '${card.kind}'): refusing to derive card debt from it`,
      );
    }
    const paid = parseMoney(statement.paidCents, `paid amount of statement '${statement.id}'`);
    if (paid < 0n) {
      throw new BalanceError(
        `statement '${statement.id}' carries negative paid_cents (${paid.toString()}): refusing before any write`,
      );
    }
    paidByAccount.set(card.accountId, (paidByAccount.get(card.accountId) ?? 0n) + paid);
    statementsById.set(statement.id, statement);
  }
  for (const tx of transactions) {
    if (tx.deleted === true || tx.deletedAt !== null && tx.deletedAt !== undefined) continue;
    const row = byId.get(tx.accountId);
    if (!row) throw new BalanceError(`transaction '${String(tx.id ?? '?')}' references unknown account '${tx.accountId}'`);
    if (tx.householdId !== row.householdId) {
      throw new BalanceError(
        `transaction '${String(tx.id ?? '?')}' household mismatch (row holds another household's movement)`,
      );
    }
    const amount = parseMoney(tx.amountCents, `amount of transaction '${String(tx.id ?? '?')}'`);
    if (amount <= 0n) throw new BalanceError(`transaction '${String(tx.id ?? '?')}' amount must be positive`);
    const isCard = row.kind === 'credit_card';
    if (tx.kind === 'income') {
      if (isCard) {
        throw new BalanceError(
          `income '${String(tx.id ?? '?')}' targets credit_card '${row.accountId}': the debt model has no income leg for cards, refusing to guess`,
        );
      }
      row.income += amount;
      row.computed += amount;
    } else if (tx.kind === 'expense') {
      if (isCard) {
        // Debt model: the ONLY ledger movement a card accepts is a live
        // linked purchase (adds debt). A payment row pointed at a card, or
        // any unlinked expense, is an orphan — the write path never writes
        // it, and the payment credit arrives via statements.paid_cents.
        if (isPresent(tx.statementPaymentId)) {
          throw new BalanceError(
            `transaction '${String(tx.id ?? '?')}' is a statement payment pointed at credit_card '${row.accountId}': payments debit the payer and credit via statements.paid_cents, refusing to double-count`,
          );
        }
        if (!isPresent(tx.statementId)) {
          throw new BalanceError(
            `transaction '${String(tx.id ?? '?')}' is an unlinked expense on credit_card '${row.accountId}': refusing to guess its statement`,
          );
        }
        // Wrong-statement hardening: the link must resolve to a statement
        // bound to THIS card and household (id + household + account).
        // A missing, foreign-household, or other-card statement_id is an
        // orphan: counting it would invent debt on the wrong card, so this
        // refuses BEFORE any write instead of silently dropping or
        // mis-attributing the transaction.
        const linked = statementsById.get(String(tx.statementId));
        if (!linked) {
          throw new BalanceError(
            `transaction '${String(tx.id ?? '?')}' links missing statement '${String(tx.statementId)}': refusing to count it as card debt`,
          );
        }
        if (linked.householdId !== tx.householdId || linked.householdId !== row.householdId) {
          throw new BalanceError(
            `transaction '${String(tx.id ?? '?')}' links statement '${linked.id}' of another household: refusing to credit across households`,
          );
        }
        if (linked.accountId !== row.accountId) {
          throw new BalanceError(
            `transaction '${String(tx.id ?? '?')}' links statement '${linked.id}' billed to account '${linked.accountId}', not to credit_card '${row.accountId}': refusing to attribute debt to the wrong card`,
          );
        }
        row.cardPurchases += amount;
        row.computed += amount;
        continue;
      }
      if (isPresent(tx.statementId)) continue;
      // bank/cash (and unknown kinds): every unlinked expense debits,
      // including the payer leg of a statement payment
      // (`statement_payment_id` with `statement_id` NULL). Imported (M2)
      // rows never carry `statement_payment_id` (the mapper leaves it
      // NULL), so converter data rarely hits this path, but live payer
      // debits must count exactly like the write path debits them.
      row.expense += amount;
      row.computed -= amount;
    } else if (tx.kind === 'transfer') {
      if (!isPresent(tx.transferToAccountId)) {
        throw new BalanceError(`transfer '${String(tx.id ?? '?')}' without transfer_to_account_id`);
      }
      const dest = byId.get(tx.transferToAccountId as string);
      if (!dest) {
        throw new BalanceError(
          `transfer '${String(tx.id ?? '?')}' references unknown destination account '${String(tx.transferToAccountId)}'`,
        );
      }
      if (dest.householdId !== row.householdId) {
        throw new BalanceError(`transfer '${String(tx.id ?? '?')}' crosses households`);
      }
      if (row.kind === 'credit_card' || dest.kind === 'credit_card') {
        throw new BalanceError(
          `transfer '${String(tx.id ?? '?')}' touches credit_card '${row.kind === 'credit_card' ? row.accountId : dest.accountId}': the debt model has no transfer leg for cards, refusing to guess`,
        );
      }
      if (dest.accountId === row.accountId) {
        throw new BalanceError(`transfer '${String(tx.id ?? '?')}' with identical account legs`);
      }
      row.transferOut += amount;
      row.computed -= amount;
      dest.transferIn += amount;
      dest.computed += amount;
    } else {
      throw new BalanceError(`transaction '${String(tx.id ?? '?')}' has unknown kind '${String(tx.kind)}'`);
    }
  }
  const out = [...byId.values()];
  // Debt leg, second half: subtract the bound statements' paid sums from
  // their cards (purchases already added during the walk). A card with no
  // statements keeps paid 0 — historical payments without a
  // `statement_payment_id` link are still represented here, via paid_cents.
  for (const row of out) {
    const paid = paidByAccount.get(row.accountId) ?? 0n;
    if (paid !== 0n) {
      // Reachable only for credit_card rows: statement binding above
      // already refused non-card targets.
      row.cardPaid += paid;
      row.computed -= paid;
    }
  }
  for (const row of out) {
    if (row.computed < PG_BIGINT_MIN || row.computed > PG_BIGINT_MAX) {
      throw new BalanceError(
        `account '${row.accountId}' balance (${row.computed.toString()}) exceeds the PostgreSQL BIGINT range: refusing before any write`,
      );
    }
    if (row.kind === 'credit_card' && row.computed > MAX_SAFE_CENTS) {
      throw new BalanceError(
        `account '${row.accountId}' (credit_card) debt (${row.computed.toString()}) exceeds Number.MAX_SAFE_INTEGER: refusing before any write`,
      );
    }
    if (row.kind === 'credit_card' && row.computed < 0n) {
      throw new BalanceError(
        `account '${row.accountId}' (credit_card) would go negative (${row.computed.toString()}): refusing before any write`,
      );
    }
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* I/O layer: backfill the V058 anchor, recompute, apply.              */
/*                                                                     */
/* The M2 import lands every account with `balance_cents = 0` and the  */
/* anchor at its DEFAULT 0 (the mapper refuses nonzero initials as     */
/* belt-and-braces). `backfillInitialBalances` copies the true anchor  */
/* from `legacy_archive.accounts`; `runBalancesStep` then recomputes   */
/* over the canonical tables and persists the result. Import.ts        */
/* intentionally does NOT call this: the orchestrator runs             */
/* `runBalancesStep` after `runCanonicalImport` (fail-closed           */
/* preconditions below mirror the import gates where they apply).      */
/* ------------------------------------------------------------------ */

export type BalancesStepOptions = {
  schema?: string | undefined;
  archiveSchema?: string | undefined;
  /** Restrict to one household; omitted processes every household present. */
  householdId?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
};

export type BackfillResult = {
  /** Canonical accounts updated with the archived anchor. */
  updated: number;
  /** Canonical accounts in scope (must equal updated, else fail-closed). */
  canonicalCount: number;
};

export type AppliedBalance = AccountBalanceComputation & { storedBefore: bigint };

export type BalancesStepResult = {
  households: string[];
  backfilled: BackfillResult;
  applied: AppliedBalance[];
  durationMs: number;
  /** F2 inert-deleted-card: statement ids skipped from balance calculation only (ids, no PII). */
  skippedInertStatementIds: string[];
};

type Row = Record<string, unknown>;

const quoteIdent = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const str = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new BalanceError('database returned an empty id');
  return value;
};

/**
 * Copies `initial_balance_cents` from the archived legacy accounts into the
 * canonical V058 anchor column (matched by id + household). Fail-closed when
 * the archive relation is absent or when any in-scope canonical account has
 * no archived anchor row — inventing a zero anchor would mask a true drift.
 */
export const backfillInitialBalances = async (
  pool: DbPool,
  opts: BalancesStepOptions = {},
): Promise<BackfillResult> => {
  const schema = opts.schema ?? 'public';
  const archiveSchema = opts.archiveSchema ?? ARCHIVE_SCHEMA;
  const params: unknown[] = [];
  const scope = opts.householdId === undefined
    ? ''
    : (() => {
      params.push(opts.householdId);
      return ` AND c.household_id = $1`;
    })();
  const archived = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'accounts') AS ok`,
    [archiveSchema],
  );
  if (archived.rows[0]?.ok !== true) {
    throw new BalanceError(`archive accounts table "${archiveSchema}.accounts" is missing: refusing to invent anchors`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyMigrationTimeouts(client);
    const updated = await client.query(
      `UPDATE ${quoteIdent(schema)}.accounts AS c
          SET initial_balance_cents = a.initial_balance_cents
         FROM ${quoteIdent(archiveSchema)}.accounts AS a
        WHERE c.id = a.id AND c.household_id = a.household_id AND c.deleted_at IS NULL${scope}`,
      params,
    );
    const counted = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${quoteIdent(schema)}.accounts AS c WHERE c.deleted_at IS NULL${scope}`,
      params,
    );
    const canonicalCount = Number(counted.rows[0]?.n ?? 0);
    const updatedCount = updated.rowCount ?? 0;
    if (updatedCount !== canonicalCount) {
      await client.query('ROLLBACK');
      throw new BalanceError(
        `anchor backfill matched ${updatedCount} of ${canonicalCount} canonical accounts: refusing to leave accounts unanchored`,
      );
    }
    await client.query('COMMIT');
    return { updated: updatedCount, canonicalCount };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure; surface the original error
    }
    throw error;
  } finally {
    client.release();
  }
};

const readCanonicalState = async (
  pool: DbPool,
  schema: string,
  householdId: string | undefined,
): Promise<{
  accounts: BalanceAccountInput[];
  transactions: BalanceTransactionInput[];
  statements: BalanceStatementInput[];
  skippedInertStatementIds: string[];
  storedBeforeByAccount: Map<string, bigint>;
}> => {
  const params: unknown[] = [];
  const scope = (column: string): string => {
    if (householdId === undefined) return '';
    params.push(householdId);
    return ` AND ${column} = $${params.length}`;
  };
  const accRes = await pool.query(
    `SELECT id, household_id, kind, initial_balance_cents, balance_cents
       FROM ${quoteIdent(schema)}.accounts
      WHERE deleted_at IS NULL${scope('household_id')}`,
    params,
  );
  const txParams: unknown[] = [];
  const txScope = householdId === undefined
    ? ''
    : (() => {
      txParams.push(householdId);
      return ` AND household_id = $1`;
    })();
  const txRes = await pool.query(
    `SELECT id, household_id, kind, account_id, transfer_to_account_id, amount_cents,
            statement_id, statement_payment_id, deleted_at
       FROM ${quoteIdent(schema)}.transactions
      WHERE deleted_at IS NULL${txScope}`,
    txParams,
  );
  // Debt leg (slice 2): every statement bills exactly one card; the paid
  // sums are the card credit legs. Household-scoped like the ledger, so a
  // statement can never credit another household's card. Statements carry
  // no deleted_at (lifecycle is the status column); cancelled statements
  // hold paid_cents 0 and contribute nothing.
  const stmtParams: unknown[] = [];
  const stmtScope = householdId === undefined
    ? ''
    : (() => {
      stmtParams.push(householdId);
      return ` AND household_id = $1`;
    })();
  const stmtRes = await pool.query(
    `SELECT id, household_id, account_id, paid_cents
       FROM ${quoteIdent(schema)}.statements
      WHERE 1 = 1${stmtScope}`,
    stmtParams,
  );
  const accounts: BalanceAccountInput[] = (accRes.rows as Row[]).map((r) => ({
    id: str(r['id']),
    householdId: str(r['household_id']),
    kind: String(r['kind']),
    initialBalanceCents: r['initial_balance_cents'] === null || r['initial_balance_cents'] === undefined
      ? 0n
      : parseMoney(r['initial_balance_cents'], `initial balance of account '${String(r['id'])}'`),
  }));
  const liveById = new Map(accounts.map((a) => [a.id, a]));
  const allStatements: BalanceStatementInput[] = (stmtRes.rows as Row[]).map((r) => ({
    id: String(r['id'] ?? ''),
    householdId: str(r['household_id']),
    accountId: str(r['account_id']),
    paidCents: parseMoney(r['paid_cents'], `paid amount of statement '${String(r['id'] ?? '')}'`),
  }));
  // F2 inert-deleted-card: candidates bill no live account. Fast path keeps
  // the common case (no orphans) on the existing 3 queries only.
  const candidates = allStatements.filter((s) => !liveById.has(s.accountId));
  let statements = allStatements;
  let skippedInertStatementIds: string[] = [];
  if (candidates.length > 0) {
    const evidence = await collectInertEvidence(pool, schema, householdId, candidates);
    const deletedById = new Map(evidence.deletedAccounts.map((a) => [a.id, a]));
    const filtered = filterInertDeletedCardStatements(
      allStatements,
      liveById,
      deletedById,
      evidence.byStatementId,
    );
    statements = filtered.kept;
    skippedInertStatementIds = filtered.skippedIds;
  }
  return {
    accounts,
    transactions: (txRes.rows as Row[]).map((r) => ({
      id: String(r['id'] ?? ''),
      householdId: str(r['household_id']),
      kind: String(r['kind']),
      accountId: str(r['account_id']),
      transferToAccountId: r['transfer_to_account_id'] === null || r['transfer_to_account_id'] === undefined
        ? null
        : String(r['transfer_to_account_id']),
      amountCents: parseMoney(r['amount_cents'], `amount of transaction '${String(r['id'] ?? '')}'`),
      statementId: r['statement_id'] === null || r['statement_id'] === undefined ? null : String(r['statement_id']),
      statementPaymentId:
        r['statement_payment_id'] === null || r['statement_payment_id'] === undefined
          ? null
          : String(r['statement_payment_id']),
      deletedAt: null,
    })),
    statements,
    skippedInertStatementIds,
    storedBeforeByAccount: new Map<string, bigint>(
      (accRes.rows as Row[]).map((r) => [
        str(r['id']),
        parseMoney(r['balance_cents'], `stored balance of account '${String(r['id'])}'`),
      ]),
    ),
  };
};

/**
 * F2 inert-deleted-card evidence (balance calculation only, never import).
 * For candidate statements billing no live account, loads the soft-deleted
 * account rows plus the four live-linkage counts each. All queries are
 * parameterized on ids (+ household when scoped) and select id/household/
 * kind/counts only — no names, descriptions, or other PII.
 */
const collectInertEvidence = async (
  pool: DbPool,
  schema: string,
  householdId: string | undefined,
  candidates: BalanceStatementInput[],
): Promise<{
  deletedAccounts: BalanceDeletedAccountInput[];
  byStatementId: Map<string, InertDeletedCardEvidence>;
}> => {
  const accountIds = [...new Set(candidates.map((s) => s.accountId))];
  const deletedAccounts: BalanceDeletedAccountInput[] = [];
  for (const accountId of accountIds) {
    const accParams: unknown[] = [accountId];
    const accScope = householdId === undefined
      ? ''
      : (() => {
        accParams.push(householdId);
        return ` AND household_id = $2`;
      })();
    const accRes = await pool.query(
      `SELECT id, household_id, kind FROM ${quoteIdent(schema)}.accounts WHERE id = $1 AND deleted_at IS NOT NULL${accScope}`,
      accParams,
    );
    for (const r of accRes.rows as Row[]) {
      deletedAccounts.push({ id: str(r['id']), householdId: str(r['household_id']), kind: String(r['kind']) });
    }
  }
  const purchasesExist = (
    await pool.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'card_purchases') AS ok`,
      [schema],
    )
  ).rows[0]?.ok === true;
  const purchasesHaveDeletedAt = purchasesExist &&
    (
      await pool.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'card_purchases' AND column_name = 'deleted_at') AS ok`,
        [schema],
      )
    ).rows[0]?.ok === true;
  const purchasesActiveScope = purchasesHaveDeletedAt ? ' AND deleted_at IS NULL' : '';
  const byStatementId = new Map<string, InertDeletedCardEvidence>();
  for (const statement of candidates) {
    const hhParams: unknown[] = [statement.id];
    const hhScope = householdId === undefined
      ? ''
      : (() => {
        hhParams.push(householdId);
        return ` AND household_id = $2`;
      })();
    const txLinked = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${quoteIdent(schema)}.transactions WHERE deleted_at IS NULL AND statement_id = $1${hhScope}`,
      hhParams,
    );
    const liveTransactionsLinked = Number((txLinked.rows as Row[])[0]?.n ?? 0);
    let livePurchasesLinked = 0;
    if (purchasesExist) {
      const pParams: unknown[] = [statement.id];
      const pScope = householdId === undefined
        ? ''
        : (() => {
          pParams.push(householdId);
          return ` AND household_id = $2`;
        })();
      const pLinked = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${quoteIdent(schema)}.card_purchases WHERE statement_id = $1${purchasesActiveScope}${pScope}`,
        pParams,
      );
      livePurchasesLinked = Number((pLinked.rows as Row[])[0]?.n ?? 0);
    }
    const acctParams: unknown[] = [statement.accountId];
    const acctScope = householdId === undefined
      ? ''
      : (() => {
        acctParams.push(householdId);
        return ` AND household_id = $2`;
      })();
    const acctTx = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${quoteIdent(schema)}.transactions WHERE deleted_at IS NULL AND (account_id = $1 OR transfer_to_account_id = $1)${acctScope}`,
      acctParams,
    );
    const liveAccountTransactions = Number((acctTx.rows as Row[])[0]?.n ?? 0);
    let liveAccountPurchases = 0;
    if (purchasesExist) {
      const apParams: unknown[] = [statement.accountId];
      const apScope = householdId === undefined
        ? ''
        : (() => {
          apParams.push(householdId);
          return ` AND household_id = $2`;
        })();
      const apRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${quoteIdent(schema)}.card_purchases WHERE account_id = $1${purchasesActiveScope}${apScope}`,
        apParams,
      );
      liveAccountPurchases = Number((apRes.rows as Row[])[0]?.n ?? 0);
    }
    byStatementId.set(statement.id, {
      liveTransactionsLinked,
      livePurchasesLinked,
      liveAccountTransactions,
      liveAccountPurchases,
    });
  }
  return { deletedAccounts, byStatementId };
};

/**
 * Transactionally persists recomputed balances (`accounts.balance_cents`).
 * The pure computation runs BEFORE the transaction opens, so a
 * `credit_card`-negative refusal never leaves a half-written household.
 */
export const applyBalances = async (
  pool: DbPool,
  schema: string,
  computed: AccountBalanceComputation[],
  storedBeforeByAccount: Map<string, bigint>,
): Promise<AppliedBalance[]> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyMigrationTimeouts(client);
    const applied: AppliedBalance[] = [];
    for (const row of computed) {
      // FINDING-2: bind the recomputed balance as an exact decimal string —
      // a JS number would lose precision past 2^53-1 on the way to pg.
      const res = await client.query(
        `UPDATE ${quoteIdent(schema)}.accounts
            SET balance_cents = $1, updated_at = NOW()
          WHERE id = $2 AND household_id = $3 AND deleted_at IS NULL`,
        [row.computed.toString(), row.accountId, row.householdId],
      );
      if ((res.rowCount ?? 0) !== 1) {
        throw new BalanceError(`account '${row.accountId}' vanished mid-apply: rolled back`);
      }
      applied.push({ ...row, storedBefore: storedBeforeByAccount.get(row.accountId) ?? 0n });
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure; surface the original error
    }
    throw error;
  } finally {
    client.release();
  }
};

/**
 * M3 pipeline step: backfill anchors from the archive, recompute balances
 * over the canonical tables, persist them. Returns per-account detail for
 * the conversion report. Any failure (unanchored account, unresolvable
 * payment leg, negative credit card, vanished row) aborts BEFORE a partial
 * write: backfill and apply are separate transactions and compute runs
 * between them.
 */
export const runBalancesStep = async (
  pool: DbPool,
  opts: BalancesStepOptions = {},
): Promise<BalancesStepResult> => {
  const schema = opts.schema ?? 'public';
  const startedAt = Date.now();
  const env = opts.env ?? process.env;
  if (env.NODE_ENV !== 'production') {
    await requireTestDatabase(pool, 'canonical-converter-balances');
  }
  const backfilled = await backfillInitialBalances(pool, opts);
  // FINDING-1: legacy card purchases may link via
  // `card_purchases.transaction_id` while the transaction row carries no
  // `statement_id` (V032/V033 normalization). Resolve those links BEFORE
  // reading the ledger, so linked purchases ADD to the card debt exactly
  // like the canonical write path adds them (an unlinked card expense
  // would fail closed as an orphan instead).
  await resolveStatementLinks(pool, opts);
  const state = await readCanonicalState(pool, schema, opts.householdId);
  const computed = computeCanonicalBalances(state.accounts, state.transactions, state.statements);
  const applied = await applyBalances(pool, schema, computed, state.storedBeforeByAccount);
  const households = [...new Set(applied.map((r) => r.householdId))].sort();
  return { households, backfilled, applied, durationMs: Date.now() - startedAt, skippedInertStatementIds: state.skippedInertStatementIds };
};

export type BalanceMismatch = {
  accountId: string;
  householdId: string;
  stored: bigint;
  expected: bigint;
};

export type BalancesVerification = {
  checked: number;
  mismatched: BalanceMismatch[];
};

/**
 * M4 read-only counterpart of `runBalancesStep`: recomputes balances from
 * anchor + ledger and compares against stored values WITHOUT writing.
 * Used as the post-step proof inside the completion report and as the
 * balances leg of the rerun no-op verification (`stored == anchor+ledger`).
 * Any mismatch (or an uncomputable ledger) fails closed via throw.
 */
export const verifyBalances = async (
  pool: DbPool,
  opts: BalancesStepOptions = {},
): Promise<BalancesVerification> => {
  const schema = opts.schema ?? 'public';
  const env = opts.env ?? process.env;
  if (env.NODE_ENV !== 'production') {
    await requireTestDatabase(pool, 'canonical-converter-balances-verify');
  }
  const state = await readCanonicalState(pool, schema, opts.householdId);
  const computed = computeCanonicalBalances(state.accounts, state.transactions, state.statements);
  const mismatched: BalanceMismatch[] = [];
  for (const row of computed) {
    const stored = state.storedBeforeByAccount.get(row.accountId) ?? 0n;
    if (stored !== row.computed) {
      mismatched.push({ accountId: row.accountId, householdId: row.householdId, stored, expected: row.computed });
    }
  }
  return { checked: computed.length, mismatched };
};

/* ------------------------------------------------------------------ */
/* FINDING-1: statement-link resolution (pre-balances step).            */
/*                                                                     */
/* Legacy card-purchase expenses may carry NO `statement_id` on the    */
/* transaction row itself: the link lives in                           */
/* `card_purchases.transaction_id -> card_purchases.statement_id`      */
/* (V032/V033 normalization). The M2 mapper copies `statement_id`      */
/* as-is, so without this step such a purchase would hit the debt      */
/* computation as an UNLINKED card expense and fail closed as an       */
/* orphan — while the canonical write path (`cards/postgres.ts`        */
/* createCardPurchaseInTx) always links a purchase to its statement    */
/* and adds it to the card debt.                                       */
/*                                                                     */
/* `resolveStatementLinks` backfills the canonical `transactions`      */
/* `statement_id` from the archived links, fail-closed when the        */
/* archive is incoherent: an orphan purchase (`transaction_id` with    */
/* no transaction), a transaction flagged `is_credit_card_purchase`    */
/* with no purchase row, or a purchase pointing at a missing           */
/* statement. Runs inside `runBalancesStep` before the ledger is       */
/* read; `verifyBalances` stays read-only and runs after it.           */
/* ------------------------------------------------------------------ */

export type StatementLinkResult = {
  /** Canonical transaction rows backfilled with the archived statement link. */
  backfilled: number;
  /** Archived card-purchase links examined. */
  checked: number;
};

const tableExists = async (pool: DbPool, schema: string, table: string): Promise<boolean> => {
  const res = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS ok`,
    [schema, table],
  );
  return (res.rows[0] as Row | undefined)?.ok === true;
};

const archiveColumnExists = async (pool: DbPool, schema: string, table: string, column: string): Promise<boolean> => {
  const res = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS ok`,
    [schema, table, column],
  );
  return (res.rows[0] as Row | undefined)?.ok === true;
};

export const resolveStatementLinks = async (
  pool: DbPool,
  opts: BalancesStepOptions = {},
): Promise<StatementLinkResult> => {
  const schema = opts.schema ?? 'public';
  const archiveSchema = opts.archiveSchema ?? ARCHIVE_SCHEMA;
  // REVIEW-R2-H: no early return when the archive `card_purchases` table is
  // absent. A transaction flagged `is_credit_card_purchase` with no purchase
  // table to resolve it must still fail closed below — otherwise it would be
  // silently debited as a plain expense. An absent table with no flagged
  // rows keeps the old quiet `{ backfilled: 0, checked: 0 }` result.
  const archivePurchasesExist = await tableExists(pool, archiveSchema, 'card_purchases');

  const params: unknown[] = [];
  // Pre-V032 archives may carry card_purchases without household_id: only
  // scope when the column exists (the link checks below are global then,
  // still fail-closed on orphans and missing statements).
  const purchasesHaveHousehold = archivePurchasesExist &&
    (opts.householdId === undefined ||
      (await archiveColumnExists(pool, archiveSchema, 'card_purchases', 'household_id')));
  const householdScope = (column: string): string => {
    if (opts.householdId === undefined || !purchasesHaveHousehold) return '';
    params.push(opts.householdId);
    return ` AND ${column} = $${params.length}`;
  };
  // Soft-deleted pairs are tombstones: preserved exactly as archived (their
  // existing statement_id values stay; NO backfill, NO balance effect, NO
  // resurrection). Only ACTIVE purchases enter the orphan/flag/statement
  // checks below. Guarded by column existence: pre-V033 archives carry no
  // deleted_at to filter on (and no soft-delete to ignore). The archived
  // transaction id-set intentionally stays `deleted_at IS NULL` only, so an
  // ACTIVE purchase pointing at a missing OR soft-deleted transaction still
  // fails closed below instead of guessing.
  const purchasesHaveDeletedAt = archivePurchasesExist &&
    (await archiveColumnExists(pool, archiveSchema, 'card_purchases', 'deleted_at'));
  const activePurchasesScope = purchasesHaveDeletedAt ? ' AND deleted_at IS NULL' : '';

  const purchasesRes = archivePurchasesExist
    ? await pool.query(
      `SELECT transaction_id, statement_id${purchasesHaveHousehold ? ', household_id' : ''} FROM ${quoteIdent(archiveSchema)}.${quoteIdent('card_purchases')} WHERE transaction_id IS NOT NULL${activePurchasesScope}${householdScope('household_id')}`,
      params,
    )
    : { rows: [] as Row[] };
  const purchases = (purchasesRes.rows as Row[]).map((r) => ({
    transactionId: String(r['transaction_id']),
    statementId: r['statement_id'] === null || r['statement_id'] === undefined ? null : String(r['statement_id']),
    householdId: String(r['household_id'] ?? ''),
  }));
  // NOTE: no early return on an empty purchase list — a transaction flagged
  // `is_credit_card_purchase` with no purchase row must still fail closed
  // below instead of silently debiting as a plain expense.

  const txParams: unknown[] = [];
  const txScope = opts.householdId === undefined
    ? ''
    : (() => {
      txParams.push(opts.householdId);
      return ` AND household_id = $1`;
    })();
  const archivedTxIds = new Set<string>();
  if (await tableExists(pool, archiveSchema, 'transactions')) {
    const txRes = await pool.query(
      `SELECT id FROM ${quoteIdent(archiveSchema)}.${quoteIdent('transactions')} WHERE deleted_at IS NULL${txScope}`,
      txParams,
    );
    const txRows = txRes.rows as Row[];
    for (const r of txRows) archivedTxIds.add(String(r['id']));
  }
  for (const purchase of purchases) {
    if (!archivedTxIds.has(purchase.transactionId)) {
      throw new BalanceError(
        `orphan card purchase links transaction '${purchase.transactionId}' with no archived transaction: refusing to guess its statement`,
      );
    }
  }

  if (await archiveColumnExists(pool, archiveSchema, 'transactions', 'is_credit_card_purchase')) {
    const flaggedRes = await pool.query(
      `SELECT id FROM ${quoteIdent(archiveSchema)}.${quoteIdent('transactions')} WHERE is_credit_card_purchase = true AND deleted_at IS NULL${txScope}`,
      txParams,
    );
    const flaggedRows = flaggedRes.rows as Row[];
    const linked = new Set(purchases.map((p) => p.transactionId));
    for (const r of flaggedRows) {
      if (!linked.has(String(r['id']))) {
        // REVIEW-R2-H: without the archive purchase table there is no link
        // to resolve at all — say so explicitly instead of reusing the
        // missing-row message.
        throw new BalanceError(
          archivePurchasesExist
            ? `transaction '${String(r['id'])}' is flagged is_credit_card_purchase with no card_purchases row: refusing to debit it as a plain expense`
            : `transaction '${String(r['id'])}' is flagged is_credit_card_purchase but archive "${archiveSchema}.card_purchases" is missing: cannot resolve its statement link, refusing to debit it as a plain expense`,
        );
      }
    }
  }

  const linkedStatementIds = [...new Set(purchases.map((p) => p.statementId).filter((id): id is string => id !== null))];
  if (linkedStatementIds.length > 0) {
    const stmtParams: unknown[] = [];
    const stmtScope = opts.householdId === undefined
      ? ''
      : (() => {
        stmtParams.push(opts.householdId);
        return ` AND household_id = $1`;
      })();
    const stmtRows = await tableExists(pool, archiveSchema, 'statements')
      ? (
        (
          await pool.query(
            `SELECT id FROM ${quoteIdent(archiveSchema)}.${quoteIdent('statements')}${stmtScope ? ` WHERE 1 = 1${stmtScope}` : ''}`,
            stmtParams,
          )
        ).rows as Row[]
      ).map((r) => String(r['id']))
      : [];
    const archivedStatements = new Set(stmtRows);
    for (const id of linkedStatementIds) {
      if (!archivedStatements.has(id)) {
        throw new BalanceError(
          `card purchase points at missing statement '${id}': refusing to link it`,
        );
      }
    }
  }

  if (!(await tableExists(pool, schema, 'card_purchases'))) return { backfilled: 0, checked: purchases.length };
  if (purchases.length === 0) return { backfilled: 0, checked: 0 };
  // REVIEW-R2-M1: the backfill below only fills `statement_id IS NULL` rows.
  // A transaction that ALREADY carries a statement_id divergent from its
  // linked purchase row would silently survive with the wrong link (and the
  // wrong balance effect). Detect that BEFORE the update and fail closed
  // with a bounded example list plus the total count. Scope is deliberately
  // narrow — both sides non-NULL and unequal: a NULL purchase statement
  // next to a copied transaction statement is left for the orphan/flag
  // checks above, not invented here.
  const divergentParams: unknown[] = [];
  const divergentScope = opts.householdId === undefined
    ? ''
    : (() => {
      divergentParams.push(opts.householdId);
      return ` AND t.household_id = $1`;
    })();
  // Same active-purchases scope on the canonical side: a soft-deleted
  // canonical purchase row must neither trigger a divergent-link refusal
  // nor feed the backfill (tombstones stay as-is). Household binding and
  // the active-transaction requirement (`t.deleted_at IS NULL`) are
  // preserved. Guarded by column existence like the archive side, so
  // pre-V033-shaped schemas keep the previous behavior instead of
  // erroring on a missing column.
  const canonPurchasesHaveDeletedAt = (await tableExists(pool, schema, 'card_purchases')) &&
    (await archiveColumnExists(pool, schema, 'card_purchases', 'deleted_at'));
  const canonActivePurchaseScope = canonPurchasesHaveDeletedAt ? ' AND cp.deleted_at IS NULL' : '';
  const divergentCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${quoteIdent(schema)}.${quoteIdent('transactions')} AS t
        JOIN ${quoteIdent(schema)}.${quoteIdent('card_purchases')} AS cp
          ON cp.transaction_id = t.id AND cp.household_id = t.household_id
       WHERE t.statement_id IS NOT NULL AND cp.statement_id IS NOT NULL
         AND t.statement_id <> cp.statement_id AND t.deleted_at IS NULL${canonActivePurchaseScope}${divergentScope}`,
    divergentParams,
  );
  const divergentTotal = Number((divergentCount.rows as Row[])[0]?.n ?? 0);
  if (divergentTotal > 0) {
    const divergentExamples = await pool.query(
      `SELECT t.id AS id, t.statement_id AS current_statement_id, cp.statement_id AS linked_statement_id
          FROM ${quoteIdent(schema)}.${quoteIdent('transactions')} AS t
          JOIN ${quoteIdent(schema)}.${quoteIdent('card_purchases')} AS cp
            ON cp.transaction_id = t.id AND cp.household_id = t.household_id
         WHERE t.statement_id IS NOT NULL AND cp.statement_id IS NOT NULL
           AND t.statement_id <> cp.statement_id AND t.deleted_at IS NULL${canonActivePurchaseScope}${divergentScope}
         ORDER BY t.id LIMIT 5`,
      divergentParams,
    );
    const examples = (divergentExamples.rows as Row[])
      .map((r) => `'${String(r['id'])}' holds '${String(r['current_statement_id'])}' but purchase links '${String(r['linked_statement_id'])}'`)
      .join('; ');
    throw new BalanceError(
      `${divergentTotal} transaction(s) already carry a statement_id divergent from the linked card_purchases row (e.g. ${examples}): refusing to silently keep the pre-existing link`,
    );
  }
  const backParams: unknown[] = [];
  const backScope = opts.householdId === undefined
    ? ''
    : (() => {
      backParams.push(opts.householdId);
      return ` AND t.household_id = $1`;
    })();
  const backfilled = await pool.query(
    `UPDATE ${quoteIdent(schema)}.${quoteIdent('transactions')} AS t
        SET statement_id = cp.statement_id
       FROM ${quoteIdent(schema)}.${quoteIdent('card_purchases')} AS cp
      WHERE cp.transaction_id = t.id AND cp.household_id = t.household_id
        AND t.statement_id IS NULL AND cp.statement_id IS NOT NULL AND t.deleted_at IS NULL${canonActivePurchaseScope}${backScope}`,
    backParams,
  );
  return { backfilled: backfilled.rowCount ?? 0, checked: purchases.length };
};
