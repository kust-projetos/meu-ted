import { describe, expect, it } from 'vitest';
import { interpretMutationUtterance } from '../../src/mutations/semantic-interpretation.js';
import { parseFinancialMutation } from '../../src/mutations/financial-parser.js';
import { routeIntent } from '../../src/orchestration/intent-router.js';

/**
 * A06 / SPEC R06 (AC12 + AC13): interpretação semântica DELIMITADA.
 *
 * The layer normalizes informal input for the existing parser; it never
 * replaces it. Every "certainty" case below must be reproducible with the
 * untouched parser too — that is the proof the boundary holds.
 */

const NOW = new Date('2026-10-03T12:00:00Z');
const at = (options: { now?: Date; timeZone?: string } = {}) => options;

describe('A06/R06 AC12 — informal mutation utterance becomes a schema-validated candidate', () => {
  it('reads "gstei 50 d carne hj no nubnk" as 5.000 cents, description "carne", hints hoje/Nubank', () => {
    const result = interpretMutationUtterance('gstei 50 d carne hj no nubnk', at({ now: NOW }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.parsed).toMatchObject({ kind: 'expense', amountCents: 5000, description: 'carne' });
    expect(result.parsed.date).toBe('2026-10-03');
  });

  it('never turns the description into a category (A03/R03 preserved through the new layer)', () => {
    const result = interpretMutationUtterance('gstei 50 d carne hj no nubnk', at({ now: NOW }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.parsed).not.toHaveProperty('categoryQuery');
  });

  it('keeps the original message untouched and records provenance per field', () => {
    const raw = 'gstei 50 d carne hj no nubnk';
    const result = interpretMutationUtterance(raw, at({ now: NOW }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.raw).toBe(raw);
    expect(result.provenance.amountCents).toMatchObject({ source: 'token', raw: '50' });
    expect(result.provenance.date).toMatchObject({ source: 'normalized_token', raw: 'hj', normalized: 'hoje' });
    expect(result.provenance.accountHint).toMatchObject({ source: 'normalized_token', raw: 'nubnk', normalized: 'nubank' });
  });

  it('resolves the account hint through the deterministic haystack, never by selecting an id', () => {
    const result = interpretMutationUtterance('gstei 50 d carne hj no nubnk', at({ now: NOW }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    // The hint only reaches the resolver as text; no account id is invented.
    expect(result.resolutionText).toContain('nubank');
    expect(Object.keys(result)).not.toContain('accountId');
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('normalizes only what is informal and leaves a well-formed utterance byte-identical', () => {
    const wellFormed = 'Gastei R$ 12,34 no mercado ontem';
    const result = interpretMutationUtterance(wellFormed, at({ now: NOW }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.normalizedText).toBe('');
    expect(result.resolutionText).toBe(wellFormed);
    expect(result.parsed).toEqual(parseFinancialMutation(wellFormed, { now: NOW }));
  });

  it.each([
    // format: [description, utterance, expected]
    ['no space after the amount', 'GSTEI50 DE CARNE', { kind: 'expense', amountCents: 5000, description: 'CARNE' }],
    ['clipped verb + clipped preposition + no R$', 'gst 50 d merc', { kind: 'expense', amountCents: 5000, description: 'merc' }],
    ['uppercase income verb', 'RCBI 300 DE SALARIO', { kind: 'income', amountCents: 30000, description: 'SALARIO' }],
  ])('handles additional informality: %s', (_label, utterance, expected) => {
    const result = interpretMutationUtterance(utterance, at({ now: NOW }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.parsed).toMatchObject(expected);
  });

  it('reports an advisory confidence and never a per-turn authorization signal', () => {
    const result = interpretMutationUtterance('gstei 50 d carne hj no nubnk', at({ now: NOW }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(Object.keys(result)).not.toContain('autoExecute');
    expect(Object.keys(result)).not.toContain('authorized');
  });
});

describe('A06/R06 AC13 — ambiguity asks instead of fabricating certainty', () => {
  it.each([
    ['approximate amount', 'gastei uns 80 no mercado', 'approximate_amount'],
    ['approximate amount with an explicit marker', 'paguei aproximadamente 80 no mercado', 'approximate_amount'],
    ['approximate amount with a tilde', 'paguei ~80 no mercado', 'approximate_amount'],
    ['unsupported currency', 'gastei 50 dolares no mercado', 'unsupported_currency'],
    ['unsupported currency code', 'gastei 50 usd no mercado', 'unsupported_currency'],
    ['ambiguous thousands separator', 'gastei 1,500 no mercado', 'ambiguous_separator'],
    ['ambiguous decimal separator', 'gastei 1,2345 no mercado', 'ambiguous_separator'],
    ['contradictory relative dates', 'gastei 50 no mercado ontem e anteontem', 'contradictory_dates'],
    ['contradictory explicit and relative date', 'gastei 50 no mercado dia 29/09 e ontem', 'contradictory_dates'],
    ['negation', 'nao gastei 50 no mercado', 'negation'],
  ])('clarifies instead of rounding or registering: %s', (_label, utterance, ambiguity) => {
    const result = interpretMutationUtterance(utterance, at({ now: NOW }));

    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.ambiguities).toContain(ambiguity);
    expect(result.clarification.length).toBeGreaterThan(0);
    expect(result.missingFields.length).toBeGreaterThan(0);
  });

  it.each([
    ['gastei uns 80 no mercado'],
    ['gastei 50 dolares no mercado'],
    ['gastei 1,500 no mercado'],
    ['gastei 50 no mercado ontem e anteontem'],
  ])('never returns an amount for %s — no rounding, no fabricated certainty', (utterance) => {
    const result = interpretMutationUtterance(utterance, at({ now: NOW }));

    expect(result.status).not.toBe('candidate');
    expect(JSON.stringify(result)).not.toMatch(/"amountCents"/);
  });

  it('clarifies the bare AC13 example "uns 80" instead of inventing a value', () => {
    const result = interpretMutationUtterance('uns 80', at({ now: NOW }));

    expect(result.status).toBe('clarify');
    if (result.status !== 'clarify') return;
    expect(result.ambiguities).toContain('approximate_amount');
    expect(JSON.stringify(result)).not.toMatch(/"amountCents"/);
  });

  it('never plans a mutation for the bare "uns 80" — an amount is not an intent', () => {
    // The layer may describe the ambiguity; no planner may turn it into a
    // proposal, because that would invent the mutation intent itself.
    expect(routeIntent('uns 80').requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
  });

  it('keeps the legacy parser untouched: the same ambiguity still parses today', () => {
    // Proves the layer is the ONLY thing refusing to register an approximation,
    // i.e. the guard is not an accident of the parser.
    expect(parseFinancialMutation('gastei uns 80 no mercado')).toMatchObject({ kind: 'expense', amountCents: 8000 });
  });

  it('reports a word value as unsupported instead of guessing it', () => {
    // No deterministic word-value map: guessing "cinquenta" would be exactly
    // the fabricated certainty R06 forbids, so it falls back to the existing
    // missing-amount clarification instead.
    const result = interpretMutationUtterance('gastei cinquenta no mercado', at({ now: NOW }));

    expect(result).toMatchObject({ status: 'unparsed', reason: 'missing_amount' });
    expect(JSON.stringify(result)).not.toMatch(/"amountCents"/);
  });
});

describe('A06/R06 relative dates use the message instant and never an invented timezone', () => {
  it('resolves a relative date from the injected message instant', () => {
    const result = interpretMutationUtterance('gastei 50 de carne hoje', at({ now: new Date('2026-10-03T12:00:00Z') }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.parsed.date).toBe('2026-10-03');
  });

  it('honours an authorized timezone when the caller supplies one', () => {
    const instant = new Date('2026-10-03T02:00:00Z');
    const result = interpretMutationUtterance('gastei 50 de carne hoje', at({ now: instant, timeZone: 'America/Sao_Paulo' }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    // 02:00Z is still 2026-10-02 in São Paulo — the draft date follows the
    // authorized timezone, not UTC.
    expect(result.parsed.date).toBe('2026-10-02');
    expect(result.provenance.date.timeZoneSource).toBe('authorized');
    expect(result.provenance.date.timeZone).toBe('America/Sao_Paulo');
  });

  it('marks a missing timezone as defaulted instead of pretending it was authorized', () => {
    const result = interpretMutationUtterance('gastei 50 de carne hoje', at({ now: new Date('2026-10-03T02:00:00Z') }));

    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.provenance.date.timeZoneSource).toBe('default');
    expect(result.provenance.date.value).toBe(result.parsed.date);
  });

  it('does not move a resolved date across midnight when the same instant is re-interpreted', () => {
    const instant = new Date('2026-10-03T23:30:00Z');
    const first = interpretMutationUtterance('gastei 50 de carne hoje', at({ now: instant }));
    const second = interpretMutationUtterance('gastei 50 de carne hoje', at({ now: instant }));

    expect(first.status).toBe('candidate');
    expect(second.status).toBe('candidate');
    if (first.status !== 'candidate' || second.status !== 'candidate') return;
    expect(second.parsed.date).toBe(first.parsed.date);
  });
});

// Review fix (A06): the normalization must never corrupt the description. The
// legacy parser is the oracle here — a well-formed utterance keeps its exact
// result, and the clipped preposition reaches the SAME description as its
// canonical form instead of surviving as a stray `d`.
describe('A06/R06 review — normalization never corrupts the description', () => {
  it.each([
    ['isolated uppercase D in a phrase', 'Gastei 50 de vitamina D hoje'],
    ['multi-word proper noun in the description', 'Gastei 50 de Vitamina C hoje'],
    ['accented proper noun in the description', 'Gastei 50 de Açaí hoje'],
    ['description followed by an account hint', 'gastei 50 de carne hoje no nubank'],
  ])('matches the legacy parser exactly: %s', (_label, utterance) => {
    const interpretation = interpretMutationUtterance(utterance, at({ now: NOW }));
    const legacy = parseFinancialMutation(utterance, { now: NOW });

    expect(interpretation.status).toBe('candidate');
    expect(legacy.kind).not.toBe('none');
    if (interpretation.status !== 'candidate' || legacy.kind === 'none') return;
    expect(interpretation.parsed).toEqual(legacy);
  });

  it('keeps an isolated uppercase D inside a phrase (never rewrites it as a preposition)', () => {
    const interpretation = interpretMutationUtterance('Gastei 50 de vitamina D hoje', at({ now: NOW }));

    expect(interpretation.status).toBe('candidate');
    if (interpretation.status !== 'candidate') return;
    expect(interpretation.parsed.description).toBe('vitamina D');
  });

  it('reads a clipped preposition alone (verb already canonical) as "de"', () => {
    // Regression: the preposition expansion used to be discarded unless a verb,
    // an account hint or a date token had also been rewritten, which left the
    // description as "d carne".
    const interpretation = interpretMutationUtterance('gastei 50 d carne', at({ now: NOW }));
    const canonical = parseFinancialMutation('gastei 50 de carne', { now: NOW });

    expect(interpretation.status).toBe('candidate');
    expect(canonical.kind).not.toBe('none');
    if (interpretation.status !== 'candidate' || canonical.kind === 'none') return;
    expect(interpretation.parsed.description).toBe('carne');
    expect(interpretation.parsed).toEqual(canonical);
  });

  it('never hoists a date out of the description of an otherwise well-formed utterance', () => {
    // Regression (tester F3): rewriting a CANONICAL date into the canonical
    // trailing position changed the description away from the legacy result
    // with no informal input to justify it.
    const utterance = 'gastei 50 de carne hoje no nubank';
    const interpretation = interpretMutationUtterance(utterance, at({ now: NOW }));
    const legacy = parseFinancialMutation(utterance, { now: NOW });

    expect(interpretation.status).toBe('candidate');
    expect(legacy.kind).not.toBe('none');
    if (interpretation.status !== 'candidate' || legacy.kind === 'none') return;
    expect(interpretation.normalizedText).toBe('');
    expect(interpretation.parsed.description).toBe(legacy.description);
    expect(interpretation.parsed.description).toContain('carne');
  });
});

describe('A06/R06 — the layer stays inside the mutation boundary', () => {
  it.each([
    ['qual é o meu saldo?'],
    ['me mostre meu extracto'],
    ['crie uma subcategoria de alimentação'],
  ])('does not interpret a non-mutation utterance: %s', (utterance) => {
    const result = interpretMutationUtterance(utterance, at({ now: NOW }));

    expect(result.status).toBe('not-mutation');
  });

  it('delegates an unresolvable mutation amount to the existing parser reason', () => {
    const result = interpretMutationUtterance('gastei no mercado', at({ now: NOW }));

    expect(result).toMatchObject({ status: 'unparsed', reason: 'missing_amount' });
  });

  it('delegates an unsupported multi-verb utterance to the existing parser reason', () => {
    const result = interpretMutationUtterance('gastei 10 no mercado e recebi 20', at({ now: NOW }));

    expect(result).toMatchObject({ status: 'unparsed', reason: 'unsupported' });
  });
});