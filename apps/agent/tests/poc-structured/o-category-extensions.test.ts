/**
 * O-category explicit extensions (debugger B2-root-cause, 2026-10-29).
 *
 * Scope: offline only — pure parser (`parseStructuredLLMOutput`) + pure runner
 * (`runF2A1`) + pure `extensionAcceptance`. No provider, no fetch, no
 * credentials, no inference, no production.
 *
 * Each extension = one EXTENSIONS entry (id, originalExpectation, limitation,
 * comparableCriterion, justification dated 29/10) + RED/GREEN proof here:
 * RED = base row FAILs without the extension; GREEN = `extensionAcceptance`
 * returns the extension id for the same row. Oracles, raws and evidences are
 * never touched: the base FAIL is preserved, the extension only documents the
 * accepted dimension.
 *
 * B2 raw interpretation payloads below are transcribed read-only from
 * `evidence/real/2026-10-29T21-11-36-402Z-20236/cases/*.json` (gitignored
 * execution evidence; envelope/prompt excluded — interpretation only).
 */
import { describe, expect, it } from 'vitest';
import { extensionAcceptance, runF2A1, type F2A1Row } from './evaluation-runner.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const B2_B036 = {
  interpretation: {
    intent: 'read',
    operation: 'get_month_summary',
    args: { yearMonth: '2026-10' },
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B036' },
    entities: [{ kind: 'period', value: 'mês atual', provenance: 'utterance' }],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'get_month_summary',
  },
};

const B2_J09_T1 = {
  interpretation: {
    intent: 'read',
    operation: 'get_month_summary',
    args: { yearMonth: '2026-10' },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J09', turnIndex: 0 },
    entities: [{ kind: 'period', value: '2026-10', provenance: 'local-fixture' }],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'get_month_summary',
  },
};

const B2_J09_T2 = {
  interpretation: {
    intent: 'read',
    operation: 'get_month_summary',
    args: { yearMonth: '2026-09' },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J09', turnIndex: 1 },
    entities: [{ kind: 'period', value: '2026-09', provenance: 'corpus-context' }],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'get_month_summary',
  },
};

const B2_J01_T1 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: {
      description: 'carne',
      accountId: '10000000-0000-4000-8000-000000000003',
      categoryId: '20000000-0000-4000-8000-000000000003',
      date: '2026-10-24',
    },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J01', turnIndex: 0 },
    entities: [
      { kind: 'description', value: 'carne', provenance: 'utterance' },
      { kind: 'account', value: 'Conta principal', provenance: 'utterance' },
      { kind: 'category', value: 'Mercado', provenance: 'utterance' },
      { kind: 'date', value: '2026-10-24', provenance: 'corpus-context' },
    ],
    ambiguities: [],
    clarification: null,
    missingFields: ['amount'],
    requestedAction: 'transactions.expense.create',
  },
};

const B2_J01_T2 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: {
      amountCents: 250000,
      description: 'carne',
      date: '2026-10-24',
      accountId: '10000000-0000-4000-8000-000000000003',
      categoryId: '20000000-0000-4000-8000-000000000003',
    },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J01', turnIndex: 1 },
    entities: [
      { kind: 'amount', value: '2500', provenance: 'utterance' },
      { kind: 'description', value: 'carne', provenance: 'corpus-context' },
      { kind: 'account', value: 'Conta principal', provenance: 'corpus-context' },
      { kind: 'category', value: 'Mercado', provenance: 'corpus-context' },
      { kind: 'date', value: '2026-10-24', provenance: 'corpus-context' },
    ],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'transactions.expense.create',
  },
};

const B2_J02_T1 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: {
      amountCents: 5000,
      description: 'carne',
      date: '2026-10-24',
      accountId: '10000000-0000-4000-8000-000000000003',
      accountName: 'Conta principal',
      categoryId: '20000000-0000-4000-8000-000000000003',
      categoryName: 'Mercado',
    },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J02', turnIndex: 0 },
    entities: [
      { kind: 'amount', value: '50', provenance: 'utterance' },
      { kind: 'description', value: 'carne', provenance: 'utterance' },
      { kind: 'account', value: 'Conta principal', provenance: 'utterance' },
      { kind: 'category', value: 'Mercado', provenance: 'corpus-context' },
      { kind: 'date', value: '2026-10-24', provenance: 'corpus-context' },
    ],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'transactions.expense.create',
  },
};

const B2_J02_T2 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: {
      amountCents: 5000,
      description: 'carne',
      date: '2026-10-24',
      accountId: '10000000-0000-4000-8000-000000000003',
      categoryId: '20000000-0000-4000-8000-000000000003',
    },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J02', turnIndex: 1 },
    entities: [
      { kind: 'amount', value: '50.00', provenance: 'corpus-context' },
      { kind: 'description', value: 'carne', provenance: 'corpus-context' },
      { kind: 'account', value: 'Conta principal', provenance: 'corpus-context' },
      { kind: 'category', value: 'Mercado', provenance: 'utterance' },
      { kind: 'date', value: '2026-10-24', provenance: 'local-fixture' },
    ],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'transactions.expense.create',
  },
};

const B2_J03_T1 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'accounts.create',
    args: { accountName: 'Reserva' },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J03', turnIndex: 0 },
    entities: [{ kind: 'account', value: 'Reserva', provenance: 'utterance' }],
    ambiguities: [],
    clarification: 'Qual é o tipo da conta: banco ou dinheiro?',
    missingFields: ['accountKind'],
    requestedAction: 'accounts.create',
  },
};

const B2_J03_T2 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'accounts.create',
    args: { accountName: 'Reserva', accountKind: 'bank', initialBalanceCents: 10000 },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J03', turnIndex: 1 },
    entities: [
      { kind: 'account', value: 'Reserva', provenance: 'corpus-context' },
      { kind: 'amount', value: '100', provenance: 'utterance' },
    ],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'accounts.create',
  },
};

const B2_J05_T1 = {
  interpretation: {
    intent: 'clarify',
    operation: 'none',
    args: {},
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J05', turnIndex: 0 },
    entities: [{ kind: 'account', value: 'Aurora', provenance: 'utterance' }],
    ambiguities: ['Há duas contas chamadas Aurora; não é possível identificar qual delas renomear.'],
    clarification: 'Há duas contas chamadas Aurora. Qual delas você quer renomear para Reserva?',
    missingFields: [],
    requestedAction: 'accounts.update',
  },
};

const B2_J05_T2 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'accounts.update',
    args: {
      accountId: '10000000-0000-4000-8000-000000000001',
      expectedName: 'Aurora',
      accountName: 'Reserva',
    },
    contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J05', turnIndex: 1 },
    entities: [{ kind: 'account', value: 'Aurora', provenance: 'displayed-option' }],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'accounts.update',
  },
};

const B2_B058 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: { amountCents: 2000 },
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B058' },
    entities: [
      { kind: 'amount', value: 'R$ 20', provenance: 'utterance' },
      { kind: 'period', value: '2020', provenance: 'utterance' },
    ],
    ambiguities: [],
    clarification: 'Qual foi a descrição, a conta, a categoria e a data exata em 2020 desse gasto de R$ 20?',
    missingFields: ['description', 'account', 'category', 'date'],
    requestedAction: 'transactions.expense.create',
  },
};

const B2_B013 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: {
      amountCents: 2500,
      description: 'Mercado',
      date: '2026-10-24',
      accountId: '10000000-0000-4000-8000-000000000003',
      accountName: 'Conta principal',
      categoryId: '20000000-0000-4000-8000-000000000003',
      categoryName: 'Mercado',
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
    clarification: null,
    missingFields: [],
    requestedAction: 'transactions.expense.create',
  },
};

const B2_B015 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: { amountCents: 5000, description: 'carne' },
    contextProvenance: { origin: 'local-fixture', corpusId: 'F2A1-B015-colloquial' },
    entities: [
      { kind: 'amount', value: 'R$ 50,00', provenance: 'utterance' },
      { kind: 'description', value: 'carne', provenance: 'utterance' },
    ],
    ambiguities: [],
    clarification: null,
    missingFields: ['account', 'category', 'date'],
    requestedAction: 'transactions.expense.create',
  },
};

const B2_B027 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.expense.create',
    args: { amountCents: 5000, description: 'carne', date: '2026-10-24' },
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B027-approx' },
    entities: [
      { kind: 'amount', value: '50', provenance: 'utterance' },
      { kind: 'description', value: 'carne', provenance: 'utterance' },
      { kind: 'date', value: '2026-10-24', provenance: 'corpus-context' },
    ],
    ambiguities: ["Valor aproximado informado como 'uns 50'"],
    clarification:
      'Você quer registrar um gasto de aproximadamente R$ 50 com carne em 24/10/2026. Qual conta e qual categoria devo usar?',
    missingFields: ['account', 'category'],
    requestedAction: 'transactions.expense.create',
  },
};

const B2_B012 = {
  interpretation: {
    intent: 'unsupported',
    operation: 'none',
    args: {},
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B012' },
    entities: [
      { kind: 'category', value: 'alimentação', provenance: 'utterance' },
      { kind: 'amount', value: '500', provenance: 'utterance' },
    ],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'budgets.create',
  },
};

const B2_B008 = {
  interpretation: {
    intent: 'advice',
    operation: 'none',
    args: {},
    contextProvenance: { origin: 'local-fixture', corpusId: 'F2A1-B008-concept' },
    entities: [],
    ambiguities: [],
    clarification: null,
    missingFields: [],
    requestedAction: 'none',
  },
};

const B2_B006 = {
  interpretation: {
    intent: 'clarify',
    operation: 'none',
    args: {},
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B006-reference' },
    entities: [],
    ambiguities: [],
    clarification:
      "Não há lançamento identificado para 'aquele gasto'. Qual lançamento devo corrigir (descrição ou data) e qual é o novo valor?",
    missingFields: ['entity', 'amount'],
    requestedAction: 'transactions.update',
  },
};

const B2_B016 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'accounts.update',
    args: { expectedName: 'Aurora', accountName: 'Reserva' },
    contextProvenance: { origin: 'local-fixture', corpusId: 'F2A1-B016-homonyms' },
    entities: [
      { kind: 'account', value: 'Aurora', provenance: 'utterance' },
      { kind: 'description', value: 'Reserva', provenance: 'utterance' },
    ],
    ambiguities: ["Há duas contas com o nome 'Aurora'; não está claro qual delas deve ser renomeada."],
    clarification:
      "Qual conta chamada 'Aurora' você quer renomear para 'Reserva'? Há duas: 10000000-0000-4000-8000-000000000001 e 10000000-0000-4000-8000-000000000002.",
    missingFields: ['account'],
    requestedAction: 'accounts.update',
  },
};

const B2_B021 = {
  interpretation: {
    intent: 'mutation-proposal',
    operation: 'transactions.update',
    args: { amountCents: 7500, expectedDescription: 'carne' },
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B021-correction' },
    entities: [
      { kind: 'amount', value: '75,00', provenance: 'utterance' },
      { kind: 'amount', value: '50,00', provenance: 'utterance' },
      { kind: 'description', value: 'carne', provenance: 'corpus-context' },
    ],
    ambiguities: [],
    clarification: null,
    missingFields: ['entity'],
    requestedAction: 'transactions.update',
  },
};

const scenarioRow = (id: string, output: unknown): F2A1Row => {
  const row = runF2A1({ scenarios: { [id]: output } }).scenarios.find((item) => item.corpusId === id);
  if (!row) throw new Error(`missing scenario row ${id}`);
  return row;
};

const journeyTurn = (jid: string, turns: readonly unknown[], index: number): F2A1Row => {
  const journey = runF2A1({ journeys: { [jid]: turns } }).journeys.find(
    (item) => item.comparison.corpusId === jid,
  );
  const turn = journey?.turns[index];
  if (!turn) throw new Error(`missing journey turn ${jid}:${index}`);
  return turn;
};

describe('O-category explicit extensions — RED (base FAIL) + GREEN (extension accepts)', () => {
  it('registers the four O-category extensions with dated justifications', () => {
    const extensions = runF2A1({}).extensions;
    expect(extensions).toHaveLength(13);
    const ids = extensions.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const required: Readonly<Record<string, readonly string[]>> = Object.freeze({
      'B036-period-resolution': Object.freeze(['F1-B036']),
      'J09-provenance-evidence': Object.freeze(['J09:T1', 'J09:T2']),
      'J01T2-J02T2-redundant-evidence': Object.freeze(['J01:T2', 'J02:T2']),
      'J05T1-homonym-clarification': Object.freeze(['J05:T1']),
    });
    for (const [id, corpusIds] of Object.entries(required)) {
      const entry = extensions.find((item) => item.id === id);
      expect(entry, id).toBeDefined();
      if (!entry) continue;
      for (const field of [
        'id',
        'originalExpectation',
        'limitation',
        'comparableCriterion',
        'justification',
      ] as const) {
        expect(typeof entry[field], `${id}.${field}`).toBe('string');
        expect(entry[field].trim().length, `${id}.${field}-non-empty`).toBeGreaterThan(0);
        // Significant: no placeholder single-token values.
        expect(entry[field].trim().length, `${id}.${field}-significant`).toBeGreaterThan(10);
      }
      expect(entry.justification).toContain('2026-10-29');
      expect(corpusIds.length).toBeGreaterThan(0);
    }
  });

  it('O extension ids map univocally to their allowlisted corpusIds', () => {
    const tB036 = clone(B2_B036);
    const rowB036 = scenarioRow('F1-B036', tB036);
    expect(rowB036.verdict).toBe('FAIL');
    // Each acceptance branch returns exactly its own allowlisted entry.
    expect(extensionAcceptance({ corpusId: 'F1-B036', rawOutput: tB036, row: rowB036 })).toBe(
      'B036-period-resolution',
    );
    // Cross-corpus never accepts: same valid row with a foreign corpusId.
    expect(extensionAcceptance({ corpusId: 'J09:T1', rawOutput: tB036, row: rowB036 })).toBeNull();
    expect(extensionAcceptance({ corpusId: 'J05:T1', rawOutput: tB036, row: rowB036 })).toBeNull();

    const tJ09T1 = clone(B2_J09_T1);
    const rowJ09T1 = journeyTurn('J09', [tJ09T1, clone(B2_J09_T2)], 0);
    expect(rowJ09T1.verdict).toBe('FAIL');
    expect(
      extensionAcceptance({ corpusId: 'J09:T1', rawOutput: tJ09T1, row: rowJ09T1 }),
    ).toBe('J09-provenance-evidence');
    expect(
      extensionAcceptance({ corpusId: 'F1-B036', rawOutput: tJ09T1, row: rowJ09T1 }),
    ).toBeNull();

    const j01 = [clone(B2_J01_T1), clone(B2_J01_T2)];
    const rowJ01T2 = journeyTurn('J01', j01, 1);
    expect(rowJ01T2.verdict).toBe('FAIL');
    expect(
      extensionAcceptance({ corpusId: 'J01:T2', rawOutput: j01[1], row: rowJ01T2 }),
    ).toBe('J01T2-J02T2-redundant-evidence');
    expect(
      extensionAcceptance({ corpusId: 'J05:T1', rawOutput: j01[1], row: rowJ01T2 }),
    ).toBeNull();

    const tJ05T1 = clone(B2_J05_T1);
    const rowJ05T1 = journeyTurn('J05', [tJ05T1, clone(B2_J05_T2)], 0);
    expect(rowJ05T1.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'J05:T1', rawOutput: tJ05T1, row: rowJ05T1 })).toBe(
      'J05T1-homonym-clarification',
    );
    expect(
      extensionAcceptance({ corpusId: 'F1-B036', rawOutput: tJ05T1, row: rowJ05T1 }),
    ).toBeNull();
  });

  it('tampered rawOutput is never accepted via a valid row (P1)', () => {
    const valid = clone(B2_B036);
    const row = scenarioRow('F1-B036', valid);
    expect(row.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'F1-B036', rawOutput: valid, row })).toBe(
      'B036-period-resolution',
    );
    // Parse-valid tamper: same args/entities but a different read operation.
    // Row alone still says intent/operation/args match; candidate does not.
    const tamperedOp = clone(B2_B036);
    (tamperedOp.interpretation as { operation: string }).operation = 'list_accounts';
    expect(
      extensionAcceptance({ corpusId: 'F1-B036', rawOutput: tamperedOp, row }),
    ).toBeNull();
    const tamperedArgs = clone(B2_B036);
    ((tamperedArgs.interpretation as { args: Record<string, unknown> }).args as Record<string, unknown>)[
      'yearMonth'
    ] = '2026-09';
    expect(
      extensionAcceptance({ corpusId: 'F1-B036', rawOutput: tamperedArgs, row }),
    ).toBeNull();
    // J01:T2 branch: same evidenced entities but adulterated amountCents.
    const j01 = [clone(B2_J01_T1), clone(B2_J01_T2)];
    const rowJ01T2 = journeyTurn('J01', j01, 1);
    expect(rowJ01T2.verdict).toBe('FAIL');
    expect(
      extensionAcceptance({ corpusId: 'J01:T2', rawOutput: j01[1], row: rowJ01T2 }),
    ).toBe('J01T2-J02T2-redundant-evidence');
    const tamperedAmount = clone(B2_J01_T2);
    ((tamperedAmount.interpretation as { args: Record<string, unknown> }).args as Record<string, unknown>)[
      'amountCents'
    ] = 5000;
    expect(
      extensionAcceptance({ corpusId: 'J01:T2', rawOutput: tamperedAmount, row: rowJ01T2 }),
    ).toBeNull();
  });

  it('tamper in non-identity fields is rejected via row binding (P1-round2)', () => {
    // Design choice (documented per Planner direction): `buildRow` stores the
    // exact parsed candidate that produced the row (`row.candidate`), and
    // `extensionAcceptance` requires DEEP equality (canonical JSON, sorted
    // keys) between the re-parsed `rawOutput` and that stored candidate. The
    // row already carried everything needed — no oracle/raw/evidence change,
    // no new comparison vocabulary: any tamper in ANY candidate field
    // diverges the canonical form and the acceptance is `null`.
    //
    // Each case below keeps a VALID row (built from the untampered raw) and
    // tampers ONLY one non-identity field in the raw, choosing values that
    // still satisfy every pre-existing check (oracle identity on
    // intent/operation/args, recomputed binding, branch predicates) — so a
    // `null` here proves the new deep-equality lock, not an older guard.
    const j05t1 = clone(B2_J05_T1);
    const rowJ05T1 = journeyTurn('J05', [j05t1, clone(B2_J05_T2)], 0);
    expect(rowJ05T1.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'J05:T1', rawOutput: j05t1, row: rowJ05T1 })).toBe(
      'J05T1-homonym-clarification',
    );
    // ambiguities: still non-empty and still names the homonym, but reworded.
    const tamperedAmbiguities = clone(B2_J05_T1);
    (tamperedAmbiguities.interpretation as { ambiguities: string[] }).ambiguities = [
      'Aurora: escolha entre a primeira e a segunda conta.',
    ];
    expect(
      extensionAcceptance({ corpusId: 'J05:T1', rawOutput: tamperedAmbiguities, row: rowJ05T1 }),
    ).toBeNull();
    // clarification: still names the homonym, but reworded.
    const tamperedClarification = clone(B2_J05_T1);
    (tamperedClarification.interpretation as { clarification: string }).clarification =
      'Qual conta Aurora devo renomear para Reserva, a primeira ou a segunda?';
    expect(
      extensionAcceptance({ corpusId: 'J05:T1', rawOutput: tamperedClarification, row: rowJ05T1 }),
    ).toBeNull();

    // missingFields: J09:T1 branch never inspects it, and 'account' is not in
    // the turn resolvableFields (['period']), so binding stays match.
    const j09t1 = clone(B2_J09_T1);
    const rowJ09T1 = journeyTurn('J09', [j09t1, clone(B2_J09_T2)], 0);
    expect(rowJ09T1.verdict).toBe('FAIL');
    expect(
      extensionAcceptance({ corpusId: 'J09:T1', rawOutput: j09t1, row: rowJ09T1 }),
    ).toBe('J09-provenance-evidence');
    const tamperedMissing = clone(B2_J09_T1);
    (tamperedMissing.interpretation as { missingFields: string[] }).missingFields = ['account'];
    expect(
      extensionAcceptance({ corpusId: 'J09:T1', rawOutput: tamperedMissing, row: rowJ09T1 }),
    ).toBeNull();

    // requestedAction + contextProvenance: F1-B036 branch never inspects
    // them; both tampers stay parse-valid and binding-match.
    const b036 = clone(B2_B036);
    const rowB036 = scenarioRow('F1-B036', b036);
    expect(rowB036.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'F1-B036', rawOutput: b036, row: rowB036 })).toBe(
      'B036-period-resolution',
    );
    const tamperedAction = clone(B2_B036);
    (tamperedAction.interpretation as { requestedAction: string }).requestedAction =
      'transactions.expense.create';
    expect(
      extensionAcceptance({ corpusId: 'F1-B036', rawOutput: tamperedAction, row: rowB036 }),
    ).toBeNull();
    const tamperedProvenance = clone(B2_B036);
    ((tamperedProvenance.interpretation as { contextProvenance: Record<string, unknown> }).contextProvenance as Record<string, unknown>)[
      'origin'
    ] = 'local-fixture';
    expect(
      extensionAcceptance({ corpusId: 'F1-B036', rawOutput: tamperedProvenance, row: rowB036 }),
    ).toBeNull();
  });

  it('F1-B036: RED entities mismatch, GREEN via B036-period-resolution', () => {
    const output = clone(B2_B036);
    const row = scenarioRow('F1-B036', output);
    // RED: operation + yearMonth correct, only the period entity diverges.
    expect(row.verdict).toBe('FAIL');
    expect(row.intent).toBe('match');
    expect(row.operation).toBe('match');
    expect(row.args).toBe('match');
    expect(row.entities).toBe('mismatch');
    // GREEN: "mês atual" resolves to the expected period via referenceDate.
    expect(extensionAcceptance({ corpusId: 'F1-B036', rawOutput: output, row })).toBe(
      'B036-period-resolution',
    );
  });

  it('J09:T1/T2: RED entities mismatch, GREEN via J09-provenance-evidence', () => {
    const t1 = clone(B2_J09_T1);
    const t2 = clone(B2_J09_T2);
    const row1 = journeyTurn('J09', [t1, t2], 0);
    const row2 = journeyTurn('J09', [t1, t2], 1);
    for (const [raw, row] of [
      [t1, row1],
      [t2, row2],
    ] as const) {
      expect(row.verdict).toBe('FAIL');
      expect(row.intent).toBe('match');
      expect(row.operation).toBe('match');
      expect(row.args).toBe('match');
      expect(row.entities).toBe('mismatch');
      expect(row.contextBinding).toBe('match');
      expect(extensionAcceptance({ corpusId: row.corpusId, rawOutput: raw, row })).toBe(
        'J09-provenance-evidence',
      );
    }
  });

  it('J01:T2 + J02:T2: RED entities mismatch, GREEN via redundant-evidence', () => {
    const j01 = [clone(B2_J01_T1), clone(B2_J01_T2)];
    const j02 = [clone(B2_J02_T1), clone(B2_J02_T2)];
    const row1 = journeyTurn('J01', j01, 1);
    const row2 = journeyTurn('J02', j02, 1);
    for (const [raw, row] of [
      [j01[1], row1],
      [j02[1], row2],
    ] as const) {
      expect(row.verdict).toBe('FAIL');
      expect(row.intent).toBe('match');
      expect(row.operation).toBe('match');
      expect(row.args).toBe('match');
      expect(row.entities).toBe('mismatch');
      expect(row.contextBinding).toBe('match');
      expect(extensionAcceptance({ corpusId: row.corpusId, rawOutput: raw, row })).toBe(
        'J01T2-J02T2-redundant-evidence',
      );
    }
  });

  it('J05:T1: RED ambiguities mismatch, GREEN via homonym-clarification', () => {
    const t1 = clone(B2_J05_T1);
    const t2 = clone(B2_J05_T2);
    const row = journeyTurn('J05', [t1, t2], 0);
    // RED: homonyms clarified correctly, only the ambiguities phrasing diverges.
    expect(row.verdict).toBe('FAIL');
    expect(row.intent).toBe('match');
    expect(row.operation).toBe('match');
    expect(row.entities).toBe('match');
    expect(row.clarification).toBe('match');
    expect(row.ambiguities).toBe('mismatch');
    // GREEN: journey criterion scores the semantically correct turn.
    expect(extensionAcceptance({ corpusId: 'J05:T1', rawOutput: t1, row })).toBe(
      'J05T1-homonym-clarification',
    );
  });
});

describe('O-category investigations kept FAIL (no extension granted)', () => {
  it('F1-B058 stays FAIL: proposed with incomplete date — fail-closed requires clarifying only', () => {
    const output = clone(B2_B058);
    const row = scenarioRow('F1-B058', output);
    expect(row.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'F1-B058', rawOutput: output, row })).toBeNull();
  });

  it('B013 + J02:T1 stay FAIL: redundant accountName/categoryName — strict schema may reject extras (prompt fix, not extension)', () => {
    const b013 = clone(B2_B013);
    const b013Row = scenarioRow('F2A1-B013-catalog', b013);
    expect(b013Row.verdict).toBe('FAIL');
    expect(b013Row.args).toBe('mismatch');
    expect(extensionAcceptance({ corpusId: 'F2A1-B013-catalog', rawOutput: b013, row: b013Row })).toBeNull();

    const j02t1 = clone(B2_J02_T1);
    const j02t1Row = journeyTurn('J02', [j02t1, clone(B2_J02_T2)], 0);
    expect(j02t1Row.verdict).toBe('FAIL');
    expect(j02t1Row.args).toBe('mismatch');
    expect(extensionAcceptance({ corpusId: 'J02:T1', rawOutput: j02t1, row: j02t1Row })).toBeNull();
  });

  it('B027 stays FAIL: real approximation error ("uns 50" proposed exact)', () => {
    const output = clone(B2_B027);
    const row = scenarioRow('F2A1-B027-approx', output);
    expect(row.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'F2A1-B027-approx', rawOutput: output, row })).toBeNull();
  });

  it('B012/B008/J03:T1 stay FAIL: concept/policy (budget, concept answer, creation proposal)', () => {
    const b012 = clone(B2_B012);
    const b012Row = scenarioRow('F1-B012', b012);
    expect(b012Row.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'F1-B012', rawOutput: b012, row: b012Row })).toBeNull();

    const b008 = clone(B2_B008);
    const b008Row = scenarioRow('F2A1-B008-concept', b008);
    expect(b008Row.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'F2A1-B008-concept', rawOutput: b008, row: b008Row })).toBeNull();

    const j03t1 = clone(B2_J03_T1);
    const j03t1Row = journeyTurn('J03', [j03t1, clone(B2_J03_T2)], 0);
    expect(j03t1Row.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'J03:T1', rawOutput: j03t1, row: j03t1Row })).toBeNull();
  });

  it('B006/B016/B021/J01:T1 stay FAIL: prompt-variant candidates (P/H), not extensions', () => {
    const cases = [
      ['F2A1-B006-reference', clone(B2_B006)] as const,
      ['F2A1-B016-homonyms', clone(B2_B016)] as const,
      ['F2A1-B021-correction', clone(B2_B021)] as const,
    ];
    for (const [id, output] of cases) {
      const row = scenarioRow(id, output);
      expect(row.verdict, id).toBe('FAIL');
      expect(extensionAcceptance({ corpusId: id, rawOutput: output, row }), id).toBeNull();
    }
    const j01t1 = clone(B2_J01_T1);
    const j01t1Row = journeyTurn('J01', [j01t1, clone(B2_J01_T2)], 0);
    expect(j01t1Row.verdict).toBe('FAIL');
    expect(extensionAcceptance({ corpusId: 'J01:T1', rawOutput: j01t1, row: j01t1Row })).toBeNull();
  });

  it('J03:T2 stays FAIL: "Reserva" is a creation target, not a catalog entry (binder is catalog-only by design)', () => {
    // Investigated 2026-10-29: suppliedValues.accountName ("Reserva") + history
    // DO evidence the name, but the binder account-entity rule is catalog-only
    // and the J03:T2 oracle expects zero entities. Accepting a creation-target
    // name as a known account would weaken unknown-account detection and bless
    // redundant emission — prompt variant (omit redundant entities) or oracle
    // revision, not an extension. Fail-closed de dado-ausente intocado.
    const t2 = clone(B2_J03_T2);
    const row = journeyTurn('J03', [clone(B2_J03_T1), t2], 1);
    expect(row.verdict).toBe('FAIL');
    expect(row.args).toBe('match');
    expect(row.entities).toBe('mismatch');
    expect(row.contextBinding).toBe('mismatch');
    expect(row.contextReasons).toContain('context-unknown-account-entity:Reserva');
    expect(extensionAcceptance({ corpusId: 'J03:T2', rawOutput: t2, row })).toBeNull();
  });

  it('B015 stays FAIL: oracle verbatim + bare-proposal shape is satisfiable; raw diverges on three axes at once', () => {
    // Investigated 2026-10-29: the oracle ("cinquenta reais" verbatim, no
    // missing fields, bare proposal) IS satisfiable from the context — the
    // utterance carries it and only amount is resolvable. The raw normalizes
    // the amount (semantically fine) BUT also relabels origin
    // (local-fixture vs f1-corpus-text) AND lists unasked missing fields while
    // asking nothing. An extension would need three simultaneous relaxations
    // (≈ universal leniency) and would mask the proposal-shape choice the
    // oracle deliberately pins — prompt variant, not an extension.
    const output = clone(B2_B015);
    const row = scenarioRow('F2A1-B015-colloquial', output);
    expect(row.verdict).toBe('FAIL');
    expect(row.args).toBe('match');
    expect(extensionAcceptance({ corpusId: 'F2A1-B015-colloquial', rawOutput: output, row })).toBeNull();
  });
});
