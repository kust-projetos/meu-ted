"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import BottomSheet from "@/components/BottomSheet";
import { WriteErrorBanner } from "@/components/WriteErrorBanner";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { StaleBanner } from "@/components/StaleBanner";
import Skeleton from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { TransactionActionSheet } from "./components/TransactionActionSheet";
import { TransactionEditSheet } from "./components/TransactionEditSheet";
import { CategoryBadge } from "@/components/ui/CategoryBadge";
import { useAppState } from "@/lib/state/app-state-context";
import type { Transaction } from "@/lib/state/types";
import { usePullToRefresh, PullToRefreshIndicator } from "@/lib/ui/use-pull-to-refresh";
import { Search, SlidersHorizontal, ChevronRight, ChevronLeft, Plus } from "lucide-react";

type TypeFilter = "all" | "expense" | "income" | "transfer";
type PeriodFilter = "all" | "today" | 7 | 30 | "month" | "custom";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === yesterday.toDateString()) return "Ontem";

  return d.toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "long",
  });
}

interface Group {
  label: string;
  date: string;
  items: Transaction[];
}

export default function RecordsPage() {
  const { transactions, categories, accounts, loading, error, writeError, clearWriteError, retryWriteError, deleteTransaction, refreshDomains } = useAppState();
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletePendingTx, setDeletePendingTx] = useState<Transaction | null>(null);
  const handleRowClick = useCallback((tx: Transaction) => {
    setSelectedTx(tx);
    setActionOpen(true);
  }, []);
  const handleEdit = useCallback((tx: Transaction) => {
    setActionOpen(false);
    setSelectedTx(tx);
    setEditOpen(true);
  }, []);
  const handleDelete = useCallback(
    (tx: Transaction) => {
      setDeletePendingTx(tx);
      setDeleteConfirmOpen(true);
    },
    [],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (deletePendingTx) {
      await deleteTransaction(deletePendingTx.id);
    }
    setDeleteConfirmOpen(false);
    setDeletePendingTx(null);
    setActionOpen(false);
    setSelectedTx(null);
  }, [deletePendingTx, deleteTransaction]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirmOpen(false);
    setDeletePendingTx(null);
  }, []);
  const [staleDismissed, setStaleDismissed] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [filterPage, setFilterPage] = useState<"main" | "category">("main");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const rawType = params.get("type");
    if (rawType === "expense" || rawType === "income" || rawType === "transfer") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTypeFilter(rawType);
    }
    const cat = params.get("categoryId");
    if (cat) {
      setCategoryFilter(cat);
    }
    const acct = params.get("accountId");
    if (acct) {
      setAccountFilter(acct);
    }
  }, []);

  const filtered = useMemo(() => {
    let result = [...transactions];

    if (typeFilter !== "all") {
      result = result.filter((t) => t.kind === typeFilter);
    }

    if (periodFilter !== "all") {
      const today = new Date();
      let cutoff: Date;
      if (periodFilter === "today") {
        cutoff = new Date(today.toISOString().slice(0, 10) + "T00:00:00");
      } else if (periodFilter === "month") {
        cutoff = new Date(today.getFullYear(), today.getMonth(), 1);
      } else if (periodFilter === "custom") {
        cutoff = new Date("1970-01-01");
      } else {
        cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - periodFilter);
      }
      result = result.filter(
        (t) => new Date(t.date + "T12:00:00") >= cutoff,
      );
    }

    if (periodFilter === "custom") {
      if (customStartDate) {
        result = result.filter((t) => t.date >= customStartDate);
      }
      if (customEndDate) {
        result = result.filter((t) => t.date <= customEndDate);
      }
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.description.toLowerCase().includes(q) ||
          (t.recipientName?.toLowerCase().includes(q) ?? false),
      );
    }

    if (accountFilter) {
      result = result.filter((t) => t.accountId === accountFilter);
    }

    if (categoryFilter) {
      result = result.filter((t) => t.categoryId === categoryFilter);
    }

    result.sort((a, b) => b.date.localeCompare(a.date));
    return result;
  }, [transactions, typeFilter, periodFilter, search, categoryFilter, accountFilter, customStartDate, customEndDate]);

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const tx of filtered) {
      const existing = map.get(tx.date) ?? [];
      existing.push(tx);
      map.set(tx.date, existing);
    }
    const result: Group[] = [];
    for (const [date, items] of map) {
      result.push({ label: formatDateLabel(date), date, items });
    }
    result.sort((a, b) => b.date.localeCompare(a.date));
    return result;
  }, [filtered]);

  function getCategoryName(categoryId: string): string {
    return categories.find((c) => c.id === categoryId)?.name ?? "";
  }

  function getAccountName(accountId: string): string {
    return accounts.find((a) => a.id === accountId)?.name ?? "";
  }

  const chips: { key: TypeFilter; label: string }[] = [
    { key: "all", label: "Tudo" },
    { key: "expense", label: "Despesas" },
    { key: "income", label: "Receitas" },
    { key: "transfer", label: "Transf." },
  ];

  // A4: copy distinta conforme há filtro/busca ativos ou não.
  const hasActiveFilter =
    typeFilter !== "all" ||
    periodFilter !== "all" ||
    search.trim() !== "" ||
    accountFilter !== null ||
    categoryFilter !== null ||
    customStartDate !== "" ||
    customEndDate !== "";

  const clearAllFilters = useCallback(() => {
    setTypeFilter("all");
    setPeriodFilter("all");
    setCategoryFilter(null);
    setAccountFilter(null);
    setCustomStartDate("");
    setCustomEndDate("");
    setSearch("");
  }, []);

  // Reusa o fluxo existente de novo lançamento (AppShell escuta "pwa:open-tx").
  const handleNewTransaction = useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("pwa:open-tx", { detail: { kind: "expense" } }),
      );
    }
  }, []);

  // F4 pull-to-refresh: revalida os domínios exibidos nesta tela.
  const handleRefresh = useCallback(
    async () => {
      await refreshDomains(["transactions", "accounts"]);
    },
    [refreshDomains],
  );
  const pull = usePullToRefresh({ onRefresh: handleRefresh });

  const periodChips: { key: PeriodFilter; label: string }[] = [
    { key: "today", label: "Hoje" },
    { key: 7, label: "7d" },
    { key: 30, label: "30d" },
    { key: "month", label: "Este mês" },
    { key: "custom", label: "Personalizado" },
  ];

  if (loading) {
    return (
      <div className="flex min-h-dvh flex-col bg-bg">
        <StatusBar />
        <PageHeader title="Extrato" />
        <main className="flex flex-1 flex-col gap-3 px-5 pb-[var(--tab-bar-height)] sm:px-8 lg:px-12">
          <Skeleton variant="card" height={42} />
          <div className="flex gap-2">
            <Skeleton width={64} height={30} />
            <Skeleton width={88} height={30} />
            <Skeleton width={80} height={30} />
            <Skeleton width={56} height={30} />
            <Skeleton width={56} height={30} />
          </div>
          {[0, 1, 2].map((g) => (
            <div key={g} className="flex flex-col gap-2">
              <Skeleton variant="text" width={70} height={10} />
              <div className="overflow-hidden rounded-[18px] border border-border-subtle bg-surface-1">
                {[0, 1, 2].map((r) => (
                  <div
                    key={r}
                    className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-none"
                  >
                    <Skeleton variant="circle" width={38} height={38} />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Skeleton variant="text" width="70%" />
                      <Skeleton variant="text" width="40%" height={9} />
                    </div>
                    <Skeleton variant="text" width={70} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <StatusBar />
      <main className="flex flex-1 flex-col pb-[var(--tab-bar-height)]">
        <PullToRefreshIndicator state={pull} />
        <PageHeader title="Extrato" />

        {error && (
          <div className="mx-5 mb-3 rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger">
            ⚠ {error}
          </div>
        )}

        <WriteErrorBanner
          message={writeError}
          onDismiss={clearWriteError}
          onRetry={retryWriteError ?? undefined}
        />

        {!staleDismissed && (
          <StaleBanner
            domains={["transactions", "categories", "accounts"]}
            onDismiss={() => setStaleDismissed(true)}
          />
        )}

        {/* Search */}
        <div className="mx-5 mb-3 sm:mx-8 lg:mx-12">
          <div className="flex items-center gap-2.5 rounded-[14px] border border-border-subtle bg-surface-1 px-3.5 py-2.5 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 transition-all">
            <Search size={16} className="text-text-muted flex-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar lançamento"
              className="w-full border-none bg-transparent text-[13px] font-medium text-text-primary placeholder:text-text-muted outline-none"
            />
          </div>
        </div>

        {/* Compact filter trigger */}
        <div className="mx-5 mb-3 sm:mx-8 lg:mx-12">
          <button
            data-testid="filter-trigger"
            onClick={() => setFilterOpen(true)}
            className="flex w-full items-center gap-2 rounded-[14px] border border-border-subtle bg-surface-1 px-3.5 py-2.5 text-left text-[13px] font-semibold text-text-primary shadow-sm hover:bg-surface-2 transition-colors"
          >
            <SlidersHorizontal size={15} className="text-text-muted flex-none" />
            <span>Filtro</span>
            {typeFilter !== "all" && (
              <span className="ml-auto rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-bold text-white shadow-xs">
                {chips.find((c) => c.key === typeFilter)?.label}
              </span>
            )}
            {periodFilter !== "all" && periodFilter !== "custom" && (
              <span className="rounded-full bg-surface-2 border border-border-subtle px-2 py-0.5 text-[10px] font-bold text-text-secondary">
                {periodFilter === "today"
                  ? "Hoje"
                  : periodFilter === "month"
                    ? "Este mês"
                    : `${periodFilter}d`}
              </span>
            )}
            {periodFilter === "custom" && (customStartDate || customEndDate) && (
              <span className="rounded-full bg-surface-2 border border-border-subtle px-2 py-0.5 text-[10px] font-bold text-text-secondary">
                Personalizado
              </span>
            )}
            {accountFilter && (
              <span className="rounded-full bg-surface-2 border border-border-subtle px-2 py-0.5 text-[10px] font-bold text-text-secondary">
                {accounts.find((a) => a.id === accountFilter)?.name}
              </span>
            )}
            {categoryFilter && (
              <span className="rounded-full bg-surface-2 border border-border-subtle px-2 py-0.5 text-[10px] font-bold text-text-secondary">
                {categories.find((c) => c.id === categoryFilter)?.name}
              </span>
            )}
          </button>
        </div>

        {/* Filter BottomSheet */}
        <BottomSheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filtros">
          {/* Type */}
          <div className="mb-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">Tipo</div>
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <button
                  key={chip.key}
                  onClick={() => {
                    setTypeFilter(chip.key === typeFilter ? "all" : chip.key);
                    setFilterOpen(false);
                  }}
                  className={`rounded-full px-3.5 py-1.5 text-[12px] font-bold transition-all ${
                    typeFilter === chip.key
                      ? "bg-primary text-white shadow-xs"
                      : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                  }`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          {/* Period */}
          <div className="mb-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">Período</div>
            <div className="flex flex-wrap gap-1.5">
              {periodChips.map((chip) => (
                <button
                  key={String(chip.key)}
                  onClick={() => {
                    setPeriodFilter(chip.key === periodFilter ? "all" : chip.key);
                    if (chip.key !== "custom") setFilterOpen(false);
                  }}
                  className={`rounded-full px-3.5 py-1.5 text-[12px] font-bold transition-all ${
                    periodFilter === chip.key
                      ? "bg-primary text-white shadow-xs"
                      : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                  }`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
            {/* Custom date inputs */}
            {periodFilter === "custom" && (
              <div className="mt-3 flex gap-2">
                <div className="flex-1">
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-text-muted">Data inicial</label>
                  <input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className="w-full rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2 text-[12px] text-text-primary outline-none focus:border-primary"
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-text-muted">Data final</label>
                  <input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    className="w-full rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2 text-[12px] text-text-primary outline-none focus:border-primary"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Category */}
          {categories.length > 0 && (
            <div className="mb-4">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">Categoria</div>
              {filterPage === "main" ? (
                <button
                  data-testid="category-selector-trigger"
                  onClick={() => setFilterPage("category")}
                  className="flex w-full items-center gap-2 rounded-[12px] border border-border-subtle bg-surface-2 px-3.5 py-2.5 text-left text-[13px] font-semibold text-text-primary hover:bg-surface-3 transition-colors"
                >
                  {categoryFilter
                    ? categories.find((c) => c.id === categoryFilter)?.name ?? "Categoria"
                    : "Todas as categorias"}
                  <ChevronRight size={16} className="ml-auto text-text-muted" />
                </button>
              ) : (
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => setFilterPage("main")}
                    className="mb-1 flex items-center gap-1 text-[12px] font-bold text-primary"
                  >
                    <ChevronLeft size={16} />
                    Voltar
                  </button>
                  <button
                    onClick={() => {
                      setCategoryFilter(null);
                      setFilterPage("main");
                    }}
                    className={`w-full rounded-[10px] px-3 py-2 text-left text-[13px] font-semibold transition-colors ${
                      categoryFilter === null ? "bg-primary-tint text-primary font-bold" : "text-text-primary hover:bg-surface-2"
                    }`}
                  >
                    Todas as categorias
                  </button>
                  {categories.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setCategoryFilter(c.id);
                        setFilterPage("main");
                      }}
                      className={`w-full rounded-[10px] px-3 py-2 text-left text-[13px] font-semibold transition-colors ${
                        categoryFilter === c.id ? "bg-primary-tint text-primary font-bold" : "text-text-primary hover:bg-surface-2"
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => {
              setTypeFilter("all");
              setPeriodFilter("all");
              setCategoryFilter(null);
              setFilterOpen(false);
            }}
            className="mt-2 w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 text-[13px] font-bold text-text-secondary hover:bg-surface-3 transition-colors"
          >
            Limpar filtros
          </button>
        </BottomSheet>

        {/* Content */}
        {filtered.length === 0 ? (
          <div className="px-5 py-[50px] text-center sm:px-8 lg:px-12">
            <EmptyState
              icon={<Plus size={24} strokeWidth={2.4} aria-hidden="true" />}
              title={hasActiveFilter ? "Nada encontrado" : "Nenhum lançamento ainda"}
              description={
                hasActiveFilter
                  ? "Ajuste a busca ou os filtros para ver mais resultados."
                  : "Registre sua primeira despesa ou receita para começar a acompanhar."
              }
              action={
                <div className="flex flex-col items-center gap-2">
                  <button
                    type="button"
                    onClick={handleNewTransaction}
                    className="rounded-[14px] bg-primary px-5 py-2.5 text-[13px] font-bold text-white shadow-xs transition-all hover:bg-primary-hover active:scale-[0.98]"
                  >
                    Novo lançamento
                  </button>
                  {hasActiveFilter && (
                    <button
                      type="button"
                      onClick={clearAllFilters}
                      className="rounded-[14px] px-4 py-2 text-[13px] font-bold text-primary transition-colors hover:bg-primary-tint"
                    >
                      Ver tudo
                    </button>
                  )}
                </div>
              }
            />
          </div>
        ) : (
          <div data-testid="records-groups" className="flex flex-col gap-4 px-5 sm:px-8 lg:px-12">
            {groups.map((group) => (
              <div key={group.date}>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">
                  {group.label}
                </div>
                <div className="overflow-hidden rounded-[18px] border border-border-subtle bg-surface-1 shadow-card">
                  {group.items.map((tx) => {
                    const cat = categories.find(
                      (c) => c.id === tx.categoryId,
                    );
                    const amountColor =
                      tx.kind === "expense"
                        ? "var(--color-danger)"
                        : tx.kind === "income"
                          ? "var(--color-primary)"
                          : "var(--color-info)";
                    const prefix =
                      tx.kind === "expense"
                        ? "−"
                        : tx.kind === "income"
                          ? "+"
                          : "";

                    return (
                      <div
                        key={tx.id}
                        onClick={() => handleRowClick(tx)}
                        className="flex cursor-pointer items-center gap-3 border-b border-border-subtle px-4 py-3.5 last:border-none hover:bg-surface-2/60 active:bg-surface-2 transition-colors"
                      >
                        <div className="flex h-10 w-10 flex-none items-center justify-center rounded-[12px] bg-surface-2 shadow-xs">
                          <CategoryBadge
                            name={cat?.name ?? ""}
                            size={22}
                            icon={cat?.icon}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-bold text-text-primary">
                            {tx.description}
                          </div>
                          {tx.notes ? (
                            <div className="truncate text-[11px] text-text-muted">
                              {tx.notes}
                            </div>
                          ) : null}
                          <div className="text-[11px] font-medium text-text-muted">
                            {getCategoryName(tx.categoryId)}
                            {tx.categoryId && " · "}
                            {getAccountName(tx.accountId)}
                          </div>
                        </div>
                        <div
                          className="flex-none font-mono tabular-nums text-[13px] font-bold"
                          style={{ color: amountColor }}
                        >
                          {prefix}
                          {formatBRL(tx.amountCents)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <TransactionActionSheet
        open={actionOpen}
        transaction={selectedTx}
        onClose={() => {
          setActionOpen(false);
          setSelectedTx(null);
        }}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      <TransactionEditSheet
        open={editOpen}
        transaction={selectedTx}
        onClose={() => {
          setEditOpen(false);
          setSelectedTx(null);
        }}
      />

      <ConfirmActionDialog
        open={deleteConfirmOpen}
        title="Excluir lançamento"
        message="Esta ação não pode ser desfeita. Deseja realmente excluir?"
        confirmLabel="Excluir"
        cancelLabel="Cancelar"
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
