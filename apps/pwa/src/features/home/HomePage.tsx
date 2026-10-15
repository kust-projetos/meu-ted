"use client";

import StatusBar from "@/components/StatusBar";
import { StaleBanner } from "@/components/StaleBanner";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useAppState } from "@/lib/state/app-state-context";
import { usePendingOperations } from "@/lib/state/use-pending-operations";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import { usePullToRefresh, PullToRefreshIndicator } from "@/lib/ui/use-pull-to-refresh";
import NotificationsSheet from "@/features/profile/NotificationsSheet";
import { useEffectiveProfile } from "@/features/profile/hooks";
import { dashboardSummaryGate } from "@/features/dashboard-summary-gate";
import { routeCompromissos, routePatrimonio } from "@/lib/routes";
import { useMonthDeltas } from "./hooks/useMonthDeltas";
import { useCategoryBreakdown } from "./hooks/useCategoryBreakdown";
import { useFallbackInsights } from "./hooks/useFallbackInsights";
import { useHideBalance } from "./hooks/useHideBalance";
import { useAnimatedNumber } from "./hooks/useAnimatedNumber";
import { LoadingScreen } from "./components/LoadingScreen";
import { HeroSection } from "./components/HeroSection";
import { QuickActions, type NewTxKind } from "./components/QuickActions";
import { DeltaCards } from "./components/DeltaCards";
import { AccountsCard } from "./components/AccountsCard";
import { CreditCardsCard } from "./components/CreditCardsCard";
import { PayablesCard } from "./components/PayablesCard";
import { CategoryDonutCard } from "./components/CategoryDonutCard";
import { InsightsCard } from "./components/InsightsCard";

interface HomePageProps {
  onNewTransaction?: (kind: NewTxKind) => void;
}

export default function HomePage({ onNewTransaction }: HomePageProps = {}) {
  const {
    accounts,
    transactions,
    categories,
    payables,
    budgets,
    cardStatements,
    quickInsights,
    dashboardSummary,
    refreshDashboardSummary,
    refreshDashboardSummaryStrict,
    refreshDomains,
    loading,
    error,
  } = useAppState();
  const profile = useEffectiveProfile();
  const router = useRouter();
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  // T5.3 (H-14, SPEC §22): real pending-approvals count from the
  // authoritative Agent listing, scoped to the active workspace. `null`
  // (unknown/error) keeps the hero indicator hidden — never an invented
  // number.
  // FIX-168-R2: o workspace ativo também guarda os reads desta página —
  // sem workspace, nenhum refresh financeiro dispara (zero I/O).
  const workspace = useWorkspaceSafe();
  const hasActiveWorkspace = workspace?.activeWorkspace != null;
  const pendingOperations = usePendingOperations(workspace?.activeWorkspace?.id ?? null);

  // FIX-PWA-HOME-SNAPSHOT-SUMMARY: Home-owned summary recovery. The snapshot
  // StaleBanner owns domain retry via refreshDomains and invokes
  // handleSnapshotSummaryRefresh ONLY after all snapshotted domains go live,
  // so no optimistic/mock summary is attempted when domains fail/offline.
  // Failure state lives HERE (not in the banner) so it survives the banner
  // unmounting to live; retry re-calls the authoritative strict summary
  // without reload and without touching sync/read-only.
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
      // Fail-closed: keep cached domains + read-only banner state, surface a
      // dedicated accessible summary error with its own retry.
      setSummaryError(
        "Não foi possível atualizar o resumo — tente novamente.",
      );
    } finally {
      setSummaryRetrying(false);
    }
  }, [hasActiveWorkspace, refreshDashboardSummary, refreshDashboardSummaryStrict]);

  useEffect(() => {
    // FIX-168-R2: sem workspace ativo, nenhum fetch de resumo (zero I/O).
    if (!dashboardSummary && hasActiveWorkspace && refreshDashboardSummary) {
      refreshDashboardSummary();
    }
  }, [dashboardSummary, hasActiveWorkspace, refreshDashboardSummary]);

  const handleNew = (kind: NewTxKind) => {
    if (onNewTransaction) onNewTransaction(kind);
    else if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("pwa:open-tx", { detail: { kind } }),
      );
    }
  };

  const incomeDeltaPct = useMonthDeltas(transactions, "income");
  const expenseDeltaPct = useMonthDeltas(transactions, "expense");
  const macros = useCategoryBreakdown(transactions, categories);

  const hasServerSummary = dashboardSummaryGate({ serverSummary: dashboardSummary });

  const totalBalance = hasServerSummary
    ? (dashboardSummary?.totalBalanceCents ?? (dashboardSummary as unknown as { totals?: { balanceCents?: number } })?.totals?.balanceCents ?? 0)
    : null;

  const totalIncome = hasServerSummary
    ? (dashboardSummary?.monthIncomeCents ?? (dashboardSummary as unknown as { totals?: { incomeCents?: number } })?.totals?.incomeCents ?? 0)
    : null;

  const totalExpenses = hasServerSummary
    ? (dashboardSummary?.monthExpenseCents ?? (dashboardSummary as unknown as { totals?: { expenseCents?: number } })?.totals?.expenseCents ?? 0)
    : null;

  const netResult = hasServerSummary
    ? (dashboardSummary?.monthNetCents ?? (totalIncome !== null && totalExpenses !== null ? totalIncome - totalExpenses : 0))
    : null;

  const insights = useFallbackInsights({
    transactions,
    budgets,
    payables,
    quickInsights,
    monthIncome: totalIncome,
    monthExpenses: totalExpenses,
    macros,
  });

  const { hidden: balanceHidden, toggle: toggleBalance } = useHideBalance();
  const animatedBalance = useAnimatedNumber(totalBalance ?? 0);

  // PTR (hook do Coder 2): invalida domínios + resumo do servidor.
  const handleRefresh = useCallback(async () => {
    // FIX-168-R2: sem workspace ativo, pull-to-refresh não emite I/O.
    if (!hasActiveWorkspace) return;
    await refreshDomains?.(["accounts", "transactions", "payables", "budgets"]);
    await refreshDashboardSummary?.();
  }, [hasActiveWorkspace, refreshDomains, refreshDashboardSummary]);
  const pull = usePullToRefresh({ onRefresh: handleRefresh });

  if (loading) {
    return <LoadingScreen />;
  }

  const checkingAccounts = accounts.filter((a) => a.kind !== "credit_card");
  const creditCards = accounts.filter((a) => a.kind === "credit_card");

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
          <span className="min-w-0 flex-1">{summaryError}</span>
          <button
            type="button"
            onClick={() => void handleSnapshotSummaryRefresh()}
            disabled={summaryRetrying}
            aria-busy={summaryRetrying}
            aria-label="Tentar atualizar resumo"
            className="flex-none rounded-[8px] border border-warning/40 bg-surface px-2.5 py-1 text-[11px] font-bold text-warning transition-colors hover:bg-warning/10 disabled:opacity-60"
          >
            {summaryRetrying ? "Tentando…" : "Tentar novamente"}
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mx-5 mt-2 flex items-center gap-2 rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger"
        >
          <AlertCircle size={15} className="flex-none text-danger" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <main
        className="flex flex-1 flex-col overflow-y-auto pb-[var(--tab-bar-height)]"
      >
        <PullToRefreshIndicator state={pull} />
        <HeroSection
          profile={profile}
          pendingCount={pendingOperations.pendingCount}
          totalBalance={totalBalance}
          totalIncome={totalIncome}
          totalExpenses={totalExpenses}
          netResult={netResult}
          balanceHidden={balanceHidden}
          onToggleBalance={toggleBalance}
          animatedBalance={animatedBalance}
          onOpenProfile={() => router.push("/perfil")}
          onOpenNotifications={() => setNotificationsOpen(true)}
          hasPendingInsights={insights.length > 0}
        />

        <QuickActions onNew={handleNew} />

        {/* ── Content area ── */}
        {/* pb-24: respiro p/ CTAs finais não colidirem com o FAB do TED (fixed bottom-88px) */}
        <div className="px-5 pb-24 pt-4 sm:px-8 lg:px-12">
          <DeltaCards incomeDeltaPct={incomeDeltaPct} expenseDeltaPct={expenseDeltaPct} />

          <AccountsCard
            accounts={checkingAccounts}
            onOpenAccount={(id) => router.push(routePatrimonio("contas", { accountId: id }))}
            onAddAccount={() => router.push(routePatrimonio("contas"))}
          />

          <CreditCardsCard
            cards={creditCards}
            statements={cardStatements}
            transactions={transactions}
            onOpenCard={(id) => router.push(routePatrimonio("cartoes", { cardId: id }))}
          />

          <PayablesCard payables={payables} onOpen={() => router.push(routeCompromissos("a-pagar"))} />

          <CategoryDonutCard
            macros={macros}
            totalExpenses={totalExpenses}
            onAddExpense={() => handleNew("expense")}
          />

          <InsightsCard insights={insights} />
        </div>
      </main>

      <NotificationsSheet
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
    </div>
  );
}
