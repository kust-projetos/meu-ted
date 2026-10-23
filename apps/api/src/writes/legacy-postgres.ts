/**
 * Legacy Postgres write store.
 *
 * Writes to the existing pi_financeiro schema.
 * - transactions use from_account_id / to_account_id
 * - accounts have initial_balance_cents / active boolean
 * - categories have active boolean
 * - soft-delete via deleted_at = NOW()
 * - balances are computed (no stored balance_cents update on write)
 */

import type { Pool, PoolClient } from 'pg';
import type { Account, Category, Transaction } from '../types/domain.js';
import { DEFAULT_CATEGORY_CATALOG } from '../categories/catalog.js';
import { assertCategoryKind, CARD_EXPENSE_KIND_MESSAGE } from '../categories/resolve.js';
import { withTransaction } from '../db/pool.js';
import { domainErrors, DomainError } from './errors.js';
import { assertWorkspaceWritableLegacyInTx } from '../auth/workspace-lifecycle-guard.js';
import { assertCategoryHasNoPersistedReferencesInTx, lockCategoryDeactivationInTx, lockCategoryReferencesInTx } from '../auth/category-lifecycle-guard.js';
import { runKeyedMutation, runKeyedAccountMutation, runKeyedCategoryMutation } from './pending-idempotency.js';
import type { WriteIdempotencyOptions, WriteStore, UpdateAccountOptions, UpdateCategoryOptions, DeactivateCategoryOptions, EditTransactionDescriptionInput, EditTransactionDescriptionOptions } from './store.js';
import type {
  CreateAccountInput, CreateCategoryInput, CreateExpenseInput, CreateIncomeInput,
  CreateTransferInput, DeleteCategoryInput, UpdateAccountInput, UpdateCategoryInput, UpdateTransactionInput,
} from './types.js';

type Row = Record<string, unknown>;

const LEGACY_CATEGORY_COLUMNS =
  'id, household_id, name, kind, active, parent_id, icon, color, sort_order, is_default, is_system';

const mapAccount = (r: Row): Account => ({
  id: r['id'] as string, householdId: r['household_id'] as string, name: r['name'] as string,
  kind: (r['kind'] as string) ? (r['kind'] as Account['kind']) : 'bank',
  balanceCents: Number(r['balance_cents'] ?? 0),
  status: r['active'] ? 'active' : 'inactive',
});
const mapCategory = (r: Row): Category => {
  const parentId = r['parent_id'] as string | null | undefined;
  const base: Category = {
    id: r['id'] as string, householdId: r['household_id'] as string, name: r['name'] as string,
    kind: r['kind'] as Category['kind'], status: r['active'] ? 'active' : 'inactive',
  };
  if (parentId) base.parentId = parentId;
  if (r['icon'] !== null && r['icon'] !== undefined) base.icon = r['icon'] as string;
  if (r['color'] !== null && r['color'] !== undefined) base.color = r['color'] as string;
  if (r['sort_order'] !== null && r['sort_order'] !== undefined) base.sortOrder = Number(r['sort_order']);
  if (r['is_default'] !== null && r['is_default'] !== undefined) base.isDefault = Boolean(r['is_default']);
  if (r['is_system'] !== null && r['is_system'] !== undefined) base.isSystem = Boolean(r['is_system']);
  return base;
};
const mapTransaction = (r: Row): Transaction => {
  const kind = r['kind'] as Transaction['kind'];
  const fromId = r['from_account_id'] as string | null; const toId = r['to_account_id'] as string | null;
  const base: Transaction = { id: r['id'] as string, householdId: r['household_id'] as string, kind, description: (r['description'] ?? '') as string, amountCents: Number(r['amount_cents']), date: (r['date'] as Date).toISOString().slice(0, 10), accountId: '' };
  if (kind === 'expense') base.accountId = fromId ?? '';
  else if (kind === 'income') base.accountId = toId ?? '';
  else { base.accountId = fromId ?? ''; if (toId) base.transferToAccountId = toId; }
  if (r['category_id']) base.categoryId = r['category_id'] as string;
  if (r['subcategory_id']) base.subcategoryId = r['subcategory_id'] as string;
  if (r['notes'] !== null && r['notes'] !== undefined) base.notes = r['notes'] as string;
  return base;
};

/**
 * Centralized subcategory validation for expense/income writes (M-03,
 * legacy schema). Same-household, active, real subcategory with matching
 * kind; when the entry names a distinct parent category, the subcategory
 * must belong to it.
 */
export const resolveSubcategoryLegacy = async (
  client: PoolClient,
  householdId: string,
  subcategoryId: string,
  txKind: 'expense' | 'income',
  parentCategoryId?: string,
): Promise<Category> => {
  const res = await client.query<Row>(
    `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
    [subcategoryId, householdId],
  );
  if (res.rowCount === 0) throw domainErrors.notFound('Subcategoria');
  const sub = mapCategory(res.rows[0]!);
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
 * Category check shared with the legacy CardStore (M-05): existing, active,
 * expense-kind category — the same rule as plain entries.
 *
 * V4.1 Task 2.14: the kind decision is delegated to the central resolver;
 * the legacy lookup stays schema-local (active boolean, no status column).
 */
export const resolveExpenseCategoryLegacy = async (
  client: PoolClient,
  householdId: string,
  categoryId: string,
): Promise<Category> => resolveCategoryLegacy(client, householdId, categoryId, 'expense', CARD_EXPENSE_KIND_MESSAGE);

/**
 * Legacy-schema category validation for a write expecting `expectedKind`.
 * Same 404/400 shapes as the central resolver; the row lookup stays in the
 * legacy shape (household + active + deleted_at filter).
 */
export const resolveCategoryLegacy = async (
  client: PoolClient,
  householdId: string,
  categoryId: string,
  expectedKind: 'expense' | 'income',
  wrongKindMessage?: string,
): Promise<Category> => {
  const res = await client.query<Row>(
    `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
    [categoryId, householdId],
  );
  if (res.rowCount === 0) throw domainErrors.notFound('Categoria');
  const cat = mapCategory(res.rows[0]!);
  return assertCategoryKind(cat, expectedKind, 'categoryId', wrongKindMessage);
};

/**
 * V4.1 REVIEWFIX F3 [major]: legacy twin of the canonical paid-payable
 * link guard — paid_transaction_id exists on the legacy accounts_payable
 * shape too, so direct PATCH/DELETE of the payment effect rejects with
 * 409. The legacy undo clears the column before tombstoning (unaffected).
 */
const assertNotLinkedToPaidPayableLegacy = async (
  client: PoolClient,
  householdId: string,
  transactionId: string,
): Promise<void> => {
  const linked = await client.query(
    `SELECT 1 FROM accounts_payable
      WHERE household_id = $1 AND paid_transaction_id = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [householdId, transactionId],
  );
  if ((linked.rowCount ?? 0) > 0) {
    throw domainErrors.conflict(
      'Lançamento vinculado a conta paga não pode ser alterado; desfaça o pagamento primeiro.',
    );
  }
};

/** H-01: legacy accounts flag cards via is_credit_card (no kind column). */const assertNotCreditCardLegacy = async (
  client: PoolClient,
  householdId: string,
  accountId: string,
  operation: 'compra no cartão deve usar /cards/purchases.' | 'receita não pode usar cartão de crédito.' | 'transferência não pode usar cartão de crédito.',
): Promise<void> => {
  const res = await client.query<Row>(
    `SELECT is_credit_card FROM accounts WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
    [accountId, householdId],
  );
  if (res.rowCount === 0) throw domainErrors.notFound('Conta');
  if (res.rows[0]!['is_credit_card'] === true) {
    throw new DomainError('validation.invalid', operation, 422);
  }
};

/** Idempotent catalog application inside an existing tx (legacy schema). */
const applyDefaultsLegacyInTx = async (
  client: PoolClient,
  householdId: string,
): Promise<{ created: number; skipped: number }> => {
  let created = 0;
  let skipped = 0;
  for (const [macroIdx, macro] of DEFAULT_CATEGORY_CATALOG.entries()) {
    // Race-safe: INSERT ... ON CONFLICT DO NOTHING (functional unique index
    // from V049) + SELECT, mirroring the canonical applyDefaultsInTx. Two
    // concurrent applications converge on the same rows; counts stay exact.
    const ins = await client.query<Row>(
      `INSERT INTO categories (id, household_id, name, kind, active, parent_id, icon, color, sort_order, is_default, is_system)
       VALUES (gen_random_uuid(), $1, $2, $3, true, NULL, $4, $5, $6, true, false)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [householdId, macro.name, macro.kind, macro.icon, macro.color, macroIdx],
    );
    let macroId: string;
    if ((ins.rowCount ?? 0) === 1) {
      macroId = ins.rows[0]!['id'] as string;
      created += 1;
    } else {
      const found = await findActiveCategoryByKey(client, householdId, macro.kind, null, macro.name);
      macroId = found!.id;
      skipped += 1;
    }
    for (const sub of macro.subs) {
      const subIns = await client.query(
        `INSERT INTO categories (id, household_id, name, kind, active, parent_id, icon, color, sort_order, is_default, is_system)
         VALUES (gen_random_uuid(), $1, $2, $3, true, $4, $5, NULL, 0, true, false)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [householdId, sub.name, macro.kind, macroId, sub.icon],
      );
      if ((subIns.rowCount ?? 0) === 1) {
        created += 1;
      } else {
        skipped += 1;
      }
    }
  }
  return { created, skipped };
};

/**
 * Active category lookup by the V049 uniqueness key
 * (household/kind/parent NULL-safe/case-insensitive name). Returns the id,
 * or null when no live row matches. Shared by the upsert SELECT-after-
 * conflict paths below.
 */
const findActiveCategoryByKey = async (
  client: PoolClient,
  householdId: string,
  kind: string,
  parentId: string | null,
  name: string,
): Promise<{ id: string } | null> => {
  const found = await client.query<Row>(
    `SELECT id FROM categories
      WHERE household_id = $1 AND kind = $2
        AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) =
            COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND lower(name) = lower($4)
        AND active = true
      LIMIT 1`,
    [householdId, kind, parentId, name],
  );
  if ((found.rowCount ?? 0) === 0) return null;
  return { id: found.rows[0]!['id'] as string };
};

/**
 * Client-bound legacy expense mutation (no transaction handling): shared
 * by the plain path and the V2 key-idempotent path (record + mutation in
 * the SAME tx, see pending-idempotency.ts). The production VPS runs this
 * legacy schema, so the P1 fix must cover it too.
 */
const createExpenseLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateExpenseInput,
): Promise<Transaction> => {
  await lockCategoryReferencesInTx(client, householdId);
  await assertNotCreditCardLegacy(client, householdId, input.accountId, 'compra no cartão deve usar /cards/purchases.');
  // V4.1 Task 2.15: legacy plain expenses require an existing, active,
  // expense-kind category (was: no category validation at all).
  await resolveExpenseCategoryLegacy(client, householdId, input.categoryId);
  if (input.subcategoryId !== undefined) {
    await resolveSubcategoryLegacy(client, householdId, input.subcategoryId, 'expense', input.categoryId);
  }
  const res = await client.query<Row>(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, from_account_id, category_id, subcategory_id, notes)
     VALUES (gen_random_uuid(), $1, 'expense', $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, household_id, kind, description, amount_cents, date, from_account_id, category_id, subcategory_id, notes`,
    [householdId, input.description, input.amountCents, input.date, input.accountId, input.categoryId, input.subcategoryId ?? null, input.notes ?? null]);
  return mapTransaction(res.rows[0]!);
};

/** Client-bound legacy income mutation (no transaction handling). */
const createIncomeLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateIncomeInput,
): Promise<Transaction> => {
  await lockCategoryReferencesInTx(client, householdId);
  await assertNotCreditCardLegacy(client, householdId, input.accountId, 'receita não pode usar cartão de crédito.');
  // V4.1 Task 2.15: legacy plain income requires an existing, active,
  // income-kind category (was: no category validation at all).
  await resolveCategoryLegacy(client, householdId, input.categoryId, 'income');
  if (input.subcategoryId !== undefined) {
    await resolveSubcategoryLegacy(client, householdId, input.subcategoryId, 'income', input.categoryId);
  }
  const res = await client.query<Row>(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, to_account_id, category_id, subcategory_id, notes)
     VALUES (gen_random_uuid(), $1, 'income', $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, household_id, kind, description, amount_cents, date, to_account_id, category_id, subcategory_id, notes`,
    [householdId, input.description, input.amountCents, input.date, input.accountId, input.categoryId, input.subcategoryId ?? null, input.notes ?? null]);
  return mapTransaction(res.rows[0]!);
};

/**
 * Client-bound legacy transfer mutation (no transaction handling).
 *
 * V4.1 Phase 3 Task 3.2: extracted from the inline store body so keyed
 * route producers can run the effect on the idempotency claim client
 * (single atomic commit) instead of opening an independent transaction.
 */
const createTransferLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateTransferInput,
): Promise<Transaction> => {
  await assertNotCreditCardLegacy(client, householdId, input.fromAccountId, 'transferência não pode usar cartão de crédito.');
  await assertNotCreditCardLegacy(client, householdId, input.toAccountId, 'transferência não pode usar cartão de crédito.');
  const res = await client.query<Row>(
    `INSERT INTO transactions (id, household_id, kind, description, amount_cents, date, from_account_id, to_account_id)
     VALUES (gen_random_uuid(), $1, 'transfer', $2, $3, $4, $5, $6)
     RETURNING id, household_id, kind, description, amount_cents, date, from_account_id, to_account_id`,
    [householdId, input.description, input.amountCents, input.date, input.fromAccountId, input.toAccountId]);
  return mapTransaction(res.rows[0]!);
};

/**
 * Client-bound legacy account creation (no transaction handling): shared by
 * the plain path (own tx) and the V2 key-idempotent path
 * (ted-local.account-idempotency — recovery replays key → account).
 *
 * Exported for round2 PG proofs (legacy error-preclaim runs the helper
 * inside the runner's claim transaction, like the canonical twin).
 */
export const createAccountLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateAccountInput,
): Promise<Account> => {
  await lockCategoryReferencesInTx(client, householdId);
  // Negative-balance rule: only bank/cash may start negative (legacy
  // balances are computed, so no zero floor exists to remove here).
  // The kind check guards direct store callers; the route schema
  // already limits kind to bank|cash.
  if ((input.kind as string) === 'credit_card' && input.initialBalanceCents < 0) {
    throw domainErrors.invalid('initialBalanceCents', 'cartão de crédito não pode iniciar com saldo negativo');
  }
  // Round2 achado 2 — mesma serialização + guarda do núcleo canônico,
  // na forma legada (active boolean em vez de status). Sem migration.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`v2.accounts.create:${householdId}`]);
  const duplicate = await client.query(
    `SELECT 1 FROM accounts
       WHERE household_id = $1 AND active = true AND lower(name) = lower($2)
       LIMIT 1`,
    [householdId, input.name],
  );
  if ((duplicate.rowCount ?? 0) > 0) throw domainErrors.inUse('Conta', 'nome duplicado');
  const res = await client.query<Row>(
    `INSERT INTO accounts (id, household_id, name, initial_balance_cents, active)
     VALUES (gen_random_uuid(), $1, $2, $3, true)
     RETURNING id, household_id, name, initial_balance_cents, active`,
    [householdId, input.name, input.initialBalanceCents]);
  const existing = await client.query(
    `SELECT 1 FROM categories WHERE household_id = $1 AND active = true AND deleted_at IS NULL LIMIT 1`,
    [householdId]);
  if ((existing.rowCount ?? 0) === 0) {
    await applyDefaultsLegacyInTx(client, householdId);
  }
  const r = res.rows[0]!;
  return { ...mapAccount({ ...r, balance_cents: input.initialBalanceCents }), kind: input.kind };
};

/**
 * Rename-only legacy account mutation (V2 `accounts.update`, ADR-029):
 * legacy twin of `renameAccountInTx` — row lock, active-only, exact
 * `expectedName` before-condition inside the effect transaction, no-op when
 * the name already matches. Legacy accounts carry no kind column (mapped as
 * bank), so the kind gate is a no-op here by shape parity.
 *
 * Exported for round PG proofs (same pattern as createAccountLegacyInTx).
 */
export const renameAccountLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  input: { accountId: string; name: string; expectedName: string },
): Promise<Account> => {
  // Lifecycle compatível com o schema legado (fail-closed explicado quando
  // o schema não o suporta). Roda ANTES do row lock, como no canônico.
  await assertWorkspaceWritableLegacyInTx(client, householdId);
  const res = await client.query<Row>(
    `SELECT id, household_id, name, initial_balance_cents, active, is_credit_card
       FROM accounts
      WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [input.accountId, householdId],
  );
  if ((res.rowCount ?? 0) === 0) throw domainErrors.notFound('Conta');
  // Cartão é discriminado pelo MESMO SELECT sob lock: o mapeador legado
  // sempre diz 'bank' (sem coluna kind), então a checagem lê a flag crua.
  // Qualquer forma truthy legada rejeita (equivale a IS NOT TRUE).
  const rawCard: unknown = res.rows[0]!['is_credit_card'];
  if (rawCard) {
    throw domainErrors.invalid('accountId', 'renomear exige conta bank/cash ativa');
  }
  // Mesma forma do update legado: saldo computado — só nome/active importam.
  const current = mapAccount(res.rows[0]!);
  if (current.status !== 'active') throw domainErrors.notFound('Conta');
  if (current.name !== input.expectedName) throw domainErrors.nameConflict();
  if (current.name === input.name) return current;
  const upd = await client.query<Row>(
    `UPDATE accounts SET name = $3
      WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL
     RETURNING id, household_id, name, initial_balance_cents, active`,
    [input.accountId, householdId, input.name],
  );
  if ((upd.rowCount ?? 0) === 0) throw domainErrors.notFound('Conta');
  return mapAccount(upd.rows[0]!);
};

/**
 * Rename-only legacy category mutation (V2 `categories.update`, name-only):
 * legacy twin of `renameCategoryInTx`.
 */
export const renameCategoryLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  input: { categoryId: string; name: string; expectedName: string },
): Promise<Category> => {
  await assertWorkspaceWritableLegacyInTx(client, householdId);
  await lockCategoryReferencesInTx(client, householdId);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`v2.categories.create:${householdId}`]);
  const res = await client.query<Row>(
    `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [input.categoryId, householdId],
  );
  if ((res.rowCount ?? 0) === 0) throw domainErrors.notFound('Categoria');
  const cat = mapCategory(res.rows[0]!);
  if (cat.status !== 'active') throw domainErrors.notFound('Categoria');
  if (cat.parentId) {
    const parentRes = await client.query<Row>(
      `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
      [cat.parentId, householdId],
    );
    if ((parentRes.rowCount ?? 0) === 0) throw domainErrors.notFound('Categoria pai');
    const parent = mapCategory(parentRes.rows[0]!);
    if (parent.parentId) throw domainErrors.invalid('parentId', 'subcategoria nao pode ter subcategoria');
    if (parent.kind !== cat.kind) throw domainErrors.invalid('parentId', 'categoria pai deve ter o mesmo kind');
  }
  if (cat.name !== input.expectedName) throw domainErrors.categoryNameConflict();
  if (cat.name === input.name) return cat;
  const dup = await client.query(
    `SELECT 1 FROM categories
      WHERE household_id = $1 AND kind = $2
        AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) =
            COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND lower(name) = lower($4)
        AND active = true AND deleted_at IS NULL
        AND id <> $5
      LIMIT 1`,
    [householdId, cat.kind, cat.parentId ?? null, input.name, cat.id],
  );
  if ((dup.rowCount ?? 0) > 0) throw domainErrors.inUse('Categoria', 'nome duplicado');
  try {
    const upd = await client.query<Row>(
      `UPDATE categories SET name = $3
        WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL
       RETURNING ${LEGACY_CATEGORY_COLUMNS}`,
      [input.categoryId, householdId, input.name],
    );
    if ((upd.rowCount ?? 0) === 0) throw domainErrors.notFound('Categoria');
    return mapCategory(upd.rows[0]!);
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw domainErrors.inUse('Categoria', 'nome duplicado');
    throw err;
  }
};

/**
 * Client-bound legacy category creation (no transaction handling): shared by
 * the plain path (own tx) and the V2 keyed foundation
 * (categories-create-api — recovery replays key → category).
 *
 * Exported for round PG proofs (same pattern as createAccountLegacyInTx).
 */
export const createCategoryLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateCategoryInput,
): Promise<Category> => {
  await lockCategoryReferencesInTx(client, householdId);
  if (input.parentId) {
    const parentRes = await client.query<Row>(
      `SELECT id, household_id, name, kind, active, parent_id FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
      [input.parentId, householdId],
    );
    if (parentRes.rowCount === 0) throw domainErrors.notFound('Categoria pai');
    const parent = mapCategory(parentRes.rows[0]!);
    if (parent.parentId) throw domainErrors.invalid('parentId', 'subcategoria não pode ter subcategoria');
    if (parent.kind !== input.kind) {
      throw domainErrors.invalid('parentId', 'categoria pai deve ter o mesmo kind');
    }
  }
  // Race-safe (M-02 on legacy): INSERT ... ON CONFLICT DO NOTHING on
  // the V049 functional unique index + SELECT. A concurrent duplicate
  // reuses the existing live row instead of duplicating it — same
  // return shape either way.
  const res = await client.query<Row>(
    `INSERT INTO categories (id, household_id, name, kind, active, parent_id, icon, color, sort_order, is_default, is_system)
     VALUES (gen_random_uuid(), $1, $2, $3, true, $4, $5, $6, $7, $8, false)
     ON CONFLICT DO NOTHING
     RETURNING ${LEGACY_CATEGORY_COLUMNS}`,
    [
      householdId,
      input.name,
      input.kind,
      input.parentId ?? null,
      input.icon ?? null,
      input.color ?? null,
      input.sortOrder ?? 0,
      input.isDefault ?? false,
    ]);
  if ((res.rowCount ?? 0) === 1) return mapCategory(res.rows[0]!);
  const existing = await client.query<Row>(
    `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories
      WHERE household_id = $1 AND kind = $2
        AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) =
            COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND lower(name) = lower($4)
        AND active = true
      LIMIT 1`,
    [householdId, input.kind, input.parentId ?? null, input.name],
  );
  if ((existing.rowCount ?? 0) === 0) throw domainErrors.inUse('Categoria', 'nome duplicado');
  return mapCategory(existing.rows[0]!);
};

/**
 * Client-bound legacy category creation for the KEYED path only: same parent
 * guards as the unkeyed helper, but a duplicate (household/kind/parent/name,
 * same scope as canonical `assertCategoryNameFree`) fails closed with 409
 * `in_use` instead of reusing the other key's row — each key owns exactly
 * its own effect. Serialized per household via transaction-scoped advisory
 * lock (parity with canonical `createCategoryInTx`; no migration), so a
 * distinct-key race converges to 1 winner + N-1 `in_use` on any schema.
 *
 * The UNKEYED helper above is intentionally untouched: its ON CONFLICT
 * reuse behavior is deployment compatibility (V049 index on real legacy
 * deployments) and must not change with the keyed foundation.
 *
 * Exported for round PG proofs (same pattern as createAccountLegacyInTx).
 */
export const createCategoryLegacyKeyedInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateCategoryInput,
): Promise<Category> => {
  await lockCategoryReferencesInTx(client, householdId);
  if (input.parentId) {
    const parentRes = await client.query<Row>(
      `SELECT id, household_id, name, kind, active, parent_id FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
      [input.parentId, householdId],
    );
    if (parentRes.rowCount === 0) throw domainErrors.notFound('Categoria pai');
    const parent = mapCategory(parentRes.rows[0]!);
    if (parent.parentId) throw domainErrors.invalid('parentId', 'subcategoria não pode ter subcategoria');
    if (parent.kind !== input.kind) {
      throw domainErrors.invalid('parentId', 'categoria pai deve ter o mesmo kind');
    }
  }
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`v2.categories.create:${householdId}`]);
  const duplicate = await client.query(
    `SELECT 1 FROM categories
      WHERE household_id = $1 AND kind = $2
        AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) =
            COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND lower(name) = lower($4)
        AND active = true AND deleted_at IS NULL
      LIMIT 1`,
    [householdId, input.kind, input.parentId ?? null, input.name],
  );
  if ((duplicate.rowCount ?? 0) > 0) throw domainErrors.inUse('Categoria', 'nome duplicado');
  const res = await client.query<Row>(
    `INSERT INTO categories (id, household_id, name, kind, active, parent_id, icon, color, sort_order, is_default, is_system)
     VALUES (gen_random_uuid(), $1, $2, $3, true, $4, $5, $6, $7, $8, false)
     RETURNING ${LEGACY_CATEGORY_COLUMNS}`,
    [
      householdId,
      input.name,
      input.kind,
      input.parentId ?? null,
      input.icon ?? null,
      input.color ?? null,
      input.sortOrder ?? 0,
      input.isDefault ?? false,
    ],
  );
  return mapCategory(res.rows[0]!);
};

/**
 * Client-bound legacy reversals (no transaction handling).
 * FIX-UNDO-LEGACY: lets the undo reversals join the idempotency claim tx
 * instead of opening independent transactions — the same pattern as the
 * canonical `*InTx` helpers in writes/postgres.ts.
 */
const deactivateAccountLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  id: string,
): Promise<Account> => {
  const used = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM transactions WHERE household_id = $1 AND deleted_at IS NULL AND (from_account_id = $2 OR to_account_id = $2)`, [householdId, id]);
  if (Number(used.rows[0]!.count) > 0) throw domainErrors.inUse('Conta', 'lançamentos');
  const res = await client.query<Row>(
    `UPDATE accounts SET active = false, deleted_at = NOW() WHERE id = $1 AND household_id = $2 RETURNING id, household_id, name, initial_balance_cents, active`, [id, householdId]);
  if (res.rowCount === 0) throw domainErrors.notFound('Conta');
  return mapAccount(res.rows[0]!);
};

const deactivateCategoryLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  id: string,
  expectedName?: string,
): Promise<Category> => {
  await lockCategoryDeactivationInTx(client, householdId);
  const existing = await client.query<Row>(
    `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL FOR UPDATE`,
    [id, householdId],
  );
  if ((existing.rowCount ?? 0) === 0) throw domainErrors.notFound('Categoria');
  if (expectedName !== undefined && mapCategory(existing.rows[0]!).name !== expectedName) throw domainErrors.categoryNameConflict();
  await assertCategoryHasNoPersistedReferencesInTx(client, householdId, id);
  const res = await client.query<Row>(
    `UPDATE categories SET active = false, deleted_at = NOW() WHERE id = $1 AND household_id = $2 RETURNING ${LEGACY_CATEGORY_COLUMNS}`, [id, householdId]);
  if (res.rowCount === 0) throw domainErrors.notFound('Categoria');
  return mapCategory(res.rows[0]!);
};

const softDeleteTransactionLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  id: string,
): Promise<Transaction> => {
  // V4.1 REVIEWFIX F3: same paid-payable link guard as canonical — the
  // legacy schema carries paid_transaction_id too.
  await assertNotLinkedToPaidPayableLegacy(client, householdId, id);
  const res = await client.query<Row>(
    `UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL
     RETURNING id, household_id, kind, description, amount_cents, date, from_account_id, to_account_id, category_id`,
    [id, householdId]);
  if (res.rowCount === 0) throw domainErrors.notFound('Lançamento');
  return mapTransaction(res.rows[0]!);
};

/**
 * Client-bound legacy transaction patch (no transaction handling).
 *
 * V4.1 Phase 3 Task 3.2: extracted verbatim from the inline store body so
 * keyed route producers can run the effect on the idempotency claim client
 * (single atomic commit) instead of opening an independent transaction.
 */
const updateTransactionLegacyInTx = async (
  client: PoolClient,
  householdId: string,
  id: string,
  patch: UpdateTransactionInput,
): Promise<Transaction> => {
  if (patch.categoryId !== undefined || patch.subcategoryId !== undefined) {
    await lockCategoryReferencesInTx(client, householdId);
  }
  // V4.1 SPEC §9.7: legacy applies the same PATCH contract as canonical —
  // description/date/amountCents/accountId/categoryId/subcategoryId/notes
  // on expense/income, description/date only on transfer. Unknown keys
  // never reach the store (route-level .strict() → 422).
  const existing = await client.query<Row>(
    `SELECT id, household_id, kind, description, amount_cents, date, from_account_id, to_account_id, category_id, subcategory_id, notes
       FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL`, [id, householdId]);
  if (existing.rowCount === 0) throw domainErrors.notFound('Lançamento');
  // V4.1 REVIEWFIX F3: block PATCH of a paid payable's payment effect.
  await assertNotLinkedToPaidPayableLegacy(client, householdId, id);
  const current = existing.rows[0]!;
  const txKind = current['kind'] as 'expense' | 'income' | 'transfer';
  if (txKind === 'transfer') {
    if (
      patch.amountCents !== undefined ||
      patch.accountId !== undefined ||
      patch.categoryId !== undefined ||
      patch.subcategoryId !== undefined ||
      patch.notes !== undefined
    ) {
      throw new DomainError(
        'unsupported',
        'Operação não suportada: transferências só podem ter descrição e data alteradas.',
        422,
      );
    }
    if (patch.description === undefined && patch.date === undefined) return mapTransaction(current);
    const res = await client.query<Row>(
      `UPDATE transactions SET description = COALESCE($3, description), date = COALESCE($4, date)
       WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL
       RETURNING id, household_id, kind, description, amount_cents, date, from_account_id, to_account_id, category_id, subcategory_id, notes`,
      [id, householdId, patch.description ?? null, patch.date ?? null]);
    if (res.rowCount === 0) throw domainErrors.notFound('Lançamento');
    return mapTransaction(res.rows[0]!);
  }
  if (patch.description === undefined && patch.date === undefined && patch.amountCents === undefined && patch.accountId === undefined && patch.categoryId === undefined && patch.subcategoryId === undefined && patch.notes === undefined) {
    return mapTransaction(current);
  }
  if (patch.amountCents !== undefined && patch.amountCents <= 0) {
    throw domainErrors.invalid('amountCents', 'deve ser maior que zero');
  }
  if (patch.accountId !== undefined) {
    const acc = await client.query<Row>(
      `SELECT id FROM accounts WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
      [patch.accountId, householdId]);
    if (acc.rowCount === 0) throw domainErrors.notFound('Conta');
  }
  if (patch.categoryId !== undefined) {
    // V4.1 Task 2.15: the new category must exist, be active in the
    // household, and match the entry kind (this branch only runs for
    // expense/income — transfers reject categoryId with 422 above).
    await resolveCategoryLegacy(client, householdId, patch.categoryId, txKind);
  }
  if (patch.subcategoryId !== undefined) {
    const parentId = patch.categoryId ?? (current['category_id'] as string | undefined);
    await resolveSubcategoryLegacy(client, householdId, patch.subcategoryId, txKind, parentId);
  }
  const accountColumn = txKind === 'expense' ? 'from_account_id' : 'to_account_id';
  const res = await client.query<Row>(
    `UPDATE transactions SET description = COALESCE($3, description), date = COALESCE($4, date), amount_cents = COALESCE($5, amount_cents), subcategory_id = COALESCE($6, subcategory_id), notes = COALESCE($7, notes), category_id = COALESCE($8, category_id), ${accountColumn} = COALESCE($9, ${accountColumn})
     WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL
     RETURNING id, household_id, kind, description, amount_cents, date, from_account_id, to_account_id, category_id, subcategory_id, notes`,
    [id, householdId, patch.description ?? null, patch.date ?? null, patch.amountCents ?? null, patch.subcategoryId ?? null, patch.notes ?? null, patch.categoryId ?? null, patch.accountId ?? null]);
  if (res.rowCount === 0) throw domainErrors.notFound('Lançamento');
  return mapTransaction(res.rows[0]!);
};

export const editTransactionDescriptionLegacyInTx = async (client: PoolClient, householdId: string, input: EditTransactionDescriptionInput): Promise<Transaction> => {
  await assertWorkspaceWritableLegacyInTx(client, householdId);
  const selected = await client.query<Row>(
    `SELECT id, household_id, kind, description, amount_cents, date, from_account_id, to_account_id, category_id, subcategory_id, notes,
            statement_id, statement_payment_id, installments_total, installment_number, is_credit_card_purchase
       FROM transactions WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [input.transactionId, householdId],
  );
  if (!selected.rowCount) throw domainErrors.notFound('Lançamento');
  const row = selected.rows[0]!;
  const transaction = mapTransaction(row);
  if (transaction.kind !== 'expense' && transaction.kind !== 'income') throw domainErrors.unsupported('edição de descrição exige despesa ou receita simples');
  if (row['is_credit_card_purchase'] === true || row['statement_id'] != null || row['statement_payment_id'] != null || row['installments_total'] != null || row['installment_number'] != null) throw domainErrors.unsupported('lançamento vinculado a fatura, parcela ou pagamento');
  const card = await client.query(`SELECT 1 FROM card_purchases WHERE transaction_id = $1 AND (household_id = $2 OR household_id IS NULL) LIMIT 1`, [transaction.id, householdId]);
  if ((card.rowCount ?? 0) > 0) throw domainErrors.unsupported('lançamento vinculado a compra no cartão');
  const payable = await client.query(`SELECT 1 FROM accounts_payable WHERE household_id = $1 AND paid_transaction_id = $2 LIMIT 1`, [householdId, transaction.id]);
  if ((payable.rowCount ?? 0) > 0) throw domainErrors.unsupported('lançamento vinculado a pagamento de conta a pagar');
  if (transaction.description !== input.expectedDescription) throw domainErrors.transactionDescriptionConflict();
  const description = input.description.trim();
  if (transaction.description === description) throw domainErrors.invalid('description', 'a descrição não foi alterada');
  const updated = await client.query<Row>(
    `UPDATE transactions SET description = $3, updated_at = NOW()
      WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL AND description = $4
      RETURNING id, household_id, kind, description, amount_cents, date, from_account_id, to_account_id, category_id, subcategory_id, notes`,
    [input.transactionId, householdId, description, input.expectedDescription],
  );
  if (!updated.rowCount) throw domainErrors.transactionDescriptionConflict();
  return mapTransaction(updated.rows[0]!);
};

export const createLegacyPostgresWriteStore = (opts: { pool: Pool }): WriteStore => {
  const { pool } = opts;

  const store: WriteStore = {
    async createAccount(householdId: string, input: CreateAccountInput, options?: WriteIdempotencyOptions) {
      if (options?.idempotencyKey === undefined) {
        return withTransaction(pool, async (client: PoolClient) =>
          createAccountLegacyInTx(client, householdId, input));
      }
      // ted-local.account-idempotency: V2 recovery replays key → account.
      // Audit legs stay transaction-only — account callers never audit.
      return runKeyedAccountMutation({
        pool,
        householdId,
        idempotencyKey: options.idempotencyKey,
        payload: input,
        mutate: (client) => createAccountLegacyInTx(client, householdId, input),
      });
    },
    async updateAccount(householdId: string, id: string, patch: UpdateAccountInput, options?: UpdateAccountOptions) {
      if (options?.idempotencyKey === undefined) {
        return withTransaction(pool, async (client: PoolClient) => {
          const res = await client.query<Row>(
            `UPDATE accounts SET name = COALESCE($3, name) WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL
            RETURNING id, household_id, name, initial_balance_cents, active`, [id, householdId, patch.name ?? null]);
          if (res.rowCount === 0) throw domainErrors.notFound('Conta');
          return mapAccount(res.rows[0]!);
        });
      }
      // Rename-only V2 path (ADR-029): keyed replay + atomic before-condition.
      if (options.expectedName === undefined || patch.name === undefined) {
        throw domainErrors.invalid('expectedName', 'renomeação V2 exige expectedName e name');
      }
      const args = { accountId: id, name: patch.name, expectedName: options.expectedName };
      return runKeyedAccountMutation({
        pool,
        householdId,
        idempotencyKey: options.idempotencyKey,
        payload: { tool: 'accounts.update' as const, args },
        mutate: (client) => renameAccountLegacyInTx(client, householdId, args),
      });
    },
    async deactivateAccount(householdId: string, id: string) {
      return withTransaction(pool, async (client: PoolClient) =>
        deactivateAccountLegacyInTx(client, householdId, id));
    },

    async createCategory(householdId: string, input: CreateCategoryInput, options?: WriteIdempotencyOptions) {
      if (options?.idempotencyKey === undefined) {
        // Unkeyed legado: comportamento de compatibilidade intocado
        // (ON CONFLICT + reaproveitamento conforme o índice do deployment).
        return withTransaction(pool, async (client: PoolClient) =>
          createCategoryLegacyInTx(client, householdId, input));
      }
      // Keyed: cada chave possui seu efeito; duplicado de outra chave é
      // 409 in_use (nunca reaproveita a linha alheia). Sem audit.
      return runKeyedCategoryMutation({
        pool,
        householdId,
        idempotencyKey: options.idempotencyKey,
        payload: input,
        mutate: (client) => createCategoryLegacyKeyedInTx(client, householdId, input),
      });
    },
    async updateCategory(householdId: string, id: string, patch: UpdateCategoryInput, options?: UpdateCategoryOptions) {
      if (options?.idempotencyKey === undefined) {
        return withTransaction(pool, async (client: PoolClient) => {
          const res = await client.query<Row>(
            `UPDATE categories
                SET name = COALESCE($3, name),
                    icon = COALESCE($4, icon),
                    color = COALESCE($5, color),
                    sort_order = COALESCE($6, sort_order),
                    is_default = COALESCE($7, is_default)
              WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL
             RETURNING ${LEGACY_CATEGORY_COLUMNS}`,
            [
              id,
              householdId,
              patch.name ?? null,
              patch.icon ?? null,
              patch.color ?? null,
              patch.sortOrder ?? null,
              patch.isDefault ?? null,
            ]);
          if (res.rowCount === 0) throw domainErrors.notFound('Categoria');
          return mapCategory(res.rows[0]!);
        });
      }
      if (patch.icon !== undefined || patch.color !== undefined || patch.sortOrder !== undefined || patch.isDefault !== undefined) {
        throw domainErrors.invalid('patch', 'renomeacao V2 aceita apenas name');
      }
      if (options.expectedName === undefined || patch.name === undefined) {
        throw domainErrors.invalid('expectedName', 'renomeacao V2 exige expectedName e name');
      }
      const args = { categoryId: id, name: patch.name, expectedName: options.expectedName };
      return runKeyedCategoryMutation({
        pool,
        householdId,
        idempotencyKey: options.idempotencyKey,
        payload: { tool: 'categories.update' as const, args },
        mutate: (client) => renameCategoryLegacyInTx(client, householdId, args),
      });
    },
    async deactivateCategory(householdId: string, id: string, options?: DeactivateCategoryOptions) {
      if (options?.idempotencyKey === undefined) return withTransaction(pool, (client: PoolClient) => deactivateCategoryLegacyInTx(client, householdId, id));
      if (typeof options.expectedName !== 'string' || options.expectedName.trim() === '') throw domainErrors.invalid('expectedName', 'desativacao V2 exige expectedName');
      const args = { categoryId: id, expectedName: options.expectedName };
      return runKeyedCategoryMutation({ pool, householdId, idempotencyKey: options.idempotencyKey, payload: { tool: 'categories.deactivate' as const, args }, mutate: (client) => deactivateCategoryLegacyInTx(client, householdId, id, options.expectedName) });
    },
    async deleteCategory(householdId: string, id: string, input: DeleteCategoryInput) {
      return withTransaction(pool, async (client: PoolClient) => {
        const catRes = await client.query<Row>(
          `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
          [id, householdId]);
        if (catRes.rowCount === 0) throw domainErrors.notFound('Categoria');
        const cat = mapCategory(catRes.rows[0]!);
        const subs = await client.query<Row>(
          `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories WHERE household_id = $1 AND parent_id = $2 AND active = true AND deleted_at IS NULL`,
          [householdId, id]);
        const scopeIds = [id, ...subs.rows.map((r) => r['id'] as string)];
        const referencing = await client.query<Row>(
          `SELECT id FROM transactions WHERE household_id = $1 AND deleted_at IS NULL AND (category_id = ANY($2) OR subcategory_id = ANY($2))`,
          [householdId, scopeIds]);
        let movedTransactions = 0;
        let softDeletedTransactions = 0;
        if (input.mode === 'move') {
          if (!input.destinationCategoryId) {
            throw domainErrors.invalid('destinationCategoryId', 'destino é obrigatório no modo move');
          }
          const destRes = await client.query<Row>(
            `SELECT ${LEGACY_CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND household_id = $2 AND active = true AND deleted_at IS NULL`,
            [input.destinationCategoryId, householdId]);
          if (destRes.rowCount === 0) throw domainErrors.notFound('Categoria de destino');
          const dest = mapCategory(destRes.rows[0]!);
          if (dest.kind !== cat.kind) {
            throw domainErrors.invalid('destinationCategoryId', 'destino deve ter o mesmo kind');
          }
          if (scopeIds.includes(dest.id)) {
            throw domainErrors.invalid('destinationCategoryId', 'destino não pode ser a categoria excluída');
          }
          await client.query(
            `UPDATE transactions SET category_id = $3 WHERE household_id = $1 AND deleted_at IS NULL AND category_id = ANY($2)`,
            [householdId, scopeIds, dest.id]);
          await client.query(
            `UPDATE transactions SET subcategory_id = NULL WHERE household_id = $1 AND deleted_at IS NULL AND subcategory_id = ANY($2)`,
            [householdId, scopeIds]);
          movedTransactions = referencing.rowCount ?? 0;
        } else {
          if (input.confirm !== true) {
            throw domainErrors.invalid('confirm', 'exclusão em cascata exige confirm:true');
          }
          await client.query(
            `UPDATE transactions SET deleted_at = NOW() WHERE household_id = $1 AND deleted_at IS NULL AND (category_id = ANY($2) OR subcategory_id = ANY($2))`,
            [householdId, scopeIds]);
          softDeletedTransactions = referencing.rowCount ?? 0;
        }
        await client.query(
          `UPDATE categories SET active = false, deleted_at = NOW() WHERE household_id = $1 AND id = ANY($2)`,
          [householdId, scopeIds]);
        return { deletedCategoryIds: scopeIds, movedTransactions, softDeletedTransactions };
      });
    },
    async applyCategoryDefaults(householdId: string) {
      return withTransaction(pool, async (client: PoolClient) => {
        await lockCategoryReferencesInTx(client, householdId);
        return applyDefaultsLegacyInTx(client, householdId);
      });
    },

    async createExpense(householdId: string, input: CreateExpenseInput, options?: WriteIdempotencyOptions) {
      if (input.amountCents <= 0) throw domainErrors.invalid('amountCents', 'deve ser maior que zero');
      if (options?.idempotencyKey === undefined) {
        return withTransaction(pool, async (client: PoolClient) => createExpenseLegacyInTx(client, householdId, input));
      }
      return runKeyedMutation({
        pool,
        householdId,
        idempotencyKey: options.idempotencyKey,
        payload: input,
        mutate: (client) => createExpenseLegacyInTx(client, householdId, input),
        ...(options.audit ? { audit: { ...options.audit, schema: 'legacy' as const } } : {}),
      });
    },
    async createIncome(householdId: string, input: CreateIncomeInput, options?: WriteIdempotencyOptions) {
      if (input.amountCents <= 0) throw domainErrors.invalid('amountCents', 'deve ser maior que zero');
      if (options?.idempotencyKey === undefined) {
        return withTransaction(pool, async (client: PoolClient) => createIncomeLegacyInTx(client, householdId, input));
      }
      return runKeyedMutation({
        pool,
        householdId,
        idempotencyKey: options.idempotencyKey,
        payload: input,
        mutate: (client) => createIncomeLegacyInTx(client, householdId, input),
        ...(options.audit ? { audit: { ...options.audit, schema: 'legacy' as const } } : {}),
      });
    },
    async createTransfer(householdId: string, input: CreateTransferInput) {
      if (input.amountCents <= 0) throw domainErrors.invalid('amountCents', 'deve ser maior que zero');
      if (input.fromAccountId === input.toAccountId) throw domainErrors.invalid('toAccountId', 'deve ser diferente');
      return withTransaction(pool, async (client: PoolClient) =>
        createTransferLegacyInTx(client, householdId, input));
    },
    async updateTransaction(householdId: string, id: string, patch: UpdateTransactionInput) {
      return withTransaction(pool, async (client: PoolClient) =>
        updateTransactionLegacyInTx(client, householdId, id, patch));
    },
    async editTransactionDescription(householdId: string, input, options: EditTransactionDescriptionOptions) {
      const copied = { transactionId: input.transactionId, description: input.description, expectedDescription: input.expectedDescription };
      if (typeof options?.idempotencyKey !== 'string' || options.idempotencyKey.length === 0) throw domainErrors.required('Idempotency-Key');
      if (typeof options.actorId !== 'string' || options.actorId.length === 0) throw domainErrors.required('actorId');
      const description = copied.description.trim();
      if (description.length < 1 || description.length > 240 || copied.expectedDescription.length < 1 || copied.expectedDescription.length > 240) throw domainErrors.invalid('description', 'deve conter de 1 a 240 caracteres');
      return runKeyedMutation({ pool, householdId, idempotencyKey: options.idempotencyKey,
        payload: { tool: 'transactions.description.update' as const, args: copied },
        audit: { operation: 'transaction.update', actorId: options.actorId, schema: 'legacy', idempotencyKey: options.idempotencyKey, beforeDescription: copied.expectedDescription, afterDescription: description },
        mutate: (client) => editTransactionDescriptionLegacyInTx(client, householdId, copied) });
    },
    async softDeleteTransaction(householdId: string, id: string) {
      return withTransaction(pool, async (client: PoolClient) =>
        softDeleteTransactionLegacyInTx(client, householdId, id));
    },
  };
  // FIX-UNDO-LEGACY (Fase 3 V4, SPEC §12 F3 opção 1): expose the
  // client-bound reversals as non-contractual extensions under the SAME
  // names as the canonical store (see PostgresReversalTxExtensions). The
  // undo service duck-types these and runs the reversal on the claim-tx
  // client, so claim + legacy reversal + completion commit atomically.
  // Legacy balances are computed, so the legacy soft-delete is a bare
  // tombstone (no balance restore). The declared factory return type stays
  // WriteStore, so existing callers are unaffected.
  return Object.assign(store, {
    softDeleteTransactionInTx: softDeleteTransactionLegacyInTx,
    deactivateAccountInTx: deactivateAccountLegacyInTx,
    deactivateCategoryInTx: deactivateCategoryLegacyInTx,
    // V4.1 Phase 3 Task 3.2: same member names as the canonical
    // WriteStoreMutationTxExtensions (see writes/postgres.ts) so keyed
    // route producers join the claim tx on EITHER schema. Balances stay
    // computed on legacy (bare tombstone), as before.
    createExpenseInTx: createExpenseLegacyInTx,
    createIncomeInTx: createIncomeLegacyInTx,
    createTransferInTx: createTransferLegacyInTx,
    updateTransactionInTx: updateTransactionLegacyInTx,
  });
};
