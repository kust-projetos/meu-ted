/**
 * V4.1 Phase 3 (UOW2) — keyed payable-mutation dispatch.
 *
 * Single-transaction rule (SPEC §10.1–§10.2), same pattern as
 * writes/keyed-mutations.ts: when the idempotency layer hands a route
 * producer the open claim transaction client, the financial effect MUST run
 * on that same client — claim + effect + receipt/completion commit together,
 * and any failure rolls everything back. Without a claim client (no
 * `Idempotency-Key` header, or an in-memory store) the plain `PayableStore`
 * methods keep their own boundary: behavior unchanged.
 *
 * Both Postgres payable stores (canonical `payables/postgres.ts`, legacy
 * `payables/legacy-postgres.ts`) expose the same `*InTx` member names (see
 * `PayableStoreTxExtensions`); this module duck-types them so routes stay
 * schema-agnostic. In-memory stores have no transaction client, so the
 * synchronous producer call inside the in-memory claim IS the one phase.
 */

import type { PoolClient } from 'pg';
import type { Payable, PayableTemplate } from '../types/domain.js';
import type { PayableStore } from './store.js';
import { isTxClient } from '../writes/keyed-mutations.js';
import { domainErrors } from '../writes/errors.js';

export type { Payable, PayableTemplate };

export type CreatePayableInput = Parameters<PayableStore['createPayable']>[1];
export type PayInput = Parameters<PayableStore['markPayablePaid']>[2];
export type UpdatePayableInput = Parameters<PayableStore['updatePayable']>[2];
export type CreatePayableTemplateInput = Parameters<PayableStore['createTemplate']>[1];
export type PayableFromTemplateInput = Parameters<PayableStore['createPayableFromTemplate']>[1];
export type CreatePayableWithTemplateInput = Parameters<PayableStore['createPayableWithTemplate']>[1];
export type UnpayPayableInput = { expectedPaidTransactionId?: string };
export type CancelPayableInput = { reason?: string };

/**
 * V4.1 Phase 3 (UOW2) — non-contractual client-bound payable mutations of
 * the Postgres payable stores (canonical AND legacy, same member names).
 * NOT part of `PayableStore` — existing callers are unaffected.
 */
export type PayableStoreTxExtensions = {
  createPayableInTx(client: PoolClient, householdId: string, input: CreatePayableInput): Promise<Payable>;
  createPayableWithTemplateInTx(
    client: PoolClient,
    householdId: string,
    input: CreatePayableWithTemplateInput,
  ): Promise<Payable>;
  markPayablePaidInTx(client: PoolClient, householdId: string, payableId: string, input: PayInput): Promise<Payable>;
  undoPayablePaymentInTx(
    client: PoolClient,
    householdId: string,
    payableId: string,
    opts?: UnpayPayableInput,
  ): Promise<Payable>;
  cancelPayableInTx(client: PoolClient, householdId: string, payableId: string): Promise<Payable>;
  updatePayableInTx(
    client: PoolClient,
    householdId: string,
    payableId: string,
    input: UpdatePayableInput,
  ): Promise<Payable>;
  createTemplateInTx(
    client: PoolClient,
    householdId: string,
    input: CreatePayableTemplateInput,
  ): Promise<PayableTemplate>;
  createPayableFromTemplateInTx(
    client: PoolClient,
    householdId: string,
    input: PayableFromTemplateInput,
  ): Promise<Payable>;
  /**
   * V4.1 DEBT-CODER-BULKTX — client-bound BULK cores (no transaction
   * handling). Same contract: on the open claim client the whole batch
   * joins the claim tx (all-or-nothing with claim + completion).
   */
  autoCreateFromTemplatesInTx(
    client: PoolClient,
    householdId: string,
    daysAhead?: number,
  ): Promise<Payable[]>;
  refreshPayableStatusInTx(
    client: PoolClient,
    householdId: string,
  ): Promise<Payable[]>;
};

const txExtensions = (store: PayableStore): Partial<PayableStoreTxExtensions> =>
  store as unknown as Partial<PayableStoreTxExtensions>;

export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'create',
  input: CreatePayableInput,
): Promise<Payable>;
export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'createWithTemplate',
  input: CreatePayableWithTemplateInput,
): Promise<Payable>;
export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'pay',
  input: { id: string; input: PayInput },
): Promise<Payable>;
export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'update',
  input: { id: string; patch: UpdatePayableInput },
): Promise<Payable>;
export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'unpay',
  input: { id: string; opts?: UnpayPayableInput },
): Promise<Payable>;
export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'cancel',
  input: { id: string; reason?: string },
): Promise<Payable>;
export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'createTemplate',
  input: CreatePayableTemplateInput,
): Promise<PayableTemplate>;
export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'fromTemplate',
  input: PayableFromTemplateInput,
): Promise<Payable>;
export async function runPayableMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'create' | 'createWithTemplate' | 'pay' | 'unpay' | 'cancel' | 'update' | 'createTemplate' | 'fromTemplate',
  input:
    | CreatePayableInput
    | CreatePayableWithTemplateInput
    | { id: string; input: PayInput }
    | { id: string; opts?: UnpayPayableInput; reason?: string; patch?: UpdatePayableInput }
    | CreatePayableTemplateInput
    | PayableFromTemplateInput,
): Promise<Payable | PayableTemplate> {
  if (isTxClient(claimTx)) {
    const ext = txExtensions(store);
    // V4.1 Phase 4 (fail-closed): missing `*InTx` with an open claim tx is
    // an invariant error — never a plain fallback.
    switch (op) {
      case 'create':
        if (typeof ext.createPayableInTx === 'function') {
          return ext.createPayableInTx(claimTx, householdId, input as CreatePayableInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'createWithTemplate':
        if (typeof ext.createPayableWithTemplateInTx === 'function') {
          return ext.createPayableWithTemplateInTx(claimTx, householdId, input as CreatePayableWithTemplateInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'pay':
        if (typeof ext.markPayablePaidInTx === 'function') {
          const { id, input: payInput } = input as { id: string; input: PayInput };
          return ext.markPayablePaidInTx(claimTx, householdId, id, payInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'update':
        if (typeof ext.updatePayableInTx === 'function') {
          const { id, patch } = input as { id: string; patch: UpdatePayableInput };
          return ext.updatePayableInTx(claimTx, householdId, id, patch);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'unpay':
        if (typeof ext.undoPayablePaymentInTx === 'function') {
          const { id, opts } = input as { id: string; opts?: UnpayPayableInput };
          return ext.undoPayablePaymentInTx(claimTx, householdId, id, opts);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'cancel':
        if (typeof ext.cancelPayableInTx === 'function') {
          return ext.cancelPayableInTx(claimTx, householdId, (input as { id: string }).id);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'createTemplate':
        if (typeof ext.createTemplateInTx === 'function') {
          return ext.createTemplateInTx(claimTx, householdId, input as CreatePayableTemplateInput);
        }
        throw domainErrors.atomicMutationNotSupported();
      case 'fromTemplate':
        if (typeof ext.createPayableFromTemplateInTx === 'function') {
          return ext.createPayableFromTemplateInTx(claimTx, householdId, input as PayableFromTemplateInput);
        }
        throw domainErrors.atomicMutationNotSupported();
    }
  }
  switch (op) {
    case 'create':
      return store.createPayable(householdId, input as CreatePayableInput);
    case 'createWithTemplate':
      return store.createPayableWithTemplate(householdId, input as CreatePayableWithTemplateInput);
    case 'pay': {
      const { id, input: payInput } = input as { id: string; input: PayInput };
      return store.markPayablePaid(householdId, id, payInput);
    }
    case 'update': {
      const { id, patch } = input as { id: string; patch: UpdatePayableInput };
      return store.updatePayable(householdId, id, patch);
    }
    case 'unpay': {
      const { id, opts } = input as { id: string; opts?: UnpayPayableInput };
      return store.undoPayablePayment(householdId, id, opts);
    }
    case 'cancel': {
      const { id, reason } = input as { id: string; reason?: string };
      return store.cancelPayable(householdId, id, reason);
    }
    case 'createTemplate':
      return store.createTemplate(householdId, input as CreatePayableTemplateInput);
    case 'fromTemplate':
      return store.createPayableFromTemplate(householdId, input as PayableFromTemplateInput);
  }
}

/**
 * V4.1 DEBT-CODER-BULKTX — keyed BULK dispatch (same single-transaction
 * rule as `runPayableMutation`): with an open claim client the whole batch
 * runs on that client; without one (no `Idempotency-Key`, in-memory store)
 * the plain store method keeps its own single-transaction boundary
 * (behavior: all-or-nothing either way).
 */
export async function runPayableBulkMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'autoCreate',
  input: { daysAhead?: number },
): Promise<Payable[]>;
export async function runPayableBulkMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'refresh',
  input: Record<string, never>,
): Promise<Payable[]>;
export async function runPayableBulkMutation(
  store: PayableStore,
  claimTx: unknown,
  householdId: string,
  op: 'autoCreate' | 'refresh',
  input: { daysAhead?: number } | Record<string, never>,
): Promise<Payable[]> {
  if (isTxClient(claimTx)) {
    const ext = txExtensions(store);
    // V4.1 Phase 4 (fail-closed): bulk effects join the claim tx or throw.
    if (op === 'autoCreate') {
      if (typeof ext.autoCreateFromTemplatesInTx === 'function') {
        return ext.autoCreateFromTemplatesInTx(
          claimTx,
          householdId,
          (input as { daysAhead?: number }).daysAhead,
        );
      }
      throw domainErrors.atomicMutationNotSupported();
    }
    if (op === 'refresh') {
      if (typeof ext.refreshPayableStatusInTx === 'function') {
        return ext.refreshPayableStatusInTx(claimTx, householdId);
      }
      throw domainErrors.atomicMutationNotSupported();
    }
  }
  if (op === 'autoCreate') {
    return store.autoCreateFromTemplates(
      householdId,
      (input as { daysAhead?: number }).daysAhead,
    );
  }
  return store.refreshPayableStatus(householdId);
}
