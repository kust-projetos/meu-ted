"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import {
  fetchAgentHistory,
  fetchActiveUndoProposals,
  sendAgentMessage,
  renewAgentSession,
  composeChatSend,
  loadPendingChatSend,
  clearPendingChatSend,
  isAnchorSupersededByHistory,
  isTurnAnswerConvergedByIdentity,
  type ActiveUndoProposal,
  type AgentMessage,
  type PendingChatSend,
  type UndoDecision,
} from "@/lib/api/agent-client";
import { TedMessage, type TedDeliveryState } from "./TedMessage";
import { TedExecutionCard } from "./TedExecutionCard";
import { TedUndoCard, type TedUndoProposal } from "./TedUndoCard";
import { useOptionalAppState } from "@/lib/state/app-state-context";
import { routePatrimonio } from "@/lib/routes";
import type { MutationReceipt } from "@pi-finance/llm-contracts/types";
import { AppFloatingMenu } from "@/components/AppFloatingMenu";

import { Sparkles, Send, RefreshCw, Lock, X } from "lucide-react";

const HISTORY_LOAD_ERROR = "Não foi possível carregar o histórico. Tente novamente.";
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
 * FIX-P1-UX #175: browser-side allowlist for the undo decision `result`.
 * The REAL result is the UndoResult envelope `{ undone, receipt }`
 * (API `apps/api/src/approvals/undo.ts:185-188`, relayed verbatim by the
 * Agent `finance-chat-agent.ts:2953` as the decision `result`). Only the
 * RECEIPT nested at `result.receipt` — well-formed (non-empty id/kind,
 * succeeded status, string-array targets) — may reach the financial
 * reconciler. Anything else (absent, null, a flattened receipt at `result`
 * itself, malformed) yields `null` and no reconciliation is invented.
 * Mirrors the agent-client receipt contract without touching it.
 */
const sanitizeUndoResultReceipt = (value: unknown): MutationReceipt | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const receipt = envelope.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const candidate = receipt as Record<string, unknown>;
  if (typeof candidate.mutationId !== "string" || candidate.mutationId.trim() === "") return null;
  if (typeof candidate.mutationKind !== "string" || candidate.mutationKind.trim() === "") return null;
  if (candidate.status !== "succeeded") return null;
  if (!Array.isArray(candidate.affectedTargets)) return null;
  if (!candidate.affectedTargets.every((t) => typeof t === "string")) return null;
  return receipt as MutationReceipt;
};

/** FIX-P1-UX #173: within this distance of the live tail the reader counts as "at the bottom". */
const SCROLL_NEAR_BOTTOM_PX = 120;

/** SPEC §19.4: every connection status is user-facing pt-BR, never raw enum names. */
type TedChatStatus = "connecting" | "ready" | "streaming" | "error";

const CONNECTION_STATUS_LABELS: Readonly<Record<TedChatStatus, string>> = {
  connecting: "conectando…",
  ready: "online",
  streaming: "escrevendo…",
  error: "indisponível",
};

/** Local message with the §19.1 optimistic delivery lifecycle. */
type ChatMessage = AgentMessage & {
  delivery?: TedDeliveryState;
  /**
   * R2 FIX 1: `false` para âncoras legadas reidratadas — o envio original
   * podia ter anexos perdidos no formato antigo, então não há retry (o balão
   * failed é explícito, sem reenvio). Ausente/`true` = retry permitido.
   */
  retryable?: boolean;
};

export function TedChat() {
  const ws = useWorkspaceSafe();
  const activeWorkspace = ws?.activeWorkspace ?? null;
  const members = ws?.members ?? [];
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // debt-undo-confirmation-protocol + debt-undo-proposal-rehydration: live
  // undo proposals come EXCLUSIVELY from structured server state — the turn
  // response's `undoProposal` field (immediate) plus the authenticated
  // active-list RPC below (reload/remount/workspace change). Model text is
  // never parsed or acted on, and rehydration never decides. Entries are
  // deduped by requestId; expired summaries are dropped.
  const [undoProposals, setUndoProposals] = useState<TedUndoProposal[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // P2 — server-confirmed runtime for the live conversation (from the
  // proxied `x-ted-runtime` header). The cancel affordance renders ONLY when
  // B is confirmed; A0/unknown keeps the existing disabled submit (no false
  // cancel — A0 has no turn-cancel path upstream). Local per mount, reset on
  // scope teardown; the module view stays keyed by workspace.
  const canCancelTurn = true;
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<TedChatStatus>("ready");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  /**
   * FIX-P1-UX #173: the reader's viewport position. `true` while the user is
   * parked near the live tail (auto-scroll allowed); `false` while they read
   * history (auto-scroll forbidden, jump button offered). Written ONLY by the
   * list's own scroll events — programmatic jumps never fake it, so a mocked
   * `scrollIntoView` (no real movement) keeps the parked state in tests.
   */
  const nearBottomRef = useRef(true);
  const tailScrolledOnceRef = useRef(false);
  /**
   * FIX-P1-UX #173: identity of the last tail the scroll effect already
   * considered. Card-only updates (undo refreshes, decision follow-ups)
   * reuse the same message tail — with no NEW tail
   * there is nothing to scroll to, so the effect returns early instead of
   * scrolling again on `last.isOwn`. Only a genuinely new tail (a new own
   * send or a new assistant answer) may scroll or toggle the jump button.
   */
  const lastScrolledTailIdRef = useRef<string | undefined>(undefined);
  const tailWatchedRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = messageInputRef.current;
    if (!el) return;
    if (!input) {
      el.style.height = "";
      el.style.overflowY = "hidden";
      return;
    }
    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, 112);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > 112 ? "auto" : "hidden";
  }, [input]);
  const prevWorkspaceIdRef = useRef<string | null>(null);
  // A02/R02 (AC07): live authenticated scope, mirrored on every workspace
  // change. An in-flight turn is bound to the scope that issued it — a result
  // that arrives after a switch/logout belongs to the PREVIOUS scope and is
  // discarded instead of being written into the chat now on screen.
  const activeWorkspaceIdRef = useRef<string | null>(activeWorkspace?.id ?? null);
  /**
   * A02/R02 (AC07 HIGH): scope guard for ANY continuation that writes state
   * after an await. A turn or a refresh belongs to the scope that issued it;
   * once that scope is no longer the live one, the continuation writes
   * nothing. Stable identity (no deps) so `loadHistory` keeps its own.
   */
  const isStaleScope = useCallback((scopeId: string) => activeWorkspaceIdRef.current !== scopeId, []);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable per-message retry drafts retain text and intention identity across reloads.
  const draftsRef = useRef<Map<string, PendingChatSend>>(new Map());
  /**
   * R2 FIX 3 + R3 FIX 1/2: snapshots das âncoras restauradas (`messageId` →
   * conteúdo + timestamp + anexos do envio) para reconciliar em TODA carga de
   * histórico — não só na montagem. Quando o lote autoritativo passa a trazer
   * a mensagem correspondente (FIX-169-170-R2 P2-2: identidade `messageId` /
   * `intentionId` como chave primária; legado: critério temporal do FIX 2 —
   * para âncoras com anexos, só com evidência de anexo — R3 FIX 2), o failed
   * restaurado sai da tela e o servidor vira dono do log. Sobrevive à troca
   * do storage (um novo envio sobrescreve/limpa a âncora) porque vive em
   * memória. Os anexos do snapshot servem à regra de reconciliação e à recusa
   * de retry infiel (R3 FIX 1: sem draft e com anexos, não há reenvio).
   */
  const anchorSnapshotsRef = useRef<
    Map<string, Pick<PendingChatSend, "content" | "createdAt" | "messageId">>
  >(new Map());
  const loadSeqRef = useRef(0);
  const discardDrafts = useCallback(() => {
    draftsRef.current.clear();
    anchorSnapshotsRef.current.clear();
  }, []);

  useEffect(() => () => discardDrafts(), [discardDrafts]);

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
  // trap, no Escape-to-close; navigation away unmounts the page.

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
      // FIX-P1-UX #172: carry the display-safe target projection through
      // when the server sent one; legacy payloads stay target-less and the
      // card degrades to the summary shape.
      next.push({
        requestId: item.requestId,
        status: item.status,
        expiresAt: item.expiresAt,
        ...(item.target ? { target: item.target } : {}),
      });
    }
    setUndoProposals(next);
  }, []);

  /**
   * Returns the authoritative batch this refresh actually observed. Callers
   * that must compare a turn result against the refreshed log (A02/R02 AC06)
   * need the batch itself, never a conversation-wide text scan.
   */
  const loadHistory = useCallback(async (options?: { silent?: boolean }): Promise<AgentMessage[]> => {
    const silent = options?.silent === true;
    if (!activeWorkspace) return [];
    const seq = ++loadSeqRef.current;
    const isObsoleteSilentLoad = () => silent && seq !== loadSeqRef.current;
    try {
    // A02/R02 (AC07 HIGH): this refresh belongs to the scope that started it.
    const scopeId = activeWorkspace.id;
    // P2: re-ground the runtime belief on every history batch — a B pin
    // cleared gateway-side must not keep offering cancel on the A0 that
    // follows. The fetch below re-captures when the header is present.
    let history: AgentMessage[];
    try {
      if (!silent) setStatus("connecting");
      history = await fetchAgentHistory(scopeId);
      if (isObsoleteSilentLoad()) return [];
    } catch {
      // A failed refresh never writes another scope's error.
      if (isStaleScope(scopeId) || isObsoleteSilentLoad()) return [];
      if (silent) return [];
      // SPEC §25.4: a failed reload keeps last-known server state and
      // signals staleness — never invents a card, never wipes history.
      setError(HISTORY_LOAD_ERROR);
      setStatus("error");
      // P2: even a failed batch may have revealed the runtime (a B 400 with
      // no cookie yet still carries the runtime header, captured above).
      return [];
    }
    // The scope may have changed while the batch was in flight: never apply it.
    if (isStaleScope(scopeId) || isObsoleteSilentLoad()) return [];
    // Consume the stable in-flight send anchor and restore it as a failed
    // bubble with retry; never automatically resend. Existing bubbles are
    // deduplicated, and history supersedes matching anchors by identity or
    // text/timestamp. Old-format anchors remain non-retryable when their
    // original payload cannot be reconstructed.
    // R3 FIX 1: o updater abaixo é PURO — só calcula mensagens a partir de
    // decisões tomadas ANTES (ancora superada? quais snapshots reconciliam?
    // a âncora é retryable?). Nenhum `Map.set/delete` e nenhum
    // `clearPendingChatSend` dentro do updater: StrictMode double-invoke
    // passa a ser no-op na 2ª passada. O cleanup de refs/storage acontece
    // DEPOIS do setState, de forma idempotente.
    const anchored = loadPendingChatSend(scopeId);
    // Decisão pura de storage, fora do updater: âncora superada é obsoleta.
    const anchoredSuperseded = anchored ? isAnchorSupersededByHistory(anchored, history) : false;
    if (anchored && anchoredSuperseded) {
      clearPendingChatSend(scopeId);
    }
    // R2 FIX 3: reconciliação em TODA carga de histórico — snapshots
    // superados pelo lote atual, calculados só do histórico (sem `prev`).
    const reconciledIds: string[] = [];
    for (const [anchorId, snap] of anchorSnapshotsRef.current) {
      if (isAnchorSupersededByHistory(snap, history)) reconciledIds.push(anchorId);
    }
    const anchorRetryable = anchored !== null && !anchoredSuperseded && anchored.legacyAnchor !== true;
    setMessages((prev) => {
      let next: ChatMessage[] = [
        ...history,
        // SPEC §19.1/§19.3: local optimistic sends not yet confirmed by the
        // server survive authoritative reloads — failed messages are never
        // silently discarded and in-flight ones keep their sending state.
        // FIX-169 (P0): `sent` bubbles ALSO survive as sent-awaiting-history
        // (consistência eventual explícita) — marking sent then reloading a
        // still-lagging history used to drop the bubble and the turn seemed
        // to vanish. A `sent` bubble superseded below converges to the
        // server copy; a 502/timeout never lands here (failed path).
        ...prev.filter((m) => m.delivery === "sending" || m.delivery === "failed" || m.delivery === "sent"),
      ];
      if (reconciledIds.length > 0) {
        const reconciled = new Set(reconciledIds);
        next = next.filter((m) => !(reconciled.has(m.id) && m.delivery === "failed"));
      }
      // FIX-169: converge `sent` bubbles once the authoritative history
      // carries them (FIX-169-170-R2 P2-2: stable send identity as the primary
      // key, content + timestamp as the legacy fallback — attachment sends
      // additionally require attachment evidence server-side, so an unrelated
      // same-text server message never absorbs them). Until then the local
      // `sent` copy is the visible bubble.
      next = next.filter(
        (m) =>
          m.delivery !== "sent" ||
          !isAnchorSupersededByHistory(
            {
              content: m.content,
              createdAt: m.createdAt ?? new Date().toISOString(),
              // The local bubble id IS the stable send identity (SPEC §7.7:
              // PWA messageId sent as the turn intentionId).
              messageId: m.id,
            },
            history,
          ),
      );
      if (anchored && !anchoredSuperseded && !next.some((m) => m.id === anchored.messageId)) {
        return [
          ...next,
          {
            id: anchored.messageId,
            actorId: "local",
            role: "user",
            content: anchored.content,
            createdAt: anchored.createdAt,
            isOwn: true,
            delivery: "failed" as const,
            // F1: o texto do balão continua EXATAMENTE o digitado (refs de
            // anexo viajam só no draft, nunca compostos no texto que o
            // servidor usa para rotear decisões). Sem URL local pós-reload,
            // não há preview — a fidelidade está no payload do retry.
  
          },
        ];
      }
      return next;
    });
    // Cleanup de refs/storage FORA do updater (idempotente — repetir é no-op).
    for (const anchorId of reconciledIds) {
      anchorSnapshotsRef.current.delete(anchorId);
      draftsRef.current.delete(anchorId);
    }
    if (anchored && anchoredSuperseded) {
      anchorSnapshotsRef.current.delete(anchored.messageId);
      draftsRef.current.delete(anchored.messageId);
    } else if (anchored && !anchorSnapshotsRef.current.has(anchored.messageId)) {
      // Record the snapshot once so a later history refresh can reconcile it;
      // don't overwrite a live retry draft and change its timestamp.
      // Idempotent: repetir o registro com a mesma chave é no-op.
      if (anchorRetryable) {
        draftsRef.current.set(
          anchored.messageId,
          composeChatSend(anchored.content, {
            messageId: anchored.messageId,
            // R2 FIX 1: o draft carrega os MESMOS refs de anexo da âncora —
            // o retry recompõe o payload fiel. Omitido quando vazio para
            // preservar a forma do envio original (sem chave `attachments`).
          }),
        );
      }
      anchorSnapshotsRef.current.set(anchored.messageId, {
        content: anchored.content,
        createdAt: anchored.createdAt,
        messageId: anchored.messageId,
      });
    }
    setHistoryLoaded(true);
    if (!silent) {
      setError(null);
      setStatus("ready");
    }
    // debt-undo-proposal-rehydration: reload/remount rehydrates the live undo
    // cards from the authenticated active-list RPC (bound summaries only).
    // Read-only: failures keep last-known cards, never invent, never decide.
    try {
      const activeUndo = await fetchActiveUndoProposals(scopeId);
      if (isStaleScope(scopeId) || isObsoleteSilentLoad()) return [];
      applyActiveUndoProposals(activeUndo);
    } catch {
      // Last-known undo cards stay (untouched); staleness is already
      // signaled by the history error path above when it fails.
    }
    return history;
    } finally {
    }
  }, [activeWorkspace, applyActiveUndoProposals, isStaleScope]);

  // Reconciliação financeira: o recibo canônico de uma execução bem-sucedida
  // (já validado na fronteira do cliente) atualiza extrato/saldo/dashboard.
  // Seguro fora do AppStateProvider (testes do launcher) via o hook opcional —
  // null significa "sem atualização financeira", nunca reconciliação inventada.
  const optionalAppState = useOptionalAppState();
  const optionalReconcile = optionalAppState?.reconcileMutation;
  const reconcileFinancialUi: ((input: { receipt?: MutationReceipt | null; mutationKind?: string }) => Promise<unknown>) | null =
    optionalReconcile !== undefined && optionalReconcile !== null
      ? (input: { receipt?: MutationReceipt | null; mutationKind?: string }) => optionalReconcile(input)
      : null;

  // debt-undo-confirmation-protocol: uma confirmação de desfazer inverteu uma
  // mutação, então o histórico autoritativo recarrega. Um cancelamento não
  // muda nada. O recibo TYPED carregado pela decisão alimenta o mesmo
  // reconciliador financeiro; sem recibo (ou malformado) nada é inventado.
  const handleUndoResolved = async (decision: UndoDecision): Promise<void> => {
    if (decision.status === "confirmed") {
      const receipt = sanitizeUndoResultReceipt(decision.result);
      if (receipt && reconcileFinancialUi) {
        try {
          await reconcileFinancialUi({ receipt });
        } catch {
          // Reconciliation failure surfaces as stale in app-state;
          // the chat history must still reload below.
        }
      }
      await loadHistory();
    }
  };
  // TASK-08 FIX 2 + R2 FIX 4 (LOW): workspace sem contas/categorias recebe
  // orientação no empty state, reaproveitando copy e rotas existentes
  // (patrimônio para cadastrar conta, `/hub/categorias` para categorias,
  // capture para criar transação) — nenhuma tela nova.
  // Fora do provider (launcher tests) ou com dados indisponíveis, o empty
  // state original é preservado.
  // R2 FIX 4: arrays iniciais vazios ≠ carregado. O gate exige carga
  // concluída — quando o app-state expõe `sync`/`loading`, os domínios
  // contas/categorias precisam estar sincronizados (`syncedAt`) e `loading`
  // precisa ser `false`; sem esses sinais (doubles de teste, launcher sem
  // provider) cai para histórico carregado + arrays definidos. E a cópia
  // distingue contas vazias de categorias vazias (contas têm precedência —
  // sem conta não há onde lançar).
  const setupAccounts = optionalAppState?.accounts;
  const setupCategories = optionalAppState?.categories;
  const setupArraysDefined = Array.isArray(setupAccounts) && Array.isArray(setupCategories);
  const setupSync = optionalAppState?.sync;
  const setupSyncLoaded =
    setupSync === undefined || setupSync === null
      ? true
      : (setupSync.accounts?.syncedAt ?? null) !== null && (setupSync.categories?.syncedAt ?? null) !== null;
  const setupSettled =
    setupArraysDefined && setupSyncLoaded && optionalAppState?.loading !== true;
  const setupAccountsEmpty = Array.isArray(setupAccounts) && setupAccounts.length === 0;
  const setupCategoriesEmpty = Array.isArray(setupCategories) && setupCategories.length === 0;
  const showSetupGuidance =
    messages.length === 0 &&
    historyLoaded &&
    setupSettled &&
    (setupAccountsEmpty || setupCategoriesEmpty);

  const [originContext] = useState<{ label: string; prompts: string[] }>(() => {
    let rawOrigin = "";
    try {
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        rawOrigin = params.get("from") ?? window.sessionStorage.getItem("meu-ted:ted-origin") ?? "";
      }
    } catch {
      rawOrigin = "";
    }
    if (rawOrigin.includes("comprovante") || rawOrigin.includes("capture")) {
      return {
        label: "Atalhos · Comprovante",
        prompts: [
          "Registrar despesa de comprovante PIX: valor e descrição",
          "Lançar compra no cartão a partir de um comprovante",
          "Conferir se este comprovante já foi registrado hoje",
        ],
      };
    }
    if (rawOrigin.includes("cartoes")) {
      return {
        label: "Atalhos · Cartões",
        prompts: [
          "Qual o resumo e vencimento das minhas faturas abertas?",
          "Simule o pagamento da minha fatura atual do cartão",
          "Quanto ainda tenho de limite disponível nos cartões?",
        ],
      };
    }
    if (rawOrigin.includes("registros") || rawOrigin.includes("extrato")) {
      return {
        label: "Atalhos · Extrato",
        prompts: [
          "Quais foram meus maiores gastos recentes no extrato?",
          "Quanto gastei em alimentação neste mês?",
          "Registrar uma nova despesa na conta corrente",
        ],
      };
    }
    if (rawOrigin.includes("relatorios")) {
      return {
        label: "Atalhos · Relatórios",
        prompts: [
          "Quanto entrou, saiu e sobrou neste mês?",
          "Em quais categorias mais gastei nos últimos 30 dias?",
          "Como está minha taxa de poupança real e patrimônio?",
        ],
      };
    }
    if (rawOrigin.includes("compromissos") || rawOrigin.includes("a-pagar")) {
      return {
        label: "Atalhos · Compromissos",
        prompts: [
          "Quais contas a pagar estão vencidas ou vencem esta semana?",
          "Cadastrar uma nova conta a pagar para este mês",
          "Marcar uma conta a pagar pendente como paga",
        ],
      };
    }
    return {
      label: "Atalhos · Início",
      prompts: [
        "Quanto gastei em alimentação este mês?",
        "Quais contas vencem nos próximos dias?",
        "Mostre o resumo do meu saldo e resultado do mês",
      ],
    };
  });

  // Isolamento por workspace: limpar histórico imediatamente ao trocar de workspace.
  useEffect(() => {
    const newId = activeWorkspace?.id ?? null;
    if (prevWorkspaceIdRef.current !== null && prevWorkspaceIdRef.current !== newId) {
      discardDrafts();
      setMessages([]);
      setUndoProposals([]);
      setHistoryLoaded(false);
      setError(null);
      setStatus("ready");
    }
    activeWorkspaceIdRef.current = newId;
    prevWorkspaceIdRef.current = newId;
  }, [activeWorkspace?.id, discardDrafts]);

  useEffect(() => {
    if (activeWorkspace) {
      void loadHistory();
    }
  }, [activeWorkspace, loadHistory]);


  /**
   * FIX-P1-UX #173: reduced-motion users always get instant jumps — every
   * programmatic tail scroll in this chat goes through this helper.
   */
  const scrollToLiveTail = useCallback(() => {
    const tail = messagesEndRef.current;
    if (!tail || typeof tail.scrollIntoView !== "function") return;
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      tail.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "end" });
    } catch {
      /* scroll is best-effort — the jump button stays as the fallback */
    }
  }, []);

  const jumpToLiveTail = useCallback(() => {
    scrollToLiveTail();
    setShowJumpToLatest(false);
  }, [scrollToLiveTail]);

  /** FIX-P1-UX #173: parking far from the tail offers the jump button. */
  const handleMessageListScroll = useCallback(() => {
    const list = messageListRef.current;
    if (!list) return;
    const distanceFromTail = list.scrollHeight - list.scrollTop - list.clientHeight;
    const near = distanceFromTail <= SCROLL_NEAR_BOTTOM_PX;
    nearBottomRef.current = near;
    setShowJumpToLatest(!near);
  }, []);

  // FIX-P1-UX #173: auto-scroll fires only for a NEW tail — the user's own
  // new send, a new assistant/turn answer while near the tail, or mount. A
  // mere card update (same message tail, only undo card updates
  // changed) never yanks the viewport — the reader stays parked and the
  // jump button recovers the live tail on demand.
  useEffect(() => {
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    const tailId = last?.id;
    if (tailWatchedRef.current && tailId === lastScrolledTailIdRef.current) {
      // No new tail since the last pass — a mere card update. Never scroll,
      // never toggle the jump button.
      return;
    }
    tailWatchedRef.current = true;
    lastScrolledTailIdRef.current = tailId;
    if (!tailScrolledOnceRef.current) {
      tailScrolledOnceRef.current = true;
      scrollToLiveTail();
      return;
    }
    if (last?.isOwn === true) {
      scrollToLiveTail();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowJumpToLatest(false);
      return;
    }
    if (nearBottomRef.current) {
      scrollToLiveTail();
      return;
    }
    setShowJumpToLatest(true);
  }, [messages, scrollToLiveTail]);

  // SPEC §19.1: the actual send lifecycle shared by first sends and §19.3
  // retries. Success marks the optimistic bubble as sent and lets the
  // authoritative history own the log; failure keeps the bubble visible as
  // failed (never silently discarded) with the draft intact for retry.
  //
  // Runtime cancellation is always available.
  // active send owns ONE AbortController (ref, never state — transient by
  // `rerender-use-ref-transient-values`). Cancel aborts the in-flight
  // `sendAgentMessage` only; `loading` stays true until the abort settles in
  // `finally`, no second send is enabled meanwhile, and the abort lands in
  // the existing failed+retry UX (same anchor/messageId, same draft — no new
  // delivery enum, no card cancellation). A0/unknown sends carry no abort
  // wiring at all: no effective cancel is ever invoked off-B.
  const activeSendControllerRef = useRef<AbortController | null>(null);
  const handleCancelSend = useCallback(() => {
    activeSendControllerRef.current?.abort();
  }, []);
  const executeSend = async (send: PendingChatSend): Promise<void> => {
    if (!activeWorkspace) return;
    // A02/R02 (AC07): the turn is bound to the scope that issued it.
    const sendWorkspaceId = activeWorkspace.id;
    // A02/R02 (AC06): assistant copies of THIS turn's answer that the
    // conversation already shows before the refresh — the comparison anchor.
    // Identity, never text: an identical reply from an earlier turn counts
    // here and therefore can never suppress this turn's own answer.
    const answerBefore = (text: string | undefined): number =>
      text?.trim() ? messages.filter((m) => !m.isOwn && m.content === text).length : 0;
    setLoading(true);
    setError(null);
    setStatus("streaming");
    // P2: abort wiring exists only for a server-confirmed B turn. A0/unknown
    // sends pass no signal — fetchWithAgentAuth still tracks the flight for
    // session teardown, but nothing can cancel it as a turn.
    const controller = canCancelTurn ? new AbortController() : null;
    activeSendControllerRef.current = controller;
    try {
      const turn = await sendAgentMessage(
        sendWorkspaceId,
        send.content,
        {
          // SPEC §7.7: retries pass the SAME messageId back — a lost HTTP
          // response can never produce a second operation.
          messageId: send.messageId,
          ...(controller ? { signal: controller.signal } : {}),
        },
      );
      // A02/R02 (AC07): a result that lands after a workspace switch or a
      // logout belongs to the previous scope. It is dropped whole — never
      // reconciled into the new conversation, never shown as its error.
      if (isStaleScope(sendWorkspaceId)) return;
      if (turn.memorized && turn.memorized.length > 0) {
        flashNotice(`TED memorizou: ${turn.memorized.slice(0, 2).join(" · ")}`);
      }
      const returnedUndoProposal = turn.undoProposal;
      // ADR-033: o agente confirma e executa direto; a resposta traz um
      // `execution` somente leitura (recibo/outcome), nunca uma proposta
      // acionável. Um `succeeded` sem recibo canônico é degradado pelo cliente.
      const returnedExecution = turn.execution;
      // P1 output vazio: um 200 sem texto de resposta E sem decisão estruturada
      // (undoProposal/execution) não é sucesso — é falha retentável.
      if (!turn.output?.trim() && !returnedUndoProposal && !returnedExecution) {
        if (isStaleScope(sendWorkspaceId)) return;
        setMessages((prev) => prev.map((m) => (m.id === send.messageId ? { ...m, delivery: "failed" as const } : m)));
        setError(MESSAGE_SEND_ERROR);
        setStatus("error");
        return;
      }
      // O recibo canônico da execução (já validado na fronteira) atualiza o
      // financeiro. failed/unverified nunca reconciliam.
      const executedReceipt =
        returnedExecution?.status === "succeeded" ? returnedExecution.receipt : undefined;
      if (executedReceipt && reconcileFinancialUi) {
        try {
          await reconcileFinancialUi({ receipt: executedReceipt });
        } catch {
          // Reconciliation failure surfaces as stale in app-state.
        }
      }
      // A02/R02 (AC07 HIGH): the scope may have changed during the financial
      // reconciliation (an app-state refresh, deliberately NOT skipped — the
      // mutation really happened and its receipt is authoritative). From here
      // on, EVERY write below is chat state and belongs to the new scope only.
      if (isStaleScope(sendWorkspaceId)) return;
      setMessages((prev) => prev.map((m) => (m.id === send.messageId ? { ...m, delivery: "sent" as const } : m)));
      const copiesBefore = answerBefore(turn.output);
      const freshHistory = await loadHistory();
      // …and it may have changed again while the refresh was in flight.
      if (isStaleScope(sendWorkspaceId)) return;
      // The Agent turn is itself authoritative for its user-facing response.
      // History can briefly lag (or omit an autoexecuted result), so retain
      // the returned text — UNLESS this refresh already brought back a copy
      // the conversation did not have yet (A02/R02 AC06: this turn produces
      // exactly ONE answer; an identical one from an earlier turn never
      // suppresses it).
      // FIX-melhorias item 3: quando o lote já traz a resposta DESTE turno
      // (mesmo texto + intentionId do envio — `send.messageId` viajou como
      // intentionId, SPEC §7.7), a cópia local é suprimida por identidade,
      // mesmo que a contagem por texto conte a resposta ainda-local de um
      // turno anterior. Sem identidade em jogo, a regra legada vale.
      const convergedByIdentity = isTurnAnswerConvergedByIdentity(turn.output, send.messageId, freshHistory);
      // A multi-step turn can already be present in the authoritative history
      // under the SAME native assistant id. Appending it again would create a
      // duplicate React key and can leave the composer stuck in `loading`.
      // Identity convergence above is intention-based; this is the final
      // id-based guard for the same turn.
      const alreadyHasTurnId = typeof turn.turnId === "string" && freshHistory.some((m) => m.id === turn.turnId);
      if (
        turn.output?.trim() &&
        !convergedByIdentity &&
        !alreadyHasTurnId &&
        freshHistory.filter((m) => !m.isOwn && m.content === turn.output).length <= copiesBefore
      ) {
        setMessages((previous) => [
          ...previous,
          {
            id: turn.turnId,
            actorId: "ted",
            role: "assistant",
            content: turn.output!,
            createdAt: new Date().toISOString(),
            isOwn: false,
            // ADR-033 S2: the read-only terminal state rides on the assistant
            // message; TedMessage renders its copy and the list renders the
            // receipt-aware (button-free) card below it.
            ...(returnedExecution ? { execution: returnedExecution } : {}),
          },
        ]);
      }
      // debt-undo-confirmation-protocol: the structured turn field is the
      // ONLY source of the undo card — output text never mints one.
      // FIX-P1-UX #172: the display-safe target projection rides along when
      // present; absent stays absent (summary shape, never invented).
      if (returnedUndoProposal) {
        setUndoProposals((previous) => [
          {
            requestId: returnedUndoProposal.requestId,
            status: "proposed",
            expiresAt: returnedUndoProposal.expiresAt,
            ...(returnedUndoProposal.target ? { target: returnedUndoProposal.target } : {}),
          },
          ...previous.filter((proposal) => proposal.requestId !== returnedUndoProposal.requestId),
        ]);
      }
      // §19.3: success consumed the draft — the authoritative history
      // replaced the bubble, so the local blob URLs can be revoked now.
      // A13: os previews são locais (o wire leva só a referência), então o
      // revoke vem do registro local do rascunho, não do payload enviado.
      draftsRef.current.delete(send.messageId);
      // R3 FIX 1: o snapshot da âncora morre com o draft no sucesso — o
      // histórico autoritativo passa a ser dono do log.
      anchorSnapshotsRef.current.delete(send.messageId);
    } catch (err) {
      // A02/R02 (AC07): a failure raised after the scope changed belongs to
      // the previous conversation — never mark a bubble nor surface an error
      // in the chat now on screen. The failed draft of the OLD scope was
      // already dropped by the workspace-change teardown.
      if (isStaleScope(sendWorkspaceId)) return;
      // P2 cancel/timeout: same failed+retry UX — the abort keeps the anchor,
      // messageId and draft intact for retry (no new delivery enum).
      setMessages((prev) => prev.map((m) => (m.id === send.messageId ? { ...m, delivery: "failed" as const } : m)));
      setError(sendErrorMessage(err));
      setStatus("error");
      // No history reload on failure: it would wipe the failed bubble.
      // The draft (messageId and content) stays for retry.
    } finally {
      if (activeSendControllerRef.current === controller) activeSendControllerRef.current = null;
      // Keep loading state scoped to the conversation that started the send.
      if (!isStaleScope(sendWorkspaceId))
        setLoading(false);
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !activeWorkspace || loading) return;

    const userText = input.trim();
    // SPEC §7.7: the send identity is minted ONCE at composition; retries
    // reuse it via the draft record below. Because `content` IS the typed text,
    // the §19.3 retry path re-sends exactly what was typed — the old divergence
    // (markers on the first attempt, plain text on retry) is gone by construction.
    const send = composeChatSend(userText);
    draftsRef.current.set(send.messageId, send);

    const optimistic: ChatMessage = {
      id: send.messageId,
      actorId: "local",
      role: "user",
      content: userText,
      createdAt: new Date().toISOString(),
      isOwn: true,
      delivery: "sending",
    };
    setMessages((prev) => [...prev, optimistic]);

    setInput("");
    void executeSend(send);
  };

  // SPEC §19.3: retry resends the preserved draft — same text, same live
  // attachments, SAME stable messageId. A retry that fails again returns
  // the message to `failed` keeping the draft; success consumes it.
  // R3 FIX 1: sem o draft fiel (com anexos), o retry é RECUSADO — reenviar
  // sem os anexos mudaria o payload sob a mesma identidade (`intentionId`).
  const handleRetry = (messageId: string) => {
    if (!activeWorkspace || loading) return;
    const failed = messages.find((m) => m.id === messageId && m.delivery === "failed");
    // Legacy anchors whose original payload cannot be reconstructed are not
    // retryable (the button is not offered).
    if (!failed || failed.retryable === false) return;
    const stored = draftsRef.current.get(messageId);
    const send = stored ?? composeChatSend(failed.content, { messageId });
    if (!send.content.trim()) return;
    draftsRef.current.set(messageId, send);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, delivery: "sending" as const } : m)));
    void executeSend(send);
  };

  const handleNewSession = async () => {
    if (!activeWorkspace || loading) return;
    discardDrafts();
    setError(null);
    // As listas ativas têm escopo de workspace/ator/device, não de sessão —
    // a renovação NÃO as cancela. Este refresh pertence ao escopo que o iniciou.
    const scopeId = activeWorkspace.id;
    try {
      await renewAgentSession(scopeId);
      // O escopo pode ter mudado durante o POST: nada da sessão antiga entra na nova.
      if (isStaleScope(scopeId)) return;
      // P2: a renewal defines a fresh conversation lifecycle (the client
      // reset the view on success) — sync the local gate from it.
      setMessages([]);
      setInput("");
      // Nova sessão limpa SÓ a exibição local: o lote do /rpc/history logo
      // após a renovação ainda pode trazer as mensagens pré-renovação
      // (evidência live), então NÃO recarrega aqui — a recarga traria as
      // mensagens antigas de volta para a tela. O próximo turno/mount
      // recarrega do servidor normalmente. O POST session/new acima segue
      // intocado (arquivamento server-side preservado).
      setHistoryLoaded(true);
      setStatus("ready");
      flashNotice("Nova sessão iniciada — o TED mantém o que aprendeu.");
      // Reidrata SÓ os undos vivos da fonte autoritativa (mesmo filtro do
      // loadHistory, sem recarregar mensagens). Falha preserva o último
      // estado conhecido — nunca inventa cartão.
      try {
        const activeUndo = await fetchActiveUndoProposals(scopeId);
        if (isStaleScope(scopeId)) return;
        applyActiveUndoProposals(activeUndo);
      } catch {
        // Cartões de undo preservados (último estado conhecido).
      }
    } catch {
      setError("Não foi possível iniciar uma nova sessão. Tente novamente.");
    }
  };

  // ADR-027 D3: opt-in explícito por conversa privada (gated server-side;
  // 403 com flag off vira aviso honesto, sem expor ids).
  const handleNewPrivateSession = async () => {
    if (!activeWorkspace || loading) return;
    discardDrafts();
    setError(null);
    try {
      const renewal = await renewAgentSession(activeWorkspace.id, { visibility: 'private' });
      setMessages([]);
      setUndoProposals([]);
      setHistoryLoaded(false);
      setInput("");
      flashNotice(
        renewal.visibility === 'private'
          ? "Conversa privada iniciada — só você vê este contexto."
          : "Nova sessão iniciada — o TED mantém o que aprendeu.",
      );
      await loadHistory();
    } catch {
      setError("Conversas privadas estão desabilitadas neste workspace. Tente novamente.");
    }
  };

  return (
    <section
      role="region"
      aria-label="Chat com TED"
      data-testid="ted-chat"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[22px] border border-border-subtle bg-surface-1"
    >
        {/* Header */}
        <div className="relative z-30 flex items-center justify-between border-b border-border-subtle bg-surface-2/80 px-4 py-3.5 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-full shadow-fab ring-1 ring-primary/25">
              <img
                src="/brand/ted-launcher.png"
                alt=""
                width={40}
                height={40}
                className="h-full w-full rounded-full object-cover"
              />
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
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleNewPrivateSession()}
              disabled={loading}
              aria-label="Nova conversa privada"
              title="Nova conversa privada (só você vê)"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-text-secondary shadow-xs transition-colors hover:bg-surface-4 hover:text-text-primary disabled:opacity-50 cursor-pointer"
            >
              <Lock size={14} />
            </button>
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
            <AppFloatingMenu compact />
          </div>
        </div>

        {/* Message container */}
        <div
          ref={messageListRef}
          data-testid="ted-message-list"
          onScroll={handleMessageListScroll}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-bg p-4 [scrollbar-width:thin]"
        >
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
              <img
                src="/brand/ted-launcher.png"
                alt=""
                width={56}
                height={56}
                className="mb-4 h-14 w-14 rounded-full object-cover shadow-fab ring-2 ring-primary/25"
              />
              <h3 className="text-[16px] font-bold tracking-tight text-text-primary">Olá! Sou o TED.</h3>
              <p className="mt-1.5 max-w-[280px] text-[13px] leading-relaxed text-text-muted">
                Seu co-piloto financeiro. Posso analisar despesas, consultar metas, simular pagamentos e te ajudar a manter o orçamento no azul.
              </p>
              {showSetupGuidance && (
                <div
                  data-testid="ted-setup-guidance"
                  className="mt-4 w-full max-w-[300px] rounded-[14px] border border-dashed border-border-subtle bg-surface-2 px-3.5 py-3 text-left"
                >
                  {setupAccountsEmpty ? (
                    <p
                      data-testid="ted-setup-guidance-accounts"
                      className="text-[13px] leading-relaxed text-text-secondary"
                    >
                      Nenhuma conta cadastrada. Cadastre sua primeira conta para o TED registrar e analisar seus gastos.
                    </p>
                  ) : (
                    <p
                      data-testid="ted-setup-guidance-categories"
                      className="text-[13px] leading-relaxed text-text-secondary"
                    >
                      Nenhuma categoria cadastrada. Crie categorias para organizar seus gastos por tema.
                    </p>
                  )}
                  <div className="mt-2.5 flex flex-col gap-2">
                    {setupAccountsEmpty ? (
                      <a
                        href={routePatrimonio("contas")}
                        className="rounded-[12px] bg-primary px-3.5 py-2.5 text-center text-[13px] font-bold text-white shadow-xs transition-all hover:bg-primary-hover"
                      >
                        Cadastrar conta
                      </a>
                    ) : (
                      <a
                        href="/hub/categorias"
                        className="rounded-[12px] bg-primary px-3.5 py-2.5 text-center text-[13px] font-bold text-white shadow-xs transition-all hover:bg-primary-hover"
                      >
                        Ver categorias
                      </a>
                    )}
                    <a
                      href="/capture"
                      className="rounded-[12px] border border-border-subtle bg-surface-1 px-3.5 py-2.5 text-center text-[13px] font-bold text-text-primary shadow-xs transition-all hover:border-primary"
                    >
                      Criar transação
                    </a>
                  </div>
                </div>
              )}
              <div className="mt-5 grid w-full max-w-[300px] gap-2" data-testid="ted-origin-shortcuts">
                {originContext.prompts.map((q) => (
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
              <div className="mt-4 text-[11px] font-medium tracking-wide text-text-muted">
                {originContext.label} • toque para preencher
              </div>
            </div>
          )}

          {messages.map((m) => {
            const isCurrentUser = m.isOwn;
            const member = members.find(
              (u) => u.userId === m.actorId || (u as unknown as { id?: string }).id === m.actorId,
            );
            const senderName = isCurrentUser ? "Você" : member?.name || "Membro";
            return (
              <div key={m.id}>
                <TedMessage
                  message={m}
                  isCurrentUser={isCurrentUser}
                  senderName={m.role === "assistant" ? "TED" : senderName}
                  delivery={m.delivery}
                  // R2 FIX 1: failed de âncora legada não oferece retry.
                  onRetry={m.delivery === "failed" && m.retryable !== false ? () => handleRetry(m.id) : undefined}
                />
                {/* Resultado terminal e somente leitura da execução feita
                    pelo agente — sem botões de decisão. */}
                {!isCurrentUser && m.execution && <TedExecutionCard execution={m.execution} />}
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

          {status === "streaming" && (
            <div className="flex items-center gap-2 py-3">
              <img
                src="/brand/ted-launcher.png"
                alt=""
                width={28}
                height={28}
                className="h-7 w-7 animate-pulse rounded-full object-cover shadow-xs ring-1 ring-primary/25"
              />
              <span className="rounded-full bg-surface-1 border border-border-subtle px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-xs">TED está escrevendo…</span>
            </div>
          )}

          {error && <div role="alert" className="my-3 rounded-[14px] border border-danger/30 bg-danger-tint px-3.5 py-2.5 text-xs font-semibold text-danger">{error}</div>}

          {/* The live-tail sentinel carries a bottom scroll-margin ≥ the fixed
              BottomNav height (`--tab-bar-height` 72px + safe-area) plus
              composer clearance so the last message/card never lands under
              "Início" when scrolled into view. */}
          <div
            ref={messagesEndRef}
            data-testid="ted-live-tail"
            aria-hidden="true"
            className="scroll-mb-[calc(var(--tab-bar-height)+env(safe-area-inset-bottom)+5rem)]"
          />
        </div>

        {/* FIX-P1-UX #173: parked readers recover the live tail on demand.
            Absolute above the composer so it never covers input/buttons —
            safe at 390px widths. */}
        {showJumpToLatest && (
          <button
            type="button"
            onClick={jumpToLiveTail}
            aria-label="Ir à última mensagem"
            className="absolute bottom-28 right-4 z-10 rounded-full bg-primary px-3.5 py-2 text-[12px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-95"
          >
            ↓ Ir à última
          </button>
        )}

        {notice && (
          <div role="status" className="mx-4 mb-2 flex items-center gap-2 rounded-[12px] border border-primary/30 bg-primary-tint px-3.5 py-2 text-[12px] font-semibold text-primary shadow-xs">
            <Sparkles size={13} className="flex-none" />
            <span className="truncate">{notice}</span>
          </div>
        )}

        {/* Footer Input */}
        <form onSubmit={handleSend} className="border-t border-border-subtle bg-surface-1 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          {/* Attachment previews */}
          <div className="flex items-end gap-2 rounded-[20px] border border-border-subtle bg-surface-2 py-1.5 pl-3.5 pr-1.5 shadow-xs transition-colors focus-within:border-primary focus-within:bg-surface-1">
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
              className="max-h-28 min-h-[36px] flex-1 resize-none overflow-y-hidden bg-transparent py-2 text-[13px] leading-[1.35] text-text-primary placeholder:truncate placeholder:text-[12.5px] placeholder:text-text-muted focus:outline-none"
            />
            {loading && canCancelTurn ? (
              <button
                type="button"
                onClick={handleCancelSend}
                aria-label="Cancelar envio"
                title="Cancelar envio"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary text-white shadow-fab transition-all hover:bg-primary-hover active:scale-95 cursor-pointer"
              >
                <X size={15} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={loading || !input.trim()}
                aria-label="Enviar mensagem"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary text-white shadow-fab transition-all hover:bg-primary-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none cursor-pointer"
              >
                <Send size={15} />
              </button>
            )}
          </div>
          {/* §19.5/§24: keyboard hints assume a physical keyboard — they do
              not occupy space on touch devices (hover:none + pointer:coarse). */}
          <div className="mt-2 flex items-center justify-center gap-2 text-[10px] font-medium tracking-wide text-text-muted [@media(hover:none)_and_(pointer:coarse)]:hidden">
            <span>Pressione Enter para enviar • Shift+Enter para nova linha</span>
          </div>
        </form>
    </section>
  );
}
