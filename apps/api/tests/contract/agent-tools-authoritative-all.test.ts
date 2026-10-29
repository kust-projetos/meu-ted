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

type Schema = z.ZodType;
const constraintKeys = ['type', 'format', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'items'] as const;
const normalizeIntegerBounds = (schema: Record<string, unknown>): Record<string, unknown> => {
  if (schema.type !== 'integer') return schema;
  const result = { ...schema };
  const lower: number[] = [];
  const upper: number[] = [];
  if (typeof schema.minimum === 'number') lower.push(schema.exclusiveMinimum === true ? Math.floor(schema.minimum) + 1 : Math.ceil(schema.minimum));
  if (typeof schema.maximum === 'number') upper.push(schema.exclusiveMaximum === true ? Math.ceil(schema.maximum) - 1 : Math.floor(schema.maximum));
  if (typeof schema.exclusiveMinimum === 'number') lower.push(Math.floor(schema.exclusiveMinimum) + 1);
  if (typeof schema.exclusiveMaximum === 'number') upper.push(Math.ceil(schema.exclusiveMaximum) - 1);
  delete result.exclusiveMinimum;
  delete result.exclusiveMaximum;
  if (lower.length) result.minimum = Math.max(...lower);
  if (upper.length) result.maximum = Math.min(...upper);
  return result;
};
const compareConstraints = (actual: Record<string, unknown>, expected: Record<string, unknown>, label: string) => {
  actual = normalizeIntegerBounds(actual);
  expected = normalizeIntegerBounds(expected);
  for (const key of constraintKeys) {
    if (expected[key] !== undefined) expect(actual[key], `${label}.${key}`).toEqual(expected[key]);
    else expect(actual[key], `${label}.${key}`).toBeUndefined();
  }
};
const openApiFields = (name: string, schema: Schema) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing generated contract ${name}`);
  const inBody = tool.parameters.filter((parameter) => parameter.in === 'body');
  const inQuery = tool.parameters.filter((parameter) => parameter.in === 'query' && parameter.name !== 'householdId');
  const converted = z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' });
  if (converted.type !== 'object' || !converted.properties) throw new Error(`${name}: expected an object input schema`);
  const fields = Object.keys(converted.properties);
  const actual = new Set(['audit_logs', 'list_accounts', 'list_categories', 'get_month_summary', 'list_recent_transactions', 'list_accounts_payable', 'list_statements', 'spending_insights', 'budget_trends', 'list_recurring_purchases', 'auto_create_from_templates', 'get_pending_operation', 'confirm_pending_operation', 'cancel_pending_operation', 'analytics_kpis', 'analytics_category_breakdown']).has(name) ? inQuery : inBody;
  expect(actual.map((parameter) => parameter.name).sort()).toEqual([...fields].sort());
  for (const [field, fieldSchema] of Object.entries(converted.properties)) {
    const parameter = actual.find((candidate) => candidate.name === field)!;
    const expectedRequired = requiredOverrides[name]?.[field] ?? (converted.required?.includes(field) ?? false);
    expect(parameter.required ?? false, `${name}.${field} required`).toBe(expectedRequired);
    if (typeof fieldSchema !== 'object' || fieldSchema === null) throw new Error(`${name}.${field}: invalid converted schema`);
    compareConstraints(parameter.schema, fieldSchema, `${name}.${field}`);
  }
};

describe('exhaustive authoritative schema coverage', () => {
  it('enforces safe integer limits in the three affected fields', () => {
    for (const field of ['minAmountCents', 'maxAmountCents'] as const) {
      expect(transactionFiltersSchema.safeParse({ [field]: Number.MAX_SAFE_INTEGER }).success).toBe(true);
      expect(transactionFiltersSchema.safeParse({ [field]: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    }
    const amount = detectSchema.shape.amountCents;
    expect(amount.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(amount.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });
  it('compares integer bounds by value without accepting wider bounds', () => {
    expect(() => compareConstraints({ type: 'integer', minimum: 1, maximum: 9 }, { type: 'integer', minimum: 0, exclusiveMinimum: true, exclusiveMaximum: 10 }, 'integer')).not.toThrow();
    expect(() => compareConstraints({ type: 'integer', minimum: 0, maximum: 9 }, { type: 'integer', minimum: 0, exclusiveMinimum: true, exclusiveMaximum: 10 }, 'integer')).toThrow();
    expect(() => compareConstraints({ type: 'number', minimum: 1 }, { type: 'number', minimum: 0, exclusiveMinimum: true }, 'number')).toThrow();
  });
  it('reports all schema discrepancies together', () => {
    const differences: string[] = [];
    const queryTools = new Set(['audit_logs', 'list_accounts', 'list_categories', 'get_month_summary', 'list_recent_transactions', 'list_accounts_payable', 'list_statements', 'spending_insights', 'budget_trends', 'list_recurring_purchases', 'auto_create_from_templates', 'get_pending_operation', 'confirm_pending_operation', 'cancel_pending_operation', 'analytics_kpis', 'analytics_category_breakdown']);
    const report = (name: string, field: string, key: string, expected: unknown, actual: unknown) => differences.push(`${name}.${field}.${key}: authoritative=${JSON.stringify(expected)} openapi=${JSON.stringify(actual)}`);
    for (const [name, schema] of Object.entries(authoritativeSchemas)) {
      try {
        const converted = z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' });
        if (converted.type !== 'object' || !converted.properties) throw new Error('expected object properties');
        const tool = tools.get(name);
        if (!tool) throw new Error('missing tool');
        const parameters = tool.parameters.filter((p) => p.in === (queryTools.has(name) ? 'query' : 'body') && p.name !== 'householdId');
        for (const parameter of parameters) if (!(parameter.name in converted.properties)) report(name, parameter.name, 'field', 'absent', 'present');
        for (const [field, definition] of Object.entries(converted.properties)) {
          const parameter = parameters.find((p) => p.name === field);
          if (!parameter) { report(name, field, 'field', 'present', 'absent'); continue; }
          const required = requiredOverrides[name]?.[field] ?? (converted.required?.includes(field) ?? false);
          if ((parameter.required ?? false) !== required) report(name, field, 'required', required, parameter.required ?? false);
          if (!definition || typeof definition !== 'object') { report(name, field, 'schema', 'object', definition); continue; }
          const expected = normalizeIntegerBounds(definition);
          const actual = normalizeIntegerBounds(parameter.schema);
          for (const key of constraintKeys) {
            if (expected[key] !== undefined) { if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) report(name, field, key, expected[key], actual[key]); }
            else if (actual[key] !== undefined) report(name, field, key, undefined, actual[key]);
          }
        }
      } catch (error) { report(name, '*', 'conversion', 'success', String(error)); }
    }
    expect(differences.join('\n')).toBe('');
  });
  it('detects a missing field and a required field made optional', () => {
    const name = '__contract_fixture__';
    const schema = z.object({ value: z.string() });
    const parameter = { name: 'value', in: 'body', required: true, schema: { type: 'string' } };
    try {
      tools.set(name, { parameters: [parameter] });
      expect(() => openApiFields(name, schema)).not.toThrow();
      tools.set(name, { parameters: [] });
      expect(() => openApiFields(name, schema)).toThrow();
      tools.set(name, { parameters: [{ ...parameter, required: false }] });
      expect(() => openApiFields(name, schema)).toThrow();
    } finally {
      tools.delete(name);
    }
  });
  it('enforces UUID semantics consistently across pending-operation tools', () => {
    const input = z.toJSONSchema(pendingIdentitySchema, { target: 'openapi-3.0', io: 'input' });
    const field = input.properties?.pendingOperationId;
    if (!field || typeof field !== 'object' || typeof field.pattern !== 'string') throw new Error('missing authoritative UUID pattern');
    const examples = [
      ['550e8400-e29b-41d4-a716-446655440000', true],
      ['01890f5a-7b9c-7def-8123-456789abcdef', true],
      ['not-a-uuid', false],
      ['550e8400-e29b-41d4-0716-446655440000', false],
    ] as const;
    for (const [value, valid] of examples) {
      expect(pendingIdentitySchema.safeParse({ pendingOperationId: value }).success, value).toBe(valid);
      expect(new RegExp(field.pattern).test(value), value).toBe(valid);
    }
    for (const name of ['get_pending_operation', 'confirm_pending_operation', 'cancel_pending_operation']) {
      const parameter = tools.get(name)?.parameters.find((item) => item.name === 'pendingOperationId');
      expect(parameter?.schema.pattern, name).toBe(field.pattern);
      expect(() => compareConstraints({ ...parameter?.schema, pattern: undefined }, field, name)).toThrow();
      expect(() => compareConstraints({ ...parameter?.schema, pattern: '.*' }, field, name)).toThrow();
    }
  });
  it('rejects missing or widened constraints in a controlled fixture', () => {
    const expected = { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['a', 'b'], maxLength: 4 } };
    const examples = [
      { type: 'array', maxItems: 3, items: expected.items },
      { type: 'array', minItems: 1, maxItems: 4, items: expected.items },
      { type: 'string', minItems: 1, maxItems: 3, items: expected.items },
      { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['a', 'b', 'c'], maxLength: 4 } },
      { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['a', 'b'], maxLength: 5 } },
    ];
    for (const actual of examples) expect(() => compareConstraints(actual, expected, 'fixture')).toThrow();
  });
  it('rejects unexpected additional constraints in a controlled fixture', () => {
    const cases: Array<{ expected: Record<string, unknown>; actual: Record<string, unknown> }> = [
      { expected: { type: 'string' }, actual: { type: 'string', minLength: 1 } },
      { expected: { type: 'string' }, actual: { type: 'string', pattern: 'a+' } },
      { expected: { type: 'string' }, actual: { type: 'string', enum: ['a'] } },
      { expected: { type: 'array', items: { type: 'string' } }, actual: { type: 'array', items: { type: 'string' }, minItems: 1 } },
    ];
    for (const { actual, expected } of cases) expect(() => compareConstraints(actual, expected, 'fixture-extra')).toThrow();
  });
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
