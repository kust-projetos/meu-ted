import { z } from "zod";
import type { MutationReceipt } from "@pi-finance/llm-contracts/types";
import { TED_APPROVAL_TOOLS } from "@pi-finance/llm-contracts/types";
import { fetchAgentConnectionToken, clearAgentConnectionTokenCache, trackAgentConnection } from "./agent-auth";
import { getOfflinePrincipalId } from "@/lib/auth/offline-identity";

export const attachmentSchema = z.object({
  type: z.enum(["image", "pdf", "audio"]),
  url: z.string(),
  name: z.string().optional(),
});

const historyItemSchema = z.object({
  id: z.string(),
  actorId: z.string().optional(),
  role: z.string(),
  content: z.string().optional(),
  text: z.string().optional(),
  createdAt: z.string().optional(),
  isOwn: z.boolean(),
  attachments: z.array(attachmentSchema).optional(),
  // FIX-169-170-R2 (P2-2): identidade estável do envio ecoada pelo Agent
  // (SPEC §7.7) — a reconciliação a usa como chave primária; ausente em
  // itens legados, que seguem a regra conteúdo+timestamp.
  intentionId: z.string().optional(),
  proposalOperationId: z.unknown().optional(),
  proposalTool: z.unknown().optional(),
  terminalOutcome: z.unknown().optional(),
  // §25.4 (browser reload during proposed/executing): the server may attach
  // the authoritative pending operation so the PWA rehydrates the approval
  // card from SERVER state. Raw input — sanitized in the transform below.
  pendingOperation: z.unknown().optional(),
}).transform((item): AgentMessage => {
  const pendingOperation = sanitizePendingOperation(
    item.pendingOperation as AgentTurn["pendingOperation"],
  );
  const terminalOutcome = sanitizeTerminalOutcome(item.terminalOutcome, item.proposalOperationId, item.proposalTool);
  const proposalOperationId = z.string().uuid().safeParse(item.proposalOperationId);
  const proposalTool = typeof item.proposalTool === 'string' && (TED_APPROVAL_TOOLS as readonly string[]).includes(item.proposalTool) ? item.proposalTool : undefined;
  return {
    id: item.id,
    actorId: item.actorId ?? (item.role === "assistant" ? "ted" : "unknown"),
    role: item.role,
    content: item.content ?? item.text ?? "",
    createdAt: item.createdAt,
    isOwn: item.isOwn,
    attachments: item.attachments,
    ...(typeof item.intentionId === "string" && item.intentionId ? { intentionId: item.intentionId } : {}),
    ...(proposalOperationId.success ? { proposalOperationId: proposalOperationId.data } : {}),
    ...(proposalTool ? { proposalTool } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    // Invalid/absent collapses to no card — never invented data.
    ...(pendingOperation === undefined ? {} : { pendingOperation }),
  };
});

const historySchema = z.object({
  items: z.array(historyItemSchema),
  total: z.number().optional(),
});

export type AgentMessage = {
  id: string;
  actorId: string;
  role: string;
  content: string;
  createdAt: string | undefined;
  isOwn: boolean;
  attachments?: Array<z.infer<typeof attachmentSchema>>;
  /**
   * FIX-169-170-R2 (P2-2): identidade estável do envio (SPEC §7.7) ecoada
   * pelo Agent quando o turno a gravou. Chave primária da reconciliação —
   * ausente em itens legados (fallback conteúdo+timestamp).
   */
  intentionId?: string;
  proposalOperationId?: string;
  proposalTool?: string;
  terminalOutcome?: TerminalOutcome;
  /**
   * §25.4: authoritative pending operation attached to a history item, when
   * the server emitted one. Same allowlist as the turn path — absent or
   * invalid means `undefined` (no card), never invented data.
   */
  pendingOperation?: AgentTurn["pendingOperation"];
};

function agentBaseUrl(): string {  // ADR-011: canonical browser transport is the same-origin proxy /api/agent.
  // V4.1 Phase 5 (SPEC §12.6): the browser default is the same-origin proxy —
  // no production hostname is an architectural dependency. An explicitly
  // configured direct URL is a dev/test-only escape hatch (ADR-011 transient
  // compat) — never a published production default.
  const direct = process.env.NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL?.replace(/\/$/, "");
  if (direct) return direct;
  // Fallback seguro ao proxy Next.js /api/agent quando a URL direta não estiver configurada.
  // Preserva token e X-Workspace-Id via forwardHeaders do proxy e evita CORS/misconfig.
  return "/api/agent";
}

const pendingOperationPresentationLabelSchema = z
  .object({ id: z.string(), label: z.string() })
  .strict();

/**
 * T3.4 (SPEC §16): browser-safe card projection. Strict: single-use approval
 * material and authority material are rejected — the card carries display data only.
 * Every field is optional except identity/title/expiry so legacy payloads
 * (old in-flight ops without a presentation) still parse.
 */
const pendingOperationPresentationSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    tool: z.string(),
    title: z.string(),
    amountCents: z.number().optional(),
    description: z.string().optional(),
    expectedDescription: z.string().min(1).max(240).optional(),
    transactionTargetId: z.string().min(1).max(128).optional(),
    transactionAmountCents: z.number().int().min(0).optional(),
    transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    transactionAccount: pendingOperationPresentationLabelSchema.optional(),
    date: z.string().optional(),
    account: pendingOperationPresentationLabelSchema.optional(),
    category: pendingOperationPresentationLabelSchema.optional(),
    categoryParent: pendingOperationPresentationLabelSchema.optional(),
    // accounts.create display tuple (contrato packages/llm-contracts):
    // nome + tipo + saldo inicial em vez da tupla transacional. Ausente em
    // payloads legados — o card degrada para a forma enxuta.
    // accounts.deactivate carrega o snapshot display-only balanceCents
    // (saldo no momento da proposta) + account {id,label} resolvido
    // server-side (gate do Confirm) — mesmo contrato.
    // categories.create carrega categoryName/categoryKind + parent `category`
    // {id,label} resolvido server-side (raiz sem parent segue acionável).
    accountName: z.string().min(1).max(120).optional(),
    accountKind: z.string().min(1).max(32).optional(),
    initialBalanceCents: z.number().int().optional(),
    balanceCents: z.number().int().optional(),
    categoryName: z.string().min(1).max(120).optional(),
    categoryKind: z.string().min(1).max(32).optional(),
    expiresAt: z.string(),
    warnings: z.array(z.string()),
  })
  .strict();

export type PendingOperationPresentation = z.infer<typeof pendingOperationPresentationSchema>;

/**
 * T3.3 (SPEC §15.1): browser-safe execution receipt. Strict allowlist with
 * the same shape as the shared `MutationReceipt` contract — a payload
 * carrying single-use approval material/authority material or ANY unknown key is dropped
 * wholesale (fail-closed), never partially forwarded to the reconciler.
 * Declared locally (not imported from the zod-bearing contracts entry) to
 * honor the client bundle budget; the type IS the shared contract type.
 */
const mutationReceiptSchema = z
  .object({
    mutationId: z.string().min(1),
    mutationKind: z.string().min(1),
    status: z.literal("succeeded"),
    affectedTargets: z.array(z.string()),
    operationId: z.string().min(1).optional(),
    entity: z.object({ type: z.string(), id: z.string() }).strict().optional(),
  })
  .strict();

export type PendingOperationReceipt = MutationReceipt;

/** Returns the receipt only when it exactly matches the browser-safe contract. */
function sanitizeMutationReceipt(value: unknown): PendingOperationReceipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = mutationReceiptSchema.safeParse(value);
  return parsed.success ? (parsed.data as PendingOperationReceipt) : undefined;
}

/**
 * HIGH3 (round 3): gateway-echoed authoritative context (tool + target id,
 * no authority material). Strict shape — anything else degrades to NO
 * context (callers fail closed on sensitive tools without context, never
 * accept a smuggled binding).
 */
function sanitizeExpectedContext(value: unknown): DecisionExpectedContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.tool !== "string" || !raw.tool.trim()) return undefined;
  if (raw.entityId !== undefined && (typeof raw.entityId !== "string" || !raw.entityId.trim())) {
    return undefined;
  }
  return raw.entityId !== undefined
    ? { tool: raw.tool.trim(), entityId: (raw.entityId as string).trim() }
    : { tool: raw.tool.trim() };
}

/**
 * HIGH3: authoritative expected context for a decision/turn receipt — the
 * ORIGINAL tool (+ the account target id when the card names a
 * pre-existing account), from the card presentation that authorized the
 * tap. A receipt for another tool/entity with the same pending id fails
 * closed. Without context the parser enforces the approval-kind +
 * linkage checks only (never accepts garbage).
 */
export type DecisionExpectedContext = Readonly<{
  tool?: string;
  entityId?: string;
}>;

export type TerminalOutcome = Readonly<
  | { operationId: string; tool: string; status: 'succeeded'; receipt: PendingOperationReceipt; expectedContext: DecisionExpectedContext }
  | { operationId: string; tool: string; status: 'failed'; failureCode?: 'in_use' }
  | { operationId: string; tool: string; status: 'cancelled' | 'expired' | 'unverified' }
>;

const terminalSuccessSchema = z.object({
  operationId: z.string().min(1), tool: z.string().min(1), status: z.literal('succeeded'),
  receipt: mutationReceiptSchema, expectedContext: z.object({ tool: z.string().min(1), entityId: z.string().min(1).optional() }).strict(),
}).strict();
const terminalFailureSchema = z.object({
  operationId: z.string().min(1), tool: z.string().min(1), status: z.literal('failed'), failureCode: z.literal('in_use').optional(),
}).strict();
const terminalOtherSchema = z.object({ operationId: z.string().min(1), tool: z.string().min(1), status: z.enum(['cancelled', 'expired', 'unverified']) }).strict();

function sanitizeTerminalOutcome(value: unknown, proposalOperationId: unknown, proposalTool: unknown): TerminalOutcome | undefined {
  const parsedProposalId = z.string().uuid().safeParse(proposalOperationId);
  if (!parsedProposalId.success || typeof proposalTool !== 'string' || !APPROVAL_TOOLS.includes(proposalTool) || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proposalId = parsedProposalId.data;
  const raw = value as Record<string, unknown>;
  if (raw.operationId !== proposalId || raw.tool !== proposalTool) return undefined;
  if (raw.status === 'succeeded') {
    const parsed = terminalSuccessSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const { receipt, expectedContext } = parsed.data;
    if (receipt.status !== 'succeeded' || receipt.operationId !== proposalId || receipt.mutationKind !== proposalTool || !receipt.entity || expectedContext.tool !== proposalTool) return undefined;
    const entityType = approvalEntityType(proposalTool);
    if (!entityType) return undefined;
    if (receipt.entity.type !== entityType) return undefined;
    const targetRequired = proposalTool === 'transactions.update' || proposalTool === 'accounts.update' || proposalTool === 'accounts.deactivate' || proposalTool === 'categories.update' || proposalTool === 'categories.deactivate';
    if (targetRequired && !expectedContext.entityId) return undefined;
    if (expectedContext.entityId !== undefined && expectedContext.entityId !== receipt.entity.id) return undefined;
    return parsed.data as TerminalOutcome;
  }
  if (raw.status === 'failed') {
    const parsed = terminalFailureSchema.safeParse(raw);
    if (!parsed.success || (parsed.data.failureCode === 'in_use' && proposalTool !== 'categories.deactivate')) return undefined;
    return parsed.data as TerminalOutcome;
  }
  const parsed = terminalOtherSchema.safeParse(raw);
  return parsed.success ? parsed.data as TerminalOutcome : undefined;
}

const APPROVAL_TOOLS = TED_APPROVAL_TOOLS as readonly string[];

const isAccountApprovalTool = (tool: string): boolean => tool.startsWith("accounts.");
const isCategoryApprovalTool = (tool: string): boolean => tool.startsWith("categories.");

/** Closed approval-tool mapping; unknown tools never inherit a fallback entity type. */
function approvalEntityType(tool: string): "transaction" | "account" | "category" | undefined {
  switch (tool) {
    case "transactions.expense.create":
    case "transactions.income.create":
    case "transactions.update":
      return "transaction";
    case "accounts.create":
    case "accounts.update":
    case "accounts.deactivate":
      return "account";
    case "categories.create":
    case "categories.update":
    case "categories.deactivate":
      return "category";
    default:
      return undefined;
  }
}

export const PENDING_OPERATION_STATUS = [
  "proposed",
  "confirmed",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

export type PendingOperationStatus = (typeof PENDING_OPERATION_STATUS)[number];

type AgentTurnPendingOperationBase = Readonly<{
  id: string;
  operation: string;
  summary?: string;
  presentation?: PendingOperationPresentation;
  /**
   * HIGH3 (round 3): gateway-echoed authoritative context (tool + target
   * id, no authority token). Binds the receipt instead of trusting the
   * response alone. Optional: absent on legacy payloads (PWA degrades —
   * sensitive tools fail closed without it).
   */
  expected?: DecisionExpectedContext;
}>;

export type AgentTurnPendingOperation =
  | (AgentTurnPendingOperationBase & Readonly<{
      status: "succeeded";
      receipt: PendingOperationReceipt;
    }>)
  | (AgentTurnPendingOperationBase & Readonly<{
      status: Exclude<PendingOperationStatus, "succeeded">;
      receipt?: never;
    }>);

export type AgentTurn = {
  turnId: string;
  status: string;
  attempts?: number;
  output?: string;
  memorized?: string[];
  pendingOperation?: AgentTurnPendingOperation;
  /**
   * debt-undo-confirmation-protocol: separate undo proposal (requestId for
   * the authenticated decision RPC). Display-only; the fixed target stays
   * server-side in the Agent DO.
   *
   * FIX-P1-UX #172: optional display-safe projection of that fixed target
   * (wire contract: `undoTargetSchema`). Absent on legacy payloads — the
   * card degrades to the summary shape.
   */
  undoProposal?: Readonly<{
    requestId: string;
    status: 'proposed';
    expiresAt: string;
    target?: Readonly<{
      kind?: string;
      description?: string;
      amountCents?: number;
      accountLabel?: string;
      occurredOn?: string;
    }>;
  }>;
};

/**
 * SPEC §16 visible-states contract (pt-BR), testable mapping from the
 * authoritative operation status to what the TED must show. Clarification
 * and stale states belong to T3.3 and are intentionally absent here.
 */
export const PENDING_OPERATION_STATUS_LABELS: Readonly<Record<PendingOperationStatus, string>> = {
  proposed: "aguardando aprovação",
  confirmed: "confirmada — processando operação…",
  executing: "processando operação…",
  succeeded: "concluída",
  failed: "falhou",
  cancelled: "cancelada",
  expired: "expirada",
};

export function describePendingOperationStatus(status: string): string {
  return (PENDING_OPERATION_STATUS_LABELS as Readonly<Record<string, string>>)[status] ?? status;
}

/** pt-BR currency for the card and the confirm button (cents → "R$ 850,00"). */
export function formatCentsToBRL(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/** Canonical YYYY-MM-DD → pt-BR "DD/MM/YYYY"; unknown shapes pass through. */
export function formatDateToBR(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  return match ? `${match[3]}/${match[2]}/${match[1]}` : isoDate;
}

/**
 * Allowlisted pending-operation DTO: only card-safe fields cross into the
 * turn. A presentation carrying single-use approval material (or any unknown
 * dropped — the operation itself still surfaces in its legacy shape.
 */
const executionOutcomeUnknown = (): Error & { code: string } =>
  Object.assign(
    new Error("O resultado desta operação ainda não pôde ser verificado. Atualize o estado antes de tomar outra decisão."),
    { code: "agent.execution_outcome_unknown" },
  );

function sanitizePendingOperation(value: unknown): AgentTurn["pendingOperation"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  // A server-asserted success may reach chat output/reconciliation only with
  // the canonical receipt linked to both the pending operation and the
  // persisted entity (transaction for transaction tools, account for
  // accounts.create/accounts.deactivate/accounts.update/categories.deactivate).
  //
  // HIGH3 (round 4): card-known context (presentation) precedes gateway
  // echo — and a conflict between them is denied, never resolved by
  // preferring echo. Echo+receipt agreement alone is never the sole
  // proof: without any card-known or plan-derived context, sensitive
  // tools fail closed.
  if (raw.status === "succeeded") {
    const candidateId = typeof raw.id === "string" ? raw.id : "";
    const candidateReceipt = sanitizeMutationReceipt(raw.receipt);
    const entityId = typeof candidateReceipt?.entity?.id === "string" ? candidateReceipt.entity.id.trim() : "";
    const presentationTool =
      raw.presentation && typeof raw.presentation === "object"
        ? (raw.presentation as { tool?: unknown }).tool
        : undefined;
    const presentationAccountId =
      raw.presentation && typeof raw.presentation === "object"
        ? (raw.presentation as { account?: { id?: unknown } }).account?.id
        : undefined;
    const echoExpected = sanitizeExpectedContext((raw as { expected?: unknown }).expected);
    // HIGH3 (round 4): card-known context (presentation) precedes gateway
    // echo — and a conflict between them is denied, never resolved by
    // preferring echo. Echo+receipt agreement alone is never the sole
    // proof: without any card-known or plan-derived context, sensitive
    // tools fail closed.
    let contextTool: string | undefined;
    let contextEntityId: string | undefined;
    if (
      typeof presentationTool === "string" &&
      APPROVAL_TOOLS.includes(presentationTool)
    ) {
      // Sensitive account targets bind ONLY with a resolved pre-existing
      // target id (presentation.account.id). Without it the card proves no
      // target — no context, never an arbitrary entity (fail-closed below).
      if (isCategoryApprovalTool(presentationTool)) {
        const presentationCategoryId =
          raw.presentation && typeof raw.presentation === "object"
            ? (raw.presentation as { category?: { id?: unknown } }).category?.id
            : undefined;
        // Sensitive category tools (categories.update) bind the RENAMED
        // target id. `categories.create` does NOT: its `category` label is
        // the PARENT, while the receipt carries the newly created category
        // (minted at execution) — kind-only policy, never a false failure.
        if (
          (presentationTool === "categories.update" || presentationTool === "categories.deactivate") &&
          typeof presentationCategoryId === "string" &&
          presentationCategoryId.trim()
        ) {
          contextTool = presentationTool;
          contextEntityId = presentationCategoryId.trim();
        } else {
          contextTool = presentationTool;
        }
      } else if (!isAccountApprovalTool(presentationTool)) {
        contextTool = presentationTool;
        if (presentationTool === "transactions.update") {
          const transactionTargetId =
            raw.presentation && typeof raw.presentation === "object"
              ? (raw.presentation as { transactionTargetId?: unknown }).transactionTargetId
              : undefined;
          if (typeof transactionTargetId === "string" && transactionTargetId.trim()) {
            contextEntityId = transactionTargetId.trim();
          }
        }
      } else if (
        typeof presentationAccountId === "string" &&
        presentationAccountId.trim()
      ) {
        contextTool = presentationTool;
        contextEntityId = presentationAccountId.trim();
      }
      if (echoExpected !== undefined && echoExpected.tool !== presentationTool) {
        throw executionOutcomeUnknown();
      }
      // Card and echo name the same tool but disagree on the target: two
      // authorizing contexts in conflict — deny, never prefer one of them.
      if (
        contextEntityId !== undefined &&
        echoExpected?.entityId !== undefined &&
        echoExpected.entityId !== contextEntityId
      ) {
        throw executionOutcomeUnknown();
      }
    } else if (echoExpected !== undefined) {
      contextTool = echoExpected.tool;
      contextEntityId = echoExpected.entityId;
    }
    const kind = candidateReceipt?.mutationKind;
    if (
      !candidateId.trim() ||
      !candidateReceipt ||
      typeof kind !== "string" ||
      !APPROVAL_TOOLS.includes(kind) ||
      candidateReceipt.operationId !== candidateId ||
      !entityId
    ) {
      throw executionOutcomeUnknown();
    }
    if (contextTool !== undefined) {
      if (kind !== contextTool) throw executionOutcomeUnknown();
      // entity.type/kind coherence holds in EVERY path: account tools bind
      // accounts, categories.create binds categories, every other approval
      // tool binds transactions.
      const expectsAccount =
        kind === "accounts.create" || kind === "accounts.update" || kind === "accounts.deactivate";
      const expectsCategory = kind === "categories.create" || kind === "categories.update" || kind === "categories.deactivate";
      if (
        (expectsAccount && candidateReceipt?.entity?.type !== "account") ||
        (expectsCategory && candidateReceipt?.entity?.type !== "category") ||
        (!expectsAccount && !expectsCategory && candidateReceipt?.entity?.type !== "transaction")
      ) {
        throw executionOutcomeUnknown();
      }
      if (contextEntityId !== undefined) {
        const expectedType = approvalEntityType(kind);
        if (candidateReceipt.entity?.id !== contextEntityId || candidateReceipt.entity?.type !== expectedType) {
          throw executionOutcomeUnknown();
        }
      }
      // Sensitive tools always bind a pre-existing target: a bare {tool}
      // context (no entity id from any context) never proves one.
      if (
        (kind === "transactions.update" || kind === "accounts.update" || kind === "accounts.deactivate" || kind === "categories.update" || kind === "categories.deactivate") &&
        contextEntityId === undefined
      ) {
        throw executionOutcomeUnknown();
      }
    } else {
      // No context: sensitive account targets are never accepted blind.
      if (kind === "transactions.update" || kind === "accounts.update" || kind === "accounts.deactivate" || kind === "categories.update" || kind === "categories.deactivate") {
        throw executionOutcomeUnknown();
      }
      // accounts-card-pwa-round2: a entidade vinculada respeita o kind — conta
      // só em accounts.create, categoria só em categories.create, transação
      // nos demais (preserva o gate estrito de transação e admite os
      // sucessos de criação). `categories.update` nunca chega aqui: o
      // guard acima já o recusou (alvo sensível sem contexto).
      const entityMatchesKind =
        kind === "accounts.create"
          ? candidateReceipt?.entity?.type === "account"
          : kind === "categories.create"
            ? candidateReceipt?.entity?.type === "category"
            : candidateReceipt?.entity?.type === "transaction";
      if (!entityMatchesKind) throw executionOutcomeUnknown();
    }
    // The turn operation itself is authoritative when it names an approval
    // tool (mutation turns): the receipt kind must equal it exactly.
    if (
      typeof raw.operation === "string" &&
      APPROVAL_TOOLS.includes(raw.operation) &&
      kind !== raw.operation
    ) {
      throw executionOutcomeUnknown();
    }
  }
  if (typeof raw.id !== "string" || !raw.id.trim() || typeof raw.operation !== "string") return undefined;
  if (!(PENDING_OPERATION_STATUS as readonly string[]).includes(String(raw.status))) return undefined;
  const id = raw.id;
  const status = raw.status as PendingOperationStatus;
  const operation = raw.operation;
  const summary = typeof raw.summary === "string" ? raw.summary : undefined;
  const parsedPresentation =
    raw.presentation && typeof raw.presentation === "object"
      ? pendingOperationPresentationSchema.safeParse(raw.presentation)
      : null;
  const receipt = sanitizeMutationReceipt(raw.receipt);
  if (status !== "succeeded" && raw.receipt !== undefined) {
    const err = new Error("A resposta da decisão não corresponde a um estado sem execução financeira.") as Error & { code?: string };
    err.code = "agent.invalid_decision_result";
    throw err;
  }
  const expected = sanitizeExpectedContext((raw as { expected?: unknown }).expected);
  const safeFields = {
    id,
    operation,
    ...(summary !== undefined ? { summary } : {}),
    ...(parsedPresentation && parsedPresentation.success ? { presentation: parsedPresentation.data } : {}),
    ...(expected !== undefined ? { expected } : {}),
  };
  if (status === "succeeded") {
    if (!receipt) throw executionOutcomeUnknown();
    return { ...safeFields, status, receipt };
  }
  return { ...safeFields, status };
}

/**
 * SPEC §7.7/§7.7.1 — stable per-turn message identity (PWA-owned).
 *
 * Every outgoing chat message gets a `messageId` generated ONCE at send
 * composition. Retries of the same send MUST reuse it (pass
 * `{ messageId }` back into `sendAgentMessage`); the id is sent as the
 * Agent's `intentionId`, so a lost HTTP response can never produce a second
 * proposal. Never regenerate on retry; a new message composes a new id.
 */
/**
 * A13: an outgoing attachment is EITHER an opaque server-side `ref` (the
 * reference flow) OR the legacy `url` shape. The local preview URL never
 * crosses the wire, so a sent attachment carries `ref` instead.
 */
export type OutgoingAttachment = Readonly<{
  type: string;
  url?: string;
  ref?: string;
  name: string;
}>;

export type PendingChatSend = Readonly<{
  messageId: string;
  content: string;
  createdAt: string;
  attachments?: ReadonlyArray<OutgoingAttachment>;
  /**
   * R2 FIX 1 (HIGH): `true` quando a âncora veio do formato legado (JSON sem
   * `anchorVersion`/`attachments`). O envio original podia ter anexos que se
   * perderam no formato antigo, então o retry é PROIBIDO — reenviar sem os
   * anexos mudaria o payload sob a mesma identidade (mesmo `intentionId`) e
   * derrubaria o veto de anexo no Agent. A UI reidrata como failed SEM retry.
   */
  legacyAnchor?: boolean;
  /**
   * R3 FIX 3 (MEDIUM): `true` quando o envio original carregava mais anexos
   * que o limite do servidor. Reenviar (truncado ou não) produziria um
   * payload diferente sob a mesma identidade — então o retry é PROIBIDO e a
   * UI reidrata como failed SEM retry, como na âncora legada.
   */
  overLimit?: boolean;
}>;

export function createChatMessageId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function composeChatSend(
  content: string,
  opts?: {
    attachments?: Array<OutgoingAttachment>;
    messageId?: string;
  },
): PendingChatSend {
  const messageId = opts?.messageId && opts.messageId.trim() ? opts.messageId.trim() : createChatMessageId();
  return {
    messageId,
    content,
    createdAt: new Date().toISOString(),
    ...(opts?.attachments ? { attachments: opts.attachments } : {}),
  };
}

/**
 * FIX-P1-SESS #176: a âncora de retry é isolada por (ator, workspace).
 *
 * A chave legada `ted.pending-send.${workspaceId}` não identifica o dono: o
 * ator B, no mesmo workspace/browser, reidratava o retry do ator A. A chave
 * com ator conhecido é `ted.pending-send.${actorId}.${workspaceId}`; sem
 * ator conhecido (fluxo deslogado/antigo) mantém-se a chave legada por
 * compatibilidade — e a legada NUNCA reidrata quando há principal ativo
 * (dono ambíguo => fail-closed, sem vazar para outra conta).
 */
const PENDING_SEND_KEY_PREFIX = "ted.pending-send.";
const pendingSendLegacyKey = (workspaceId: string): string => `${PENDING_SEND_KEY_PREFIX}${workspaceId}`;

function currentPendingSendActor(): string | null {
  try {
    return getOfflinePrincipalId();
  } catch {
    return null;
  }
}

function resolvePendingSendActor(explicit?: string | null): string | null {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (explicit === undefined) return currentPendingSendActor();
  return null;
}

const pendingSendKey = (workspaceId: string, actorId?: string | null): string => {
  const actor = resolvePendingSendActor(actorId);
  return actor ? `${PENDING_SEND_KEY_PREFIX}${actor}.${workspaceId}` : pendingSendLegacyKey(workspaceId);
};

/**
 * R2 FIX 1 (HIGH): a âncora persiste as REFS dos anexos (`{type,ref,name}` —
 * JSON pequeno, referências opacas já emitidas pelo servidor), nunca blob
 * URLs locais (inúteis após o reload) e nunca segredos. No load, os refs
 * voltam no draft para que o retry reenvie o MESMO payload sob a MESMA
 * identidade (`intentionId`).
 */
const CHAT_SEND_ANCHOR_VERSION = 1;
const ANCHOR_ATTACHMENT_TYPES: ReadonlySet<string> = new Set(["image", "pdf", "audio"]);
/**
 * R3 FIX 3: limite de anexos por envio — o MESMO número do servidor
 * (`MAX_CHAT_ATTACHMENTS = 10` em `apps/agent/src/finance-chat-agent.ts`,
 * que responde 413 `agent.payload_too_large` acima disso). A âncora e a UI
 * usam este número; nenhum teto próprio/inventado no cliente.
 */
export const CHAT_SEND_ATTACHMENT_LIMIT = 10;

function sanitizeAnchorAttachment(value: unknown): OutgoingAttachment | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.type !== "string" || !ANCHOR_ATTACHMENT_TYPES.has(item.type)) return null;
  if (typeof item.name !== "string" || item.name.length === 0 || item.name.length > 256) return null;
  if (
    item.ref !== undefined &&
    (typeof item.ref !== "string" || item.ref.length === 0 || item.ref.length > 512)
  ) {
    return null;
  }
  return {
    type: item.type,
    url: "",
    name: item.name,
    ...(typeof item.ref === "string" ? { ref: item.ref } : {}),
  };
}

/**
 * Persists the in-flight send record (messageId + content + attachment refs —
 * never secrets, never local blob URLs) so a page reload restores the same
 * id for retry. Scoped by (actor, workspace) — see #176 above.
 */
export function savePendingChatSend(workspaceId: string, send: PendingChatSend, actorId?: string | null): void {
  try {
    const raw = Array.isArray(send.attachments) ? send.attachments : [];
    // R3 FIX 3: NUNCA truncar. Um envio acima do limite persiste marcado
    // `overLimit` (sem retry) — os 10 primeiros sob a mesma identidade seriam
    // um payload DIFERENTE do original (o 11º levaria 413 no servidor).
    const overLimit = send.overLimit === true || raw.length > CHAT_SEND_ATTACHMENT_LIMIT;
    const attachments = raw.map((a) => ({
      type: a.type,
      name: a.name,
      ...(typeof a.ref === "string" && a.ref ? { ref: a.ref } : {}),
    }));
    sessionStorage.setItem(
      pendingSendKey(workspaceId, actorId),
      JSON.stringify({
        anchorVersion: CHAT_SEND_ANCHOR_VERSION,
        messageId: send.messageId,
        content: send.content,
        createdAt: send.createdAt,
        attachments,
        ...(overLimit ? { overLimit: true } : {}),
      }),
    );
  } catch {
    // Storage unavailable (private mode): the in-memory retry path still reuses the id.
  }
}

export function loadPendingChatSend(workspaceId: string, actorId?: string | null): PendingChatSend | null {
  try {
    const actor = resolvePendingSendActor(actorId);
    // #176: com principal ativo, a chave legada (sem ator, dono ambíguo)
    // nunca reidrata — só a chave do próprio ator. Sem principal, a legada
    // segue valendo (fluxo antigo/deslogado).
    const raw = actor !== null
      ? sessionStorage.getItem(pendingSendKey(workspaceId, actor))
      : sessionStorage.getItem(pendingSendLegacyKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      messageId?: unknown;
      content?: unknown;
      createdAt?: unknown;
      anchorVersion?: unknown;
      attachments?: unknown;
      overLimit?: unknown;
    };
    if (typeof parsed.messageId !== "string" || !parsed.messageId || typeof parsed.content !== "string") return null;
    const base = {
      messageId: parsed.messageId,
      content: parsed.content,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
    };
    // Formato legado (gravado antes do FIX 1): sem versão nem anexos — o
    // envio original podia ter anexos, então volta marcado como legado (sem
    // retry; ver `legacyAnchor`). Âncoras sem timestamp caem no epoch, o que
    // preserva a regra conservadora anterior (igualdade textual suprime).
    if (parsed.anchorVersion !== CHAT_SEND_ANCHOR_VERSION || !Array.isArray(parsed.attachments)) {
      return { ...base, legacyAnchor: true };
    }
    // R3 FIX 3: âncora acima do limite — nunca retryable. Defesa em
    // profundidade dupla: a flag gravada pelo save novo OU a contagem real
    // (âncora artesanal/antiga com 11 itens vira non-retryable aqui).
    if (parsed.overLimit === true || parsed.attachments.length > CHAT_SEND_ATTACHMENT_LIMIT) {
      return { ...base, overLimit: true };
    }
    const attachments: OutgoingAttachment[] = [];
    for (const item of parsed.attachments) {
      const clean = sanitizeAnchorAttachment(item);
      // Anexo corrompido = payload não mais fiel → trata como legado (sem retry).
      if (!clean) return { ...base, legacyAnchor: true };
      attachments.push(clean);
    }
    return { ...base, attachments };
  } catch {
    return null;
  }
}

/**
 * R3 FIX 2: evidência de anexo no histórico do servidor. Um turno com anexo
 * persiste como placeholder `[anexo …]` (sem extração aceita) ou ABRINDO com
 * o portador de proveniência da extração aceita (STT/visão/PDF) — ver
 * `finance-chat-agent.ts` (`attachmentPlaceholder`,
 * `composeTurnTextWithAttachmentData`). Texto arbitrário nunca conta: sem
 * heurística textual permissiva.
 *
 * R4 FIX (MEDIUM): o marcador vale somente como PREFIXO estrutural
 * (`startsWith`) — é assim que o servidor compõe o turno (placeholder ou
 * portador de extração no INÍCIO). Texto puro posterior que apenas CITA o
 * marcador no meio (ex: "O que significa [anexo nota.jpg]?") NÃO é evidência
 * de anexo: fail-closed, mantém o failed+retry.
 */
const ATTACHMENT_HISTORY_MARKERS: readonly string[] = [
  "[anexo ",
  "[transcrição do anexo de áudio",
  "[dados extraídos do anexo de imagem",
  "[texto extraído do anexo em PDF",
];

type HistoryItemForSupersede = Pick<AgentMessage, "isOwn" | "content" | "createdAt" | "attachments" | "intentionId">;

function historyItemCarriesAttachment(item: HistoryItemForSupersede): boolean {
  if (Array.isArray(item.attachments) && item.attachments.length > 0) return true;
  return (
    typeof item.content === "string" &&
    ATTACHMENT_HISTORY_MARKERS.some((marker) => item.content.startsWith(marker))
  );
}

/**
 * FIX-169-170-R3 (MEDIUM): o item carrega identidade conhecida (intentionId
 * ecoado pelo Agent) que diverge da identidade da âncora. Só diverge quando
 * OS DOIS lados são conhecidos: item legado sem intentionId e âncora sem
 * identidade seguem o fallback legado (conteúdo+timestamp) inalterado.
 */
function hasDivergingIdentity(item: HistoryItemForSupersede, anchorIdentity: string | undefined): boolean {
  return (
    anchorIdentity !== undefined &&
    typeof item.intentionId === "string" &&
    item.intentionId.length > 0 &&
    item.intentionId !== anchorIdentity
  );
}

/**
 * FIX-melhorias item 3: a resposta do turno convergiu quando o lote
 * autoritativo já traz a resposta DESTE turno — item do assistente com o
 * mesmo texto E o intentionId do envio (SPEC §7.7: o messageId do PWA viaja
 * como intentionId; o Agent persiste o par Q&A de mutação/continuação/retry
 * com ele e o /rpc/history o ecoa). Regra pura, sem schema: não toca no
 * protocolo nem em zod. Sem identidade em jogo (turno read persistido sem
 * intentionId, item legado), retorna false e a contagem legada por texto
 * decide como antes. Restrita a itens do assistente: o eco existe também no
 * item próprio do mesmo turno, que nunca confirma a resposta.
 */
export function isTurnAnswerConvergedByIdentity(
  output: string | undefined,
  turnIntentionId: string | undefined,
  history: ReadonlyArray<Pick<AgentMessage, "isOwn" | "content" | "intentionId">>,
): boolean {
  if (!output || !turnIntentionId) return false;
  return history.some(
    (item) => !item.isOwn && item.content === output && item.intentionId === turnIntentionId,
  );
}

/**
 * R2 FIX 2 + FIX 3 (MEDIUM): critério temporal único para reconciliar a
 * âncora contra o histórico autoritativo. A âncora é considerada superada
 * somente quando o histórico traz mensagem própria de conteúdo idêntico com
 * timestamp >= timestamp da âncora (o servidor persistiu DEPOIS do envio).
 * Igualdade textual sozinha NÃO confirma nada: um "Bom dia" antigo nunca
 * suprime um novo envio "Bom dia".
 *
 * Casos sem timestamp confiável (âncora legada no epoch, histórico sem
 * `createdAt`) seguem a regra conservadora anterior — igualdade textual
 * suprime — porque não há como provar a ordem; ver FIX 2.
 *
 * R3 FIX 2 (MEDIUM): âncora COM anexos segue regra própria. O conteúdo da
 * âncora é SÓ o digitado (`""` no envio só-anexo) enquanto o servidor
 * persiste placeholder/extração — igualdade textual nunca casaria (ou
 * casaria errado: um texto idêntico posterior sem anexo é OUTRO envio, não
 * a persistência deste). A âncora com anexos só é superada por mensagem
 * própria POSTERIOR com evidência de anexo (placeholder, portador de
 * extração real ou `attachments` no item). Sem ordem confiável: fail-closed
 * (mantém o failed, nunca suprime).
 *
 * Limite documentado: o histórico não carrega refs nem identidade do envio,
 * então a correlação é marcador+timestamp — duas âncoras só-anexo próximas
 * podem colidir num mesmo marcador. Fail-closed nos cantos (sem
 * marcador/sem ordem) em vez de heurística permissiva.
 *
 * FIX-169-170-R2 (P2-2): quando AMBOS os lados carregam a identidade estável
 * (âncora `messageId`/`intentionId` = intentionId enviado; item
 * `intentionId` ecoado pelo Agent), ela é a CHAVE PRIMÁRIA — supera DLP
 * (conteúdo divergente do digitado) e clock skew (timestamp anterior) sem
 * fantasma permanente. Restrita a itens próprios: o eco existe também em
 * itens do assistente do mesmo turno, que nunca absorvem a âncora do
 * usuário. Sem identidade em jogo, a regra legada abaixo vale inalterada.
 */
export function isAnchorSupersededByHistory(
  anchor: Pick<PendingChatSend, "content" | "createdAt" | "attachments"> & Partial<Pick<PendingChatSend, "messageId">> & { intentionId?: string },
  history: ReadonlyArray<HistoryItemForSupersede>,
): boolean {
  const anchorIdentity =
    typeof anchor.intentionId === "string" && anchor.intentionId
      ? anchor.intentionId
      : typeof anchor.messageId === "string" && anchor.messageId
        ? anchor.messageId
        : undefined;
  if (anchorIdentity !== undefined) {
    for (const item of history) {
      if (!item.isOwn) continue;
      if (typeof item.intentionId === "string" && item.intentionId && item.intentionId === anchorIdentity) return true;
    }
  }
  const anchorAttachments = Array.isArray(anchor.attachments) ? anchor.attachments : [];
  if (anchorAttachments.length > 0) {
    const anchorTime = Date.parse(anchor.createdAt);
    if (Number.isNaN(anchorTime)) return false;
    for (const item of history) {
      if (!item.isOwn) continue;
      // FIX-169-170-R3 (MEDIUM): identidade conhecida e DIFERENTE da âncora
      // prova outro envio — nunca reconcilia pelo fallback marcador+timestamp.
      if (hasDivergingIdentity(item, anchorIdentity)) continue;
      const itemTime = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : NaN;
      if (Number.isNaN(itemTime) || itemTime < anchorTime) continue;
      if (historyItemCarriesAttachment(item)) return true;
    }
    return false;
  }
  const anchorTime = Date.parse(anchor.createdAt);
  for (const item of history) {
    if (!item.isOwn || item.content !== anchor.content) continue;
    // FIX-169-170-R3 (MEDIUM): mesmo texto + ts posterior com intentionId
    // DIFERENTE é outro envio (send-B), não a persistência da âncora (send-A).
    if (hasDivergingIdentity(item, anchorIdentity)) continue;
    if (Number.isNaN(anchorTime)) return true;
    const itemTime = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : NaN;
    if (Number.isNaN(itemTime)) return true;
    if (itemTime >= anchorTime) return true;
  }
  return false;
}

/**
 * R3 FIX 1 (HIGH): decisão de retry FORA do updater de reconciliação — pura
 * e testável. Com draft armazenado, reusa (mesma identidade, mesmo payload).
 * Sem draft e com qualquer resíduo de anexo (no snapshot da âncora ou no
 * próprio balão), RECUSA (`null`): o payload fiel se perdeu e reenviar sem
 * os anexos mudaria o envio sob a mesma identidade (`intentionId`). Sem
 * draft e texto puro, recompõe o mesmo messageId e conteúdo.
 */
export function resolveRetrySend(input: {
  messageId: string;
  failed: {
    content: string;
    attachments?: ReadonlyArray<{ type: string; url?: string; name?: string }>;
  };
  stored?: PendingChatSend;
  snapshotAttachments?: ReadonlyArray<OutgoingAttachment>;
}): PendingChatSend | null {
  if (input.stored) return input.stored;
  const snapshotHas =
    Array.isArray(input.snapshotAttachments) && input.snapshotAttachments.length > 0;
  const balloonHas = Array.isArray(input.failed.attachments) && input.failed.attachments.length > 0;
  if (snapshotHas || balloonHas) return null;
  return composeChatSend(input.failed.content, { messageId: input.messageId });
}

export function clearPendingChatSend(workspaceId: string, actorId?: string | null): void {
  try {
    // #176: limpa a âncora do próprio escopo E a legada ambígua do workspace
    // (o sucesso do envio encerra qualquer retry pendente dali).
    const actor = resolvePendingSendActor(actorId);
    if (actor !== null) sessionStorage.removeItem(pendingSendKey(workspaceId, actor));
    sessionStorage.removeItem(pendingSendLegacyKey(workspaceId));
  } catch {
    // Best effort.
  }
}

/**
 * FIX-P1-SESS #176: purga TODAS as âncoras de retry (`ted.pending-send.*`,
 * com e sem ator) — teardown de sessão (logout, troca de principal,
 * revogação). Chamada por `clearSensitiveSession`; best-effort, nunca lança.
 */
export function clearAllPendingChatSends(): void {
  try {
    const storage =
      typeof sessionStorage !== "undefined" ? sessionStorage : null;
    if (!storage) return;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(PENDING_SEND_KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    // Best effort.
  }
}

const pendingDecisionSchema = z.object({
  operationId: z.string(),
  status: z.enum(["proposed", "succeeded", "failed", "cancelled", "expired"]),
  retryable: z.boolean().optional(),
  failureCode: z.literal('in_use').optional(),
  // Raw receipt is parsed separately: the strict schema drops any payload
  // carrying single-use approval material or unknown keys WHOLESALE (INV-05, T3.3).
  receipt: z.unknown().optional(),
}).strict();

type PendingOperationDecisionStatus = z.infer<typeof pendingDecisionSchema>["status"];

/** Safe result of an approval decision. Attestations never cross the browser boundary. */
export type PendingOperationDecision =
  | {
      operationId: string;
      status: "succeeded";
      retryable?: boolean;
      failureCode?: 'in_use';
      /** A success is only actionable when it carries its canonical receipt. */
      receipt: PendingOperationReceipt;
    }
  | {
      operationId: string;
      status: Exclude<PendingOperationDecisionStatus, "succeeded">;
      retryable?: boolean;
      failureCode?: 'in_use';
      receipt?: never;
    };

/**
 * Error shapes do caminho do Agent. O Agent emite `{ code, message }`
 * top-level e o proxy same-origin repassa o corpo do upstream intacto — mas
 * os erros GERADOS pelo próprio proxy (misconfig, csrf, 413, timeout 504,
 * 502 upstream_unavailable) usam o envelope `{ ok:false, error:{code,message} }`
 * (route.ts upstreamErrorResponse). Ambos os shapes são server-authored e
 * exibíveis; este leitor aceita os dois para nenhum 502 perder code+message.
 */
function readAgentErrorFields(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object") return {};
  const raw = body as Record<string, unknown>;
  const nested = raw.error;
  const nestedFields =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
  const code = raw.code ?? nestedFields?.code;
  const message = raw.message ?? nestedFields?.message;
  return {
    ...(typeof code === "string" && code ? { code } : {}),
    ...(typeof message === "string" && message ? { message } : {}),
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorMsg = "Operação do agente falhou.";
    let errorCode: string | undefined;
    try {
      const fields = readAgentErrorFields(await response.json());
      if (fields.message) errorMsg = fields.message;
      if (fields.code) errorCode = fields.code;
    } catch {
      // fallback
    }
    // debt-undo-confirmation-race-fix: the machine-readable code crosses so
    // the UI can tell pending (`undo.executing`) from terminal outcomes.
    // Additive only — callers that read just `message` are unaffected.
    const err = new Error(errorMsg) as Error & { code?: string };
    if (errorCode) err.code = errorCode;
    throw err;
  }
  return await response.json() as T;
}

async function agentAuthHeaders(workspaceId: string, forceFresh = false): Promise<Record<string, string>> {
  // C-01: connection tokens are single-use — every call mints fresh.
  const token = await fetchAgentConnectionToken(workspaceId, forceFresh);
  return { "x-agent-connection-token": token };
}

const peekErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    return readAgentErrorFields(await response.clone().json()).code;
  } catch {
    return undefined;
  }
};

/**
 * Authenticated agent fetch (H-05/C-01): fresh single-use token per call;
 * exactly ONE retry on `agent.token_replayed` (stale bearer raced with the
 * single-use consumption); cache invalidated on any 401/403 so logout,
 * user switch and workspace switch never reuse a previous bearer.
 */
async function fetchWithAgentAuth(workspaceId: string, url: string, init: RequestInit): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const authHeaders = await agentAuthHeaders(workspaceId, true);
    // H-13: the flight is tracked so logout/401/workspace-switch aborts it.
    // The caller's own signal (if any) is linked, never replaced.
    const callerSignal = init.signal instanceof AbortSignal ? init.signal : null;
    const { signal, release } = trackAgentConnection(callerSignal);
    try {
      return await fetch(url, {
        ...init,
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), ...authHeaders },
        signal,
      });
    } finally {
      release();
    }
  };
  let res = await attempt();
  if (res.ok) return res;
  if ((await peekErrorCode(res)) === "agent.token_replayed") {
    clearAgentConnectionTokenCache();
    res = await attempt();
    if (res.ok) return res;
  } else if (res.status === 401 || res.status === 403) {
    clearAgentConnectionTokenCache();
  }
  return res;
}

/**
 * A13 — attachment upload result. The Agent answers with an OPAQUE server-side
 * reference; there is no public URL and no base64 in this shape.
 */
export const uploadedAttachmentSchema = z.object({
  ref: z.string().regex(/^att_[A-Za-z0-9_-]{16,64}$/),
  kind: z.enum(["image", "pdf", "audio"]),
  name: z.string(),
  size: z.number().int().nonnegative(),
});

export type UploadedAttachment = z.infer<typeof uploadedAttachmentSchema>;

export type AttachmentUploadKind = "image" | "pdf" | "audio";

/**
 * A13 — REAL upload against the Agent's `POST /rpc/attachments`.
 *
 * The bytes go out as a raw binary body with the DECLARED kind/name in headers;
 * the server re-derives the real media type from magic bytes, so a lying
 * client is rejected there. The answer is validated: a payload without a
 * well-formed `ref` throws instead of inventing a reference (fail-closed).
 * Failures carry the typed `code` so the UI can render an explicit state.
 */
export async function uploadAttachment(
  workspaceId: string,
  input: { kind: AttachmentUploadKind; file: File | Blob; name?: string },
): Promise<UploadedAttachment> {
  const baseUrl = agentBaseUrl();
  const name = input.name ?? (input.file instanceof File ? input.file.name : "anexo");
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/attachments`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": input.file.type || "application/octet-stream",
        "X-Workspace-Id": workspaceId,
        "x-ted-attachment-kind": input.kind,
        "x-ted-attachment-name": name,
      },
      body: await input.file.arrayBuffer(),
    },
  );
  if (!response.ok) {
    let errorMsg = "Não foi possível enviar o anexo.";
    let errorCode: string | undefined;
    try {
      const fields = readAgentErrorFields(await response.json());
      if (fields.message) errorMsg = fields.message;
      if (fields.code) errorCode = fields.code;
    } catch {
      /* keep the default message */
    }
    const err = new Error(errorMsg) as Error & { code?: string; status?: number };
    err.status = response.status;
    err.code = errorCode ?? "attachment_upload_failed";
    throw err;
  }
  const parsed = uploadedAttachmentSchema.safeParse(await response.json());
  if (!parsed.success) {
    // Never fabricate a reference the Agent did not issue.
    const err = new Error("O anexo não pôde ser identificado.") as Error & { code?: string };
    err.code = "attachment_upload_invalid_response";
    throw err;
  }
  return parsed.data;
}

export async function sendAgentMessage(
  workspaceId: string,
  content: string,
  opts?: { attachments?: Array<OutgoingAttachment>; messageId?: string },
): Promise<AgentTurn> {
  const baseUrl = agentBaseUrl();
  // SPEC §7.7: the send identity is fixed ONCE here; retries pass the same
  // messageId back and the pending record keeps it across reloads.
  const messageId = opts?.messageId && opts.messageId.trim() ? opts.messageId.trim() : createChatMessageId();
  savePendingChatSend(workspaceId, {
    messageId,
    content,
    createdAt: new Date().toISOString(),
    ...(opts?.attachments ? { attachments: opts.attachments } : {}),
  });
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/chat`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "X-Workspace-Id": workspaceId,
      },
      body: JSON.stringify({ text: content, attachments: opts?.attachments, intentionId: messageId }),
    },
  );
  if (!response.ok) {
    let errorMsg = "Operação do agente falhou.";
    let errorCode: string | undefined;
    try {
      const fields = readAgentErrorFields(await response.json());
      if (fields.message) errorMsg = fields.message;
      if (fields.code) errorCode = fields.code;
    } catch {
      // use default message
    }
    // Preserve 401/403 sem mascarar: anexa code/status ao erro para caller distinguir sem vazar segredo
    const err = new Error(errorMsg) as Error & { status?: number; code?: string };
    err.status = response.status;
    if (errorCode) err.code = errorCode;
    else if (response.status === 401) err.code = "auth.session_required";
    else if (response.status === 403) err.code = "auth.workspace_forbidden";
    throw err;
  }
  const data = await response.json() as { turnId?: string; intentionId?: string; status?: string; output?: string; memorized?: string[]; pendingOperation?: unknown; undoProposal?: unknown };
  const pendingOperation = sanitizePendingOperation(data.pendingOperation);
  const undoProposal = sanitizeUndoProposal(data.undoProposal as AgentTurn["undoProposal"]);
  // The turn landed: the in-flight record is no longer needed. On failure
  // (including an unlinked succeeded receipt) it stays, so retry reuses the
  // same idempotent messageId.
  // P2-1 (retry pós-reload): um 200 sem output E sem decisão estruturada
  // (pendingOperation/undoProposal) NÃO é sucesso — é falha retentável, então
  // a âncora/storage SOBREVIVE para o retry reusar a MESMA identidade §7.7
  // mesmo após reload/remount. Só sucesso real limpa.
  const hasRealResult = Boolean(data.output?.trim() || pendingOperation || undoProposal);
  if (hasRealResult) {
    clearPendingChatSend(workspaceId);
  }
  return {
    turnId: data.turnId ?? data.intentionId ?? `turn-${Date.now()}`,
    status: data.status ?? "completed",
    output: data.output,
    ...(Array.isArray(data.memorized) ? { memorized: data.memorized.filter((m): m is string => typeof m === "string") } : {}),
    ...(pendingOperation ? { pendingOperation } : {}),
    ...(undoProposal ? { undoProposal } : {}),
  };
}

/**
 * Sends a user decision to the authenticated Agent. The Agent, not the
 * browser, owns V2 confirmation, credential consumption and execution.
 *
 * HIGH3: `expected` carries the authoritative card context (ORIGINAL tool
 * + account target id from the presentation that authorized the tap).
 * A receipt for another tool/entity with the same pending id fails
 * closed. Optional: without it the approval-kind + linkage checks still
 * apply.
 */
export async function decidePendingOperation(
  workspaceId: string,
  operationId: string,
  decision: "confirm" | "cancel" | "retry",
  expected?: DecisionExpectedContext,
): Promise<PendingOperationDecision> {
  const baseUrl = agentBaseUrl();
  const requestId = crypto.randomUUID();
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/pending-operations/${encodeURIComponent(operationId)}/decision`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "X-Workspace-Id": workspaceId },
      body: JSON.stringify({ decision, requestId }),
    },
  );
  let rawDecision: unknown;
  try {
    rawDecision = await parseJson<unknown>(response);
  } catch (parseErr) {
    // Resposta de erro (!ok) mantém o fluxo original do parseJson (mensagem
    // + code do Agent) — só corpo 2xx indecodificável (vazio/truncado) é
    // outcome NÃO verificado: a decisão pode já ter executado.
    if (!response.ok) throw parseErr;
    const err = new Error(
      "O resultado desta operação ainda não pôde ser verificado. Atualize o estado antes de tomar outra decisão.",
    ) as Error & { code?: string };
    err.code = "agent.execution_outcome_unknown";
    throw err;
  }
  // P2-2: falhas de parsing/validação da resposta de decisão são resultado
  // NÃO verificado (ex.: `succeeded` com campo extra rejeitado pelo
  // `.strict()`). Sem receipt canônico vinculado, a decisão pode já ter
  // executado — o card trava como unverified (lock + reconciliação
  // obrigatória), nunca com botões de decisão. Nunca `ZodError` cru.
  const decisionResult = pendingDecisionSchema.safeParse(rawDecision);
  if (!decisionResult.success) {
    const err = new Error(
      "O resultado desta operação ainda não pôde ser verificado. Atualize o estado antes de tomar outra decisão.",
    ) as Error & { code?: string };
    err.code = "agent.execution_outcome_unknown";
    throw err;
  }
  const parsed = decisionResult.data;
  const receipt = sanitizeMutationReceipt(parsed.receipt);
  const safe = {
    operationId: parsed.operationId,
    status: parsed.status,
    ...(parsed.retryable !== undefined ? { retryable: parsed.retryable } : {}),
    ...(parsed.status === 'failed' && parsed.failureCode === 'in_use' ? { failureCode: 'in_use' as const } : {}),
  };
  if (safe.operationId !== operationId) {
    const err = new Error(
      "O resultado desta operação ainda não pôde ser verificado. Atualize o estado antes de tomar outra decisão.",
    ) as Error & { code?: string };
    err.code = "agent.execution_outcome_unknown";
    throw err;
  }
  // Fail-closed succeeded: the API+Agent contract guarantees a successful
  // execute carries the pending ID + nested succeeded execution + canonical
  // receipt (receipt.operationId === pending ID, entity {type:'transaction' |
  // 'account' | 'category', id: persistedId} com o tipo vinculado ao kind:
  // conta só em accounts.create/accounts.deactivate/accounts.update, categoria
  // só em categories.create, transação nos demais). A succeeded decision without that receipt
  // cannot be reconciled, so it must reject — never resolve as success. Other
  // statuses (cancelled/failed/proposed/expired) carry no receipt by contract.
  //
  // HIGH3 (round 3): approval-path receipts always carry approval-tool
  // kinds — a normal-write receipt with the same pending id is a swapped
  // result, never a success. Rename/deactivate WITHOUT the card `expected`
  // context fail closed (sensitive target, no proof); with it, the kind
  // must equal the ORIGINAL tool and the entity must equal the ORIGINAL
  // target id. `accounts.create`/`categories.create` keep the kind-only
  // policy (entity minted at execution — never blocks honest creation).
  if (safe.status === "succeeded") {
    const entityId = typeof receipt?.entity?.id === "string" ? receipt.entity.id.trim() : "";
    const kind = receipt?.mutationKind;
    const entityMatchesKind = receipt?.entity?.type === approvalEntityType(kind ?? "");
    if (
      !receipt ||
      typeof kind !== "string" ||
      !APPROVAL_TOOLS.includes(kind) ||
      receipt.operationId !== operationId ||
      !entityMatchesKind ||
      !entityId
    ) {
      const err = new Error(
        "O resultado desta operação ainda não pôde ser verificado. Atualize o estado antes de tomar outra decisão.",
      ) as Error & { code?: string };
      err.code = "agent.execution_outcome_unknown";
      throw err;
    }
    if (
        (expected === undefined &&
        (kind === "transactions.update" || kind === "accounts.update" ||
          kind === "accounts.deactivate" ||
          kind === "categories.update" || kind === "categories.deactivate")) ||
      ((kind === "transactions.update" || kind === "accounts.update" ||
        kind === "accounts.deactivate" ||
        kind === "categories.update" || kind === "categories.deactivate") &&
        (typeof expected?.entityId !== "string" || !expected.entityId.trim())) ||
      (expected?.tool !== undefined && kind !== expected.tool) ||
      (expected?.entityId !== undefined &&
        (receipt.entity?.id !== expected.entityId || receipt.entity?.type !== approvalEntityType(kind)))
    ) {
      const err = new Error(
        "O resultado desta operação ainda não pôde ser verificado. Atualize o estado antes de tomar outra decisão.",
      ) as Error & { code?: string };
      err.code = "agent.execution_outcome_unknown";
      throw err;
    }
    return {
      operationId: safe.operationId,
      status: "succeeded",
      ...(safe.retryable !== undefined ? { retryable: safe.retryable } : {}),
      receipt,
    };
  }
  if (parsed.receipt !== undefined) {
    const err = new Error(
      "A resposta da decisão não corresponde a um estado sem execução financeira.",
    ) as Error & { code?: string };
    err.code = "agent.invalid_decision_result";
    throw err;
  }
  return {
    operationId: safe.operationId,
    status: safe.status,
    ...(safe.retryable !== undefined ? { retryable: safe.retryable } : {}),
    ...(safe.status === 'failed' && parsed.failureCode === 'in_use' ? { failureCode: 'in_use' as const } : {}),
  };
}

/**
 * debt-undo-confirmation-protocol: browser-safe undo proposal DTO. Strict
 * allowlist — anything else collapses to `undefined` (no card).
 *
 * FIX-P1-UX #172: display-safe projection of the fixed undo target. Strict
 * allowlist of presentation-only fields — anything else (in particular
 * target ids, idempotency keys, or raw operation data smuggled inside
 * `target`) fails the parse and the payload is discarded wholesale, like
 * every other unknown key in these DTOs. Optional and additive: legacy
 * payloads without `target` parse exactly as before.
 */
const undoTargetSchema = z
  .object({
    kind: z.string().optional(),
    description: z.string().optional(),
    amountCents: z.number().optional(),
    accountLabel: z.string().optional(),
    occurredOn: z.string().optional(),
  })
  .strict();

const undoProposalSchema = z
  .object({ requestId: z.string().min(1).max(128), status: z.literal('proposed'), expiresAt: z.string().min(1), target: undoTargetSchema.optional() });

function sanitizeUndoProposal(value: AgentTurn['undoProposal']): AgentTurn['undoProposal'] {
  if (!value || typeof value !== 'object') return undefined;
  const parsed = undoProposalSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const undoDecisionSchema = z
  .object({ requestId: z.string().min(1), status: z.enum(['confirmed', 'cancelled']), result: z.unknown().optional() })
  .strict();

export type UndoDecision = z.infer<typeof undoDecisionSchema>;

/**
 * Sends the undo confirm/cancel to the authenticated Agent. The Agent owns
 * the binding check, the fixed target, and the narrow undo credential —
 * the browser only names the proposal (requestId) and the decision.
 */
export async function decideUndoProposal(
  workspaceId: string,
  requestId: string,
  decision: 'confirm' | 'cancel',
): Promise<UndoDecision> {
  const baseUrl = agentBaseUrl();
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/undo/decision`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'X-Workspace-Id': workspaceId },
      body: JSON.stringify({ decision, requestId }),
    },
  );
  return undoDecisionSchema.parse(await parseJson<unknown>(response));
}

/**
 * debt-undo-proposal-rehydration: browser-safe active undo summary. Strict
 * allowlist — the server projection is {requestId,status,expiresAt} only,
 * plus the optional display-safe `target` projection (FIX-P1-UX #172);
 * ANY other unknown key (in particular target ids / idempotency keys / raw
 * operation data) fails the parse and the WHOLE payload is discarded.
 */
const undoProposalSummarySchema = z
  .object({
    requestId: z.string().min(1).max(128),
    status: z.enum(["proposed", "executing"]),
    expiresAt: z.string().min(1),
    target: undoTargetSchema.optional(),
  })
  .strict();

export type ActiveUndoProposal = z.infer<typeof undoProposalSummarySchema>;

const undoActiveListSchema = z
  .object({
    items: z.array(undoProposalSummarySchema),
    total: z.number(),
  })
  .strict();

/**
 * Lists the workspace's live undo proposals for chat rehydration (reload /
 * remount / workspace change). Read-only GET: it never decides anything.
 * Client-side safety net over the authoritative server filter — summaries
 * already expired by the local clock are omitted (unparseable dates are
 * kept: only the server can prove expiry).
 */
export async function fetchActiveUndoProposals(workspaceId: string): Promise<ActiveUndoProposal[]> {
  const baseUrl = agentBaseUrl();
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/undo/active`,
    {
      method: "GET",
      credentials: "include",
      headers: { "X-Workspace-Id": workspaceId },
    },
  );
  if (!response.ok) {
    throw new Error("Não foi possível carregar as propostas de desfazer agora.");
  }
  const parsed = undoActiveListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Não foi possível carregar as propostas de desfazer agora.");
  }
  const now = Date.now();
  return parsed.data.items.filter((item) => {
    const time = Date.parse(item.expiresAt);
    return Number.isNaN(time) || time > now;
  });
}

export type AgentSessionRenewal = {
  ok: boolean;
  sessionId: string;
  previousSessionId: string | null;
  messageCount: number;
  summarized: boolean;
  visibility?: 'workspace' | 'private';
  privateViewsEnabled?: boolean;
};

const agentSessionRenewalSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  previousSessionId: z.string().nullable(),
  messageCount: z.number(),
  summarized: z.boolean(),
  // ADR-027 D3 (opt-in explícito por conversa, sem expor ids).
  visibility: z.enum(['workspace', 'private']).optional(),
  privateViewsEnabled: z.boolean().optional(),
});

/**
 * Starts a fresh chat session (Part B): archives the current context into
 * the session registry and clears the model context. Durable memories are
 * kept. Plain fetch (same shape as sendAgentMessage) — intentionally not
 * an apiFetch endpoint write.
 *
 * ADR-027 D3: `opts.visibility: 'private'` é o opt-in explícito por
 * conversa (gated server-side pela flag `TED_PRIVATE_VIEWS_ENABLED`;
 * 403 quando desabilitado). Ausente = coletiva (ou herança server-side).
 */
export async function renewAgentSession(
  workspaceId: string,
  opts?: { visibility?: 'workspace' | 'private' },
): Promise<AgentSessionRenewal> {
  const baseUrl = agentBaseUrl();
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/session/new`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "X-Workspace-Id": workspaceId,
      },
      body: JSON.stringify(opts?.visibility ? { visibility: opts.visibility } : {}),
    },
  );
  if (!response.ok) throw new Error("Não foi possível iniciar uma nova sessão.");
  // FIX-melhorias item 4 / REVIEW-MEDIUM-3: nova sessão = contexto
  // arquivado — a âncora de retry do escopo antigo morre aqui (mesma purga
  // do sucesso de envio), SOMENTE após o sucesso validado: JSON íntegro +
  // shape do contrato (ok:true). JSON inválido ou ok:false preservam a
  // âncora (fail-closed: a sessão antiga segue válida).
  let renewal: z.infer<typeof agentSessionRenewalSchema>;
  try {
    renewal = agentSessionRenewalSchema.parse(await response.json());
  } catch {
    throw new Error("Não foi possível iniciar uma nova sessão.");
  }
  clearPendingChatSend(workspaceId);
  return renewal;
}

/**
 * T4.2 (SPEC section 11 E2): the legacy helpers were REMOVED, not re-pointed.
 * Cancel/stream/reconnect of legacy turns, history export, history delete and
 * the access-log reader lived on the retired runtime routes, which have no
 * canonical FinanceChatAgent equivalent. Chat/history flows use
 * sendAgentMessage/fetchAgentHistory (/rpc/chat, /rpc/history) above.
 */

export async function fetchAgentHistory(workspaceId: string): Promise<AgentMessage[]> {
  const baseUrl = agentBaseUrl();
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/history`,
    {
      credentials: "include",
      headers: {
        "X-Workspace-Id": workspaceId,
      },
    },
  );
  if (!response.ok) {
    let errorMsg = "Não foi possível carregar o histórico do agente.";
    let errorCode: string | undefined;
    try {
      const fields = readAgentErrorFields(await response.json());
      if (fields.message) errorMsg = fields.message;
      if (fields.code) errorCode = fields.code;
    } catch {
      // use default message
    }
    const err = new Error(errorMsg) as Error & { status?: number; code?: string };
    err.status = response.status;
    if (errorCode) err.code = errorCode;
    else if (response.status === 401) err.code = "auth.session_required";
    else if (response.status === 403) err.code = "auth.workspace_forbidden";
    throw err;
  }
  const json = await response.json();
  return historySchema.parse(json).items;
}

/**
 * T5.3 (H-14, SPEC §22): lean active pending-operation projection relayed
 * by the Agent (which delegates to the authoritative API). Declared
 * locally with a strict allowlist — the client bundle budget forbids
 * importing the contracts zod entry. ANY unknown key (in particular
 * single-use approval material/authority material) fails the parse and the WHOLE payload is
 * discarded: the browser only ever reflects display data, never decides.
 * FIX-P1: optional canonical `presentation` (SPEC §16) derived server-side
 * from the hash-bound record. Present only when browser-safe; absent on
 * legacy payloads (card degrades to the lean shape).
 */
export type ActivePendingOperation = Readonly<{
  id: string;
  status: string;
  tool: string;
  createdAt: string;
  expiresAt: string;
  amountCents?: number;
  description?: string;
  date?: string;
  accountId?: string;
  categoryId?: string;
  failureCode?: 'in_use';
  presentation?: PendingOperationPresentation;
}>;

const activePendingOperationSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    tool: z.string().min(1),
    createdAt: z.string().min(1),
    expiresAt: z.string().min(1),
    amountCents: z.number().int().optional(),
    description: z.string().optional(),
    date: z.string().optional(),
    accountId: z.string().optional(),
    categoryId: z.string().optional(),
    failureCode: z.literal('in_use').optional(),
    presentation: pendingOperationPresentationSchema.optional(),
  })
  .strict();

const activePendingOperationsSchema = z
  .object({
    items: z.array(activePendingOperationSchema),
    total: z.number(),
  })
  .strict();

export async function fetchActivePendingOperations(workspaceId: string): Promise<ActivePendingOperation[]> {
  const baseUrl = agentBaseUrl();
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/pending-operations/active`,
    {
      method: "GET",
      credentials: "include",
      headers: { "X-Workspace-Id": workspaceId },
    },
  );
  if (!response.ok) {
    throw new Error("Não foi possível carregar as aprovações agora.");
  }
  // Strict parse: payloads carrying single-use approval material or otherwise
  // malformed payloads are discarded wholesale — surfaced as an honest error,
  const parsed = activePendingOperationsSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Não foi possível carregar as aprovações agora.");
  }
  return parsed.data.items;
}

/**
 * FIX-WS-D2-R5 — handle opaco do depósito server-side do lado Agent.
 *
 * O Agent observa o próprio SQLite/R2 e DEPOSITA a prova DIRETAMENTE na
 * API (server-to-server); o PWA recebe SÓ este UUID opaco e o devolve no
 * delete. O PWA nunca recebe, nunca persiste e nunca submete conteúdo,
 * contagens ou HMAC da prova (invariante A8) — nunca forja, nunca assina
 * e nunca interpreta nada além do id. Falhas distinguem o lado: 409
 * `agent.workspace_not_empty` (Agent tem conteúdo, com contagens) vs
 * 409 `agent.attestation_unavailable` (depósito indisponível) — o `code`
 * cruza para a UX dizer qual lado falhou, sem vazar segredo.
 */
export const emptyDepositSchema = z
  .object({
    attestationId: z.string().uuid(),
  });

export type EmptyDeposit = z.infer<typeof emptyDepositSchema>;

export async function requestAgentEmptyAttestation(
  workspaceId: string,
  inventoryVersion: string,
): Promise<EmptyDeposit> {
  const baseUrl = agentBaseUrl();
  const response = await fetchWithAgentAuth(
    workspaceId,
    `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/workspace/${encodeURIComponent(workspaceId)}/attest-empty`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "X-Workspace-Id": workspaceId,
      },
      body: JSON.stringify({ inventoryVersion }),
    },
  );
  if (!response.ok) {
    let errorMsg = "Não foi possível atestar o lado Agent.";
    let errorCode: string | undefined;
    try {
      const fields = readAgentErrorFields(await response.json());
      if (fields.message) errorMsg = fields.message;
      if (fields.code) errorCode = fields.code;
    } catch {
      // use default message
    }
    const err = new Error(errorMsg) as Error & { status?: number; code?: string };
    err.status = response.status;
    if (errorCode) err.code = errorCode;
    throw err;
  }
  const parsed = emptyDepositSchema.safeParse(await response.json());
  if (!parsed.success) {
    // Nunca inventar handle que o Agent não depositou.
    const err = new Error("Depósito do Agent inválido.") as Error & { code?: string };
    err.code = "agent.invalid_attestation_response";
    throw err;
  }
  return parsed.data;
}
