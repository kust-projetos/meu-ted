import { describe, expect, it } from 'vitest';
import { isActionablePendingOperationPresentation, pendingOperationPresentationSchema } from '@pi-finance/llm-contracts';
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
  it('presents a goal contribution with its resolved name, never its UUID', () => {
    const goalId = '00000000-0000-4000-8000-000000000020';
    const presentation = buildPendingOperationPresentation({
      ...base, tool: 'goals.contribute',
      normalizedArgs: { goalId, amountCents: 25000, contributionDate: '2026-11-10' },
      goalLabel: 'Reserva de emergência',
    });
    expect(presentation).toMatchObject({
      title: 'Aporte na meta — R$ 250,00', description: 'Reserva de emergência', amountCents: 25000, date: '2026-11-10',
      goal: { id: goalId, label: 'Reserva de emergência' },
    });
    expect(presentation!.goal?.id).toBe(goalId);
    expect([presentation!.title, presentation!.description, presentation!.goal?.label].join(' ')).not.toContain(goalId);
    expect(pendingOperationPresentationSchema.safeParse(presentation).success).toBe(true);
    expect(isActionablePendingOperationPresentation(presentation!)).toBe(true);
  });

  it('fails closed when the goal name is unavailable', () => {
    const goalId = '00000000-0000-4000-8000-000000000021';
    const presentation = buildPendingOperationPresentation({
      ...base, tool: 'goals.contribute',
      normalizedArgs: { goalId, amountCents: 25000 },
    });
    expect(presentation).toBeNull();
  });
  it('presents budget creation with category label and fails closed without it', () => {
    const categoryId = '00000000-0000-4000-8000-000000000024';
    const input = { ...base, tool: 'budgets.create', normalizedArgs: { categoryId, name: 'Mercado', amountCents: 50000, period: 'monthly', startDate: '2026-11-01' } };
    const presentation = buildPendingOperationPresentation({ ...input, categoryLabel: 'Alimentação' });
    expect(presentation).toMatchObject({ title: 'Criar orçamento', description: 'Orçamento mensal de Mercado', amountCents: 50000, date: '2026-11-01', category: { id: categoryId, label: 'Alimentação' } });
    expect(`${presentation?.title} ${presentation?.description}`).not.toContain(categoryId);
    expect(pendingOperationPresentationSchema.safeParse(presentation).success).toBe(true);
    expect(isActionablePendingOperationPresentation(presentation!)).toBe(true);
    expect(buildPendingOperationPresentation(input)).toBeNull();
  });
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

  it('projects a P3.5 installment purchase with server-computed parcels and first invoice', () => {
    const presentation = buildPendingOperationPresentation({
      ...base,
      tool: 'cards.purchase.create',
      normalizedArgs: {
        description: 'celular',
        amountCents: 120000,
        date: '2026-11-07',
        accountId: 'card-1',
        installmentsTotal: 6,
      },
      accountLabel: 'Nubank',
      cardCycle: { closingDay: 15, dueDay: 25 },
    });
    expect(presentation).not.toBeNull();
    expect(presentation!.title).toBe('Confirmar compra parcelada');
    expect(presentation!.amountCents).toBe(120000);
    expect(presentation!.installmentsTotal).toBe(6);
    expect(presentation!.installmentAmountsCents).toEqual([20000, 20000, 20000, 20000, 20000, 20000]);
    expect(presentation!.firstStatementClosingDate).toBe('2026-11-15');
    expect(presentation!.firstStatementDueDate).toBe('2026-11-25');
    expect(pendingOperationPresentationSchema.safeParse(presentation).success).toBe(true);
    expect(isActionablePendingOperationPresentation(presentation!)).toBe(true);
  });

  it('uses the exact cent split in the preview (R$ 10,00 in 3x)', () => {
    const presentation = buildPendingOperationPresentation({
      ...base,
      tool: 'cards.purchase.create',
      normalizedArgs: {
        description: 'cafe',
        amountCents: 1000,
        date: '2026-11-07',
        accountId: 'card-1',
        installmentsTotal: 3,
      },
      accountLabel: 'Nubank',
      cardCycle: { closingDay: 15, dueDay: 25 },
    });
    expect(presentation!.installmentAmountsCents).toEqual([333, 333, 334]);
  });

  it('treats installmentsTotal 1 as the unchanged 1x presentation', () => {
    const presentation = buildPendingOperationPresentation({
      ...base,
      tool: 'cards.purchase.create',
      normalizedArgs: {
        description: 'supermercado',
        amountCents: 15000,
        date: '2026-11-07',
        accountId: 'card-1',
        installmentsTotal: 1,
      },
      accountLabel: 'Nubank Card',
    });
    expect(presentation!.title).toBe('Confirmar compra no cartão');
    expect(presentation!.installmentsTotal).toBeUndefined();
    expect(presentation!.installmentAmountsCents).toBeUndefined();
  });

  it('fails closed on a malformed declared split instead of degrading to 1x', () => {
    for (const installmentsTotal of [0, 49, 1.5]) {
      const presentation = buildPendingOperationPresentation({
        ...base,
        tool: 'cards.purchase.create',
        normalizedArgs: {
          description: 'celular',
          amountCents: 120000,
          date: '2026-11-07',
          accountId: 'card-1',
          installmentsTotal,
        },
        accountLabel: 'Nubank',
      });
      expect(presentation).toBeNull();
    }
  });

  it('fails closed when the total cannot cover 1 cent per parcel', () => {
    const presentation = buildPendingOperationPresentation({
      ...base,
      tool: 'cards.purchase.create',
      normalizedArgs: {
        description: 'doce',
        amountCents: 2,
        date: '2026-11-07',
        accountId: 'card-1',
        installmentsTotal: 3,
      },
      accountLabel: 'Nubank',
    });
    expect(presentation).toBeNull();
  });

  it('rejects a preview whose parcel amounts do not sum to the total', () => {
    const presentation = {
      id: 'op-1',
      status: 'proposed',
      tool: 'cards.purchase.create',
      title: 'Confirmar compra parcelada',
      amountCents: 120000,
      installmentsTotal: 6,
      installmentAmountsCents: [20000, 20000, 20000, 20000, 20000, 19999],
      description: 'celular',
      date: '2026-11-07',
      account: { id: 'card-1', label: 'Nubank' },
      expiresAt: '2026-11-07T12:00:00.000Z',
      warnings: [],
    } as const;
    expect(isActionablePendingOperationPresentation(presentation)).toBe(false);
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

  it('projects a P3.6 statement payment with card, invoice, authoritative amounts and payer', () => {
    const statementContext = {
      id: 'stmt-1',
      accountId: 'card-1',
      cycleYearMonth: '2026-11',
      totalCents: 120000,
      paidCents: 35000,
      remainingCents: 85000,
      dueDate: '2026-11-25',
      status: 'partial',
    };
    const presentation = buildPendingOperationPresentation({
      ...base,
      tool: 'cards.statement.pay',
      normalizedArgs: { statementId: 'stmt-1', fromAccountId: 'acc-itau', amountCents: 85000 },
      accountLabel: 'Nubank',
      fromAccountLabel: 'Itaú',
      statementContext,
    });
    expect(presentation).not.toBeNull();
    expect(presentation!.title).toBe('Pagamento de fatura — R$ 850,00');
    expect(presentation!.amountCents).toBe(85000);
    expect(presentation!.account).toEqual({ id: 'card-1', label: 'Nubank' });
    expect(presentation!.fromAccount).toEqual({ id: 'acc-itau', label: 'Itaú' });
    expect(presentation!.statement).toEqual({ id: 'stmt-1', label: 'Novembro/2026' });
    expect(presentation!.statementTotalCents).toBe(120000);
    expect(presentation!.statementPaidCents).toBe(35000);
    expect(presentation!.statementRemainingCents).toBe(85000);
    expect(presentation!.statementDueDate).toBe('2026-11-25');
    expect(presentation!.statementStatus).toBe('partial');
    expect(pendingOperationPresentationSchema.safeParse(presentation).success).toBe(true);
    expect(isActionablePendingOperationPresentation(presentation!)).toBe(true);
  });

  it('fails a statement payment closed when the context is missing, stale or overpaid', () => {
    const statementContext = {
      id: 'stmt-1',
      accountId: 'card-1',
      cycleYearMonth: '2026-11',
      totalCents: 120000,
      paidCents: 35000,
      remainingCents: 85000,
      dueDate: '2026-11-25',
      status: 'partial',
    };
    const input = {
      ...base,
      tool: 'cards.statement.pay',
      normalizedArgs: { statementId: 'stmt-1', fromAccountId: 'acc-itau', amountCents: 85000 },
      accountLabel: 'Nubank',
      fromAccountLabel: 'Itaú',
    } as const;
    expect(buildPendingOperationPresentation(input)).toBeNull();
    expect(buildPendingOperationPresentation({ ...input, statementContext: { ...statementContext, id: 'other' } })).toBeNull();
    expect(buildPendingOperationPresentation({ ...input, statementContext: { ...statementContext, remainingCents: 0, paidCents: 120000 } })).toBeNull();
    expect(buildPendingOperationPresentation({ ...input, statementContext, normalizedArgs: { ...input.normalizedArgs, amountCents: 90000 } })).toBeNull();
    expect(buildPendingOperationPresentation({ ...input, statementContext, fromAccountLabel: '' })).toBeNull();
  });
});
