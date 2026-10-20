import { describe, expect, it } from 'vitest';
import { resolveConfirmation } from '../../src/mutations/confirmation-resolver.js';
import { buildApprovalPresentation } from '../../src/mutations/approval-presentation.js';
import { toActiveOperationRecords } from '../../src/mutations/active-operation-projection.js';

/**
 * Role contract (confirmation trio — clarification only, no re-architecture):
 *
 * - `resolveConfirmation` (guard) DECIDES text → decision from the typed text
 *   and the pending list only. It never reads financial args and never emits
 *   amounts, accounts, dates or categories.
 * - `buildApprovalPresentation` (constructor) BUILDS the approval card from
 *   the canonical normalized args plus resolved labels. Incomplete args yield
 *   `null` — it never invents a value and never leaks authority material.
 * - `toActiveOperationRecords` (projection) FILTERS the relayed listing to
 *   the lean display allowlist. It never creates, renames or reclassifies:
 *   what the guard decided on is what the PWA sees.
 *
 * None of the three creates a new financial rule, and none contradicts the
 * other two: the guard's confirmed id survives the projection unchanged, and
 * the constructor's card carries exactly the args it was given.
 */
describe('confirmation roles contract (guard decides / constructor builds / projection filters)', () => {
  it('guard decides confirm/cancel/clarify from text + pending list, emitting no financial content', () => {
    expect(resolveConfirmation('sim', ['op-1'])).toEqual({ kind: 'confirm', operationId: 'op-1' });
    expect(resolveConfirmation('cancela', ['op-1'])).toMatchObject({ kind: 'cancel' });
    expect(resolveConfirmation('talvez depois', ['op-1'])).toMatchObject({ kind: 'clarify', reason: 'not_explicit_confirmation' });
    expect(resolveConfirmation('sim', [])).toMatchObject({ kind: 'clarify', reason: 'no_pending_operation' });
    expect(resolveConfirmation('sim', ['op-1', 'op-2'])).toMatchObject({ kind: 'clarify', reason: 'multiple_pending_operations' });
  });

  it('guard decisions carry only decision keys — never amounts, accounts or dates', () => {
    const decisions = [
      resolveConfirmation('sim', ['op-1']),
      resolveConfirmation('cancela', ['op-1']),
      resolveConfirmation('talvez', ['op-1']),
    ];
    for (const decision of decisions) {
      for (const key of Object.keys(decision)) {
        expect(['kind', 'operationId', 'reason']).toContain(key);
      }
      expect(JSON.stringify(decision)).not.toMatch(/amountCents|accountId|categoryId/);
    }
  });

  it('constructor builds the card from the canonical args plus labels, inventing nothing', () => {
    const args = {
      amountCents: 85000,
      description: 'Mercado',
      date: '2026-09-14',
      accountId: '00000000-0000-4000-8000-0000000000a1',
      categoryId: '00000000-0000-4000-8000-000000000001',
    };
    const card = buildApprovalPresentation({
      operationId: 'op-1',
      status: 'proposed',
      tool: 'transactions.expense.create',
      normalizedArgs: args,
      expiresAt: '2026-09-14T13:00:00.000Z',
      accountLabel: 'Nubank',
      categoryLabel: 'Alimentação',
    });
    expect(card).not.toBeNull();
    expect(card).toMatchObject({
      id: 'op-1',
      amountCents: 85000,
      description: 'Mercado',
      date: '2026-09-14',
      account: { id: args.accountId, label: 'Nubank' },
      category: { id: args.categoryId, label: 'Alimentação' },
    });
    expect(JSON.stringify(card)).not.toMatch(/attestation|normalizedArgs/);
  });

  it('constructor returns null for incomplete args instead of presenting a partial card', () => {
    expect(
      buildApprovalPresentation({
        operationId: 'op-x',
        status: 'proposed',
        tool: 'transactions.expense.create',
        normalizedArgs: { description: 'Mercado' },
        expiresAt: '2026-09-14T13:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('projection relays only the lean allowlist, stripping authority material without reclassifying', () => {
    const out = toActiveOperationRecords([
      {
        id: 'op-1',
        status: 'proposed',
        tool: 'transactions.expense.create',
        createdAt: '2026-09-14T10:00:00.000Z',
        expiresAt: '2026-09-14T13:00:00.000Z',
        amountCents: 85000,
        description: 'Mercado',
        attestation: 'a'.repeat(64),
        normalizedArgs: { amountCents: 1 },
        extraField: 'smuggled',
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: 'op-1',
      status: 'proposed',
      tool: 'transactions.expense.create',
      createdAt: '2026-09-14T10:00:00.000Z',
      expiresAt: '2026-09-14T13:00:00.000Z',
      amountCents: 85000,
      description: 'Mercado',
    });
  });

  it('projection never invents an amount and drops items missing required keys', () => {
    const out = toActiveOperationRecords([
      {
        id: 'op-1',
        status: 'proposed',
        tool: 'transactions.expense.create',
        createdAt: '2026-09-14T10:00:00.000Z',
        expiresAt: '2026-09-14T13:00:00.000Z',
      },
      { id: 'op-broken', status: 'proposed' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('amountCents');
    expect(out[0]!.id).toBe('op-1');
  });

  it('guard decision, constructor card and projection agree: no rewrites across the chain', () => {
    // The operation the guard confirms is the one the projection relays.
    const decision = resolveConfirmation('sim', ['op-1']);
    expect(decision).toEqual({ kind: 'confirm', operationId: 'op-1' });
    const relayed = toActiveOperationRecords([
      {
        id: decision.operationId,
        status: 'proposed',
        tool: 'transactions.expense.create',
        createdAt: '2026-09-14T10:00:00.000Z',
        expiresAt: '2026-09-14T13:00:00.000Z',
      },
    ]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.id).toBe('op-1');
    expect(relayed[0]!.status).toBe('proposed');

    // The constructor card preserves the canonical amount; a projection that
    // carries a presentation preserves that same amount (fidelity, no rule).
    const card = buildApprovalPresentation({
      operationId: 'op-1',
      status: 'proposed',
      tool: 'transactions.expense.create',
      normalizedArgs: {
        amountCents: 85000,
        description: 'Mercado',
        date: '2026-09-14',
        accountId: '00000000-0000-4000-8000-0000000000a1',
        categoryId: '00000000-0000-4000-8000-000000000001',
      },
      expiresAt: '2026-09-14T13:00:00.000Z',
    });
    expect(card!.amountCents).toBe(85000);
    const withPresentation = toActiveOperationRecords([
      {
        id: 'op-1',
        status: 'proposed',
        tool: 'transactions.expense.create',
        createdAt: '2026-09-14T10:00:00.000Z',
        expiresAt: '2026-09-14T13:00:00.000Z',
        presentation: card,
      },
    ]);
    expect(withPresentation[0]!.presentation).toMatchObject({ amountCents: 85000 });
  });
});
