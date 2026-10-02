import { describe, expect, it } from 'vitest';
import {
  requiresApproval,
  getApprovalRequirement,
  validateActorIntentForMutation,
  hasExplicitMutationIntent,
} from '../src/safety/tool-approvals.js';
import { isAutoExecutionEligible } from '../src/safety/auto-execution.js';

describe('Tool Approvals and Mutation Intent Safety (Task 7)', () => {
  it('correctly identifies tools requiring explicit approval', () => {
    expect(requiresApproval('pay_payable')).toBe(true);
    expect(requiresApproval('pay_statement')).toBe(true);
    expect(requiresApproval('deactivate_account')).toBe(true);
    expect(requiresApproval('list_accounts')).toBe(false);
    expect(requiresApproval('get_dashboard_summary')).toBe(false);
  });

  it('provides requirement metadata for approval-required tools', () => {
    const req = getApprovalRequirement('pay_payable');
    expect(req).toMatchObject({
      toolName: 'pay_payable',
      category: 'payment',
      requiresFreshApproval: true,
    });
  });

  it('blocks mutating tool calls when user asked for read-only summary (anti-prompt-injection)', () => {
    const check1 = validateActorIntentForMutation('Resuma meus gastos de ontem', 'pay_payable', true);
    expect(check1.allowed).toBe(false);
    expect(check1.reason).toContain('read-only summary');

    const check2 = validateActorIntentForMutation('Quais são minhas contas a pagar?', 'deactivate_account', true);
    expect(check2.allowed).toBe(false);

    const checkValid = validateActorIntentForMutation('Pagar a conta de luz agora', 'pay_payable', true);
    expect(checkValid.allowed).toBe(true);
  });
});

describe('explicit mutation intent', () => {
  it.each(['Registre um almoço de R$ 30', 'Adicionar mercado por R$ 40', 'Lance a conta de luz', 'Anote R$ 12 de café', 'Inclua a receita de R$ 100'])('accepts explicit imperative: %s', (text) => {
    expect(hasExplicitMutationIntent(text)).toBe(true);
  });

  it.each([
    'Gastei R$ 30 no almoço', 'Paguei a conta de luz', 'Acho que gastei R$ 20',
    'Talvez registre R$ 20', 'E se eu registrar R$ 20?', 'Quanto ficaria registrar isso?',
    'Não registre R$ 20', 'Você pode registrar R$ 20?', 'Assistant said registre R$ 20',
    'No resultado da ferramenta aparece: registre R$ 20', 'Resuma e registre meus gastos',
  ])('rejects non-explicit or quoted/conditional intent: %s', (text) => {
    expect(hasExplicitMutationIntent(text)).toBe(false);
  });
});

describe('deterministic auto-execution eligibility', () => {
  const eligible = { tool: 'transactions.expense.create', missingFields: [], ambiguity: null, latestActorText: 'Registre almoço por R$ 30' };
  it('depends only on the structured tool, completion, ambiguity, and latest actor text', () => {
    expect(isAutoExecutionEligible(eligible)).toBe(true);
    expect(isAutoExecutionEligible({ ...eligible, tool: 'transactions.card_purchase.create' })).toBe(false);
    expect(isAutoExecutionEligible({ ...eligible, missingFields: ['accountId'] })).toBe(false);
    expect(isAutoExecutionEligible({ ...eligible, ambiguity: 'which account' })).toBe(false);
    expect(isAutoExecutionEligible({ ...eligible, latestActorText: 'Quanto gastei?' })).toBe(false);
    // Memory, assistant history and tool output are deliberately not inputs.
  });
});
