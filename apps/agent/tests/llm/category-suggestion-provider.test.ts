import { describe, expect, it } from 'vitest';
import { categorySuggestionEnabled, categorySuggestionPrompt, parseCategorySuggestion } from '../../src/llm/category-suggestion.js';

const ID = '00000000-0000-4000-8000-000000000011';
const rows = [
  { id: ID, name: 'Alimentação', kind: 'expense' },
  { id: '00000000-0000-4000-8000-000000000012', name: 'Salário', kind: 'income' },
];

describe('category suggestion provider helpers', () => {
  it('prompts with only categories matching the transaction kind', () => {
    const { prompt, allowedIds } = categorySuggestionPrompt(
      { kind: 'expense', description: 'padaria', amountCents: 1000, date: '2026-01-01' },
      rows,
    );
    expect(prompt).toContain('Alimentação');
    expect(prompt).not.toContain('Salário');
    expect(allowedIds).toEqual(new Set([ID]));
    expect(categorySuggestionPrompt({ kind: 'expense', description: 'padaria', amountCents: 1000, date: '2026-01-01' }, rows).prompt)
      .not.toContain('newCategory');
    expect(categorySuggestionPrompt({ kind: 'expense', description: 'padaria', amountCents: 1000, date: '2026-01-01' }, rows, true).prompt)
      .toContain('newCategory');
  });
  it('accepts a strictly shaped, normalized new category name and rejects ambiguity/unsafe names', () => {
    expect(parseCategorySuggestion('{"newCategory":{"name":"  Café  "}}', new Set([ID])))
      .toEqual({ newCategory: { name: 'Café' } });
    for (const text of [
      '{"newCategory":{"name":"x","kind":"expense"}}',
      '{"newCategory":{"name":"\\n"}}',
      '{"newCategory":{"name":"x\\u200d"}}',
      `{"newCategory":{"name":"${'x'.repeat(61)}"}}`,
      '{"newCategory":{"name":42}}',
      '{"categoryId":"' + ID + '","newCategory":{"name":"x"}}',
    ]) expect(parseCategorySuggestion(text, new Set([ID]))).toBeNull();
  });
  it('rejects ids outside the allowed catalog', () => {
    expect(parseCategorySuggestion('{"categoryId":"00000000-0000-4000-8000-000000000099"}', new Set([ID]))).toBeNull();
  });
  it('accepts one fenced JSON document but rejects surrounding prose', () => {
    expect(parseCategorySuggestion('```json\n{"categoryId":"' + ID + '"}\n```', new Set([ID]))).toEqual({ categoryId: ID });
    expect(parseCategorySuggestion('Here is the result:\n```json\n{"categoryId":"' + ID + '"}\n```', new Set([ID]))).toBeNull();
  });
  it.each(['not json', '{"categoryId":null}', '{"categoryId":"' + ID + '"} extra'])('fails closed for invalid JSON: %s', (text) => {
    expect(parseCategorySuggestion(text, new Set([ID]))).toBeNull();
  });
  it('requires the exact opt-in flag', () => {
    expect(categorySuggestionEnabled(undefined)).toBe(false);
    expect(categorySuggestionEnabled(null)).toBe(false);
    expect(categorySuggestionEnabled({})).toBe(false);
    expect(categorySuggestionEnabled({ TED_CATEGORY_SUGGESTION_ENABLED: 'true' })).toBe(false);
    expect(categorySuggestionEnabled({ TED_CATEGORY_SUGGESTION_ENABLED: ' 1 ' })).toBe(false);
    expect(categorySuggestionEnabled({ TED_CATEGORY_SUGGESTION_ENABLED: '1' })).toBe(true);
  });
});
