import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Budget, BudgetStatus, BudgetTrend } from '../types/domain.js';
import type { BudgetStore } from './store.js';
import { assertCategoryKind } from '../categories/resolve.js';
import { domainErrors } from '../writes/errors.js';
import { withTransaction } from '../db/pool.js';
import { assertWorkspaceWritableInTx } from '../auth/workspace-lifecycle-guard.js';

type Row = Record<string, unknown>;

type QueryFn = <R extends Row = Row>(text: string, values?: unknown[]) => Promise<R[]>;

type CreateBudgetInput = Parameters<BudgetStore['createBudget']>[1];
type UpdateBudgetInput = Parameters<BudgetStore['updateBudget']>[2];

/**
 * V4.1 Phase 3 (UOW2) — client-bound budget cores (no transaction handling).
 * The plain store methods run them in their own transaction; keyed route
 * producers (see budgets/keyed-mutations.ts) run them on the open
 * idempotency claim client, so claim + effect + completion commit
 * atomically in ONE transaction.
 */
const createBudgetInTx = async (
  client: PoolClient,
  householdId: string,
  input: CreateBudgetInput,
): Promise<Budget> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  const gate = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> =>
    (await client.query<R>(text, values)).rows;
  // V4.1 Task 2.15: budgets had no category validation at all.
  await assertBudgetCategory(gate, householdId, input.categoryId);
  const insert = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> =>
    (await client.query<R>(text, values)).rows;
  return insertBudgetRow(insert, householdId, input);
};

const updateBudgetInTx = async (
  client: PoolClient,
  householdId: string,
  budgetId: string,
  patch: UpdateBudgetInput,
): Promise<Budget> => {
  // FIX-WS-D2-R2 item 2: lifecycle active dentro da transação do efeito.
  await assertWorkspaceWritableInTx(client, householdId);
  const existing = await client.query<Row>(`SELECT * FROM budgets WHERE id=$1 AND household_id=$2`, [budgetId, householdId]);
  if ((existing.rowCount ?? 0) === 0) throw domainErrors.notFound('Orçamento');
  if (patch.amountCents !== undefined) await client.query(`UPDATE budgets SET amount_cents=$1, updated_at=NOW() WHERE id=$2 AND household_id=$3`, [patch.amountCents, budgetId, householdId]);
  if (patch.alertThreshold !== undefined) await client.query(`UPDATE budgets SET alert_threshold=$1, updated_at=NOW() WHERE id=$2 AND household_id=$3`, [patch.alertThreshold, budgetId, householdId]);
  const rows = await client.query<Row>(`SELECT * FROM budgets WHERE id=$1 AND household_id=$2`, [budgetId, householdId]);
  const r = rows.rows[0]!;
  return { id: r['id'] as string, householdId, categoryId: r['category_id'] as string, name: r['name'] as string, amountCents: Number(r['amount_cents']), period: r['period'] as Budget['period'], startDate: (r['start_date'] as Date).toISOString().slice(0, 10), alertThreshold: Number(r['alert_threshold']), rollover: r['rollover'] as boolean };
};

/**
 * Canonical-schema category gate for budget creation (V4.1 Task 2.15,
 * SPEC §9.8): the budget category must be an active expense-kind category
 * of the household — 404 when unknown/inactive, 400 on kind mismatch.
 * The lookup stays schema-local (status column); the legacy twin in
 * legacy-postgres.ts mirrors it with `active`.
 */
export const assertBudgetCategory = async (
  query: QueryFn,
  householdId: string,
  categoryId: string,
): Promise<void> => {
  const rows = await query<Row>(
    `SELECT id, kind, status FROM categories WHERE id = $1 AND household_id = $2`,
    [categoryId, householdId],
  );
  if (rows.length === 0) throw domainErrors.notFound('Categoria');
  const cat = rows[0]!;
  if (cat['status'] !== 'active') throw domainErrors.notFound('Categoria');
  assertCategoryKind(
    { id: categoryId, householdId, kind: String(cat['kind']), status: 'active' },
    'expense',
  );
};

/**
 * Shared budget-row insert core: the canonical store runs it after the
 * canonical category gate; the legacy store runs it after the legacy
 * (`active`) gate.
 */
export const insertBudgetRow = async (
  query: QueryFn,
  householdId: string,
  input: CreateBudgetInput,
): Promise<Budget> => {
  const id = randomUUID();
  await query(`INSERT INTO budgets (id,household_id,category_id,name,amount_cents,period,start_date,alert_threshold) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, householdId, input.categoryId, input.name, input.amountCents, input.period, input.startDate, input.alertThreshold ?? 80]);
  return { id, householdId, categoryId: input.categoryId, name: input.name, amountCents: input.amountCents, period: input.period, startDate: input.startDate, alertThreshold: input.alertThreshold ?? 80, rollover: false };
};

function getPeriodBounds(date: string, period: string): { start: string; end: string } {
  const d = new Date(date + 'T00:00:00');
  const y = d.getUTCFullYear(); const m = d.getUTCMonth();
  if (period === 'monthly') {
    return { start: `${y}-${String(m+1).padStart(2,'0')}-01`, end: `${y}-${String(m+1).padStart(2,'0')}-${String(new Date(Date.UTC(y,m+1,0)).getUTCDate()).padStart(2,'0')}` };
  } else if (period === 'quarterly') {
    const qs = Math.floor(m/3)*3;
    return { start: `${y}-${String(qs+1).padStart(2,'0')}-01`, end: `${y}-${String(qs+3).padStart(2,'0')}-${String(new Date(Date.UTC(y,qs+3,0)).getUTCDate()).padStart(2,'0')}` };
  }
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

export const createPostgresBudgetStore = (pool: Pool): BudgetStore => {
  const query = async <R extends Row = Row>(text: string, values: unknown[] = []): Promise<R[]> => {
    const res = await pool.query<R>(text, values); return res.rows;
  };

  const calcSpent = async (budgetId: string, categoryId: string, householdId: string, period: string): Promise<number> => {
    const today = new Date().toISOString().slice(0, 10);
    const { start, end } = getPeriodBounds(today, period);
    const rows = await query<Row>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS spent FROM transactions WHERE household_id=$1 AND category_id=$2 AND kind='expense' AND date>=$3 AND date<=$4 AND deleted_at IS NULL`,
      [householdId, categoryId, start, end],
    );
    return Number(rows[0]!['spent']);
  };

  const store: BudgetStore = {
    async listBudgets(householdId) {
      const rows = await query<Row>(`SELECT * FROM budgets WHERE household_id=$1 ORDER BY amount_cents DESC`, [householdId]);
      const result: BudgetStatus[] = [];
      for (const r of rows) {
        const b: Budget = { id: r['id'] as string, householdId, categoryId: r['category_id'] as string, name: r['name'] as string, amountCents: Number(r['amount_cents']), period: r['period'] as Budget['period'], startDate: (r['start_date'] as Date).toISOString().slice(0,10), alertThreshold: Number(r['alert_threshold']), rollover: r['rollover'] as boolean };
        const spent = await calcSpent(b.id, b.categoryId, householdId, b.period);
        result.push({ ...b, spentCents: spent, remainingCents: Math.max(0, b.amountCents - spent), percentUsed: Math.round((spent / b.amountCents) * 100) });
      }
      result.sort((a, b) => b.percentUsed - a.percentUsed);
      return result;
    },

    async createBudget(householdId, input) {
      return withTransaction(pool, (client) => createBudgetInTx(client, householdId, input));
    },

    async updateBudget(householdId, budgetId, patch) {
      return withTransaction(pool, (client) => updateBudgetInTx(client, householdId, budgetId, patch));
    },

    async getBudgetTrends(householdId, budgetId, monthsBack = 3) {
      const existing = await query<Row>(`SELECT * FROM budgets WHERE id=$1 AND household_id=$2`, [budgetId, householdId]);
      if (existing.length === 0) throw domainErrors.notFound('Orçamento');
      const b = existing[0]!;
      const trends: BudgetTrend[] = [];
      const now = new Date();
      for (let i = monthsBack - 1; i >= 0; i--) {
        const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - i);
        const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
        const { start, end } = getPeriodBounds(`${ym}-01`, b['period'] as string);
        const rows = await query<Row>(`SELECT COALESCE(SUM(amount_cents),0) AS spent FROM transactions WHERE household_id=$1 AND category_id=$2 AND kind='expense' AND date>=$3 AND date<=$4 AND deleted_at IS NULL`,
          [householdId, b['category_id'], start, end]);
        trends.push({ yearMonth: ym, budgetCents: Number(b['amount_cents']), spentCents: Number(rows[0]!['spent']) });
      }
      return trends;
    },
  };
  // V4.1 Phase 3 (UOW2): expose the client-bound cores as non-contractual
  // extensions (see BudgetStoreTxExtensions in budgets/keyed-mutations.ts).
  // The declared factory return type stays BudgetStore.
  return Object.assign(store, {
    createBudgetInTx,
    updateBudgetInTx,
  });
};
