import { describe, expect, it } from 'vitest';
import { classifyFastPath, routeIntent } from '../../src/orchestration/intent-router.js';

describe('T3.2 deterministic fast paths', () => {
  it.each([
    ['Qual meu saldo?', 'balance'],
    ['Mostre os últimos lançamentos', 'recent_transactions'],
    ['confirmar', 'confirm'],
    ['pode cancelar', 'cancel'],
  ])('%s avoids planner', (text, kind) => {
    const result = classifyFastPath(text);
    expect(result.kind).toBe(kind);
    expect(result.plannerRequired).toBe(false);
  });

  it('routes confirmation and cancellation as deterministic modes', () => {
    expect(routeIntent('confirmar').mode).toBe('confirmation');
    expect(routeIntent('pode cancelar').mode).toBe('cancel');
  });

  it('enforces stage and turn budgets with fail-closed decisions', () => {
    const result = classifyFastPath('qual meu saldo?', { stageCalls: 2, turnCalls: 2 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('call_budget_exceeded');
  });

  it('never treats cached balance as current authority', () => {
    const result = classifyFastPath('qual meu saldo?', { cacheHit: true });
    expect(result.cacheAuthoritative).toBe(false);
    expect(result.requiresFreshApi).toBe(true);
  });
});

// A06/R06: informal mutation language must not be captured by the deterministic
// confirm/cancel/balance fast paths — those stay reserved for their own commands.
describe('T3.2 fast paths keep their boundary over informal input (A06/R06)', () => {
  it.each([
    'gstei 50 d carne hj no nubnk',
    'gastei uns 80 no mercado',
    'nao gastei 50 no mercado',
    'GSTEI50 DE CARNE',
  ])('does not treat %s as a fast path', (text) => {
    const result = classifyFastPath(text);
    expect(result.kind).toBe('none');
    expect(result.plannerRequired).toBe(true);
    expect(result.apiCallBudget).toBe(0);
  });

  it('routes the informal mutation to a proposal plan, never to confirmation or cancel', () => {
    const plan = routeIntent('gstei 50 d carne hj no nubnk');
    expect(plan.mode).toBe('mutation-proposal');
    expect(plan.requestedOperations.map((operation) => operation.name)).toEqual(['transactions.expense.create']);
  });

  it('leaves the confirmation and cancellation commands untouched', () => {
    expect(routeIntent('confirmar').mode).toBe('confirmation');
    expect(routeIntent('pode cancelar').mode).toBe('cancel');
  });
});
