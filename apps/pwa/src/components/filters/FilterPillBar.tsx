"use client";

import { useState } from "react";
import { CalendarDays, ChevronDown, Wallet, X } from "lucide-react";
import type { AnalyticsFilters, AnalyticsPeriod } from "./analytics-filters";

export type FilterAccount = { id: string; name: string };

const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  last30days: "Últimos 30 dias",
  lastMonth: "Mês Passado",
  thisYear: "Este Ano",
  custom: "Personalizado",
};

const PERIOD_OPTIONS: AnalyticsPeriod[] = ["last30days", "lastMonth", "thisYear", "custom"];

/**
 * Pílula sticky [Período ▾][Conta ▾] com gaveta de opções (períodos +
 * personalizado com datas, lista de contas). Controlada via props.
 */
export function FilterPillBar({
  filters,
  accounts,
  onPeriodChange,
  onAccountChange,
}: {
  filters: AnalyticsFilters;
  accounts: FilterAccount[];
  onPeriodChange: (period: AnalyticsPeriod, custom?: { from: string; to: string }) => void;
  onAccountChange: (accountId?: string) => void;
}) {
  const [drawer, setDrawer] = useState<"period" | "account" | null>(null);
  const [customFrom, setCustomFrom] = useState(filters.from ?? "");
  const [customTo, setCustomTo] = useState(filters.to ?? "");
  const activeAccount = accounts.find((account) => account.id === filters.accountId);

  const toggle = (which: "period" | "account") => setDrawer((current) => (current === which ? null : which));

  return (
    <div className="sticky top-0 z-10 -mt-1 bg-bg/80 py-3 backdrop-blur-md">
      <div className="flex gap-2" role="group" aria-label="Filtros de analytics">
        <button
          type="button"
          onClick={() => toggle("period")}
          aria-expanded={drawer === "period"}
          aria-label={`Período: ${filters.period === "custom" && filters.from && filters.to ? `${filters.from} a ${filters.to}` : PERIOD_LABELS[filters.period]}`}
          className={`flex flex-1 items-center justify-between gap-1.5 rounded-full border px-3.5 py-2 text-[12px] font-bold shadow-sm transition-all active:scale-[0.98] ${
            drawer === "period"
              ? "border-primary bg-primary-tint text-primary"
              : "border-border-subtle bg-surface-1 text-text-primary"
          }`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <CalendarDays size={14} className="flex-none text-text-muted" />
            <span className="truncate">
              {filters.period === "custom" && filters.from && filters.to
                ? `${filters.from.slice(5)}–${filters.to.slice(5)}`
                : PERIOD_LABELS[filters.period]}
            </span>
          </span>
          <ChevronDown size={14} className={`flex-none transition-transform ${drawer === "period" ? "rotate-180" : ""}`} />
        </button>
        <button
          type="button"
          onClick={() => toggle("account")}
          aria-expanded={drawer === "account"}
          aria-label={`Conta: ${activeAccount?.name ?? "Todas"}`}
          className={`flex flex-1 items-center justify-between gap-1.5 rounded-full border px-3.5 py-2 text-[12px] font-bold shadow-sm transition-all active:scale-[0.98] ${
            drawer === "account"
              ? "border-primary bg-primary-tint text-primary"
              : "border-border-subtle bg-surface-1 text-text-primary"
          }`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Wallet size={14} className="flex-none text-text-muted" />
            <span className="truncate">{activeAccount?.name ?? "Todas"}</span>
          </span>
          <ChevronDown size={14} className={`flex-none transition-transform ${drawer === "account" ? "rotate-180" : ""}`} />
        </button>
      </div>

      {drawer === "period" && (
        <div className="mt-2 rounded-[16px] border border-border-subtle bg-surface-1 p-2 shadow-card" role="dialog" aria-label="Escolher período">
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                if (option !== "custom") {
                  onPeriodChange(option);
                  setDrawer(null);
                } else {
                  onPeriodChange("custom", customFrom && customTo ? { from: customFrom, to: customTo } : undefined);
                  if (customFrom && customTo) setDrawer(null);
                }
              }}
              aria-pressed={filters.period === option}
              className={`flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[13px] font-semibold transition-colors ${
                filters.period === option ? "bg-primary-tint text-primary" : "text-text-primary hover:bg-surface-2"
              }`}
            >
              {PERIOD_LABELS[option]}
              {filters.period === option && <span className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />}
            </button>
          ))}
          <div
            data-testid="period-custom-dates"
            className="mt-1 flex flex-col gap-2.5 border-t border-border-subtle px-3 pt-2.5 pb-2 sm:flex-row sm:items-end"
          >
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                De
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  aria-label="Data inicial personalizada"
                  className="min-h-11 w-full min-w-0 rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] font-medium normal-case text-text-primary outline-none focus:border-primary"
                />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                Até
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  aria-label="Data final personalizada"
                  className="min-h-11 w-full min-w-0 rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] font-medium normal-case text-text-primary outline-none focus:border-primary"
                />
              </label>
              <button
                type="button"
                disabled={!customFrom || !customTo || customFrom > customTo}
                onClick={() => {
                  onPeriodChange("custom", { from: customFrom, to: customTo });
                  setDrawer(null);
                }}
                className="min-h-11 w-full rounded-[10px] bg-primary px-4 py-2 text-[12px] font-bold text-white transition-opacity disabled:opacity-50 sm:w-auto sm:self-end"
              >
                OK
              </button>
            </div>
        </div>
      )}

      {drawer === "account" && (
        <div className="mt-2 max-h-56 overflow-y-auto rounded-[16px] border border-border-subtle bg-surface-1 p-2 shadow-card" role="dialog" aria-label="Escolher conta">
          <button
            type="button"
            onClick={() => {
              onAccountChange(undefined);
              setDrawer(null);
            }}
            aria-pressed={!filters.accountId}
            className={`flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[13px] font-semibold transition-colors ${
              !filters.accountId ? "bg-primary-tint text-primary" : "text-text-primary hover:bg-surface-2"
            }`}
          >
            Todas as contas
            {!filters.accountId && <span className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />}
          </button>
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => {
                onAccountChange(account.id);
                setDrawer(null);
              }}
              aria-pressed={filters.accountId === account.id}
              className={`flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[13px] font-semibold transition-colors ${
                filters.accountId === account.id ? "bg-primary-tint text-primary" : "text-text-primary hover:bg-surface-2"
              }`}
            >
              <span className="truncate">{account.name}</span>
              {filters.accountId === account.id && <span className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />}
            </button>
          ))}
          {filters.accountId && (
            <button
              type="button"
              onClick={() => {
                onAccountChange(undefined);
              }}
              aria-label="Limpar filtro de conta"
              className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[12px] px-3 py-2 text-[12px] font-bold text-text-muted hover:text-text-primary"
            >
              <X size={13} /> Limpar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
