"use client";

import { useState } from "react";
import { Minus, Pencil, TrendingDown, TrendingUp } from "lucide-react";
import {
  AnalyticsFiltersProvider,
  useAnalyticsFilters,
} from "@/components/filters/analytics-filters";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import { FilterPillBar, type FilterAccount } from "@/components/filters/FilterPillBar";
import {
  BudgetBulletBars,
  CashflowAreaChart,
  DonutChart,
  KpiCard,
} from "@/components/charts";
import { formatBRL, formatPct } from "@/lib/format/brl";
import { useAnalytics, type CategorySlice } from "../../charts-data/useAnalytics";
import { useBlockLayout } from "@/lib/ui/use-block-layout";
import { BlockEmpty, BlockShell, BlockSkeleton, ZoneError } from "../../charts-data/BlockShell";
import { formatDeltaPp, pctChange, trendOf } from "../../charts-data/analytics-format";

const REPORT_DEFAULT_ORDER = [
  "reports-kpis",
  "reports-donut",
  "reports-budgets",
  "reports-cashflow",
  "reports-comparison",
];

const REPORT_TITLES: Record<string, string> = {
  "reports-kpis": "Indicadores",
  "reports-donut": "Gastos por categoria",
  "reports-budgets": "Orçamentos",
  "reports-cashflow": "Fluxo de caixa",
  "reports-comparison": "Comparativo do período",
};

const shortIsoDate = (iso: string): string => {
  const parts = iso.slice(0, 10).split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : iso;
};

const formatComparisonDelta = (current: number, previous: number, useCurrencyDelta: boolean): string | null => {
  const diff = current - previous;
  if (useCurrencyDelta || previous === 0) {
    if (previous === 0 && current === 0) return "Estável";
    if (diff === 0) return "Estável";
    return `${diff > 0 ? "+" : "−"}${formatBRL(Math.abs(diff))}`;
  }
  const pct = pctChange(current, previous);
  if (pct === null) return null;
  if (pct === 0) return "0.0%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
};

const topSlicesWithOthers = (slices: CategorySlice[]) => {
  const sorted = [...slices].sort((a, b) => b.totalCents - a.totalCents);
  const head = sorted.slice(0, 5).map((slice) => ({
    id: slice.categoryId,
    name: slice.name,
    valueCents: slice.totalCents,
    color: slice.color,
  }));
  const restTotal = sorted.slice(5).reduce((sum, slice) => sum + Math.max(0, slice.totalCents), 0);
  if (restTotal > 0) {
    head.push({ id: "outras", name: "Outras", valueCents: restTotal, color: null });
  }
  return head;
};

function ReportsAnalyticsBlocks({ accounts, workspaceId }: { accounts: FilterAccount[]; workspaceId: string }) {
  const { filters, setPeriod, setAccountId } = useAnalyticsFilters();
  const bundle = useAnalytics(filters, { includeHeatmap: false });
  const layout = useBlockLayout({ workspaceId, surface: "reports", schema: { all: REPORT_DEFAULT_ORDER, essentialDefaultHidden: [] } });
  const [editing, setEditing] = useState(false);
  const [selectedSlice, setSelectedSlice] = useState<string | null>(null);

  const editProps = (id: string, index: number) => ({
    editMode: editing,
    hidden: layout.state.hidden.includes(id),
    disableUp: index === 0,
    disableDown: index === layout.state.order.length - 1,
    onToggleHidden: () => layout.toggle(id),
    onMoveUp: () => layout.move(id, -1),
    onMoveDown: () => layout.move(id, 1),
  });

  const renderBlock = (id: string, index: number) => {
    const title = REPORT_TITLES[id] ?? id;
    if (bundle.loading) {
      return (
        <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
          <BlockSkeleton />
        </BlockShell>
      );
    }
    if (id === "reports-kpis") {
      const kpis = bundle.kpis;
      if (!kpis) {
        return (
          <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
            <BlockEmpty message="Sem indicadores no período." hint="Registre lançamentos para ver seus números aqui." />
          </BlockShell>
        );
      }
      const savingsDelta =
        kpis.savingsRatePct === null || kpis.previousSavingsRatePct === null
          ? null
          : kpis.savingsRatePct - kpis.previousSavingsRatePct;
      // H-10: when scoped to one account, subscriptions (household-only)
      // are excluded from the fixed total — say so instead of implying
      // the fixed number covers everything.
      const fixed = kpis.fixedVsDiscretionary;
      const fixedHint =
        fixed.scope === "account" && fixed.subscriptionsCents > 0
          ? `discricionário ${formatBRL(fixed.discretionaryCents)} · +${formatBRL(fixed.subscriptionsCents)} assinaturas (todas as contas)`
          : `discricionário ${formatBRL(fixed.discretionaryCents)}`;
      const periodNetCents = kpis.incomeCents - kpis.expenseCents;
      return (
        <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
          <div
            data-testid="reports-cashflow-summary"
            className="mb-3 grid grid-cols-3 gap-2 rounded-[14px] border border-border-subtle bg-surface-2 p-3"
          >
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Entrou</div>
              <div className="mt-0.5 truncate font-mono tabular-nums text-[14px] font-bold text-primary">
                {formatBRL(kpis.incomeCents)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Saiu</div>
              <div className="mt-0.5 truncate font-mono tabular-nums text-[14px] font-bold text-danger">
                {formatBRL(kpis.expenseCents)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Sobrou</div>
              <div
                className={`mt-0.5 truncate font-mono tabular-nums text-[14px] font-bold ${
                  periodNetCents >= 0 ? "text-primary" : "text-danger"
                }`}
              >
                {formatBRL(periodNetCents)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5" data-testid="reports-kpi-grid">
            <KpiCard
              label="Taxa de poupança real"
              value={kpis.savingsRatePct === null ? "—" : formatPct(kpis.savingsRatePct)}
              deltaText={formatDeltaPp(savingsDelta)}
              trend={trendOf(savingsDelta)}
              hint="meta: acima de 20%"
            />
            <KpiCard
              label="Fixo vs discricionário"
              value={formatBRL(fixed.fixedCents)}
              deltaText={null}
              hint={fixedHint}
            />
            <div className="col-span-2">
              <KpiCard
                label="Patrimônio líquido"
                value={formatBRL(kpis.netWorthCents)}
                deltaText={null}
                spark={bundle.netWorth.map((m) => m.netWorthCents)}
                hint={bundle.netWorth.length > 1 ? "curva dos últimos meses" : undefined}
              />
            </div>
          </div>
        </BlockShell>
      );
    }
    if (id === "reports-donut") {
      const donutSlices = topSlicesWithOthers(bundle.breakdown?.slices ?? []);
      const total = donutSlices.reduce((sum, slice) => sum + slice.valueCents, 0);
      return (
        <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
          {total <= 0 ? (
            <BlockEmpty message="Sem despesas no período." hint="Suas categorias aparecem aqui." />
          ) : (
            <DonutChart
              slices={donutSlices}
              formatValue={formatBRL}
              selectedId={selectedSlice}
              onSelect={setSelectedSlice}
            />
          )}
        </BlockShell>
      );
    }
    if (id === "reports-budgets") {
      return (
        <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
          <BudgetBulletBars
            items={bundle.budgets.map((item) => ({
              id: item.budgetId,
              name: item.name,
              spentCents: item.spentCents,
              amountCents: item.amountCents,
              pctUsed: item.pctUsed,
            }))}
            formatValue={formatBRL}
          />
        </BlockShell>
      );
    }
    if (id === "reports-cashflow") {
      const series = bundle.cashflow;
      const empty = !series || series.current.length === 0;
      return (
        <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
          {empty ? (
            <BlockEmpty message="Sem movimentação no período." hint="Registre lançamentos para ver o fluxo aqui." />
          ) : (
            <CashflowAreaChart
              current={series.current}
              previous={series.previous}
              formatValue={formatBRL}
            />
          )}
        </BlockShell>
      );
    }
    const kpis = bundle.kpis;
    const noActivity =
      !kpis ||
      (kpis.incomeCents === 0 &&
        kpis.expenseCents === 0 &&
        kpis.previousIncomeCents === 0 &&
        kpis.previousExpenseCents === 0);
    if (noActivity) {
      return (
        <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
          <BlockEmpty
            message="Sem dados para comparar."
            hint="Registre lançamentos em dois períodos para acompanhar sua evolução."
          />
        </BlockShell>
      );
    }

    const currentNet = kpis.incomeCents - kpis.expenseCents;
    const previousNet = kpis.previousIncomeCents - kpis.previousExpenseCents;
    const netDiff = currentNet - previousNet;
    const hasPrevious = kpis.previousIncomeCents > 0 || kpis.previousExpenseCents > 0;
    const periodRangeCaption =
      kpis.period?.from && kpis.period?.to && kpis.previousPeriod?.from && kpis.previousPeriod?.to
        ? `${shortIsoDate(kpis.period.from)}–${shortIsoDate(kpis.period.to)} vs ${shortIsoDate(kpis.previousPeriod.from)}–${shortIsoDate(kpis.previousPeriod.to)}`
        : null;

    const comparisonRows = [
      {
        key: "income",
        label: "Receitas",
        current: kpis.incomeCents,
        previous: kpis.previousIncomeCents,
        invertPolarity: false,
        useCurrencyDelta: false,
        barColor: "var(--color-primary)",
      },
      {
        key: "expense",
        label: "Despesas",
        current: kpis.expenseCents,
        previous: kpis.previousExpenseCents,
        invertPolarity: true,
        useCurrencyDelta: false,
        barColor: "var(--color-danger)",
      },
      {
        key: "net",
        label: "Saldo líquido",
        current: currentNet,
        previous: previousNet,
        invertPolarity: false,
        useCurrencyDelta: true,
        barColor: currentNet >= 0 ? "var(--color-primary)" : "var(--color-danger)",
      },
    ];

    const hasOpenInvoices = (kpis.openInvoices?.limitCents ?? 0) > 0;
    const hasDueSoon = (kpis.dueSoonCents ?? 0) > 0;
    const creditPct = hasOpenInvoices
      ? kpis.openInvoices.utilizationPct ??
        Math.round((kpis.openInvoices.committedCents / kpis.openInvoices.limitCents) * 100)
      : 0;

    return (
      <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
        <div className="flex flex-col gap-3">
          {periodRangeCaption && (
            <div className="text-[11px] font-medium text-text-muted">{periodRangeCaption}</div>
          )}

          {hasPrevious && (
            <div
              className={`flex items-center gap-2 rounded-[12px] px-3 py-2 text-[12px] font-bold ${
                netDiff > 0
                  ? "bg-primary-tint text-primary"
                  : netDiff < 0
                    ? "bg-danger-tint text-danger"
                    : "bg-surface-2 text-text-secondary"
              }`}
            >
              {netDiff > 0 ? (
                <TrendingUp size={14} className="flex-none" aria-hidden="true" />
              ) : netDiff < 0 ? (
                <TrendingDown size={14} className="flex-none" aria-hidden="true" />
              ) : (
                <Minus size={14} className="flex-none" aria-hidden="true" />
              )}
              <span>
                {netDiff > 0
                  ? `Sobrou ${formatBRL(netDiff)} a mais que no período anterior`
                  : netDiff < 0
                    ? `Saldo ${formatBRL(Math.abs(netDiff))} menor que no período anterior`
                    : "Saldo estável em relação ao período anterior"}
              </span>
            </div>
          )}

          <div className="flex flex-col gap-3" data-testid="reports-comparison-rows">
            {comparisonRows.map((row) => {
              const deltaText = formatComparisonDelta(row.current, row.previous, row.useCurrencyDelta);
              const pctDelta = pctChange(row.current, row.previous);
              const semanticSource = row.useCurrencyDelta || row.previous === 0 ? row.current - row.previous : pctDelta;
              const trend = trendOf(semanticSource, row.invertPolarity);
              const badgeStyle =
                trend === "up"
                  ? "bg-primary-tint text-primary"
                  : trend === "down"
                    ? "bg-danger-tint text-danger"
                    : "bg-surface-2 text-text-muted";
              const maxAbs = Math.max(Math.abs(row.current), Math.abs(row.previous), 1);
              const currentPct =
                row.current === 0 ? 0 : Math.max(3, Math.round((Math.abs(row.current) / maxAbs) * 100));
              const previousPct =
                row.previous === 0 ? 0 : Math.max(3, Math.round((Math.abs(row.previous) / maxAbs) * 100));

              return (
                <div
                  key={row.key}
                  className="rounded-[14px] border border-border-subtle bg-surface-2/60 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[12px] font-bold text-text-primary">{row.label}</span>
                    {deltaText && (
                      <span className={`rounded-full px-2 py-0.5 font-mono tabular-nums text-[10px] font-bold ${badgeStyle}`}>
                        {deltaText}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-12 flex-none text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                        Atual
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{ width: `${currentPct}%`, background: row.barColor }}
                        />
                      </div>
                      <span className="min-w-[82px] text-right font-mono tabular-nums text-[12px] font-bold text-text-primary">
                        {formatBRL(row.current)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-12 flex-none text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                        Anterior
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-surface-3 transition-all duration-300"
                          style={{ width: `${previousPct}%` }}
                        />
                      </div>
                      <span className="min-w-[82px] text-right font-mono tabular-nums text-[12px] font-medium text-text-muted">
                        {formatBRL(row.previous)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {(hasOpenInvoices || hasDueSoon) && (
            <div className="grid grid-cols-1 gap-2 border-t border-border-subtle pt-2.5 sm:grid-cols-2">
              {hasOpenInvoices && (
                <div className="flex items-center justify-between gap-2 rounded-[12px] bg-surface-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                      Crédito comprometido
                    </div>
                    <div className="truncate font-mono tabular-nums text-[12px] font-bold text-text-primary">
                      {formatBRL(kpis.openInvoices.committedCents)} / {formatBRL(kpis.openInvoices.limitCents)}
                    </div>
                  </div>
                  <span className="rounded-full bg-surface-1 px-2 py-0.5 font-mono tabular-nums text-[11px] font-bold text-text-secondary">
                    {creditPct}%
                  </span>
                </div>
              )}
              {hasDueSoon && (
                <div className="flex items-center justify-between gap-2 rounded-[12px] bg-surface-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                      Contas a vencer
                    </div>
                    <div className="truncate font-mono tabular-nums text-[12px] font-bold text-text-primary">
                      {formatBRL(kpis.dueSoonCents)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </BlockShell>
    );
  };

  return (
    <div className="flex flex-col gap-3.5" data-testid="reports-analytics-zone">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <FilterPillBar
            filters={filters}
            accounts={accounts}
            onPeriodChange={setPeriod}
            onAccountChange={setAccountId}
          />
        </div>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          aria-pressed={editing}
          aria-label="Editar blocos"
          title="Editar blocos"
          className={`mt-3 flex-none rounded-full border p-2.5 shadow-sm transition-all active:scale-[0.98] ${
            editing
              ? "border-primary bg-primary-tint text-primary"
              : "border-border-subtle bg-surface-1 text-text-muted"
          }`}
        >
          <Pencil size={14} />
        </button>
      </div>
      {bundle.error && !bundle.loading ? (
        <ZoneError message="Não foi possível carregar os gráficos." onRetry={bundle.reload} />
      ) : (
        (editing ? layout.state.order : layout.visible).map((id, index) => renderBlock(id, index))
      )}
    </div>
  );
}

export function ReportsAnalyticsZone({ accounts }: { accounts: FilterAccount[] }) {
  // H-11: filters persist per canonical workspace, never globally.
  const workspaceId = useWorkspaceSafe()?.activeWorkspace?.id ?? null;
  return (
    <AnalyticsFiltersProvider workspaceId={workspaceId}>
      <ReportsAnalyticsBlocks accounts={accounts} workspaceId={workspaceId ?? "default"} />
    </AnalyticsFiltersProvider>
  );
}
