/**
 * F2-A POC — operation and argument vocabulary (single source, no mirroring
 * where production already exports one).
 *
 * Canonical reuse:
 *  - mutation operations: imported from `TED_APPROVAL_TOOLS`
 *    (`packages/llm-contracts/src/types.ts`) — the same closed set the approval
 *    protocol and the receipt validator use. Never re-typed here.
 *  - draft argument names: compile-time bound to `MutationDraftResolvedArgs`
 *    (`apps/agent/src/mutations/mutation-draft.ts`) through `satisfies`, so a
 *    renamed/removed production field fails `tsc` instead of drifting.
 *
 * Explicit debt (not fake parity):
 *  - `OPERATION_TO_READ` (`apps/agent/src/orchestration/channel-evidence.ts`) is
 *    NOT exported. Rather than editing production just for a POC, the read
 *    registry below is a declared mirror, and
 *    `tests/poc-structured/f2a-structured-interpretation.test.ts` parses the
 *    production source and fails when the two sets diverge.
 *  - `targetReference` / `target` / `priorAmountCents` / `correctedAmountCents`
 *    exist only in the frozen F1 oracle vocabulary (undo/correction concepts),
 *    never in `MutationDraftResolvedArgs`. They are accepted here as
 *    POC-only interpretation vocabulary and flagged `supportedInProduction:
 *    false`; no production parity is claimed for them.
 */

import { TED_APPROVAL_TOOLS, type TedApprovalTool } from '@pi-finance/llm-contracts/types';
import type { MutationDraftResolvedArgs } from '../mutations/mutation-draft.js';

/** Mirror of `OPERATION_TO_READ` keys — parity is enforced by a source test. */
export const READ_OPERATION_NAMES = Object.freeze([
  'get_balance',
  'list_accounts',
  'list_transactions',
  'list_recent_transactions',
  'get_month_summary',
  'spending_insights',
  'list_cards',
  'list_statements',
  'get_statement_details',
  'list_payables',
  'list_accounts_payable',
  'check_payable_reminders',
  'list_budgets',
  'check_budgets',
  'budget_trends',
  'list_goals',
  'list_categories',
  'analytics_kpis',
  'analytics_category_breakdown',
] as const);

export const READ_REGISTRY_PROVENANCE = Object.freeze({
  source: 'apps/agent/src/orchestration/channel-evidence.ts#OPERATION_TO_READ',
  authority: 'mirror',
  reason: 'not-exported-by-production',
} as const);

export const MUTATION_OPERATIONS: readonly TedApprovalTool[] = Object.freeze([
  ...TED_APPROVAL_TOOLS,
]);

export const MUTATION_REGISTRY_PROVENANCE = Object.freeze({
  source: '@pi-finance/llm-contracts/types#TED_APPROVAL_TOOLS',
  authority: 'imported',
} as const);

/** Closed set of operations an interpretation may name. `none` = no operation. */
export const ALLOWED_OPERATIONS: readonly string[] = Object.freeze([
  'none',
  ...READ_OPERATION_NAMES,
  ...MUTATION_OPERATIONS,
]);

/**
 * Argument names that exist in the canonical draft contract. `satisfies` makes
 * this a compile-time subset check: dropping a field upstream breaks here.
 */
export const DRAFT_ARG_KEYS = Object.freeze([
  'amountCents',
  'description',
  'date',
  'categoryQuery',
  'accountId',
  'categoryId',
  'accountName',
  'accountKind',
  'initialBalanceCents',
  'categoryName',
  'categoryKind',
  'parentCategoryId',
  'parentCategoryName',
  'parentQuery',
  'requiresParent',
  'expectedName',
  'transactionId',
  'expectedDescription',
] as const satisfies readonly (keyof MutationDraftResolvedArgs)[]);

/** F1-oracle-only vocabulary (undo / correction). No production parity. */
export const F1_CONCEPTUAL_ARG_KEYS = Object.freeze([
  'targetReference',
  'target',
  'priorAmountCents',
  'correctedAmountCents',
] as const satisfies readonly string[]);

/** Read-window vocabulary used by the frozen F1 oracle for read operations. */
export const READ_WINDOW_ARG_KEYS = Object.freeze([
  'yearMonth',
  'period',
  'from',
  'to',
  'startDate',
  'endDate',
] as const satisfies readonly string[]);

export type ArgValueKind =
  | 'string'
  | 'cents'
  | 'signed-cents'
  | 'boolean'
  | 'account-kind'
  | 'category-kind';

export type ArgSpec = Readonly<{
  kind: ArgValueKind;
  supportedInProduction: boolean;
}>;

const spec = (kind: ArgValueKind, supportedInProduction: boolean): ArgSpec =>
  Object.freeze({ kind, supportedInProduction });

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

/** Complete argument vocabulary with value shape and production-support flag. */
export const ARG_SPECS: Readonly<Record<string, ArgSpec>> = Object.freeze({
  amountCents: spec('cents', true),
  description: spec('string', true),
  date: spec('string', true),
  categoryQuery: spec('string', true),
  accountId: spec('string', true),
  categoryId: spec('string', true),
  accountName: spec('string', true),
  accountKind: spec('account-kind', true),
  initialBalanceCents: spec('signed-cents', true),
  categoryName: spec('string', true),
  categoryKind: spec('category-kind', true),
  parentCategoryId: spec('string', true),
  parentCategoryName: spec('string', true),
  parentQuery: spec('string', true),
  requiresParent: spec('boolean', true),
  expectedName: spec('string', true),
  transactionId: spec('string', true),
  expectedDescription: spec('string', true),
  targetReference: spec('string', false),
  target: spec('string', false),
  priorAmountCents: spec('cents', false),
  correctedAmountCents: spec('cents', false),
  yearMonth: spec('string', false),
  period: spec('string', false),
  from: spec('string', false),
  to: spec('string', false),
  startDate: spec('string', false),
  endDate: spec('string', false),
});

export const ACCOUNT_KINDS = Object.freeze(['bank', 'cash'] as const);
export const CATEGORY_KINDS = Object.freeze(['expense', 'income'] as const);

/**
 * Own-property read of the closed argument vocabulary. `key in ARG_SPECS` (or
 * `ARG_SPECS[key] !== undefined`) would accept `toString`, `constructor` and
 * other prototype members as if they were declared slots.
 */
export const getArgSpec = (key: string): ArgSpec | undefined =>
  hasOwn(ARG_SPECS, key) ? ARG_SPECS[key] : undefined;

const argKeys = (...keys: readonly string[]): ReadonlySet<string> => new Set(keys);

const READ_ARGS = argKeys(...READ_WINDOW_ARG_KEYS);

/**
 * Arguments accepted per operation. A key outside its operation's set is an
 * operation-appropriate violation (never silently ignored).
 */
export const OPERATION_ARG_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  none: argKeys(),
  ...Object.fromEntries(READ_OPERATION_NAMES.map((name) => [name, READ_ARGS])),
  'transactions.expense.create': argKeys(
    'amountCents',
    'description',
    'date',
    'accountId',
    'categoryId',
    'accountName',
    'categoryName',
    'categoryQuery',
  ),
  'transactions.income.create': argKeys(
    'amountCents',
    'description',
    'date',
    'accountId',
    'categoryId',
    'accountName',
    'categoryName',
    'categoryQuery',
  ),
  'transactions.update': argKeys(
    'transactionId',
    'expectedDescription',
    'description',
    'amountCents',
    'date',
    'accountId',
    'categoryId',
    'targetReference',
  ),
  'accounts.create': argKeys('accountName', 'accountKind', 'initialBalanceCents'),
  'accounts.update': argKeys('accountId', 'expectedName', 'accountName'),
  'accounts.deactivate': argKeys('accountId', 'expectedName', 'accountName'),
  'categories.create': argKeys(
    'categoryName',
    'categoryKind',
    'parentCategoryId',
    'parentCategoryName',
    'parentQuery',
    'requiresParent',
  ),
  'categories.update': argKeys('categoryId', 'expectedName', 'categoryName'),
  'categories.deactivate': argKeys('categoryId', 'expectedName', 'categoryName'),
});

export const isMutationOperation = (operation: string): boolean =>
  (MUTATION_OPERATIONS as readonly string[]).includes(operation);

/** Own-property check: every canonical mutation op must declare an arg schema. */
export const hasOperationArgSchema = (operation: string): boolean =>
  hasOwn(OPERATION_ARG_KEYS, operation);

export const isReadOperation = (operation: string): boolean =>
  (READ_OPERATION_NAMES as readonly string[]).includes(operation);
