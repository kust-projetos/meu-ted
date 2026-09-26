import { describe, expect, it } from 'vitest';
import {
  BalanceError,
  computeCanonicalBalances,
  type BalanceAccountInput,
  type BalanceTransactionInput,
} from '../../src/scripts/canonical-converter/balances.js';

const household = '11111111-1111-4111-8111-111111111111';

const acc = (over: Partial<BalanceAccountInput> = {}): BalanceAccountInput => ({
  id: 'a1',
  householdId: household,
  kind: 'bank',
  initialBalanceCents: 0,
  ...over,
});

const tx = (over: Partial<BalanceTransactionInput> = {}): BalanceTransactionInput => ({
  id: 't1',
  householdId: household,
  kind: 'expense',
  accountId: 'a1',
  amountCents: 100,
  ...over,
});

describe('canonical converter balances (M3, pure)', () => {
  it('computes initial + income − expense − transfer_out + transfer_in', () => {
    const out = computeCanonicalBalances(
      [
        acc({ id: 'a1', initialBalanceCents: 500 }),
        acc({ id: 'a2', initialBalanceCents: 0 }),
      ],
      [
        tx({ id: 't-inc', kind: 'income', accountId: 'a1', amountCents: 1000 }),
        tx({ id: 't-exp', kind: 'expense', accountId: 'a1', amountCents: 200 }),
        tx({ id: 't-out', kind: 'transfer', accountId: 'a1', transferToAccountId: 'a2', amountCents: 150 }),
        tx({ id: 't-in', kind: 'transfer', accountId: 'a2', transferToAccountId: 'a1', amountCents: 50 }),
      ],
    );
    // a1: 500 + 1000 − 200 − 150 + 50 = 1200; a2: 0 + 150 − 50 = 100.
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.accountId === 'a1')).toMatchObject({
      computed: 1200n,
      initial: 500n,
      income: 1000n,
      expense: 200n,
      transferOut: 150n,
      transferIn: 50n,
    });
    expect(out.find((r) => r.accountId === 'a2')).toMatchObject({ computed: 100n });
  });

  it('excludes statement-linked expenses from bank/cash (purchases live on cards)', () => {
    const out = computeCanonicalBalances([acc({ initialBalanceCents: 1000 })], [
      tx({ id: 't-card', kind: 'expense', amountCents: 400, statementId: 's1' }),
    ]);
    // Slice 2 (ADR-018 debt): linked purchases ADD to credit_card debt;
    // a bank/cash row never carries one, so the legacy exclusion stays.
    expect(out[0]).toMatchObject({ computed: 1000n, expense: 0n });
  });

  it('debits payer statement-payment expenses on bank/cash; refuses them pointed at a card', () => {
    const bank = computeCanonicalBalances([acc({ initialBalanceCents: 1000 })], [
      tx({ id: 't-pay', kind: 'expense', amountCents: 400, statementPaymentId: 's1' }),
    ]);
    // payStatementInTx debits the payer exactly like a plain expense; the
    // card credit arrives via statements.paid_cents, never via this row.
    expect(bank[0]).toMatchObject({ computed: 600n, expense: 400n });
    expect(() =>
      computeCanonicalBalances([acc({ kind: 'credit_card', initialBalanceCents: 1000 })], [
        tx({ id: 't-pay-card', kind: 'expense', amountCents: 400, statementPaymentId: 's1' }),
      ]),
    ).toThrow(BalanceError);
  });

  it('lets bank/cash go negative but refuses a negative credit_card result', () => {
    const bank = computeCanonicalBalances([acc({ kind: 'bank', initialBalanceCents: 100 })], [
      tx({ amountCents: 250 }),
    ]);
    expect(bank[0]!.computed).toBe(-150n);
    // Slice 2: a plain (unlinked) expense on a card is an orphan under the
    // debt model — and a linked-purchases-minus-paid derivation that lands
    // negative is refused with no clamp. Both fail closed.
    expect(() =>
      computeCanonicalBalances([acc({ kind: 'credit_card', initialBalanceCents: 100 })], [
        tx({ amountCents: 250 }),
      ]),
    ).toThrow(BalanceError);
    expect(() =>
      computeCanonicalBalances(
        [acc({ kind: 'credit_card', initialBalanceCents: 100 })],
        [tx({ amountCents: 50, statementId: 's1' })],
        [{ id: 's1', householdId: household, accountId: 'a1', paidCents: 200 }],
      ),
    ).toThrow(BalanceError);
  });

  it('handles circular transfers with a zero net effect', () => {
    const out = computeCanonicalBalances(
      [acc({ id: 'a1', initialBalanceCents: 700 }), acc({ id: 'a2', initialBalanceCents: 300 })],
      [
        tx({ id: 't1', kind: 'transfer', accountId: 'a1', transferToAccountId: 'a2', amountCents: 200 }),
        tx({ id: 't2', kind: 'transfer', accountId: 'a2', transferToAccountId: 'a1', amountCents: 200 }),
      ],
    );
    expect(out.find((r) => r.accountId === 'a1')).toMatchObject({ computed: 700n });
    expect(out.find((r) => r.accountId === 'a2')).toMatchObject({ computed: 300n });
  });

  it('skips soft-deleted transactions and fails closed on orphans and bad amounts', () => {
    const out = computeCanonicalBalances([acc({ initialBalanceCents: 1000 })], [
      tx({ id: 't-del', amountCents: 999, deletedAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    expect(out[0]).toMatchObject({ computed: 1000n, expense: 0n });
    expect(() => computeCanonicalBalances([acc()], [tx({ accountId: 'ghost' })])).toThrow(BalanceError);
    expect(() => computeCanonicalBalances([acc()], [tx({ amountCents: 0 })])).toThrow(BalanceError);
    expect(() =>
      computeCanonicalBalances([acc()], [tx({ kind: 'transfer', transferToAccountId: undefined })]),
    ).toThrow(BalanceError);
    expect(() =>
      computeCanonicalBalances([acc()], [
        tx({ householdId: '22222222-2222-4222-8222-222222222222' }),
      ]),
    ).toThrow(BalanceError);
  });

  it('FINDING-2 RED: sums exactly beyond Number.MAX_SAFE_INTEGER in bigint', () => {
    // pg BIGINT money arrives as a string; a value past 2^53-1 must stay
    // exact instead of throwing or losing precision.
    const out = computeCanonicalBalances(
      [acc({ initialBalanceCents: '9007199254740993' })],
      [tx({ id: 't-big', kind: 'income', amountCents: '10' })],
    );
    expect(out[0]!.computed).toBe(9007199254741003n);
    expect(out[0]!.initial).toBe(9007199254740993n);
    expect(out[0]!.income).toBe(10n);
  });

  it('FINDING-2 RED: fails closed when the result exceeds the PostgreSQL BIGINT range', () => {
    expect(() =>
      computeCanonicalBalances(
        [acc({ initialBalanceCents: '9223372036854775807' })],
        [tx({ id: 't-over', kind: 'income', amountCents: 1 })],
      ),
    ).toThrow(/BIGINT/i);
  });

  it('JSON boundary: credit_card debt at 2^53-1 passes, at 2^53 fails closed before any write', () => {
    // Exact bigint is kept inside the converter; only the JSON-unsafe
    // credit_card result is refused. bank/cash keep the BIGINT-only rule.
    const card = (initial: string): BalanceAccountInput => acc({ id: 'a1', kind: 'credit_card', initialBalanceCents: initial });
    const ok = computeCanonicalBalances([card('9007199254740991')], []);
    expect(ok[0]!.computed).toBe(9007199254740991n);
    expect(() => computeCanonicalBalances([card('9007199254740992')], [])).toThrow(
      /MAX_SAFE_INTEGER/,
    );
    // Bank beyond safe still computes exactly (no JSON debt advertised).
    const bank = computeCanonicalBalances([acc({ initialBalanceCents: '9007199254740992' })], []);
    expect(bank[0]!.computed).toBe(9007199254740992n);
  });
});
