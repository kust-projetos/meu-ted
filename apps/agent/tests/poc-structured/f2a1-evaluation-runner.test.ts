import { describe, expect, it } from 'vitest';
import { runF2A1 } from './evaluation-runner.js';
import { F2A1_LOCAL_CANDIDATES, F2A1_LOCAL_JOURNEYS } from './f2a1-candidates.js';
import { F2A1_INPUTS } from './f2a1-inputs.js';

const candidate = (value: Record<string, unknown>) => ({
  interpretation: {
    intent: 'clarify',
    operation: 'none',
    args: {},
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B017' },
    entities: [{ kind: 'period', value: '2020', provenance: 'utterance' }],
    ambiguities: [],
    missingFields: ['period'],
    clarification: 'Qual mês ou período você quer consultar?',
    ...value,
  },
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const corruptScenario = (
  id: string,
  mutate: (interpretation: Record<string, unknown>) => void,
): { id: string; output: unknown } => {
  const copy = clone(F2A1_LOCAL_CANDIDATES[id]) as { interpretation: Record<string, unknown> };
  mutate(copy.interpretation);
  return { id, output: copy };
};

const scenarioRow = (result: ReturnType<typeof runF2A1>, id: string) =>
  result.scenarios.find((row) => row.corpusId === id);

const journeyRows = (id: string) => {
  const turns = clone(F2A1_LOCAL_JOURNEYS[id] as readonly unknown[]);
  return { [id]: turns };
};

describe('F2-A1 independent oracle runner', () => {
  it('parses supplied actual outputs and compares historical-year semantics', () => {
    const result = runF2A1({ scenarios: { 'F1-B017': candidate({}) } });
    const row = scenarioRow(result, 'F1-B017');
    expect(row?.verdict).toBe('PASS');
    expect(row?.clarificationNeedles).toBe('match');
    expect(row?.missingFields).toBe('match');
    expect(row?.ambiguities).toBe('match');
    expect(row?.financialCompletion).toBe('unobservable');
    expect(row?.inputContext?.currentText).toBe('Quanto gastei em 2020?');
    expect(row?.inputContext?.referenceDate).toBe('2026-10-24');
  });

  it('runs all 13 semantic scenarios and all 5 evaluated journeys to PASS', () => {
    const result = runF2A1({ scenarios: F2A1_LOCAL_CANDIDATES, journeys: F2A1_LOCAL_JOURNEYS });
    const expectedScenarios = [
      'F1-B005', 'F1-B010', 'F1-B012', 'F1-B017', 'F1-B036', 'F1-B058',
      'F2A1-B013-catalog', 'F2A1-B015-colloquial', 'F2A1-B027-approx',
      'F2A1-B006-reference', 'F2A1-B016-homonyms', 'F2A1-B021-correction',
      'F2A1-B008-concept',
    ];
    expect(result.scenarios).toHaveLength(13);
    for (const id of expectedScenarios) {
      expect(scenarioRow(result, id)?.verdict, id).toBe('PASS');
    }
    expect(result.journeys.map((journey) => journey.comparison.corpusId)).toEqual([
      'J01', 'J02', 'J03', 'J05', 'J09',
    ]);
    for (const journey of result.journeys) {
      expect(journey.semanticVerdict, journey.comparison.corpusId).toBe('PASS');
      expect(journey.comparison.financialCompletion).toBe('unobservable');
      expect(journey.comparison.verdict).toBe('INCONCLUSIVE');
    }
    expect(result.verdict).toBe('PASS');
  });

  it('keeps the other five frozen journeys retained and separate from the aggregate', () => {
    const result = runF2A1({ scenarios: F2A1_LOCAL_CANDIDATES, journeys: F2A1_LOCAL_JOURNEYS });
    expect(result.retainedJourneys.map((journey) => journey.corpusId)).toEqual([
      'J04', 'J06', 'J07', 'J08', 'J10',
    ]);
    for (const journey of result.retainedJourneys) {
      expect(journey.verdict).toBe('INCONCLUSIVE');
      expect(journey.reasons).toContain('journey-retained-not-evaluated');
      expect(journey.financialCompletion).toBe('unobservable');
    }
    // Their INCONCLUSIVE state never pulls the evaluated aggregate down.
    expect(result.verdict).toBe('PASS');
  });

  it('reports B012 as an honest unsupported capability, never executable', () => {
    const row = scenarioRow(runF2A1({ scenarios: F2A1_LOCAL_CANDIDATES }), 'F1-B012');
    expect(row?.verdict).toBe('PASS');
    expect(row?.intent).toBe('match');
    expect(row?.operation).toBe('match');
    expect(row?.requestedAction).toBe('match');
    expect(row?.missingFields).toBe('match');
    expect(row?.ambiguities).toBe('match');
    expect(row?.capabilityAvailability).toBe('unsupported');
    expect(row?.clarificationKind).toBe('limitation');
    expect(row?.reasons).not.toContain('observable-mismatch-no-financial-claim');
  });

  it('does not treat a known unavailable capability as an ambiguity (B012)', () => {
    const withCapabilityAmbiguity = corruptScenario('F1-B012', (interpretation) => {
      interpretation.ambiguities = ['capability'];
    });
    const row = scenarioRow(
      runF2A1({ scenarios: { [withCapabilityAmbiguity.id]: withCapabilityAmbiguity.output } }),
      withCapabilityAmbiguity.id,
    );
    expect(row?.verdict).toBe('FAIL');
    expect(row?.ambiguities).toBe('mismatch');
    // Still an honest limitation, never an executable capability.
    expect(row?.capabilityAvailability).toBe('unsupported');
    expect(row?.clarificationKind).toBe('limitation');
  });

  it('requires declared context evidence for inherited slots (J03 account name)', () => {
    const withoutEvidence = {
      ...F2A1_INPUTS['J03:T2']!,
      history: [],
      suppliedValues: {},
    };
    const removed = runF2A1({
      journeys: { J03: F2A1_LOCAL_JOURNEYS.J03 },
      inputs: { ...F2A1_INPUTS, 'J03:T2': withoutEvidence },
    });
    const turn = removed.journeys.find((item) => item.comparison.corpusId === 'J03')?.turns[1];
    expect(turn?.contextBinding).toBe('mismatch');
    expect(turn?.verdict).toBe('FAIL');
    expect(turn?.contextReasons).toContain('context-unevidenced-arg:accountName');

    // Either declared source alone still justifies the inherited name.
    const historyOnly = runF2A1({
      journeys: { J03: F2A1_LOCAL_JOURNEYS.J03 },
      inputs: { ...F2A1_INPUTS, 'J03:T2': { ...F2A1_INPUTS['J03:T2']!, suppliedValues: {} } },
    });
    const suppliedOnly = runF2A1({
      journeys: { J03: F2A1_LOCAL_JOURNEYS.J03 },
      inputs: { ...F2A1_INPUTS, 'J03:T2': { ...F2A1_INPUTS['J03:T2']!, history: [] } },
    });
    expect(
      historyOnly.journeys.find((item) => item.comparison.corpusId === 'J03')?.turns[1]?.contextBinding,
    ).toBe('match');
    expect(
      suppliedOnly.journeys.find((item) => item.comparison.corpusId === 'J03')?.turns[1]?.contextBinding,
    ).toBe('match');
  });

  it('requires declared context evidence for J01 description and J09 prior period', () => {
    const j01 = runF2A1({
      journeys: { J01: F2A1_LOCAL_JOURNEYS.J01 },
      inputs: {
        ...F2A1_INPUTS,
        'J01:T2': { ...F2A1_INPUTS['J01:T2']!, history: [], suppliedValues: {} },
      },
    });
    const j01Turn = j01.journeys.find((item) => item.comparison.corpusId === 'J01')?.turns[1];
    expect(j01Turn?.verdict).toBe('FAIL');
    expect(j01Turn?.contextReasons).toContain('context-unevidenced-arg:description');

    const j09 = runF2A1({
      journeys: { J09: F2A1_LOCAL_JOURNEYS.J09 },
      inputs: {
        ...F2A1_INPUTS,
        'J09:T2': { ...F2A1_INPUTS['J09:T2']!, history: [], suppliedValues: {} },
      },
    });
    const j09Turn = j09.journeys.find((item) => item.comparison.corpusId === 'J09')?.turns[1];
    expect(j09Turn?.verdict).toBe('FAIL');
    expect(j09Turn?.contextReasons).toContain('context-unevidenced-arg:yearMonth');
    // The frozen reference date still evidences the current month (T1).
    const j09T1 = runF2A1({
      journeys: { J09: F2A1_LOCAL_JOURNEYS.J09 },
      inputs: {
        ...F2A1_INPUTS,
        'J09:T1': { ...F2A1_INPUTS['J09:T1']!, suppliedValues: {} },
      },
    });
    expect(
      j09T1.journeys.find((item) => item.comparison.corpusId === 'J09')?.turns[0]?.contextBinding,
    ).toBe('match');
  });

  it('does not ask a redundant J02 category question when the catalog is obvious', () => {
    const result = runF2A1({ journeys: { J02: F2A1_LOCAL_JOURNEYS.J02 } });
    const journey = result.journeys.find((item) => item.comparison.corpusId === 'J02');
    expect(journey?.turns[0]?.clarification).toBe('match');
    expect(journey?.turns[0]?.clarificationKind).toBeNull();
    expect(journey?.turns[0]?.missingFields).toBe('match');
    expect(journey?.turns[0]?.args).toBe('match');
    expect(journey?.turns[0]?.contextBinding).toBe('match');
    expect(journey?.semanticVerdict).toBe('PASS');
    // The frozen F1 stage list remains a separate, documented constraint.
    expect(result.extensions.find((item) => item.id === 'J02-category')?.originalExpectation).toContain(
      'clarify -> propose',
    );
  });

  it('binds J05 turn 2 to the first displayed Aurora option, not an arbitrary one', () => {
    const result = runF2A1({ journeys: journeyRows('J05') });
    const journey = result.journeys.find((item) => item.comparison.corpusId === 'J05');
    const second = journey?.turns[1];
    expect(second?.verdict).toBe('PASS');
    expect(second?.clarificationKind).toBeNull();
    expect(second?.inputContext?.displayedOptions).toEqual([
      expect.objectContaining({ position: 1, name: 'Aurora', accountId: '10000000-0000-4000-8000-000000000001' }),
      expect.objectContaining({ position: 2, name: 'Aurora', accountId: '10000000-0000-4000-8000-000000000002' }),
    ]);
    expect(second?.inputContext?.suppliedValues.selectedPosition).toBe(1);

    const wrongOption = clone(F2A1_LOCAL_JOURNEYS.J05 as readonly unknown[]) as {
      interpretation: Record<string, unknown>;
    }[];
    wrongOption[1]!.interpretation.args = {
      accountId: '10000000-0000-4000-8000-000000000002',
      expectedName: 'Aurora',
      accountName: 'Reserva',
    };
    const wrong = runF2A1({ journeys: { J05: wrongOption } });
    const wrongTurn = wrong.journeys.find((item) => item.comparison.corpusId === 'J05')?.turns[1];
    expect(wrongTurn?.verdict).toBe('FAIL');
    expect(wrongTurn?.args).toBe('mismatch');
    expect(wrongTurn?.contextReasons).toContain(
      'context-selection-mismatch:10000000-0000-4000-8000-000000000002',
    );
  });

  it('rejects unknown context IDs and questions the supplied context already answers', () => {
    const unknownId = corruptScenario('F2A1-B013-catalog', (interpretation) => {
      interpretation.args = {
        ...(interpretation.args as Record<string, unknown>),
        categoryId: '99999999-0000-4000-8000-000000000099',
      };
    });
    const unknownRow = scenarioRow(runF2A1({ scenarios: { [unknownId.id]: unknownId.output } }), unknownId.id);
    expect(unknownRow?.verdict).toBe('FAIL');
    expect(unknownRow?.contextBinding).toBe('mismatch');
    expect(unknownRow?.contextReasons).toContain(
      'context-unknown-category-id:99999999-0000-4000-8000-000000000099',
    );

    const redundant = clone(F2A1_LOCAL_JOURNEYS.J02 as readonly unknown[]) as {
      interpretation: Record<string, unknown>;
    }[];
    redundant[0]!.interpretation.missingFields = ['category'];
    const redundantRow = runF2A1({ journeys: { J02: redundant } })
      .journeys.find((item) => item.comparison.corpusId === 'J02')
      ?.turns[0];
    expect(redundantRow?.verdict).toBe('FAIL');
    expect(redundantRow?.contextReasons).toContain('missing-despite-context:category');
  });

  it('keeps set comparisons independent of array order', () => {
    const reordered = clone(F2A1_LOCAL_CANDIDATES['F1-B058']) as { interpretation: Record<string, unknown> };
    reordered.interpretation.entities = [
      { kind: 'date', value: '2020', provenance: 'utterance' },
      { kind: 'amount', value: '2000', provenance: 'utterance' },
    ];
    const row = scenarioRow(runF2A1({ scenarios: { 'F1-B058': reordered } }), 'F1-B058');
    expect(row?.verdict).toBe('PASS');
    expect(row?.entities).toBe('match');
  });

  it('rejects invalid supplied payloads as FAIL and missing candidates as INCONCLUSIVE', () => {
    const invalid = runF2A1({ scenarios: { 'F1-B005': { interpretation: { intent: 'bogus' } } } });
    expect(scenarioRow(invalid, 'F1-B005')?.schemaError).toBe('agent.invalid_structured_interpretation');
    expect(scenarioRow(invalid, 'F1-B005')?.verdict).toBe('FAIL');
    expect(scenarioRow(invalid, 'F1-B005')?.reasons).toContain(
      'schema-invalid:agent.invalid_structured_interpretation',
    );

    const missing = runF2A1({ scenarios: {} });
    expect(missing.scenarios.every((row) => row.verdict === 'INCONCLUSIVE')).toBe(true);
    expect(missing.scenarios.every((row) => row.reasons.includes('no-candidate'))).toBe(true);
  });

  it('rejects year-as-money, dropped clarification, invented entity/context', () => {
    const yearAsAmount = candidate({
      intent: 'mutation-proposal',
      operation: 'transactions.expense.create',
      args: { amountCents: 202000 },
      clarification: null,
    });
    const noClarification = candidate({ clarification: null });
    const inventedContext = candidate({
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B058' },
      entities: [{ kind: 'account', value: 'Inventada', provenance: 'corpus-context' }],
    });
    const result = runF2A1({
      scenarios: {
        'F1-B058': yearAsAmount,
        'F1-B017': noClarification,
        'F1-B036': inventedContext,
      },
    });
    expect(scenarioRow(result, 'F1-B058')?.verdict).toBe('FAIL');
    expect(scenarioRow(result, 'F1-B058')?.intent).toBe('mismatch');
    expect(scenarioRow(result, 'F1-B017')?.clarification).toBe('mismatch');
    expect(scenarioRow(result, 'F1-B036')?.verdict).toBe('FAIL');
    expect(scenarioRow(result, 'F1-B036')?.contextProvenance).toBe('mismatch');
  });

  it('fails independently corrupted entity and context provenance in B036', () => {
    const good = F2A1_LOCAL_CANDIDATES['F1-B036'] as { interpretation: Record<string, unknown> };
    const extraEntity = {
      ...good,
      interpretation: {
        ...good.interpretation,
        entities: [{ kind: 'account', value: 'Inventada', provenance: 'utterance' }],
      },
    };
    const wrongOrigin = {
      ...good,
      interpretation: { ...good.interpretation, contextProvenance: { origin: 'local-fixture', corpusId: 'F1-B036' } },
    };
    const entityResult = scenarioRow(runF2A1({ scenarios: { 'F1-B036': extraEntity } }), 'F1-B036');
    const originResult = scenarioRow(runF2A1({ scenarios: { 'F1-B036': wrongOrigin } }), 'F1-B036');
    expect(entityResult?.verdict).toBe('FAIL');
    expect(entityResult?.entities).toBe('mismatch');
    expect(originResult?.verdict).toBe('FAIL');
    expect(originResult?.contextProvenance).toBe('mismatch');
  });

  it('proves each of the seven extension pairs with a negative corruption', () => {
    const corruptions = [
      corruptScenario('F2A1-B013-catalog', (interpretation) => {
        interpretation.args = { ...(interpretation.args as Record<string, unknown>), categoryId: 'unknown' };
      }),
      corruptScenario('F2A1-B015-colloquial', (interpretation) => {
        interpretation.args = { ...(interpretation.args as Record<string, unknown>), amountCents: 500 };
      }),
      corruptScenario('F2A1-B027-approx', (interpretation) => {
        interpretation.intent = 'mutation-proposal';
        interpretation.operation = 'transactions.expense.create';
        interpretation.args = { amountCents: 5000 };
        interpretation.ambiguities = [];
        interpretation.missingFields = [];
        interpretation.clarification = null;
      }),
      corruptScenario('F2A1-B006-reference', (interpretation) => {
        interpretation.intent = 'mutation-proposal';
        interpretation.operation = 'transactions.update';
        interpretation.args = { transactionId: 'missing-target' };
        interpretation.clarification = null;
      }),
      corruptScenario('F2A1-B016-homonyms', (interpretation) => {
        interpretation.intent = 'mutation-proposal';
        interpretation.operation = 'accounts.update';
        interpretation.args = {
          accountId: '10000000-0000-4000-8000-000000000001',
          expectedName: 'Aurora',
          accountName: 'Reserva',
        };
        interpretation.ambiguities = [];
        interpretation.clarification = null;
      }),
      corruptScenario('F2A1-B021-correction', (interpretation) => {
        interpretation.intent = 'mutation-proposal';
        interpretation.operation = 'transactions.update';
        interpretation.args = { transactionId: 'missing-target' };
        interpretation.clarification = null;
      }),
      corruptScenario('F2A1-B008-concept', (interpretation) => {
        interpretation.intent = 'mutation-proposal';
        interpretation.operation = 'transactions.expense.create';
        interpretation.args = { amountCents: 1000 };
      }),
    ];

    for (const corruption of corruptions) {
      const row = scenarioRow(runF2A1({ scenarios: { [corruption.id]: corruption.output } }), corruption.id);
      expect(row?.verdict, corruption.id).toBe('FAIL');
    }

    const concept = scenarioRow(runF2A1({ scenarios: F2A1_LOCAL_CANDIDATES }), 'F2A1-B008-concept');
    expect(concept?.operation).toBe('match');
    expect(concept?.intent).toBe('match');
  });

  it('keeps a partial journey inconclusive and flags omitted turns', () => {
    const oneTurn = {
      interpretation: {
        intent: 'clarify',
        operation: 'none',
        args: {},
        contextProvenance: { origin: 'f1-journey-turn', corpusId: 'J01', turnIndex: 0 },
        entities: [{ kind: 'description', value: 'carne', provenance: 'utterance' }],
        ambiguities: [],
        missingFields: ['amount'],
        clarification: 'Qual valor devo registrar?',
      },
    };
    const result = runF2A1({ journeys: { J01: [oneTurn] } });
    const journey = result.journeys.find((item) => item.comparison.corpusId === 'J01');
    expect(journey?.comparison.verdict).toBe('INCONCLUSIVE');
    expect(journey?.comparison.reasons).toContain('missing-required-turn');
    expect(journey?.turns).toHaveLength(2);
    expect(journey?.turns[1]?.verdict).toBe('INCONCLUSIVE');
    expect(journey?.comparison.financialCompletion).toBe('unobservable');
    expect(journey?.semanticVerdict).toBe('INCONCLUSIVE');
  });

  it('retains explicit extension limitations for all eight declared pairs', () => {
    const result = runF2A1({});
    expect(result.scenarios).toHaveLength(13);
    expect(result.scenarios.every((row) => row.verdict === 'INCONCLUSIVE')).toBe(true);
    expect(result.extensions).toHaveLength(8);
    expect(
      result.extensions.every(
        (item) => item.originalExpectation && item.limitation && item.comparableCriterion && item.justification,
      ),
    ).toBe(true);
    expect(result.extensions.find((item) => item.id === 'B015-colloquial')?.originalExpectation).toContain(
      'clarification',
    );
  });

  it('propagates each semantic turn verdict into the global aggregate', () => {
    const badTurn = clone(F2A1_LOCAL_JOURNEYS.J09 as readonly unknown[]) as {
      interpretation: Record<string, unknown>;
    }[];
    badTurn[1]!.interpretation = {
      ...badTurn[1]!.interpretation,
      args: { yearMonth: '2026-10' },
      entities: [{ kind: 'period', value: '2026-10', provenance: 'utterance' }],
    };
    const result = runF2A1({ journeys: { ...F2A1_LOCAL_JOURNEYS, J09: badTurn } });
    expect(result.journeys.find((item) => item.comparison.corpusId === 'J09')?.semanticVerdict).toBe('FAIL');
    expect(result.verdict).toBe('FAIL');
  });

  it('reports actual supplied context on every row and never invents one', () => {
    const result = runF2A1({ scenarios: F2A1_LOCAL_CANDIDATES, journeys: F2A1_LOCAL_JOURNEYS });
    for (const row of result.scenarios) {
      expect(row.inputContext, row.corpusId).not.toBeNull();
      expect(row.inputContext?.referenceDate, row.corpusId).toBe('2026-10-24');
      expect(row.inputContext?.currentText, row.corpusId).toBe(F2A1_INPUTS[row.corpusId]?.currentText);
    }
    for (const journey of result.journeys) {
      for (const turn of journey.turns) {
        expect(turn.inputContext, turn.corpusId).not.toBeNull();
      }
    }
  });
});
