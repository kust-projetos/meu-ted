"use client";

import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import { useAppState } from "@/lib/state/app-state-context";
import { ReportsAnalyticsZone } from "./components/ReportsAnalyticsZone";

// H-10: single source of truth. All period/account aggregates come from
// the server-driven ReportsAnalyticsZone (/analytics/* with one explicit
// AccountScope). The legacy client-side computations (hero, monthly flow,
// donut, top categories, net-worth trend, budgets-vs-real) were removed:
// they used a different universe than the zone and could not honor the
// account filter uniformly.
export default function ReportsPage() {
  const { accounts, loading, error } = useAppState();

  if (loading) {
    return (
      <div className="flex min-h-dvh flex-col bg-bg">
        <StatusBar />
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-fill-medium border-t-primary" />
            <span className="text-[13px] font-semibold text-text-muted">
              Carregando...
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <StatusBar />
      <main className="flex flex-1 flex-col pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8">
        <PageHeader title="Relatórios" />
        <div className="flex flex-col gap-3.5 px-5 pt-3 sm:px-8 lg:px-12">
          <ReportsAnalyticsZone accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
        </div>

        {error && (
          <div className="mx-5 mb-3 rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger">
            ⚠ {error}
          </div>
        )}
      </main>
    </div>
  );
}
