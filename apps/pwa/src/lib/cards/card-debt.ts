/**
 * Card outstanding-debt resolver (ADR-018 + card-balance-semantics-contract).
 *
 * Canonical layout: `credit_card.balance_cents` is the authoritative
 * outstanding debt (all live linked purchases − paid statements,
 * non-negative) AND the API tags the row with
 * `balanceSemantics: "outstanding_debt"`. Available credit =
 * `credit_limit_cents − balance_cents`. Per-statement `totalCents` is
 * per-cycle only and goes stale across cycles and partial payments, so it
 * must never stand in for the total when the discriminator is known.
 *
 * Legacy layout (production until the canonical cutover): the same DTO
 * field is computed as `initial + income − expense …` over transactions
 * where card purchases are `from_account_id` expenses, so a card with
 * purchases reads back zero or NEGATIVE. The API tags those rows with
 * `balanceSemantics: "legacy_calculated"` (or omits the field on rows
 * predating the contract). That value is not outstanding debt and must
 * not be displayed as such — even when it happens to be positive.
 *
 * Explicit rule (never infer layout from the balance value): authoritative
 * only when `balanceSemantics === "outstanding_debt"` AND the balance is a
 * safe non-negative integer. Anything else (legacy / absent / unknown)
 * returns `source: "statement-fallback"` and the caller keeps its existing
 * per-statement display.
 */

export type CardBalanceSemantics = "outstanding_debt" | "legacy_calculated";

export type CardDebtSource = "authoritative" | "statement-fallback";

export interface CardDebtInput {
  balanceCents?: number;
  creditLimitCents?: number;
  /** Optional discriminator from the API card DTO; absent/unknown = fallback. */
  balanceSemantics?: unknown;
}

export interface CardDebtResult {
  outstandingCents: number;
  availableCents: number | null;
  source: CardDebtSource;
}

export function isCanonicalCardDebt(
  balanceCents: unknown,
  balanceSemantics: unknown,
): boolean {
  if (balanceSemantics !== "outstanding_debt") return false;
  if (typeof balanceCents !== "number" || !Number.isSafeInteger(balanceCents)) return false;
  if (balanceCents < 0) return false;
  return true;
}

export function resolveCardOutstanding(
  card: CardDebtInput,
  opts: { statementFallbackCents: number },
): CardDebtResult {
  const fallback = opts.statementFallbackCents;
  const safeFallback =
    typeof fallback === "number" && Number.isSafeInteger(fallback) && fallback >= 0
      ? fallback
      : 0;
  const authoritative = isCanonicalCardDebt(card.balanceCents, card.balanceSemantics);
  const outstandingCents = authoritative
    ? (card.balanceCents as number)
    : safeFallback;
  const limit = card.creditLimitCents;
  const availableCents =
    typeof limit === "number" && Number.isSafeInteger(limit)
      ? limit - outstandingCents
      : null;
  return {
    outstandingCents,
    availableCents,
    source: authoritative ? "authoritative" : "statement-fallback",
  };
}
