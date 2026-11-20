"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
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
  WeeklyHeatmap,
} from "@/components/charts";
import { formatBRL, formatPct } from "@/lib/format/brl";
import { useAnalytics, type CategorySlice } from "../../charts-data/useAnalytics";
import { useBlockLayout } from "@/lib/ui/use-block-layout";
import { BlockEmpty, BlockShell, BlockSkeleton, ZoneError } from "../../charts-data/BlockShell";
import { formatDeltaPp, trendOf } from "../../charts-data/analytics-format";

const REPORT_DEFAULT_ORDER = [
  "reports-kpis",
  "reports-donut",
  "reports-budgets",
  "reports-cashflow",
  "reports-heatmap",
];

const REPORT_TITLES: Record<string, string> = {
  "reports-kpis": "Indicadores",
  "reports-donut": "Gastos por categoria",
  "reports-budgets": "Orçamentos",
  "reports-cashflow": "Fluxo de caixa",
  "reports-heatmap": "Atividade no mês",
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
  const bundle = useAnalytics(filters);
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
    const weeks = bundle.heatmap?.weeks ?? [];
    return (
      <BlockShell key={id} title={title} testId={`analytics-block-${id}`} {...editProps(id, index)}>
        {weeks.length === 0 ? (
          <BlockEmpty message="Sem atividade no período." hint="Seus gastos por dia aparecem aqui." />
        ) : (
          <WeeklyHeatmap weeks={weeks} formatValue={formatBRL} />
        )}
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
