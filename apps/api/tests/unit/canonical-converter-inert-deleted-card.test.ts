import { describe, expect, it } from 'vitest';
import {
  BalanceError,
  computeCanonicalBalances,
  filterInertDeletedCardStatements,
} from '../../src/scripts/canonical-converter/balances.js';

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const CARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STMT = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';

const liveCard = () => ({
  id: 'live-bank',
  householdId: HOUSEHOLD,
  kind: 'bank' as const,
  initialBalanceCents: 0,
});

const inertStatement = () => ({
  id: STMT,
  householdId: HOUSEHOLD,
  accountId: CARD,
  paidCents: 0,
});

const deletedCard = () => ({ id: CARD, householdId: HOUSEHOLD, kind: 'credit_card' });

const inertEvidence = () => ({
  liveTransactionsLinked: 0,
  livePurchasesLinked: 0,
  liveAccountTransactions: 0,
  liveAccountPurchases: 0,
});

describe('f2-inert-deleted-card RED: skip inert statements on soft-deleted cards', () => {
  it('skips a paid=0 statement on a same-household soft-deleted credit_card with no live linkage', () => {
    const { kept, skippedIds } = filterInertDeletedCardStatements(
      [inertStatement()],
      new Map([[liveCard().id, liveCard()]]),
      new Map([[CARD, deletedCard()]]),
      new Map([[STMT, inertEvidence()]]),
    );
    expect(kept).toHaveLength(0);
    expect(skippedIds).toEqual([STMT]);
    // The filtered ledger computes cleanly (no unknown-account refusal).
    const out = computeCanonicalBalances([liveCard()], [], kept);
    expect(out).toHaveLength(1);
  });

  it('fail-closed when the deleted account is missing (true unknown)', () => {
    expect(() =>
      filterInertDeletedCardStatements(
        [inertStatement()],
        new Map([[liveCard().id, liveCard()]]),
        new Map(),
        new Map([[STMT, inertEvidence()]]),
      ),
    ).toThrow(BalanceError);
  });

  it('fail-closed when paid_cents is nonzero', () => {
    expect(() =>
      filterInertDeletedCardStatements(
        [{ ...inertStatement(), paidCents: 100 }],
        new Map([[liveCard().id, liveCard()]]),
        new Map([[CARD, deletedCard()]]),
        new Map([[STMT, inertEvidence()]]),
      ),
    ).toThrow(BalanceError);
  });

  it('fail-closed on any live linkage or live movement touching the deleted account', () => {
    const cases = [
      { ...inertEvidence(), liveTransactionsLinked: 1 },
      { ...inertEvidence(), livePurchasesLinked: 1 },
      { ...inertEvidence(), liveAccountTransactions: 1 },
      { ...inertEvidence(), liveAccountPurchases: 1 },
    ];
    for (const evidence of cases) {
      expect(() =>
        filterInertDeletedCardStatements(
          [inertStatement()],
          new Map([[liveCard().id, liveCard()]]),
          new Map([[CARD, deletedCard()]]),
          new Map([[STMT, evidence]]),
        ),
      ).toThrow(BalanceError);
    }
  });

  it('fail-closed when the soft-deleted account is not a same-household credit_card', () => {
    expect(() =>
      filterInertDeletedCardStatements(
        [inertStatement()],
        new Map([[liveCard().id, liveCard()]]),
        new Map([[CARD, { id: CARD, householdId: HOUSEHOLD, kind: 'bank' }]]),
        new Map([[STMT, inertEvidence()]]),
      ),
    ).toThrow(BalanceError);
    expect(() =>
      filterInertDeletedCardStatements(
        [inertStatement()],
        new Map([[liveCard().id, liveCard()]]),
        new Map([[CARD, { id: CARD, householdId: 'other-household', kind: 'credit_card' }]]),
        new Map([[STMT, inertEvidence()]]),
      ),
    ).toThrow(BalanceError);
  });
});
