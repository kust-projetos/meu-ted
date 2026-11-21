"use client";

import { useState } from "react";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import { undoLastAction } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/client";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import { usePendingOperations } from "@/lib/state/use-pending-operations";
import {
  describePendingOperationStatus,
  formatCentsToBRL,
  formatDateToBR,
} from "@/lib/api/agent-client";
import { openTedChat } from "@/features/ted/TedChatLauncher";
import { useOptionalAppState } from "@/lib/state/app-state-context";
import { notifyPendingOperationsChanged } from "@/lib/state/use-pending-operations";
import { ShieldCheck, Undo2, ExternalLink } from "lucide-react";

/**
 * T5.3 (H-14, SPEC §22): reflective listing of the workspace's ACTIVE
 * pending operations (lean projection relayed by the Agent). This surface
 * NEVER decides — no approve/cancel executor exists here, ever. Every CTA
 * routes back to the TED, where the Decision Service owns
 * confirm/cancel/retry and disambiguates between multiple operations.
 *
 * Each item opens the single chat deep-linked to that operation. The
 * Decision Service inside the TED still owns every decision.
 */
const PENDING_LIST_ERROR = "Não foi possível carregar as aprovações agora.";

function OpenInTedButton({ label }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => openTedChat(label ? { operationId: label } : undefined)}
      data-testid={label ? "pending-open-ted-item" : "pending-open-ted"}
      className="flex items-center justify-center gap-1.5 rounded-[12px] bg-primary px-4 py-2 text-[12px] font-bold text-white shadow-xs transition-all hover:bg-primary-strong active:scale-[0.99]"
    >
      <ExternalLink size={14} />
      Abrir no TED
    </button>
  );
}

export default function PendingOperationsPage({ embedded = false }: { embedded?: boolean }) {
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoResult, setUndoResult] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const workspace = useWorkspaceSafe();
  const { items, pendingCount, error, loading, refresh } = usePendingOperations(
    workspace?.activeWorkspace?.id ?? null,
  );
  // FIX-P1-PWA-RECEIPT-CONSUMERS: same canonical access as TedChat — the
  // optional hook never throws outside AppStateProvider (null = no financial
  // refresh, never an invented reconciliation).
  const optionalReconcile = useOptionalAppState()?.reconcileMutation;

  const handleUndo = async () => {
    setUndoLoading(true);
    setUndoError(null);
    setUndoResult(null);
    try {
      const res = await undoLastAction();
      setUndoResult(`Desfeito: ${res.undone.operation} (${res.undone.reversal})`);
      // The undo itself is authoritative — refresh the listing reflection.
      notifyPendingOperationsChanged();
      if (optionalReconcile) {
        try {
          // Real receipt wins (mutationId enables dedup); without one the
          // reversal kind applies — never an invented mutationId. A refresh
          // failure surfaces as stale in app-state; the undo result stays
          // (never rolled back).
          await optionalReconcile(
            res.receipt
              ? { receipt: res.receipt }
              : { mutationKind: res.undone.reversal },
          );
        } catch {
          // Reconciliation failure is signaled stale by the provider.
        }
      }
    } catch (error) {
      setUndoError(error instanceof ApiError || error instanceof Error ? error.message : "Falha ao desfazer");
    } finally {
      setUndoLoading(false);
    }
  };

  return (
    <div className={embedded ? "flex flex-1 flex-col bg-bg" : "flex min-h-dvh flex-col bg-bg"}>
      {!embedded && (
        <>
          <StatusBar />
          <PageHeader title="Aprovações" />
        </>
      )}

      <main className={embedded ? "flex flex-1 flex-col gap-3 px-5 pt-4 sm:px-8 lg:px-12" : "flex flex-1 flex-col gap-3 px-5 pb-[calc(9rem+env(safe-area-inset-bottom))] sm:px-8 lg:px-12 lg:pb-8"}>
        {/* Honest error state: the listing is authoritative — when it cannot
            be loaded we say so and offer a retry; never stale, never invented. */}
        {error && (
          <section
            data-testid="pending-list-error"
            className="flex flex-col items-center gap-3 rounded-[14px] bg-danger-tint px-4 py-5 text-center"
            role="alert"
          >
            <p className="text-[13px] font-semibold text-danger">{PENDING_LIST_ERROR}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-[12px] border border-border-subtle bg-surface-1 px-4 py-2 text-[12px] font-bold text-text-primary shadow-xs transition-all hover:bg-surface-2 active:scale-[0.99]"
            >
              Tentar novamente
            </button>
          </section>
        )}

        {/* First load (nothing known yet): quiet skeleton, no fake count. */}
        {!error && items === null && loading && (
          <section aria-label="Carregando aprovações" className="flex flex-col gap-2 py-4">
            <div className="h-16 animate-pulse rounded-[14px] bg-surface-2" />
            <div className="h-16 animate-pulse rounded-[14px] bg-surface-2" />
          </section>
        )}

        {/* Neutral state (no active workspace or between loads): the
            informational TED-only guidance. */}
        {!error && items === null && !loading && (
          <section
            data-testid="pending-v2-info"
            className="flex flex-1 flex-col items-center justify-center py-16 text-center"
          >
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-text-muted shadow-xs">
              <ShieldCheck size={26} strokeWidth={2} />
            </div>
            <h2 className="text-[15px] font-bold text-text-primary">Aprovações são concluídas no TED</h2>
            <p className="mt-1 max-w-[300px] text-[12px] leading-relaxed text-text-muted">
              Quando uma ação exigir confirmação, revise e decida no cartão seguro da conversa com o TED.
            </p>
          </section>
        )}

        {/* Known listing (possibly empty). */}
        {items !== null && (
          items.length === 0 ? (
            <section
              data-testid="pending-v2-info"
              className="flex flex-1 flex-col items-center justify-center py-16 text-center"
            >
              <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-text-muted shadow-xs">
                <ShieldCheck size={26} strokeWidth={2} />
              </div>
              <h2 className="text-[15px] font-bold text-text-primary">Aprovações são concluídas no TED</h2>
              <p className="mt-1 max-w-[300px] text-[12px] leading-relaxed text-text-muted">
                Quando uma ação exigir confirmação, revise e decida no cartão seguro da conversa com o TED.
              </p>
            </section>
          ) : (
            <>
              <section className="flex items-center justify-between py-1" aria-live="polite">
                <h2 className="text-[13px] font-bold text-text-primary" data-testid="pending-list-count">
                  {pendingCount === 1
                    ? "1 aprovação pendente"
                    : `${pendingCount} aprovações pendentes`}
                </h2>
                <OpenInTedButton />
              </section>

              <ul className="flex flex-col gap-2" data-testid="pending-list">
                {items.map((item) => (
                  <li
                    key={item.id}
                    data-testid="pending-list-item"
                    className="flex flex-col gap-2 rounded-[14px] border border-border-subtle bg-surface-1 px-4 py-3 shadow-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[13px] font-bold text-text-primary">
                        {item.description ?? "Operação financeira"}
                      </span>
                      <span className="whitespace-nowrap font-mono text-[13px] font-semibold tabular-nums text-text-primary">
                        {item.amountCents !== undefined ? formatCentsToBRL(item.amountCents) : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
                      <span data-testid="pending-item-status">
                        {describePendingOperationStatus(item.status)}
                      </span>
                      {item.date && <span>{formatDateToBR(item.date)}</span>}
                    </div>
                    <OpenInTedButton label={item.id} />
                  </li>
                ))}
              </ul>

              <p className="px-1 text-[11px] leading-relaxed text-text-muted">
                As decisões (aprovar ou cancelar) acontecem na conversa com o TED.
              </p>
            </>
          )
        )}

        <section className="flex flex-col gap-2" aria-label="Desfazer última ação">
          <button
            type="button"
            onClick={() => void handleUndo()}
            disabled={undoLoading}
            data-testid="undo-last-action"
            className="flex w-full items-center justify-center gap-2 rounded-[14px] border border-border-subtle bg-surface-1 px-4 py-3 text-[13px] font-bold text-text-primary shadow-xs transition-all hover:bg-surface-2 active:scale-[0.99] disabled:opacity-60"
          >
            <Undo2 size={16} />
            {undoLoading ? "Desfazendo…" : "Desfazer última ação"}
          </button>
          {undoResult && (
            <div className="rounded-[12px] bg-primary-tint px-4 py-2.5 text-[12px] font-bold text-primary" data-testid="undo-success">
              ✓ {undoResult}
            </div>
          )}
          {undoError && (
            <div className="rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger" data-testid="undo-error">
              ⚠ {undoError}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
