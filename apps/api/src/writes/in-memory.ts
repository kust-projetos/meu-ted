/**
 * In-memory implementation of WriteStore.
 *
 * Mutates the same arrays that `createInMemoryReadModelStore` reads
 * from. Both factories share state when constructed together via
 * `createInMemoryStores`.
 *
 * The shared state pattern is the simplest way to keep read and write
 * sides in sync without a full repository abstraction. The Postgres
 * side achieves the same via real transactions.
 */

import { randomUUID } from 'node:crypto';
import type { Account, Category, Transaction } from '../types/domain.js';
import { DEFAULT_CATEGORY_CATALOG } from '../categories/catalog.js';
import { resolveCategoryForWrite } from '../categories/resolve.js';
import { domainErrors, DomainError } from './errors.js';
import { hashPayloadV2, matchesPayloadHash } from './idempotency.js';
import { namespacedPendingV2Key } from './pending-idempotency.js';
import type { ApplyDefaultsResult, DeleteCategoryResult, WriteStore } from './store.js';
import type {
  CreateExpenseInput,
  CreateIncomeInput,
  DeleteCategoryInput,
} from './types.js';

export type InMemoryState = {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  /** Soft-deleted transaction ids, per household. Read store filters these out. */
  deletedTransactions: Set<string>;
};

/**
 * V4.1 REVIEWFIX F3 [major]: in-memory twin of the paid-payable link
 * guard. The payable store keeps its rows on the same shared state
 * (`_payables`, see payables/in-memory.ts); a live paid link blocks direct
 * transaction PATCH/DELETE with 409. The undo path clears the link before
 * tombstoning, so it is unaffected.
 */
const assertNotLinkedToPaidPayableInState = (state: InMemoryState, householdId: string, transactionId: string): void => {
  const payables = (state as unknown as { _payables?: Array<{ householdId: string; paidTransactionId?: string }> })._payables;
  const linked = payables?.some(
    (p) => p.householdId === householdId && p.paidTransactionId === transactionId,
  );
  if (linked) {
    throw domainErrors.conflict(
      'Lançamento vinculado a conta paga não pode ser alterado; desfaça o pagamento primeiro.',
    );
  }
};

/**
 * Idempotent application of the pt-BR default catalog to a household.
 * Existing same-kind macros (case-insensitive name match) are reused;
 * subs are matched under their resolved macro. Shared by
 * applyCategoryDefaults and the createAccount bootstrap.
 */
export const applyDefaultsToState = (state: InMemoryState, householdId: string): ApplyDefaultsResult => {
  let created = 0;
  let skipped = 0;
  const activeOf = (): Category[] =>
    state.categories.filter((c) => c.householdId === householdId && c.status === 'active');
  DEFAULT_CATEGORY_CATALOG.forEach((macro, macroIdx) => {
    let macroRow = activeOf().find(
      (c) => !c.parentId && c.kind === macro.kind && c.name.toLowerCase() === macro.name.toLowerCase(),
    );
    if (!macroRow) {
      macroRow = {
        id: randomUUID(),
        householdId,
        name: macro.name,
        kind: macro.kind,
        status: 'active',
        icon: macro.icon,
        color: macro.color,
        sortOrder: macroIdx,
        isDefault: true,
        isSystem: false,
      };
      state.categories.push(macroRow);
      created += 1;
    } else {
      skipped += 1;
    }
    for (const sub of macro.subs) {
      const exists = activeOf().find(
        (c) => c.parentId === macroRow!.id && c.name.toLowerCase() === sub.name.toLowerCase(),
      );
      if (exists) {
        skipped += 1;
        continue;
      }
      state.categories.push({
        id: randomUUID(),
        householdId,
        name: sub.name,
        kind: macro.kind,
        status: 'active',
        parentId: macroRow!.id,
        icon: sub.icon,
        isDefault: true,
        isSystem: false,
      });
      created += 1;
    }
  });
  return { created, skipped };
};

/**
 * Centralized subcategory validation for expense/income writes (M-03).
 * Same-household, active, real subcategory with matching kind; when the
 * entry names a distinct parent category, the subcategory must belong to it.
 */
export const resolveSubcategory = (
  state: InMemoryState,
  householdId: string,
  subcategoryId: string,
  txKind: 'expense' | 'income',
  parentCategoryId?: string,
): Category => {
  const sub = state.categories.find((c) => c.id === subcategoryId && c.householdId === householdId);
  if (!sub || sub.status !== 'active') throw domainErrors.notFound('Subcategoria');
  if (!sub.parentId) throw domainErrors.invalid('subcategoryId', 'deve ser uma subcategoria');
  if (sub.kind !== txKind) {
    throw domainErrors.invalid('subcategoryId', 'subcategoria deve ter o mesmo kind do lançamento');
  }
  if (parentCategoryId !== undefined && parentCategoryId !== subcategoryId && sub.parentId !== parentCategoryId) {
    throw domainErrors.invalid('subcategoryId', 'subcategoria não pertence à categoria informada');
  }
  return sub;
};

/**
 * Negative-balance rule (user-approved): `bank`/`cash` accounts may go
 * negative — debits on them are never rejected for insufficient funds.
 * `credit_card` keeps non-negative outstanding-balance semantics, so a
 * debit leg that would drive a card below zero still fails with 400
 * `validation.invalid` — never a silent clamp.
 */
const assertDebitAllowed = (kind: string, balanceCents: number, amountCents: number): void => {
  if (kind !== 'credit_card') return;
  if (balanceCents < amountCents) {
    throw domainErrors.invalid('amountCents', 'saldo insuficiente na conta de origem');
  }
};

/**
 * V4.1 Phase 4 (D1 option B): H-01 parity for PATCH — an entry moved onto
 * a credit card is rejected with the same 422 the create path uses.
 */
const assertNotCreditCardForKind = (
  acc: Account,
  kind: 'expense' | 'income',
): void => {
  if (acc.kind !== 'credit_card') return;
  if (kind === 'expense') {
    throw new DomainError('validation.invalid', 'compra no cartão deve usar /cards/purchases.', 422);
  }
  throw new DomainError('validation.invalid', 'receita não pode usar cartão de crédito.', 422);
};

const softDeleteTxInState = (state: InMemoryState, tx: Transaction): void => {
  if (tx.kind === 'expense') {
    const acc = state.accounts.find((a) => a.id === tx.accountId && a.householdId === tx.householdId);
    if (acc) acc.balanceCents = Math.min(acc.balanceCents + tx.amountCents, Number.MAX_SAFE_INTEGER);
  } else if (tx.kind === 'income') {
    const acc = state.accounts.find((a) => a.id === tx.accountId && a.householdId === tx.householdId);
    // Negative-balance rule: reversing an income is a debit — allowed to
    // drive bank/cash negative, still floored at zero for credit cards.
    if (acc) {
      assertDebitAllowed(acc.kind, acc.balanceCents, tx.amountCents);
      acc.balanceCents -= tx.amountCents;
    }
  } else if (tx.kind === 'transfer') {
    // C-04 parity with softDeleteTransaction: reverse both legs.
    const from = state.accounts.find((a) => a.id === tx.accountId && a.householdId === tx.householdId);
    if (from) from.balanceCents = Math.min(from.balanceCents + tx.amountCents, Number.MAX_SAFE_INTEGER);
    if (tx.transferToAccountId) {
      const to = state.accounts.find((a) => a.id === tx.transferToAccountId && a.householdId === tx.householdId);
      if (to) {
        assertDebitAllowed(to.kind, to.balanceCents, tx.amountCents);
        to.balanceCents -= tx.amountCents;
      }
    }
  }
  state.deletedTransactions.add(tx.id);
};

export const createInMemoryWriteStore = (state: InMemoryState): WriteStore => {
  const findAccount = (id: string, householdId: string): Account => {
    const a = state.accounts.find((x) => x.id === id && x.householdId === householdId);
    if (!a) throw domainErrors.notFound('Conta');
    return a;
  };
  const findCategory = (id: string, householdId: string): Category => {
    const c = state.categories.find((x) => x.id === id && x.householdId === householdId);
    if (!c) throw domainErrors.notFound('Categoria');
    return c;
  };
  const findTransaction = (id: string, householdId: string): Transaction => {
    const t = state.transactions.find((x) => x.id === id && x.householdId === householdId);
    if (!t) throw domainErrors.notFound('Lançamento');
    if (state.deletedTransactions.has(t.id)) throw domainErrors.notFound('Lançamento');
    return t;
  };

  const assertNotDeleted = (e: { deletedAt?: string; status: string } | null): void => {
    if (!e) return;
    if ('deletedAt' in e && e.deletedAt) throw domainErrors.notFound('Lançamento');
    if (e.status === 'inactive') throw domainErrors.notFound('Conta');
  };

  // P1 (audit item 7): key-idempotent V2 execution records. First call
  // executes and records (key → transaction); concurrent or repeated
  // calls with the same key + payload replay without re-executing.
  const idemRecords = new Map<string, { payloadHash: string; transaction: Transaction }>();
  const idemFlights = new Map<string, { payloadHash: string; promise: Promise<Transaction> }>();
  // ted-local.account-idempotency: V2 key → account records (same
  // pending-v2 namespace as transactions, separate envelope so a
  // transaction record can never replay as an account).
  const idemAccountRecords = new Map<string, { payloadHash: string; account: Account }>();
  const idemAccountFlights = new Map<string, { payloadHash: string; promise: Promise<Account> }>();
  // categories-create-api: V2 key → category records (same pending-v2
  // namespace, `{ category }` envelope — never replays as account/tx).
  const idemCategoryRecords = new Map<string, { payloadHash: string; category: Category }>();
  const idemCategoryFlights = new Map<string, { payloadHash: string; promise: Promise<Category> }>();
  // All typed V2 writers share one namespace, matching PostgreSQL's single
  // idempotency_keys envelope. Keep typed result snapshots above, but reserve
  // ownership synchronously before any producer can run.
  type KeyedOwner = { kind: 'account' | 'category' | 'transaction'; payloadHash: string };
  const keyedOwners = new Map<string, KeyedOwner>();
  const assertKeyOwner = (key: string, kind: 'account' | 'category' | 'transaction', payload: unknown): string => {
    const composite = `${key.length}:${key}`;
    const payloadHash = hashPayloadV2(payload);
    const owner = keyedOwners.get(composite);
    if (owner && (owner.kind !== kind || !matchesPayloadHash(owner.payloadHash, payload))) {
      throw domainErrors.idempotencyConflict();
    }
    return composite;
  };
  // Round2 achado 3 — o registro keyed é um SNAPSHOT: a conta viva no state
  // segue mutável (updateAccount edita in place), então persistir/retornar
  // a referência viva contaminaria o replay. Clona no persist e em CADA
  // retorno (hit, flight, primeira entrega) para que nem mutação do state
  // nem mutação pelo chamador altere o snapshot.
  const cloneAccount = (account: Account): Account => JSON.parse(JSON.stringify(account)) as Account;
  const cloneCategory = (category: Category): Category => JSON.parse(JSON.stringify(category)) as Category;
  const cloneTransaction = (transaction: Transaction): Transaction => JSON.parse(JSON.stringify(transaction)) as Transaction;
  const runKeyedAccount = async (
    householdId: string,
    idempotencyKey: string,
    payload: unknown,
    producer: () => Promise<Account>,
  ): Promise<Account> => {
    const composite = assertKeyOwner(`${householdId}::${namespacedPendingV2Key(idempotencyKey)}`, 'account', payload);
    const payloadHash = hashPayloadV2(payload);
    const hit = idemAccountRecords.get(composite);
    if (hit) {
      if (!matchesPayloadHash(hit.payloadHash, payload)) throw domainErrors.idempotencyConflict();
      return cloneAccount(hit.account);
    }
    const flight = idemAccountFlights.get(composite);
    if (flight) {
      if (!matchesPayloadHash(flight.payloadHash, payload)) throw domainErrors.idempotencyConflict();
      return cloneAccount(await flight.promise);
    }
    let resolveFlight!: (a: Account) => void;
    let rejectFlight!: (err: unknown) => void;
    const promise = new Promise<Account>((res, rej) => {
      resolveFlight = res;
      rejectFlight = rej;
    });
    promise.catch(() => undefined);
    const owner: KeyedOwner = { kind: 'account', payloadHash };
    keyedOwners.set(composite, owner);
    idemAccountFlights.set(composite, { payloadHash, promise });
    try {
      const account = await producer();
      const snapshot = cloneAccount(account);
      idemAccountRecords.set(composite, { payloadHash, account: snapshot });
      resolveFlight(snapshot);
      return cloneAccount(snapshot);
    } catch (err) {
      if (keyedOwners.get(composite) === owner) keyedOwners.delete(composite);
      rejectFlight(err);
      throw err;
    } finally {
      idemAccountFlights.delete(composite);
    }
  };
  const runKeyedCategory = async (
    householdId: string,
    idempotencyKey: string,
    payload: unknown,
    producer: () => Promise<Category>,
  ): Promise<Category> => {
    const composite = assertKeyOwner(`${householdId}::${namespacedPendingV2Key(idempotencyKey)}`, 'category', payload);
    const payloadHash = hashPayloadV2(payload);
    const hit = idemCategoryRecords.get(composite);
    if (hit) {
      if (!matchesPayloadHash(hit.payloadHash, payload)) throw domainErrors.idempotencyConflict();
      return cloneCategory(hit.category);
    }
    const flight = idemCategoryFlights.get(composite);
    if (flight) {
      if (!matchesPayloadHash(flight.payloadHash, payload)) throw domainErrors.idempotencyConflict();
      return cloneCategory(await flight.promise);
    }
    let resolveFlight!: (c: Category) => void;
    let rejectFlight!: (err: unknown) => void;
    const promise = new Promise<Category>((res, rej) => {
      resolveFlight = res;
      rejectFlight = rej;
    });
    promise.catch(() => undefined);
    const owner: KeyedOwner = { kind: 'category', payloadHash };
    keyedOwners.set(composite, owner);
    idemCategoryFlights.set(composite, { payloadHash, promise });
    try {
      const category = await producer();
      const snapshot = cloneCategory(category);
      idemCategoryRecords.set(composite, { payloadHash, category: snapshot });
      resolveFlight(snapshot);
      return cloneCategory(snapshot);
    } catch (err) {
      if (keyedOwners.get(composite) === owner) keyedOwners.delete(composite);
      rejectFlight(err);
      throw err;
    } finally {
      idemCategoryFlights.delete(composite);
    }
  };

  const runKeyed = async (
    householdId: string,
    idempotencyKey: string,
    payload: unknown,
    producer: () => Promise<Transaction>,
  ): Promise<Transaction> => {
    const composite = assertKeyOwner(`${householdId}::${namespacedPendingV2Key(idempotencyKey)}`, 'transaction', payload);
    // V4.1 Phase 3 Tasks 3.6/3.7: new records hash V2; older rows replay.
    const payloadHash = hashPayloadV2(payload);
    const hit = idemRecords.get(composite);
    if (hit) {
      if (!matchesPayloadHash(hit.payloadHash, payload)) throw domainErrors.idempotencyConflict();
      return cloneTransaction(hit.transaction);
    }
    const flight = idemFlights.get(composite);
    if (flight) {
      if (!matchesPayloadHash(flight.payloadHash, payload)) throw domainErrors.idempotencyConflict();
      return cloneTransaction(await flight.promise);
    }
    let resolveFlight!: (tx: Transaction) => void;
    let rejectFlight!: (err: unknown) => void;
    const promise = new Promise<Transaction>((res, rej) => {
      resolveFlight = res;
      rejectFlight = rej;
    });
    promise.catch(() => undefined);
    const owner: KeyedOwner = { kind: 'transaction', payloadHash };
    keyedOwners.set(composite, owner);
    idemFlights.set(composite, { payloadHash, promise });
    try {
      const tx = await producer();
      const snapshot = cloneTransaction(tx);
      idemRecords.set(composite, { payloadHash, transaction: snapshot });
      resolveFlight(snapshot);
      return cloneTransaction(snapshot);
    } catch (err) {
      if (keyedOwners.get(composite) === owner) keyedOwners.delete(composite);
      rejectFlight(err);
      throw err;
    } finally {
      idemFlights.delete(composite);
    }
  };

  const createExpenseUnkeyed = async (householdId: string, input: CreateExpenseInput): Promise<Transaction> => {
    const acc = findAccount(input.accountId, householdId);
    assertNotDeleted(acc);
    // H-01: card purchases must flow through the CardStore (statements,
    // limits, invoice semantics) — never as plain balance expenses.
    if (acc.kind === 'credit_card') {
      throw new DomainError('validation.invalid', 'compra no cartão deve usar /cards/purchases.', 422);
    }
    const cat = resolveCategoryForWrite(state.categories, {
      householdId,
      categoryId: input.categoryId,
      expectedKind: 'expense',
    });
    assertNotDeleted(cat);
    if (input.subcategoryId !== undefined) {
      resolveSubcategory(state, householdId, input.subcategoryId, 'expense', input.categoryId);
    }
    if (input.amountCents <= 0) throw domainErrors.invalid('amountCents', 'deve ser maior que zero');
    // Negative-balance rule (user-approved): bank/cash expenses may cross
    // below zero — the guard below is a no-op for them and stays as the
    // zero floor for credit cards (already 422-rejected above).
    assertDebitAllowed(acc.kind, acc.balanceCents, input.amountCents);
    const tx: Transaction = {
      id: randomUUID(),
      householdId,
      kind: 'expense',
      description: input.description,
      amountCents: input.amountCents,
      date: input.date,
      accountId: input.accountId,
      categoryId: input.categoryId,
      ...(input.subcategoryId !== undefined ? { subcategoryId: input.subcategoryId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    state.transactions.push(tx);
    acc.balanceCents -= input.amountCents;
    return tx;
  };

  const createIncomeUnkeyed = async (householdId: string, input: CreateIncomeInput): Promise<Transaction> => {
    const acc = findAccount(input.accountId, householdId);
    assertNotDeleted(acc);
    // H-01: income on a credit card is rejected (422), not silently booked.
    if (acc.kind === 'credit_card') {
      throw new DomainError('validation.invalid', 'receita não pode usar cartão de crédito.', 422);
    }
    const cat = resolveCategoryForWrite(state.categories, {
      householdId,
      categoryId: input.categoryId,
      expectedKind: 'income',
    });
    assertNotDeleted(cat);
    if (input.subcategoryId !== undefined) {
      resolveSubcategory(state, householdId, input.subcategoryId, 'income', input.categoryId);
    }
    if (input.amountCents <= 0) throw domainErrors.invalid('amountCents', 'deve ser maior que zero');
    const tx: Transaction = {
      id: randomUUID(),
      householdId,
      kind: 'income',
      description: input.description,
      amountCents: input.amountCents,
      date: input.date,
      accountId: input.accountId,
      categoryId: input.categoryId,
      ...(input.subcategoryId !== undefined ? { subcategoryId: input.subcategoryId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    state.transactions.push(tx);
    acc.balanceCents += input.amountCents;
    return tx;
  };

  const createAccountUnkeyed = async (
    householdId: string,
    input: Parameters<WriteStore['createAccount']>[1],
  ): Promise<Account> => {
      const duplicate = state.accounts.some(
        (existing) =>
          existing.householdId === householdId &&
          existing.status === 'active' &&
          existing.name.toLowerCase() === input.name.toLowerCase(),
      );
      if (duplicate) throw domainErrors.inUse('Conta', 'nome duplicado');
      // Negative-balance rule: only bank/cash may start negative. The
      // route schema already limits kind to bank|cash; this guards direct
      // store callers presenting any account kind.
      if ((input.kind as string) === 'credit_card' && input.initialBalanceCents < 0) {
        throw domainErrors.invalid('initialBalanceCents', 'cartão de crédito não pode iniciar com saldo negativo');
      }
      const acc: Account = {

        id: randomUUID(),
        householdId,
        name: input.name,
        kind: input.kind,
        balanceCents: input.initialBalanceCents,
        status: 'active',
      };
      state.accounts.push(acc);
      // Item 11: new accounts bootstrap the default set, but only for
      // households that have no categories yet (explicit apply-defaults
      // covers backfill; seeded households are untouched).
      if (!state.categories.some((c) => c.householdId === householdId && c.status === 'active')) {
        applyDefaultsToState(state, householdId);
      }
      return acc;
  };

  const renameAccountUnkeyed = (
    householdId: string,
    input: { accountId: string; name: string; expectedName: string },
  ): Account => {
    const acc = findAccount(input.accountId, householdId);
    if (acc.status !== 'active') throw domainErrors.notFound('Conta');
    if (acc.kind !== 'bank' && acc.kind !== 'cash') {
      throw domainErrors.invalid('kind', 'renomear exige conta bank/cash ativa');
    }
    if (acc.name !== input.expectedName) throw domainErrors.nameConflict();
    if (acc.name === input.name) return acc;
    acc.name = input.name;
    return acc;
  };

  const createCategoryUnkeyed = async (
    householdId: string,
    input: Parameters<WriteStore['createCategory']>[1],
  ): Promise<Category> => {
    const duplicate = state.categories.some(
      (existing) =>
        existing.householdId === householdId &&
        existing.status === 'active' &&
        existing.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (duplicate) throw domainErrors.inUse('Categoria', 'nome duplicado');
    if (input.parentId) {
      const parent = state.categories.find(
        (c) => c.id === input.parentId && c.householdId === householdId && c.status === 'active',
      );
      if (!parent) throw domainErrors.notFound('Categoria pai');
      if (parent.parentId) throw domainErrors.invalid('parentId', 'subcategoria não pode ter subcategoria');
      if (parent.kind !== input.kind) {
        throw domainErrors.invalid('parentId', 'categoria pai deve ter o mesmo kind');
      }
    }
    const cat: Category = {
      id: randomUUID(),
      householdId,
      name: input.name,
      kind: input.kind,
      status: 'active',
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    };
    state.categories.push(cat);
    return cat;
  };

  return {
    async createAccount(householdId, input, options) {
      if (options?.idempotencyKey !== undefined) {
        // ted-local.account-idempotency: V2 recovery replays key → account.
        return runKeyedAccount(householdId, options.idempotencyKey, input, () =>
          createAccountUnkeyed(householdId, input),
        );
      }
      return createAccountUnkeyed(householdId, input);
    },

    async updateAccount(householdId, id, patch, options) {
      if (options?.idempotencyKey === undefined) {
        const acc = findAccount(id, householdId);
        if (acc.status !== 'active') throw domainErrors.notFound('Conta');
        if (patch.name !== undefined) acc.name = patch.name;
        return acc;
      }
      // Rename-only V2 path (ADR-029): keyed replay + atomic before-condition.
      if (options.expectedName === undefined || patch.name === undefined) {
        throw domainErrors.invalid('expectedName', 'renomeação V2 exige expectedName e name');
      }
      const args = { accountId: id, name: patch.name, expectedName: options.expectedName };
      return runKeyedAccount(householdId, options.idempotencyKey, { tool: 'accounts.update', args }, async () =>
        renameAccountUnkeyed(householdId, args),
      );
    },

    async deactivateAccount(householdId, id) {
      const acc = findAccount(id, householdId);
      if (acc.status !== 'active') throw domainErrors.notFound('Conta');
      const referenced = state.transactions.some(
        (t) => t.householdId === householdId && (t.accountId === id || t.transferToAccountId === id),
      );
      if (referenced) throw domainErrors.inUse('Conta', 'lançamentos');
      acc.status = 'inactive';
      return acc;
    },

    async createCategory(householdId, input, options) {
      if (options?.idempotencyKey !== undefined) {
        return runKeyedCategory(householdId, options.idempotencyKey, input, () =>
          createCategoryUnkeyed(householdId, input),
        );
      }
      return createCategoryUnkeyed(householdId, input);
    },

    async updateCategory(householdId, id, patch, options) {
      if (options?.idempotencyKey === undefined) {
        const cat = findCategory(id, householdId);
        if (cat.status !== 'active') throw domainErrors.notFound('Categoria');
        if (patch.name !== undefined) cat.name = patch.name;
        if (patch.icon !== undefined) cat.icon = patch.icon;
        if (patch.color !== undefined) cat.color = patch.color;
        if (patch.sortOrder !== undefined) cat.sortOrder = patch.sortOrder;
        if (patch.isDefault !== undefined) cat.isDefault = patch.isDefault;
        return cat;
      }
      if (patch.icon !== undefined || patch.color !== undefined || patch.sortOrder !== undefined || patch.isDefault !== undefined) {
        throw domainErrors.invalid('patch', 'renomeacao V2 aceita apenas name');
      }
      if (options.expectedName === undefined || patch.name === undefined) {
        throw domainErrors.invalid('expectedName', 'renomeacao V2 exige expectedName e name');
      }
      const args = { categoryId: id, name: patch.name, expectedName: options.expectedName };
      return runKeyedCategory(householdId, options.idempotencyKey, { tool: 'categories.update' as const, args }, async () => {
        const cat = findCategory(id, householdId);
        if (cat.status !== 'active') throw domainErrors.notFound('Categoria');
        if (cat.parentId) {
          const parent = state.categories.find((c) => c.id === cat.parentId && c.householdId === householdId);
          if (!parent || parent.status !== 'active') throw domainErrors.notFound('Categoria pai');
          if (parent.parentId) throw domainErrors.invalid('parentId', 'subcategoria nao pode ter subcategoria');
          if (parent.kind !== cat.kind) throw domainErrors.invalid('parentId', 'categoria pai deve ter o mesmo kind');
        }
        if (cat.name !== options.expectedName) throw domainErrors.categoryNameConflict();
        if (cat.name === patch.name) return cloneCategory(cat);
        const conflict = state.categories.find(
          (c) =>
            c.householdId === householdId &&
            c.status === 'active' &&
            c.id !== cat.id &&
            c.kind === cat.kind &&
            (c.parentId ?? null) === (cat.parentId ?? null) &&
            c.name.toLowerCase() === patch.name!.toLowerCase(),
        );
        if (conflict) throw domainErrors.inUse('Categoria', 'nome duplicado');
        cat.name = patch.name!;
        return cloneCategory(cat);
      });
    },

    async deactivateCategory(householdId, id, options) {
      if (options?.idempotencyKey !== undefined) {
        if (typeof options.expectedName !== 'string' || options.expectedName.trim() === '') throw domainErrors.invalid('expectedName', 'desativacao V2 exige expectedName');
        const args = { categoryId: id, expectedName: options.expectedName };
        return runKeyedCategory(householdId, options.idempotencyKey, { tool: 'categories.deactivate', args }, async () => {
          const category = findCategory(id, householdId);
          if (category.status !== 'active') throw domainErrors.notFound('Categoria');
          if (category.name !== options.expectedName) throw domainErrors.categoryNameConflict();
          const referenced = state.categories.some((child) => child.householdId === householdId && child.parentId === id) || state.transactions.some((t) => t.householdId === householdId && (t.categoryId === id || t.subcategoryId === id));
          const payableReferences = (state as unknown as { _payables?: Array<{ householdId: string; categoryId?: string }> })._payables?.some((row) => row.householdId === householdId && row.categoryId === id) ?? false;
          if (referenced || payableReferences) throw domainErrors.inUse('Categoria', 'registros vinculados');
          category.status = 'inactive';
          return cloneCategory(category);
        });
      }
      const cat = findCategory(id, householdId);
      if (cat.status !== 'active') throw domainErrors.notFound('Categoria');
      const referenced = state.categories.some((child) => child.householdId === householdId && child.parentId === id) ||
        state.transactions.some(
        (t) =>
          t.householdId === householdId &&
          (t.categoryId === id || t.subcategoryId === id),
      );
      // Some optional in-memory stores attach their persisted rows to the
      // shared state. Inspect only those real collections; do not synthesize
      // a cross-store cache when a store is not present.
      const payableReferences = (state as unknown as {
        _payables?: Array<{ householdId: string; categoryId?: string }>;
      })._payables?.some((row) => row.householdId === householdId && row.categoryId === id) ?? false;
      if (referenced || payableReferences) throw domainErrors.inUse('Categoria', 'registros vinculados');
      cat.status = 'inactive';
      return cat;
    },

    async deleteCategory(householdId, id, input: DeleteCategoryInput): Promise<DeleteCategoryResult> {
      const cat = findCategory(id, householdId);
      if (cat.status !== 'active') throw domainErrors.notFound('Categoria');
      const scopeIds = new Set<string>([id]);
      for (const c of state.categories) {
        if (c.householdId === householdId && c.status === 'active' && c.parentId === id) {
          scopeIds.add(c.id);
        }
      }
      const referencing = state.transactions.filter(
        (t) =>
          t.householdId === householdId &&
          !state.deletedTransactions.has(t.id) &&
          ((t.categoryId !== undefined && scopeIds.has(t.categoryId)) ||
            (t.subcategoryId !== undefined && scopeIds.has(t.subcategoryId))),
      );
      let movedTransactions = 0;
      let softDeletedTransactions = 0;
      if (input.mode === 'move') {
        const dest = state.categories.find(
          (c) => c.id === input.destinationCategoryId && c.householdId === householdId,
        );
        if (!dest || dest.status !== 'active') throw domainErrors.notFound('Categoria de destino');
        if (dest.kind !== cat.kind) {
          throw domainErrors.invalid('destinationCategoryId', 'destino deve ter o mesmo kind');
        }
        if (scopeIds.has(dest.id)) {
          throw domainErrors.invalid('destinationCategoryId', 'destino não pode ser a categoria excluída');
        }
        for (const t of referencing) {
          if (t.categoryId !== undefined && scopeIds.has(t.categoryId)) t.categoryId = dest.id;
          if (t.subcategoryId !== undefined && scopeIds.has(t.subcategoryId)) delete t.subcategoryId;
          movedTransactions += 1;
        }
      } else {
        if (input.confirm !== true) {
          throw domainErrors.invalid('confirm', 'exclusão em cascata exige confirm:true');
        }
        for (const t of referencing) {
          softDeleteTxInState(state, t);
          softDeletedTransactions += 1;
        }
      }
      for (const c of state.categories) {
        if (c.householdId === householdId && scopeIds.has(c.id)) c.status = 'inactive';
      }
      return { deletedCategoryIds: [...scopeIds], movedTransactions, softDeletedTransactions };
    },

    async applyCategoryDefaults(householdId) {
      return applyDefaultsToState(state, householdId);
    },

    async createExpense(householdId, input, options) {
      if (options?.idempotencyKey !== undefined) {
        return runKeyed(householdId, options.idempotencyKey, input, () => createExpenseUnkeyed(householdId, input));
      }
      return createExpenseUnkeyed(householdId, input);
    },

    async createIncome(householdId, input, options) {
      if (options?.idempotencyKey !== undefined) {
        return runKeyed(householdId, options.idempotencyKey, input, () => createIncomeUnkeyed(householdId, input));
      }
      return createIncomeUnkeyed(householdId, input);
    },

    async createTransfer(householdId, input) {
      if (input.fromAccountId === input.toAccountId) {
        throw domainErrors.invalid('toAccountId', 'deve ser diferente da conta de origem');
      }
      const from = findAccount(input.fromAccountId, householdId);
      assertNotDeleted(from);
      const to = findAccount(input.toAccountId, householdId);
      assertNotDeleted(to);
      // H-01: transfers cannot touch credit cards (pay the invoice instead).
      if (from.kind === 'credit_card' || to.kind === 'credit_card') {
        throw new DomainError('validation.invalid', 'transferência não pode usar cartão de crédito.', 422);
      }
      if (input.amountCents <= 0) throw domainErrors.invalid('amountCents', 'deve ser maior que zero');
      // Negative-balance rule (user-approved): bank/cash sources may cross
      // below zero — the guard below is a no-op for them and stays as the
      // zero floor for credit cards (already 422-rejected above).
      assertDebitAllowed(from.kind, from.balanceCents, input.amountCents);
      const tx: Transaction = {
        id: randomUUID(),
        householdId,
        kind: 'transfer',
        description: input.description,
        amountCents: input.amountCents,
        date: input.date,
        accountId: input.fromAccountId,
        transferToAccountId: input.toAccountId,
      };
      state.transactions.push(tx);
      from.balanceCents -= input.amountCents;
      to.balanceCents += input.amountCents;
      return tx;
    },

    async updateTransaction(householdId, id, patch) {
      const tx = findTransaction(id, householdId);
      // V4.1 REVIEWFIX F3: block PATCH of a paid payable's payment effect.
      assertNotLinkedToPaidPayableInState(state, householdId, id);
      if (tx.kind === 'transfer') {
        // Limited: description + date only.
        if (patch.description !== undefined) tx.description = patch.description;
        if (patch.date !== undefined) tx.date = patch.date;
        if (
          patch.amountCents !== undefined ||
          patch.accountId !== undefined ||
          patch.categoryId !== undefined ||
          patch.subcategoryId !== undefined ||
          patch.notes !== undefined
        ) {
          // V4.1 SPEC §9.7: restricted transfer fields are a contract
          // violation (422), not a malformed body.
          throw new DomainError(
            'unsupported',
            'Operação não suportada: transferências só podem ter descrição e data alteradas.',
            422,
          );
        }
        return tx;
      }
      // expense / income
      if (patch.description !== undefined) tx.description = patch.description;
      if (patch.date !== undefined) tx.date = patch.date;
      // V4.1 Phase 4 (Tasks 4.4–4.5): delta engine — compute the effective
      // after-state, validate it (negative-balance rule: only credit-card
      // legs keep the zero floor; H-01: no credit-card leg), then
      // reverse(before) + apply(after) exactly once. Validation runs
      // BEFORE any mutation so a rejection leaves every balance untouched.
      const balanceTouched =
        patch.amountCents !== undefined ||
        (patch.accountId !== undefined && patch.accountId !== tx.accountId);
      if (balanceTouched) {
        if (patch.amountCents !== undefined && patch.amountCents <= 0) {
          throw domainErrors.invalid('amountCents', 'deve ser maior que zero');
        }
        const newAmount = patch.amountCents ?? tx.amountCents;
        const newAccountId = patch.accountId ?? tx.accountId;
        const oldAcc = findAccount(tx.accountId, householdId);
        const newAcc = newAccountId === tx.accountId ? oldAcc : findAccount(newAccountId, householdId);
        assertNotDeleted(newAcc);
        assertNotCreditCardForKind(newAcc, tx.kind);
        // Projected finals: reverse(before) then apply(after).
        const reverseDelta = tx.kind === 'expense' ? tx.amountCents : -tx.amountCents;
        const applyDelta = tx.kind === 'expense' ? -newAmount : newAmount;
        if (newAccountId === tx.accountId) {
          const final = oldAcc.balanceCents + reverseDelta + applyDelta;
          // Negative-balance rule: bank/cash may end negative; only a
          // credit-card leg keeps the zero floor.
          if (final < 0 && oldAcc.kind === 'credit_card') {
            throw domainErrors.invalid('amountCents', 'saldo insuficiente na conta de origem');
          }
          oldAcc.balanceCents = final;
        } else {
          const oldFinal = oldAcc.balanceCents + reverseDelta;
          const newFinal = newAcc.balanceCents + applyDelta;
          // reverseDelta on an expense is a credit (never negative);
          // on income it is a debit. Only credit-card legs keep the
          // zero floor (a card target is already 422-rejected above).
          if (
            (oldFinal < 0 && oldAcc.kind === 'credit_card') ||
            (newFinal < 0 && newAcc.kind === 'credit_card')
          ) {
            throw domainErrors.invalid('amountCents', 'saldo insuficiente na conta de origem');
          }
          oldAcc.balanceCents = oldFinal;
          newAcc.balanceCents = newFinal;
        }
        tx.amountCents = newAmount;
        tx.accountId = newAccountId;
      }
      if (patch.accountId !== undefined && !balanceTouched) {
        // Same-account no-op patch: still validate the target.
        const next = findAccount(patch.accountId, householdId);
        assertNotDeleted(next);
        assertNotCreditCardForKind(next, tx.kind);
      }
      if (patch.categoryId !== undefined) {
        // V4.1 Task 2.15: the new category must be active in the household
        // and match the entry kind (this branch only runs for
        // expense/income — transfers reject categoryId with 422 above).
        resolveCategoryForWrite(state.categories, {
          householdId,
          categoryId: patch.categoryId,
          expectedKind: tx.kind === 'income' ? 'income' : 'expense',
        });
      }
      if (patch.subcategoryId !== undefined) {
        const parentId = patch.categoryId ?? tx.categoryId;
        resolveSubcategory(state, householdId, patch.subcategoryId, tx.kind, parentId);
        tx.subcategoryId = patch.subcategoryId;
      } else if (
        patch.categoryId !== undefined &&
        patch.categoryId !== tx.categoryId &&
        tx.subcategoryId !== undefined
      ) {
        // Parent changed without re-specifying the subcategory: drop the
        // retained subcategory instead of persisting an incoherent tree.
        delete tx.subcategoryId;
      }
      if (patch.categoryId !== undefined) {
        tx.categoryId = patch.categoryId;
      }
      if (patch.notes !== undefined) tx.notes = patch.notes;
      return tx;
    },

    async editTransactionDescription(householdId, input, options) {
      const args = { transactionId: input.transactionId, description: input.description, expectedDescription: input.expectedDescription };
      const description = input.description.trim();
      if (typeof options?.idempotencyKey !== 'string' || options.idempotencyKey.length === 0) throw domainErrors.required('Idempotency-Key');
      if (typeof options.actorId !== 'string' || options.actorId.length === 0) throw domainErrors.required('actorId');
      if (description.length < 1 || description.length > 240 || input.expectedDescription.length < 1 || input.expectedDescription.length > 240) {
        throw domainErrors.invalid('description', 'deve conter de 1 a 240 caracteres');
      }
      return runKeyed(householdId, options.idempotencyKey, { tool: 'transactions.description.update', args }, async () => {
        const transaction = findTransaction(input.transactionId, householdId);
        if (transaction.kind !== 'expense' && transaction.kind !== 'income') throw domainErrors.unsupported('edição de descrição exige despesa ou receita simples');
        if (transaction.description !== input.expectedDescription) throw domainErrors.transactionDescriptionConflict();
        if (transaction.description === description) throw domainErrors.invalid('description', 'a descrição não foi alterada');
        const cardPurchases = (state as unknown as { _cardPurchases?: Array<{ transactionId?: string }> })._cardPurchases;
        if (cardPurchases?.some((row) => row.transactionId === transaction.id)) throw domainErrors.unsupported('lançamento vinculado a compra no cartão');
        const payables = (state as unknown as { _payables?: Array<{ householdId: string; paidTransactionId?: string }> })._payables;
        if (payables?.some((row) => row.householdId === householdId && row.paidTransactionId === transaction.id)) {
          throw domainErrors.unsupported('lançamento vinculado a pagamento de conta a pagar');
        }
        transaction.description = description;
        return cloneTransaction(transaction);
      });
    },

    async softDeleteTransaction(householdId, id) {
      const tx = findTransaction(id, householdId);
      // V4.1 REVIEWFIX F3: block DELETE of a paid payable's payment effect.
      assertNotLinkedToPaidPayableInState(state, householdId, id);
      if (state.deletedTransactions.has(tx.id)) {
        throw domainErrors.notFound('Lançamento');
      }
      // Restore balance effect (negative-balance rule: only credit-card
      // debit legs keep the zero floor, never a clamp).
      if (tx.kind === 'expense') {
        const acc = findAccount(tx.accountId, householdId);
        acc.balanceCents = Math.min(acc.balanceCents + tx.amountCents, Number.MAX_SAFE_INTEGER);
      } else if (tx.kind === 'income') {
        const acc = findAccount(tx.accountId, householdId);
        assertDebitAllowed(acc.kind, acc.balanceCents, tx.amountCents);
        acc.balanceCents -= tx.amountCents;
      } else if (tx.kind === 'transfer') {
        const from = findAccount(tx.accountId, householdId);
        const to = tx.transferToAccountId
          ? findAccount(tx.transferToAccountId, householdId)
          : null;
        if (to) assertDebitAllowed(to.kind, to.balanceCents, tx.amountCents);
        from.balanceCents = Math.min(from.balanceCents + tx.amountCents, Number.MAX_SAFE_INTEGER);
        if (to) to.balanceCents -= tx.amountCents;
      }
      // Soft delete: tombstone. Read store filters these out.
      state.deletedTransactions.add(tx.id);
      return tx;
    },
  };
};

/**
 * Compose read and write stores over the same in-memory state.
 */
export const createInMemoryStores = (seed?: {
  accounts?: Account[];
  categories?: Category[];
  transactions?: Transaction[];
}): { state: InMemoryState; writes: ReturnType<typeof createInMemoryWriteStore> } => {
  const state: InMemoryState = {
    accounts: seed?.accounts ?? [],
    categories: seed?.categories ?? [],
    transactions: seed?.transactions ?? [],
    deletedTransactions: new Set(),
  };
  return { state, writes: createInMemoryWriteStore(state) };
};
