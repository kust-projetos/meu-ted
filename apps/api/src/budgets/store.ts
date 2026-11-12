import type { Budget, BudgetStatus, BudgetTrend } from '../types/domain.js';

export type BudgetStore = {
  listBudgets(householdId: string): Promise<BudgetStatus[]>;
  createBudget(householdId: string, input: {
    categoryId: string; name: string; amountCents: number;
    period: 'monthly' | 'quarterly' | 'yearly'; startDate: string;
    alertThreshold?: number;
  }, opts?: { idempotencyKey?: string }): Promise<Budget>;
  updateBudget(householdId: string, budgetId: string, patch: {
    amountCents?: number; alertThreshold?: number;
  }): Promise<Budget>;
  getBudgetTrends(householdId: string, budgetId: string, monthsBack?: number): Promise<BudgetTrend[]>;
};
