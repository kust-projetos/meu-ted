/**
 * SPEC §16 (T3.4, H-10, INV-02): Agent-side approval-card projection.
 *
 * The card is derived from the SAME canonical `normalizedArgs` that were
 * just proposed (hash-bound at the API) plus the account/category labels
 * resolved from the authoritative entity lists during this turn — never
 * from the LLM summary. Labels are display-only; the API re-validates the
 * canonical args at confirm/execute time.
 *
 * Transport choice (documented per T3.4): labels are attached at propose
 * time from the entity-resolver output (zero new reads, zero new
 * endpoints) instead of resolving server-side in GET /v2/active, which
 * stays a lean label-free listing for disambiguation. Incomplete args
 * yield `null` (defense: the canonical gate already blocks propose).
 *
 * Role contract: this constructor only BUILDS the card from the canonical
 * args plus labels — it never decides confirmation, never filters the relay
 * listing, never creates financial rules.
 */
import {
  pendingOperationPresentationSchema,
  type PendingOperationPresentation,
} from '@pi-finance/llm-contracts';

export const deriveApprovalTitle = (tool: string): string =>
  tool.includes('income') ? 'Confirmar receita' : tool.includes('expense') ? 'Confirmar despesa' : 'Confirmar operação';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const buildApprovalPresentation = (input: {
  operationId: string;
  status: string;
  tool: string;
  normalizedArgs: unknown;
  expiresAt: string;
  accountLabel?: string;
  categoryLabel?: string;
}): PendingOperationPresentation | null => {
  const args = isRecord(input.normalizedArgs) ? input.normalizedArgs : null;
  if (!args) return null;
  const { amountCents, description, date, accountId, categoryId } = args;
  if (
    typeof amountCents !== 'number' ||
    typeof description !== 'string' ||
    typeof date !== 'string' ||
    typeof accountId !== 'string' ||
    typeof categoryId !== 'string'
  ) {
    return null;
  }
  const candidate: Record<string, unknown> = {
    id: input.operationId,
    status: input.status,
    tool: input.tool,
    title: deriveApprovalTitle(input.tool),
    amountCents,
    description,
    date,
    expiresAt: input.expiresAt,
    warnings: [],
  };
  if (typeof input.accountLabel === 'string' && input.accountLabel) {
    candidate.account = { id: accountId, label: input.accountLabel };
  }
  if (typeof input.categoryLabel === 'string' && input.categoryLabel) {
    candidate.category = { id: categoryId, label: input.categoryLabel };
  }
  const parsed = pendingOperationPresentationSchema.safeParse(candidate);
  if (!parsed.success) return null;
  // The strict schema is the authority: its output carries exactly the
  // contract fields. The cast bridges zod's inferred optionals to the
  // hand-written contract interface (exactOptionalPropertyTypes).
  return parsed.data as PendingOperationPresentation;
};
