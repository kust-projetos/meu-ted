"use client";

import { useState } from "react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { formatBRL } from "@/lib/format/brl";
import type { MonthlyComparisonPoint } from "../hooks/useMonthlyComparison";

export interface MonthlyComparisonCardProps {
  points: MonthlyComparisonPoint[];
  hidden: boolean;
  onOpenReports: () => void;
}

export function MonthlyComparisonCard({
  points,
  hidden,
  onOpenReports,
}: MonthlyComparisonCardProps) {
  const [selectedYm, setSelectedYm] = useState<string | null>(null);

  const activePoint =
    (selectedYm ? points.find((p) => p.yearMonth === selectedYm) : undefined) ??
    points[points.length - 1];
  const activeIndex = activePoint
    ? points.findIndex((p) => p.yearMonth === activePoint.yearMonth)
    : -1;
  const previousPoint = activeIndex > 0 ? points[activeIndex - 1] : undefined;

  const maxValue = Math.max(
    1,
    ...points.flatMap((p) => [p.incomeCents, p.expenseCents]),
  );

  const deltaNetPct =
    activePoint &&
    previousPoint &&
    Math.abs(previousPoint.netCents) > 0
      ? Math.round(
          ((activePoint.netCents - previousPoint.netCents) /
            Math.abs(previousPoint.netCents)) *
            100,
        )
      : null;

  return (
    <section className="mt-6">
      <SectionHeader
        title="Comparativo mensal"
        meta={
          points.length > 0
            ? points.length === 1
              ? "1 mês com registro"
              : `Últimos ${points.length} meses com registro`
            : undefined
        }
        action={
          <button
            type="button"
            onClick={onOpenReports}
            className="min-h-11 px-2 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Relatórios
          </button>
        }
      />

      {points.length > 0 && activePoint ? (
        <div className="mt-2.5 overflow-hidden rounded-[20px] border border-border-subtle bg-surface-1 p-4 sm:p-5 shadow-card">
          <div className="mb-4 flex items-center justify-between gap-2 text-xs text-text-muted">
            <div className="flex items-center gap-4">
              <span className="inline-flex items-center gap-1.5 font-medium text-text-secondary">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full bg-success"
                />
                Receitas
              </span>
              <span className="inline-flex items-center gap-1.5 font-medium text-text-secondary">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full bg-danger"
                />
                Despesas
              </span>
            </div>
            <span className="text-[11px] text-text-muted">Toque no mês</span>
          </div>

          <div
            role="group"
            aria-label="Comparativo mensal de receitas e despesas"
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))`,
            }}
          >
            {points.map((point) => {
              const isSelected = point.yearMonth === activePoint.yearMonth;
              const incomePct =
                point.incomeCents > 0
                  ? Math.max(8, Math.round((point.incomeCents / maxValue) * 100))
                  : 0;
              const expensePct =
                point.expenseCents > 0
                  ? Math.max(8, Math.round((point.expenseCents / maxValue) * 100))
                  : 0;

              return (
                <button
                  key={point.yearMonth}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${point.fullLabel}: receitas ${
                    hidden ? "ocultas" : formatBRL(point.incomeCents)
                  }, despesas ${
                    hidden ? "ocultas" : formatBRL(point.expenseCents)
                  }`}
                  onClick={() => setSelectedYm(point.yearMonth)}
                  className={`group flex flex-col items-center rounded-xl px-1 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    isSelected
                      ? "bg-surface-2/80"
                      : "hover:bg-surface-2/40"
                  }`}
                >
                  <div className="flex h-[112px] w-full items-end justify-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`w-3 sm:w-4 rounded-t-md bg-success transition-all duration-300 ${
                        isSelected ? "opacity-100" : "opacity-70 group-hover:opacity-90"
                      }`}
                      style={{ height: `${incomePct}%` }}
                    />
                    <span
                      aria-hidden="true"
                      className={`w-3 sm:w-4 rounded-t-md bg-danger/85 transition-all duration-300 ${
                        isSelected ? "opacity-100" : "opacity-70 group-hover:opacity-90"
                      }`}
                      style={{ height: `${expensePct}%` }}
                    />
                  </div>
                  <span
                    className={`mt-2 rounded-full px-2 py-0.5 text-[11px] font-bold transition-colors ${
                      isSelected
                        ? "bg-primary-tint text-primary"
                        : "text-text-muted group-hover:text-text-primary"
                    }`}
                  >
                    {point.shortLabel}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-4 rounded-[14px] border border-[var(--hairline)] bg-surface-2/50 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold text-text-primary">
                {activePoint.fullLabel}
              </span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  activePoint.netCents >= 0
                    ? "bg-success-tint text-success"
                    : "bg-danger-tint text-danger"
                }`}
              >
                {activePoint.netCents >= 0 ? "Superávit" : "Déficit"}
                {!hidden && deltaNetPct !== null
                  ? ` · ${deltaNetPct > 0 ? "+" : ""}${deltaNetPct}% vs. mês ant.`
                  : ""}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <div className="min-w-0">
                <p className="text-[11px] text-text-muted">Receitas</p>
                <p className="text-money tabular mt-0.5 truncate text-[13px] font-bold text-success">
                  {hidden ? "••••" : formatBRL(activePoint.incomeCents)}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-[11px] text-text-muted">Despesas</p>
                <p className="text-money tabular mt-0.5 truncate text-[13px] font-bold text-danger">
                  {hidden ? "••••" : formatBRL(activePoint.expenseCents)}
                </p>
              </div>
              <div className="min-w-0 text-right">
                <p className="text-[11px] text-text-muted">Resultado</p>
                <p className="text-money tabular mt-0.5 truncate text-[13px] font-bold text-text-primary">
                  {hidden ? "••••" : formatBRL(activePoint.netCents)}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex min-h-14 items-center rounded-[20px] border border-dashed border-border-medium bg-surface-1 px-4 py-3 text-sm text-text-muted">
          Sem histórico mensal ainda. O comparativo começa a partir do primeiro mês com registros.
        </div>
      )}
    </section>
  );
}

export default MonthlyComparisonCard;
