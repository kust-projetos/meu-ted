import { z } from "zod";
import type { MutationReceipt } from "@pi-finance/llm-contracts/types";
import { TED_APPROVAL_TOOLS } from "@pi-finance/llm-contracts/types";
import { fetchAgentConnectionToken, clearAgentConnectionTokenCache, trackAgentConnection, getActiveDeviceToken } from "./agent-auth";

import { getOfflinePrincipalId } from "@/lib/auth/offline-identity";

const historyItemSchema = z.object({
  id: z.string(),
  actorId: z.string().optional(),
  role: z.string(),
  content: z.string().optional(),
  text: z.string().optional(),
  createdAt: z.string().optional(),
  isOwn: z.boolean(),
  // FIX-169-170-R2 (P2-2): identidade estável do envio ecoada pelo Agent
  // (SPEC §7.7) — a reconciliação a usa como chave primária; ausente em
  // itens legados, que seguem a regra conteúdo+timestamp.
  intentionId: z.string().optional(),
  proposalOperationId: z.unknown().optional(),
  proposalTool: z.unknown().optional(),
  terminalOutcome: z.unknown().optional(),
  // ADR-033: read-only self-confirm result echoed on a history item.
  // Raw input — strict allowlist in the transform below (no attestation/hash).
  execution: z.unknown().optional(),
}).transform((item): AgentMessage => {
  const execution = sanitizeSelfConfirmExecution(item.execution);
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
    ...(typeof item.intentionId === "string" && item.intentionId ? { intentionId: item.intentionId } : {}),
    ...(proposalOperationId.success ? { proposalOperationId: proposalOperationId.data } : {}),
    ...(proposalTool ? { proposalTool } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    // Invalid/absent collapses to no terminal state — never invented data.
    ...(execution ? { execution } : {}),
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
   * ADR-033 S2: terminal, read-only result of an agent self-confirmed
   * operation (no Confirm/Cancel). Strictly sanitized at the boundary.
   */
  execution?: SelfConfirmExecution;
};

export function agentBaseUrl(): string {  // ADR-011: canonical browser transport is the same-origin proxy /api/agent.
  // V4.1 Phase 5 (SPEC §12.6): the browser default is the same-origin proxy —
  // no production hostname is an architectural dependency. An explicitly
  // configured direct URL is a dev/test-only escape hatch (ADR-011 transient
  // compat) — never a published production default.
  // Dev/test-only escape hatch: in production the override is ignored so the
  // same-origin /api/agent proxy (CSRF/session handling) is always used.
  const direct = process.env.NODE_ENV === "production"
    ? undefined
    : process.env.NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL?.replace(/\/$/, "");
  if (direct) return direct;
  // Fallback seguro ao proxy Next.js /api/agent quando a URL direta não estiver configurada.
  // Preserva token e X-Workspace-Id via forwardHeaders do proxy e evita CORS/misconfig.
  return "/api/agent";
}

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
    const targetRequired = proposalTool === 'transactions.update' || proposalTool === 'accounts.update' || proposalTool === 'accounts.deactivate' || proposalTool === 'categories.update' || proposalTool === 'categories.deactivate' || proposalTool === 'cards.statement.pay';
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

/**
 * ADR-033 S2 — browser-safe projection of the gateway's agent self-confirm
 * result. Strict allowlist: the only fields allowed to cross are the operation
 * identity, the tool, the coarse terminal status, the (display-only) outcome
 * and — for a PROVEN success only — the canonical receipt. No attestation,
 * idempotency key, proposal hash or any other authority material is accepted:
 * a single extra key drops the WHOLE value (fail closed, like every DTO here).
 *
 * `outcome.status` is echoed as an opaque string on purpose: the authoritative
 * coarse status is `execution.status`; the model-owned text never becomes a
 * success claim. `succeeded` without a canonical receipt whose `operationId`
 * is the SAME one (and whose `mutationKind` is the SAME tool) is downgraded to
 * `unverified` — never surfaced as success (ADR-033 decision 5).
 */
const selfConfirmOutcomeSchema = z
  .object({
    status: z.string().min(1),
    failureCode: z.string().min(1).optional(),
  })
  .strict();

const selfConfirmExecutionSchema = z
  .object({
    operationId: z.string().min(1),
    tool: z.string().min(1),
    status: z.enum(["succeeded", "failed", "unverified"]),
    receipt: z.unknown().optional(),
    outcome: selfConfirmOutcomeSchema,
  })
  .strict();

export type SelfConfirmExecution = Readonly<
  | {
      operationId: string;
      tool: string;
      status: "succeeded";
      receipt: PendingOperationReceipt;
      outcome: { status: string; failureCode?: string };
    }
  | {
      operationId: string;
      tool: string;
      status: "failed" | "unverified";
      receipt?: never;
      outcome: { status: string; failureCode?: string };
    }
>;

export function sanitizeSelfConfirmExecution(value: unknown): SelfConfirmExecution | undefined {
  const parsed = selfConfirmExecutionSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { operationId, tool, status, outcome } = parsed.data;
  // An unknown tool can never produce a browser-visible financial success.
  if (!APPROVAL_TOOLS.includes(tool)) {
    return { operationId, tool, status: "unverified", outcome };
  }
  if (status === "succeeded") {
    const receipt = sanitizeMutationReceipt(parsed.data.receipt);
    if (
      !receipt ||
      receipt.status !== "succeeded" ||
      receipt.operationId !== operationId ||
      receipt.mutationKind !== tool
    ) {
      // The write may already have happened: park as unverified, never success.
      return { operationId, tool, status: "unverified", outcome };
    }
    return { operationId, tool, status: "succeeded", receipt, outcome };
  }
  // failed/unverified carry no financial proof by contract. A receipt smuggled
  // into a non-success terminal is not displayed and never reconciles anything.
  if (parsed.data.receipt !== undefined) {
    return { operationId, tool, status: "unverified", outcome };
  }
  return { operationId, tool, status, outcome };
}

/** Closed approval-tool mapping; unknown tools never inherit a fallback entity type. */
function approvalEntityType(tool: string): "transaction" | "account" | "category" | "statement" | undefined {
  switch (tool) {
    case "transactions.expense.create":
    case "transactions.income.create":
    case "transactions.transfer.create":
    case "transactions.update":
    case "cards.purchase.create":
      return "transaction";
    case "accounts.create":
    case "accounts.update":
    case "accounts.deactivate":
      return "account";
    case "categories.create":
    case "categories.update":
    case "categories.deactivate":
      return "category";
    case "cards.statement.pay":
      return "statement";
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

export type AgentTurn = {
  turnId: string;
  status: string;
  attempts?: number;
  output?: string;
  memorized?: string[];
  /**
   * ADR-033: o agente confirma e executa direto; a resposta traz apenas este
   * resultado terminal e somente leitura. Na dúvida, o agente responde em
   * texto, sem execução. Nunca carrega atestação/hash.
   */
  execution?: SelfConfirmExecution;
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
  proposed: "em andamento",
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

/** pt-BR currency for the result card (cents → "R$ 850,00"). */
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
/**
 * SPEC §7.7/§7.7.1 — stable per-turn message identity (PWA-owned).
 *
 * Every outgoing chat message gets a `messageId` generated ONCE at send
 * composition. Retries of the same send MUST reuse it (pass
 * `{ messageId }` back into `sendAgentMessage`); the id is sent as the
 * Agent's `intentionId`, so a lost HTTP response can never produce a second
 * operation. Never regenerate on retry; a new message composes a new id.
 */
export type PendingChatSend = Readonly<{
  messageId: string;
  content: string;
  createdAt: string;
  /**
   * Older retry records predate the versioned text-send shape; keep them
   * non-retryable because their original payload cannot be reconstructed.
   */
  legacyAnchor?: boolean;
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
  opts?: { messageId?: string },
): PendingChatSend {
  const messageId = opts?.messageId && opts.messageId.trim() ? opts.messageId.trim() : createChatMessageId();
  return {
    messageId,
    content,
    createdAt: new Date().toISOString(),
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
/**
 * Persists the in-flight send record (messageId + content + attachment refs —
 * never secrets, never local blob URLs) so a page reload restores the same
 * id for retry. Scoped by (actor, workspace) — see #176 above.
 */
export function savePendingChatSend(workspaceId: string, send: PendingChatSend, actorId?: string | null): void {
  try {
    sessionStorage.setItem(
      pendingSendKey(workspaceId, actorId),
      JSON.stringify({
        anchorVersion: CHAT_SEND_ANCHOR_VERSION,
        messageId: send.messageId,
        content: send.content,
        createdAt: send.createdAt,
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
    };
    if (typeof parsed.messageId !== "string" || !parsed.messageId || typeof parsed.content !== "string") return null;
    const base = {
      messageId: parsed.messageId,
      content: parsed.content,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
    };
    if (
      parsed.anchorVersion !== CHAT_SEND_ANCHOR_VERSION ||
      Object.prototype.hasOwnProperty.call(parsed, "attachments")
    ) {
      return { ...base, legacyAnchor: true };
    }
    return base;
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
type HistoryItemForSupersede = Pick<AgentMessage, "isOwn" | "content" | "createdAt" | "intentionId">;

/**
 * FIX-169-170-R3 (MEDIUM): o item carrega identidade conhecida (intentionId
 * ecoado pelo Agent) que diverge da identidade da âncora. Só diverge quando
 * OS DOIS lados são conhecidos: item legado sem intentionId e âncora sem
 * identidade seguem o fallback legado (conteúdo+timestamp) inalterado.
 */
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
  anchor: Pick<PendingChatSend, "content" | "createdAt"> & Partial<Pick<PendingChatSend, "messageId">> & { intentionId?: string },
  history: ReadonlyArray<HistoryItemForSupersede>,
): boolean {
  const identity = anchor.intentionId || anchor.messageId;
  if (identity && history.some((item) => item.isOwn && item.intentionId === identity)) return true;
  const anchorTime = Date.parse(anchor.createdAt);
  return history.some((item) => {
    if (!item.isOwn || item.content !== anchor.content) return false;
    if (identity && item.intentionId && item.intentionId !== identity) return false;
    if (Number.isNaN(anchorTime)) return true;
    const itemTime = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : NaN;
    return Number.isNaN(itemTime) || itemTime >= anchorTime;
  });
}

export function resolveRetrySend(input: { messageId: string; failed: { content: string }; stored?: PendingChatSend }):
  | { ok: true; send: PendingChatSend; draft?: PendingChatSend }
  | { ok: false; reason: "no_draft" } {
  if (input.stored) return { ok: true, send: input.stored, draft: input.stored };
  if (!input.failed.content.trim()) return { ok: false, reason: "no_draft" };
  const send = composeChatSend(input.failed.content, { messageId: input.messageId });
  return { ok: true, send, draft: send };
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

async function agentAuthHeaders(workspaceId: string, forceFresh = false, url?: string): Promise<Record<string, string>> {
  // C-01: connection tokens are single-use — every call mints fresh.
  const token = await fetchAgentConnectionToken(workspaceId, forceFresh);
  const headers: Record<string, string> = { "x-agent-connection-token": token };
  // P2 seam: AFTER the mint completes (which also finishes the device
  // self-heal — `ensureDeviceToken` persists before the mint resolves), read
  // the active device token for same-origin proxy requests ONLY, and never
  // for a server-confirmed A0 conversation (no new credentials upstream on
  // A0 — the proxy allowlist strips this header there anyway). A relative
  // URL targets the same-origin `/api/agent` proxy; an absolute (direct/dev
  // `NEXT_PUBLIC_...`) URL must never receive it. Unknown views still send it:
  // the first B contact needs it before any P2 response confirms the runtime.
  if (typeof url === "string" && url.startsWith("/")) {
    try {
      const device = getActiveDeviceToken();
      if (device) headers["x-device-token"] = device;
    } catch {
      // Unreadable store/view: omit the header (gateway fails closed server-side).
    }
  }
  return headers;
}

/**
 * P2 — captures the server-confirmed runtime from one proxied response into
 * the workspace view. Runs on ok AND error responses (a B rejection still
 * proves the conversation is B-routed); responses without the header (legacy
 * A0 path) leave the view untouched.
 *
 * Authority rule (same seam as the device token): ONLY a relative
 * same-origin `/api/agent` URL can confirm a runtime — the proxy is the
 * authority. A foreign direct/dev host must never confirm one: its
 * (non-secret) header could falsely present an A0 stream as
 * server-cancelable. Callers pass the exact request URL they fetched.
 */
function captureTedRuntime(workspaceId: string, url: string, response: Response): void {
  if (typeof url !== "string" || !url.startsWith("/")) return;
  try {
    
  } catch {
    // View bookkeeping never breaks the turn.
  }
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
    const authHeaders = await agentAuthHeaders(workspaceId, true, url);
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
export async function sendAgentMessage(
  workspaceId: string,
  content: string,
  opts?: { messageId?: string; signal?: AbortSignal },
): Promise<AgentTurn> {
  const baseUrl = agentBaseUrl();
  // SPEC §7.7: the send identity is fixed ONCE here; retries pass the same
  // messageId back and the pending record keeps it across reloads.
  const messageId = opts?.messageId && opts.messageId.trim() ? opts.messageId.trim() : createChatMessageId();
  // Mesma data/hora sobrevive ao turno para ordenação do retry.
  const anchorCreatedAt = new Date().toISOString();
  savePendingChatSend(workspaceId, {
    messageId,
    content,
    createdAt: anchorCreatedAt,
  });
  const requestUrl = `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/chat`;
  const response = await fetchWithAgentAuth(
    workspaceId,
    requestUrl,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "X-Workspace-Id": workspaceId,
      },
      body: JSON.stringify({ text: content, intentionId: messageId }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
  );
  // P2 — the turn response confirms the conversation runtime (ok or error).
  captureTedRuntime(workspaceId, requestUrl, response);
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
  const data = await response.json() as { turnId?: string; intentionId?: string; status?: string; output?: string; memorized?: string[]; undoProposal?: unknown; execution?: unknown };
  const undoProposal = sanitizeUndoProposal(data.undoProposal as AgentTurn["undoProposal"]);
  const execution = sanitizeSelfConfirmExecution(data.execution);
  // The turn landed: the in-flight record is no longer needed. On failure
  // (including an unlinked succeeded receipt) it stays, so retry reuses the
  // same idempotent messageId.
  const hasRealResult = Boolean(data.output?.trim() || undoProposal || execution);
  if (hasRealResult) clearPendingChatSend(workspaceId);
  return {
    turnId: data.turnId ?? data.intentionId ?? `turn-${Date.now()}`,
    status: data.status ?? "completed",
    output: data.output,
    ...(Array.isArray(data.memorized) ? { memorized: data.memorized.filter((m): m is string => typeof m === "string") } : {}),
    ...(undoProposal ? { undoProposal } : {}),
    ...(execution ? { execution } : {}),
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
  const requestUrl = `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/session/new`;
  const response = await fetchWithAgentAuth(
    workspaceId,
    requestUrl,
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
  // P2 — a renewal starts a fresh conversation lifecycle: drop the previous
  // runtime belief, then capture what THIS renewal confirms (B/A0-P2 header,
  // or unknown on the legacy path). No body/DTO/session id crosses.
  
  captureTedRuntime(workspaceId, requestUrl, response);
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
  const requestUrl = `${baseUrl}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/history`;
  const response = await fetchWithAgentAuth(
    workspaceId,
    requestUrl,
    {
      credentials: "include",
      headers: {
        "X-Workspace-Id": workspaceId,
      },
    },
  );
  // P2 — history reveals the runtime even when it errors (first B history
  // load with no cookie yet answers 400 through the B branch).
  captureTedRuntime(workspaceId, requestUrl, response);
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
