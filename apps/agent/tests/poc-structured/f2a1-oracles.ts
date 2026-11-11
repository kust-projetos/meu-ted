import type { F2AOracle } from '../../src/poc-structured/ab-compare.js';

/**
 * Independently authored expectations; never assembled from candidate output.
 *
 * `missingFields` and `ambiguities` are deliberately separate:
 *  - missingFields = a required slot the supplied context cannot answer;
 *  - ambiguities  = two or more context-valid alternatives still unresolved.
 * A known year with an unknown month is MISSING `period`, not an ambiguity.
 */
export const F2A1_SCENARIOS: Readonly<Record<string, F2AOracle>> = Object.freeze({
  'F1-B005': {
    allowedModes: ['read'], allowedOperations: ['list_payables'], expectedArgs: {},
    clarificationRequired: false, clarificationNeedles: null,
    expectedMissingFields: [], expectedAmbiguities: [], expectedEntities: [],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B005' },
  },
  'F1-B010': {
    allowedModes: ['read'], allowedOperations: ['list_statements'], expectedArgs: {},
    clarificationRequired: false, clarificationNeedles: null,
    expectedMissingFields: [], expectedAmbiguities: [], expectedEntities: [],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B010' },
  },
  'F1-B012': {
    allowedModes: ['unsupported'], allowedOperations: [], expectedArgs: {},
    clarificationRequired: true, clarificationNeedles: ['orçamento', 'não'],
    expectedMissingFields: [], expectedAmbiguities: [], expectedEntities: [{ kind: 'amount', value: '50000', provenance: 'utterance' }],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B012' },
    // Understood create request; the capability is named, never executed.
    // A known unavailable capability is a limitation, not an ambiguity.
    expectedRequestedAction: 'budgets.create',
  },
  'F1-B017': {
    allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
    clarificationRequired: true, clarificationNeedles: ['mês', 'período'],
    // Year is known; only the specific month/period is missing.
    expectedMissingFields: ['period'], expectedAmbiguities: [],
    expectedEntities: [{ kind: 'period', value: '2020', provenance: 'utterance' }],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B017' },
  },
  'F1-B036': {
    allowedModes: ['read'], allowedOperations: ['get_month_summary'],
    expectedArgs: { yearMonth: '2026-10' },
    clarificationRequired: false, clarificationNeedles: null,
    expectedMissingFields: [], expectedAmbiguities: [],
    expectedEntities: [{ kind: 'period', value: '2026-10', provenance: 'utterance' }],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B036' },
  },
  'F1-B058': {
    allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
    clarificationRequired: true, clarificationNeedles: ['data'],
    // R$ 20 is the amount and 2020 is the year: only the exact date is missing.
    expectedMissingFields: ['date'], expectedAmbiguities: [],
    expectedEntities: [
      { kind: 'amount', value: '2000', provenance: 'utterance' },
      { kind: 'date', value: '2020', provenance: 'utterance' },
    ],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B058' },
  },
  'F2A1-B013-catalog': {
    allowedModes: ['mutation-proposal'], allowedOperations: ['transactions.expense.create'],
    expectedArgs: {
      amountCents: 2500, description: 'mercado',
      accountId: '10000000-0000-4000-8000-000000000003',
      categoryId: '20000000-0000-4000-8000-000000000003',
      date: '2026-10-24',
    },
    clarificationRequired: false, clarificationNeedles: null,
    expectedMissingFields: [], expectedAmbiguities: [],
    expectedEntities: [
      { kind: 'amount', value: '2500', provenance: 'utterance' },
      { kind: 'description', value: 'mercado', provenance: 'utterance' },
    ],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B013-catalog' },
  },
  'F2A1-B015-colloquial': {
    allowedModes: ['mutation-proposal'], allowedOperations: ['transactions.expense.create'],
    expectedArgs: { amountCents: 5000, description: 'carne' },
    clarificationRequired: false, clarificationNeedles: null,
    expectedMissingFields: [], expectedAmbiguities: [],
    expectedEntities: [
      { kind: 'amount', value: 'cinquenta reais', provenance: 'utterance' },
      { kind: 'description', value: 'carne', provenance: 'utterance' },
    ],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B015-colloquial' },
  },
  'F2A1-B027-approx': {
    allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
    clarificationRequired: true, clarificationNeedles: ['valor exato'],
    expectedMissingFields: ['amount'], expectedAmbiguities: ['amount'],
    expectedEntities: [{ kind: 'amount', value: 'uns 50', provenance: 'utterance' }],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B027-approx' },
  },
  'F2A1-B006-reference': {
    allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
    clarificationRequired: true, clarificationNeedles: ['lançamento'],
    // No transaction target is available in the supplied context.
    expectedMissingFields: ['entity'], expectedAmbiguities: [], expectedEntities: [],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B006-reference' },
  },
  'F2A1-B016-homonyms': {
    allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
    clarificationRequired: true, clarificationNeedles: ['Aurora'],
    expectedMissingFields: [], expectedAmbiguities: ['account'],
    expectedEntities: [{ kind: 'account', value: 'Aurora', provenance: 'utterance' }],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B016-homonyms' },
  },
  'F2A1-B021-correction': {
    allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
    clarificationRequired: true, clarificationNeedles: ['valor'],
    expectedMissingFields: ['entity'], expectedAmbiguities: [],
    expectedEntities: [{ kind: 'amount', value: '75', provenance: 'utterance' }],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B021-correction' },
  },
  'F2A1-B008-concept': {
    allowedModes: ['conversation'], allowedOperations: [], expectedArgs: {},
    clarificationRequired: false, clarificationNeedles: null,
    expectedMissingFields: [], expectedAmbiguities: [], expectedEntities: [],
    expectedContextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B008-concept' },
  },
});

export type F2A1TurnOracle = Readonly<{
  allowedModes: readonly string[];
  allowedOperations: readonly string[];
  expectedArgs: Readonly<Record<string, unknown>>;
  clarificationRequired: boolean;
  clarificationNeedles: readonly string[] | null;
  expectedMissingFields: readonly string[];
  expectedAmbiguities: readonly string[];
  expectedEntities: readonly Readonly<{ kind: string; value: string; provenance: string }>[];
  expectedContextProvenance: Readonly<{ origin: string; corpusId: string; turnIndex: number }>;
}>;

/**
 * The five evaluated journeys. Financial completion is still unobservable;
 * the other five frozen journeys are retained separately as INCONCLUSIVE and
 * never enter the evaluated aggregate.
 *
 * J02 is an explicit semantic extension: the frozen F1 stage list is
 * `clarify -> propose`, but when the synthetic catalog already makes the only
 * category obvious, asking again would be redundant. The extension therefore
 * proposes directly with the catalog category bound.
 *
 * J05 turn 2 resolves "a primeira conta Aurora" against the ordered options
 * displayed by the frozen F1 clarification text. The first option carries
 * account id `...0001`; the operation is `accounts.update` with the POC
 * argument schema (`accountId`, `expectedName`, `accountName`).
 */
export const F2A1_JOURNEYS: Readonly<Record<string, readonly F2A1TurnOracle[]>> = Object.freeze({
  J01: [
    {
      allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
      clarificationRequired: true, clarificationNeedles: ['valor'],
      expectedMissingFields: ['amount'], expectedAmbiguities: [],
      expectedEntities: [{ kind: 'description', value: 'carne', provenance: 'utterance' }],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J01', turnIndex: 0 },
    },
    {
      allowedModes: ['mutation-proposal'], allowedOperations: ['transactions.expense.create'],
      expectedArgs: {
        amountCents: 250000, description: 'carne',
        accountId: '10000000-0000-4000-8000-000000000003',
        categoryId: '20000000-0000-4000-8000-000000000003',
        date: '2026-10-24',
      },
      clarificationRequired: false, clarificationNeedles: null,
      expectedMissingFields: [], expectedAmbiguities: [], expectedEntities: [],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J01', turnIndex: 1 },
    },
  ],
  J02: [
    {
      allowedModes: ['mutation-proposal'], allowedOperations: ['transactions.expense.create'],
      expectedArgs: {
        amountCents: 5000, description: 'carne',
        accountId: '10000000-0000-4000-8000-000000000003',
        categoryId: '20000000-0000-4000-8000-000000000003',
        date: '2026-10-24',
      },
      clarificationRequired: false, clarificationNeedles: null,
      expectedMissingFields: [], expectedAmbiguities: [],
      expectedEntities: [
        { kind: 'amount', value: '5000', provenance: 'utterance' },
        { kind: 'description', value: 'carne', provenance: 'utterance' },
      ],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J02', turnIndex: 0 },
    },
    {
      allowedModes: ['mutation-proposal'], allowedOperations: ['transactions.expense.create'],
      expectedArgs: {
        amountCents: 5000, description: 'carne',
        accountId: '10000000-0000-4000-8000-000000000003',
        categoryId: '20000000-0000-4000-8000-000000000003',
        date: '2026-10-24',
      },
      clarificationRequired: false, clarificationNeedles: null,
      expectedMissingFields: [], expectedAmbiguities: [],
      expectedEntities: [{ kind: 'category', value: 'mercado', provenance: 'utterance' }],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J02', turnIndex: 1 },
    },
  ],
  J03: [
    {
      allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
      clarificationRequired: true, clarificationNeedles: ['saldo', 'tipo'],
      expectedMissingFields: ['initialBalance', 'accountKind'], expectedAmbiguities: [],
      expectedEntities: [],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J03', turnIndex: 0 },
    },
    {
      allowedModes: ['mutation-proposal'], allowedOperations: ['accounts.create'],
      expectedArgs: { accountName: 'Reserva', accountKind: 'bank', initialBalanceCents: 10000 },
      clarificationRequired: false, clarificationNeedles: null,
      expectedMissingFields: [], expectedAmbiguities: [], expectedEntities: [],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J03', turnIndex: 1 },
    },
  ],
  J05: [
    {
      allowedModes: ['clarify'], allowedOperations: [], expectedArgs: {},
      clarificationRequired: true, clarificationNeedles: ['Aurora'],
      expectedMissingFields: [], expectedAmbiguities: ['account'],
      expectedEntities: [{ kind: 'account', value: 'Aurora', provenance: 'utterance' }],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J05', turnIndex: 0 },
    },
    {
      allowedModes: ['mutation-proposal'], allowedOperations: ['accounts.update'],
      expectedArgs: {
        accountId: '10000000-0000-4000-8000-000000000001',
        expectedName: 'Aurora',
        accountName: 'Reserva',
      },
      clarificationRequired: false, clarificationNeedles: null,
      expectedMissingFields: [], expectedAmbiguities: [],
      expectedEntities: [{ kind: 'account', value: 'Aurora', provenance: 'displayed-option' }],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J05', turnIndex: 1 },
    },
  ],
  J09: [
    {
      allowedModes: ['read'], allowedOperations: ['get_month_summary'],
      expectedArgs: { yearMonth: '2026-10' },
      clarificationRequired: false, clarificationNeedles: null,
      expectedMissingFields: [], expectedAmbiguities: [],
      expectedEntities: [{ kind: 'period', value: '2026-10', provenance: 'utterance' }],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J09', turnIndex: 0 },
    },
    {
      allowedModes: ['read'], allowedOperations: ['get_month_summary'],
      expectedArgs: { yearMonth: '2026-09' },
      clarificationRequired: false, clarificationNeedles: null,
      expectedMissingFields: [], expectedAmbiguities: [],
      expectedEntities: [{ kind: 'period', value: '2026-09', provenance: 'utterance' }],
      expectedContextProvenance: { origin: 'f1-journey-turn', corpusId: 'J09', turnIndex: 1 },
    },
  ],
});

export const F2A1_EVALUATED_JOURNEY_IDS: readonly string[] = Object.freeze([
  'J01', 'J02', 'J03', 'J05', 'J09',
]);
