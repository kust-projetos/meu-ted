"use client";

import StatusBar from "@/components/StatusBar";
import { StaleBanner } from "@/components/StaleBanner";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Bell, CalendarClock, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, GripVertical, SlidersHorizontal, TrendingDown, TrendingUp } from "lucide-react";
import { useAppState } from "@/lib/state/app-state-context";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import {
  usePullToRefresh,
  PullToRefreshIndicator,
} from "@/lib/ui/use-pull-to-refresh";
import NotificationsSheet from "@/features/profile/NotificationsSheet";
import { useEffectiveProfile } from "@/features/profile/hooks";
import { dashboardSummaryGate } from "@/features/dashboard-summary-gate";
import { routeCompromissos, routePatrimonio, routePlanejamento } from "@/lib/routes";
import { formatBRL } from "@/lib/format/brl";
import { useCategoryBreakdown } from "./hooks/useCategoryBreakdown";
import { useFallbackInsights } from "./hooks/useFallbackInsights";
import { useMonthlyComparison } from "./hooks/useMonthlyComparison";
import { useHideBalance } from "./hooks/useHideBalance";
import { useAnimatedNumber } from "./hooks/useAnimatedNumber";
import { LoadingScreen } from "./components/LoadingScreen";
import { HomeFloatingMenu } from "./components/HomeFloatingMenu";
import { AiGuidanceCard } from "./components/AiGuidanceCard";
import { GoalsAndBudgetsCard } from "./components/GoalsAndBudgetsCard";
import { RecentTransactionsCard } from "./components/RecentTransactionsCard";
import { MonthlyComparisonCard } from "./components/MonthlyComparisonCard";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { InstitutionMark } from "@/components/brand/InstitutionMark";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatementPanel } from "@/components/ui/StatementPanel";
import { ProportionBand } from "@/components/ui/ProportionBand";
import { useAccountAppearance, writeAccountAppearance } from "@/lib/institutions/appearance-store";
import { resolveAccountPresentation } from "@/lib/institutions/appearance-store";
import { getCardProduct } from "@/lib/institutions/card-products";
import { resolveCardOutstanding } from "@/lib/cards/card-debt";
import { openTedChat } from "@/features/ted/TedChatLauncher";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { useBlockLayout } from "@/lib/ui/use-block-layout";

const money = (value: number | null) =>
  value === null ? "-" : formatBRL(value);
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(
    new Date(`${date}T12:00:00`),
  );
const monthShortLabel = (date: string) =>
  new Intl.DateTimeFormat("pt-BR", { month: "short" })
    .format(new Date(`${date}T12:00:00`))
    .replace(/\.$/, "")
    .toUpperCase();

function profileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return `${parts[0]!.charAt(0)}${parts[parts.length - 1]!.charAt(0)}`.toUpperCase();
}

export default function HomePage() {
  const state = useAppState();
  const {
    accounts,
    transactions,
    categories,
    payables,
    budgets,
    goals,
    cardStatements,
    quickInsights,
    dashboardSummary,
  } = state;
  const {
    refreshDashboardSummary,
    refreshDashboardSummaryStrict,
    refreshDomains,
  } = state;
  const profile = useEffectiveProfile();
  const router = useRouter();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const workspace = useWorkspaceSafe();
  const workspaceId = workspace?.activeWorkspace?.id ?? "default";
  const homeSchema = {
    all: [
      "home-attention",
      "home-statement",
      "home-ai-guidance",
      "home-accounts",
      "home-cards",
      "home-planning",
      "home-recent",
      "home-commitments",
      "home-categories",
      "home-monthly-comparison",
    ],
    essentialDefaultHidden: [
      "home-cards",
      "home-categories",
      "home-monthly-comparison",
    ],
  };
  const layout = useBlockLayout({ workspaceId, surface: "home", schema: homeSchema });
  const [customizing, setCustomizing] = useState(false);
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const [categoryTab, setCategoryTab] = useState<"expense" | "income">("expense");
  const [announcement, setAnnouncement] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const dragRef = useRef<{ id: string; pointerId: number; index: number } | null>(null);
  const hasActiveWorkspace = workspace?.activeWorkspace != null;
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryRetrying, setSummaryRetrying] = useState(false);
  const handleSnapshotSummaryRefresh = useCallback(async () => {
    if (!hasActiveWorkspace) return;
    const fn = refreshDashboardSummaryStrict ?? refreshDashboardSummary;
    if (typeof fn !== "function") return;
    setSummaryRetrying(true);
    try {
      await fn();
      setSummaryError(null);
    } catch {
      setSummaryError("Não foi possível atualizar o resumo - tente novamente.");
    } finally {
      setSummaryRetrying(false);
    }
  }, [
    hasActiveWorkspace,
    refreshDashboardSummary,
    refreshDashboardSummaryStrict,
  ]);
  useEffect(() => {
    if (!dashboardSummary && hasActiveWorkspace && refreshDashboardSummary)
      refreshDashboardSummary();
  }, [dashboardSummary, hasActiveWorkspace, refreshDashboardSummary]);
  const hasServerSummary = dashboardSummaryGate({
    serverSummary: dashboardSummary,
  });
  const totalBalance = hasServerSummary
    ? (dashboardSummary?.totalBalanceCents ?? 0)
    : null;
  const totalIncome = hasServerSummary
    ? (dashboardSummary?.monthIncomeCents ?? 0)
    : null;
  const totalExpenses = hasServerSummary
    ? (dashboardSummary?.monthExpenseCents ?? 0)
    : null;
  const netResult = hasServerSummary
    ? (dashboardSummary?.monthNetCents ??
      (totalIncome !== null && totalExpenses !== null
        ? totalIncome - totalExpenses
        : 0))
    : null;
  const expenseMacros = useCategoryBreakdown(transactions, categories, "expense");
  const incomeMacros = useCategoryBreakdown(transactions, categories, "income");
  const monthlyComparison = useMonthlyComparison(transactions, 6);
  const insights = useFallbackInsights({
    transactions,
    budgets,
    payables,
    quickInsights,
    monthIncome: totalIncome,
    monthExpenses: totalExpenses,
    macros: expenseMacros,
  });
  const { hidden, toggle } = useHideBalance();
  const animatedBalance = useAnimatedNumber(totalBalance ?? 0);
  const appearance = useAccountAppearance(workspaceId).map;
  useEffect(() => {
    for (const account of accounts) {
      const patch = {
        ...(account.institutionId ? { institutionId: account.institutionId } : {}),
        ...(account.cardProductId ? { cardProductId: account.cardProductId } : {}),
      };
      if (Object.keys(patch).length) writeAccountAppearance(workspaceId, account.id, patch);
    }
  }, [accounts, workspaceId]);
  const handleRefresh = useCallback(async () => {
    if (!hasActiveWorkspace) return;
    await refreshDomains?.(["accounts", "transactions", "payables", "budgets"]);
    await refreshDashboardSummary?.();
  }, [hasActiveWorkspace, refreshDomains, refreshDashboardSummary]);
  const pull = usePullToRefresh({ onRefresh: handleRefresh });
  if (state.loading) return <LoadingScreen />;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = today.toISOString().slice(0, 10);
  const inSevenDays = new Date(today);
  inSevenDays.setDate(today.getDate() + 7);
  const dueWithinWeek = (date: string) =>
    date >= todayKey && date <= inSevenDays.toISOString().slice(0, 10);
  const checkingAccounts = accounts.filter((a) => a.kind !== "credit_card");
  const cards = accounts
    .filter((a) => a.kind === "credit_card")
    .map((card) => {
      const statements = cardStatements
        .filter((s) => s.accountId === card.id)
        .sort((a, b) => b.cycleYearMonth.localeCompare(a.cycleYearMonth));
      const outstanding = resolveCardOutstanding(card, {
        statementFallbackCents:
          statements[0]?.totalCents ??
          transactions
            .filter((t) => t.accountId === card.id && t.kind === "expense")
            .reduce((sum, t) => sum + t.amountCents, 0),
      }).outstandingCents;
      return {
        card,
        statements,
        outstanding,
        limit: card.creditLimitCents ?? 0,
      };
    })
    .sort((a, b) => b.outstanding - a.outstanding);
  const attention: Array<{
    key: string;
    tone: "danger" | "warning";
    label: string;
    value?: string;
    date: string;
    route: string;
  }> = [
    ...payables
      .filter((p) => p.status === "pending" && p.dueDate < todayKey)
      .map((p) => ({
        key: p.id,
        tone: "danger" as const,
        label: `${p.description} vencida · ${dateLabel(p.dueDate)}`,
        value: formatBRL(p.amountCents),
        date: p.dueDate,
        route: routeCompromissos("a-pagar"),
      })),
    ...payables
      .filter((p) => p.status === "pending" && dueWithinWeek(p.dueDate))
      .map((p) => ({
        key: p.id,
        tone: "warning" as const,
        label: `${p.description} vence ${dateLabel(p.dueDate)}`,
        value: formatBRL(p.amountCents),
        date: p.dueDate,
        route: routeCompromissos("a-pagar"),
      })),
    ...cards.flatMap(({ card, statements, outstanding, limit }) => [
      ...statements
        .filter((s) => dueWithinWeek(s.dueDate))
        .map((s) => ({
          key: s.id,
          tone: "warning" as const,
          label: `Fatura ${card.name} vence ${dateLabel(s.dueDate)}`,
          value: formatBRL(s.totalCents),
          date: s.dueDate,
          route: routePatrimonio("cartoes"),
        })),
      ...(limit > 0 && outstanding / limit >= 0.8
        ? [
            {
              key: `${card.id}-limit`,
              tone: "warning" as const,
              label: `Limite ${card.name} em ${Math.round((outstanding / limit) * 100)}%`,
              date: "9999-12-31",
              route: routePatrimonio("cartoes"),
            },
          ]
        : []),
    ]),
  ]
    .sort((a, b) =>
      a.tone === b.tone
        ? a.date.localeCompare(b.date)
        : a.tone === "danger"
          ? -1
          : 1,
    )
    .slice(0, 4);

  const attentionSummary = (() => {
    if (attention.length === 0) return "Tudo em dia.";
    const overdueCount = attention.filter((item) => item.date < todayKey).length;
    const todayCount = attention.filter((item) => item.date === todayKey).length;
    const upcomingCount = attention.filter(
      (item) => item.date > todayKey && item.date < "9999-12-31",
    ).length;
    const limitAlerts = attention.filter((item) => item.date === "9999-12-31").length;
    const parts: string[] = [];
    if (overdueCount > 0) parts.push(`${overdueCount} em atraso`);
    if (todayCount > 0) parts.push(`${todayCount} para hoje`);
    if (upcomingCount > 0) parts.push(`${upcomingCount} nos próximos dias`);
    if (limitAlerts > 0 && parts.length === 0) {
      parts.push(`${limitAlerts} ${limitAlerts === 1 ? "alerta de limite" : "alertas de limite"}`);
    }
    return parts.join(" · ") || `${attention.length} pendências`;
  })();
  const hasOverdueAttention = attention.some((item) => item.tone === "danger");
  const totalAlertBadge = attention.length;
  const checkingTotalCents = checkingAccounts.reduce((s, a) => s + a.balanceCents, 0);
  const checkingPositiveTotal = checkingAccounts.reduce(
    (s, a) => s + Math.max(0, a.balanceCents),
    0,
  );
  const pendingPayables = payables
    .filter((p) => p.status === "pending" || p.status === "overdue")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 4);
  const firstName = profile.name.trim().split(/\s+/)[0] || "Visitante";
  const month = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
  }).format(new Date());
  const expenseBreakdownTotal = expenseMacros.reduce((sum, item) => sum + item.amountCents, 0);
  const incomeBreakdownTotal = incomeMacros.reduce((sum, item) => sum + item.amountCents, 0);
  const activeMacros = categoryTab === "expense" ? expenseMacros : incomeMacros;
  const topMacros = activeMacros.slice(0, 4);
  const categoriesForBand = [
    ...topMacros,
    ...(activeMacros.length > 4
      ? [
          {
            name: "Outros",
            amountCents: activeMacros
              .slice(4)
              .reduce((s, item) => s + item.amountCents, 0),
            pct: activeMacros.slice(4).reduce((s, item) => s + item.pct, 0),
          },
        ]
      : []),
  ];
  const expenseTotalForTab =
    expenseBreakdownTotal > 0 ? expenseBreakdownTotal : (totalExpenses ?? 0);
  const incomeTotalForTab =
    incomeBreakdownTotal > 0 ? incomeBreakdownTotal : (totalIncome ?? 0);
  const activeCategoryTotal =
    categoryTab === "expense" ? expenseTotalForTab : incomeTotalForTab;
  const activeHasCategoryTotal =
    categoryTab === "expense"
      ? expenseBreakdownTotal > 0 || totalExpenses !== null
      : incomeBreakdownTotal > 0 || totalIncome !== null;
  const statementExpenseRatioPct =
    totalIncome !== null && totalIncome > 0 && totalExpenses !== null
      ? Math.min(100, Math.round((totalExpenses / totalIncome) * 100))
      : null;
  const accountKindLabels: Record<string, string> = {
    checking: "Conta corrente",
    savings: "Poupança",
    investment: "Investimento",
    cash: "Dinheiro",
  };

  const blocks: Record<string, { title: string; node: ReactNode }> = {
    "home-attention": {
      title: "Atenção",
      node: (
        <>
          {attention.length > 0 && (
            <nav
              aria-label="Itens que precisam de atenção"
              className={`mt-3 overflow-hidden rounded-[18px] border bg-surface-1 shadow-sm ${
                hasOverdueAttention ? "border-danger/25" : "border-warning/25"
              }`}
            >
              <button
                type="button"
                aria-expanded={attentionExpanded}
                onClick={() => setAttentionExpanded((v) => !v)}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                      hasOverdueAttention
                        ? "bg-danger-tint text-danger"
                        : "bg-warning-tint text-warning"
                    }`}
                  >
                    <AlertCircle size={15} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">
                    {attentionSummary}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-text-secondary">
                  {attentionExpanded ? "Ocultar" : "Ver avisos"}
                  <ChevronDown
                    size={15}
                    aria-hidden="true"
                    className={`transition-transform duration-200 ${
                      attentionExpanded ? "rotate-180" : ""
                    }`}
                  />
                </span>
              </button>

              {attentionExpanded && (
                <div className="divide-y divide-[var(--hairline)] border-t border-[var(--hairline)]">
                  {attention.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => router.push(item.route)}
                      className={`${
                        item.tone === "danger"
                          ? "attention-danger"
                          : "attention-warning"
                      } flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          item.tone === "danger" ? "bg-danger" : "bg-warning"
                        }`}
                      />
                      <span className="min-w-0 flex-1 text-[13px] font-medium text-text-primary">
                        {item.label}
                      </span>
                      {item.value && (
                        <span
                          className={`text-money tabular shrink-0 text-[13px] font-semibold ${
                            item.tone === "danger"
                              ? "text-danger"
                              : "text-warning"
                          }`}
                        >
                          {hidden ? "••••" : item.value}
                        </span>
                      )}
                      <ChevronRight
                        size={15}
                        aria-hidden="true"
                        className="shrink-0 text-text-muted"
                      />
                    </button>
                  ))}
                </div>
              )}
            </nav>
          )}
        </>
      ),
    },
    "home-statement": {
      title: "Fechamento do mês",
      node: (() => {
        const monthLabel = month.charAt(0).toUpperCase() + month.slice(1);
        const pctOfIncome =
          totalIncome !== null && totalIncome > 0 && netResult !== null
            ? Math.round((netResult / totalIncome) * 100)
            : null;
        return (
          <StatementPanel
            className="mt-4"
            footer={
              pendingPayables[0] ? (
                <button
                  type="button"
                  data-testid="home-next-due"
                  onClick={() => router.push(routeCompromissos("a-pagar"))}
                  className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-[var(--statement-text)] focus-visible:outline-none focus-visible:underline"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <CalendarClock
                      size={14}
                      aria-hidden="true"
                      className="shrink-0 text-[var(--statement-muted)]"
                    />
                    <span className="min-w-0 truncate">
                      <span className="text-[var(--statement-muted)]">
                        {pendingPayables[0].dueDate < todayKey ||
                        pendingPayables[0].status === "overdue"
                          ? "Vencimento em atraso:"
                          : "Próximo vencimento:"}
                      </span>{" "}
                      <strong className="font-semibold">
                        {pendingPayables[0].description}
                      </strong>{" "}
                      <span className="text-[var(--statement-muted)]">
                        ({dateLabel(pendingPayables[0].dueDate)})
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-money tabular font-semibold">
                      {hidden ? "••••" : formatBRL(pendingPayables[0].amountCents)}
                    </span>
                    <ChevronRight size={14} aria-hidden="true" className="text-[var(--statement-muted)]" />
                  </span>
                </button>
              ) : undefined
            }
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--statement-muted)]">
                  Fechamento do mês
                </p>
                <p className="mt-0.5 text-[15px] font-bold text-[var(--statement-text)]">
                  {monthLabel}
                </p>
              </div>
              {pctOfIncome !== null && (
                <span className="inline-flex shrink-0 items-center rounded-full bg-white/12 px-2.5 py-1 text-[11px] font-bold text-emerald-200">
                  {pctOfIncome > 0 ? `+${pctOfIncome}` : pctOfIncome}% das receitas
                </span>
              )}
            </div>

            <div className="mt-4">
              <p className="text-xs font-medium text-[var(--statement-muted)]">
                Resultado do mês
              </p>
              <p className="text-money tabular mt-0.5 text-[28px] font-bold leading-tight tracking-tight text-[var(--statement-text)]">
                {hidden ? "••••" : money(netResult)}
              </p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2.5">
              <div className="rounded-[14px] border border-white/10 bg-white/[0.07] px-3.5 py-2.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--statement-muted)]">
                  <TrendingUp
                    size={13}
                    aria-hidden="true"
                    className="text-emerald-300"
                  />
                  Receitas
                </p>
                <p className="text-money tabular mt-1 text-[15px] font-bold text-[var(--statement-text)]">
                  {hidden ? "••••" : money(totalIncome)}
                </p>
              </div>
              <div className="rounded-[14px] border border-white/10 bg-white/[0.07] px-3.5 py-2.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--statement-muted)]">
                  <TrendingDown
                    size={13}
                    aria-hidden="true"
                    className="text-rose-300"
                  />
                  Despesas
                </p>
                <p className="text-money tabular mt-1 text-[15px] font-bold text-[var(--statement-text)]">
                  {hidden ? "••••" : money(totalExpenses)}
                </p>
              </div>
            </div>

            {statementExpenseRatioPct !== null && (
              <div className="mt-3.5">
                <div className="flex items-center justify-between text-[11px] text-[var(--statement-muted)]">
                  <span>Comprometimento da receita</span>
                  <span className="text-money tabular font-semibold text-[var(--statement-text)]">
                    {hidden ? "••••" : `${statementExpenseRatioPct}%`}
                  </span>
                </div>
                <div
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/15"
                >
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      statementExpenseRatioPct >= 90
                        ? "bg-rose-400"
                        : statementExpenseRatioPct >= 70
                          ? "bg-amber-300"
                          : "bg-emerald-300"
                    }`}
                    style={{
                      width: `${hidden ? 0 : Math.max(4, statementExpenseRatioPct)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </StatementPanel>
        );
      })(),
    },
    "home-ai-guidance": {
      title: "Orientações do TED",
      node: (
        <AiGuidanceCard
          insights={insights}
          quickInsights={quickInsights}
          cards={cards}
          payables={payables}
          hidden={hidden}
          onNavigate={(route) => router.push(route)}
          onAskTed={() => openTedChat()}
        />
      ),
    },
    "home-accounts": {
      title: "Contas",
      node: (
        <>
          <section className="mt-6">
            <SectionHeader
              title="Contas"
              action={
                <button
                  onClick={() => router.push(routePatrimonio("contas"))}
                  className="min-h-11 px-2 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Ver todas
                </button>
              }
            />
            {checkingAccounts.length > 0 ? (
              <div className="mt-2.5 overflow-hidden rounded-[20px] border border-border-subtle bg-surface-1 shadow-card">
                <ul
                  aria-label="Contas conectadas"
                  className="m-0 list-none divide-y divide-[var(--hairline)] p-0"
                >
                  {checkingAccounts.map((account) => {
                    const a = appearance[account.id] ?? {};
                    const institution = resolveAccountPresentation(account, a).institution;
                    const kindLabel = accountKindLabels[account.kind] ?? "Conta";
                    const sharePct =
                      checkingPositiveTotal > 0 && account.balanceCents > 0
                        ? Math.round((account.balanceCents / checkingPositiveTotal) * 100)
                        : 0;
                    const barColor = institution?.colors.primary ?? "var(--primary)";

                    return (
                      <li key={account.id}>
                        <button
                          type="button"
                          onClick={() =>
                            router.push(routePatrimonio("contas", { accountId: account.id }))
                          }
                          aria-label={`Abrir ${account.name} em Contas`}
                          className="group flex min-h-[68px] w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/60 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                        >
                          <InstitutionMark
                            institution={institution}
                            size="md"
                            className="ring-1 ring-black/5 dark:ring-white/10"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] font-semibold text-text-primary">
                              {account.name}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-text-muted">
                              {kindLabel}
                              {!hidden && sharePct > 0 ? ` · ${sharePct}%` : ""}
                            </span>
                            {sharePct > 0 && (
                              <span
                                aria-hidden="true"
                                className="mt-1.5 block h-1 w-full max-w-[132px] overflow-hidden rounded-full bg-surface-2"
                              >
                                <span
                                  className="block h-full rounded-full transition-all duration-300"
                                  style={{
                                    width: `${hidden ? 0 : Math.max(6, sharePct)}%`,
                                    backgroundColor: barColor,
                                  }}
                                />
                              </span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className="text-money tabular text-[14px] font-bold text-text-primary">
                              {hidden ? "••••" : formatBRL(account.balanceCents)}
                            </span>
                            <ChevronRight
                              size={15}
                              aria-hidden="true"
                              className="text-text-muted transition-transform group-hover:translate-x-0.5"
                            />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex items-center justify-between border-t border-[var(--hairline)] bg-surface-2/40 px-4 py-2.5 text-xs">
                  <span className="font-medium text-text-muted">Total em contas</span>
                  <span className="text-money tabular font-semibold text-text-secondary">
                    {hidden ? "••••" : formatBRL(checkingTotalCents)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-2.5 flex min-h-14 items-center justify-between gap-3 rounded-[20px] border border-dashed border-border-medium bg-surface-1 px-4 py-3 text-sm text-text-muted">
                <span>Nenhuma conta conectada</span>
                <button
                  onClick={() => router.push(routePatrimonio("contas"))}
                  className="min-h-11 shrink-0 px-2 font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Adicionar conta
                </button>
              </div>
            )}
          </section>
        </>
      ),
    },
    "home-recent": {
      title: "Últimos lançamentos",
      node: (
        <RecentTransactionsCard
          transactions={transactions}
          categories={categories}
          accounts={accounts}
          hidden={hidden}
          onOpenRecords={() => router.push("/registros")}
          onNewTransaction={() =>
            window.dispatchEvent(
              new CustomEvent("pwa:open-tx", { detail: { kind: "expense" } }),
            )
          }
        />
      ),
    },
    "home-cards": {
      title: "Cartões",
      node: (
        <>
          <section className="mt-6">
            <SectionHeader
              title="Cartões"
              action={
                <button
                  onClick={() => router.push(routePatrimonio("cartoes"))}
                  className="min-h-11 px-2 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Ver todos
                </button>
              }
            />
            {cards.length > 0 ? (() => {
              const totalCardsOutstanding = cards.reduce(
                (s, item) => s + item.outstanding,
                0,
              );
              return (
                <div className="mt-2.5 overflow-hidden rounded-[20px] border border-border-subtle bg-surface-1 shadow-card">
                  <ul
                    aria-label="Cartões conectados"
                    className="m-0 list-none divide-y divide-[var(--hairline)] p-0"
                  >
                    {cards.map(({ card, outstanding, limit }) => {
                      const a = appearance[card.id] ?? {};
                      const presentation = resolveAccountPresentation(card, a);
                      const institution = presentation.institution;
                      const product =
                        presentation.product ??
                        getCardProduct(a.cardProductId ?? card.cardProductId ?? "");
                      const displayName = a.customCardName ?? card.name;
                      const usagePct =
                        limit > 0
                          ? Math.min(100, Math.round((outstanding / limit) * 100))
                          : 0;
                      const availableCents = Math.max(0, limit - outstanding);
                      const swatchBg = product
                        ? `linear-gradient(135deg, ${product.colors.base} 0%, ${product.colors.accent} 100%)`
                        : institution
                          ? `linear-gradient(135deg, ${institution.colors.primary} 0%, ${institution.colors.secondary} 100%)`
                          : "linear-gradient(135deg, #1F2A27 0%, #0E8C5A 100%)";

                      return (
                        <li key={card.id}>
                          <button
                            type="button"
                            onClick={() =>
                              router.push(
                                routePatrimonio("cartoes", {
                                  cardId: card.id,
                                }),
                              )
                            }
                            aria-label={`Abrir ${displayName} em Cartões`}
                            className="group flex min-h-[72px] w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/60 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                          >
                            <span
                              aria-hidden="true"
                              className="relative flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[10px] shadow-xs ring-1 ring-black/15 dark:ring-white/15"
                              style={{ background: swatchBg }}
                            >
                              <span className="pointer-events-none absolute -right-2 -top-2 h-6 w-6 rounded-full bg-white/15" />
                              <span className="absolute left-1.5 top-1.5 h-1.5 w-2 rounded-[2px] bg-amber-200/80" />
                              <InstitutionMark
                                institution={institution}
                                size="sm"
                                className="scale-90 ring-1 ring-white/25 shadow-xs"
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14px] font-semibold text-text-primary">
                                {displayName}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-text-muted">
                                {limit > 0
                                  ? `Disp. ${hidden ? "••••" : formatBRL(availableCents)}${card.dueDay ? ` · vence dia ${card.dueDay}` : ""}`
                                  : card.dueDay
                                    ? `Vence dia ${card.dueDay}`
                                    : "Cartão de crédito"}
                              </span>
                              {limit > 0 && (
                                <span className="mt-1.5 flex items-center gap-2">
                                  <span
                                    aria-hidden="true"
                                    className="block h-1.5 w-full max-w-[140px] overflow-hidden rounded-full bg-surface-2"
                                  >
                                    <span
                                      className={`block h-full rounded-full transition-all duration-300 ${
                                        usagePct >= 85
                                          ? "bg-danger"
                                          : usagePct >= 65
                                            ? "bg-warning"
                                            : "bg-primary"
                                      }`}
                                      style={{
                                        width: `${hidden ? 0 : Math.max(4, usagePct)}%`,
                                      }}
                                    />
                                  </span>
                                  {!hidden && (
                                    <span className="text-[11px] font-medium tabular text-text-muted">
                                      {usagePct}%
                                    </span>
                                  )}
                                </span>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              <span className="text-money tabular text-[14px] font-bold text-text-primary">
                                {hidden ? "••••" : formatBRL(outstanding)}
                              </span>
                              <ChevronRight
                                size={15}
                                aria-hidden="true"
                                className="text-text-muted transition-transform group-hover:translate-x-0.5"
                              />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex items-center justify-between border-t border-[var(--hairline)] bg-surface-2/40 px-4 py-2.5 text-xs">
                    <span className="font-medium text-text-muted">
                      {cards.length > 1
                        ? `Total em faturas (${cards.length} cartões)`
                        : "Total em faturas"}
                    </span>
                    <span className="text-money tabular font-semibold text-text-secondary">
                      {hidden ? "••••" : formatBRL(totalCardsOutstanding)}
                    </span>
                  </div>
                </div>
              );
            })() : (
              <div className="mt-2.5 flex min-h-14 items-center justify-between gap-3 rounded-[20px] border border-dashed border-border-medium bg-surface-1 px-4 py-3 text-sm text-text-muted">
                <span>Nenhum cartão conectado</span>
                <button
                  onClick={() => router.push(routePatrimonio("cartoes"))}
                  className="min-h-11 shrink-0 px-2 font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Adicionar cartão
                </button>
              </div>
            )}
          </section>
        </>
      ),
    },
    "home-planning": {
      title: "Metas e orçamentos",
      node: (
        <GoalsAndBudgetsCard
          budgets={budgets}
          goals={goals}
          transactions={transactions}
          hidden={hidden}
          onOpenBudgets={() => router.push(routePlanejamento("orcamentos"))}
          onOpenGoals={() => router.push(routePlanejamento("metas"))}
        />
      ),
    },
    "home-commitments": {
      title: "Compromissos",
      node: (
        <>
          <section className="mt-6">
            <SectionHeader
              title="Compromissos"
              action={
                <button
                  onClick={() => router.push(routeCompromissos("a-pagar"))}
                  className="min-h-11 px-2 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Ver todos
                </button>
              }
            />
            {pendingPayables.length > 0 ? (() => {
              const pendingTotalCents = pendingPayables.reduce(
                (s, p) => s + p.amountCents,
                0,
              );
              return (
                <div className="mt-2.5 overflow-hidden rounded-[20px] border border-border-subtle bg-surface-1 shadow-card">
                  <ul
                    aria-label="Compromissos pendentes"
                    className="m-0 list-none divide-y divide-[var(--hairline)] p-0"
                  >
                    {pendingPayables.map((p) => {
                      const isOverdue =
                        p.dueDate < todayKey || p.status === "overdue";
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() =>
                              router.push(routeCompromissos("a-pagar"))
                            }
                            aria-label={`Abrir ${p.description} em Contas a pagar`}
                            className="group flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                          >
                            <time
                              dateTime={p.dueDate}
                              className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl text-xs tabular ${
                                isOverdue
                                  ? "bg-danger-tint text-danger"
                                  : "bg-surface-2 text-text-secondary"
                              }`}
                            >
                              <span className="text-[13px] font-bold leading-none">
                                {dateLabel(p.dueDate).slice(0, 2)}
                              </span>
                              <span className="mt-0.5 text-[9px] font-bold tracking-wider">
                                {monthShortLabel(p.dueDate)}
                              </span>
                            </time>

                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14px] font-semibold text-text-primary">
                                {p.description}
                              </span>
                              <span className="mt-1 inline-flex items-center">
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                    isOverdue
                                      ? "bg-danger-tint text-danger"
                                      : "bg-warning-tint text-warning"
                                  }`}
                                >
                                  {isOverdue ? "Vencida" : "Pendente"}
                                </span>
                              </span>
                            </span>

                            <span className="flex shrink-0 items-center gap-1.5">
                              <span
                                className={`text-money tabular text-[14px] font-bold ${
                                  isOverdue ? "text-danger" : "text-text-primary"
                                }`}
                              >
                                {hidden ? "••••" : formatBRL(p.amountCents)}
                              </span>
                              <ChevronRight
                                size={15}
                                aria-hidden="true"
                                className="text-text-muted transition-transform group-hover:translate-x-0.5"
                              />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex items-center justify-between border-t border-[var(--hairline)] bg-surface-2/40 px-4 py-2.5 text-xs">
                    <span className="font-medium text-text-muted">
                      Total pendente
                    </span>
                    <span className="text-money tabular font-semibold text-text-secondary">
                      {hidden ? "••••" : formatBRL(pendingTotalCents)}
                    </span>
                  </div>
                </div>
              );
            })() : (
              <div className="mt-2.5 flex min-h-14 items-center rounded-[20px] border border-dashed border-border-medium bg-surface-1 px-4 py-3 text-sm text-text-muted">
                Nada por aqui
              </div>
            )}
          </section>
        </>
      ),
    },
    "home-categories": {
      title: "Por categoria",
      node: (
        <>
          <section className="mt-6">
            <SectionHeader
              title="Por categoria"
              meta={
                activeHasCategoryTotal
                  ? `${hidden ? "••••" : formatBRL(activeCategoryTotal)} no mês`
                  : undefined
              }
            />
            <div className="mt-2.5 rounded-[20px] border border-border-subtle bg-surface-1 p-4 sm:p-5 shadow-card">
              <div
                role="group"
                aria-label="Tipo de categoria"
                className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1"
              >
                <button
                  type="button"
                  aria-pressed={categoryTab === "expense"}
                  onClick={() => setCategoryTab("expense")}
                  className={`flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    categoryTab === "expense"
                      ? "bg-surface-1 text-text-primary shadow-xs"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  <span>Despesas</span>
                  <span className="text-money tabular text-[11px] font-semibold">
                    {hidden ? "••••" : formatBRL(expenseTotalForTab)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={categoryTab === "income"}
                  onClick={() => setCategoryTab("income")}
                  className={`flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    categoryTab === "income"
                      ? "bg-surface-1 text-text-primary shadow-xs"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  <span>Receitas</span>
                  <span className="text-money tabular text-[11px] font-semibold">
                    {hidden ? "••••" : formatBRL(incomeTotalForTab)}
                  </span>
                </button>
              </div>

              {categoriesForBand.length > 0 ? (
                <div className="mt-4">
                  <ProportionBand
                    segments={categoriesForBand.map((item, i) => ({
                      label: item.name,
                      pct: Math.round(item.pct),
                      colorToken: [
                        "cat-1",
                        "cat-2",
                        "cat-3",
                        "cat-4",
                        "cat-5",
                      ][i % 5]!,
                      amount: hidden ? "••••" : formatBRL(item.amountCents),
                    }))}
                  />
                </div>
              ) : (
                <p className="mt-4 py-3 text-center text-sm text-text-muted">
                  {categoryTab === "expense"
                    ? "Sem despesas no período"
                    : "Sem receitas no período"}
                </p>
              )}
            </div>
          </section>
        </>
      ),
    },
    "home-monthly-comparison": {
      title: "Comparativo mensal",
      node: (
        <MonthlyComparisonCard
          points={monthlyComparison}
          hidden={hidden}
          onOpenReports={() => router.push("/hub/relatorios")}
        />
      ),
    },
  };
  const visibleNodes = layout.visible.map((id) => <Fragment key={id}>{blocks[id]?.node}</Fragment>);
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <StatusBar />
      <StaleBanner
        domains={["accounts", "transactions", "payables", "budgets"]}
        onRetry={() => router.refresh()}
        onSnapshotRefresh={handleSnapshotSummaryRefresh}
      />
      {summaryError && (
        <div
          data-testid="home-summary-error"
          role="alert"
          className="mx-5 mt-2 flex items-center justify-between gap-2 rounded-[12px] bg-warning-tint px-4 py-2.5 text-[12px] font-semibold text-warning"
        >
          <span>{summaryError}</span>
          <button
            onClick={() => void handleSnapshotSummaryRefresh()}
            disabled={summaryRetrying}
          >
            Tentar novamente
          </button>
        </div>
      )}
      {state.error && (
        <div
          role="alert"
          className="mx-5 mt-2 flex items-center gap-2 rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger"
        >
          <AlertCircle size={15} aria-hidden="true" />
          {state.error}
        </div>
      )}
      <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col overflow-y-auto px-5 pb-[calc(9rem+env(safe-area-inset-bottom))] sm:px-8 lg:pb-0">
        <PullToRefreshIndicator state={pull} />
        <header className="flex items-center justify-between gap-2 pb-4 pt-[calc(1rem+env(safe-area-inset-top))]">
          <button
            type="button"
            aria-label="Abrir perfil"
            onClick={() => router.push("/perfil")}
            className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-full pr-2 text-left transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-white shadow-xs ring-2 ring-surface-1"
              style={{ backgroundColor: profile.avatarColor || "var(--primary)" }}
              aria-hidden="true"
            >
              {profileInitials(profile.name)}
            </span>
            <h1 className="truncate text-[16px] font-bold tracking-tight text-text-primary">
              {firstName}
            </h1>
          </button>

          <div className="flex shrink-0 items-center gap-1.5">
            <div className="lg:hidden">
              <WorkspaceSwitcher compact align="right" />
            </div>

            <button
              type="button"
              aria-label="Notificações"
              onClick={() => setNotificationsOpen(true)}
              className="relative flex h-11 w-11 items-center justify-center rounded-full border border-border-subtle bg-surface-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Bell size={19} aria-hidden="true" />
              {totalAlertBadge > 0 && (
                <span
                  className={`absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white ring-2 ring-bg ${
                    hasOverdueAttention ? "bg-danger" : "bg-warning"
                  }`}
                >
                  {totalAlertBadge > 9 ? "9+" : totalAlertBadge}
                </span>
              )}
            </button>

            <HomeFloatingMenu onOpenCustomize={() => setCustomizing(true)} />
          </div>
        </header>

        <section
          aria-label="Saldo total"
          className="relative overflow-hidden rounded-[22px] border border-border-subtle bg-surface-1 shadow-card"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full bg-primary/10 blur-2xl"
          />
          <div className="relative p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold text-text-muted">
                  Saldo total em contas
                </p>
                <span className="inline-flex items-center gap-1 rounded-full bg-primary-tint px-2 py-0.5 text-[10px] font-bold text-primary">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                  Disponível agora
                </span>
              </div>
              <button
                type="button"
                onClick={toggle}
                aria-pressed={hidden}
                aria-label={hidden ? "Mostrar saldos" : "Ocultar saldos"}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2/80 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            <p className="text-money tabular mt-1 text-[length:var(--text-money-hero)] font-bold leading-[var(--text-money-hero-line-height)] tracking-tight text-text-primary">
              {totalBalance === null ? (
                "-"
              ) : hidden ? (
                <>
                  <span data-testid="balance-hidden" aria-hidden="true">
                    ••••••
                  </span>
                  <span className="sr-only">Saldo oculto</span>
                </>
              ) : (
                formatBRL(animatedBalance)
              )}
            </p>

            <div className="mt-4 flex items-center justify-between gap-2 border-t border-[var(--hairline)] pt-3 text-xs">
              <span className="font-medium text-text-muted">
                {cards.length > 0
                  ? `${checkingAccounts.length} ${checkingAccounts.length === 1 ? "conta" : "contas"} · ${cards.length} ${cards.length === 1 ? "cartão" : "cartões"}`
                  : `${checkingAccounts.length} ${checkingAccounts.length === 1 ? "conta conectada" : "contas conectadas"}`}
              </span>
              <button
                type="button"
                onClick={() => router.push(routePatrimonio("contas"))}
                className="inline-flex items-center gap-0.5 font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Ver contas
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

        </section>

        {visibleNodes}

        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={() => setCustomizing(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-subtle bg-surface-1 px-4 py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            Personalizar início
          </button>
        </div>
      </main>
      <BottomSheet open={customizing} onClose={() => setCustomizing(false)} title="Personalizar início">
        <div className="mb-4 grid grid-cols-2 rounded-xl bg-surface-2 p-1" aria-label="Modo de exibição">
          {(["essential", "complete"] as const).map((mode) => <button key={mode} type="button" aria-pressed={layout.mode === mode} onClick={() => layout.setMode(mode)} className="min-h-11 rounded-lg px-3 text-sm font-semibold aria-pressed:bg-surface-1">{mode === "essential" ? "Essencial" : "Completa"}</button>)}
        </div>
        <ol className="space-y-1" aria-label="Blocos da página inicial">
          {layout.state.order.map((id, index) => <li key={id} ref={(node) => { if (node) rowRefs.current.set(id, node); else rowRefs.current.delete(id); }} className={`flex items-center gap-1 rounded-xl border border-border-subtle p-2 transition-transform duration-150 motion-reduce:transition-none ${draggingId === id ? "scale-[1.01] opacity-70" : ""}`}>
            <button type="button" aria-label={`Arrastar ${blocks[id]?.title}`} className="touch-none cursor-grab p-2" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { id, pointerId: event.pointerId, index }; setDraggingId(id); }} onPointerMove={(event) => { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const target = layout.state.order.findIndex((item) => { const rect = rowRefs.current.get(item)?.getBoundingClientRect(); return rect ? event.clientY < rect.top + rect.height / 2 : false; }); drag.index = target < 0 ? layout.state.order.length - 1 : target; }} onPointerUp={(event) => { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const target = drag.index; layout.reorder(drag.id, target); setAnnouncement(`${blocks[drag.id]?.title} movido para a posição ${target + 1}`); dragRef.current = null; setDraggingId(null); }} onPointerCancel={() => { dragRef.current = null; setDraggingId(null); }}><GripVertical size={18} aria-hidden="true" /></button>
            <span className="min-w-0 flex-1 text-sm font-medium">{blocks[id]?.title}</span>
            <button type="button" aria-label={`Mover ${blocks[id]?.title} para cima`} disabled={index === 0} onClick={() => { layout.move(id, -1); setAnnouncement(`${blocks[id]?.title} movido para a posição ${index}`); }} className="min-h-11 min-w-10 disabled:opacity-40"><ChevronUp size={18} /></button>
            <button type="button" aria-label={`Mover ${blocks[id]?.title} para baixo`} disabled={index === layout.state.order.length - 1} onClick={() => { layout.move(id, 1); setAnnouncement(`${blocks[id]?.title} movido para a posição ${index + 2}`); }} className="min-h-11 min-w-10 disabled:opacity-40"><ChevronDown size={18} /></button>
            <button type="button" aria-pressed={!layout.state.hidden.includes(id)} aria-label={`${layout.state.hidden.includes(id) ? "Mostrar" : "Ocultar"} ${blocks[id]?.title}`} onClick={() => layout.toggle(id)} className="min-h-11 px-2 text-xs font-semibold text-primary">{layout.state.hidden.includes(id) ? "Mostrar" : "Ocultar"}</button>
          </li>)}
        </ol>
        <p className="sr-only" aria-live="polite">{announcement}</p>
        <button type="button" onClick={layout.reset} className="mt-4 min-h-11 w-full font-semibold text-primary">Restaurar padrão</button>
      </BottomSheet>
      <NotificationsSheet
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
    </div>
  );
}
