/**
 * Slice 2 RED: canonical card debt derivation.
 *
 * After the write-path change (slice 1) `credit_card.balance_cents` is
 * outstanding debt, nonnegative:
 *   card = initial_balance_cents
 *        + SUM(live linked card-purchase expense transactions)
 *        - SUM(statements.paid_cents for the card)
 * bank/cash keep the legacy derivation (initial + income − expense −
 * transfer_out + transfer_in). Exact bigint end-to-end, household
 * boundaries, fail-closed on orphan/negative, no card_purchases
 * double-count; historical statement payments without
 * statement_payment_id are represented via statements.paid_cents (the
 * payment-coverage detector stays separate).
 */
import { describe, expect, it } from 'vitest';
import {
  BalanceError,
  computeCanonicalBalances,
} from '../../src/scripts/canonical-converter/balances.js';
import { detectAccountsBalanceDrift } from '../../src/scripts/reconciliation/detectors.js';
import {
  buildReconciliationQueries,
  isSelectOnly,
} from '../../src/scripts/reconciliation/sql.js';

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const OTHER_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';

const card = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bank = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stmt1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const stmt2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';

const cardAccount = (over: Record<string, unknown> = {}) => ({
  id: card,
  householdId: HOUSEHOLD,
  kind: 'credit_card',
  initialBalanceCents: 0,
  ...over,
});

const bankAccount = (over: Record<string, unknown> = {}) => ({
  id: bank,
  householdId: HOUSEHOLD,
  kind: 'bank',
  initialBalanceCents: 5000,
  ...over,
});

const purchase = (id: string, amount: number | string, statementId: string | null) => ({
  id,
  householdId: HOUSEHOLD,
  kind: 'expense',
  accountId: card,
  amountCents: amount,
  statementId,
});

const cardStatements = (over: Record<string, unknown> = {}) => [
  {
    id: stmt1,
    householdId: HOUSEHOLD,
    accountId: card,
    paidCents: 20000,
    ...over,
  },
];

describe('slice 2 RED: canonical card debt derivation (pure compute)', () => {
  it('derives card debt as initial + linked purchases − statements.paid_cents', () => {
    const out = computeCanonicalBalances(
      [cardAccount()],
      [
        purchase('t1', 40000, stmt1),
        purchase('t2', 10000, stmt2),
      ],
      [
        ...cardStatements(),
        { id: stmt2, householdId: HOUSEHOLD, accountId: card, paidCents: 0 },
      ],
    );
    // 0 + (40000 + 10000) − 20000 = 30000.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ accountId: card, computed: 30000n });
  });

  it('counts a linked purchase exactly once (no card_purchases double-count)', () => {
    const out = computeCanonicalBalances(
      [cardAccount()],
      [purchase('t1', 40000, stmt1)],
      [{ id: stmt1, householdId: HOUSEHOLD, accountId: card, paidCents: 0 }],
    );
    expect(out[0]).toMatchObject({ computed: 40000n });
  });

  it('represents historical payments without statement_payment_id via statements.paid_cents', () => {
    // No payment transaction row at all — the card credit still applies.
    const out = computeCanonicalBalances(
      [cardAccount()],
      [purchase('t1', 40000, stmt1)],
      [{ id: stmt1, householdId: HOUSEHOLD, accountId: card, paidCents: 40000 }],
    );
    expect(out[0]).toMatchObject({ computed: 0n });
  });

  it('debits the payer statement-payment expense on bank accounts instead of failing closed', () => {
    const out = computeCanonicalBalances(
      [bankAccount()],
      [
        {
          id: 't-pay',
          householdId: HOUSEHOLD,
          kind: 'expense',
          accountId: bank,
          amountCents: 20000,
          statementId: null,
          statementPaymentId: stmt1,
        },
      ],
      [],
    );
    // 5000 − 20000 = −15000 (bank may go negative, ADR-018).
    expect(out[0]).toMatchObject({ computed: -15000n });
  });

  it('fails closed on a plain unlinked expense against a card (orphan ledger movement)', () => {
    expect(() =>
      computeCanonicalBalances(
        [cardAccount()],
        [
          {
            id: 't-plain',
            householdId: HOUSEHOLD,
            kind: 'expense',
            accountId: card,
            amountCents: 25000,
            statementId: null,
          },
        ],
        [],
      ),
    ).toThrow(BalanceError);
  });

  it('fails closed when the card derivation would go negative (no clamp)', () => {
    expect(() =>
      computeCanonicalBalances(
        [cardAccount({ initialBalanceCents: 10000 })],
        [purchase('t1', 5000, stmt1)],
        [{ id: stmt1, householdId: HOUSEHOLD, accountId: card, paidCents: 20000 }],
      ),
    ).toThrow(BalanceError);
  });

  it('fails closed on a statement bound to an unknown account (orphan)', () => {
    expect(() =>
      computeCanonicalBalances(
        [cardAccount()],
        [purchase('t1', 40000, stmt1)],
        [{ id: stmt1, householdId: HOUSEHOLD, accountId: 'ghost', paidCents: 0 }],
      ),
    ).toThrow(BalanceError);
  });

  it('fails closed on an invalid historical negative anchor (no silent clamp)', () => {
    // Production test data is disposable: a negative card anchor is invalid
    // history, refused — never clamped to zero.
    expect(() =>
      computeCanonicalBalances([cardAccount({ initialBalanceCents: -5000 })], [], []),
    ).toThrow(BalanceError);
  });

  it('fails closed on a statement household mismatch (boundary)', () => {
    expect(() =>
      computeCanonicalBalances(
        [cardAccount()],
        [purchase('t1', 40000, stmt1)],
        [{ id: stmt1, householdId: OTHER_HOUSEHOLD, accountId: card, paidCents: 0 }],
      ),
    ).toThrow(BalanceError);
  });

  it('keeps bank/cash derivation unchanged (statement links stay excluded)', () => {
    const out = computeCanonicalBalances(
      [bankAccount({ initialBalanceCents: 5000 })],
      [
        { id: 't-inc', householdId: HOUSEHOLD, kind: 'income', accountId: bank, amountCents: 1000 },
        { id: 't-exp', householdId: HOUSEHOLD, kind: 'expense', accountId: bank, amountCents: 200 },
      ],
      [],
    );
    expect(out[0]).toMatchObject({ computed: 5800n });
  });

  it('keeps bigint exact at 2^53-1 but fails closed at 2^53 (JSON boundary)', () => {
    const ok = computeCanonicalBalances(
      [cardAccount({ initialBalanceCents: '9007199254740991' })],
      [],
      [],
    );
    expect(ok[0]!.computed).toBe(9007199254740991n);
    expect(() =>
      computeCanonicalBalances(
        [cardAccount({ initialBalanceCents: '9007199254740993' })],
        [purchase('t-big', '10', stmt1)],
        [{ id: stmt1, householdId: HOUSEHOLD, accountId: card, paidCents: 0 }],
      ),
    ).toThrow(/MAX_SAFE_INTEGER/);
  });
});

describe('slice 2 RED: accounts_balance detector follows the debt derivation', () => {
  it('reports zero findings for a coherent card debt row', () => {
    const result = detectAccountsBalanceDrift([
      {
        accountId: card,
        householdId: HOUSEHOLD,
        storedCents: 30000,
        initialCents: 0,
        incomeCents: 0,
        expenseCents: 0,
        transferInCents: 0,
        transferOutCents: 0,
        accountKind: 'credit_card',
        cardPurchaseCents: 50000,
        cardPaidCents: 20000,
      },
    ]);
    expect(result.findings).toHaveLength(0);
    expect(result.counts).toEqual({ checked: 1, drifted: 0 });
  });

  it('flags a card row diverging from initial + purchases − paid', () => {
    const result = detectAccountsBalanceDrift([
      {
        accountId: card,
        householdId: HOUSEHOLD,
        storedCents: 10000,
        initialCents: 0,
        incomeCents: 0,
        expenseCents: 0,
        transferInCents: 0,
        transferOutCents: 0,
        accountKind: 'credit_card',
        cardPurchaseCents: 50000,
        cardPaidCents: 20000,
      },
    ]);
    expect(result.counts.drifted).toBe(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'balance_drift',
      expected: 30000,
      actual: 10000,
    });
  });
});

describe('slice 2 RED: canonical accounts_balance query projects the debt legs', () => {
  it('projects card purchase and paid legs and stays SELECT-only', () => {
    const query = buildReconciliationQueries('canonical', {}).accounts_balance;
    expect(isSelectOnly(query.text)).toBe(true);
    expect(query.text).toMatch(/card_purchase_cents/);
    expect(query.text).toMatch(/card_paid_cents/);
  });
});

describe('hardening RED: exact cents past 2^53 in the accounts_balance detector', () => {
  it('reports zero findings for a coherent balance past Number.MAX_SAFE_INTEGER', () => {
    // pg BIGINT money arrives as a decimal string; Number(...) would round
    // 9007199254740993 to 9007199254740992 and invent drift.
    const result = detectAccountsBalanceDrift([
      {
        accountId: bank,
        householdId: HOUSEHOLD,
        storedCents: '9007199254740993',
        initialCents: '9007199254740992',
        incomeCents: '1',
        expenseCents: 0,
        transferInCents: 0,
        transferOutCents: 0,
      },
    ]);
    expect(result.findings).toHaveLength(0);
    expect(result.counts).toEqual({ checked: 1, drifted: 0 });
  });

  it('catches a 1-cent drift past 2^53 with exact decimal strings (no rounding)', () => {
    const result = detectAccountsBalanceDrift([
      {
        accountId: bank,
        householdId: HOUSEHOLD,
        storedCents: '9007199254740993',
        initialCents: '9007199254740992',
        incomeCents: 0,
        expenseCents: 0,
        transferInCents: 0,
        transferOutCents: 0,
      },
    ]);
    expect(result.counts.drifted).toBe(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'balance_drift',
      expected: '9007199254740992',
      actual: '9007199254740993',
    });
    // The JSON report must survive the round-trip with no precision loss.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('fails closed on an unsafe JS number instead of computing on rounded input', () => {
    // 9007199254740993 is not representable: Number(...) already rounded it
    // to 9007199254740992 before the detector saw it — fail closed.
    const result = detectAccountsBalanceDrift([
      {
        accountId: bank,
        householdId: HOUSEHOLD,
        storedCents: 9007199254740993,
        initialCents: 9007199254740992,
        incomeCents: 0,
        expenseCents: 0,
        transferInCents: 0,
        transferOutCents: 0,
      },
    ]);
    expect(result.counts.drifted).toBe(1);
    expect(result.findings.map((f) => f.kind)).toContain('invalid_balance_input');
  });
});

describe('hardening RED: wrong-statement card debt is rejected, never counted', () => {
  it('rejects a card purchase pointing at a missing statement', () => {
    expect(() =>
      computeCanonicalBalances(
        [cardAccount()],
        [purchase('t-ghost', 10000, 'missing-statement')],
        cardStatements(),
      ),
    ).toThrow(BalanceError);
  });

  it('rejects a card purchase pointing at another card statement', () => {
    const card2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(() =>
      computeCanonicalBalances(
        [
          cardAccount(),
          { id: card2, householdId: HOUSEHOLD, kind: 'credit_card', initialBalanceCents: 0 },
        ],
        [purchase('t-wrong-card', 10000, stmt1)],
        [
          { id: stmt1, householdId: HOUSEHOLD, accountId: card2, paidCents: 0 },
        ],
      ),
    ).toThrow(BalanceError);
  });

  it('flags statement-linked debt that resolves to no same-card statement', () => {
    const result = detectAccountsBalanceDrift([
      {
        accountId: card,
        householdId: HOUSEHOLD,
        storedCents: 50000,
        initialCents: 0,
        incomeCents: 0,
        expenseCents: 0,
        transferInCents: 0,
        transferOutCents: 0,
        accountKind: 'credit_card',
        cardPurchaseCents: 50000,
        cardPaidCents: 0,
        cardInvalidCents: '5000',
      },
    ]);
    expect(result.findings.map((f) => f.kind)).toContain('invalid_statement_link');
  });

  it('restricts the canonical debt leg to same account+household statements (SELECT-only)', () => {
    const query = buildReconciliationQueries('canonical', {}).accounts_balance;
    expect(isSelectOnly(query.text)).toBe(true);
    expect(query.text).toMatch(/card_invalid_cents/);
    // The debt leg must join id + household + account: a purchase linked to
    // a missing, foreign-household, or other-card statement must not count
    // as correctly linked debt.
    expect(query.text).toMatch(/s\.id\s*=\s*t\.statement_id/);
    expect(query.text).toMatch(/s\.household_id/);
    expect(query.text).toMatch(/s\.account_id\s*=\s*a\.id/);
  });
});
