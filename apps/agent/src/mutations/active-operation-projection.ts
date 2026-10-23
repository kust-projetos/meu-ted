/**
 * T5.3 (H-14, SPEC §22): strict lean projection of active pending
 * operations relayed by the Agent rpc to the PWA. Defense in depth on top
 * of the API's own lean endpoint: even if the API ever echoed extra
 * fields, only the allowlisted display fields survive — attestation
 * material and raw normalizedArgs can never cross to the browser.
 * FIX-P1: the canonical `presentation` (SPEC §16) is allowlisted as an
 * opaque-but-validated DTO — strict schema parse only; a poisoned
 * presentation is dropped while the lean record still relays.
 *
 * Role contract: this projection only FILTERS to the lean allowlist — it
 * never decides confirmation, never builds financial content, never
 * creates financial rules.
 */
import { pendingOperationPresentationSchema } from '@pi-finance/llm-contracts';
import type { ActiveOperationRecord } from './mutation-api-client.js';

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Builds a record with only the allowlisted keys set (no undefined holes). */
const buildRecord = (source: ActiveOperationRecord): ActiveOperationRecord => ({
  id: source.id,
  status: source.status,
  tool: source.tool,
  createdAt: source.createdAt,
  expiresAt: source.expiresAt,
  ...(source.amountCents !== undefined ? { amountCents: source.amountCents } : {}),
  ...(source.description !== undefined ? { description: source.description } : {}),
  ...(source.date !== undefined ? { date: source.date } : {}),
  ...(source.accountId !== undefined ? { accountId: source.accountId } : {}),
  ...(source.categoryId !== undefined ? { categoryId: source.categoryId } : {}),
  ...(source.status === 'failed' && source.tool === 'categories.deactivate' && source.failureCode === 'in_use' ? { failureCode: 'in_use' as const } : {}),
  ...(source.presentation !== undefined ? { presentation: source.presentation } : {}),
});

const parsePresentation = (value: unknown): ActiveOperationRecord['presentation'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const parsed = pendingOperationPresentationSchema.safeParse(value);
  return parsed.success ? (parsed.data as ActiveOperationRecord['presentation']) : undefined;
};

/**
 * Projects an unknown listing payload into the lean allowlist. Invalid
 * items are dropped wholesale (never partially relayed); the returned
 * array contains ONLY the fields a browser may display.
 */
export const toActiveOperationRecords = (input: unknown): ActiveOperationRecord[] => {
  if (!Array.isArray(input)) return [];
  const records: ActiveOperationRecord[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const source = raw as Record<string, unknown>;
    const id = asString(source.id);
    const status = asString(source.status);
    const tool = asString(source.tool);
    const createdAt = asString(source.createdAt);
    const expiresAt = asString(source.expiresAt);
    if (!id || !status || !tool || !createdAt || !expiresAt) continue;
    const amountCents = typeof source.amountCents === 'number' && Number.isFinite(source.amountCents)
      ? source.amountCents
      : undefined;
    records.push(
      buildRecord({
        id,
        status,
        tool,
        createdAt,
        expiresAt,
        ...(amountCents !== undefined ? { amountCents } : {}),
        ...(asOptionalString(source.description) !== undefined ? { description: asOptionalString(source.description) } : {}),
        ...(asOptionalString(source.date) !== undefined ? { date: asOptionalString(source.date) } : {}),
        ...(asOptionalString(source.accountId) !== undefined ? { accountId: asOptionalString(source.accountId) } : {}),
        ...(asOptionalString(source.categoryId) !== undefined ? { categoryId: asOptionalString(source.categoryId) } : {}),
        ...(status === 'failed' && tool === 'categories.deactivate' && source.failureCode === 'in_use' ? { failureCode: 'in_use' as const } : {}),
        ...(parsePresentation(source.presentation) !== undefined ? { presentation: parsePresentation(source.presentation) } : {}),
      }),
    );
  }
  return records;
};
