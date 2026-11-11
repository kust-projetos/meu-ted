/**
 * HIGH3 (round 3) — authoritative expected context for receipt binding.
 *
 * `resolveExpectedContext` derives `{ tool, entityId? }` from the
 * AUTHORITATIVE listing record (the API actual `GET /pending-operations/v2/active`
 * shape: `tool` + stored-args `accountId` + server-derived `presentation`) —
 * never from the execution response, never from client input, never
 * invented. Callers fail closed when it returns `undefined` on a
 * sensitive tool (no context = no proof).
 *
 * Policy (no broad framework, single boundary):
 * - `accounts.update` / `accounts.deactivate` REQUIRE the pre-existing
 *   account target id (`presentation.account.id` first, stored-args
 *   `accountId` as fallback); without it there is no context;
 * - `accounts.create` / `categories.create` bind kind only (the entity does
 *   not exist yet — distinct policy, never blocks honest creation);
 * - every other tool binds kind only (transaction entities are minted at
 *   execution).
 */
import type { MutationExpectedContext } from './mutation-executor.js';
import type { ActiveOperationRecord } from './mutation-api-client.js';

const SENSITIVE_ACCOUNT_TOOLS: ReadonlySet<string> = new Set([
  'accounts.update',
  'accounts.deactivate',
]);

const SENSITIVE_CATEGORY_TOOLS: ReadonlySet<string> = new Set([
  'categories.update',
  'categories.deactivate',
]);
const SENSITIVE_TRANSACTION_TOOLS: ReadonlySet<string> = new Set(['transactions.update']);
/** P3.6: the statement payment binds the pre-existing invoice id. */
const SENSITIVE_STATEMENT_TOOLS: ReadonlySet<string> = new Set(['cards.statement.pay']);
/**
 * V1 completion: paying a payable moves money, so the pre-existing payable id
 * is REQUIRED. `payables.create` stays kind-only (the payable does not exist
 * yet) — same policy as the account/category creations.
 */
const SENSITIVE_PAYABLE_TOOLS: ReadonlySet<string> = new Set(['payables.pay']);

/**
 * Tools whose receipt binds a PRE-EXISTING entity id. Without a resolvable
 * target id there is no context — callers must fail closed with zero
 * transport (never confirm/execute blind).
 */
export const requiresExpectedEntity = (tool: string): boolean =>
  SENSITIVE_ACCOUNT_TOOLS.has(tool) || SENSITIVE_CATEGORY_TOOLS.has(tool) || SENSITIVE_TRANSACTION_TOOLS.has(tool) || SENSITIVE_STATEMENT_TOOLS.has(tool) || SENSITIVE_PAYABLE_TOOLS.has(tool);

export const resolveExpectedContext = (
  record: Pick<ActiveOperationRecord, 'tool' | 'accountId' | 'categoryId' | 'statementId' | 'payableId'> & {
    presentation?: { account?: { id?: unknown; label?: unknown } | null; category?: { id?: unknown; label?: unknown } | null; statement?: { id?: unknown; label?: unknown } | null; transactionTargetId?: unknown } | null;
  } | null | undefined,
): MutationExpectedContext | undefined => {
  const tool = typeof record?.tool === 'string' ? record.tool.trim() : '';
  if (!tool) return undefined;
  if (SENSITIVE_STATEMENT_TOOLS.has(tool)) {
    const fromPresentation =
      record?.presentation && typeof record.presentation === 'object'
        ? record.presentation.statement
        : undefined;
    const presentationId =
      fromPresentation && typeof fromPresentation === 'object' && typeof fromPresentation.id === 'string'
        ? fromPresentation.id.trim()
        : '';
    const storedId = typeof record?.statementId === 'string' ? record.statementId.trim() : '';
    const entityId = presentationId || storedId;
    if (!entityId) return undefined;
    return { tool, entityId };
  }
  if (SENSITIVE_PAYABLE_TOOLS.has(tool)) {
    const storedId = typeof record?.payableId === 'string' ? record.payableId.trim() : '';
    if (!storedId) return undefined;
    return { tool, entityId: storedId };
  }
  if (SENSITIVE_CATEGORY_TOOLS.has(tool)) {
    const fromPresentation =
      record?.presentation && typeof record.presentation === 'object'
        ? record.presentation.category
        : undefined;
    const presentationId =
      fromPresentation && typeof fromPresentation === 'object' && typeof fromPresentation.id === 'string'
        ? fromPresentation.id.trim()
        : '';
    const storedId = typeof record?.categoryId === 'string' ? record.categoryId.trim() : '';
    const entityId = presentationId || storedId;
    if (!entityId) return undefined;
    return { tool, entityId };
  }
  if (SENSITIVE_TRANSACTION_TOOLS.has(tool)) {
    const entityId = typeof record?.presentation?.transactionTargetId === 'string' ? record.presentation.transactionTargetId.trim() : '';
    if (!entityId) return undefined;
    return { tool, entityId };
  }
  if (SENSITIVE_ACCOUNT_TOOLS.has(tool)) {
    const fromPresentation =
      record?.presentation && typeof record.presentation === 'object'
        ? record.presentation.account
        : undefined;
    const presentationId =
      fromPresentation && typeof fromPresentation === 'object' && typeof fromPresentation.id === 'string'
        ? fromPresentation.id.trim()
        : '';
    const storedId = typeof record?.accountId === 'string' ? record.accountId.trim() : '';
    const entityId = presentationId || storedId;
    if (!entityId) return undefined;
    return { tool, entityId };
  }
  return { tool };
};
