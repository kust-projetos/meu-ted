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
});
