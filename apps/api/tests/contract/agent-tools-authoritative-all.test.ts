import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { auditQuerySchema } from '../../src/routes/audit.js';
import { accountQuerySchema } from '../../src/routes/accounts.js';
import { categoryQuerySchema } from '../../src/routes/categories.js';
import { monthSummaryQuerySchema } from '../../src/routes/dashboard.js';
import { createBudgetSchema, updateBudgetSchema, budgetTrendQuerySchema } from '../../src/routes/budgets.js';
import { spendingInsightQuerySchema } from '../../src/routes/insights.js';
import { payableQuerySchema, createPayableSchema, payPayableSchema, cancelPayableSchema, payableTemplateSchema, payableFromTemplateSchema, notificationSchema, autoCreateQuery } from '../../src/routes/payables.js';
import { createCardSchema, cardPurchaseSchema, cardInstallmentsSchema, cardRecurringSchema, cardPaySchema, cardStatementQuerySchema, recurringQuerySchema } from '../../src/routes/cards.js';
import { createGoalSchema, contributeSchema } from '../../src/routes/goals.js';
import { transactionFiltersSchema } from '../../src/types/transactions.js';
import { createAccountInputSchema, createCategoryInputSchema, createExpenseInputSchema, createIncomeInputSchema, createTransferInputSchema, updateTransactionInputSchema, updateAccountInputSchema, updateCategoryInputSchema } from '../../src/writes/types.js';

import { pendingIdentitySchema } from '../../src/routes/pending-operations.js';
import { detectSchema } from '../../src/routes/duplicate-detect.js';
import { analyticsQuerySchema, categoryBreakdownQuerySchema } from '../../src/analytics/types.js';

const document = JSON.parse(readFileSync(new URL('../../openapi/agent-tools.openapi.json', import.meta.url), 'utf8'));
const tools = new Map<string, { parameters: Array<{ name: string; in: string; required?: boolean; schema: Record<string, unknown> }> }>();
for (const item of Object.values(document.paths) as Array<Record<string, any>>) for (const operation of Object.values(item)) {
  if (!operation || typeof operation !== 'object') continue;
  const entries = [operation['x-pi-tool'], ...(operation['x-pi-tools'] ?? [])].filter(Boolean);
  for (const tool of entries) {
    const body = operation.requestBody?.content?.['application/json']?.schema;
    const parameters = [...(operation.parameters ?? []), ...Object.entries(body?.properties ?? {}).map(([name, schema]) => ({ name, in: 'body', required: body.required?.includes(name) ?? false, schema }))];
    tools.set(tool.name ?? operation.operationId, { parameters });
  }
}

const authoritativeSchemas = {
  get_pending_operation: pendingIdentitySchema,
  confirm_pending_operation: pendingIdentitySchema,
  cancel_pending_operation: pendingIdentitySchema,
  audit_logs: auditQuerySchema,
  list_accounts: accountQuerySchema,
  list_categories: categoryQuerySchema,
  get_month_summary: monthSummaryQuerySchema,
  list_recent_transactions: transactionFiltersSchema,
  detect_duplicate: detectSchema,
  create_account: createAccountInputSchema,
  create_category: createCategoryInputSchema,
  create_expense: createExpenseInputSchema,
  create_income: createIncomeInputSchema,
  create_transfer: createTransferInputSchema,
  update_account: updateAccountInputSchema,
  update_category: updateCategoryInputSchema,
  update_transaction: updateTransactionInputSchema,
  create_account_payable: createPayableSchema,
  list_accounts_payable: payableQuerySchema,
  mark_account_paid: payPayableSchema,
  cancel_account_payable: cancelPayableSchema,
  create_payable_template: payableTemplateSchema,
  create_payable_from_template: payableFromTemplateSchema,
  auto_create_from_templates: autoCreateQuery,
  configure_notification: notificationSchema,
  create_goal: createGoalSchema,
  contribute_to_goal: contributeSchema,
  create_budget: createBudgetSchema,
  update_budget: updateBudgetSchema,
  budget_trends: budgetTrendQuerySchema,
  spending_insights: spendingInsightQuerySchema,
  create_credit_card_account: createCardSchema,
  create_card_purchase: cardPurchaseSchema,
  create_card_installments: cardInstallmentsSchema,
  create_recurring_purchase: cardRecurringSchema,
  list_recurring_purchases: recurringQuerySchema,
  pay_statement: cardPaySchema,
  list_statements: cardStatementQuerySchema,
  analytics_kpis: analyticsQuerySchema,
  analytics_category_breakdown: categoryBreakdownQuerySchema,
} as const;

/**
 * Tools whose OpenAPI entry is STRICTER than the API schema, field by field.
 *
 * The only divergence today is `period` on the two analytics reads: the API
 * accepts `from`/`to` without `period` and then SILENTLY discards them
 * (`resolveRange` falls back to `last30days` —
 * `docs/reports/2026-10-04-ted-inteligente-v1-a09-spike.md` §3.1). A model
 * tool that inherited the optionality could answer the wrong window with no
 * error, so the tool requires the preset explicitly. The divergence is
 * narrowing-only: a tool may be stricter than the route, never more permissive
 * (the dangerous direction is still enforced below).
 */
const requiredOverrides: Record<string, Record<string, boolean>> = {
  analytics_kpis: { period: true },
  analytics_category_breakdown: { period: true },
};

type Schema = z.ZodTypeAny;
const unwrap = (schema: Schema): Schema => {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable || current instanceof z.ZodEffects) {
    const definition = current._def as any;
    current = definition.innerType ?? definition.schema;
  }
  return current;
};
const isOptional = (schema: Schema): boolean => schema instanceof z.ZodOptional || schema instanceof z.ZodDefault;
const schemaFields = (schema: Schema): Record<string, Schema> => {
  const unwrapped = unwrap(schema);
  if (unwrapped instanceof z.ZodObject) return unwrapped.shape;
  return {};
};
const zodConstraints = (schema: Schema): Record<string, unknown> => {
  const base = unwrap(schema);
  if (base instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: 'string' };
    if (base._def.checks.some((check: any) => check.kind === 'uuid')) result.format = 'uuid';
    for (const check of base._def.checks) {
      if (check.kind === 'min') result.minLength = check.value;
      if (check.kind === 'max') result.maxLength = check.value;
      if (check.kind === 'regex') result.pattern = check.regex.source;
    }
    return result;
  }
  if (base instanceof z.ZodEnum) {
    const result: Record<string, unknown> = { type: 'string', enum: base._def.values };
    return result;
  }
  if (base instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: base._def.checks.some((check: any) => check.kind === 'int') ? 'integer' : 'number' };
    for (const check of base._def.checks) {
      if (check.kind === 'min') result.minimum = check.inclusive === false ? check.value + 1 : check.value;
      if (check.kind === 'max') result.maximum = check.inclusive === false ? check.value - 1 : check.value;
    }
    return result;
  }
  if (base instanceof z.ZodBoolean) return { type: 'boolean' };
  if (base instanceof z.ZodArray) return { type: 'array', items: zodConstraints(base._def.type) };
  return {};
};
const openApiFields = (name: string, schema: Schema) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing generated contract ${name}`);
  const inBody = tool.parameters.filter((parameter) => parameter.in === 'body');
  const inQuery = tool.parameters.filter((parameter) => parameter.in === 'query' && parameter.name !== 'householdId');
  const fields = Object.keys(schemaFields(schema));
  const actual = new Set(['audit_logs', 'list_accounts', 'list_categories', 'get_month_summary', 'list_recent_transactions', 'list_accounts_payable', 'list_statements', 'spending_insights', 'budget_trends', 'list_recurring_purchases', 'auto_create_from_templates', 'get_pending_operation', 'confirm_pending_operation', 'cancel_pending_operation', 'analytics_kpis', 'analytics_category_breakdown']).has(name) ? inQuery : inBody;
  expect(actual.map((parameter) => parameter.name).sort()).toEqual([...fields].sort());
  for (const [field, fieldSchema] of Object.entries(schemaFields(schema))) {
    const parameter = actual.find((candidate) => candidate.name === field)!;
    const expectedRequired = requiredOverrides[name]?.[field] ?? !isOptional(fieldSchema);
    expect(parameter.required ?? false, `${name}.${field} required`).toBe(expectedRequired);
    for (const [key, value] of Object.entries(zodConstraints(fieldSchema))) expect(parameter.schema[key], `${name}.${field}.${key}`).toEqual(value);
  }
};

describe('exhaustive authoritative schema coverage', () => {
  it('covers every generated tool with an API schema or an explicit no-input route', () => {
    const noInput = new Set(['check_payable_reminders', 'list_goals', 'list_budgets', 'check_budgets', 'list_notifications', 'list_payable_templates', 'get_balance', 'deactivate_account', 'deactivate_category', 'delete_transaction', 'cancel_goal', 'get_statement_details', 'refresh_payable_status', 'undo_last_action']);
    expect(new Set([...Object.keys(authoritativeSchemas), ...noInput])).toEqual(new Set(tools.keys()));
    for (const [name, schema] of Object.entries(authoritativeSchemas)) openApiFields(name, schema);
    for (const name of noInput) {
      const unsupported = tools.get(name)!.parameters.filter((parameter) => parameter.in === 'query' && parameter.name !== 'householdId' || parameter.in === 'body');
      expect(unsupported, `${name} unsupported parameters`).toEqual([]);
    }
  });
});
