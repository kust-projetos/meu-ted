/**
 * Legacy Postgres read model store.
 *
 * Maps the existing pi_financeiro schema (from legacy Agent Pi migrations)
 * to the pi-finance-api ReadModelStore contract.
 *
 * Key differences from the API's own schema:
 * - accounts: uses initial_balance_cents + computed; active boolean; no kind/status
 *   (credit-card rows flagged by is_credit_card are excluded here — parity
 *   with the canonical store's `kind <> 'credit_card'`; cards are served by
 *   the CardStore, never borrowed into generic account surfaces)
 * - categories: active boolean; no status
 * - transactions: uses from_account_id/to_account_id; expense uses from, income uses to, transfer uses both
 * - balances are computed per-query (no stored balance_cents)
 *
 * Activated by: DB_SCHEMA=legacy env variable.
 */

import type { Pool } from 'pg';
import type { Account, Category, Transaction, TransactionFilters } from '../types/domain.js';
import type { ReadModelStore } from './store.js';
import { transactionFiltersSchema, type ParsedTransactionFilters } from '../types/transactions.js';

type Row = Record<string, unknown>;

const mapAccount = (r: Row): Account => ({
  id: r['id'] as string,
  householdId: r['household_id'] as string,
  name: r['name'] as string,
  kind: (r['kind'] as string) ? (r['kind'] as Account['kind']) : 'bank',
  balanceCents: Number(r['balance_cents'] ?? 0),
  status: r['active'] ? 'active' : 'inactive',
});

const mapCategory = (r: Row): Category => {
  const parentId = r['parent_id'] as string | null | undefined;
  const base: Category = {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    name: r['name'] as string,
    kind: r['kind'] as Category['kind'],
    status: r['active'] ? 'active' : 'inactive',
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
  const fromId = r['from_account_id'] as string | null;
  const toId = r['to_account_id'] as string | null;
  const base: Transaction = {
    id: r['id'] as string,
    householdId: r['household_id'] as string,
    kind,
    description: (r['description'] ?? '') as string,
    amountCents: Number(r['amount_cents']),
    date: (r['date'] as Date).toISOString().slice(0, 10),
    accountId: '',
  };
  if (kind === 'expense') {
    base.accountId = fromId ?? '';
  } else if (kind === 'income') {
    base.accountId = toId ?? '';
  } else {
    base.accountId = fromId ?? '';
    if (toId) base.transferToAccountId = toId;
  }
  const catId = r['category_id'];
  if (catId !== null && catId !== undefined) base.categoryId = catId as string;
  const subId = r['subcategory_id'];
  if (subId !== null && subId !== undefined) base.subcategoryId = subId as string;
  const notes = r['notes'];
  if (notes !== null && notes !== undefined) base.notes = notes as string;
  return base;
};

export const createLegacyPostgresReadModelStore = (opts: { pool: Pool }): ReadModelStore => {
  const { pool } = opts;

  const query = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> => {
    const res = await pool.query<R>(text, values);
    return res.rows;
  };

  return {
    async listAccounts(householdId: string, options) {
      // A08 parity with the canonical store: the opt-in drops ONLY the
      // availability predicate (`a.active`), keeping the household bind, the
      // soft-delete guard and the card exclusion.
      const activeFilter = options?.includeInactive === true ? '' : 'AND a.active = true';
      const rows = await query<Row>(
        `SELECT a.id, a.household_id, a.name, a.initial_balance_cents,
                COALESCE(a.initial_balance_cents, 0)
                + COALESCE(totals.income, 0)
                - COALESCE(totals.expense, 0)
                - COALESCE(totals.transfer_out, 0)
                + COALESCE(totals.transfer_in, 0)
                AS balance_cents,
                a.active
           FROM accounts a
           LEFT JOIN LATERAL (
             SELECT
               COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount_cents ELSE 0 END) FILTER (WHERE t.to_account_id = a.id), 0) as income,
               COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END) FILTER (WHERE t.from_account_id = a.id), 0) as expense,
               COALESCE(SUM(CASE WHEN t.kind = 'transfer' THEN t.amount_cents ELSE 0 END) FILTER (WHERE t.from_account_id = a.id), 0) as transfer_out,
               COALESCE(SUM(CASE WHEN t.kind = 'transfer' THEN t.amount_cents ELSE 0 END) FILTER (WHERE t.to_account_id = a.id), 0) as transfer_in
             FROM transactions t
             WHERE t.household_id = $1 AND t.deleted_at IS NULL
           ) totals ON true

            WHERE a.household_id = $1 ${activeFilter} AND a.deleted_at IS NULL
              AND a.is_credit_card IS NOT TRUE`,
        [householdId],
      );
      return rows.map(mapAccount);
    },

    async listCategories(householdId: string) {
      const rows = await query<Row>(
        `SELECT id, household_id, name, kind, active, parent_id,
                icon, color, sort_order, is_default, is_system
           FROM categories
          WHERE household_id = $1 AND active = true AND deleted_at IS NULL`,
        [householdId],
      );
      return rows.map(mapCategory);
    },

    async listTransactions(householdId: string, filters: ParsedTransactionFilters) {
      const parsed = transactionFiltersSchema.parse(filters);
      const clean: TransactionFilters = {};
      if (parsed.startDate !== undefined) clean.startDate = parsed.startDate;
      if (parsed.endDate !== undefined) clean.endDate = parsed.endDate;
      if (parsed.accountId !== undefined) clean.accountId = parsed.accountId;
      if (parsed.categoryId !== undefined) clean.categoryId = parsed.categoryId;
      if (parsed.kind !== undefined) clean.kind = parsed.kind;
      if (parsed.minAmountCents !== undefined) clean.minAmountCents = parsed.minAmountCents;
      if (parsed.maxAmountCents !== undefined) clean.maxAmountCents = parsed.maxAmountCents;
      if (parsed.query !== undefined) clean.query = parsed.query;

      const where: string[] = ['t.household_id = $1', 't.deleted_at IS NULL'];
      const values: unknown[] = [householdId];

      if (clean.startDate !== undefined) { values.push(clean.startDate); where.push(`t.date >= $${values.length}`); }
      if (clean.endDate !== undefined) { values.push(clean.endDate); where.push(`t.date <= $${values.length}`); }
      if (clean.kind !== undefined) { values.push(clean.kind); where.push(`t.kind = $${values.length}`); }
      if (clean.minAmountCents !== undefined) { values.push(clean.minAmountCents); where.push(`t.amount_cents >= $${values.length}`); }
      if (clean.maxAmountCents !== undefined) { values.push(clean.maxAmountCents); where.push(`t.amount_cents <= $${values.length}`); }
      if (clean.query !== undefined) { values.push(`%${clean.query.toLowerCase()}%`); where.push(`LOWER(t.description) LIKE $${values.length}`); }

      // account filter: expense/transfer uses from_account_id, income uses to_account_id
      if (clean.accountId !== undefined) {
        values.push(clean.accountId);
        where.push(`( (t.kind IN ('expense','transfer') AND t.from_account_id = $${values.length}) OR (t.kind = 'income' AND t.to_account_id = $${values.length}) )`);
      }
      if (clean.categoryId !== undefined) { values.push(clean.categoryId); where.push(`t.category_id = $${values.length}`); }

      const whereSql = where.join(' AND ');

      const totalRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM transactions t WHERE ${whereSql}`, values);
      const total = Number(totalRes.rows[0]?.count ?? 0);

      values.push(parsed.limit); const limIdx = values.length;
      values.push(parsed.offset); const offIdx = values.length;

      const rows = await query<Row>(
        `SELECT t.id, t.household_id, t.kind, t.description, t.amount_cents, t.date,
                t.from_account_id, t.to_account_id, t.category_id, t.subcategory_id, t.notes
           FROM transactions t
          WHERE ${whereSql}
          ORDER BY t.date DESC, t.id DESC
          LIMIT $${limIdx} OFFSET $${offIdx}`, values);

      return { items: rows.map(mapTransaction), total };
    },

    async listAllTransactions(householdId: string) {
      const rows = await query<Row>(
        `SELECT id, household_id, kind, description, amount_cents, date,
                from_account_id, to_account_id, category_id, subcategory_id, notes
           FROM transactions
          WHERE household_id = $1 AND deleted_at IS NULL`, [householdId]);
      return rows.map(mapTransaction);
    },
  };
};
