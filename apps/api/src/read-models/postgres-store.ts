/**
 * Postgres implementation of ReadModelStore.
 *
 * Schema lives in `sql/V001__init.sql`. Connection is provided by the
 * caller (we accept a Pool to keep this module easy to test). The store
 * builds parameterized SQL for every filter and always scopes by the
 * householdId the caller passes — server-side derivation lives in the
 * route layer, so this layer never trusts client-supplied ids.
 */

import type { Pool, PoolClient } from 'pg';
import type { Account, Category, Transaction, TransactionFilters } from '../types/domain.js';
import type { ReadModelStore } from './store.js';
import { transactionFiltersSchema, type ParsedTransactionFilters } from '../types/transactions.js';

type Row = Record<string, unknown>;

const mapAccount = (r: Row): Account => ({
  id: r['id'] as string,
  householdId: r['household_id'] as string,
  name: r['name'] as string,
  kind: r['kind'] as Account['kind'],
  balanceCents: Number(r['balance_cents']),
  status: r['status'] as Account['status'],
});

const mapCategory = (r: Row): Category => {
  const parentId = r['parent_id'] as string | null | undefined;
  const base: Category = {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    name: r['name'] as string,
    kind: r['kind'] as Category['kind'],
    status: r['status'] as Category['status'],
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
  const base: Transaction = {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    kind: r['kind'] as Transaction['kind'],
    description: r['description'] as string,
    amountCents: Number(r['amount_cents']),
    date: (r['date'] as Date).toISOString().slice(0, 10),
    accountId: r['account_id'] as string,
  };
  const cat = r['category_id'];
  const sub = r['subcategory_id'];
  const to = r['transfer_to_account_id'];
  if (cat !== null && cat !== undefined) {
    base.categoryId = cat as string;
  }
  if (sub !== null && sub !== undefined) {
    base.subcategoryId = sub as string;
  }
  if (to !== null && to !== undefined) {
    base.transferToAccountId = to as string;
  }
  const notes = r['notes'];
  if (notes !== null && notes !== undefined) {
    base.notes = notes as string;
  }
  return base;
};

export const createPostgresReadModelStore = (opts: { pool: Pool }): ReadModelStore => {
  const { pool } = opts;

  const query = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> => {
    const res = await pool.query<R>(text, values);
    return res.rows;
  };

  return {
    async listAccounts(householdId, options) {
      // A08: `includeInactive` drops ONLY the `status = 'active'` predicate.
      // `household_id` stays the first bind and the card/soft-delete
      // exclusions stay put, so the opt-in can never widen the workspace or
      // turn the generic account surface into a card surface. The fragment is
      // a literal chosen by a boolean - never interpolated input.
      const activeFilter = options?.includeInactive === true ? '' : "AND status = 'active'";
      const rows = await query<Row>(
        `SELECT id, household_id, name, kind, balance_cents, status
           FROM accounts
          WHERE household_id = $1
            ${activeFilter}
            AND kind <> 'credit_card'
            AND deleted_at IS NULL`,
        [householdId],
      );
      return rows.map(mapAccount);
    },

    async listCategories(householdId) {
      const rows = await query<Row>(
        `SELECT id, household_id, name, kind, status, parent_id,
                icon, color, sort_order, is_default, is_system
           FROM categories
          WHERE household_id = $1
            AND status = 'active'
            AND deleted_at IS NULL`,
        [householdId],
      );
      return rows.map(mapCategory);
    },

    async listTransactions(householdId, filters) {
      const parsed: ParsedTransactionFilters = transactionFiltersSchema.parse(filters);

      // Build a clean object with only defined keys (exactOptionalPropertyTypes).
      const clean: TransactionFilters = {};
      if (parsed.startDate !== undefined) clean.startDate = parsed.startDate;
      if (parsed.endDate !== undefined) clean.endDate = parsed.endDate;
      if (parsed.accountId !== undefined) clean.accountId = parsed.accountId;
      if (parsed.categoryId !== undefined) clean.categoryId = parsed.categoryId;
      if (parsed.kind !== undefined) clean.kind = parsed.kind;
      if (parsed.minAmountCents !== undefined) clean.minAmountCents = parsed.minAmountCents;
      if (parsed.maxAmountCents !== undefined) clean.maxAmountCents = parsed.maxAmountCents;
      if (parsed.query !== undefined) clean.query = parsed.query;

      const where: string[] = ['household_id = $1', "deleted_at IS NULL"];
      const values: unknown[] = [householdId];

      if (clean.startDate !== undefined) {
        values.push(clean.startDate);
        where.push(`date >= $${values.length}`);
      }
      if (clean.endDate !== undefined) {
        values.push(clean.endDate);
        where.push(`date <= $${values.length}`);
      }
      if (clean.accountId !== undefined) {
        values.push(clean.accountId);
        where.push(`account_id = $${values.length}`);
      }
      if (clean.categoryId !== undefined) {
        values.push(clean.categoryId);
        where.push(`category_id = $${values.length}`);
      }
      if (clean.kind !== undefined) {
        values.push(clean.kind);
        where.push(`kind = $${values.length}`);
      }
      if (clean.minAmountCents !== undefined) {
        values.push(clean.minAmountCents);
        where.push(`amount_cents >= $${values.length}`);
      }
      if (clean.maxAmountCents !== undefined) {
        values.push(clean.maxAmountCents);
        where.push(`amount_cents <= $${values.length}`);
      }
      if (clean.query !== undefined) {
        values.push(`%${clean.query.toLowerCase()}%`);
        where.push(`LOWER(description) LIKE $${values.length}`);
      }

      const whereSql = where.join(' AND ');

      // Count total
      const totalRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM transactions WHERE ${whereSql}`,
        values,
      );
      const total = Number(totalRes.rows[0]?.count ?? 0);

      // Page
      values.push(parsed.limit);
      const limitIdx = values.length;
      values.push(parsed.offset);
      const offsetIdx = values.length;

      const rows = await query<Row>(
        `SELECT id, household_id, kind, description, amount_cents, date,
                account_id, category_id, subcategory_id, transfer_to_account_id, notes
           FROM transactions
          WHERE ${whereSql}
          ORDER BY date DESC, id DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        values,
      );

      return {
        items: rows.map(mapTransaction),
        total,
      };
    },

    async listAllTransactions(householdId) {
      const rows = await query<Row>(
        `SELECT id, household_id, kind, description, amount_cents, date,
                account_id, category_id, subcategory_id, transfer_to_account_id, notes
           FROM transactions
          WHERE household_id = $1
            AND deleted_at IS NULL`,
        [householdId],
      );
      return rows.map(mapTransaction);
    },
  };
};

/**
 * Helper: insert a seed row. Used by tests; not exported via the public
 * `ReadModelStore` interface because CRUD lives in a later slice.
 */
export const insertSeed = async (
  client: PoolClient,
  table: 'accounts' | 'categories' | 'transactions' | 'device_tokens',
  values: Record<string, unknown>,
): Promise<void> => {
  const cols = Object.keys(values);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const params = cols.map((c) => values[c]);
  await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    params,
  );
};
