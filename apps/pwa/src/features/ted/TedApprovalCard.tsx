"use client";

import { useEffect, useRef, useState } from "react";
import { isActionablePendingOperationPresentation } from "@pi-finance/llm-contracts/types";
import {
  decidePendingOperation,
  describePendingOperationStatus,
  formatCentsToBRL,
  formatDateToBR,
  type PendingOperationDecision,
  type PendingOperationPresentation,
  type PendingOperationStatus,
} from "@/lib/api/agent-client";

export type TedPendingOperation = Readonly<{
  id: string;
  status: PendingOperationStatus;
  operation: string;
  summary?: string;
  /**
   * T3.4 (SPEC §16, INV-02): safe projection derived from the same
   * canonical hash-bound args that will execute. Absent on legacy
   * in-flight payloads — the card degrades to the summary shape.
   */
  presentation?: PendingOperationPresentation;
}>;

interface TedApprovalCardProps {
  operation: TedPendingOperation;
  workspaceId: string;
  /** T3.3: receives the resolved decision (carrying the real receipt, when present). */
  onResolved?: (decision: PendingOperationDecision) => void;
}

const deriveFallbackTitle = (operation: TedPendingOperation): string => {
  if (operation.operation.includes("income")) return "Confirmar receita";
  if (operation.operation.includes("expense")) return "Confirmar despesa";
  return operation.summary || "Confirmar operação";
};

/**
 * FIX-P1-UX-R3: terminal-sticky lifecycle predicates. `succeeded` /
 * `cancelled` / `expired` are DEFINITIVE terminals — the first one applied
 * wins and no later remote snapshot or late RPC verdict ever moves the card
 * again. `failed` is a RETRYABLE terminal: the card never steps INTO it from
 * another terminal verdict (a stale failure GET would resurrect Retry), but a
 * retryable `failed` follows a legitimate retry — back into `executing` /
 * `confirmed`, or onward to its definitive outcome — instead of freezing on
 * the failure shape. Retry is only offered while `failed` is the confirmed
 * current state.
 */
const isDefinitiveTerminal = (status: TedPendingOperation["status"]): boolean =>
  status === "succeeded" || status === "cancelled" || status === "expired";

const isTerminalStatus = (status: TedPendingOperation["status"]): boolean =>
  status === "failed" || isDefinitiveTerminal(status);

const isRetryInflight = (status: TedPendingOperation["status"]): boolean =>
  status === "executing" || status === "confirmed";

/**
 * FIX-P1-UX #171: lifecycle rank of the approval states. Forward motion only
 * — see the terminal-sticky guards on the sync effect and on `resolve`.
 */
const APPROVAL_STATUS_RANK: Readonly<Record<TedPendingOperation["status"], number>> = {
  proposed: 0,
  executing: 1,
  confirmed: 1,
  failed: 2,
  succeeded: 2,
  cancelled: 2,
  expired: 2,
};

export function TedApprovalCard({ operation, workspaceId, onResolved }: TedApprovalCardProps) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TedPendingOperation["status"]>(operation.status);
  const [error, setError] = useState<string | null>(null);

  // FIX-P1-UX #171 + FIX-P1-UX-R3: the remote `operation.status` is
  // authoritative and must flow into the card — the initial `useState`
  // snapshot alone goes stale on every parent refresh. Terminal-sticky guards
  // keep the card from stepping back:
  // (1) a definitive terminal (`succeeded`/`cancelled`/`expired`) never moves
  // again — first terminal wins, so a stale GET carrying another terminal
  // (e.g. `failed` after `succeeded`) never regresses the card nor resurrects
  // Retry; moves between definitive terminals are likewise ignored;
  // (2) the card never steps INTO `failed` from a terminal verdict — a stale
  // failure GET after a verdict would resurrect Retry (`executing`/
  // `confirmed`→`failed` stays allowed: that is the execution legitimately
  // failing);
  // (3) a retryable `failed` follows a legitimate retry — back into
  // `executing`/`confirmed`, or onward to its definitive outcome when the
  // refresh skips flight — instead of freezing on the failure shape;
  // converging to a definitive outcome resurrects no action (it renders no
  // buttons);
  // (4) any other refresh must be strictly forward by lifecycle rank
  // (proposed(0) < executing/confirmed(1) < terminals(2)) — stale snapshots
  // never downgrade the card, no resurrected Confirm/Cancel/Retry;
  // (5) a decision RPC that resolves after a NEWER remote truth arrived
  // mid-flight never overwrites it — the newer truth wins, while the decision
  // itself still propagates to the parent (reconcile + reload).
  const lastRemoteStatusRef = useRef(operation.status);
  useEffect(() => {
    const prev = lastRemoteStatusRef.current;
    const next = operation.status;
    if (next === prev) return;
    // FIX-P1-UX-R3 HIGH: definitive terminal never regresses — first wins.
    if (isDefinitiveTerminal(prev)) return;
    // FIX-P1-UX-R3 HIGH: never step INTO `failed` from a terminal verdict
    // (stale failure GET); flight→failed stays allowed (legitimate failure).
    if (next === "failed" && isTerminalStatus(prev)) return;
    // FIX-P1-UX-R3 MEDIUM: retryable `failed` follows the retry — back into
    // flight or onward to its definitive outcome — instead of freezing.
    if (prev === "failed" && (isRetryInflight(next) || isDefinitiveTerminal(next))) {
      lastRemoteStatusRef.current = next;
      setStatus(next);
      return;
    }
    if ((APPROVAL_STATUS_RANK[next] ?? 0) > (APPROVAL_STATUS_RANK[prev] ?? 0)) {
      lastRemoteStatusRef.current = next;
      setStatus(next);
    }
  }, [operation.status]);
  const presentation = operation.presentation;
  const title = presentation?.title ?? deriveFallbackTitle(operation);
  const operationLabel = presentation?.description ?? operation.summary ?? operation.operation ?? "operação financeira";

  const resolve = async (decision: "confirm" | "cancel" | "retry") => {
    const remoteAtStart = lastRemoteStatusRef.current;
    const resolved: PendingOperationDecision = await decidePendingOperation(workspaceId, operation.id, decision);
    const latestRemote = lastRemoteStatusRef.current;
    // FIX-P1-UX #171 + FIX-P1-UX-R3: a newer remote truth that arrived while
    // this RPC was in flight wins over this verdict — never step the card
    // back to it. That is either a strictly more advanced remote state, or a
    // definitive terminal (`succeeded`/`cancelled`/`expired`) differing from
    // this verdict (a tardy `failed` after a `succeeded` refresh never
    // regresses the card nor resurrects Retry). The decision itself still
    // propagates to the parent so reconciliation and history reload happen.
    // A legitimate retry verdict (from the confirmed `failed` state, with no
    // newer remote truth) always propagates — retry never freezes.
    if (
      ((APPROVAL_STATUS_RANK[latestRemote] ?? 0) > (APPROVAL_STATUS_RANK[remoteAtStart] ?? 0) &&
        (APPROVAL_STATUS_RANK[latestRemote] ?? 0) > (APPROVAL_STATUS_RANK[resolved.status] ?? 0)) ||
      (isDefinitiveTerminal(latestRemote) && latestRemote !== resolved.status)
    ) {
      onResolved?.(resolved);
      return;
    }
    lastRemoteStatusRef.current = resolved.status;
    setStatus(resolved.status);
    onResolved?.(resolved);
  };

  const isUncertainOutcome = (e: unknown): boolean => {
    const code = (e as { code?: unknown }).code;
    // A retry that cannot prove its outcome may already have executed.
    if (code === "agent.execution_outcome_unknown" || code === "approval.execution_uncertain") return true;
    // P2-2 (defesa em profundidade): um erro cru de validação que escape o
    // mapeamento do cliente também é outcome não verificado — nunca erro
    // comum retentável com botões de decisão.
    return (e as { name?: unknown }).name === "ZodError";
  };

  // Shared approve/retry lock: the decision may have reached the API and
  // committed the write even when the response/receipt is missing. Keep this
  // card non-actionable until the authoritative operation state is refreshed.
  // FIX-P1-UX-R4: a late RPC rejection after a definitive terminal refresh
  // must not regress the card — the definitive terminal wins, no lock.
  const lockUnverified = () => {
    if (isDefinitiveTerminal(lastRemoteStatusRef.current)) return;
    setStatus("executing");
    setError("O resultado desta operação ainda não foi verificado. Atualize o estado antes de tomar outra decisão.");
  };

  const handleRetry = async () => {
    setLoading(true);
    setError(null);
    try {
      await resolve("retry");
    } catch (e) {
      // Uncertain post-retry outcome: SAME lock as approve — executing, no
      // Confirm/Cancel/Retry, no duplicate resend. Any other error keeps the
      // failed state with Retry available.
      // FIX-P1-UX-R4: both branches respect terminal-sticky — a definitive
      // terminal already in force is never regressed by a late rejection.
      if (isDefinitiveTerminal(lastRemoteStatusRef.current)) return;
      if (isUncertainOutcome(e)) {
        lockUnverified();
      } else {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    setLoading(true);
    setError(null);
    try {
      await resolve("confirm");
    } catch (e) {
      // Só incerteza real (resultado pós-write desconhecido) trava como
      // não-verificado. 502/timeout/offline e demais erros são retentáveis
      // e distinguíveis — mesmo padrão do retry acima.
      if (isDefinitiveTerminal(lastRemoteStatusRef.current)) return;
      if (isUncertainOutcome(e)) {
        lockUnverified();
      } else {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    setLoading(true);
    setError(null);
    try {
      await resolve("cancel");
    } catch (e) {
      // FIX-P1-UX-R4: late rejection never regresses a definitive terminal.
      if (isDefinitiveTerminal(lastRemoteStatusRef.current)) return;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Mandatory presentation (production functional corrections item 4,
  // SPEC §16 INV-02): Retry re-authorizes money movement, so it may only be
  // offered next to the actionable hash-bound financial data the user is
  // re-authorizing. Without it, Retry never renders and retry is never sent.
  const hasActionablePresentation =
    presentation !== undefined && isActionablePendingOperationPresentation(presentation);

  if (status === "failed") {
    if (!hasActionablePresentation || !presentation) {
      return (
        <div className="my-2 rounded-[14px] border border-danger/30 bg-danger-tint p-3 text-xs text-danger">
          <strong>Não foi possível concluir a operação — {describePendingOperationStatus("failed")}.</strong>
          <div className="mt-0.5">Dados da operação incompletos — não é possível tentar novamente. Atualize e refaça a proposta.</div>
          {error && <div className="mt-1">{error}</div>}
        </div>
      );
    }
    return (
      <div className="my-2 rounded-[14px] border border-danger/30 bg-danger-tint p-3 text-xs text-danger">
        <strong>Não foi possível concluir a operação — {describePendingOperationStatus("failed")}.</strong>
        <div className="mt-1 text-sm font-semibold">⚠️ {presentation.title}</div>
        {presentation.description && <div className="mt-0.5 font-semibold">{presentation.description}</div>}
        <dl className="mt-2 space-y-1">
          {typeof presentation.amountCents === "number" && (
            <div className="flex justify-between gap-2">
              <dt className="opacity-70">Valor</dt>
              <dd className="font-bold">{formatCentsToBRL(presentation.amountCents)}</dd>
            </div>
          )}
          {presentation.account && (
            <div className="flex justify-between gap-2">
              <dt className="opacity-70">Conta</dt>
              <dd className="font-semibold">{presentation.account.label}</dd>
            </div>
          )}
          {presentation.category && (
            <div className="flex justify-between gap-2">
              <dt className="opacity-70">Categoria</dt>
              <dd className="font-semibold">{presentation.category.label}</dd>
            </div>
          )}
          {presentation.date && (
            <div className="flex justify-between gap-2">
              <dt className="opacity-70">Data</dt>
              <dd className="font-semibold">{formatDateToBR(presentation.date)}</dd>
            </div>
          )}
        </dl>
        {presentation.warnings.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {presentation.warnings.map((warning) => (
              <li key={warning}>⚠️ {warning}</li>
            ))}
          </ul>
        )}
        <div className="mt-1">Revise os dados acima — tentar novamente reautoriza esta operação pelo mesmo fluxo de aprovação.</div>
        {error && <div className="mt-1">{error}</div>}
        <button type="button" disabled={loading} onClick={handleRetry} className="mt-2 rounded-[10px] border border-danger/30 px-3 py-2 font-bold disabled:opacity-50">{loading ? "Tentando…" : "Tentar novamente"}</button>
      </div>
    );
  }
  if (status === "executing" || status === "confirmed") {
    // SPEC §16: never premature success (INV-03) — the operation is running.
    return (
      <div className="my-2 rounded-[14px] border border-border-subtle bg-surface-2 p-3 text-xs text-text-secondary">
        {error ? (
          <><strong className="text-warning">⚠️ {error}</strong>: <strong className="text-text-primary">{operationLabel}</strong></>
        ) : (
          <>⏳ {describePendingOperationStatus(status)}: <strong className="text-text-primary">{operationLabel}</strong></>
        )}
      </div>
    );
  }
  if (!["proposed"].includes(status)) {
    const stateLabel = describePendingOperationStatus(status);
    return (
      <div className="my-2 rounded-[14px] border border-border-subtle bg-surface-2 p-3 text-xs text-text-secondary">
        Operação {status === "succeeded" ? "✅ registrada" : status === "cancelled" ? "❌ cancelada" : `⏳ ${stateLabel}`}: <strong className="text-text-primary">{operationLabel}</strong>
      </div>
    );
  }

  // Canonical card (SPEC §16 example): real financial data, never summary-only.
  if (presentation) {
    // V3-FIX-CARD-FAILCLOSED (SPEC §16, INV-02): an incomplete financial
    // context degrades to a non-actionable card — Cancel stays (it moves no
    // money), Confirm never renders.
    if (!isActionablePendingOperationPresentation(presentation)) {
      return (
        <div className="my-2 rounded-[16px] border border-warning/30 bg-warning-tint p-3.5 text-xs shadow-xs">
          <div className="font-bold text-warning">⚠️ {title}</div>
          {presentation.description && <div className="mt-1 text-sm font-semibold text-text-primary">{presentation.description}</div>}
          <dl className="mt-2 space-y-1 text-text-primary">
            {typeof presentation.amountCents === "number" && (
              <div className="flex justify-between gap-2">
                <dt className="text-text-muted">Valor</dt>
                <dd className="font-bold">{formatCentsToBRL(presentation.amountCents)}</dd>
              </div>
            )}
            {presentation.account && (
              <div className="flex justify-between gap-2">
                <dt className="text-text-muted">Conta</dt>
                <dd className="font-semibold">{presentation.account.label}</dd>
              </div>
            )}
            {presentation.category && (
              <div className="flex justify-between gap-2">
                <dt className="text-text-muted">Categoria</dt>
                <dd className="font-semibold">{presentation.category.label}</dd>
              </div>
            )}
            {presentation.date && (
              <div className="flex justify-between gap-2">
                <dt className="text-text-muted">Data</dt>
                <dd className="font-semibold">{formatDateToBR(presentation.date)}</dd>
              </div>
            )}
          </dl>
          {presentation.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-warning">
              {presentation.warnings.map((warning) => (
                <li key={warning}>⚠️ {warning}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 font-semibold text-warning">Dados da operação incompletos — não é possível confirmar agora. Atualize e tente novamente, ou cancele.</div>

          {error && <div className="mt-1 font-semibold text-danger">{error}</div>}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={handleReject}
              className="rounded-[10px] border border-border-subtle bg-surface-1 px-3.5 py-2 font-bold text-text-secondary transition-all hover:bg-surface-2 active:scale-95 disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      );
    }
    const confirmLabel =
      typeof presentation.amountCents === "number" ? `Confirmar ${formatCentsToBRL(presentation.amountCents)}` : "Confirmar";
    return (
      <div className="my-2 rounded-[16px] border border-warning/30 bg-warning-tint p-3.5 text-xs shadow-xs">
        <div className="font-bold text-warning">⚠️ {title}</div>
        <dl className="mt-2 space-y-1 text-text-primary">
          {presentation.description && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Descrição</dt>
              <dd className="font-semibold">{presentation.description}</dd>
            </div>
          )}
          {typeof presentation.amountCents === "number" && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Valor</dt>
              <dd className="font-bold">{formatCentsToBRL(presentation.amountCents)}</dd>
            </div>
          )}
          {presentation.account && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Conta</dt>
              <dd className="font-semibold">{presentation.account.label}</dd>
            </div>
          )}
          {presentation.category && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Categoria</dt>
              <dd className="font-semibold">{presentation.category.label}</dd>
            </div>
          )}
          {presentation.date && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Data</dt>
              <dd className="font-semibold">{formatDateToBR(presentation.date)}</dd>
            </div>
          )}
        </dl>
        {presentation.warnings.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-warning">
            {presentation.warnings.map((warning) => (
              <li key={warning}>⚠️ {warning}</li>
            ))}
          </ul>
        )}
        <div className="mt-0.5 text-text-muted">O valor será registrado no seu histórico financeiro. {describePendingOperationStatus("proposed")}.</div>

        {error && <div className="mt-1 font-semibold text-danger">{error}</div>}

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={handleApprove}
            className="rounded-[10px] bg-primary px-3.5 py-2 font-bold text-white shadow-xs transition-all hover:bg-primary-hover active:scale-95 disabled:opacity-50"
          >
            {loading ? "Processando…" : confirmLabel}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={handleReject}
            className="rounded-[10px] border border-border-subtle bg-surface-1 px-3.5 py-2 font-bold text-text-secondary transition-all hover:bg-surface-2 active:scale-95 disabled:opacity-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  // Legacy payload (old in-flight op without a presentation): fail closed.
  // Without the hash-bound presentation there is nothing the user can
  // review, so Confirm/Aprovar never render. Cancel moves no money and
  // stays available. Never synthesize a presentation from summary, LLM
  // text, or cache.
  return (
    <div className="my-2 rounded-[16px] border border-warning/30 bg-warning-tint p-3.5 text-xs shadow-xs">
      <div className="font-bold text-warning">⚠️ {title}</div>
      {operation.summary && (
        <div className="mt-1 text-text-primary">
          Ação: <strong>{operation.summary}</strong>
        </div>
      )}
      <div className="mt-2 font-semibold text-warning">Dados da operação incompletos — não é possível confirmar agora. Atualize e tente novamente, ou cancele.</div>

      {error && <div className="mt-1 font-semibold text-danger">{error}</div>}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={handleReject}
          className="rounded-[10px] border border-border-subtle bg-surface-1 px-3.5 py-2 font-bold text-text-secondary transition-all hover:bg-surface-2 active:scale-95 disabled:opacity-50"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
