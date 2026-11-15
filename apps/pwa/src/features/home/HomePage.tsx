"use client";

import StatusBar from "@/components/StatusBar";
import { StaleBanner } from "@/components/StaleBanner";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Bell, Compass, Eye, EyeOff, Pencil, GripVertical, ChevronUp, ChevronDown } from "lucide-react";
import { useAppState } from "@/lib/state/app-state-context";
import { usePendingOperations } from "@/lib/state/use-pending-operations";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import {
  usePullToRefresh,
  PullToRefreshIndicator,
} from "@/lib/ui/use-pull-to-refresh";
import NotificationsSheet from "@/features/profile/NotificationsSheet";
import { useEffectiveProfile } from "@/features/profile/hooks";
import { dashboardSummaryGate } from "@/features/dashboard-summary-gate";
import { routeCompromissos, routePatrimonio } from "@/lib/routes";
import { formatBRL } from "@/lib/format/brl";
import { useCategoryBreakdown } from "./hooks/useCategoryBreakdown";
import { useFallbackInsights } from "./hooks/useFallbackInsights";
import { useHideBalance } from "./hooks/useHideBalance";
import { useAnimatedNumber } from "./hooks/useAnimatedNumber";
import { LoadingScreen } from "./components/LoadingScreen";
import { TedMark } from "@/components/brand/TedMark";
import { InstitutionMark } from "@/components/brand/InstitutionMark";
import BankCard from "@/components/BankCard";
import { Ledger, LedgerRow } from "@/components/ui/Ledger";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatementPanel } from "@/components/ui/StatementPanel";
import { AttentionChip } from "@/components/ui/AttentionChip";
import { ProportionBand } from "@/components/ui/ProportionBand";
import { InsightLine } from "@/components/ui/InsightLine";
import { getInstitution, resolveInstitution } from "@/lib/institutions/catalog";
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

export default function HomePage() {
  const state = useAppState();
  const {
    accounts,
    transactions,
    categories,
    payables,
    budgets,
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
  const homeSchema = { all: ["home-attention", "home-statement", "home-accounts", "home-cards", "home-commitments", "home-categories"], essentialDefaultHidden: ["home-cards", "home-categories"] };
  const layout = useBlockLayout({ workspaceId, surface: "home", schema: homeSchema });
  const [customizing, setCustomizing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const dragRef = useRef<{ id: string; pointerId: number; index: number } | null>(null);
  const pendingOperations = usePendingOperations(
    workspace?.activeWorkspace?.id ?? null,
  );
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
  const macros = useCategoryBreakdown(transactions, categories);
  const breakdownTotalExpenses = macros.reduce((sum, item) => sum + item.amountCents, 0);
  const insights = useFallbackInsights({
    transactions,
    budgets,
    payables,
    quickInsights,
    monthIncome: totalIncome,
    monthExpenses: totalExpenses,
    macros,
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
        label: `${p.description} vencida`,
        value: dateLabel(p.dueDate),
        date: p.dueDate,
        route: routeCompromissos("a-pagar"),
      })),
    ...payables
      .filter((p) => p.status === "pending" && dueWithinWeek(p.dueDate))
      .map((p) => ({
        key: p.id,
        tone: "warning" as const,
        label: `${p.description} vence ${dateLabel(p.dueDate)}`,
        value: undefined,
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
  const pendingPayables = payables
    .filter((p) => p.status === "pending" || p.status === "overdue")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 4);
  const firstName = profile.name.trim().split(/\s+/)[0] || "por aqui";
  const greeting =
    new Date().getHours() < 12
      ? "Bom dia"
      : new Date().getHours() < 18
        ? "Boa tarde"
        : "Boa noite";
  const month = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
  }).format(new Date());
  const topMacros = macros.slice(0, 4);
  const categoriesForBand = [
    ...topMacros,
    ...(macros.length > 4
      ? [
          {
            name: "Outros",
            amountCents: macros
              .slice(4)
              .reduce((s, item) => s + item.amountCents, 0),
            pct: macros.slice(4).reduce((s, item) => s + item.pct, 0),
          },
        ]
      : []),
  ];
  const topInsight = insights[0];

  const blocks: Record<string, { title: string; node: ReactNode }> = {
    "home-attention": { title: "Atenção", node: <>        {attention.length > 0 && (
          <nav
            aria-label="Itens que precisam de atenção"
            className="no-scrollbar -mx-5 flex snap-x snap-mandatory gap-2 overflow-x-auto px-5 py-4 sm:-mx-8 sm:px-8"
          >
            {attention.map((item) => (
              <AttentionChip
                key={item.key}
                tone={item.tone}
                label={item.label}
                value={item.value}
                onClick={() => router.push(item.route)}
                className="max-w-[90%] shrink-0 snap-start"
              />
            ))}
          </nav>
        )}</> },
    "home-statement": { title: "Fechamento do mês", node: <>        <StatementPanel eyebrow={`Fechamento · ${month} · todas as contas`} className="my-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <p className="text-xs text-[var(--statement-muted)]">Receitas</p>
              <p className="text-money tabular font-semibold">
                {money(totalIncome)}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--statement-muted)]">Despesas</p>
              <p className="text-money tabular font-semibold">
                {money(totalExpenses)}
              </p>
            </div>
            <div className="col-span-2 flex items-end justify-between border-t border-[var(--statement-border)] pt-3">
              <div>
                <p className="text-xs text-[var(--statement-muted)]">
                  Resultado do mês
                </p>
                <p className="text-money tabular text-xl font-semibold">
                  {money(netResult)}
                </p>
              </div>
              {totalIncome !== null &&
                totalIncome > 0 &&
                netResult !== null && (
                  <p className="text-xs text-[var(--statement-muted)]">
                    {Math.round((netResult / totalIncome) * 100)}% das receitas
                  </p>
                )}
            </div>
          </div>
        </StatementPanel></> },
    "home-accounts": { title: "Contas", node: <>        <section className="mt-6">
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
            <Ledger label="Contas conectadas" className="mt-2">
              {checkingAccounts.map((account) => {
                const a = appearance[account.id] ?? {};
                const institution = resolveAccountPresentation(account, a).institution;
                return (
                  <LedgerRow
                    key={account.id}
                    onClick={() => router.push(routePatrimonio("contas", { accountId: account.id }))}
                    aria-label={`Abrir ${account.name} em Contas`}
                    leading={
                      <InstitutionMark institution={institution} size="sm" />
                    }
                    primary={account.name}
                    secondary={
                      account.kind === "checking"
                        ? "Conta corrente"
                        : account.kind === "savings"
                          ? "Poupança"
                          : account.kind === "investment"
                            ? "Investimento"
                            : account.kind === "cash"
                              ? "Dinheiro"
                              : "Conta"
                    }
                    trailing={
                      <span className="tabular">
                        {formatBRL(account.balanceCents)}
                      </span>
                    }
                  />
                );
              })}
            </Ledger>
          ) : (
            <div className="hairline-t mt-2 flex min-h-11 items-center justify-between gap-3 py-2 text-sm text-text-muted">
              <span>Nenhuma conta conectada</span>
              <button
                onClick={() => router.push(routePatrimonio("contas"))}
                className="min-h-11 shrink-0 px-2 font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Adicionar conta
              </button>
            </div>
          )}
        </section></> },
    "home-cards": { title: "Cartões", node: <>        <section className="mt-6">
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
          {cards.length > 0 ? (
            <>
              <div className="mt-3">
                {cards[0] && (
                  <>
                    <BankCard
                      bankId={appearance[cards[0].card.id]?.institutionId}
                      product={getCardProduct(
                        appearance[cards[0].card.id]?.cardProductId ?? "",
                      )}
                      cardName={
                        appearance[cards[0].card.id]?.customCardName ??
                        cards[0].card.name
                      }
                      onClick={() => router.push(routePatrimonio("cartoes", { cardId: cards[0].card.id }))}
                      aria-label={`Abrir ${cards[0].card.name} em Cartões`}
                      compact
                    />
                    <p className="mt-2 text-sm text-text-secondary">
                      {formatBRL(cards[0].outstanding)} de{" "}
                      {formatBRL(cards[0].limit)}
                      {cards[0].card.dueDay
                        ? ` · vence dia ${cards[0].card.dueDay}`
                        : ""}
                    </p>
                  </>
                )}
              </div>
              {cards.length > 1 && (
                <Ledger label="Outros cartões" className="mt-2">
                  {cards.slice(1).map(({ card, outstanding, limit }) => (
                    <LedgerRow
                      key={card.id}
                      onClick={() => router.push(routePatrimonio("cartoes", { cardId: card.id }))}
                      aria-label={`Abrir ${card.name} em Cartões`}
                      primary={card.name}
                      secondary={`Limite ${formatBRL(limit)}${card.dueDay ? ` · vence dia ${card.dueDay}` : ""}`}
                      trailing={
                        <span className="tabular">
                          {formatBRL(outstanding)}
                        </span>
                      }
                    />
                  ))}
                </Ledger>
              )}
            </>
          ) : (
            <div className="hairline-t mt-2 flex min-h-11 items-center justify-between gap-3 py-2 text-sm text-text-muted">
              <span>Nenhum cartão conectado</span>
              <button
                onClick={() => router.push(routePatrimonio("cartoes"))}
                className="min-h-11 shrink-0 px-2 font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Adicionar cartão
              </button>
            </div>
          )}
        </section></> },
    "home-commitments": { title: "Compromissos", node: <>        <section className="mt-6">
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
          {pendingPayables.length > 0 ? (
            <Ledger label="Compromissos pendentes" className="mt-2">
              {pendingPayables.map((p) => (
                <LedgerRow
                  key={p.id}
                  onClick={() => router.push(routeCompromissos("a-pagar"))}
                  aria-label={`Abrir ${p.description} em Contas a pagar`}
                  leading={
                    <time
                      dateTime={p.dueDate}
                      className={`flex h-10 w-10 flex-col items-center justify-center rounded-lg bg-surface-2 text-xs tabular ${p.dueDate < todayKey || p.status === "overdue" ? "text-danger" : "text-text-secondary"}`}
                    >
                      <span>{dateLabel(p.dueDate).slice(0, 2)}</span>
                      <span className="text-[10px]">
                        {dateLabel(p.dueDate).slice(3)}
                      </span>
                    </time>
                  }
                  primary={p.description}
                  secondary={
                    p.dueDate < todayKey || p.status === "overdue"
                      ? "Vencida"
                      : "Pendente"
                  }
                  trailing={
                    <span
                      className={`tabular ${p.dueDate < todayKey || p.status === "overdue" ? "text-danger" : ""}`}
                    >
                      {formatBRL(p.amountCents)}
                    </span>
                  }
                />
              ))}
            </Ledger>
          ) : (
            <p className="hairline-t mt-2 flex min-h-11 items-center py-2 text-sm text-text-muted">
              Nada por aqui
            </p>
          )}
        </section></> },
    "home-categories": { title: "Para onde foi", node: <>        <section className="mt-6">
          <SectionHeader
            title="Para onde foi"
            meta={
              breakdownTotalExpenses === 0 && totalExpenses === null
                ? undefined
                : `${formatBRL(breakdownTotalExpenses > 0 ? breakdownTotalExpenses : totalExpenses!)} no mês`
            }
          />
          {categoriesForBand.length > 0 ? (
            <>
              <div className="mt-3">
                <ProportionBand
                  segments={categoriesForBand.map((item, i) => ({
                    label: item.name,
                    pct: Math.round(item.pct),
                    colorToken: [
                      "primary",
                      "accent-money",
                      "warning",
                      "info",
                      "surface-3",
                    ][i % 5]!,
                    amount: formatBRL(item.amountCents),
                  }))}
                />
              </div>
              {topInsight && (
                <InsightLine
                  className="mt-3"
                  action={
                    <button
                      onClick={() => openTedChat()}
                      className="min-h-11 px-2 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      TED
                    </button>
                  }
                >
                  {topInsight.body}
                </InsightLine>
              )}
            </>
          ) : (
            <p className="hairline-t mt-2 flex min-h-11 items-center py-2 text-sm text-text-muted">
              Sem despesas no período
            </p>
          )}
        </section></> },
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
      <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col overflow-y-auto px-5 pb-[calc(8rem+env(safe-area-inset-bottom))] sm:px-8">
        <PullToRefreshIndicator state={pull} />
        <header className="flex items-center justify-between pb-5 pt-[calc(1rem+env(safe-area-inset-top))]">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-text-primary">
              {greeting}, {firstName}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {attention.length
                ? `${attention.length} itens para hoje`
                : "Tudo em dia."}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Explorar"
              onClick={() => router.push("/hub")}
              className="flex h-11 items-center justify-center gap-1 rounded-full px-2 text-sm font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Compass size={18} aria-hidden="true" />
              Explorar
            </button>
            <button
              aria-label="Abrir perfil"
              onClick={() => router.push("/perfil")}
              className="flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <TedMark size={30} label="" />
            </button>
            <button
              aria-label="Personalizar início"
              onClick={() => setCustomizing(true)}
              className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Pencil size={18} />
            </button>
            <button
              aria-label="Notificações"
              onClick={() => setNotificationsOpen(true)}
              className="relative flex h-11 w-11 items-center justify-center rounded-full text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Bell size={20} />
              {pendingOperations.pendingCount !== null &&
                pendingOperations.pendingCount > 0 && (
                  <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-warning" />
                )}
            </button>
          </div>
        </header>
        <section
          aria-label="Saldo total"
          className="border-b border-[var(--hairline)] pb-5"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-text-muted">
              Saldo total em contas
            </p>
            <button
              onClick={toggle}
              aria-pressed={hidden}
              aria-label={hidden ? "Mostrar saldos" : "Ocultar saldos"}
              className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <p className="text-money tabular text-[length:var(--text-money-hero)] leading-[var(--text-money-hero-line-height)] tracking-tight">
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
          <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
            <span>{cards.length > 0 ? `${accounts.length} contas e cartões` : `${accounts.length} contas conectadas`}</span>
            {pendingOperations.pendingCount !== null &&
              pendingOperations.pendingCount > 0 && (
                <button
                  data-testid="hero-pending-approvals"
                  onClick={() => openTedChat()}
                  className="min-h-11 rounded-full bg-warning-tint px-3 font-semibold text-warning"
                >
                  {pendingOperations.pendingCount} aprovações pendentes
                </button>
              )}
          </div>
        </section>
        {visibleNodes}
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
