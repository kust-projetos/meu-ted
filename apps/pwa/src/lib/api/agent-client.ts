import { z } from "zod";
import type { MutationReceipt } from "@pi-finance/llm-contracts/types";
import { fetchAgentConnectionToken, clearAgentConnectionTokenCache, trackAgentConnection } from "./agent-auth";

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
  // §25.4 (browser reload during proposed/executing): the server may attach
  // the authoritative pending operation so the PWA rehydrates the approval
  // card from SERVER state. Raw input — sanitized in the transform below.
  pendingOperation: z.unknown().optional(),
}).transform((item): AgentMessage => {
  const pendingOperation = sanitizePendingOperation(
    item.pendingOperation as AgentTurn["pendingOperation"],
  );
  return {
    id: item.id,
    actorId: item.actorId ?? (item.role === "assistant" ? "ted" : "unknown"),
    role: item.role,
    content: item.content ?? item.text ?? "",
    createdAt: item.createdAt,
    isOwn: item.isOwn,
    attachments: item.attachments,
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
    date: z.string().optional(),
    account: pendingOperationPresentationLabelSchema.optional(),
    category: pendingOperationPresentationLabelSchema.optional(),
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
   */
  undoProposal?: Readonly<{
    requestId: string;
    status: 'proposed';
    expiresAt: string;
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
  // the canonical receipt linked to both the pending operation and tx.
  if (raw.status === "succeeded") {
    const candidateId = typeof raw.id === "string" ? raw.id : "";
    const candidateReceipt = sanitizeMutationReceipt(raw.receipt);
    const entityId = typeof candidateReceipt?.entity?.id === "string" ? candidateReceipt.entity.id.trim() : "";
    if (
      !candidateId.trim() ||
      !candidateReceipt ||
      candidateReceipt.operationId !== candidateId ||
      candidateReceipt.entity?.type !== "transaction" ||
      !entityId
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
  const safeFields = {
    id,
    operation,
    ...(summary !== undefined ? { summary } : {}),
    ...(parsedPresentation && parsedPresentation.success ? { presentation: parsedPresentation.data } : {}),
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
export type PendingChatSend = Readonly<{
  messageId: string;
  content: string;
  createdAt: string;
  attachments?: ReadonlyArray<Readonly<{ type: string; url: string; name: string }>>;
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
    attachments?: Array<{ type: string; url: string; name: string }>;
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

const pendingSendKey = (workspaceId: string): string => `ted.pending-send.${workspaceId}`;

/**
 * Persists the in-flight send record (messageId + content only — never
 * secrets) so a page reload restores the same id for retry.
 */
export function savePendingChatSend(workspaceId: string, send: PendingChatSend): void {
  try {
    sessionStorage.setItem(
      pendingSendKey(workspaceId),
      JSON.stringify({ messageId: send.messageId, content: send.content, createdAt: send.createdAt }),
    );
  } catch {
    // Storage unavailable (private mode): the in-memory retry path still reuses the id.
  }
}

export function loadPendingChatSend(workspaceId: string): PendingChatSend | null {
  try {
    const raw = sessionStorage.getItem(pendingSendKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { messageId?: unknown; content?: unknown; createdAt?: unknown };
    if (typeof parsed.messageId !== "string" || !parsed.messageId || typeof parsed.content !== "string") return null;
    return {
      messageId: parsed.messageId,
      content: parsed.content,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function clearPendingChatSend(workspaceId: string): void {
  try {
    sessionStorage.removeItem(pendingSendKey(workspaceId));
  } catch {
    // Best effort.
  }
}

const pendingDecisionSchema = z.object({
  operationId: z.string(),
  status: z.enum(["proposed", "succeeded", "failed", "cancelled", "expired"]),
  retryable: z.boolean().optional(),
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
      /** A success is only actionable when it carries its canonical receipt. */
      receipt: PendingOperationReceipt;
    }
  | {
      operationId: string;
      status: Exclude<PendingOperationDecisionStatus, "succeeded">;
      retryable?: boolean;
      receipt?: never;
    };

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorMsg = "Operação do agente falhou.";
    let errorCode: string | undefined;
    try {
      const body = await response.json() as { message?: string; code?: string };
      if (body?.message) errorMsg = body.message;
      if (typeof body?.code === "string" && body.code) errorCode = body.code;
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
    return ((await response.clone().json()) as { code?: string })?.code;
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

export async function sendAgentMessage(
  workspaceId: string,
  content: string,
  opts?: { attachments?: Array<{ type: string; url: string; name: string }>; messageId?: string },
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
      const errBody = await response.json() as { message?: string; code?: string };
      if (errBody?.message) errorMsg = errBody.message;
      if (errBody?.code) errorCode = errBody.code;
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
  clearPendingChatSend(workspaceId);
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
 */
export async function decidePendingOperation(
  workspaceId: string,
  operationId: string,
  decision: "confirm" | "cancel" | "retry",
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
  const parsed = pendingDecisionSchema.parse(await parseJson<unknown>(response));
  const receipt = sanitizeMutationReceipt(parsed.receipt);
  const safe = {
    operationId: parsed.operationId,
    status: parsed.status,
    ...(parsed.retryable !== undefined ? { retryable: parsed.retryable } : {}),
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
  // receipt (receipt.operationId === pending ID, entity {type:'transaction',
  // id: transactionID}). A succeeded decision without that receipt cannot be
  // reconciled, so it must reject — never resolve as success. Other statuses
  // (cancelled/failed/proposed/expired) carry no receipt by contract.
  if (safe.status === "succeeded") {
    const entityId = typeof receipt?.entity?.id === "string" ? receipt.entity.id.trim() : "";
    if (
      !receipt ||
      receipt.operationId !== operationId ||
      receipt.entity?.type !== "transaction" ||
      !entityId
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
  };
}

/**
 * debt-undo-confirmation-protocol: browser-safe undo proposal DTO. Strict
 * allowlist — anything else collapses to `undefined` (no card).
 */
const undoProposalSchema = z
  .object({ requestId: z.string().min(1).max(128), status: z.literal('proposed'), expiresAt: z.string().min(1) });

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
 * allowlist — the server projection is {requestId,status,expiresAt} only;
 * ANY unknown key (in particular target ids / idempotency keys / raw
 * operation data) fails the parse and the WHOLE payload is discarded.
 */
const undoProposalSummarySchema = z
  .object({
    requestId: z.string().min(1).max(128),
    status: z.enum(["proposed", "executing"]),
    expiresAt: z.string().min(1),
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
};

/**
 * Starts a fresh chat session (Part B): archives the current context into
 * the session registry and clears the model context. Durable memories are
 * kept. Plain fetch (same shape as sendAgentMessage) — intentionally not
 * an apiFetch endpoint write.
 */
export async function renewAgentSession(workspaceId: string): Promise<AgentSessionRenewal> {
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
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) throw new Error("Não foi possível iniciar uma nova sessão.");
  return (await response.json()) as AgentSessionRenewal;
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
      const errBody = await response.json() as { message?: string; code?: string };
      if (errBody?.message) errorMsg = errBody.message;
      if (errBody?.code) errorCode = errBody.code;
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
