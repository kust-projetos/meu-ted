import { describe, expect, it } from 'vitest';
import { pendingOperationPresentationSchema } from '@pi-finance/llm-contracts';
import { buildPendingOperationPresentation } from '../../src/approvals/presentation.js';

const base = {
  id: 'op-1',
  status: 'proposed',
  tool: 'transactions.expense.create',
  normalizedArgs: {
    description: 'Mercado',
    amountCents: 85000,
    date: '2026-09-14',
    accountId: 'acc-1',
    categoryId: 'cat-1',
  },
  expiresAt: '2026-09-14T13:00:00.000Z',
};

describe('buildPendingOperationPresentation (SPEC §16)', () => {
  it('derives the card from the same canonical args that will execute (INV-02)', () => {
    const presentation = buildPendingOperationPresentation({
      ...base,
      accountLabel: 'Nubank',
      categoryLabel: 'Alimentação',
    });
    expect(presentation).not.toBeNull();
    expect(presentation!.amountCents).toBe(85000);
    expect(presentation!.description).toBe('Mercado');
    expect(presentation!.date).toBe('2026-09-14');
    expect(presentation!.account).toEqual({ id: 'acc-1', label: 'Nubank' });
    expect(presentation!.category).toEqual({ id: 'cat-1', label: 'Alimentação' });
    expect(presentation!.title).toBe('Confirmar despesa');
    expect(presentation!.warnings).toEqual([]);
    expect(pendingOperationPresentationSchema.safeParse(presentation).success).toBe(true);
  });

  it('titles income operations as revenue confirmation', () => {
    const presentation = buildPendingOperationPresentation({ ...base, tool: 'transactions.income.create' });
    expect(presentation!.title).toBe('Confirmar receita');
  });

  it('omits labels when names are unknown (IDs still carried)', () => {
    const presentation = buildPendingOperationPresentation(base);
    expect(presentation!.account).toBeUndefined();
    expect(presentation!.category).toBeUndefined();
    expect(pendingOperationPresentationSchema.safeParse(presentation).success).toBe(true);
  });

  it('returns null when canonical args are incomplete (defense: cannot exist post-T1.4)', () => {
    expect(
      buildPendingOperationPresentation({ ...base, normalizedArgs: { description: 'x' } }),
    ).toBeNull();
    expect(
      buildPendingOperationPresentation({ ...base, normalizedArgs: null }),
    ).toBeNull();
  });

  it('never carries attestation or authority material', () => {
    const presentation = buildPendingOperationPresentation({
      ...base,
      accountLabel: 'Nubank',
      categoryLabel: 'Alimentação',
    }) as unknown as Record<string, unknown>;
    for (const forbidden of ['attestation', 'attestationHash', 'proposalHash', 'normalizedArgs', 'args']) {
      expect(presentation).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(presentation)).not.toContain('attestation');
  });

  it('projects a P3.4 card purchase (card + value + description + date, category optional)', () => {
    const cardArgs = {
      description: 'supermercado',
      amountCents: 15000,
      date: '2026-11-07',
      accountId: 'card-1',
    };
    const presentation = buildPendingOperationPresentation({
      ...base,
      tool: 'cards.purchase.create',
      normalizedArgs: cardArgs,
      accountLabel: 'Nubank Card',
    });
    expect(presentation).not.toBeNull();
    expect(presentation!.title).toBe('Confirmar compra no cartão');
    expect(presentation!.amountCents).toBe(15000);
    expect(presentation!.description).toBe('supermercado');
    expect(presentation!.date).toBe('2026-11-07');
    expect(presentation!.account).toEqual({ id: 'card-1', label: 'Nubank Card' });
    expect(presentation!.category).toBeUndefined();
    expect(pendingOperationPresentationSchema.safeParse(presentation).success).toBe(true);
  });

  it('keeps the optional card category when the read model resolves it', () => {
    const presentation = buildPendingOperationPresentation({
      ...base,
      tool: 'cards.purchase.create',
      normalizedArgs: {
        description: 'supermercado',
        amountCents: 15000,
        date: '2026-11-07',
        accountId: 'card-1',
        categoryId: 'cat-food',
      },
      accountLabel: 'Nubank Card',
      categoryLabel: 'Mercado',
    });
    expect(presentation!.category).toEqual({ id: 'cat-food', label: 'Mercado' });
  });
});
