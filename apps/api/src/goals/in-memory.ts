import { createHash, randomUUID } from 'node:crypto';
import type { Goal, GoalContribution } from '../types/domain.js';
import type { GoalStore } from './store.js';
import type { InMemoryState } from '../writes/in-memory.js';
import { domainErrors } from '../writes/errors.js';

function opt<T extends Record<string, unknown>>(obj: T, props: Partial<T>): T {
  const result = { ...obj };
  for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== null) (result as any)[k] = v;
  return result;
}

export const createInMemoryGoalStore = (state: InMemoryState): GoalStore => {
  if (!(state as any)._goals) (state as any)._goals = [] as Goal[];
  if (!(state as any)._contributions) (state as any)._contributions = [] as GoalContribution[];
  const goals = (state as any)._goals as Goal[];
  const contributions = (state as any)._contributions as GoalContribution[];

  return {
    async listGoals(householdId) {
      return goals.filter(g => g.householdId === householdId).sort((a, b) => b.targetAmountCents - a.targetAmountCents);
    },
    async createGoal(householdId, input) {
      const g = opt<Goal>(
        { id: randomUUID(), householdId, name: input.name, goalType: input.goalType as Goal['goalType'], targetAmountCents: input.targetAmountCents, currentAmountCents: 0, startDate: input.startDate, status: 'active' as const },
        { description: input.description, targetDate: input.targetDate, categoryId: input.categoryId, accountId: input.accountId, notes: input.notes } as Partial<Goal>,
      );
      goals.push(g);
      return g;
    },
    async contributeToGoal(householdId, goalId, input, opts) {
      const keyedId = opts?.idempotencyKey ? (() => {
        const bytes = createHash('sha256').update(`${householdId}:${opts.idempotencyKey}`).digest().subarray(0, 16);
        bytes[6] = (bytes[6]! & 0x0f) | 0x50;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
      })() : undefined;
      if (keyedId) {
        const prior = contributions.find((item) => item.id === keyedId);
        if (prior) {
          if (prior.goalId !== goalId) throw domainErrors.invalid('goal', 'idempotency key reutilizada');
          return prior;
        }
      }
      const g = goals.find(x => x.id === goalId && x.householdId === householdId);
      if (!g) throw domainErrors.notFound('Meta');
      // Status guard mirroring the Postgres stores (single-threaded mutation
      // is inherently atomic here, so no lost update is possible).
      if (g.status === 'cancelled') throw domainErrors.invalid('goal', 'meta cancelada não aceita aportes');
      g.currentAmountCents += input.amountCents;
      if (g.currentAmountCents >= g.targetAmountCents) g.status = 'achieved';
      const c = opt<GoalContribution>(
        { id: keyedId ?? randomUUID(), goalId, amountCents: input.amountCents, contributionDate: input.contributionDate ?? new Date().toISOString().slice(0, 10) },
        { source: input.source, notes: input.notes } as Partial<GoalContribution>,
      );
      contributions.push(c);
      return c;
    },
    async cancelGoal(householdId, goalId, _reason) {
      const g = goals.find(x => x.id === goalId && x.householdId === householdId);
      if (!g) throw domainErrors.notFound('Meta');
      g.status = 'cancelled';
      return g;
    },

    async updateGoal(householdId, goalId, input) {
      const g = goals.find(x => x.id === goalId && x.householdId === householdId);
      if (!g) throw domainErrors.notFound('Meta');
      if (input.name !== undefined) g.name = input.name;
      if (input.targetAmountCents !== undefined) g.targetAmountCents = input.targetAmountCents;
      if (input.targetDate !== undefined) g.targetDate = input.targetDate;
      return g;
    },
  };
};
