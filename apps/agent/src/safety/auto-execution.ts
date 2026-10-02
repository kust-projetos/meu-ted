import { hasExplicitMutationIntent } from './tool-approvals.js';

export const AUTOEXECUTION_ELIGIBLE_TOOLS = [
  'transactions.expense.create',
  'transactions.income.create',
] as const;

export const isAutoExecutionEligible = (input: {
  tool: string;
  missingFields: readonly string[];
  ambiguity: string | null;
  latestActorText: string;
}): boolean =>
  AUTOEXECUTION_ELIGIBLE_TOOLS.includes(input.tool as (typeof AUTOEXECUTION_ELIGIBLE_TOOLS)[number]) &&
  input.missingFields.length === 0 &&
  input.ambiguity === null &&
  hasExplicitMutationIntent(input.latestActorText);
