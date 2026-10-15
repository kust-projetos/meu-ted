"use client";

import { useRef, useState } from "react";
import {
  decideUndoProposal,
  formatCentsToBRL,
  formatDateToBR,
  type UndoDecision,
} from "@/lib/api/agent-client";

/**
 * FIX-P1-UX #172: display-safe projection of the fixed undo target — the
 * human-reviewable slice (kind/value/description/account/date) of the exact
 * mutation the confirm would reverse. Carried as data, never parsed from
 * model text; the confirm still goes exclusively through the card RPC.
 */
export type TedUndoTarget = Readonly<{
  kind?: string;
  description?: string;
  amountCents?: number;
  accountLabel?: string;
  occurredOn?: string;
}>;

export type TedUndoProposal = Readonly<{
  requestId: string;
  status: "proposed" | "executing";
  expiresAt: string;
  /** Absent on legacy payloads — the card degrades to the summary shape. */
  target?: TedUndoTarget;
}>;

interface TedUndoCardProps {
  proposal: TedUndoProposal;
  workspaceId: string;
  /** Receives the authoritative decision (confirmed/cancelled) for chat-level refresh. */
  onResolved?: (decision: UndoDecision) => void;
}

const isNonBlank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * FIX-P1-UX #172: fail-closed display gate for the fixed target. Confirm may
 * only be offered next to something human-reviewable: a blank description
 * authorizes nothing, and a non-finite amount authorizes nothing. Absent
 * target (legacy payload) is NOT blocked here — it renders the long-standing
 * summary shape with the same RPC-only confirm.
 */
const isDisplaySafeUndoTarget = (target: TedUndoTarget | undefined): boolean => {
  if (target === undefined) return true;
  if (!isNonBlank(target.description)) return false;
  if (target.amountCents !== undefined && !Number.isFinite(target.amountCents)) return false;
  return true;
};

/** Terminal server verdicts: the proposal is decided elsewhere — no buttons, no fake success. */
const TERMINAL_UNDO_CODES: ReadonlySet<string> = new Set(["undo.terminal"]);
const DECISION_ERROR = "Não foi possível registrar a decisão. Tente novamente.";
const TERMINAL_UNDO_MESSAGE = "Esta proposta já foi decidida — nada mais a fazer aqui.";
const TARGET_INCOMPLETE_MESSAGE =
  "Não é possível confirmar — os dados do alvo estão incompletos. Cancele ou peça um novo resumo ao TED.";
/** In-flight server verdicts: parked with no buttons until the server converges. */
const PENDING_UNDO_CODES: ReadonlySet<string> = new Set(["undo.executing"]);

const undoErrorCode = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/** pt-BR short date-time for the expiry line; unknown shapes pass through raw. */
function formatExpiry(expiresAt: string): string {
  const time = Date.parse(expiresAt);
  if (Number.isNaN(time)) return expiresAt;
  return new Date(time).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TedUndoCard({ proposal, workspaceId, onResolved }: TedUndoCardProps) {
  const [outcome, setOutcome] = useState<"proposed" | "confirmed" | "cancelled" | "terminal" | "pending">("proposed");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local single-decision guard: once the server confirms a terminal state,
  // this card never issues another RPC (server CAS is the authority; this
  // only stops a duplicate click from leaving the browser).
  const decidedRef = useRef(false);
  const inFlightRef = useRef(false);

  const decide = async (decision: "confirm" | "cancel") => {
    if (decidedRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      // The ONLY path that decides: explicit card button → authenticated RPC
      // naming the proposal (requestId) and the decision. Model text is never
      // parsed or acted on here.
      const result = await decideUndoProposal(workspaceId, proposal.requestId, decision);
      decidedRef.current = true;
      setOutcome(result.status === "confirmed" ? "confirmed" : "cancelled");
      onResolved?.(result);
    } catch (e) {
      const code = undoErrorCode(e);
      if (code !== undefined && TERMINAL_UNDO_CODES.has(code)) {
        // The server already decided this proposal (409 undo.terminal): end
        // the card honestly — no buttons, no invented success, no retry.
        decidedRef.current = true;
        setOutcome("terminal");
      } else if (code !== undefined && PENDING_UNDO_CODES.has(code)) {
        // The server owns the effect (undo.executing): park the card with no
        // buttons until the authoritative state converges via rehydration.
        decidedRef.current = true;
        setOutcome("pending");
      } else {
        setError(e instanceof Error && e.message ? e.message : DECISION_ERROR);
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleConfirm = () => void decide("confirm");
  const handleCancel = () => void decide("cancel");

  if (outcome === "confirmed") {
    return (
      <div
        role="status"
        data-testid="ted-undo-confirmed"
        className="my-2 rounded-[14px] border border-border-subtle bg-surface-2 p-3 text-xs text-text-secondary"
      >
        ✅ Ação desfeita.
      </div>
    );
  }

  if (outcome === "cancelled") {
    return (
      <div
        role="status"
        data-testid="ted-undo-cancelled"
        className="my-2 rounded-[14px] border border-border-subtle bg-surface-2 p-3 text-xs text-text-secondary"
      >
        ❌ Desfazer cancelado — nada foi alterado.
      </div>
    );
  }

  if (outcome === "terminal") {
    return (
      <div
        role="status"
        data-testid="ted-undo-terminal"
        className="my-2 rounded-[14px] border border-border-subtle bg-surface-2 p-3 text-xs text-text-secondary"
      >
        {TERMINAL_UNDO_MESSAGE}
      </div>
    );
  }

  // debt-undo-proposal-rehydration: a rehydrated `executing` proposal is
  // truthfully in-flight (confirm claim persisted, effect owned by the
  // server). The card shows the pending state with NO buttons and issues NO
  // RPC — rehydration never decides; a retry converges via the card's own
  // confirm only while `proposed`.
  if (outcome === "pending" || (proposal.status === "executing" && outcome === "proposed")) {
    return (
      <div
        role="status"
        data-testid="ted-undo-pending"
        className="my-2 rounded-[14px] border border-border-subtle bg-surface-2 p-3 text-xs text-text-secondary"
      >
        ⏳ Desfazer em andamento — aguarde a confirmação do servidor.
      </div>
    );
  }

  // FIX-P1-UX #172: a projected target that is not display-safe blocks
  // Confirm (it moves money with nothing human-reviewable) while Cancel —
  // which moves nothing — stays available.
  const targetDisplaySafe = isDisplaySafeUndoTarget(proposal.target);
  const target = targetDisplaySafe ? proposal.target : undefined;

  return (
    <div
      data-testid="ted-undo-card"
      className="my-2 rounded-[16px] border border-warning/30 bg-warning-tint p-3.5 text-xs shadow-xs"
    >
      <div className="font-bold text-warning">↩️ Desfazer última ação</div>
      {target ? (
        <dl className="mt-2 space-y-1 text-text-primary">
          {isNonBlank(target.kind) && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Tipo</dt>
              <dd className="font-semibold">{target.kind}</dd>
            </div>
          )}
          {isNonBlank(target.description) && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Descrição</dt>
              <dd className="font-semibold">{target.description}</dd>
            </div>
          )}
          {typeof target.amountCents === "number" && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Valor</dt>
              <dd className="font-bold">{formatCentsToBRL(target.amountCents)}</dd>
            </div>
          )}
          {isNonBlank(target.accountLabel) && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Conta</dt>
              <dd className="font-semibold">{target.accountLabel}</dd>
            </div>
          )}
          {isNonBlank(target.occurredOn) && (
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Data</dt>
              <dd className="font-semibold">{formatDateToBR(target.occurredOn)}</dd>
            </div>
          )}
        </dl>
      ) : (
        <div className="mt-1 text-sm font-semibold text-text-primary">
          Desfazer a última ação registrada.
        </div>
      )}
      <div className="mt-0.5 text-text-muted">
        Confira antes de confirmar — esta ação não pode ser refeita automaticamente. Válido até{" "}
        {formatExpiry(proposal.expiresAt)}.
      </div>

      {!targetDisplaySafe && (
        <div role="alert" className="mt-1 font-semibold text-danger">
          {TARGET_INCOMPLETE_MESSAGE}
        </div>
      )}

      {error && (
        <div role="alert" className="mt-1 font-semibold text-danger">
          {error}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        {targetDisplaySafe && (
          <button
            type="button"
            disabled={loading}
            onClick={handleConfirm}
            className="rounded-[10px] bg-primary px-3.5 py-2 font-bold text-white shadow-xs transition-all hover:bg-primary-hover active:scale-95 disabled:opacity-50"
          >
            {loading ? "Processando…" : "Confirmar desfazer"}
          </button>
        )}
        <button
          type="button"
          disabled={loading}
          onClick={handleCancel}
          className="rounded-[10px] border border-border-subtle bg-surface-1 px-3.5 py-2 font-bold text-text-secondary transition-all hover:bg-surface-2 active:scale-95 disabled:opacity-50"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
