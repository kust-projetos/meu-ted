"use client";

import { useMemo, useState, useCallback } from "react";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import BottomSheet from "@/components/BottomSheet";
import { WriteErrorBanner } from "@/components/WriteErrorBanner";
import { StaleBanner } from "@/components/StaleBanner";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useAppState } from "@/lib/state/app-state-context";
import { usePullToRefresh, PullToRefreshIndicator } from "@/lib/ui/use-pull-to-refresh";
import { useFormDirtySafe } from "@/lib/unsaved-changes";
import type { Payable } from "@/lib/state/types";
import { Plus } from "lucide-react";

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

function NewPayableSheet({
  open,
  onClose,
  onSave,
  accounts,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (input: {
    accountId: string;
    description: string;
    amountCents: number;
    dueDate: string;
    categoryId?: string;
  }) => void | Promise<void>;
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string; kind: string }[];
}) {
  const { markDirty, markClean } = useFormDirtySafe();
  const [description, setDescription] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState("");

  async function handleSave() {
    if (!description.trim() || !dueDate) return;
    const amountCents = parseBRLToCents(amountStr);
    if (amountCents <= 0) return;
    try {
      await onSave({
        accountId,
        description: description.trim(),
        amountCents,
        dueDate,
        categoryId: categoryId || undefined,
      });
      markClean();
      setDescription("");
      setAmountStr("");
      setDueDate("");
      onClose();
    } catch {
      // Save failed: keep dirty.
    }
  }

  function handleCancel() {
    markClean();
    setDescription("");
    setAmountStr("");
    setDueDate("");
    onClose();
  }

  const expenseCategories = categories.filter(
    (c) => c.kind === "expense",
  );

  return (
    <BottomSheet open={open} onClose={handleCancel} title="Nova conta a pagar">
      <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Descrição</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex: Aluguel, Netflix..." className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary" />
        </fieldset>
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Valor (R$)</label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[16px] font-bold text-text-muted">R$</span>
            <input type="text" inputMode="numeric" value={amountStr} onChange={(e) => { const raw = e.target.value.replace(/\D/g, ""); if (raw.length > 12) return; setAmountStr(formatInputBRL(raw)); }} placeholder="0,00" className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[16px] font-bold text-text-primary outline-none focus:border-primary" />
          </div>
        </fieldset>
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Vencimento</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary" />
        </fieldset>
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Conta</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary">
            {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </select>
        </fieldset>
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Categoria</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary">
            <option value="">Sem categoria</option>
            {expenseCategories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
          </select>
        </fieldset>
        <button type="button" onClick={handleSave} disabled={!description.trim() || !dueDate || parseBRLToCents(amountStr) <= 0} className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50">Salvar conta</button>
      </div>
    </BottomSheet>
  );
}

type StatusFilter = "all" | "overdue" | "pending" | "paid";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function formatDayMonth(dateStr: string): { day: string; mon: string } {
  const d = new Date(dateStr + "T12:00:00");
  return { day: String(d.getDate()).padStart(2, "0"), mon: d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "") };
}

function formatDatePtBr(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function daysUntil(dateStr: string): number {
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr + "T12:00:00");
  const d = new Date(dateStr + "T12:00:00");
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function formatPayableDueCopy(
  dateStr: string,
  status: "paid" | "overdue" | "pending",
): string {
  const formatted = formatDatePtBr(dateStr);
  if (status === "paid") return `Paga em ${formatted}`;
  const diff = daysUntil(dateStr);
  if (status === "overdue" || diff < 0) {
    const lateDays = Math.abs(diff);
    if (lateDays === 1) return `Venceu em ${formatted} (há 1 dia)`;
    if (lateDays > 1) return `Venceu em ${formatted} (há ${lateDays} dias)`;
    return `Venceu em ${formatted}`;
  }
  if (diff === 0) return `Vence hoje (${formatted})`;
  if (diff === 1) return `Vence amanhã (${formatted})`;
  if (diff <= 7) return `Vence em ${formatted} (em ${diff} dias)`;
  return `Vence em ${formatted}`;
}

interface PayableWithStatus extends Payable {
  derivedStatus: "paid" | "overdue" | "pending";
}

interface PayableGroup {
  key: string;
  title: string;
  color: string;
  items: PayableWithStatus[];
}

function DetailSheet({
  open,
  payable,
  accounts,
  categories,
  onClose,
  onSave,
  onMarkPaid,
  onUndoPay,
  onCancel,
}: {
  open: boolean;
  payable: PayableWithStatus | null;
  accounts: { id: string; name: string; kind?: string }[];
  categories: { id: string; name: string; kind: string }[];
  onClose: () => void;
  onSave: (id: string, input: { description?: string; amountCents?: number; dueDate?: string; accountId?: string; categoryId?: string }) => void | Promise<void>;
  onMarkPaid: (id: string) => void;
  onUndoPay: (id: string) => void;
  onCancel: (p: Payable) => void;
}) {
  const { markDirty, markClean } = useFormDirtySafe();
  const isCancelled = payable?.status === "cancelled";
  const [description, setDescription] = useState(payable?.description ?? "");
  const [amountStr, setAmountStr] = useState(payable ? formatInputBRL(String(payable.amountCents)) : "");
  const [dueDate, setDueDate] = useState(payable?.dueDate ?? "");
  const [accountId, setAccountId] = useState(payable?.accountId ?? "");
  const [categoryId, setCategoryId] = useState(payable?.categoryId ?? "");

  function handleClose() {
    markClean();
    onClose();
  }

  async function handleSave() {
    if (!payable) return;
    const parsed = parseBRLToCents(amountStr);
    try {
      await onSave(payable.id, {
        description: description.trim() || undefined,
        amountCents: parsed > 0 ? parsed : undefined,
        dueDate: dueDate || undefined,
        accountId: accountId || undefined,
        categoryId: categoryId || undefined,
      });
      markClean();
      onClose();
    } catch {
      // Save failed: keep dirty.
    }
  }

  if (!payable) return null;

  const expenseCategories = categories.filter((c) => c.kind === "expense");

  const showActions = !isCancelled && (payable.status === "pending" || payable.status === "overdue");
  const showUndo = !isCancelled && payable.status === "paid";

  return (
    <BottomSheet open={open} onClose={handleClose} title={payable.description}>
      <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
        {isCancelled ? (
          <>
            <div className="space-y-3">
              <div className="flex justify-between rounded-[14px] bg-surface-2 px-4 py-3 border border-border-subtle">
                <span className="text-[13px] text-text-secondary">Valor</span>
                <span className="font-mono tabular-nums text-[14px] font-bold text-text-primary">{formatBRL(payable.amountCents)}</span>
              </div>
              <div className="flex justify-between rounded-[14px] bg-surface-2 px-4 py-3 border border-border-subtle">
                <span className="text-[13px] text-text-secondary">Vencimento</span>
                <span className="text-[13px] font-semibold text-text-primary">{formatDatePtBr(payable.dueDate)}</span>
              </div>
              <div className="flex justify-between rounded-[14px] bg-surface-2 px-4 py-3 border border-border-subtle">
                <span className="text-[13px] text-text-secondary">Status</span>
                <span className="text-[13px] font-semibold text-text-muted">Cancelada</span>
              </div>
            </div>
            <button type="button" onClick={onClose} className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-[14px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98]">Fechar</button>
          </>
        ) : (
          <>
            <fieldset>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Descrição</label>
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary" />
            </fieldset>
            <fieldset>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Valor (R$)</label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[16px] font-bold text-text-muted">R$</span>
                <input type="text" inputMode="numeric" value={amountStr} onChange={(e) => { const raw = e.target.value.replace(/\D/g, ""); if (raw.length > 12) return; setAmountStr(formatInputBRL(raw)); }} className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[16px] font-bold text-text-primary outline-none focus:border-primary" />
              </div>
            </fieldset>
            <fieldset>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Vencimento</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary" />
            </fieldset>
            <fieldset>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Conta</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary">
                {accounts.map((a) => (<option key={a.id} value={a.id}>{a.kind === "credit_card" ? `Cartão • ${a.name}` : `Conta • ${a.name}`}</option>))}
              </select>
            </fieldset>
            <fieldset>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Categoria</label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary">
                <option value="">Sem categoria</option>
                {expenseCategories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </fieldset>
            <button
              type="button"
              onClick={handleSave}
              className="w-full rounded-[14px] bg-primary py-3.5 text-[14px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98]"
            >
              Salvar alterações
            </button>
            {showActions && (
              <>
                <button
                  type="button"
                  onClick={() => { markClean(); onMarkPaid(payable.id); onClose(); }}
                  className="w-full rounded-[14px] bg-primary py-3.5 text-[14px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98]"
                >
                  Marcar como paga
                </button>
                <button
                  type="button"
                  onClick={() => { markClean(); onCancel(payable); onClose(); }}
                  className="w-full rounded-[14px] border border-danger/30 bg-danger-tint py-3.5 text-[14px] font-bold text-danger hover:bg-danger-tint/80 transition-colors"
                >
                  Cancelar conta
                </button>
              </>
            )}
            {showUndo && (
              <button
                type="button"
                onClick={() => { markClean(); onUndoPay(payable.id); onClose(); }}
                className="w-full rounded-[14px] border border-warning/30 bg-warning-tint py-3.5 text-[14px] font-bold text-warning hover:bg-warning-tint/80 transition-colors"
              >
                Desfazer pagamento
              </button>
            )}
          </>
        )}
      </div>
    </BottomSheet>
  );
}

export default function PayablesPage({ embedded = false }: { embedded?: boolean }) {
  const { payables, categories, accounts, markPayablePaid, cancelPayable, updatePayable, undoPayablePayment, createPayable, loading, error, writeError, clearWriteError, retryWriteError, refreshDomains } = useAppState();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<Payable | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<Payable | null>(null);
  const [detailPayable, setDetailPayable] = useState<PayableWithStatus | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const deriveStatus = (p: Payable): "paid" | "overdue" | "pending" => {
    if (p.status === "paid") return "paid";
    if (p.status === "overdue") return "overdue";
    if (p.status === "cancelled") return "paid";
    const d = daysUntil(p.dueDate);
    if (d < 0) return "overdue";
    return "pending";
  };

  const payablesWithStatus = useMemo((): PayableWithStatus[] =>
    payables.map((p) => ({ ...p, derivedStatus: deriveStatus(p) })), [payables]);

  const filtered = useMemo((): PayableWithStatus[] => {
    if (statusFilter === "all") return payablesWithStatus;
    return payablesWithStatus.filter((p) => p.derivedStatus === statusFilter);
  }, [payablesWithStatus, statusFilter]);

  const groups = useMemo(() => {
    const overdue: PayableWithStatus[] = [];
    const upcoming: PayableWithStatus[] = [];
    const paid: PayableWithStatus[] = [];
    for (const p of filtered) {
      if (p.derivedStatus === "paid") paid.push(p);
      else if (p.derivedStatus === "overdue") overdue.push(p);
      else upcoming.push(p);
    }
    const result: PayableGroup[] = [];
    if (overdue.length > 0) result.push({ key: "overdue", title: `Vencidas · ${overdue.length}`, color: "var(--color-danger)", items: overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate)) });
    if (upcoming.length > 0) result.push({ key: "upcoming", title: `Próximas · ${upcoming.length}`, color: "var(--color-warning)", items: upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate)) });
    if (paid.length > 0) result.push({ key: "paid", title: `Pagas · ${paid.length}`, color: "var(--color-primary)", items: paid.sort((a, b) => b.dueDate.localeCompare(a.dueDate)) });
    return result;
  }, [filtered]);

  const openDetail = (p: PayableWithStatus) => {
    setDetailPayable(p);
    setDetailOpen(true);
  };

  const totalCents = payables.reduce((s, p) => s + p.amountCents, 0);
  const paidCents = payables.filter((p) => p.status === "paid").reduce((s, p) => s + p.amountCents, 0);
  const pendingCents = payables.filter((p) => p.status === "pending" || p.status === "overdue").reduce((s, p) => s + p.amountCents, 0);

  function getCategory(id?: string): string {
    if (!id) return "";
    return categories.find((c) => c.id === id)?.name ?? "";
  }

  const filterChips: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "Todas" }, { key: "overdue", label: "Vencidas" }, { key: "pending", label: "Próximas" }, { key: "paid", label: "Pagas" },
  ];

  // F4 pull-to-refresh: revalida os domínios exibidos nesta tela.
  const handleRefresh = useCallback(
    async () => {
      await refreshDomains(["payables", "accounts"]);
    },
    [refreshDomains],
  );
  const pull = usePullToRefresh({ onRefresh: handleRefresh });

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

  return (
    <div className={embedded ? "flex flex-1 flex-col bg-bg" : "flex min-h-dvh flex-col bg-bg"}>
      {!embedded && <StatusBar />}
      <main className={embedded ? "flex flex-1 flex-col pt-4" : "flex flex-1 flex-col pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8"}>
        <PullToRefreshIndicator state={pull} />
        {!embedded && (
          <PageHeader title="Contas a pagar" action={
            <button type="button" onClick={() => setCreateOpen(true)} className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[12px] font-bold text-white shadow-sm hover:bg-primary-hover active:scale-95 transition-all">
              <Plus size={15} strokeWidth={2.4} />
              Nova
            </button>
          } />
        )}

        {error && (<div className="mx-5 mb-3 rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger">⚠ {error}</div>)}
        <WriteErrorBanner message={writeError} onDismiss={clearWriteError} onRetry={retryWriteError ?? undefined} />
        <StaleBanner domains={["payables", "categories"]} />

        <div className="px-5 sm:px-8 lg:px-12">
          <div className="mb-4 overflow-hidden rounded-[20px] px-5 py-5 text-white shadow-card" style={{ background: "linear-gradient(165deg, #0F6B45, #0A3A28)" }}>
            <div className="grid grid-cols-3 gap-2.5 text-center">
              <div><div className="mb-1 text-[11px] font-medium text-white/70">Total</div><div className="font-mono tabular-nums text-[16px] font-bold text-white">{formatBRL(totalCents)}</div></div>
              <div><div className="mb-1 text-[11px] font-medium text-white/70">Pago</div><div className="font-mono tabular-nums text-[16px] font-bold text-[#7FE3B0]">{formatBRL(paidCents)}</div></div>
              <div><div className="mb-1 text-[11px] font-medium text-white/70">A pagar</div><div className="font-mono tabular-nums text-[16px] font-bold text-[#F9A8A2]">{formatBRL(pendingCents)}</div></div>
            </div>
          </div>

          <div className="mb-4 flex items-center gap-2">
            <div data-no-swipe className="flex flex-1 gap-2 overflow-x-auto scrollbar-hide">
              {filterChips.map((chip) => (
                <button key={chip.key} onClick={() => setStatusFilter(chip.key === statusFilter ? "all" : chip.key)}
                  className={`flex-none rounded-full px-4 py-2 text-[12px] font-bold transition-all ${statusFilter === chip.key ? "bg-primary text-white shadow-xs" : "bg-surface-1 border border-border-subtle text-text-secondary hover:bg-surface-2"}`}
                >{chip.label}</button>
              ))}
            </div>
            {embedded && (
              <button type="button" onClick={() => setCreateOpen(true)} className="flex flex-none items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[12px] font-bold text-white shadow-sm hover:bg-primary-hover active:scale-95 transition-all">
                <Plus size={15} strokeWidth={2.4} />
                Nova
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 px-5 sm:px-8 lg:px-12">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="mb-2.5 flex items-center gap-2">
                <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: group.color }} />
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">{group.title}</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {group.items.map((p) => {
                  const dm = formatDayMonth(p.dueDate);
                  const isPaid = p.status === "paid" || p.status === "cancelled";
                  const isOverdue = p.derivedStatus === "overdue";
                  const opacity = isPaid ? "0.65" : "1";
                  const iconBg = isPaid ? "var(--color-primary-tint)" : isOverdue ? "var(--color-danger-tint)" : "var(--surface-2)";
                  const iconColor = isPaid ? "var(--color-primary)" : isOverdue ? "var(--color-danger)" : "var(--color-text-secondary)";

                  return (
                    <button
                      type="button"
                      key={p.id}
                      onClick={() => openDetail(p)}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded-[16px] bg-surface-1 px-4 py-3.5 text-left shadow-card hover:bg-surface-2/60 active:scale-[0.99] transition-all border ${isOverdue ? "border-danger/30" : "border-border-subtle"}`}
                      style={{ opacity }}
                    >
                      <div className="flex h-[42px] w-[42px] flex-none flex-col items-center justify-center rounded-[12px] font-mono font-bold leading-none shadow-xs" style={{ background: iconBg, color: iconColor }}>
                        <span className="text-[14px]">{dm.day}</span>
                        <span className="text-[8px] uppercase font-bold">{dm.mon}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-bold text-text-primary">{p.description}</div>
                        <div className="text-[11px] font-medium" style={{ color: isOverdue ? "var(--color-danger)" : "var(--color-text-muted)" }}>
                          {getCategory(p.categoryId)}{p.categoryId && " · "}{formatPayableDueCopy(p.dueDate, p.derivedStatus)}
                        </div>
                      </div>
                      <div className="font-mono tabular-nums text-[14px] font-bold text-text-primary">{formatBRL(p.amountCents)}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <div className="flex flex-col items-center py-[50px] text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/ted-launcher.png" alt="" aria-label="Ted relaxado" width={56} height={56} className="h-14 w-14 rounded-2xl object-contain" />
              <div className="mt-3 text-[14px] font-bold text-text-primary">Nenhuma conta pendente. Tudo em dia!</div>
              <div className="mt-1 text-[12px] text-text-muted">Nenhuma conta com este status.</div>
            </div>
          )}
        </div>
      </main>

      <NewPayableSheet open={createOpen} onClose={() => setCreateOpen(false)} onSave={createPayable} accounts={accounts} categories={categories} />

      <DetailSheet
        key={detailPayable?.id ?? "none"}
        open={detailOpen}
        payable={detailPayable}
        accounts={accounts}
        categories={categories}
        onClose={() => { setDetailOpen(false); setDetailPayable(null); }}
        onSave={(id, input) => updatePayable(id, input)}
        onMarkPaid={(id) => markPayablePaid(id)}
        onUndoPay={() => setConfirmUndo(detailPayable)}
        onCancel={(p) => setConfirmCancel(p)}
      />

      {/* Confirm undo payment */}
      <ConfirmActionDialog
        open={confirmUndo !== null}
        title="Desfazer pagamento"
        message={`Tem certeza que deseja desfazer o pagamento de "${confirmUndo?.description ?? ""}"? A transação será removida.`}
        confirmLabel="Sim, desfazer pagamento"
        cancelLabel="Voltar"
        danger
        onConfirm={() => { if (confirmUndo) undoPayablePayment(confirmUndo.id); setConfirmUndo(null); }}
        onCancel={() => setConfirmUndo(null)}
      />

      <ConfirmActionDialog
        open={confirmCancel !== null}
        title="Cancelar conta a pagar"
        message={`Tem certeza que deseja cancelar "${confirmCancel?.description ?? ""}"? Esta ação pode ser desfeita.`}
        confirmLabel="Sim, cancelar conta"
        cancelLabel="Voltar"
        danger
        onConfirm={() => { if (confirmCancel) cancelPayable(confirmCancel.id); setConfirmCancel(null); }}
        onCancel={() => setConfirmCancel(null)}
      />
    </div>
  );
}
