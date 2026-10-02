import { describe, expect, it } from 'vitest';
import { AUTOEXECUTION_ELIGIBLE_TOOLS, createApprovalPolicy } from '../../src/approvals/policy.js';

describe('risk-based mutation authorization policy', () => {
  const policy = createApprovalPolicy();
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    tool: 'transactions.expense.create', amountCents: 3499, complete: true, explicitIntent: true, ...overrides,
  });
  const decision = (input: Record<string, unknown>) => policy.evaluateMutation(input as never);

  it('limits auto-execution eligibility to the two create tools', () => {
    expect([...AUTOEXECUTION_ELIGIBLE_TOOLS].sort()).toEqual([
      'transactions.expense.create', 'transactions.income.create',
    ]);
  });
  it.each([
    ['expense low', candidate(), { action: 'auto_execute', risk: 'low', reason: 'explicit_low_risk' }],
    ['expense below threshold', candidate({ amountCents: 49_999 }), { action: 'auto_execute', risk: 'low', reason: 'explicit_low_risk' }],
    ['expense threshold', candidate({ amountCents: 50_000 }), { action: 'require_confirmation', risk: 'high', reason: 'high_value' }],
    ['expense high', candidate({ amountCents: 200_000 }), { action: 'require_confirmation', risk: 'high', reason: 'high_value' }],
    ['income below threshold', candidate({ tool: 'transactions.income.create', amountCents: 49_999 }), { action: 'auto_execute', risk: 'low', reason: 'explicit_low_risk' }],
    ['income threshold', candidate({ tool: 'transactions.income.create', amountCents: 50_000 }), { action: 'require_confirmation', risk: 'high', reason: 'high_value' }],
    ['destructive', candidate({ destructive: true }), { action: 'require_confirmation', risk: 'destructive', reason: 'destructive' }],
    ['outside allowlist', candidate({ tool: 'transactions.delete' }), { action: 'require_confirmation', risk: 'medium', reason: 'policy_required' }],
    ['duplicate', candidate({ duplicateSuspected: true }), { action: 'require_confirmation', risk: 'medium', reason: 'possible_duplicate' }],
    // Missing required fields precede duplicate evaluation by policy order.
    ['missing fields precede duplicate', candidate({ complete: false, duplicateSuspected: true }), { action: 'clarify', risk: 'medium', reason: 'missing_fields' }],
    ['missing account', candidate({ complete: false }), { action: 'clarify', risk: 'medium', reason: 'missing_fields' }],
    ['ambiguous entity', candidate({ ambiguousEntity: true }), { action: 'clarify', risk: 'medium', reason: 'ambiguous_entity' }],
    ['implicit intent', candidate({ explicitIntent: false }), { action: 'clarify', risk: 'medium', reason: 'intent_not_explicit' }],
    ['missing amount', candidate({ amountCents: undefined }), { action: 'require_confirmation', risk: 'medium', reason: 'policy_required' }],
  ])('%s', (_label, input, expected) => expect(decision(input as Record<string, unknown>)).toEqual(expected));

  it('uses the workspace threshold inclusively', () => {
    const scoped = createApprovalPolicy({ limitsByWorkspace: { w1: 1000 } });
    expect(scoped.evaluateMutation(candidate({ workspaceId: 'w1', amountCents: 1000 }))).toEqual({ action: 'require_confirmation', risk: 'high', reason: 'high_value' });
    expect(scoped.evaluateMutation(candidate({ workspaceId: 'w1', amountCents: 999 }))).toEqual({ action: 'auto_execute', risk: 'low', reason: 'explicit_low_risk' });
  });
});
