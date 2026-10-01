"use client";

import { useState } from "react";
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

export function TedApprovalCard({ operation, workspaceId, onResolved }: TedApprovalCardProps) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TedPendingOperation["status"]>(operation.status);
  const [error, setError] = useState<string | null>(null);
  const presentation = operation.presentation;
  const title = presentation?.title ?? deriveFallbackTitle(operation);
  const operationLabel = presentation?.description ?? operation.summary ?? operation.operation ?? "operação financeira";

  const resolve = async (decision: "confirm" | "cancel" | "retry") => {
    const resolved: PendingOperationDecision = await decidePendingOperation(workspaceId, operation.id, decision);
    setStatus(resolved.status);
    onResolved?.(resolved);
  };

  const isUncertainOutcome = (e: unknown): boolean => {
    const code = (e as { code?: unknown }).code;
    // A retry that cannot prove its outcome may already have executed.
    return code === "agent.execution_outcome_unknown" || code === "approval.execution_uncertain";
  };

  // Shared approve/retry lock: the decision may have reached the API and
  // committed the write even when the response/receipt is missing. Keep this
  // card non-actionable until the authoritative operation state is refreshed.
  const lockUnverified = () => {
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
    } catch {
      lockUnverified();
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
