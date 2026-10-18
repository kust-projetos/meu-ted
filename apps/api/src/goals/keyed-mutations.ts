/**
 * V4.1 Phase 3 (UOW2) — keyed goal-mutation dispatch.
 *
 * Same single-transaction pattern as writes/keyed-mutations.ts: the route
 * producer forwards the open idempotency claim client, and the effect joins
 * that transaction. Without a claim client the plain `GoalStore` methods
 * keep their own boundary.
 */

import type { PoolClient } from 'pg';
import type { Goal, GoalContribution } from '../types/domain.js';
import type { GoalStore } from './store.js';
import { isTxClient } from '../writes/keyed-mutations.js';
import { domainErrors } from '../writes/errors.js';

export type CreateGoalInput = Parameters<GoalStore['createGoal']>[1];
export type ContributeGoalInput = Parameters<GoalStore['contributeToGoal']>[2];
export type UpdateGoalInput = Parameters<GoalStore['updateGoal']>[2];

/**
 * V4.1 Phase 3 (UOW2) — non-contractual client-bound goal mutations of the
 * Postgres goal stores (canonical AND legacy, same member names).
 * NOT part of `GoalStore` — existing callers are unaffected.
 */
export type GoalStoreTxExtensions = {
  createGoalInTx(client: PoolClient, householdId: string, input: CreateGoalInput): Promise<Goal>;
  contributeToGoalInTx(
    client: PoolClient,
    householdId: string,
    goalId: string,
    input: ContributeGoalInput,
  ): Promise<GoalContribution>;
  updateGoalInTx(client: PoolClient, householdId: string, goalId: string, input: UpdateGoalInput): Promise<Goal>;
  cancelGoalInTx(client: PoolClient, householdId: string, goalId: string): Promise<Goal>;
};

const txExtensions = (store: GoalStore): Partial<GoalStoreTxExtensions> =>
  store as unknown as Partial<GoalStoreTxExtensions>;

export async function runGoalMutation(
  store: GoalStore,
  claimTx: unknown,
  householdId: string,
  op: 'create',
  input: CreateGoalInput,
): Promise<Goal>;
export async function runGoalMutation(
  store: GoalStore,
  claimTx: unknown,
  householdId: string,
  op: 'contribute',
  input: { id: string; input: ContributeGoalInput },
): Promise<GoalContribution>;
export async function runGoalMutation(
  store: GoalStore,
  claimTx: unknown,
  householdId: string,
  op: 'update',
  input: { id: string; patch: UpdateGoalInput },
): Promise<Goal>;
export async function runGoalMutation(
  store: GoalStore,
  claimTx: unknown,
  householdId: string,
  op: 'cancel',
  input: { id: string },
): Promise<Goal>;
export async function runGoalMutation(
  store: GoalStore,
  claimTx: unknown,
  householdId: string,
  op: 'create' | 'contribute' | 'update' | 'cancel',
  input: CreateGoalInput | { id: string; input: ContributeGoalInput } | { id: string; patch: UpdateGoalInput } | { id: string },
): Promise<Goal | GoalContribution> {
  if (isTxClient(claimTx)) {
    const ext = txExtensions(store);
    // V4.1 Phase 4 (fail-closed): missing `*InTx` with an open claim tx is
    // an invariant error — never a plain fallback.
    switch (op) {
      case 'create':
        if (typeof ext.createGoalInTx === 'function') {
          return ext.createGoalInTx(claimTx, householdId, input as CreateGoalInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'contribute':
        if (typeof ext.contributeToGoalInTx === 'function') {
          const { id, input: contrib } = input as { id: string; input: ContributeGoalInput };
          return ext.contributeToGoalInTx(claimTx, householdId, id, contrib);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'update':
        if (typeof ext.updateGoalInTx === 'function') {
          const { id, patch } = input as { id: string; patch: UpdateGoalInput };
          return ext.updateGoalInTx(claimTx, householdId, id, patch);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'cancel':
        if (typeof ext.cancelGoalInTx === 'function') {
          return ext.cancelGoalInTx(claimTx, householdId, (input as { id: string }).id);
        }
        throw domainErrors.atomicMutationNotSupported();
    }
  }
  switch (op) {
    case 'create':
      return store.createGoal(householdId, input as CreateGoalInput);
    case 'contribute': {
      const { id, input: contrib } = input as { id: string; input: ContributeGoalInput };
      return store.contributeToGoal(householdId, id, contrib);
    }
    case 'update': {
      const { id, patch } = input as { id: string; patch: UpdateGoalInput };
      return store.updateGoal(householdId, id, patch);
    }
    case 'cancel':
      return store.cancelGoal(householdId, (input as { id: string }).id);
  }
}
