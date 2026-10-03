import { describe, expect, it } from 'vitest';
import { routeIntent } from '../../src/orchestration/intent-router.js';
import { hasExplicitMutationIntent } from '../../src/safety/tool-approvals.js';

describe('T2.2 intent router', () => {
  it('routes Brazilian Portuguese negation without turning it into a mutation', () => {
    const plan = routeIntent('não registre uma despesa de 20 reais');
    expect(plan.mode).toBe('cancel');
    expect(plan.requestedOperations).toEqual([]);
  });

  it('tolerates common Portuguese typos', () => {
    const plan = routeIntent('me mostre meu sald');
    expect(plan.mode).toBe('read');
    expect(plan.domain).toBe('accounts');
    expect(plan.requestedOperations[0]?.name).toBe('get_balance');
  });

  it('keeps a compound utterance bounded to four operations and eight tools', () => {
    const plan = routeIntent('mostre meu saldo e minhas contas e meu extrato e minhas faturas');
    expect(plan.mode).toBe('read');
    expect(plan.requestedOperations.length).toBeLessThanOrEqual(4);
    expect(plan.requestedTools?.length ?? 0).toBeLessThanOrEqual(8);
  });
});

// A06 / SPEC R06: an informal mutation routes like its canonical form, an
// ambiguous one plans nothing, and neither becomes a mutation imperative.
describe('T2.2 intent router — A06/R06 bounded semantic interpretation', () => {
  it('routes the clipped utterance exactly like its canonical form', () => {
    const informal = routeIntent('gstei 50 d carne hj no nubnk');
    const canonical = routeIntent('Gastei R$ 50 de carne no mercado');
    expect(informal.mode).toBe('mutation-proposal');
    expect(informal.domain).toBe(canonical.domain);
    expect(informal.requestedOperations).toEqual(canonical.requestedOperations);
    expect(informal.missingFields).toEqual(canonical.missingFields);
  });

  it.each([
    ['approximate value', 'gastei uns 80 no mercado'],
    ['unsupported currency', 'gastei 50 dolares no mercado'],
    ['ambiguous separator', 'gastei 1,500 no mercado'],
    ['contradictory dates', 'gastei 50 no mercado ontem e anteontem'],
  ])('plans no mutation operation for %s', (_label, text) => {
    const plan = routeIntent(text);
    expect(plan.requestedOperations.some((operation) => operation.kind === 'mutation')).toBe(false);
    expect(plan.mode).not.toBe('mutation-proposal');
  });

  it('infers no authorization from the informal utterance (V5 eligibility untouched)', () => {
    expect(hasExplicitMutationIntent('gstei 50 d carne hj no nubnk')).toBe(false);
    expect(hasExplicitMutationIntent('Gastei R$ 50 de carne no mercado')).toBe(false);
  });
});
