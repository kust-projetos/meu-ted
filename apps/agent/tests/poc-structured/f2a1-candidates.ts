/**
 * Hand-authored candidate outputs, independent of the oracle definitions.
 *
 * These are FIXTURES, not model output: they prove the harness/parser and the
 * declared semantics, never model quality.
 */
const provenance = (corpusId: string, turnIndex?: number) =>
  ({ origin: turnIndex === undefined ? 'f1-corpus-text' : 'f1-journey-turn', corpusId, ...(turnIndex === undefined ? {} : { turnIndex }) });

const base = (corpusId: string, turnIndex?: number) => ({
  intent: 'clarify',
  operation: 'none',
  args: {},
  contextProvenance: provenance(corpusId, turnIndex),
  entities: [] as readonly unknown[],
  ambiguities: [] as readonly string[],
  missingFields: [] as readonly string[],
  clarification: null as string | null,
});

const single = (corpusId: string, values: Record<string, unknown>) => ({
  interpretation: { ...base(corpusId), ...values },
});

const turn = (corpusId: string, turnIndex: number, values: Record<string, unknown>) => ({
  interpretation: { ...base(corpusId, turnIndex), ...values },
});

const MAIN_ACCOUNT_ID = '10000000-0000-4000-8000-000000000003';
const MERCADO_CATEGORY_ID = '20000000-0000-4000-8000-000000000003';
const AURORA_FIRST_ID = '10000000-0000-4000-8000-000000000001';

export const F2A1_LOCAL_CANDIDATES: Readonly<Record<string, unknown>> = Object.freeze({
  'F1-B005': single('F1-B005', { intent: 'read', operation: 'list_payables' }),
  'F1-B010': single('F1-B010', { intent: 'read', operation: 'list_statements' }),
  'F1-B012': single('F1-B012', {
    intent: 'unsupported',
    operation: 'none',
    args: {},
    entities: [{ kind: 'amount', value: '50000', provenance: 'utterance' }],
    ambiguities: [],
    missingFields: [],
    requestedAction: 'budgets.create',
    // Honest limitation message, NOT a missing-field question.
    clarification: 'Ainda não é possível criar orçamento por aqui.',
  }),
  'F1-B017': single('F1-B017', {
    entities: [{ kind: 'period', value: '2020', provenance: 'utterance' }],
    missingFields: ['period'],
    ambiguities: [],
    clarification: 'Qual mês ou período de 2020?',
  }),
  'F1-B036': single('F1-B036', {
    intent: 'read',
    operation: 'get_month_summary',
    args: { yearMonth: '2026-10' },
    entities: [{ kind: 'period', value: '2026-10', provenance: 'utterance' }],
  }),
  'F1-B058': single('F1-B058', {
    entities: [
      { kind: 'amount', value: '2000', provenance: 'utterance' },
      { kind: 'date', value: '2020', provenance: 'utterance' },
    ],
    missingFields: ['date'],
    ambiguities: [],
    clarification: 'Informe a data exata (dia e mês) de 2020.',
  }),
  'F2A1-B013-catalog': single('F2A1-B013-catalog', {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: {
      amountCents: 2500,
      description: 'mercado',
      accountId: MAIN_ACCOUNT_ID,
      categoryId: MERCADO_CATEGORY_ID,
      date: '2026-10-24',
    },
    entities: [
      { kind: 'amount', value: '2500', provenance: 'utterance' },
      { kind: 'description', value: 'mercado', provenance: 'utterance' },
    ],
  }),
  'F2A1-B015-colloquial': single('F2A1-B015-colloquial', {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: { amountCents: 5000, description: 'carne' },
    entities: [
      { kind: 'amount', value: 'cinquenta reais', provenance: 'utterance' },
      { kind: 'description', value: 'carne', provenance: 'utterance' },
    ],
  }),
  'F2A1-B027-approx': single('F2A1-B027-approx', {
    entities: [{ kind: 'amount', value: 'uns 50', provenance: 'utterance' }],
    ambiguities: ['amount'],
    missingFields: ['amount'],
    clarification: 'Qual o valor exato?',
  }),
  'F2A1-B006-reference': single('F2A1-B006-reference', {
    missingFields: ['entity'],
    ambiguities: [],
    clarification: 'Qual lançamento?',
  }),
  'F2A1-B016-homonyms': single('F2A1-B016-homonyms', {
    entities: [{ kind: 'account', value: 'Aurora', provenance: 'utterance' }],
    ambiguities: ['account'],
    missingFields: [],
    clarification: 'Qual conta Aurora?',
  }),
  'F2A1-B021-correction': single('F2A1-B021-correction', {
    entities: [{ kind: 'amount', value: '75', provenance: 'utterance' }],
    missingFields: ['entity'],
    ambiguities: [],
    clarification: 'Qual lançamento devo corrigir para esse valor?',
  }),
  'F2A1-B008-concept': single('F2A1-B008-concept', {
    intent: 'conversation',
    operation: 'none',
    args: {},
    ambiguities: [],
    missingFields: [],
    clarification: null,
  }),
});

export const F2A1_LOCAL_JOURNEYS: Readonly<Record<string, readonly unknown[]>> = Object.freeze({
  J01: [
    turn('J01', 0, {
      entities: [{ kind: 'description', value: 'carne', provenance: 'utterance' }],
      missingFields: ['amount'],
      ambiguities: [],
      clarification: 'Qual valor devo registrar?',
    }),
    turn('J01', 1, {
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: {
        amountCents: 250000,
        description: 'carne',
        accountId: MAIN_ACCOUNT_ID,
        categoryId: MERCADO_CATEGORY_ID,
        date: '2026-10-24',
      },
      ambiguities: [],
      missingFields: [],
      clarification: null,
    }),
  ],
  J02: [
    turn('J02', 0, {
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: {
        amountCents: 5000,
        description: 'carne',
        accountId: MAIN_ACCOUNT_ID,
        categoryId: MERCADO_CATEGORY_ID,
        date: '2026-10-24',
      },
      entities: [
        { kind: 'amount', value: '5000', provenance: 'utterance' },
        { kind: 'description', value: 'carne', provenance: 'utterance' },
      ],
      ambiguities: [],
      missingFields: [],
      clarification: null,
    }),
    turn('J02', 1, {
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: {
        amountCents: 5000,
        description: 'carne',
        accountId: MAIN_ACCOUNT_ID,
        categoryId: MERCADO_CATEGORY_ID,
        date: '2026-10-24',
      },
      entities: [{ kind: 'category', value: 'mercado', provenance: 'utterance' }],
      ambiguities: [],
      missingFields: [],
      clarification: null,
    }),
  ],
  J03: [
    turn('J03', 0, {
      missingFields: ['initialBalance', 'accountKind'],
      ambiguities: [],
      clarification: 'Qual o tipo da conta e o saldo inicial?',
    }),
    turn('J03', 1, {
      intent: 'mutation-proposal',
      operation: 'accounts.create',
      args: { accountName: 'Reserva', accountKind: 'bank', initialBalanceCents: 10000 },
      ambiguities: [],
      missingFields: [],
      clarification: null,
    }),
  ],
  J05: [
    turn('J05', 0, {
      entities: [{ kind: 'account', value: 'Aurora', provenance: 'utterance' }],
      ambiguities: ['account'],
      missingFields: [],
      clarification: 'Qual conta Aurora devo renomear?',
    }),
    turn('J05', 1, {
      intent: 'mutation-proposal',
      operation: 'accounts.update',
      args: {
        accountId: AURORA_FIRST_ID,
        expectedName: 'Aurora',
        accountName: 'Reserva',
      },
      entities: [{ kind: 'account', value: 'Aurora', provenance: 'displayed-option' }],
      ambiguities: [],
      missingFields: [],
      clarification: null,
    }),
  ],
  J09: [
    turn('J09', 0, {
      intent: 'read',
      operation: 'get_month_summary',
      args: { yearMonth: '2026-10' },
      entities: [{ kind: 'period', value: '2026-10', provenance: 'utterance' }],
    }),
    turn('J09', 1, {
      intent: 'read',
      operation: 'get_month_summary',
      args: { yearMonth: '2026-09' },
      entities: [{ kind: 'period', value: '2026-09', provenance: 'utterance' }],
    }),
  ],
});
