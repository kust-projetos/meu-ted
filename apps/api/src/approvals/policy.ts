/** API-authoritative risk policy (ADR-026): deterministic code decides; the LLM never grants authorization. */
export const DEFAULT_HIGH_VALUE_LIMIT_CENTS = 50_000;

export type MutationRiskTier = 'low' | 'medium' | 'high' | 'destructive';
export type MutationAuthorizationAction = 'auto_execute' | 'clarify' | 'require_confirmation';
export type MutationAuthorizationReason =
  | 'explicit_low_risk' | 'missing_fields' | 'ambiguous_entity' | 'possible_duplicate'
  | 'intent_not_explicit' | 'high_value' | 'destructive' | 'policy_required';
export const AUTOEXECUTION_ELIGIBLE_TOOLS: ReadonlySet<string> = new Set([
  'transactions.expense.create',
  'transactions.income.create',
]);

export type MutationAuthorizationCandidate = {
  tool: string;
  amountCents?: number;
  workspaceId?: string;
  destructive?: boolean;
  complete?: boolean;
  ambiguousEntity?: boolean;
  duplicateSuspected?: boolean;
  explicitIntent?: boolean;
};
export type MutationAuthorizationDecision =
  | { action: 'auto_execute'; risk: 'low'; reason: 'explicit_low_risk' }
  | { action: 'clarify'; risk: 'medium'; reason: 'missing_fields' | 'ambiguous_entity' | 'intent_not_explicit' | 'possible_duplicate' }
  | { action: 'require_confirmation'; risk: 'medium'; reason: 'possible_duplicate' | 'policy_required' }
  | { action: 'require_confirmation'; risk: 'high'; reason: 'high_value' }
  | { action: 'require_confirmation'; risk: 'destructive'; reason: 'destructive' };

export type ApprovalCandidate = {
  operation: string;
  workspaceId?: string;
  amountCents?: number;
  destructive: boolean;
};

export type ApprovalDecision =
  | { requiresApproval: false }
  | { requiresApproval: true; reason: 'high_value' | 'destructive' };

export type ApprovalPolicy = {
  evaluate(candidate: ApprovalCandidate): ApprovalDecision;
  evaluateMutation(candidate: MutationAuthorizationCandidate): MutationAuthorizationDecision;
};

export const createApprovalPolicy = (config?: { highValueLimitCents?: number; limitsByWorkspace?: Record<string, number> }): ApprovalPolicy => {
  const highValueLimitCents = config?.highValueLimitCents ?? DEFAULT_HIGH_VALUE_LIMIT_CENTS;
  const limitsByWorkspace = config?.limitsByWorkspace ?? {};
  if (!Number.isSafeInteger(highValueLimitCents) || highValueLimitCents < 1) {
    throw new Error('highValueLimitCents must be a positive safe integer');
  }

  return {
    evaluate(candidate) {
      if (candidate.destructive) return { requiresApproval: true, reason: 'destructive' };
      const limit = candidate.workspaceId ? limitsByWorkspace[candidate.workspaceId] ?? highValueLimitCents : highValueLimitCents;
      if ((candidate.amountCents ?? 0) >= limit) return { requiresApproval: true, reason: 'high_value' };
      return { requiresApproval: false };
    },
    evaluateMutation(candidate) {
      // First match wins; preserve this order so incomplete data is clarified before contextual risks.
      if (!AUTOEXECUTION_ELIGIBLE_TOOLS.has(candidate.tool)) return { action: 'require_confirmation', risk: 'medium', reason: 'policy_required' };
      if (candidate.destructive) return { action: 'require_confirmation', risk: 'destructive', reason: 'destructive' };
      if (candidate.complete !== true) return { action: 'clarify', risk: 'medium', reason: 'missing_fields' };
      if (candidate.ambiguousEntity) return { action: 'clarify', risk: 'medium', reason: 'ambiguous_entity' };
      if (candidate.duplicateSuspected) return { action: 'require_confirmation', risk: 'medium', reason: 'possible_duplicate' };
      if (candidate.explicitIntent !== true) return { action: 'clarify', risk: 'medium', reason: 'intent_not_explicit' };
      const limit = candidate.workspaceId ? limitsByWorkspace[candidate.workspaceId] ?? highValueLimitCents : highValueLimitCents;
      if ((candidate.amountCents ?? 0) >= limit) return { action: 'require_confirmation', risk: 'high', reason: 'high_value' };
      if (Number.isSafeInteger(candidate.amountCents) && candidate.amountCents! >= 1) return { action: 'auto_execute', risk: 'low', reason: 'explicit_low_risk' };
      return { action: 'require_confirmation', risk: 'medium', reason: 'policy_required' };
    },
  };
};
