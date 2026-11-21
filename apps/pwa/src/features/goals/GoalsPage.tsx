"use client";

import { useEffect, useState } from "react";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import BottomSheet from "@/components/BottomSheet";
import { WriteErrorBanner } from "@/components/WriteErrorBanner";
import { StaleBanner } from "@/components/StaleBanner";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useAppState } from "@/lib/state/app-state-context";
import { useFormDirtySafe } from "@/lib/unsaved-changes";
import type { Goal } from "@/lib/state/types";
import { Plus, Target, Check, CheckCircle2, Calendar } from "lucide-react";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatInputBRL(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  const padded = digits.padStart(3, "0");
  const intPart = padded.slice(0, -2);
  const decPart = padded.slice(-2);
  return `${parseInt(intPart, 10).toLocaleString("pt-BR")},${decPart}`;
}

function parseBRLToCents(value: string): number {
  const cleaned = value.replace(/[.\s]/g, "").replace(",", ".");
  return Math.round(parseFloat(cleaned) * 100) || 0;
}

function NewGoalSheet({
  open,
  onClose,
  onSave,
  initialType,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (input: {
    name: string;
    goalType: "savings" | "purchase" | "debt_payoff" | "emergency_fund";
    targetAmountCents: number;
    startDate: string;
  }) => void;
  initialType?: "debt_payoff";
}) {
  const { markDirty, markClean } = useFormDirtySafe();
  const [name, setName] = useState("");
  const [type, setType] = useState<"savings" | "purchase" | "debt_payoff" | "emergency_fund">("savings");
  const [targetStr, setTargetStr] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialType) setType(initialType);
  }, [initialType]);

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName("");
      setTargetStr("");
      setType("savings");
      markClean();
    }
  }, [open, markClean]);

  function handleClose() {
    markClean();
    onClose();
  }

  function handleSave() {
    if (!name.trim()) return;
    const targetAmountCents = parseBRLToCents(targetStr);
    if (targetAmountCents <= 0) return;
    onSave({
      name: name.trim(),
      goalType: type,
      targetAmountCents,
      startDate: new Date().toISOString().slice(0, 10),
    });
    markClean();
    setName("");
    setTargetStr("");
    onClose();
  }

  const canSave = Boolean(name.trim()) && parseBRLToCents(targetStr) > 0;

  const types = [
    { value: "savings" as const, label: "Poupança" },
    { value: "purchase" as const, label: "Compra" },
    { value: "debt_payoff" as const, label: "Quitar dívida" },
    { value: "emergency_fund" as const, label: "Reserva" },
  ];

  return (
    <BottomSheet open={open} onClose={handleClose} title="Nova meta">
      <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Nome
          </label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Ex: Viagem, Carro novo..."
            className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary" />
        </fieldset>
        {!initialType && (
          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Tipo</label>
            <div className="flex flex-wrap gap-2">
              {types.map((t) => (
                <button key={t.value} type="button" onClick={() => setType(t.value)}
                  className={`rounded-full px-3.5 py-2 text-[12px] font-bold transition-all ${type === t.value ? "bg-primary text-white shadow-xs" : "bg-surface-2 text-text-secondary hover:bg-surface-3"}`}>
                  {t.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Valor alvo (R$)</label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[16px] font-bold text-text-muted">R$</span>
            <input type="text" inputMode="numeric" value={targetStr}
              onChange={(e) => { const raw = e.target.value.replace(/\D/g, ""); if (raw.length > 12) return; setTargetStr(formatInputBRL(raw)); }}
              placeholder="0,00"
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[16px] font-bold text-text-primary outline-none focus:border-primary" />
          </div>
        </fieldset>
        <button type="button" onClick={handleSave} disabled={!canSave}
          className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50">
          Salvar meta
        </button>
      </div>
    </BottomSheet>
  );
}

function ContributeSheet({
  open,
  goal,
  onClose,
  onContribute,
}: {
  open: boolean;
  goal: Goal | null;
  onClose: () => void;
  onContribute: (id: string, amountCents: number) => void;
}) {
  const { markDirty, markClean } = useFormDirtySafe();
  const [amountStr, setAmountStr] = useState("");

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAmountStr("");
      markClean();
    }
  }, [open, markClean]);

  function handleClose() {
    markClean();
    onClose();
  }

  function handleSave() {
    if (!goal) return;
    const amountCents = parseBRLToCents(amountStr);
    if (amountCents <= 0) return;
    onContribute(goal.id, amountCents);
    markClean();
    setAmountStr("");
    onClose();
  }

  const canSave = Boolean(goal) && parseBRLToCents(amountStr) > 0;

  return (
    <BottomSheet open={open} onClose={handleClose} title="Adicionar valor">
      <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
        {goal && (
          <div className="text-center rounded-[16px] border border-border-subtle bg-surface-2 p-3.5">
            <div className="text-[14px] font-bold text-text-primary">{goal.name}</div>
            <div className="mt-0.5 text-[11px] font-medium text-text-muted">
              {formatPct(Math.min((goal.currentAmountCents / goal.targetAmountCents) * 100, 100))} concluído
            </div>
          </div>
        )}
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Valor (R$)</label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[16px] font-bold text-text-muted">R$</span>
            <input type="text" inputMode="numeric" value={amountStr}
              onChange={(e) => { const raw = e.target.value.replace(/\D/g, ""); if (raw.length > 12) return; setAmountStr(formatInputBRL(raw)); }}
              placeholder="0,00"
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[16px] font-bold text-text-primary outline-none focus:border-primary" />
          </div>
        </fieldset>
        <button type="button" onClick={handleSave} disabled={!canSave}
          className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50">
          Adicionar
        </button>
      </div>
    </BottomSheet>
  );
}

function GoalDetailSheet({
  goal,
  open,
  onClose,
  onEdit,
}: {
  goal: Goal | null;
  open: boolean;
  onClose: () => void;
  onEdit: (id: string, input: { name?: string; targetAmountCents?: number }) => void | Promise<void>;
}) {
  const { markDirty, markClean } = useFormDirtySafe();
  const [editMode, setEditMode] = useState(false);
  const [name, setName] = useState("");
  const [targetDisplay, setTargetDisplay] = useState("");

  useEffect(() => {
    if (goal && open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(goal.name);
      setTargetDisplay(formatInputBRL(String(goal.targetAmountCents)));
      setEditMode(false);
      markClean();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, open]);

  if (!goal) return null;

  const pct = goal.targetAmountCents > 0 ? Math.min((goal.currentAmountCents / goal.targetAmountCents) * 100, 100) : 0;

  function handleClose() {
    markClean();
    onClose();
  }

  async function handleSave() {
    if (!goal) return;
    const targetAmountCents = parseBRLToCents(targetDisplay);
    if (targetAmountCents <= 0) return;
    try {
      await onEdit(goal.id, { name: name.trim() || undefined, targetAmountCents });
      markClean();
      onClose();
    } catch {
      // Save failed: keep dirty.
    }
  }

  return (
    <BottomSheet open={open} onClose={handleClose} title={editMode ? "Editar meta" : "Detalhes da meta"}>
      {editMode ? (
        <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Nome</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary" />
          </fieldset>
          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Valor alvo (R$)</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[16px] font-bold text-text-muted">R$</span>
              <input type="text" inputMode="numeric" value={targetDisplay}
                onChange={(e) => { const raw = e.target.value.replace(/\D/g, ""); if (raw.length > 12) return; setTargetDisplay(formatInputBRL(raw)); }}
                placeholder="0,00"
                className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[16px] font-bold text-text-primary outline-none focus:border-primary" />
            </div>
          </fieldset>
          <button type="button" onClick={handleSave}
            disabled={parseBRLToCents(targetDisplay) <= 0}
            className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50">
            Salvar alterações
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-[16px] border border-border-subtle bg-surface-2 p-3.5">
            <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[11px] bg-primary-tint text-primary shadow-xs">
              <Target size={18} strokeWidth={2.2} />
            </div>
            <div>
              <div className="text-[14px] font-bold text-text-primary">{goal.name}</div>
              <div className="text-[11px] font-medium text-text-muted">
                {goal.goalType === "emergency_fund" ? "Reserva de emergência"
                  : goal.goalType === "savings" ? "Poupança"
                  : goal.goalType === "debt_payoff" ? "Quitação de dívida"
                  : goal.goalType === "purchase" ? "Compra planejada" : "Meta"}
              </div>
            </div>
          </div>
          <div className="h-2.5 rounded-full bg-surface-2 overflow-hidden">
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: "linear-gradient(90deg, #0E8C5A, #2FA56F)" }} />
          </div>
          <div className="flex justify-between text-[12px] font-medium">
            <span className="font-mono tabular-nums font-bold text-text-primary">{formatBRL(goal.currentAmountCents)}</span>
            <span className="font-mono tabular-nums text-text-muted">de {formatBRL(goal.targetAmountCents)}</span>
          </div>
          <div className="text-center font-mono tabular-nums text-[18px] font-bold text-primary">{formatPct(pct)} concluído</div>
          <button type="button" onClick={() => setEditMode(true)}
            className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3.5 text-center text-[14px] font-bold text-text-primary hover:bg-surface-3 transition-colors">
            Editar
          </button>
        </div>
      )}
    </BottomSheet>
  );
}

export default function GoalsPage({ embedded = false }: { embedded?: boolean }) {
  const { goals, debts, loading, error, writeError, clearWriteError, retryWriteError, createGoal, contributeToGoal, cancelGoal, updateGoal } = useAppState();
  const [tab, setTab] = useState<"goals" | "debts">("goals");
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<"goal" | "debt" | null>(null);
  const [chooseOpen, setChooseOpen] = useState(false);
  const [contributeGoal, setContributeGoal] = useState<Goal | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<Goal | null>(null);
  const [detailGoal, setDetailGoal] = useState<Goal | null>(null);

  if (loading) {
    return (
      <div className={embedded ? "flex flex-1 flex-col bg-bg" : "flex min-h-dvh flex-col bg-bg"}>
        {!embedded && <StatusBar />}
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-border-subtle border-t-primary" />
            <span className="text-[13px] font-semibold text-text-muted">Carregando...</span>
          </div>
        </div>
      </div>
    );
  }

  const goalPcts = goals.map((g) => {
    const pct = g.targetAmountCents > 0
      ? Math.min((g.currentAmountCents / g.targetAmountCents) * 100, 100) : 0;
    return { ...g, pct };
  });

  const debtGoals = goals.filter((g) => g.goalType === "debt_payoff");
  const visibleDebts = debts.length > 0 || debtGoals.length > 0;

  return (
    <div className={embedded ? "flex flex-1 flex-col bg-bg" : "flex min-h-dvh flex-col bg-bg"}>
      {!embedded && <StatusBar />}
      <main className={embedded ? "flex flex-1 flex-col pt-4" : "flex flex-1 flex-col pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8"}>
        {!embedded && (
          <PageHeader
            title="Metas & Dívidas"
            action={
              <button type="button" onClick={() => setChooseOpen(true)}
                className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[12px] font-bold text-white shadow-sm hover:bg-primary-hover active:scale-95 transition-all">
                <Plus size={15} strokeWidth={2.4} />
                Nova
              </button>
            }
          />
        )}

        {error && (
          <div className="mx-5 mb-3 rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger">⚠ {error}</div>
        )}

        <WriteErrorBanner message={writeError} onDismiss={clearWriteError} onRetry={retryWriteError ?? undefined} />

        <StaleBanner domains={["goals"]} />

        <div className="px-5 sm:px-8 lg:px-12">
          <div className="mb-4 flex items-center gap-2">
            <div className="flex flex-1 gap-1.5 rounded-[14px] bg-surface-2 p-1 border border-border-subtle">
              <button onClick={() => setTab("goals")}
                className={`flex-1 rounded-[10px] py-2.5 text-center text-[13px] font-bold transition-all ${tab === "goals" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}>
                Metas
              </button>
              <button onClick={() => setTab("debts")}
                className={`flex-1 rounded-[10px] py-2.5 text-center text-[13px] font-bold transition-all ${tab === "debts" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}>
                Dívidas
              </button>
            </div>
            {embedded && (
              <button type="button" onClick={() => setChooseOpen(true)}
                className="flex flex-none items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-[12px] font-bold text-white shadow-sm hover:bg-primary-hover active:scale-95 transition-all">
                <Plus size={15} strokeWidth={2.4} />
                Nova
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 px-5 sm:px-8 lg:px-12">
          {tab === "goals" ? (
            goalPcts.length === 0 ? (
              <div className="py-[50px] text-center text-text-muted">
                <div className="text-[14px] font-semibold">Nenhuma meta</div>
                <div className="mt-1 text-[12px]">Crie uma meta financeira para começar.</div>
              </div>
            ) : (
              goalPcts.map((g) => (
                <div key={g.id} className="rounded-[18px] border border-border-subtle bg-surface-1 px-4 py-4 shadow-card hover:bg-surface-2/40 transition-colors">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`Ver detalhes de ${g.name}`}
                    onClick={() => setDetailGoal(g)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDetailGoal(g);
                      }
                    }}
                    className="cursor-pointer"
                  >
                    <div className="mb-[10px] flex items-center justify-between">
                      <div className="flex items-center gap-[9px]">
                        <div className="flex h-[36px] w-[36px] items-center justify-center rounded-[11px] bg-primary-tint text-primary shadow-xs">
                          <Target size={18} strokeWidth={2.2} />
                        </div>
                        <div>
                          <div className="text-[14px] font-bold text-text-primary">{g.name}</div>
                          <div className="text-[11px] font-medium text-text-muted">
                            {g.goalType === "emergency_fund" ? "Reserva de emergência"
                              : g.goalType === "savings" ? "Poupança"
                              : g.goalType === "debt_payoff" ? "Quitação de dívida"
                              : g.goalType === "purchase" ? "Compra planejada" : "Meta"}
                          </div>
                        </div>
                      </div>
                      <span className="font-mono tabular-nums text-[14px] font-bold text-primary">{formatPct(g.pct)}</span>
                    </div>
                    <div className="mb-[6px] h-2 rounded-full bg-surface-2 overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${g.pct}%`, background: "linear-gradient(90deg, #0E8C5A, #2FA56F)" }} />
                    </div>
                    <div className="mb-2 text-[11px] font-medium text-text-muted">{formatPct(g.pct)} concluído</div>
                    {g.pct >= 100 && (
                      <div className="mb-2 flex items-center gap-2 rounded-[12px] bg-success-tint px-3 py-2">
                        <CheckCircle2 size={18} strokeWidth={2.2} role="img" aria-label="Meta batida" className="flex-none text-success" />
                        <span className="text-[12px] font-bold text-success">Meta batida!</span>
                      </div>
                    )}
                    <div className="mb-3 flex justify-between text-[12px] font-medium text-text-secondary">
                      <span className="font-mono tabular-nums font-bold text-text-primary">{formatBRL(g.currentAmountCents)}</span>
                      <span>de <span className="font-mono tabular-nums">{formatBRL(g.targetAmountCents)}</span></span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setContributeGoal(g)}
                      className="flex-1 rounded-[12px] bg-primary py-2.5 text-center text-[12px] font-bold text-white shadow-xs hover:bg-primary-hover active:scale-[0.98] transition-all">
                      Adicionar
                    </button>
                    <button type="button" onClick={() => setConfirmCancel(g)}
                      className="flex-1 rounded-[12px] bg-danger-tint border border-danger/20 py-2.5 text-center text-[12px] font-bold text-danger hover:bg-danger-tint/80 active:scale-[0.98] transition-all">
                      Cancelar
                    </button>
                  </div>
                </div>
              ))
            )
          ) : !visibleDebts ? (
            <div className="py-[50px] text-center text-text-muted">
              <div className="text-[14px] font-semibold">Nenhuma dívida</div>
              <div className="mt-1 text-[12px]">
                Crie uma dívida pelo botão Nova.
              </div>
            </div>
          ) : (
            <>
            {debts.map((d) => {
              const remaining = d.totalAmountCents - d.paidAmountCents;
              const pct = d.totalAmountCents > 0
                ? Math.min((d.paidAmountCents / d.totalAmountCents) * 100, 100) : 0;

              return (
                <div key={d.id} className="overflow-hidden rounded-[18px] border border-border-subtle bg-surface-1 shadow-card">
                  <div className="px-4 pb-2 pt-4">
                    <div className="mb-[14px] flex items-start gap-2.5">
                      <div className="flex h-[40px] w-[40px] flex-none items-center justify-center rounded-[12px] bg-danger-tint text-danger shadow-xs">
                        <Target size={20} strokeWidth={2.2} />
                      </div>
                      <div className="flex-1">
                        <div className="text-[15px] font-bold text-text-primary">{d.name}</div>
                        <div className="text-[11px] font-medium text-text-muted">
                          {d.interestRate > 0 ? `${(d.interestRate * 100).toFixed(1)}% a.m.` : "Sem juros"} · {d.installmentsPaid}/{d.installmentsTotal} parcelas
                        </div>
                      </div>
                    </div>

                    <div className="mb-[14px] grid grid-cols-3 gap-2">
                      <div className="rounded-[12px] bg-surface-2 px-3 py-2.5 border border-border-subtle">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Pago</div>
                        <div className="font-mono tabular-nums text-[13px] font-bold text-primary">{formatBRL(d.paidAmountCents)}</div>
                      </div>
                      <div className="rounded-[12px] bg-surface-2 px-3 py-2.5 border border-border-subtle">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Restante</div>
                        <div className="font-mono tabular-nums text-[13px] font-bold text-danger">{formatBRL(remaining)}</div>
                      </div>
                      <div className="rounded-[12px] bg-surface-2 px-3 py-2.5 border border-border-subtle">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Total</div>
                        <div className="font-mono tabular-nums text-[13px] font-bold text-text-primary">{formatBRL(d.totalAmountCents)}</div>
                      </div>
                    </div>

                    <div className="mb-[6px] h-[7px] rounded-full bg-surface-2 overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: "linear-gradient(90deg, #0E8C5A, #2FA56F)" }} />
                    </div>
                    <div className="mb-3.5 text-[11px] font-medium text-text-muted">{formatPct(pct)} quitado</div>

                    {/* Próxima parcela */}
                    {d.installmentsTotal - d.installmentsPaid >= 1 && (() => {
                      const monthlyAmount = Math.round(d.totalAmountCents / d.installmentsTotal);
                      const dueDate = new Date();
                      dueDate.setMonth(dueDate.getMonth() + 1);
                      const monthLabel = dueDate.toLocaleDateString("pt-BR", { month: "long" });
                      return (
                        <div className="mb-3.5 flex items-center gap-3 rounded-[14px] border border-warning/30 bg-warning-tint px-3.5 py-3">
                          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-warning/20 text-warning">
                            <Calendar size={18} strokeWidth={2.2} />
                          </div>
                          <div className="flex-1">
                            <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-warning">Próxima parcela</div>
                            <div className="text-[13px] font-bold text-text-primary">{monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1)} · <span className="font-mono tabular-nums">{formatBRL(monthlyAmount)}</span></div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Dot grid */}
                  <div className="border-t border-border-subtle px-4 pb-3 pt-3">
                    <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-text-muted">Todas as parcelas</div>
                    <div className="flex flex-wrap gap-[6px]">
                      {Array.from({ length: d.installmentsTotal }, (_, i) => {
                        const idx = i + 1;
                        const isPaid = idx <= d.installmentsPaid;
                        const isCurrent = idx === d.installmentsPaid + 1;
                        return (
                          <div key={idx}
                            className="flex h-[28px] w-[28px] flex-none items-center justify-center rounded-[8px] text-[10px] font-bold shadow-2xs"
                            style={isPaid ? { background: "var(--color-primary)", color: "#fff" } : isCurrent ? { background: "var(--color-warning-tint)", border: "1.5px solid var(--color-warning)", color: "var(--color-warning)" } : { background: "var(--surface-2)", color: "var(--color-text-muted)" }}>
                            {isPaid ? (
                              <Check size={13} strokeWidth={3} />
                            ) : isCurrent ? <span className="block h-[7px] w-[7px] rounded-full bg-warning" />
                            : <span className="font-mono">{idx}</span>}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-3 text-[10px] font-semibold text-text-muted">
                      <span className="flex items-center gap-1.5"><span className="h-[10px] w-[10px] rounded-[3px] bg-primary" /> Pago</span>
                      <span className="flex items-center gap-1.5"><span className="h-[10px] w-[10px] rounded-[3px] bg-warning-tint border border-warning" /> Atual</span>
                      <span className="flex items-center gap-1.5"><span className="h-[10px] w-[10px] rounded-[3px] bg-surface-2 border border-border-subtle" /> Pendente</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {debtGoals.map((g) => {
              const pct = g.targetAmountCents > 0
                ? Math.min((g.currentAmountCents / g.targetAmountCents) * 100, 100) : 0;
              return (
                <div key={g.id} className="rounded-[18px] border border-border-subtle bg-surface-1 px-4 py-4 shadow-card hover:bg-surface-2/40 transition-colors">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`Ver detalhes de ${g.name}`}
                    onClick={() => setDetailGoal(g)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDetailGoal(g);
                      }
                    }}
                    className="cursor-pointer"
                  >
                    <div className="mb-[10px] flex items-center gap-[9px]">
                      <div className="flex h-[36px] w-[36px] items-center justify-center rounded-[11px] bg-danger-tint text-danger shadow-xs">
                        <Target size={18} strokeWidth={2.2} />
                      </div>
                      <div>
                        <div className="text-[14px] font-bold text-text-primary">{g.name}</div>
                        <div className="text-[11px] font-medium text-text-muted">Quitação de dívida</div>
                      </div>
                    </div>
                    <div className="mb-[6px] h-2 rounded-full bg-surface-2 overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: "linear-gradient(90deg, #0E8C5A, #2FA56F)" }} />
                    </div>
                    <div className="flex justify-between text-[12px] font-medium">
                      <span className="font-mono tabular-nums font-bold text-text-primary">{formatBRL(g.currentAmountCents)}</span>
                      <span className="font-mono tabular-nums text-text-muted">de {formatBRL(g.targetAmountCents)}</span>
                    </div>
                  </div>
                  <div className="mt-3 text-[11px] font-medium text-text-muted">{formatPct(pct)} quitado</div>
                  <div className="mt-3 flex gap-2">
                    <button type="button"
                      onClick={(e) => { e.stopPropagation(); setContributeGoal(g); }}
                      className="flex-1 rounded-[12px] bg-primary py-2.5 text-center text-[12px] font-bold text-white shadow-xs hover:bg-primary-hover active:scale-[0.98] transition-all">
                      Adicionar
                    </button>
                    <button type="button"
                      onClick={(e) => { e.stopPropagation(); setConfirmCancel(g); }}
                      className="flex-1 rounded-[12px] bg-danger-tint border border-danger/20 py-2.5 text-center text-[12px] font-bold text-danger hover:bg-danger-tint/80 active:scale-[0.98] transition-all">
                      Cancelar
                    </button>
                  </div>
                </div>
              );
            })}
            </>
          )}
        </div>
      </main>

      {/* Chooser for Nova */}
      <BottomSheet open={chooseOpen} onClose={() => setChooseOpen(false)} title="Nova entrada">
        <div className="flex flex-col gap-4">
          <button type="button" onClick={() => { setChooseOpen(false); setCreateType("goal"); setCreateOpen(true); }}
            className="w-full rounded-[16px] border border-border-subtle bg-surface-2 p-5 text-center transition-all hover:border-primary hover:bg-surface-3 shadow-xs">
            <div className="text-[16px] font-bold text-text-primary">Meta financeira</div>
            <div className="mt-1 text-[12px] text-text-muted">Defina uma meta de poupança, reserva ou compra.</div>
          </button>
          <button type="button" onClick={() => { setChooseOpen(false); setCreateType("debt"); setCreateOpen(true); }}
            className="w-full rounded-[16px] border border-border-subtle bg-surface-2 p-5 text-center transition-all hover:border-primary hover:bg-surface-3 shadow-xs">
            <div className="text-[16px] font-bold text-text-primary">Dívida</div>
            <div className="mt-1 text-[12px] text-text-muted">Registre uma dívida para acompanhar o pagamento.</div>
          </button>
        </div>
      </BottomSheet>

      <NewGoalSheet
        open={createOpen}
        onClose={() => { setCreateOpen(false); setCreateType(null); }}
        onSave={createGoal}
        initialType={createType === "debt" ? "debt_payoff" : undefined}
      />

      <ContributeSheet
        open={contributeGoal !== null}
        goal={contributeGoal}
        onClose={() => setContributeGoal(null)}
        onContribute={(id, amountCents) =>
          contributeToGoal(id, { amountCents })
        }
      />

      <ConfirmActionDialog
        open={confirmCancel !== null}
        title="Cancelar meta"
        message={`Tem certeza que deseja cancelar a meta "${confirmCancel?.name ?? ""}"? Esta ação pode ser desfeita.`}
        confirmLabel="Cancelar meta"
        danger
        onConfirm={() => {
          if (confirmCancel) cancelGoal(confirmCancel.id);
          setConfirmCancel(null);
        }}
        onCancel={() => setConfirmCancel(null)}
      />

      <GoalDetailSheet
        goal={detailGoal}
        open={detailGoal !== null}
        onClose={() => setDetailGoal(null)}
        onEdit={(id, input) => updateGoal(id, input)}
      />
    </div>
  );
}
