/**
 * P3 proposal broker — the narrow A4 bridge for the external OpenCode runtime.
 *
 * The runtime holds no delegation secret and cannot mint financial
 * capabilities. This module is the ONLY place the broker mints: exactly
 * `financial.approval.propose` for the authenticated user/device, then calls
 * the authoritative Pending V2 propose endpoint with a stable idempotency key.
 *
 * Scope guardrails:
 * - ONE tool: `transactions.expense.create`.
 * - No confirm/execute/cancel/authorize/retry capability is ever minted here.
 * - Identity comes from the gateway-verified headers; the browser intent only
 *   carries the expense payload and the stable intention id.
 * - A0's canonical ConversationOrchestrator keeps owning A0 chat turns; this
 *   broker does not interpret text, propose from a draft, or touch a turn.
 */
import { z } from 'zod';
import { requestPiApiJson } from '../tools/api-client.js';
import { createDelegatedTurnToken } from '../delegated-token.js';
import { deriveIdempotencyKey } from '../tools/intention-ledger.js';
import { createMutationProposal } from './mutation-proposal.js';

export const PROPOSE_EXPENSE_TOOL = 'transactions.expense.create';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'date must be a real YYYY-MM-DD');

/** Strict expense contract — mirrors the API's createExpenseInputSchema for the slice. */
export const expenseProposalArgsSchema = z
  .object({
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    description: z.string().trim().min(1).max(240),
    date: isoDate,
    accountId: z.string().uuid(),
    categoryId: z.string().uuid(),
  })
  .strict();

export const expenseProposalIntentSchema = z
  .object({
    tool: z.literal(PROPOSE_EXPENSE_TOOL),
    intentionId: z.string().trim().min(1).max(128),
    normalizedArgs: expenseProposalArgsSchema,
  })
  .strict();

export type ExpenseProposalIntent = z.infer<typeof expenseProposalIntentSchema>;
export type ProposalBrokerIdentity = {
  actorId: string;
  workspaceId: string;
  deviceId: string;
  role: 'owner' | 'member';
};

export type ProposalBrokerResult = { id: string; existing: boolean };

function formatBRL(amountCents: number): string {
  return `R$ ${(amountCents / 100).toFixed(2).replace('.', ',')}`;
}

/**
 * Mints the propose-only delegated token and persists the proposal through the
 * authoritative API. Throws the API's typed error (statusCode/code) on refusal;
 * the caller maps it without leaking dependency text.
 */
export async function proposeExpenseFromIntent(input: {
  intent: ExpenseProposalIntent;
  identity: ProposalBrokerIdentity;
  secret: string;
  apiOrigin?: string;
  request?: typeof requestPiApiJson;
}): Promise<ProposalBrokerResult> {
  const { intent, identity, secret } = input;
  if (!secret) throw Object.assign(new Error('delegation secret is required'), { code: 'agent.proposal_unavailable' });
  if (!identity.deviceId) throw Object.assign(new Error('device binding is required'), { code: 'agent.device_required' });

  const delegatedToken = await createDelegatedTurnToken(
    {
      actorId: identity.actorId,
      workspaceId: identity.workspaceId,
      role: identity.role,
      capabilities: ['financial.approval.propose'],
      requestId: intent.intentionId,
      deviceId: identity.deviceId,
    },
    secret,
  );
  const request = input.request ?? requestPiApiJson;
  const summary = `Despesa de ${formatBRL(intent.normalizedArgs.amountCents)} em "${intent.normalizedArgs.description}"`;
  const proposal = await createMutationProposal({
    tool: intent.tool,
    normalizedArgs: intent.normalizedArgs,
    summary,
    identity: {
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
    },
    idempotencyKey: deriveIdempotencyKey(identity.workspaceId, intent.intentionId, intent.tool),
    request: (async (method, path, options) =>
      request(method, path, {
        ...options,
        delegatedToken,
        ...(input.apiOrigin !== undefined ? { apiOrigin: input.apiOrigin } : {}),
      })) as typeof requestPiApiJson,
  });
  return { id: proposal.id, existing: proposal.existing };
}
