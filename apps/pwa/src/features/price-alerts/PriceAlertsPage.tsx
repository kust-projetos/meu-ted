"use client";

import { useEffect, useState } from "react";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import { fetchPriceAlerts, createPriceAlert } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/client";
import { Bell, ArrowDown, ArrowUp } from "lucide-react";

type Alert = {
  id: string;
  productName: string;
  targetPriceCents: number;
  condition: "below" | "above";
  createdAt: string;
};

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export default function PriceAlertsPage({ embedded = false }: { embedded?: boolean }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Phase 7 gating: the API only mounts /alerts/price* under explicit
  // opt-in (PI_FEATURE_PRICE_ALERTS); with the flag OFF every call 404s.
  // Degrade to an explicit unavailable state instead of an error wall.
  const [unavailable, setUnavailable] = useState(false);
  const [productName, setProductName] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [condition, setCondition] = useState<"below" | "above">("below");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function isFlagOff(e: unknown): boolean {
    return e instanceof ApiError && e.status === 404;
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchPriceAlerts();
      setAlerts(items);
    } catch (e) {
      if (isFlagOff(e)) {
        setUnavailable(true);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  function parseBRLToCents(value: string): number {
    const cleaned = value.replace(/[.\s]/g, "").replace(",", ".");
    return Math.round(parseFloat(cleaned) * 100) || 0;
  }

  function formatInputBRL(value: string): string {
    const digits = value.replace(/\D/g, "");
    if (!digits) return "";
    const padded = digits.padStart(3, "0");
    const intPart = padded.slice(0, -2);
    const decPart = padded.slice(-2);
    return `${parseInt(intPart, 10).toLocaleString("pt-BR")},${decPart}`;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const cents = parseBRLToCents(targetPrice);
    if (!productName.trim()) {
      setFormError("Informe o nome do produto.");
      return;
    }
    if (cents <= 0) {
      setFormError("Informe um preço alvo válido.");
      return;
    }
    setSaving(true);
    try {
      await createPriceAlert({ productName: productName.trim(), targetPriceCents: cents, condition });
      setProductName("");
      setTargetPrice("");
      await load();
    } catch (err) {
      if (isFlagOff(err)) {
        setUnavailable(true);
      } else {
        setFormError((err as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  if (unavailable) {
    return (
      <div className={embedded ? "flex flex-1 flex-col bg-bg" : "flex min-h-dvh flex-col bg-bg"}>
        {!embedded && <StatusBar />}
        <main className={embedded ? "flex flex-1 flex-col pt-4" : "flex flex-1 flex-col pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8"}>
          {!embedded && <PageHeader title="Alertas de Preço" />}
          <div className="px-5 sm:px-8 lg:px-12">
            <div className="py-10 text-center">
              <div className="mb-2 flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-surface-2 text-text-muted shadow-xs">
                <Bell size={22} />
              </div>
              <div className="text-[14px] font-bold text-text-primary">Alertas de preço indisponíveis</div>
              <div className="mt-1 text-[12px] text-text-muted">Este recurso está desativado no momento.</div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={embedded ? "flex flex-1 flex-col bg-bg" : "flex min-h-dvh flex-col bg-bg"}>
      {!embedded && <StatusBar />}
      <main className={embedded ? "flex flex-1 flex-col pt-4" : "flex flex-1 flex-col pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8"}>
        {!embedded && <PageHeader title="Alertas de Preço" />}
        <div className="px-5 sm:px-8 lg:px-12">
          <form onSubmit={handleSubmit} className="mb-6 rounded-[18px] border border-border-subtle bg-surface-1 p-4 shadow-card">
            <h2 className="mb-3 text-[14px] font-bold text-text-primary">Novo alerta</h2>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Produto</span>
                <input
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="Ex: Arroz 5kg"
                  className="rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[13px] font-semibold text-text-primary outline-none focus:border-primary"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Preço alvo (R$)</span>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[14px] font-bold text-text-muted">R$</span>
                  <input
                    value={targetPrice}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/\D/g, "");
                      if (raw.length > 12) return;
                      setTargetPrice(formatInputBRL(raw));
                    }}
                    placeholder="0,00"
                    inputMode="numeric"
                    className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[14px] font-bold text-text-primary outline-none focus:border-primary"
                  />
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Condição</span>
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value as "below" | "above")}
                  className="rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[13px] font-semibold text-text-primary outline-none focus:border-primary"
                >
                  <option value="below">Avisar quando ficar abaixo</option>
                  <option value="above">Avisar quando ficar acima</option>
                </select>
              </label>
              {formError && <div className="rounded-[12px] bg-danger-tint px-3 py-2 text-[12px] font-semibold text-danger">{formError}</div>}
              <button
                type="submit"
                disabled={saving}
                className="w-full rounded-[14px] bg-primary py-3.5 text-center text-[14px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50"
              >
                {saving ? "Salvando..." : "Criar alerta"}
              </button>
            </div>
          </form>

          {loading ? (
            <div className="py-10 text-center text-[13px] font-semibold text-text-muted">Carregando...</div>
          ) : error ? (
            <div className="rounded-[12px] bg-danger-tint px-4 py-3 text-[12px] font-semibold text-danger">{error}</div>
          ) : alerts.length === 0 ? (
            <div className="py-10 text-center">
              <div className="mb-2 flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-surface-2 text-text-muted shadow-xs">
                <Bell size={22} />
              </div>
              <div className="text-[14px] font-bold text-text-primary">Nenhum alerta</div>
              <div className="mt-1 text-[12px] text-text-muted">Crie seu primeiro alerta de preço acima.</div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Alertas ({alerts.length})</h3>
              {alerts.map((a) => (
                <div key={a.id} className="rounded-[16px] border border-border-subtle bg-surface-1 px-4 py-3.5 shadow-card">
                  <div className="text-[14px] font-bold text-text-primary">{a.productName}</div>
                  <div className="mt-1.5 flex items-center gap-2 text-[12px] text-text-muted">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${a.condition === "below" ? "bg-primary-tint text-primary" : "bg-warning-tint text-warning"}`}>
                      {a.condition === "below" ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
                      {a.condition === "below" ? "abaixo de" : "acima de"}
                    </span>
                    <span className="font-mono tabular-nums font-bold text-text-primary">{formatBRL(a.targetPriceCents)}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-text-muted">{new Date(a.createdAt).toLocaleDateString("pt-BR")}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
