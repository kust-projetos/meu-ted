/**
 * B0 divergences — offline characterization (synthetic reproductions, no inference).
 *
 * Source (read-only, confirmed 2026-10-29, NOT loaded at runtime):
 * `apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/
 *  2026-10-29T13-25-07-295Z-6180/cases/{F1-B017,F1-B058,F2A1-B013-catalog,J09_T2}.json`
 * (fields `text`/`apiText`). That directory is gitignored execution evidence,
 * so CI must NOT read it: the shapes below are transcribed inline instead.
 * They are REPRODUCTIONS for characterization, not verbatim copies of the
 * stored files (envelope/metadata/prompt excluded; only the `interpretation`
 * payload is reproduced, faithfully including the divergence-relevant keys).
 *
 * Guarantees:
 * - Offline only: pure parser (`parseStructuredLLMOutput`) + pure runner
 *   (`runF2A1`). No provider, no fetch, no credentials, no inference.
 * - Does NOT modify oracles, parser, frozen artifacts, or production.
 * - J09:T2 asserts the oracle mismatch only (`yearMonth` expected, `period`
 *   supplied). API incompatibility is documented from the authoritative
 *   contract — `apps/api/openapi/agent-tools.openapi.json`
 *   (`/dashboard/month-summary`, operationId `get_month_summary`,
 *   required query param `yearMonth` with pattern
 *   `^\d{4}-(0[1-9]|1[0-2])$`, no `period` param; enforced by
 *   `monthSummaryQuerySchema` in `apps/api/src/routes/dashboard.ts`) —
 *   and is NOT executed or string-built here (no circular helper).
 * - For B013, asserts oracle exactness only and binder leniency only;
 *   asserts NOTHING about production API case requirements and does NOT
 *   change the oracle.
 */
import { describe, expect, it } from 'vitest';
import { parseStructuredLLMOutput } from '../../src/poc-structured/structured-interpretation.js';
import { F2A1_SCENARIOS } from './f2a1-oracles.js';
import { runF2A1 } from './evaluation-runner.js';

// Reproduction of B0 run 2026-10-29 `F1-B017` `text` (read-only confirmed):
// read/spending_insights with args {period:"2020"}, provenance
// local-fixture/F1-B017, entities [period 2020 utterance], no clarification,
// no missingFields, requestedAction spending_insights.
const b017Reproduction = {
  interpretation: {
    intent: 'read',
    operation: 'spending_insights',
    args: { period: '2020' },
    contextProvenance: { origin: 'local-fixture', corpusId: 'F1-B017' },
    entities: [{ kind: 'period', value: '2020', provenance: 'utterance' }],
    ambiguities: [],
    missingFields: [],
    clarification: null,
    requestedAction: 'spending_insights',
  },
};

// Reproduction of B0 run 2026-10-29 `F1-B058` `text` (read-only confirmed):
// mutation-proposal/transactions.expense.create with args {amountCents:2000},
// entities [amount "R$ 20" utterance, date "2020" utterance], one English
// ambiguity sentence, clarification asking for description/account/category/
// exact date, missingFields [description,account,category,date],
// requestedAction transactions.expense.create.
const b058Reproduction = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: { amountCents: 2000 },
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B058' },
    entities: [
      { kind: 'amount', value: 'R$ 20', provenance: 'utterance' },
      { kind: 'date', value: '2020', provenance: 'utterance' },
    ],
    ambiguities: ['Only the year 2020 is provided for the expense date; the month and day are unresolved.'],
    missingFields: ['description', 'account', 'category', 'date'],
    clarification: 'Informe a descrição, a conta, a categoria e a data exata (mês e dia) do gasto de R$ 20 em 2020.',
    requestedAction: 'transactions.expense.create',
  },
};

// Reproduction of B0 run 2026-10-29 `J09:T2` `text` (read-only confirmed):
// read/get_month_summary with args {period:"2026-09"} (NOT yearMonth),
// provenance f1-journey-turn/J09/turnIndex 1,
// entities [period 2026-09 corpus-context], no clarification/missingFields.
const j09T2Reproduction = {
  interpretation: {
    intent: 'read',
    operation: 'get_month_summary',
    args: { period: '2026-09' },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J09', turnIndex: 1 },
    entities: [{ kind: 'period', value: '2026-09', provenance: 'corpus-context' }],
    ambiguities: [],
    missingFields: [],
    clarification: null,
  },
};

// Reproduction of B0 run 2026-10-29 `F2A1-B013-catalog` `text`
// (read-only confirmed): mutation-proposal/transactions.expense.create with
// args description "Mercado" (capital M), entities amount "R$ 25,00"
// utterance + description "Mercado" utterance + category "Mercado"
// local-fixture + account "Conta principal" local-fixture + date
// "2026-10-24" local-fixture, requestedAction transactions.expense.create.
const b013Reproduction = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: {
      amountCents: 2500,
      description: 'Mercado',
      date: '2026-10-24',
      accountId: '10000000-0000-4000-8000-000000000003',
      categoryId: '20000000-0000-4000-8000-000000000003',
    },
    contextProvenance: { origin: 'local-fixture', corpusId: 'F2A1-B013-catalog' },
    entities: [
      { kind: 'amount', value: 'R$ 25,00', provenance: 'utterance' },
      { kind: 'description', value: 'Mercado', provenance: 'utterance' },
      { kind: 'category', value: 'Mercado', provenance: 'local-fixture' },
      { kind: 'account', value: 'Conta principal', provenance: 'local-fixture' },
      { kind: 'date', value: '2026-10-24', provenance: 'local-fixture' },
    ],
    ambiguities: [],
    missingFields: [],
    clarification: null,
    requestedAction: 'transactions.expense.create',
  },
};

describe('B0 divergences — offline characterization (reproductions)', () => {
  it('F1-B017: B0 read/spending_insights without clarification FAILs per oracle (clarification required)', () => {
    const parsed = parseStructuredLLMOutput(JSON.parse(JSON.stringify(b017Reproduction)));
    expect(parsed.intent).toBe('read');

    const result = runF2A1({ scenarios: { 'F1-B017': b017Reproduction } });
    const row = result.scenarios.find((item) => item.corpusId === 'F1-B017');
    expect(row?.verdict).toBe('FAIL');
    expect(row?.intent).toBe('mismatch');
    expect(row?.operation).toBe('mismatch');
    expect(row?.clarification).toBe('mismatch');
    expect(row?.missingFields).toBe('mismatch');
    expect(row?.contextProvenance).toBe('mismatch');
    expect(row?.reasons).toContain('observable-mismatch-no-financial-claim');
    // Oracle independently still requires clarification for a bare year.
    expect(F2A1_SCENARIOS['F1-B017']?.clarificationRequired).toBe(true);
    expect(F2A1_SCENARIOS['F1-B017']?.expectedMissingFields).toEqual(['period']);
  });

  it('F1-B058: B0 proposal shape FAILs per oracle on intent/args/entities despite present clarification', () => {
    const parsed = parseStructuredLLMOutput(JSON.parse(JSON.stringify(b058Reproduction)));
    expect(parsed.intent).toBe('mutation-proposal');

    const result = runF2A1({ scenarios: { 'F1-B058': b058Reproduction } });
    const row = result.scenarios.find((item) => item.corpusId === 'F1-B058');
    expect(row?.verdict).toBe('FAIL');
    expect(row?.intent).toBe('mismatch');
    expect(row?.operation).toBe('mismatch');
    expect(row?.args).toBe('mismatch');
    // The B0 text DOES clarify (needle "data" present); the failure is the
    // proposal shape, not a missing question.
    expect(row?.clarification).toBe('match');
    expect(row?.missingFields).toBe('mismatch');
    expect(row?.entities).toBe('mismatch');
    expect(F2A1_SCENARIOS['F1-B058']?.clarificationRequired).toBe(true);
    expect(F2A1_SCENARIOS['F1-B058']?.expectedMissingFields).toEqual(['date']);
  });

  it('J09:T2: B0 `period` instead of `yearMonth` FAILs vs oracle (authoritative contract cited, not executed)', () => {
    const parsed = parseStructuredLLMOutput(JSON.parse(JSON.stringify(j09T2Reproduction)));
    expect(parsed.operation).toBe('get_month_summary');

    const full = runF2A1({
      journeys: {
        J09: [
          {
            interpretation: {
              intent: 'read',
              operation: 'get_month_summary',
              args: { yearMonth: '2026-10' },
              contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J09', turnIndex: 0 },
              entities: [{ kind: 'period', value: '2026-10', provenance: 'utterance' }],
              ambiguities: [],
              missingFields: [],
              clarification: null,
            },
          },
          j09T2Reproduction,
        ],
      },
    });
    const journey = full.journeys.find((item) => item.comparison.corpusId === 'J09');
    const t2 = journey?.turns[1];
    expect(t2?.verdict).toBe('FAIL');
    expect(t2?.args).toBe('mismatch');
    expect(t2?.argsMismatchedKeys).toEqual(expect.arrayContaining(['yearMonth', 'period']));
    expect(t2?.entities).toBe('mismatch');
    // NOTE: API incompatibility follows from the authoritative contract
    // (agent-tools.openapi.json: GET /dashboard/month-summary requires
    // `yearMonth`, no `period`; dashboard.ts monthSummaryQuerySchema), but no
    // HTTP/API call or query-string rendering is performed in this test.
    const candidateArgs = parsed.args as Record<string, unknown>;
    expect(candidateArgs).not.toHaveProperty('yearMonth');
    expect(candidateArgs).toHaveProperty('period', '2026-09');
  });

  it('F2A1-B013: G2c folds `Mercado` vs oracle `mercado` (args match); FAIL preserved via entities/provenance', () => {
    const parsed = parseStructuredLLMOutput(JSON.parse(JSON.stringify(b013Reproduction)));
    expect(parsed.args['description']).toBe('Mercado');

    // Oracle is unchanged: lowercase `mercado`. G2c (uso pessoal, operador
    // 2026-10-29) compara description por fold; IDs seguem exatos e a API
    // preserva casing original (prova em transactions-write.test.ts).
    expect(F2A1_SCENARIOS['F2A1-B013-catalog']?.expectedArgs).toMatchObject({ description: 'mercado' });

    const result = runF2A1({ scenarios: { 'F2A1-B013-catalog': b013Reproduction } });
    const row = result.scenarios.find((item) => item.corpusId === 'F2A1-B013-catalog');
    // Folded description matches; the B0 shape still FAILs on entities
    // (amount `R$ 25,00` vs `2500`, extra local-fixture entities) e
    // contextProvenance (local-fixture vs f1-corpus-text).
    expect(row?.verdict).toBe('FAIL');
    expect(row?.args).toBe('match');
    expect(row?.argsMismatchedKeys).not.toContain('description');
    expect(row?.entities).toBe('mismatch');
    // Binder evidence is folded (case/accents): the same value is still evidenced.
    expect(row?.contextBinding).toBe('match');
    expect(row?.contextReasons).not.toContain('context-unevidenced-arg:description');
    // Deliberately NO assertion about production API case-sensitivity here.
  });
});
