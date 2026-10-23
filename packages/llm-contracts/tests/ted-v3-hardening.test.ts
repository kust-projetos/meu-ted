import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BROWSER_FACING_SCHEMAS,
  FORBIDDEN_BROWSER_KEYS,
  MUTATION_EFFECTS_REGISTRY,
  assertAllMutationKindsRegistered,
  mutationDraftChannelSchema,
  mutationEffectsEntrySchema,
  mutationReceiptSchema,
  pendingOperationPresentationSchema,
  resolveMutationEffects,
  type ForbiddenBrowserKey,
  type MutationDraftChannelMessage,
  type MutationReceipt,
  type PendingOperationPresentation,
} from '../src/index.js';

const validPresentation = {
  id: 'op_01JABC',
  status: 'proposed',
  tool: 'transactions.expense.create',
  title: 'Confirmar despesa',
  amountCents: 85000,
  description: 'Mercado',
  date: '2026-09-14',
  account: { id: 'acc_nubank', label: 'Nubank' },
  category: { id: 'cat_food', label: 'Alimentação' },
  expiresAt: '2026-09-14T13:00:00.000Z',
  warnings: [] as string[],
};

const validTedReceipt = {
  mutationId: 'mut_001',
  mutationKind: 'transactions.expense.create',
  status: 'succeeded',
  affectedTargets: ['transactions', 'accounts'],
  operationId: 'op_01JABC',
} as const;
const validOutcome = {
  operationId: '00000000-0000-4000-8000-000000000001',
  tool: 'transactions.expense.create',
  status: 'succeeded',
  expectedContext: { tool: 'transactions.expense.create' },
  receipt: {
    ...validTedReceipt,
    operationId: '00000000-0000-4000-8000-000000000001',
    entity: { type: 'transaction', id: '00000000-0000-4000-8000-000000000002' },
  },
} as const;

describe('PendingOperationPresentation (SPEC §16)', () => {
  it('accepts a complete card projection', () => {
    const parsed = pendingOperationPresentationSchema.safeParse(validPresentation);
    expect(parsed.success).toBe(true);
  });

  it('preserves the exact current transaction description in the browser-safe projection',()=>{
    const parsed=pendingOperationPresentationSchema.parse({...validPresentation,tool:'transactions.update',expectedDescription:'  Mercado  ',transactionTargetId:'tx-1',transactionAmountCents:100,transactionDate:'2026-10-22',transactionAccount:{id:'acc-1',label:'Conta'}});
    expect(parsed.expectedDescription).toBe('  Mercado  ');
  });

  it('accepts a minimal card (optional financial detail omitted)', () => {
    const { amountCents, description, date, account, category, ...minimal } = validPresentation;
    expect(amountCents).toBe(85000);
    expect(description).toBe('Mercado');
    expect(date).toBe('2026-09-14');
    expect(account).toBeDefined();
    expect(category).toBeDefined();
    expect(pendingOperationPresentationSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects a card without warnings (user must see explicit risk list, even empty)', () => {
    const { warnings, ...withoutWarnings } = validPresentation;
    expect(warnings).toEqual([]);
    expect(pendingOperationPresentationSchema.safeParse(withoutWarnings).success).toBe(false);
  });

  it('rejects negative amounts and malformed dates', () => {
    expect(
      pendingOperationPresentationSchema.safeParse({ ...validPresentation, amountCents: -1 }).success,
    ).toBe(false);
    expect(
      pendingOperationPresentationSchema.safeParse({ ...validPresentation, date: '14/09/2026' })
        .success,
    ).toBe(false);
  });

  it('exposes the presentation type without attestation material', () => {
    expectTypeOf<Extract<ForbiddenBrowserKey, keyof PendingOperationPresentation>>().toEqualTypeOf<never>();
    const presentation: PendingOperationPresentation = { ...validPresentation };
    expect(presentation.warnings).toEqual([]);
  });
});

describe('MutationReceipt (SPEC §15.1)', () => {
  it('accepts a TED receipt carrying its origin operationId', () => {
    expect(mutationReceiptSchema.safeParse({ ...validTedReceipt }).success).toBe(true);
  });

  it('rejects a TED approval-tool receipt WITHOUT operationId', () => {
    const { operationId, ...withoutOrigin } = validTedReceipt;
    expect(operationId).toBe('op_01JABC');
    for (const tedKind of ['transactions.expense.create', 'transactions.income.create'] as const) {
      expect(
        mutationReceiptSchema.safeParse({ ...withoutOrigin, mutationKind: tedKind }).success,
      ).toBe(false);
    }
  });

  it('accepts a normal-write receipt without operationId (never converted to a PendingOperation)', () => {
    expect(
      mutationReceiptSchema.safeParse({
        mutationId: 'mut_002',
        mutationKind: 'transaction.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
      }).success,
    ).toBe(true);
  });

  it('rejects non-succeeded statuses and unknown mutation kinds', () => {
    expect(
      mutationReceiptSchema.safeParse({ ...validTedReceipt, status: 'failed' }).success,
    ).toBe(false);
    expect(
      mutationReceiptSchema.safeParse({ ...validTedReceipt, mutationKind: 'nope.unknown' }).success,
    ).toBe(false);
  });

  it('exposes the receipt type without attestation material', () => {
    expectTypeOf<Extract<ForbiddenBrowserKey, keyof MutationReceipt>>().toEqualTypeOf<never>();
    const receipt: MutationReceipt = { ...validTedReceipt, affectedTargets: [...validTedReceipt.affectedTargets] };
    expect(receipt.status).toBe('succeeded');
  });
});

describe('Mutation Effects Registry (SPEC §15.1.1)', () => {
  it('resolves the SPEC example: transaction.create refresh set', () => {
    expect(resolveMutationEffects('transaction.create')).toEqual({
      mutationKind: 'transaction.create',
      affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
    });
  });

  it('resolves the SPEC example: payable.update refresh set', () => {
    expect(resolveMutationEffects('payable.update')?.affectedTargets).toEqual([
      'payables',
      'dashboard-summary',
      'quick-insights',
    ]);
  });

  it('resolves TED approval tools through the same deterministic registry', () => {
    for (const tedKind of ['transactions.expense.create', 'transactions.income.create'] as const) {
      const entry = resolveMutationEffects(tedKind);
      expect(entry?.affectedTargets).toContain('transactions');
      expect(entry?.affectedTargets).toContain('dashboard-summary');
    }
  });

  it('throws for a known mutation kind with no registration (absence = error)', () => {
    expect(() => resolveMutationEffects('transaction.archive' as never)).toThrow(
      /no registered mutation effects/i,
    );
  });

  it('fails a registry missing a known kind', () => {
    const { 'transaction.create': _omitted, ...partial } = MUTATION_EFFECTS_REGISTRY;
    expect(_omitted.affectedTargets.length).toBeGreaterThan(0);
    expect(() => assertAllMutationKindsRegistered(partial)).toThrow(/transaction\.create/);
  });

  it('passes a complete registry', () => {
    expect(() => assertAllMutationKindsRegistered(MUTATION_EFFECTS_REGISTRY)).not.toThrow();
  });

  it('accepts an explicit no-refresh exception with zero targets', () => {
    expect(
      mutationEffectsEntrySchema.safeParse({
        mutationKind: 'category.update',
        affectedTargets: [],
        noRefresh: true,
      }).success,
    ).toBe(true);
  });

  it('rejects empty targets WITHOUT the explicit no-refresh marker', () => {
    expect(
      mutationEffectsEntrySchema.safeParse({
        mutationKind: 'category.update',
        affectedTargets: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a no-refresh marker combined with targets', () => {
    expect(
      mutationEffectsEntrySchema.safeParse({
        mutationKind: 'category.update',
        affectedTargets: ['categories'],
        noRefresh: true,
      }).success,
    ).toBe(false);
  });
});

describe('MutationDraft channel surface (SPEC §7.8)', () => {
  const validDraft = {
    draftId: 'draft_01JABC',
    tool: 'transactions.expense.create' as const,
    missingFields: ['accountId'],
    question: 'Em qual conta devo lançar?',
    expiresAt: '2026-09-14T12:10:00.000Z',
  };

  it('accepts a clarification payload with draft identity, tool, missing fields and question', () => {
    expect(mutationDraftChannelSchema.safeParse(validDraft).success).toBe(true);
  });

  it('rejects empty missingFields and empty questions', () => {
    expect(
      mutationDraftChannelSchema.safeParse({ ...validDraft, missingFields: [] }).success,
    ).toBe(false);
    expect(mutationDraftChannelSchema.safeParse({ ...validDraft, question: '  ' }).success).toBe(
      false,
    );
  });

  it('carries no authorization, attestation or executable args — by type and at runtime', () => {
    expectTypeOf<Extract<ForbiddenBrowserKey, keyof MutationDraftChannelMessage>>().toEqualTypeOf<never>();
    const draft: MutationDraftChannelMessage = { ...validDraft };
    expect(draft.draftId).toBe('draft_01JABC');
    for (const forbidden of FORBIDDEN_BROWSER_KEYS) {
      expect(
        mutationDraftChannelSchema.safeParse({ ...validDraft, [forbidden]: 'smuggled' }).success,
        `channel must reject ${forbidden}`,
      ).toBe(false);
    }
  });
});

describe('browser-facing attestation ban (all channel schemas)', () => {
  it('rejects every forbidden key in every browser-facing schema', () => {
    expect(Object.keys(BROWSER_FACING_SCHEMAS).length).toBeGreaterThan(0);
    for (const [name, schema] of Object.entries(BROWSER_FACING_SCHEMAS)) {
      for (const forbidden of FORBIDDEN_BROWSER_KEYS) {
        const base =
          name === 'mutationReceipt'
            ? { ...validTedReceipt }
            : name === 'mutationDraftChannel'
              ? {
                  draftId: 'draft_x',
                  tool: 'transactions.expense.create',
                  missingFields: ['accountId'],
                  question: 'Em qual conta?',
                  expiresAt: '2026-09-14T12:10:00.000Z',
                }
              : name === 'pendingOperationOutcome'
                ? { ...validOutcome }
                : { ...validPresentation };
        expect(schema.safeParse({ ...base, [forbidden]: 'smuggled' }).success, `${name} rejects ${forbidden}`).toBe(
          false,
        );
      }
    }
  });
});

describe('terminal pending-operation outcome DTO', () => {
  it('exports one strict browser-safe schema for only recognized terminal states', () => {
    expect(Object.keys(BROWSER_FACING_SCHEMAS)).toContain('pendingOperationOutcome');
    const schema = (BROWSER_FACING_SCHEMAS as Record<string, { safeParse: (value: unknown) => { success: boolean } }>).pendingOperationOutcome!;
    expect(schema.safeParse(validOutcome).success).toBe(true);
    for (const status of ['proposed', 'confirmed', 'executing'] as const) {
      expect(schema.safeParse({ operationId: validOutcome.operationId, tool: validOutcome.tool, status }).success).toBe(true);
    }
    for (const status of ['succeeded-ish', undefined] as const) {
      const malformed = { ...validOutcome, ...(status === undefined ? {} : { status }) };
      if (status === undefined) delete (malformed as { status?: unknown }).status;
      expect(schema.safeParse(malformed).success).toBe(false);
    }
    expect(schema.safeParse({ ...validOutcome, attestation: 'secret' }).success).toBe(false);
    expect(schema.safeParse({ ...validOutcome, receipt: { ...validOutcome.receipt, operationId: '00000000-0000-4000-8000-000000000003' } }).success).toBe(false);
    expect(schema.safeParse({ operationId: validOutcome.operationId, tool: validOutcome.tool, status: 'failed', failureCode: 'in_use' }).success).toBe(false);
  });
});
