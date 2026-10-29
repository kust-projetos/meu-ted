import { describe, expect, it } from 'vitest';
import { parseStructuredLLMOutput } from '../../src/poc-structured/structured-interpretation.js';
import { F2B0_CASE_IDS, F2B0_PROMPT, evaluateF2B0Attempts, getF2B0Cases } from './f2b0-adapter.js';
import { F2A1_LOCAL_CANDIDATES, F2A1_LOCAL_JOURNEYS } from './f2a1-candidates.js';

const valid = {
  interpretation: {
    intent: 'conversation', operation: 'none', args: {},
    contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B008-concept' },
    entities: [], ambiguities: [], missingFields: [], clarification: null,
  },
};

describe('F2B0 pure adapter', () => {
  it('explicitly requires the parser envelope rather than a bare interpretation', () => {
    expect(F2B0_PROMPT).toContain('The top-level object must have exactly one key: "interpretation".');
    expect(F2B0_PROMPT).toContain('allowedResponseKeys and requiredResponseKeys apply inside interpretation, not at the top level.');
    expect(() => parseStructuredLLMOutput(valid.interpretation)).toThrow();
    expect(parseStructuredLLMOutput(valid).intent).toBe('conversation');
  });
  it('exposes the 13 manifest scenarios and 10 journey turns with shared contract text', () => {
    const cases = getF2B0Cases();
    expect(F2B0_CASE_IDS).toHaveLength(23);
    expect(cases).toHaveLength(23);
    expect(new Set(cases.map((item) => item.prompt.split('\nManifest case ID:')[0])).size).toBe(1);
    expect(cases.every((item) => item.prompt.includes(`Manifest case ID: ${item.id}`))).toBe(true);
    expect(cases.find((item) => item.id === 'J01:T2')?.prompt).toContain('Synthetic input ID (corpusId): J01');
    expect(cases.find((item) => item.id === 'J01:T2')?.prompt).toContain('"turnIndex":1');
    expect(F2B0_PROMPT).not.toContain('expectedArgs');
    expect(F2B0_PROMPT).not.toContain('oracle');
    expect(F2B0_PROMPT).not.toContain('candidate');
    expect(F2B0_PROMPT).toContain('budgets.create');
    expect(F2B0_PROMPT).toContain('"clarification"');
    expect(cases.find((item) => item.id === 'J01:T2')?.input).toMatchObject({ currentText: '2500', history: expect.any(Array) });
  });

  it('accepts only the closed parser contract; does not repair JSON or strip fences', () => {
    expect(parseStructuredLLMOutput(JSON.stringify(valid)).intent).toBe('conversation');
    expect(() => parseStructuredLLMOutput('```json\n' + JSON.stringify(valid) + '\n```')).toThrow();
    expect(() => parseStructuredLLMOutput('{"interpretation":{},"extra":true}')).toThrow();
    expect(() => parseStructuredLLMOutput({ ...valid, tool_call: {} })).toThrow();
  });

  it('records malformed JSON and schema failures per case without aborting the batch', () => {
    const result = evaluateF2B0Attempts([{ id: 'F2A1-B008-concept', raw: JSON.stringify(valid) }]);
    expect(result.results['F2A1-B008-concept']).toMatchObject({ jsonValid: true, schemaValid: true, raw: JSON.stringify(valid) });
    expect(result.evaluation.scenarios.find((row) => row.corpusId === 'F2A1-B008-concept')?.verdict).toBe('PASS');
    const bad = evaluateF2B0Attempts([
      { id: 'F1-B005', raw: '{bad' },
      { id: 'F1-B010', raw: JSON.stringify({ interpretation: {} }) },
    ]);
    expect(bad.results['F1-B005']).toMatchObject({ jsonValid: false, schemaValid: false, sanitizedReason: 'invalid-json', raw: '{bad' });
    expect(bad.results['F1-B010']).toMatchObject({ jsonValid: true, schemaValid: false, sanitizedReason: expect.any(String) });
    expect(bad.evaluation.scenarios.find((row) => row.corpusId === 'F1-B005')?.verdict).toBe('FAIL');
    expect(bad.evaluation.scenarios.find((row) => row.corpusId === 'F1-B010')?.verdict).toBe('FAIL');
  });

  it('keeps null, empty JSON string, whitespace and fenced output as explicit failures', () => {
    const raws = ['null', '""', '   ', `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``];
    const ids = ['F1-B005', 'F1-B010', 'F1-B012', 'F1-B017'];
    const result = evaluateF2B0Attempts(ids.map((id, index) => ({ id, raw: raws[index]! })));
    for (const id of ids) {
      expect(result.results[id]?.schemaValid).toBe(false);
      expect(result.evaluation.scenarios.find((row) => row.corpusId === id)?.verdict).toBe('FAIL');
    }
  });

  it('evaluates all 23 hand-authored local fixtures without claiming model evidence', () => {
    const attempts = [
      ...Object.entries(F2A1_LOCAL_CANDIDATES).map(([id, output]) => ({ id, raw: JSON.stringify(output) })),
      ...Object.entries(F2A1_LOCAL_JOURNEYS).flatMap(([journey, turns]) => turns.map((output, index) => ({
        id: `${journey}:T${index + 1}`,
        raw: JSON.stringify(output),
      }))),
    ];
    const result = evaluateF2B0Attempts(attempts, { requireComplete: true });
    expect(attempts).toHaveLength(23);
    expect(result.complete).toBe(true);
    expect(result.attempted).toBe(23);
    expect(Object.values(result.results).every((row) => row.schemaValid)).toBe(true);
  });

  it('rejects duplicate IDs before parsing and reports missing IDs as incomplete', () => {
    expect(() => evaluateF2B0Attempts([
      { id: 'F1-B005', raw: 'not JSON' }, { id: 'F1-B005', raw: '{}' },
    ])).toThrow('duplicate case ID');
    expect(() => evaluateF2B0Attempts([{ id: 'unknown', raw: 'not JSON' }])).toThrow('unknown case ID');
    const partialPayload = {
      interpretation: {
        ...valid.interpretation, intent: 'read', operation: 'list_payables',
        contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B005' },
      },
    };
    const partial = evaluateF2B0Attempts([{ id: 'F1-B005', raw: JSON.stringify(partialPayload) }]);
    expect(partial.complete).toBe(false);
    expect(partial.missingIds).toHaveLength(22);
    expect(partial.evaluation.scenarios.find((row) => row.corpusId === 'F1-B005')?.verdict).toBe('PASS');
    expect(partial.evaluation.scenarios.find((row) => row.corpusId === 'F1-B010')?.verdict).toBe('INCONCLUSIVE');
    expect(() => evaluateF2B0Attempts([{ id: 'F1-B005', raw: '{}' }], { requireComplete: true })).toThrow('incomplete case batch');
  });

  it('describes parser-exact shapes for origin/entities/requestedAction', () => {
    expect(F2B0_PROMPT).toContain('"origin":"string');
    expect(F2B0_PROMPT).toContain('"entities":{"type":"array"');
    expect(F2B0_PROMPT).toContain('"requestedAction":{"type":"string","optional":true');
    const base = {
      interpretation: {
        intent: 'conversation', operation: 'none', args: {},
        contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B008-concept' },
        entities: [{ kind: 'account', value: 'Aurora', provenance: 'utterance' }],
        ambiguities: [], missingFields: [], clarification: null,
        requestedAction: 'budgets.create',
      },
    };
    expect(parseStructuredLLMOutput(base).requestedAction).toBe('budgets.create');
    expect(() => parseStructuredLLMOutput({
      interpretation: { ...base.interpretation, contextProvenance: { origin: ['f1-corpus-text'], corpusId: 'F2A1-B008-concept' } },
    })).toThrow();
    expect(() => parseStructuredLLMOutput({
      interpretation: { ...base.interpretation, entities: { item: { kind: 'account', value: 'Aurora', provenance: 'utterance' } } },
    })).toThrow();
    expect(() => parseStructuredLLMOutput({
      interpretation: { ...base.interpretation, requestedAction: { allowed: ['budgets.create'] } },
    })).toThrow();
  });

  it('aligns intent/operation descriptor with parser string enums and pairing', () => {
    expect(F2B0_PROMPT).toContain('"intent":{"type":"string"');
    expect(F2B0_PROMPT).toContain('"operation":{"type":"string"');
    const base = () => ({
      interpretation: {
        intent: 'read', operation: 'list_payables', args: {},
        contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B005' },
        entities: [], ambiguities: [], missingFields: [], clarification: null,
      },
    });
    expect(parseStructuredLLMOutput(base()).operation).toBe('list_payables');
    expect(() => parseStructuredLLMOutput({ interpretation: { ...base().interpretation, intent: ['read'] } })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...base().interpretation, intent: 'frobnicate' } })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...base().interpretation, operation: ['list_payables'] } })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...base().interpretation, operation: 'droptable' } })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...base().interpretation, intent: 'clarify', operation: 'list_payables' } })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...base().interpretation, intent: 'conversation', operation: 'list_payables' } })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...base().interpretation, intent: 'read', operation: 'none' } })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...base().interpretation, intent: 'mutation-proposal', operation: 'list_payables' } })).toThrow();
  });

  it('aligns args descriptor with parser object, allowlist, value shapes and formats', () => {
    expect(F2B0_PROMPT).toContain('"args":{"type":"object","maxKeys":12');
    const base = (args: unknown) => ({
      interpretation: {
        intent: 'mutation-proposal', operation: 'transactions.expense.create', args,
        contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B008-concept' },
        entities: [], ambiguities: [], missingFields: [], clarification: null,
      },
    });
    expect(parseStructuredLLMOutput(base({ amountCents: 100, description: 'cafe', date: '2026-10-01' })).operation).toBe('transactions.expense.create');
    expect(parseStructuredLLMOutput(base({ amountCents: 100, description: null, date: '2026-10-01' })).args).toMatchObject({ description: null });
    expect(() => parseStructuredLLMOutput(base(['amountCents']))).toThrow();
    expect(() => parseStructuredLLMOutput({
      interpretation: { ...base({}).interpretation, intent: 'conversation', operation: 'none', args: { description: 'x' } },
    })).toThrow();
    expect(() => parseStructuredLLMOutput(base({ nope: 'x' }))).toThrow();
    expect(() => parseStructuredLLMOutput({
      interpretation: { ...base({}).interpretation, intent: 'read', operation: 'list_payables', args: { description: 'x' } },
    })).toThrow();
    expect(() => parseStructuredLLMOutput(base({ amountCents: -1, description: 'cafe', date: '2026-10-01' }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ amountCents: 1.5, description: 'cafe', date: '2026-10-01' }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ amountCents: 100, description: '', date: '2026-10-01' }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ amountCents: 100, description: 'x'.repeat(201), date: '2026-10-01' }))).toThrow();
    expect(() => parseStructuredLLMOutput({
      interpretation: { ...base({}).interpretation, intent: 'read', operation: 'list_payables', args: { yearMonth: '2026-13' } },
    })).toThrow();
    expect(() => parseStructuredLLMOutput(base({ amountCents: 100, description: 'cafe', date: '2026-02-30' }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({
      amountCents: 1, description: null, date: null, categoryQuery: null, accountId: null, categoryId: null,
      accountName: null, accountKind: null, initialBalanceCents: null, categoryName: null, categoryKind: null,
      parentCategoryId: null, expectedName: null,
    }))).toThrow();
  });

  it('aligns contextProvenance descriptor with parser closed keys, id pattern and turnIndex', () => {
    expect(F2B0_PROMPT).toContain('"closedKeys":["origin","corpusId","turnIndex"]');
    expect(F2B0_PROMPT).toContain('LOCAL-');
    expect(F2B0_PROMPT).toContain('non-negative integer');
    const base = (contextProvenance: unknown) => ({
      interpretation: {
        intent: 'conversation', operation: 'none', args: {}, contextProvenance,
        entities: [], ambiguities: [], missingFields: [], clarification: null,
      },
    });
    expect(parseStructuredLLMOutput(base({ origin: 'f1-journey-turn', corpusId: 'J01', turnIndex: 1 })).contextProvenance).toMatchObject({ turnIndex: 1 });
    expect(() => parseStructuredLLMOutput(base({ origin: 'f1-corpus-text', corpusId: 'F1-B005', extra: 1 }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ origin: 'f1-corpus-text', corpusId: 'NOPE' }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ origin: 'f1-corpus-text', corpusId: 'F1-B005', turnIndex: -1 }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ origin: 'f1-corpus-text', corpusId: 'F1-B005', turnIndex: 1.5 }))).toThrow();
  });

  it('aligns entities descriptor with parser array, closed item keys and limits', () => {
    expect(F2B0_PROMPT).toContain('"closedItemKeys":["kind","value","provenance"]');
    const base = (entities: unknown) => ({
      interpretation: {
        intent: 'conversation', operation: 'none', args: {},
        contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B008-concept' },
        entities, ambiguities: [], missingFields: [], clarification: null,
      },
    });
    const item = { kind: 'account', value: 'Aurora', provenance: 'utterance' };
    expect(parseStructuredLLMOutput(base([item])).entities).toHaveLength(1);
    expect(() => parseStructuredLLMOutput(base(Array.from({ length: 9 }, () => item)))).toThrow();
    expect(() => parseStructuredLLMOutput(base([{ ...item, kind: 'planet' }]))).toThrow();
    expect(() => parseStructuredLLMOutput(base([{ ...item, value: '' }]))).toThrow();
    expect(() => parseStructuredLLMOutput(base([{ ...item, value: 'x'.repeat(201) }]))).toThrow();
    expect(() => parseStructuredLLMOutput(base([{ ...item, provenance: 'telepathy' }]))).toThrow();
    expect(() => parseStructuredLLMOutput(base([{ ...item, extra: 1 }]))).toThrow();
    expect(() => parseStructuredLLMOutput(base(['not-a-record']))).toThrow();
  });

  it('aligns ambiguities/missingFields/clarification descriptor with parser limits and no linkage', () => {
    const base = (patch: Record<string, unknown>) => ({
      interpretation: {
        intent: 'conversation', operation: 'none', args: {},
        contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B008-concept' },
        entities: [], ambiguities: [], missingFields: [], clarification: null, ...patch,
      },
    });
    expect(parseStructuredLLMOutput(base({ clarification: 'Which month?', ambiguities: [] })).clarification).toBe('Which month?');
    expect(parseStructuredLLMOutput(base({ clarification: null, ambiguities: ['a', 'b'] })).ambiguities).toHaveLength(2);
    expect(() => parseStructuredLLMOutput(base({ ambiguities: 'x' }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ ambiguities: Array.from({ length: 9 }, () => 'a') }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ ambiguities: [''] }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ ambiguities: ['x'.repeat(201)] }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ missingFields: 'amount' }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ missingFields: ['nope'] }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ missingFields: Array.from({ length: 9 }, () => 'amount') }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ clarification: 123 }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ clarification: '' }))).toThrow();
    expect(() => parseStructuredLLMOutput(base({ clarification: 'y'.repeat(501) }))).toThrow();
  });

  it('does not cap corpusId at 200 chars and keeps turnIndex independent of origin', () => {
    const longId = `F2A1-${'A'.repeat(300)}`;
    expect(longId.length).toBeGreaterThan(200);
    const base = (contextProvenance: unknown) => ({
      interpretation: {
        intent: 'conversation', operation: 'none', args: {}, contextProvenance,
        entities: [], ambiguities: [], missingFields: [], clarification: null,
      },
    });
    expect(parseStructuredLLMOutput(base({ origin: 'f1-corpus-text', corpusId: longId })).contextProvenance.corpusId).toBe(longId);
    expect(parseStructuredLLMOutput(base({ origin: 'local-fixture', corpusId: 'LOCAL-ABC', turnIndex: 0 })).contextProvenance).toMatchObject({ turnIndex: 0 });
    expect(parseStructuredLLMOutput(base({ origin: 'f1-journey-turn', corpusId: 'J01' })).contextProvenance).toMatchObject({ origin: 'f1-journey-turn' });
    expect(F2B0_PROMPT).toContain('"turnIndex":"optional non-negative integer"');
    expect(F2B0_PROMPT).not.toContain('omit unless journey');
  });

  it('bounds descriptor without a global string cap, preserving per-field bounds', () => {
    expect(F2B0_PROMPT).not.toContain('strings <=');
    expect(F2B0_PROMPT).toContain('ambiguity texts <=');
    expect(F2B0_PROMPT).toContain('clarification <=');
    expect(F2B0_PROMPT).toContain('at any depth are rejected');
  });

  it('aligns envelope/bounds/authority descriptor with parser rejections (sampled)', () => {    expect(F2B0_PROMPT).toContain('at any depth are rejected');
    const payload = {
      intent: 'conversation', operation: 'none', args: {},
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F2A1-B008-concept' },
      entities: [], ambiguities: [], missingFields: [], clarification: null,
    };
    expect(() => parseStructuredLLMOutput({ interpretation: { ...payload, mystery: 1 } })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...payload, approval: true } })).toThrow();
    expect(() => parseStructuredLLMOutput({
      interpretation: { ...payload, entities: [{ kind: 'account', value: 'Aurora', provenance: 'utterance', approval: true }] },
    })).toThrow();
    expect(() => parseStructuredLLMOutput({ interpretation: { ...payload, clarification: 'z'.repeat(9000) } })).toThrow();
  });
});
