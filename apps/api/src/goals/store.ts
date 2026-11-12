import type { Goal, GoalContribution } from '../types/domain.js';

export type GoalStore = {
  listGoals(householdId: string): Promise<Goal[]>;
  createGoal(householdId: string, input: {
    name: string; goalType: string; targetAmountCents: number;
    startDate: string; targetDate?: string; description?: string;
    categoryId?: string; accountId?: string; notes?: string;
  }): Promise<Goal>;
  contributeToGoal(householdId: string, goalId: string, input: {
    amountCents: number; contributionDate?: string; source?: string; notes?: string;
  }, opts?: { idempotencyKey?: string }): Promise<GoalContribution>;
  cancelGoal(householdId: string, goalId: string, reason?: string): Promise<Goal>;

  updateGoal(householdId: string, goalId: string, input: {
    name?: string;
    targetAmountCents?: number;
    targetDate?: string;
  }): Promise<Goal>;
};
