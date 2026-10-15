"use client";

import { useState, useEffect } from "react";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import BottomSheet from "@/components/BottomSheet";
import Badge from "@/components/ui/Badge";
import { WriteErrorBanner } from "@/components/WriteErrorBanner";
import { StaleBanner } from "@/components/StaleBanner";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useAppState } from "@/lib/state/app-state-context";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import { useFormDirtySafe } from "@/lib/unsaved-changes";
import { Plus, ChevronRight } from "lucide-react";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function formatInputBRL(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  const padded = digits.padStart(3, "0");
  const intPart = padded.slice(0, -2);
  const decPart = padded.slice(-2);
  return `${parseInt(intPart, 10).toLocaleString("pt-BR")},${decPart}`;
}

const SUB_COLORS: Record<string, string> = {
  Netflix: "#E50914",
  Spotify: "#1DB954",
  "Amazon Prime": "#00A8E1",
  "Disney+": "#113CCF",
  Azure: "#0089D6",
  "YouTube Premium": "#FF0000",
  "ChatGPT Plus": "#10A37F",
};

function subColor(name: string): string {
  for (const [key, color] of Object.entries(SUB_COLORS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return "#3E6FB0";
}

const SERVICE_PRESETS = [
  { name: "Netflix" },
  { name: "Spotify" },
  { name: "Amazon Prime" },
  { name: "Disney+" },
  { name: "YouTube Premium" },
  { name: "ChatGPT Plus" },
];

const CYCLE_OPTIONS = [
  { value: "monthly", label: "Mensal" },
  { value: "yearly", label: "Anual" },
];

const PAYMENT_OPTIONS = [
  { value: "card", label: "Cartão" },
  { value: "boleto", label: "Boleto" },
  { value: "pix", label: "PIX" },
  { value: "manual", label: "Manual" },
];

function parseBRLToCents(value: string): number {
  const cleaned = value.replace(/[.\s]/g, "").replace(",", ".");
  return Math.round(parseFloat(cleaned) * 100) || 0;
}

function NewSubscriptionSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (input: { name: string; amountCents: number; cycle: "monthly" | "yearly" | "weekly"; day: number; paymentMethod: string }) => void | Promise<void>;
}) {
  const { markDirty, markClean } = useFormDirtySafe();
  const [service, setService] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cycle, setCycle] = useState("monthly");
  const [payment, setPayment] = useState("card");
  const [day, setDay] = useState("");

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setService(null);
      setName("");
      setAmount("");
      setDay("");
      markClean();
    }
  }, [open, markClean]);

  async function handleSave() {
    try {
      await onAdd({
        name: name.trim() || service || "Assinatura",
        amountCents: parseBRLToCents(amount),
        cycle: cycle as "monthly" | "yearly" | "weekly",
        day: parseInt(day, 10) || 1,
        paymentMethod: payment === "card" ? "credit_card" : payment === "boleto" ? "boleto" : payment === "pix" ? "pix" : "manual",
      });
      markClean();
      onClose();
    } catch {
      // Save failed: keep dirty.
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Nova assinatura">
      <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Serviço
          </label>
          <div className="flex flex-wrap gap-2">
            {SERVICE_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => {
                  markDirty();
                  setService(p.name);
                  setName(p.name);
                }}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-bold transition-all ${
                  service === p.name
                    ? "bg-primary text-white shadow-xs"
                    : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Nome
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: Netflix"
            className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none transition-colors focus:border-primary"
          />
        </fieldset>

        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Valor
          </label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[16px] font-bold text-text-muted">
              R$
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={amount}
              onChange={(e) => {
                const raw = e.target.value.replace(/\D/g, "");
                if (raw.length > 12) return;
                setAmount(formatInputBRL(raw));
              }}
              placeholder="0,00"
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[16px] font-bold text-text-primary outline-none transition-colors focus:border-primary"
            />
          </div>
        </fieldset>

        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Ciclo
          </label>
          <div className="flex gap-1 rounded-[14px] bg-surface-2 p-1 border border-border-subtle">
            {CYCLE_OPTIONS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => { markDirty(); setCycle(c.value); }}
                className={`flex-1 rounded-[10px] py-2 text-center text-[12px] font-bold transition-all ${
                  cycle === c.value
                    ? "bg-surface-1 text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Cobrado via
          </label>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENT_OPTIONS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => { markDirty(); setPayment(p.value); }}
                className={`rounded-full px-3.5 py-1.5 text-[11px] font-bold transition-all ${
                  payment === p.value
                    ? "bg-primary text-white shadow-xs"
                    : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Dia da cobrança
          </label>
          <input
            type="number"
            min={1}
            max={31}
            value={day}
            onChange={(e) => setDay(e.target.value)}
            placeholder="1 a 31"
            className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none transition-colors focus:border-primary"
          />
        </fieldset>

        <button
          type="button"
          onClick={handleSave}
          className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          Salvar assinatura
        </button>
      </div>
    </BottomSheet>
  );
}

function SubscriptionDetailSheet({
  subscription,
  open,
  onClose,
  onSave,
  onCancel,
}: {
  subscription: { id: string; name: string; amountCents: number; cycle: string; day: number; paymentMethod: string; status: string } | null;
  open: boolean;
  onClose: () => void;
  onSave: (id: string, input: { name?: string; amountCents?: number; cycle?: "monthly" | "yearly" | "weekly"; day?: number; paymentMethod?: string }) => void | Promise<void>;
  onCancel: (id: string, name: string) => void;
}) {
  const { markDirty, markClean } = useFormDirtySafe();
  const [editMode, setEditMode] = useState(false);
  const [name, setName] = useState("");
  const [amountDisplay, setAmountDisplay] = useState("");
  const [cycle, setCycle] = useState("monthly");
  const [day, setDay] = useState("");
  const [payment, setPayment] = useState("card");

  useEffect(() => {
    if (subscription && open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(subscription.name);
      setAmountDisplay(formatInputBRL(String(subscription.amountCents)));
      setCycle(subscription.cycle);
      setDay(String(subscription.day));
      const pm = subscription.paymentMethod;
      setPayment(pm === "credit_card" ? "card" : pm === "boleto" ? "boleto" : pm === "pix" ? "pix" : "manual");
      setEditMode(false);
      markClean();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription, open]);

  if (!subscription) return null;

  const isActive = subscription.status === "active";

  function handleClose() {
    markClean();
    onClose();
  }

  async function handleSaveEdit() {
    if (!subscription) return;
    const pm =
      payment === "card" ? "credit_card" :
      payment === "boleto" ? "boleto" :
      payment === "pix" ? "pix" : "manual";
    try {
      await onSave(subscription.id, {
        name: name.trim() || undefined,
        amountCents: parseBRLToCents(amountDisplay) || undefined,
        cycle: cycle as "monthly" | "yearly" | "weekly",
        day: parseInt(day, 10) || undefined,
        paymentMethod: pm,
      });
      markClean();
      onClose();
    } catch {
      // Save failed: keep dirty.
    }
  }

  return (
    <BottomSheet open={open} onClose={handleClose} title={editMode ? "Editar assinatura" : "Detalhes da assinatura"}>
      {editMode ? (
        <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Nome</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary" />
          </fieldset>

          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Valor</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[16px] font-bold text-text-muted">R$</span>
              <input type="text" inputMode="numeric" value={amountDisplay}
                onChange={(e) => { const raw = e.target.value.replace(/\D/g, ""); if (raw.length > 12) return; setAmountDisplay(formatInputBRL(raw)); }}
                className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[16px] font-bold text-text-primary outline-none focus:border-primary" />
            </div>
          </fieldset>

          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Ciclo</label>
            <div className="flex gap-1 rounded-[14px] bg-surface-2 p-1 border border-border-subtle">
              {CYCLE_OPTIONS.map((c) => (
                <button key={c.value} type="button" onClick={() => { markDirty(); setCycle(c.value); }}
                  className={`flex-1 rounded-[10px] py-2 text-center text-[12px] font-bold transition-all ${cycle === c.value ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted"}`}>
                  {c.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Cobrado via</label>
            <div className="flex flex-wrap gap-1.5">
              {PAYMENT_OPTIONS.map((p) => (
                <button key={p.value} type="button" onClick={() => { markDirty(); setPayment(p.value); }}
                  className={`rounded-full px-3.5 py-1.5 text-[11px] font-bold transition-all ${payment === p.value ? "bg-primary text-white shadow-xs" : "bg-surface-2 text-text-secondary hover:bg-surface-3"}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Dia da cobrança</label>
            <input type="number" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)}
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary" />
          </fieldset>

          <button type="button" onClick={handleSaveEdit}
            disabled={!name.trim()}
            className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50">
            Salvar alterações
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-[16px] border border-border-subtle bg-surface-2 p-3.5">
            <Badge label={subscription.name} color={subColor(subscription.name)} size="md" />
            <div className="flex-1 min-w-0">
              <div className="truncate text-[14px] font-bold text-text-primary">{subscription.name}</div>
              <div className="text-[11px] font-medium text-text-muted">
                {subscription.cycle === "monthly" ? "Mensal" : subscription.cycle === "yearly" ? "Anual" : "Semanal"} · dia {subscription.day}
              </div>
            </div>
          </div>

          <div className="rounded-[16px] bg-surface-2 px-4 py-3.5 border border-border-subtle">
            <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Valor</div>
            <div className="font-mono tabular-nums text-[24px] font-bold text-text-primary">{formatBRL(subscription.amountCents)}</div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className="rounded-full px-3 py-1 text-[11px] font-bold"
              style={{
                color: isActive ? "var(--color-primary)" : "var(--color-text-muted)",
                background: isActive ? "var(--color-primary-tint)" : "var(--surface-2)",
              }}
            >
              {isActive ? "Ativa" : "Cancelada"}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setEditMode(true)}
            className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3.5 text-center text-[14px] font-bold text-text-primary hover:bg-surface-3 transition-colors"
          >
            Editar
          </button>

          {isActive && (
            <button
              type="button"
              onClick={() => onCancel(subscription.id, subscription.name)}
              className="w-full rounded-[14px] bg-danger-tint border border-danger/20 py-3.5 text-center text-[14px] font-bold text-danger hover:bg-danger-tint/80 transition-colors"
            >
              Cancelar assinatura
            </button>
          )}
        </div>
      )}
    </BottomSheet>
  );
}

export default function SubscriptionsPage() {
  const {
    subscriptions,
    addSubscription,
    cancelSubscription,
    updateSubscription,
    writeError,
    clearWriteError,
    retryWriteError,
    refreshSubscriptions,
  } = useAppState();

  // FIX-168-R2: sem workspace ativo, nenhum lazy-load dispara (zero I/O).
  const workspace = useWorkspaceSafe();
  const hasActiveWorkspace = workspace?.activeWorkspace != null;

  useEffect(() => {
    if (!hasActiveWorkspace) return;
    refreshSubscriptions();
  }, [hasActiveWorkspace, refreshSubscriptions]);

  const [tab, setTab] = useState<"active" | "cancelled">("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<{ id: string; name: string } | null>(null);
  const [detailSub, setDetailSub] = useState<(typeof subscriptions)[0] | null>(null);

  const active = subscriptions.filter((s) => s.status === "active");
  const cancelled = subscriptions.filter((s) => s.status === "cancelled");

  const monthlyTotal = subscriptions
    .filter((s) => s.status === "active")
    .reduce((s, sub) => {
      return s + (sub.cycle === "yearly" ? sub.amountCents / 12 : sub.amountCents);
    }, 0);

  const displayed = tab === "active" ? active : cancelled;

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <StatusBar />
      <main className="flex flex-1 flex-col pb-[var(--tab-bar-height)]">
        <PageHeader
          title="Assinaturas"
          action={
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[12px] font-bold text-white shadow-sm hover:bg-primary-hover active:scale-95 transition-all"
            >
              <Plus size={15} strokeWidth={2.4} />
              Nova
            </button>
          }
        />

        <WriteErrorBanner message={writeError} onDismiss={clearWriteError} onRetry={retryWriteError ?? undefined} />

        <StaleBanner domains={["subscriptions"]} />

        <div className="px-5 sm:px-8 lg:px-12">
          {/* Monthly total hero */}
          <div
            className="mb-4 overflow-hidden rounded-[20px] px-5 py-5 text-white shadow-card"
            style={{ background: "linear-gradient(165deg, #0F6B45, #0A3A28)" }}
          >
            <div className="mb-1 text-[11px] font-medium text-white/70">
              Custo mensal recorrente
            </div>
            <div className="mb-1 font-mono tabular-nums text-[28px] font-bold tracking-tight text-white">
              {formatBRL(Math.round(monthlyTotal))}
            </div>
            <div className="text-[11px] font-medium text-white/70">
              {active.length} ativa{active.length !== 1 ? "s" : ""}
            </div>
          </div>

          {/* Tabs */}
          <div className="mb-4 flex gap-1.5 rounded-[14px] bg-surface-2 p-1 border border-border-subtle">
            {(["active", "cancelled"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 rounded-[10px] py-2.5 text-[13px] font-bold transition-all ${
                  tab === t
                    ? "bg-surface-1 text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {t === "active" ? "Ativas" : "Canceladas"}
              </button>
            ))}
          </div>

          {/* List */}
          <div className="flex flex-col gap-2.5">
            {displayed.length === 0 ? (
              <div className="py-8 text-center text-[13px] font-medium text-text-muted">
                Nenhuma assinatura {tab === "active" ? "ativa" : "cancelada"}
              </div>
            ) : (
              displayed.map((sub) => (
                <button
                  type="button"
                  key={sub.id}
                  onClick={() => setDetailSub(sub)}
                  className="relative w-full rounded-[18px] border border-border-subtle bg-surface-1 px-4 py-3.5 pr-11 shadow-card text-left transition-all hover:bg-surface-2/60"
                >
                  <div className="flex items-center gap-3">
                    <Badge label={sub.name} color={subColor(sub.name)} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-[14px] font-bold text-text-primary">
                        {sub.name}
                      </div>
                      <div className="text-[11px] font-medium text-text-muted">
                        {sub.cycle === "monthly" ? "Mensal" : "Anual"} · dia {sub.day}
                      </div>
                    </div>
                    <div className="font-mono tabular-nums text-[14px] font-bold text-text-primary">
                      {formatBRL(sub.amountCents)}
                    </div>
                  </div>
                  {/* chevron */}
                  <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-text-muted">
                    <ChevronRight size={16} />
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </main>

      <ConfirmActionDialog
        open={confirmCancel !== null}
        title="Cancelar assinatura"
        message={`Tem certeza que deseja cancelar "${confirmCancel?.name ?? ""}"? Você pode reativá-la depois.`}
        confirmLabel="Cancelar assinatura"
        danger
        onConfirm={() => {
          if (confirmCancel) cancelSubscription(confirmCancel.id);
          setConfirmCancel(null);
        }}
        onCancel={() => setConfirmCancel(null)}
      />

      <SubscriptionDetailSheet
        subscription={detailSub}
        open={detailSub !== null}
        onClose={() => setDetailSub(null)}
        onSave={(id, input) => updateSubscription(id, input)}
        onCancel={(id, name) => {
          setDetailSub(null);
          setConfirmCancel({ id, name });
        }}
      />

      <NewSubscriptionSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onAdd={addSubscription}
      />
    </div>
  );
}
