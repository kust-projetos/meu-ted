"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import {
  fetchAgentHistory,
  fetchActivePendingOperations,
  fetchActiveUndoProposals,
  sendAgentMessage,
  renewAgentSession,
  composeChatSend,
  PENDING_OPERATION_STATUS,
  type ActivePendingOperation,
  type ActiveUndoProposal,
  type AgentMessage,
  type PendingChatSend,
} from "@/lib/api/agent-client";
import { TedMessage, type TedDeliveryState } from "./TedMessage";
import { TedApprovalCard, type TedPendingOperation } from "./TedApprovalCard";
import { TedUndoCard, type TedUndoProposal } from "./TedUndoCard";
import { useRecordingState } from "./use-recording-state";
import { getChatAttachmentCapabilities } from "@/lib/capabilities";
import { useOptionalAppState } from "@/lib/state/app-state-context";
import type { MutationReceipt } from "@pi-finance/llm-contracts/types";
import type { PendingOperationDecision, UndoDecision } from "@/lib/api/agent-client";
import { notifyPendingOperationsChanged } from "@/lib/state/use-pending-operations";
import { Sparkles, Send, Mic, MicOff, Image as ImageIcon, FileText, Paperclip, Trash2, RefreshCw } from "lucide-react";

const HISTORY_LOAD_ERROR = "Não foi possível carregar o histórico. Tente novamente.";
const ACTIVE_LOAD_ERROR = "Não foi possível carregar as aprovações agora.";
const MESSAGE_SEND_ERROR = "Não foi possível enviar a mensagem. Tente novamente.";
/**
 * FIX-AGENT-QUOTA-MESSAGE: the Agent relays the usage-gate denial verbatim as
 * 429 `agent.quota_exceeded` (the daily token budget, reset on the 24h window)
 * — not a transient failure. Telling the user to "try again" is misleading
 * because retrying before the window resets cannot succeed.
 */
const MESSAGE_SEND_QUOTA_ERROR = "Cota diária do assistente atingida. Tente novamente amanhã.";
/**
 * FINDING 4: a sliding-window rate denial (also 429) clears in seconds, so
 * the daily "try again tomorrow" copy would be wrong guidance. Same HTTP
 * status, different code, different wait.
 *
 * The code is `agent.usage_rate_limited` (the usage ledger gate), NOT
 * `agent.rate_limited` — that one is the provider/upstream 429 relayed by the
 * Agent and means "the model throttled us", not "you sent too much".
 */
const MESSAGE_SEND_RATE_LIMIT_ERROR = "Muitas mensagens seguidas. Aguarde alguns instantes e tente de novo.";
/**
 * FINDING 4 (review, round 3): the per-request input cap is not a budget — the
 * same message can never be accepted later, so the only useful guidance is to
 * shorten it. No wait, no retry.
 */
const MESSAGE_SEND_INPUT_CAP_ERROR =
  "Sua mensagem está longa demais para o assistente. Tente encurtar e enviar de novo.";

/** Ledger denials get their own copy; every other failure is generic. */
const sendErrorMessage = (err: unknown): string => {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === "agent.usage_rate_limited") return MESSAGE_SEND_RATE_LIMIT_ERROR;
  if (code === "agent.usage_input_cap") return MESSAGE_SEND_INPUT_CAP_ERROR;
  return code === "agent.quota_exceeded" ? MESSAGE_SEND_QUOTA_ERROR : MESSAGE_SEND_ERROR;
};

/**
 * FIX-P1 (presentation rehydration): live cards come EXCLUSIVELY from the
 * authoritative active list (Agent relay of GET /pending-operations/v2/active
 * with the server-derived canonical presentation) — never from history.
 * Only actionable/recovery states keep a live card; terminal states stay in
 * the message log. Unknown statuses are dropped (fail closed, never success).
 */
const LIVE_CARD_STATUSES: ReadonlySet<string> = new Set([
  "proposed",
  "confirmed",
  "executing",
  "failed",
]);

function toLiveCard(item: ActivePendingOperation): TedPendingOperation | null {
  if (!LIVE_CARD_STATUSES.has(item.status)) return null;
  if (!(PENDING_OPERATION_STATUS as readonly string[]).includes(item.status)) return null;
  return {
    id: item.id,
    status: item.status as TedPendingOperation["status"],
    operation: item.tool,
    ...(typeof item.description === "string" && item.description ? { summary: item.description } : {}),
    ...(item.presentation ? { presentation: item.presentation } : {}),
  };
}

/** SPEC §19.4: every connection status is user-facing pt-BR, never raw enum names. */
type TedChatStatus = "connecting" | "ready" | "streaming" | "error";

const CONNECTION_STATUS_LABELS: Readonly<Record<TedChatStatus, string>> = {
  connecting: "conectando…",
  ready: "online",
  streaming: "escrevendo…",
  error: "indisponível",
};

/** Local message with the §19.1 optimistic delivery lifecycle. */
type ChatMessage = AgentMessage & { delivery?: TedDeliveryState };

interface TedChatProps {
  /**
   * T5.3 (SPEC §22): deep-link target — the authoritative pending-operation
   * id to highlight/focus once the chat opens. Display routing only; the
   * Decision Service still owns every decision. `null`/absent = no focus.
   * Routed via `/ted?operationId=` (page-bound chat, no dialog semantics).
   */
  focusedOperationId?: string | null;
}

export type TedAttachment = { type: "image" | "pdf" | "audio"; url: string; name: string; file?: File };

export function TedChat({ focusedOperationId = null }: TedChatProps) {
  const ws = useWorkspaceSafe();
  const activeWorkspace = ws?.activeWorkspace ?? null;
  const members = ws?.members ?? [];
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingOps, setPendingOps] = useState<TedPendingOperation[]>([]);
  // debt-undo-confirmation-protocol + debt-undo-proposal-rehydration: live
  // undo proposals come EXCLUSIVELY from structured server state — the turn
  // response's `undoProposal` field (immediate) plus the authenticated
  // active-list RPC below (reload/remount/workspace change). Model text is
  // never parsed or acted on, and rehydration never decides. Entries are
  // deduped by requestId; expired summaries are dropped.
  const [undoProposals, setUndoProposals] = useState<TedUndoProposal[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<TedChatStatus>("ready");
  const [attachments, setAttachments] = useState<TedAttachment[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const focusedCardRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const prevWorkspaceIdRef = useRef<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Microphone lifecycle (SPEC §17, H-08): recording state only exists after
  // getUserMedia + MediaRecorder + start; single idempotent cleanup.
  // (start/stop expostos de forma estável; cleanupMedia é useCallback estável.)
  const recordingCtl = useRecordingState({
    onAudioBlob: (blob) => {
      const url = URL.createObjectURL(blob);
      setAttachments((prev) => [...prev, { type: "audio", url, name: `audio-${Date.now()}.webm` }]);
    },
    onError: (message) => setError(message),
  });
  const { state: recordingState, cleanupMedia: cleanupRecordingMedia } = recordingCtl;
  const isRecording = recordingState === "recording";
  const isRequestingMic = recordingState === "requesting";

  // SPEC §18 (H-09): sem pipeline de ingestão real, anexos de arquivo ficam
  // indisponíveis — botões e file inputs nem são renderizados (default: tudo
  // false; `NEXT_PUBLIC_TED_ATTACHMENT_INGESTION=1` libera quando o pipeline
  // existir). Leitura viva por render para respeitar o env em testes.
  // V4 T1.1 (INV-08): o botão do microfone (captura de voz T4.1/SPEC §17)
  // segue o mesmo padrão atrás de `caps.microphone`
  // (`NEXT_PUBLIC_TED_MICROPHONE=1|true`) — a mesma flag que a
  // Permissions-Policy do middleware lê.
  const caps = getChatAttachmentCapabilities();

  // Registro de object URLs (INV-08): espelho dos anexos para revogar em
  // todos os gatilhos de teardown, inclusive unmount com rascunho pendente.
  const attachmentsRef = useRef<TedAttachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const revokeAttachmentUrls = useCallback((list: ReadonlyArray<{ url: string }>) => {
    for (const att of list) {
      try {
        URL.revokeObjectURL(att.url);
      } catch {
        /* já revogada ou URL inválida — revoke é idempotente por natureza */
      }
    }
  }, []);

  const clearAttachments = useCallback(() => {
    revokeAttachmentUrls(attachmentsRef.current);
    attachmentsRef.current = [];
    setAttachments([]);
  }, [revokeAttachmentUrls]);

  // SPEC §19.3: send drafts keyed by the stable messageId (SPEC §7.7) —
  // retry reuses the SAME id, text and LIVE object URLs. Success consumes
  // the draft; teardown paths that drop failed messages revoke their URLs
  // first (INV-08) — failed messages are never silently discarded.
  const draftsRef = useRef<Map<string, PendingChatSend>>(new Map());
  const discardDrafts = useCallback(() => {
    for (const draft of draftsRef.current.values()) {
      revokeAttachmentUrls(draft.attachments ?? []);
    }
    draftsRef.current.clear();
  }, [revokeAttachmentUrls]);

  // Unmount: revoga URLs restantes (cobre logout/expiração com rascunho
  // pendente — esses caminhos desmontam a página do chat).
  useEffect(() => {
    return () => {
      revokeAttachmentUrls(attachmentsRef.current);
      attachmentsRef.current = [];
      discardDrafts();
    };
  }, [revokeAttachmentUrls, discardDrafts]);

  const flashNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);
  // Page-bound chat (`/ted`): no dialog shell, no scroll lock, no focus
  // trap, no Escape-to-close. Recording flows keep their own keyboard
  // behavior; navigation away unmounts the page.

  // debt-undo-rehydration-terminal-fix: the authoritative active list is
  // the SOURCE OF TRUTH. A successful refresh REPLACES local undo cards —
  // terminal (confirmed/cancelled), expired, or otherwise omitted proposals
  // must never reappear from old local state on reload/remount. The ONLY
  // exception is the in-flight turn path below (executeSend applies the
  // just-returned `undoProposal` AFTER loadHistory, so a card minted by the
  // current turn is never erased by the refresh that preceded it).
  const applyActiveUndoProposals = useCallback((items: ActiveUndoProposal[]) => {
    const now = Date.now();
    const next: TedUndoProposal[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      // Safety net over the authoritative server filter: never render an
      // already-expired card (unparseable dates are kept — only the server
      // can prove expiry).
      const time = Date.parse(item.expiresAt);
      if (!Number.isNaN(time) && time <= now) continue;
      if (seen.has(item.requestId)) continue;
      seen.add(item.requestId);
      next.push({
        requestId: item.requestId,
        status: item.status,
        expiresAt: item.expiresAt,
      });
    }
    setUndoProposals(next);
  }, []);

  const loadHistory = useCallback(async (preserveError = false) => {
    if (!activeWorkspace) return;
    let history: AgentMessage[];
    try {
      setStatus("connecting");
      history = await fetchAgentHistory(activeWorkspace.id);
    } catch {
      // SPEC §25.4: a failed reload keeps last-known server state and
      // signals staleness — never invents a card, never wipes history.
      setError(HISTORY_LOAD_ERROR);
      setStatus("error");
      return;
    }
    setMessages((prev) => [
      ...history,
      // SPEC §19.1/§19.3: local optimistic sends not yet confirmed by the
      // server survive authoritative reloads — failed messages are never
      // silently discarded and in-flight ones keep their sending state.
      ...prev.filter((m) => m.delivery === "sending" || m.delivery === "failed"),
    ]);
    setHistoryLoaded(true);
    if (!preserveError) setError(null);
    // FIX-P1: live cards come EXCLUSIVELY from the authoritative active
    // list (server-derived canonical presentation) — history NEVER mints a
    // card, even when a legacy turn still carries a pendingOperation.
    try {
      const active = await fetchActivePendingOperations(activeWorkspace.id);
      const cards = new Map<string, TedPendingOperation>();
      for (const item of active) {
        const card = toLiveCard(item);
        if (card && !cards.has(card.id)) cards.set(card.id, card);
      }
      setPendingOps([...cards.values()]);
      if (!preserveError) setError(null);
      setStatus("ready");
    } catch {
      // Fail closed on first load (no cards invented) and honest afterwards:
      // last-known cards stay (untouched), staleness is signaled, history is
      // untouched.
      setError(ACTIVE_LOAD_ERROR);
      setStatus("ready");
    }
    // debt-undo-proposal-rehydration: reload/remount rehydrates the live undo
    // cards from the authenticated active-list RPC (bound summaries only).
    // Read-only: failures keep last-known cards, never invent, never decide.
    try {
      const activeUndo = await fetchActiveUndoProposals(activeWorkspace.id);
      applyActiveUndoProposals(activeUndo);
    } catch {
      // Last-known undo cards stay (untouched); staleness is already
      // signaled by the history/active error paths above when they fail.
    }
  }, [activeWorkspace, applyActiveUndoProposals]);

  // Post-approval reconciliation (SPEC §15.4, T3.3): chat history AND
  // financial UI refresh. The REAL execution receipt (API-emitted, relayed
  // by the Agent through agent-client) drives the reconciler whenever the
  // decision carries one; the operation → mutationKind mapping stays as a
  // documented fallback for legacy turns without a receipt. Safe outside
  // AppStateProvider (launcher tests) via the optional hook — null means
  // "no financial refresh", never an invented reconciliation.
  const optionalAppState = useOptionalAppState();
  const optionalReconcile = optionalAppState?.reconcileMutation;
  const reconcileFinancialUi: ((input: { receipt?: MutationReceipt | null; mutationKind?: string }) => Promise<unknown>) | null =
    optionalReconcile !== undefined && optionalReconcile !== null
      ? (input: { receipt?: MutationReceipt | null; mutationKind?: string }) => optionalReconcile(input)
      : null;

  const handleApprovalResolved = async (
    decision?: PendingOperationDecision,
  ): Promise<void> => {
    // T5.3 (SPEC §22): an operation was resolved (confirm/cancel/retry) —
    // external reflections of the authoritative listing (Home badge,
    // Aprovações page) refetch via the invalidation event.
    notifyPendingOperationsChanged();
    if (reconcileFinancialUi && decision?.status === "succeeded" && decision.receipt) {
      try {
        // Only an authoritative successful decision with its canonical
        // receipt may refresh financial domains. Cancelled/failed decisions
        // still invalidate the approval list and reload chat history below,
        // but must never trigger a mutation-kind fallback reconciliation.
        await reconcileFinancialUi({ receipt: decision.receipt });
      } catch {
        // Reconciliation failure surfaces as stale in app-state;
        // the chat history must still reload below.
      }
    }
    await loadHistory();
  };

  // debt-undo-confirmation-protocol: a confirmed undo reversed a mutation,
  // so external reflections refetch and the authoritative history reloads.
  // A cancel changes nothing — only the external badge state is refreshed.
  const handleUndoResolved = async (decision: UndoDecision): Promise<void> => {
    notifyPendingOperationsChanged();
    if (decision.status === "confirmed") {
      await loadHistory();
    }
  };
  // Isolamento por workspace: limpar histórico imediatamente ao trocar de workspace
  // (SPEC §17: troca de workspace também encerra o microfone via cleanup único)
  useEffect(() => {
    const newId = activeWorkspace?.id ?? null;
    if (prevWorkspaceIdRef.current !== null && prevWorkspaceIdRef.current !== newId) {
      cleanupRecordingMedia();
      clearAttachments();
      // §19.3 teardown: workspace isolation drops local failed messages,
      // so their draft object URLs are revoked here (never leaked).
      discardDrafts();
      setMessages([]);
      setPendingOps([]);
      setUndoProposals([]);
      setHistoryLoaded(false);
      setError(null);
      setStatus("ready");
    }
    prevWorkspaceIdRef.current = newId;
  }, [activeWorkspace?.id, cleanupRecordingMedia, clearAttachments, discardDrafts]);

  useEffect(() => {
    if (activeWorkspace) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadHistory();
      // T5.3 (SPEC §22): chat mount refreshes the external pending
      // reflections so indicators are never stale after in-chat decisions.
      notifyPendingOperationsChanged();
    }
  }, [activeWorkspace, loadHistory]);

  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === "function") {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, pendingOps, undoProposals]);

  // T5.3 deep-link: the launcher routes one authoritative operation id here.
  // Only AUTHORITATIVE cards (history rehydration + turn responses) can match
  // — never an invented card. An unknown id renders the honest fallback below.
  const focusedOperation = focusedOperationId
    ? pendingOps.find((op) => op.id === focusedOperationId)
    : undefined;
  const showFocusedMissing =
    focusedOperationId !== null && focusedOperationId !== undefined && historyLoaded && !focusedOperation;

  useEffect(() => {
    if (!focusedOperation) return;
    const target = focusedCardRef.current;
    if (!target) return;
    try {
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "auto", block: "center" });
      }
    } catch {
      /* scroll is best-effort — focus below is the accessible contract */
    }
    target.focus({ preventScroll: true });
  }, [focusedOperation]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!caps.image) return;
    const files = e.target.files;
    if (!files) return;
    const newAttachments: TedAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const url = URL.createObjectURL(file);
      newAttachments.push({ type: "image", url, name: file.name, file });
    }
    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
    // reset input to allow re-selecting same file
    e.target.value = "";
  };

  const handlePdfSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!caps.pdf) return;
    const files = e.target.files;
    if (!files) return;
    const newAttachments: TedAttachment[] = [];
    for (const file of Array.from(files)) {
      if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) continue;
      const url = URL.createObjectURL(file);
      newAttachments.push({ type: "pdf", url, name: file.name, file });
    }
    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
    e.target.value = "";
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => {
      const toRemove = prev[index];
      if (toRemove) {
        try {
          URL.revokeObjectURL(toRemove.url);
        } catch {
          /* já revogada — ignore */
        }
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  // SPEC §17: estado "recording" só existe após getUserMedia + MediaRecorder + start.
  // "requesting" é cancelável; "processing" aguarda o onstop gerar o anexo.
  const handleToggleRecording = () => {
    if (isRecording || recordingState === "processing") {
      recordingCtl.stop();
      return;
    }
    if (isRequestingMic) {
      cleanupRecordingMedia();
      return;
    }
    setError(null);
    void recordingCtl.start();
  };

  // SPEC §19.1: the actual send lifecycle shared by first sends and §19.3
  // retries. Success marks the optimistic bubble as sent and lets the
  // authoritative history own the log; failure keeps the bubble visible as
  // failed (never silently discarded) with the draft intact for retry.
  const executeSend = async (send: PendingChatSend): Promise<void> => {
    if (!activeWorkspace) return;
    setLoading(true);
    setError(null);
    setStatus("streaming");
    try {
      const turn = await sendAgentMessage(
        activeWorkspace.id,
        send.content,
        {
          ...(send.attachments ? { attachments: [...send.attachments] } : {}),
          // SPEC §7.7: retries pass the SAME messageId back — a lost HTTP
          // response can never produce a second proposal.
          messageId: send.messageId,
        },
      );
      if (turn.memorized && turn.memorized.length > 0) {
        flashNotice(`TED memorizou: ${turn.memorized.slice(0, 2).join(" · ")}`);
      }
      const returnedPendingOperation = turn.pendingOperation;
      const returnedUndoProposal = turn.undoProposal;
      // T3.3 (§15.4): a natural-language confirmation turn that EXECUTED in
      // the same round-trip carries the real execution receipt — reconcile
      // from it immediately (same single reconciler as the button path).
      const executedTurn = turn.pendingOperation?.status === "succeeded" ? turn.pendingOperation : undefined;
      if (executedTurn) {
        // T5.3 (SPEC §22): a turn executed an operation to a terminal
        // (succeeded) state — invalidate the external pending reflections.
        notifyPendingOperationsChanged();
      }
      if (executedTurn?.receipt && reconcileFinancialUi) {
        try {
          await reconcileFinancialUi({ receipt: executedTurn.receipt });
        } catch {
          // Reconciliation failure surfaces as stale in app-state.
        }
      }
      setMessages((prev) => prev.map((m) => (m.id === send.messageId ? { ...m, delivery: "sent" as const } : m)));
      await loadHistory();
      // The Agent turn is itself authoritative for its user-facing response.
      // History can briefly lag (or omit an autoexecuted result), so retain
      // the returned text unless the refresh already contains that response.
      if (turn.output?.trim()) {
        setMessages((previous) => {
          if (previous.some((message) => !message.isOwn && message.content === turn.output)) return previous;
          return [...previous, {
            id: turn.turnId,
            actorId: "ted",
            role: "assistant",
            content: turn.output!,
            createdAt: new Date().toISOString(),
            isOwn: false,
          }];
        });
      }
      // The turn response is authoritative too. Apply it AFTER the history
      // reload so an eventually consistent history read cannot erase the card
      // just returned by the Agent.
      if (returnedPendingOperation && returnedPendingOperation.status !== "succeeded") {
        setPendingOps((previous) => [
          returnedPendingOperation,
          ...previous.filter((operation) => operation.id !== returnedPendingOperation.id),
        ]);
      }
      // debt-undo-confirmation-protocol: the structured turn field is the
      // ONLY source of the undo card — output text never mints one.
      if (returnedUndoProposal) {
        setUndoProposals((previous) => [
          {
            requestId: returnedUndoProposal.requestId,
            status: "proposed",
            expiresAt: returnedUndoProposal.expiresAt,
          },
          ...previous.filter((proposal) => proposal.requestId !== returnedUndoProposal.requestId),
        ]);
      }
      // §19.3: success consumed the draft — the authoritative history
      // replaced the bubble, so the local blob URLs can be revoked now.
      draftsRef.current.delete(send.messageId);
      revokeAttachmentUrls(send.attachments ?? []);
    } catch (err) {
      setMessages((prev) => prev.map((m) => (m.id === send.messageId ? { ...m, delivery: "failed" as const } : m)));
      setError(sendErrorMessage(err));
      setStatus("error");
      // No history reload on failure: it would wipe the failed bubble.
      // The draft (messageId, content, live URLs) stays for retry.
    } finally {
      setLoading(false);
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const hasText = input.trim().length > 0;
    const hasAttachments = attachments.length > 0;
    if ((!hasText && !hasAttachments) || !activeWorkspace || loading) return;

    const userText = input.trim() || (hasAttachments ? attachments.map((a) => `[${a.type}: ${a.name}]`).join(" ") : "");
    // §19.1: EVERY message renders immediately (optimistic), text included —
    // not only messages carrying attachments.
    const localAttachments = attachments.map((a) => ({ type: a.type, url: a.url, name: a.name }));
    const textWithAttachments = hasAttachments
      ? `${userText} ${localAttachments.map((a) => `[${a.type}: ${a.name}]`).join(" ")}`.trim()
      : userText;
    // SPEC §7.7: the send identity is minted ONCE at composition; retries
    // reuse it via the draft record below.
    const send = composeChatSend(textWithAttachments, localAttachments.length > 0 ? { attachments: localAttachments } : undefined);
    draftsRef.current.set(send.messageId, send);

    const optimistic: ChatMessage = {
      id: send.messageId,
      actorId: "local",
      role: "user",
      content: userText,
      createdAt: new Date().toISOString(),
      isOwn: true,
      delivery: "sending",
      ...(localAttachments.length > 0 ? { attachments: localAttachments } : {}),
    };
    setMessages((prev) => [...prev, optimistic]);

    setInput("");
    // The optimistic message now owns the object URLs — do NOT revoke here
    // (§19.3 keeps them alive while the draft can still be retried).
    setAttachments([]);
    void executeSend(send);
  };

  // SPEC §19.3: retry resends the preserved draft — same text, same live
  // attachments, SAME stable messageId. A retry that fails again returns
  // the message to `failed` keeping the draft; success consumes it.
  const handleRetry = (messageId: string) => {
    if (!activeWorkspace || loading) return;
    const failed = messages.find((m) => m.id === messageId && m.delivery === "failed");
    if (!failed) return;
    const stored = draftsRef.current.get(messageId);
    const send: PendingChatSend =
      stored ??
      composeChatSend(failed.content, {
        messageId,
        ...(Array.isArray(failed.attachments) && failed.attachments.length > 0
          ? { attachments: failed.attachments.map((a) => ({ type: a.type, url: a.url, name: a.name ?? "" })) }
          : {}),
      });
    draftsRef.current.set(messageId, send);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, delivery: "sending" as const } : m)));
    void executeSend(send);
  };

  const handleNewSession = async () => {
    if (!activeWorkspace || loading) return;
    // SPEC §17: nova sessão encerra o microfone via cleanup único.
    // INV-08: nova sessão também descarta e revoga o rascunho pendente.
    cleanupRecordingMedia();
    clearAttachments();
    discardDrafts();
    setError(null);
    try {
      await renewAgentSession(activeWorkspace.id);
      setMessages([]);
      setPendingOps([]);
      setUndoProposals([]);
      setHistoryLoaded(false);
      setInput("");
      flashNotice("Nova sessão iniciada — o TED mantém o que aprendeu.");
      await loadHistory();
    } catch {
      setError("Não foi possível iniciar uma nova sessão. Tente novamente.");
    }
  };

  return (
    <section
      role="region"
      aria-label="Chat com TED"
      data-testid="ted-chat"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[22px] border border-border-subtle bg-surface-1"
    >
        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-border-subtle bg-surface-2/80 px-4 py-3.5 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[#0A3A28] text-sm font-bold text-white shadow-fab">
              TED
              <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-surface-1 shadow-xs">
                <span className="h-2 w-2 rounded-full bg-primary" />
              </span>
            </span>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-bold tracking-tight text-text-primary">TED</span>
                <span className="rounded-full bg-primary-tint px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-primary">ASSISTENTE</span>
                <span className="h-1 w-1 rounded-full bg-primary" />
                <span className="text-[11px] font-semibold text-primary">{CONNECTION_STATUS_LABELS[status]}</span>
              </div>
              <div className="text-[11px] font-medium leading-none text-text-muted">{activeWorkspace ? activeWorkspace.name : "Selecione um workspace"}</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleNewSession()}
              disabled={loading}
              aria-label="Nova sessão"
              title="Nova sessão (mantém memórias)"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-text-secondary shadow-xs transition-colors hover:bg-surface-4 hover:text-text-primary disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        {/* Message container */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-bg p-4 [scrollbar-width:thin]">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[#0A3A28] text-white shadow-fab">
                <Sparkles size={28} />
              </div>
              <h3 className="text-[16px] font-bold tracking-tight text-text-primary">Olá! Sou o TED.</h3>
              <p className="mt-1.5 max-w-[280px] text-[13px] leading-relaxed text-text-muted">
                Seu co-piloto financeiro. Posso analisar despesas, consultar metas, simular pagamentos e te ajudar a manter o orçamento no azul.
              </p>
              <div className="mt-5 grid w-full max-w-[300px] gap-2">
                {[
                  "Quanto gastei em alimentação este mês?",
                  "Mostre minhas metas e progresso",
                  "Simule pagamento da fatura de R$ 777,40",
                ].map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setInput(q)}
                    className="rounded-[14px] border border-border-subtle bg-surface-1 px-3.5 py-2.5 text-left text-[13px] font-medium text-text-secondary shadow-xs transition-all hover:border-primary hover:bg-surface-2 hover:text-text-primary"
                  >
                    “{q}”
                  </button>
                ))}
              </div>
              <div className="mt-4 text-[11px] font-medium tracking-wide text-text-muted">Sugestões • toque para preencher</div>
            </div>
          )}

          {messages.map((m) => {
            const isCurrentUser = m.isOwn;
            const member = members.find(
              (u) => u.userId === m.actorId || (u as unknown as { id?: string }).id === m.actorId,
            );
            const senderName = isCurrentUser ? "Você" : member?.name || "Membro";
            return (
              <TedMessage
                key={m.id}
                message={m}
                isCurrentUser={isCurrentUser}
                senderName={m.role === "assistant" ? "TED" : senderName}
                delivery={m.delivery}
                onRetry={m.delivery === "failed" ? () => handleRetry(m.id) : undefined}
              />
            );
          })}

          {activeWorkspace &&
            pendingOps.map((op) => {
              const isFocused = focusedOperation?.id === op.id;
              return (
                <div
                  key={op.id}
                  id={`ted-op-${op.id}`}
                  ref={isFocused ? focusedCardRef : undefined}
                  tabIndex={isFocused ? -1 : undefined}
                  data-testid={isFocused ? "ted-approval-focused" : "ted-approval-item"}
                  aria-current={isFocused ? "true" : undefined}
                  className={isFocused ? "rounded-[14px] outline-none ring-2 ring-primary ring-offset-2 ring-offset-surface-1" : undefined}
                >
                  <TedApprovalCard
                    operation={op}
                    workspaceId={activeWorkspace.id}
                    onResolved={(decision) => void handleApprovalResolved(decision)}
                  />
                </div>
              );
            })}

          {activeWorkspace &&
            undoProposals.map((proposal) => (
              <div key={proposal.requestId} data-testid="ted-undo-item">
                <TedUndoCard
                  proposal={proposal}
                  workspaceId={activeWorkspace.id}
                  onResolved={(decision) => void handleUndoResolved(decision)}
                />
              </div>
            ))}

          {showFocusedMissing && (
            <div
              role="status"
              data-testid="ted-approval-missing"
              className="my-2 rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-2.5 text-xs font-semibold text-text-secondary"
            >
              <p>Operação não encontrada nesta conversa.</p>
              <p className="mt-1 font-medium">As decisões acontecem nos cartões desta conversa.</p>
            </div>
          )}

          {status === "streaming" && (
            <div className="flex items-center gap-2 py-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[#0A3A28] text-white shadow-xs">
                <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
              </span>
              <span className="rounded-full bg-surface-1 border border-border-subtle px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-xs">TED está escrevendo…</span>
            </div>
          )}

          {error && <div role="alert" className="my-3 rounded-[14px] border border-danger/30 bg-danger-tint px-3.5 py-2.5 text-xs font-semibold text-danger">{error}</div>}

          <div ref={messagesEndRef} />
        </div>

        {notice && (
          <div role="status" className="mx-4 mb-2 flex items-center gap-2 rounded-[12px] border border-primary/30 bg-primary-tint px-3.5 py-2 text-[12px] font-semibold text-primary shadow-xs">
            <Sparkles size={13} className="flex-none" />
            <span className="truncate">{notice}</span>
          </div>
        )}

        {/* Footer Input */}
        <form onSubmit={handleSend} className="border-t border-border-subtle bg-surface-1 p-3 pb-[env(safe-area-inset-bottom)]">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((att, idx) => (
                <div key={`${att.name}-${idx}`} className="relative flex items-center gap-1.5 rounded-[12px] border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs shadow-xs">
                  {att.type === "image" && (
                    <img src={att.url} alt={att.name} className="h-10 w-10 rounded-[8px] object-cover border border-border-subtle" />
                  )}
                  {att.type === "pdf" && <FileText size={18} className="text-danger" />}
                  {att.type === "audio" && <Mic size={18} className="text-primary" />}
                  <span className="max-w-[100px] truncate text-[11px] font-medium text-text-secondary">{att.name}</span>
                  <span className="text-[10px] text-text-muted">{att.type}</span>
                  <button type="button" aria-label={`Remover ${att.name}`} onClick={() => handleRemoveAttachment(idx)} className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-3 text-text-muted hover:text-danger">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Hidden file inputs — só existem quando a capability está ativa (SPEC §18) */}
          {caps.image && (
            <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleImageSelect} aria-label="input imagem" />
          )}
          {caps.pdf && (
            <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf" multiple className="hidden" onChange={handlePdfSelect} aria-label="input pdf" />
          )}

          <div className="flex items-end gap-1.5 rounded-[16px] border border-border-subtle bg-surface-2 px-2 py-2 shadow-xs transition-colors focus-within:border-primary focus-within:bg-surface-1">
            {caps.image && (
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                aria-label="Anexar imagem"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-surface-3 text-text-secondary hover:bg-surface-4 hover:text-text-primary cursor-pointer"
              >
                <ImageIcon size={16} />
              </button>
            )}
            {caps.pdf && (
              <button
                type="button"
                onClick={() => pdfInputRef.current?.click()}
                aria-label="Anexar PDF"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-surface-3 text-text-secondary hover:bg-surface-4 hover:text-text-primary cursor-pointer"
              >
                <FileText size={16} />
              </button>
            )}
            {/* V4 T1.1 (INV-08 bidirectional): the record button exists ONLY
                when the microphone capability is on — absent from the render
                when off (never disabled), reading the SAME flag as the
                Permissions-Policy header so UI and header never diverge. */}
            {caps.microphone && (
            <button
              type="button"
              onClick={handleToggleRecording}
              aria-label={isRecording ? "Parar gravação" : isRequestingMic ? "Solicitando permissão de microfone" : "Gravar áudio"}
              className={`flex h-9 w-9 flex-none items-center justify-center rounded-full shadow-xs cursor-pointer ${isRecording ? "bg-danger text-white animate-pulse" : "bg-surface-3 text-text-secondary hover:bg-surface-4"}`}
            >
              {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
            )}
            {isRecording && <span className="text-[11px] font-bold text-danger animate-pulse">gravando…</span>}
            {isRequestingMic && <span className="text-[11px] font-medium text-text-muted">solicitando permissão…</span>}
            <textarea
              ref={messageInputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend(e as unknown as React.FormEvent);
                }
              }}
              placeholder="Pergunte sobre gastos, metas ou pagamentos…"
              aria-label="Mensagem para o assistente"
              rows={1}
              className="max-h-28 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-5 text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || (!input.trim() && attachments.length === 0)}
              aria-label="Enviar mensagem"
              className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary text-white shadow-fab transition-all hover:bg-primary-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none cursor-pointer"
            >
              <Send size={15} />
            </button>
          </div>
          {/* §19.5/§24: keyboard hints assume a physical keyboard — they do
              not occupy space on touch devices (hover:none + pointer:coarse). */}
          <div className="mt-2 flex items-center justify-center gap-2 text-[10px] font-medium tracking-wide text-text-muted [@media(hover:none)_and_(pointer:coarse)]:hidden">
            <Paperclip size={10} />
            <span>Pressione Enter para enviar • Shift+Enter para nova linha</span>
          </div>
        </form>
    </section>
  );
}
