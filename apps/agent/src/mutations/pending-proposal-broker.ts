/**
 * P3 proposal broker — the narrow A4 bridge for the external OpenCode runtime.
 *
 * The runtime holds no delegation secret and cannot mint financial
 * capabilities. This module is the ONLY place the broker mints: exactly
 * `financial.approval.propose` for the authenticated user/device, then calls
 * the authoritative Pending V2 propose endpoint with a stable idempotency key.
 *
 * Scope guardrails:
 * - Exactly THREE tools: `transactions.expense.create` (P3.1),
 *   `transactions.income.create` (P3.2) and `transactions.transfer.create`
 *   (P3.3). All share ONE code path; the API's Pending V2 tool registry
 *   remains the authority for each contract.
 * - No confirm/execute/cancel/authorize/retry capability is ever minted here.
 * - Identity comes from the gateway-verified headers; the browser intent only
 *   carries the transaction payload and the stable intention id.
 * - A0's canonical ConversationOrchestrator keeps owning A0 chat turns; this
 *   broker does not interpret text, propose from a draft, or touch a turn.
 */
import { z } from 'zod';
import { requestPiApiJson } from '../tools/api-client.js';
import { createDelegatedTurnToken } from '../delegated-token.js';
import { deriveIdempotencyKey } from '../tools/intention-ledger.js';
import { createMutationProposal } from './mutation-proposal.js';

export const PROPOSE_EXPENSE_TOOL = 'transactions.expense.create';
export const PROPOSE_INCOME_TOOL = 'transactions.income.create';
export const PROPOSE_CARD_PURCHASE_TOOL = 'cards.purchase.create';
export const PROPOSE_TRANSFER_TOOL = 'transactions.transfer.create';
export const PROPOSE_STATEMENT_PAYMENT_TOOL = 'cards.statement.pay';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'date must be a real YYYY-MM-DD');

/**
 * Strict transaction contract — mirrors the API's createExpenseInputSchema and
 * createIncomeInputSchema (the slice uses only their shared fields).
 */
export const transactionProposalArgsSchema = z
  .object({
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    description: z.string().trim().min(1).max(240),
    date: isoDate,
    accountId: z.string().uuid(),
    categoryId: z.string().uuid(),
  })
  .strict();

export const cardPurchaseProposalArgsSchema = z
  .object({
    /** TOTAL of the purchase — never a per-parcel amount. */
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    description: z.string().trim().min(1).max(240),
    date: isoDate,
    accountId: z.string().uuid(),
    categoryId: z.string().uuid().optional(),
    /** P3.5: optional parcel count (1–48). The API owns the split. */
    installmentsTotal: z.number().int().min(1).max(48).optional(),
  })
  .strict()
  .refine(
    (value) => value.installmentsTotal === undefined || value.installmentsTotal <= value.amountCents,
    { message: 'amountCents must cover at least 1 cent per installment', path: ['installmentsTotal'] },
  );

const intentBase = {
  intentionId: z.string().trim().min(1).max(128),
  normalizedArgs: transactionProposalArgsSchema,
} as const;

export const expenseProposalIntentSchema = z
  .object({ tool: z.literal(PROPOSE_EXPENSE_TOOL), ...intentBase })
  .strict();

export const incomeProposalIntentSchema = z
  .object({ tool: z.literal(PROPOSE_INCOME_TOOL), ...intentBase })
  .strict();

const cardIntentBase = {
  intentionId: z.string().trim().min(1).max(128),
  normalizedArgs: cardPurchaseProposalArgsSchema,
} as const;

export const cardPurchaseProposalIntentSchema = z
  .object({ tool: z.literal(PROPOSE_CARD_PURCHASE_TOOL), ...cardIntentBase })
  .strict();

/**
 * Internal-transfer contract — mirrors the API's createTransferInputSchema.
 * No category: an internal transfer is neither income nor expense. Origin and
 * destination are different accounts of the SAME workspace (the API revalidates).
 */
export const transferProposalArgsSchema = z
  .object({
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    description: z.string().trim().min(1).max(240),
    date: isoDate,
    fromAccountId: z.string().uuid(),
    toAccountId: z.string().uuid(),
  })
  .strict()
  .refine((value) => value.fromAccountId !== value.toAccountId, {
    message: 'fromAccountId and toAccountId must differ',
  });

export const transferProposalIntentSchema = z
  .object({
    tool: z.literal(PROPOSE_TRANSFER_TOOL),
    intentionId: z.string().trim().min(1).max(128),
    normalizedArgs: transferProposalArgsSchema,
  })
  .strict();

/**
 * P3.6 statement payment — EXACT execution tuple. The invoice id and payer
 * account id are resolved by the reader; `amountCents` is the amount paid
 * NOW (a total payment carries the authoritative remaining balance). There
 * is no "total" sentinel and no description/date to invent.
 */
export const statementPaymentProposalArgsSchema = z
  .object({
    statementId: z.string().uuid(),
    fromAccountId: z.string().uuid(),
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const statementPaymentProposalIntentSchema = z
  .object({
    tool: z.literal(PROPOSE_STATEMENT_PAYMENT_TOOL),
    intentionId: z.string().trim().min(1).max(128),
    normalizedArgs: statementPaymentProposalArgsSchema,
  })
  .strict();

/** Discriminated union: the broker route accepts these proposal tools. */
export const proposalIntentSchema = z.discriminatedUnion('tool', [
  expenseProposalIntentSchema,
  incomeProposalIntentSchema,
  cardPurchaseProposalIntentSchema,
  transferProposalIntentSchema,
  statementPaymentProposalIntentSchema,
]);

export type ExpenseProposalIntent = z.infer<typeof expenseProposalIntentSchema>;
export type IncomeProposalIntent = z.infer<typeof incomeProposalIntentSchema>;
export type CardPurchaseProposalIntent = z.infer<typeof cardPurchaseProposalIntentSchema>;
export type TransferProposalIntent = z.infer<typeof transferProposalIntentSchema>;
export type StatementPaymentProposalIntent = z.infer<typeof statementPaymentProposalIntentSchema>;
export type TransactionProposalIntent = z.infer<typeof proposalIntentSchema>;
export type ProposalBrokerIdentity = {
  actorId: string;
  workspaceId: string;
  deviceId: string;
  role: 'owner' | 'member';
};

export type ProposalBrokerResult = { id: string; existing: boolean };

function formatBRL(amountCents: number): string {
  return `R$ ${(amountCents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function proposalSummary(intent: TransactionProposalIntent): string {
  const amount = formatBRL(intent.normalizedArgs.amountCents);
  if (intent.tool === PROPOSE_STATEMENT_PAYMENT_TOOL) {
    return `Pagamento de fatura de ${amount}`;
  }
  if (intent.tool === PROPOSE_TRANSFER_TOOL) {
    return `Transferência de ${amount} em "${intent.normalizedArgs.description}"`;
  }
  const noun =
    intent.tool === PROPOSE_INCOME_TOOL
      ? 'Receita'
      : intent.tool === PROPOSE_CARD_PURCHASE_TOOL
        ? 'Compra no cartão'
        : 'Despesa';
  const installmentsTotal =
    intent.tool === PROPOSE_CARD_PURCHASE_TOOL ? intent.normalizedArgs.installmentsTotal : undefined;
  if (installmentsTotal !== undefined && installmentsTotal > 1) {
    return `${noun} de ${amount} em ${installmentsTotal}x em "${intent.normalizedArgs.description}"`;
  }
  return `${noun} de ${amount} em "${intent.normalizedArgs.description}"`;
}

/**
 * Mints the propose-only delegated token and persists the proposal through the
 * authoritative API. Throws the API's typed error (statusCode/code) on refusal;
 * the caller maps it without leaking dependency text.
 */
export async function proposeTransactionFromIntent(input: {
  intent: TransactionProposalIntent;
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
  const proposal = await createMutationProposal({
    tool: intent.tool,
    normalizedArgs: intent.normalizedArgs,
    summary: proposalSummary(intent),
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

/**
 * Backward-compatible expense entrypoint (P3.1 callers/tests). The generic
 * broker above is the single implementation; this only narrows the type.
 */
export function proposeExpenseFromIntent(input: {
  intent: ExpenseProposalIntent;
  identity: ProposalBrokerIdentity;
  secret: string;
  apiOrigin?: string;
  request?: typeof requestPiApiJson;
}): Promise<ProposalBrokerResult> {
  return proposeTransactionFromIntent(input);
}
