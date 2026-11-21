"use client";

import type { ReactNode } from "react";

export type KpiTrend = "up" | "down" | "flat";

export type KpiProgress = {
  /**
   * Percentual exibido na micro-barra. A largura é limitada a 0–100, mas
   * valores acima de 100 pintam a barra de danger (estouro do teto).
   */
  valuePct: number;
  /** Descrição acessível da barra (vira o aria-label do progressbar). */
  label: string;
};

/**
 * Cartão de KPI genérico: valor, delta vs período anterior, ícone
 * contextual opcional, micro-barra de progresso opcional e sparkline
 * opcional (polyline inline, sem dependências).
 */
export function KpiCard({
  label,
  value,
  deltaText,
  trend = "flat",
  spark,
  hint,
  icon,
  progress,
}: {
  label: string;
  value: string;
  deltaText?: string | null;
  trend?: KpiTrend;
  spark?: number[];
  hint?: string;
  icon?: ReactNode;
  progress?: KpiProgress | null;
}) {
  const trendColor =
    trend === "up" ? "text-primary" : trend === "down" ? "text-danger" : "text-text-muted";
  const sparkPoints = (() => {
    if (!spark || spark.length < 2) return null;
    const min = Math.min(...spark);
    const max = Math.max(...spark);
    const span = max - min || 1;
    return spark
      .map((value, i) => `${(i / (spark.length - 1)) * 100},${28 - ((value - min) / span) * 24}`)
      .join(" ");
  })();
  const progressClamped =
    progress === null || progress === undefined
      ? null
      : Math.min(100, Math.max(0, progress.valuePct));
  const progressOverLimit = (progress?.valuePct ?? 0) > 100;
  // Valores monetários/percentuais negativos (hífen ou sinal de menos U+2212;
  // o travessão "—" de vazio não casa) ganham destaque semântico danger.
  const isNegativeValue = /[-\u2212]/.test(value);
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-[16px] border border-border-subtle bg-surface-1 p-3.5 shadow-card"
      role="group"
      aria-label={`${label}: ${value}${deltaText ? `, ${deltaText}` : ""}`}
    >
      <span className="flex items-center gap-1.5">
        {icon && (
          <span aria-hidden="true" className="flex-none text-text-muted">
            {icon}
          </span>
        )}
        <span className="min-w-0 break-words text-[11px] font-bold uppercase leading-snug tracking-wider text-text-muted">
          {label}
        </span>
      </span>
      <span className={`break-words text-[20px] font-bold tabular-nums tracking-tight ${isNegativeValue ? "text-danger" : "text-text-primary"}`}>{value}</span>
      {(deltaText || sparkPoints) && (
        <span className="flex items-center justify-between gap-2">
          {deltaText ? (
            <span className={`text-[11px] font-bold ${trendColor}`}>
              {deltaText}
            </span>
          ) : (
            <span />
          )}
          {sparkPoints && (
            <svg viewBox="0 0 100 32" className="h-6 w-16 flex-none" aria-hidden="true">
              <polyline
                points={sparkPoints}
                fill="none"
                stroke="var(--primary)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      )}
      {hint && <span className="text-[10px] font-medium leading-snug text-text-muted">{hint}</span>}
      {progress && progressClamped !== null && (
        <div
          role="progressbar"
          aria-label={progress.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressClamped)}
          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div className={`h-full rounded-full ${progressOverLimit ? "bg-danger" : "bg-primary"}`} style={{ width: `${progressClamped}%` }} />
        </div>
      )}
    </div>
  );
}
