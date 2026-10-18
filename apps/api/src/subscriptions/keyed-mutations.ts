/**
 * V4.1 Phase 3 (UOW2) — keyed subscription-mutation dispatch.
 *
 * Same single-transaction pattern as writes/keyed-mutations.ts: the route
 * producer forwards the open idempotency claim client, and the effect joins
 * that transaction. Without a claim client the plain `SubscriptionStore`
 * method keeps its own boundary.
 */

import type { PoolClient } from 'pg';
import type { Subscription } from '../types/domain.js';
import type { CreateSubscriptionInput, SubscriptionStore, UpdateSubscriptionInput } from './store.js';
import { isTxClient } from '../writes/keyed-mutations.js';
import { domainErrors } from '../writes/errors.js';

/**
 * V4.1 Phase 3 (UOW2) — non-contractual client-bound subscription cores of
 * the canonical Postgres subscription store. NOT part of
 * `SubscriptionStore` — existing callers are unaffected.
 */
export type SubscriptionStoreTxExtensions = {
  createSubscriptionInTx(
    client: PoolClient,
    householdId: string,
    input: CreateSubscriptionInput,
  ): Promise<Subscription>;
  cancelSubscriptionInTx(
    client: PoolClient,
    householdId: string,
    id: string,
  ): Promise<Subscription>;
  updateSubscriptionInTx(
    client: PoolClient,
    householdId: string,
    id: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription>;
};

const txExtensions = (store: SubscriptionStore): Partial<SubscriptionStoreTxExtensions> =>
  store as unknown as Partial<SubscriptionStoreTxExtensions>;

export async function runSubscriptionMutation(
  store: SubscriptionStore,
  claimTx: unknown,
  householdId: string,
  op: 'create',
  input: CreateSubscriptionInput,
): Promise<Subscription>;
export async function runSubscriptionMutation(
  store: SubscriptionStore,
  claimTx: unknown,
  householdId: string,
  op: 'cancel',
  input: { id: string },
): Promise<Subscription>;
export async function runSubscriptionMutation(
  store: SubscriptionStore,
  claimTx: unknown,
  householdId: string,
  op: 'update',
  input: { id: string; patch: UpdateSubscriptionInput },
): Promise<Subscription>;
export async function runSubscriptionMutation(
  store: SubscriptionStore,
  claimTx: unknown,
  householdId: string,
  op: 'create' | 'cancel' | 'update',
  input: CreateSubscriptionInput | { id: string; patch?: UpdateSubscriptionInput },
): Promise<Subscription> {
  if (isTxClient(claimTx)) {
    const ext = txExtensions(store);
    // V4.1 Phase 4 (fail-closed): missing `*InTx` with an open claim tx is
    // an invariant error — never a plain fallback.
    switch (op) {
      case 'create':
        if (typeof ext.createSubscriptionInTx === 'function') {
          return ext.createSubscriptionInTx(claimTx, householdId, input as CreateSubscriptionInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'cancel':
        if (typeof ext.cancelSubscriptionInTx === 'function') {
          return ext.cancelSubscriptionInTx(claimTx, householdId, (input as { id: string }).id);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'update':
        if (typeof ext.updateSubscriptionInTx === 'function') {
          const { id, patch } = input as { id: string; patch: UpdateSubscriptionInput };
          return ext.updateSubscriptionInTx(claimTx, householdId, id, patch);
        }
        throw domainErrors.atomicMutationNotSupported();
    }
  }
  switch (op) {
    case 'create':
      return store.createSubscription(householdId, input as CreateSubscriptionInput);
    case 'cancel':
      return store.cancelSubscription(householdId, (input as { id: string }).id);
    case 'update': {
      const { id, patch } = input as { id: string; patch: UpdateSubscriptionInput };
      return store.updateSubscription(householdId, id, patch);
    }
  }
}
