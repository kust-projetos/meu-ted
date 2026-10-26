/**
 * F2-A POC candidate fixtures — CANDIDATE ONLY (no expected copy).
 *
 * Each entry is the structured JSON a candidate interpreter returned for the
 * turn. The A/B runner parses `llmJson` through `parseStructuredLLMOutput` and
 * compares the ACTUAL result against the frozen F1 oracle
 * (`evals/ted-f1-scenarios.json`). There is intentionally no `expected` field:
 * duplicating the expectation here would let the runner compare a fixture to
 * itself and never exercise the parser.
 *
 * Corpus IDs without an entry MUST surface as INCONCLUSIVE in the runner —
 * never invented, never PASS.
 */
export type CandidateFixture = {
  readonly fixtureId: string;
  readonly corpusId: string;
  readonly text: string;
  readonly llmJson: string;
};

const llm = (interpretation: unknown): string => JSON.stringify({ interpretation });

export const CANDIDATE_FIXTURES: readonly CandidateFixture[] = [
  {
    fixtureId: 'LOCAL-F2A-001',
    corpusId: 'F1-B002',
    text: 'Quanto gastei este mês',
    llmJson: llm({
      intent: 'read',
      operation: 'get_month_summary',
      args: { yearMonth: '2026-10' },
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B002' },
      entities: [{ kind: 'period', value: '2026-10', provenance: 'corpus-context' }],
      ambiguities: [],
      clarification: null,
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-002',
    corpusId: 'F1-B001',
    text: 'Gastei 50 com carne',
    llmJson: llm({
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: { amountCents: 5000, description: 'carne', accountId: null, categoryId: null },
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B001' },
      entities: [
        { kind: 'amount', value: '5000', provenance: 'utterance' },
        { kind: 'description', value: 'carne', provenance: 'utterance' },
      ],
      ambiguities: ['account', 'category'],
      clarification: 'Qual conta e categoria devo usar?',
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-003',
    corpusId: 'F1-B008',
    text: 'O que é cartão de crédito?',
    llmJson: llm({
      intent: 'conversation',
      operation: 'none',
      args: {},
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B008' },
      entities: [],
      ambiguities: [],
      clarification: null,
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-004',
    corpusId: 'F1-B012',
    text: 'Crie um orçamento de alimentação de 500 reais',
    llmJson: llm({
      intent: 'unsupported',
      operation: 'none',
      args: {},
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B012' },
      entities: [{ kind: 'amount', value: '50000', provenance: 'utterance' }],
      ambiguities: ['capability'],
      clarification: 'Ainda não é possível criar orçamentos pelo TED.',
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-005',
    corpusId: 'F1-B059',
    text: 'Obrigado, era só isso',
    llmJson: llm({
      intent: 'conversation',
      operation: 'none',
      args: {},
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B059' },
      entities: [],
      ambiguities: [],
      clarification: null,
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-006',
    corpusId: 'F1-B013',
    text: 'Registre uma despesa de R$ 25,00 no mercado',
    llmJson: llm({
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: {
        amountCents: 2500,
        description: 'mercado',
        accountId: '10000000-0000-4000-8000-000000000003',
        categoryId: '20000000-0000-4000-8000-000000000003',
        date: '2026-10-24',
      },
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B013' },
      entities: [
        { kind: 'amount', value: '2500', provenance: 'utterance' },
        { kind: 'description', value: 'mercado', provenance: 'utterance' },
      ],
      ambiguities: [],
      clarification: null,
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-007',
    corpusId: 'F1-B014',
    text: 'Recebi R$ 200,00 de salário',
    llmJson: llm({
      intent: 'mutation-proposal',
      operation: 'transactions.income.create',
      args: { amountCents: 20000, description: 'salário', accountId: null },
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B014' },
      entities: [{ kind: 'amount', value: '20000', provenance: 'utterance' }],
      ambiguities: ['account'],
      clarification: 'Qual conta devo usar?',
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-008',
    corpusId: 'F1-B030',
    text: 'Gastei R$ 5.000,00 com carne',
    llmJson: llm({
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: { amountCents: 500000, description: 'carne' },
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B030' },
      entities: [
        { kind: 'amount', value: '500000', provenance: 'utterance' },
        { kind: 'description', value: 'carne', provenance: 'utterance' },
      ],
      ambiguities: ['account', 'category'],
      clarification: 'Qual conta e qual categoria devo usar?',
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-009',
    corpusId: 'F1-B055',
    text: 'Registre um gasto de R$ 50,00 com carne e confirme',
    llmJson: llm({
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: { amountCents: 5000, description: 'carne' },
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B055' },
      entities: [
        { kind: 'amount', value: '5000', provenance: 'utterance' },
        { kind: 'description', value: 'carne', provenance: 'utterance' },
      ],
      ambiguities: [],
      clarification: null,
    }),
  },
  {
    fixtureId: 'LOCAL-F2A-010',
    corpusId: 'J01',
    text: 'Gastei com carne na Conta principal categoria mercado',
    llmJson: llm({
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: { description: 'carne', accountName: 'Conta principal', categoryName: 'mercado' },
      contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J01', turnIndex: 0 },
      entities: [{ kind: 'description', value: 'carne', provenance: 'utterance' }],
      ambiguities: ['amount'],
      clarification: 'Qual é o valor da despesa?',
    }),
  },
];
