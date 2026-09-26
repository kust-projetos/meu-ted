"use client";

import Link from "next/link";
import StatusBar from "@/components/StatusBar";
import Badge from "@/components/ui/Badge";
import { WriteErrorBanner } from "@/components/WriteErrorBanner";
import { StaleBanner } from "@/components/StaleBanner";
import { useAppState } from "@/lib/state/app-state-context";
import { Plus } from "lucide-react";
import { resolveBankPreset } from "@/lib/bank-presets";
import { resolveCardOutstanding } from "@/lib/cards/card-debt";
import { routePatrimonio, routePlanejamento } from "@/lib/routes";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function accountKindLabel(kind: string): string {
  switch (kind) {
    case "checking":
      return "Conta corrente";
    case "savings":
      return "Poupança";
    case "investment":
      return "Investimento";
    case "credit_card":
      return "Cartão";
    default:
      return "Conta";
  }
}

function cardBarColor(pct: number): string {
  if (pct > 90) return "var(--color-danger)";
  if (pct > 70) return "var(--color-warning)";
  return "var(--color-primary)";
}

export default function WalletPage() {
  const { accounts, goals, debts, cardStatements, loading, error, writeError, clearWriteError, retryWriteError } = useAppState();

  if (loading) {
    return (
      <div className="flex min-h-dvh flex-col bg-bg">
        <StatusBar />
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-border-subtle border-t-primary" />
            <span className="text-[13px] font-semibold text-text-muted">Carregando...</span>
          </div>
        </div>
      </div>
    );
  }

  const checkingAccounts = accounts.filter((a) => a.kind !== "credit_card");
  const creditCards = accounts.filter((a) => a.kind === "credit_card");

  const totalBalance = checkingAccounts.reduce(
    (s, a) => s + a.balanceCents,
    0,
  );
  const totalGoalsCurrent = goals.reduce((s, g) => s + g.currentAmountCents, 0);

  const cardSpending = creditCards.map((card) => {
    const openStmt = cardStatements.find(
      (s) => s.accountId === card.id && s.status === "open",
    );
    // ADR-018: net-worth card liability is the authoritative outstanding debt
    // when canonical; the open-statement total is legacy fallback only.
    const spent = resolveCardOutstanding(card, {
      statementFallbackCents: openStmt?.totalCents ?? 0,
    }).outstandingCents;
    return { ...card, spent };
  });
  const totalCardSpent = cardSpending.reduce((s, c) => s + c.spent, 0);

  const totalDebtRemaining = debts.reduce(
    (s, d) => s + (d.totalAmountCents - d.paidAmountCents),
    0,
  );

  const ativos = totalBalance + totalGoalsCurrent;
  const passivos = totalCardSpent + totalDebtRemaining;
  const netWorth = ativos - passivos;

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <StatusBar />
      <main className="flex flex-1 flex-col pb-[var(--tab-bar-height)]">
        {error && (
          <div className="mx-5 mt-2 mb-3 rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger">
            ⚠ {error}
          </div>
        )}

        <WriteErrorBanner message={writeError} onDismiss={clearWriteError} onRetry={retryWriteError ?? undefined} />

        <StaleBanner domains={["accounts", "goals", "cardStatements"]} />

        {/* Hero Titanium */}
        <div
          className="px-5 pt-3 pb-6 text-white sm:px-8 lg:px-12"
          style={{ background: "linear-gradient(165deg, #0F6B45, #0A3A28)" }}
        >
          <div className="my-4 text-[22px] font-bold tracking-tight text-white">Patrimônio</div>
          <div className="mb-1 text-[11px] font-medium text-white/70">
            Patrimônio líquido
          </div>
          <div
            className="mb-4 font-mono tabular-nums text-[36px] sm:text-[42px] font-bold text-white tracking-tight"
            style={{ letterSpacing: "-0.02em" }}
          >
            {formatBRL(netWorth)}
          </div>

          {/* 4 mini-stats */}
          <div className="grid grid-cols-2 gap-2.5">
            <div
              className="rounded-[14px] p-[10px_12px] border border-white/10"
              style={{ background: "rgba(255,255,255,.12)" }}
            >
              <div className="mb-[3px] text-[10px] font-medium text-white/70">
                Saldo em contas
              </div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono tabular-nums text-[13px] font-bold text-white">
                {formatBRL(totalBalance)}
              </div>
            </div>
            <div
              className="rounded-[14px] p-[10px_12px] border border-white/10"
              style={{ background: "rgba(255,255,255,.12)" }}
            >
              <div className="mb-[3px] text-[10px] font-medium text-white/70">
                Reservas / Metas
              </div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono tabular-nums text-[13px] font-bold text-white">
                {formatBRL(totalGoalsCurrent)}
              </div>
            </div>
            <div
              className="rounded-[14px] p-[10px_12px] border border-white/10"
              style={{ background: "rgba(255,255,255,.12)" }}
            >
              <div className="mb-[3px] text-[10px] font-medium text-white/70">
                Faturas abertas
              </div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono tabular-nums text-[13px] font-bold text-[#F9A8A2]">
                −{formatBRL(totalCardSpent)}
              </div>
            </div>
            <div
              className="rounded-[14px] p-[10px_12px] border border-white/10"
              style={{ background: "rgba(255,255,255,.12)" }}
            >
              <div className="mb-[3px] text-[10px] font-medium text-white/70">Dívidas</div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono tabular-nums text-[13px] font-bold text-[#F9A8A2]">
                −{formatBRL(totalDebtRemaining)}
              </div>
            </div>
          </div>
        </div>

        {/* Content sections */}
        <div className="pt-4 px-5 pb-6 sm:px-8 lg:px-12">
          {/* Contas section */}
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-[14px] font-bold text-text-primary">
              Contas
            </span>
            <Link
              href={routePatrimonio("contas")}
              className="text-[11px] font-bold text-primary hover:underline"
            >
              Gerenciar
            </Link>
          </div>

          <div className="mb-5 flex flex-col gap-2.5">
            {checkingAccounts.map((acc) => {
              const preset = resolveBankPreset({ name: acc.name, color: acc.color });
              return (
                <Link
                  key={acc.id}
                  href={routePatrimonio("contas", { accountId: acc.id })}
                  data-bank={preset.id}
                  className="relative flex cursor-pointer items-center gap-3 overflow-hidden rounded-[16px] border bg-surface-1 px-3.5 py-3 shadow-card hover:bg-surface-2/60 transition-colors"
                  style={{ borderColor: `${preset.primaryColor}22`, background: `linear-gradient(90deg, ${preset.primaryColor}0F, transparent 50%), var(--surface-1)` }}
                >
                  <span className="absolute left-0 top-0 h-full w-[4px]" style={{ background: preset.gradient }} aria-hidden="true" />
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[11px] font-black text-white shadow-sm"
                    style={{ background: preset.gradient, color: preset.textColor }}
                    aria-hidden="true"
                  >
                    {preset.shortName.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[14px] font-bold text-text-primary">
                      {acc.name}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
                      <span>{accountKindLabel(acc.kind)}</span>
                      <span className="h-1 w-1 rounded-full bg-border-subtle" />
                      <span style={{ color: preset.primaryColor }}>{preset.name}</span>
                    </div>
                  </div>
                  <div className="font-mono tabular-nums text-[14px] font-bold text-text-primary">
                    {formatBRL(acc.balanceCents)}
                  </div>
                </Link>
              );
            })}

            <Link
              href={routePatrimonio("contas")}
              className="flex items-center justify-center gap-2 rounded-[16px] border border-dashed border-border-subtle bg-surface-1/40 px-3 py-3 text-[13px] font-bold text-text-secondary hover:bg-surface-2 transition-colors"
            >
              <Plus size={16} strokeWidth={2.4} />
              Adicionar conta
            </Link>
          </div>

          {/* Cartões section */}
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-[14px] font-bold text-text-primary">
              Cartões
            </span>
            <Link
              href={routePatrimonio("cartoes")}
              className="text-[11px] font-bold text-primary hover:underline"
            >
              Gerenciar
            </Link>
          </div>

          <div className="flex flex-col gap-2.5">
            {cardSpending.map((card) => {
              const pct =
                card.creditLimitCents && card.creditLimitCents > 0
                  ? Math.min(
                      (card.spent / card.creditLimitCents) * 100,
                      100,
                    )
                  : 0;
              const preset = resolveBankPreset({ name: card.name, color: (card as { color?: string }).color });
              return (
                <Link
                  key={card.id}
                  href={routePatrimonio("cartoes", { cardId: card.id })}
                  data-bank={preset.id}
                  className="relative cursor-pointer overflow-hidden rounded-[16px] border bg-surface-1 px-3.5 py-3 shadow-card hover:bg-surface-2/60 transition-colors"
                  style={{ borderColor: `${preset.primaryColor}22` }}
                >
                  <span className="absolute left-0 top-0 h-full w-[4px]" style={{ background: preset.gradient }} aria-hidden="true" />
                  <div className="mb-2.5 flex items-center gap-3">
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[11px] font-black text-white shadow-sm"
                      style={{ background: preset.gradient, color: preset.textColor }}
                      aria-hidden="true"
                    >
                      {preset.shortName.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-[14px] font-bold text-text-primary">
                        {card.name}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
                        <span>Vence dia {card.dueDay}</span>
                        <span className="h-1 w-1 rounded-full bg-border-subtle" />
                        <span style={{ color: preset.primaryColor }}>{preset.name}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono tabular-nums text-[14px] font-bold text-danger">
                        {formatBRL(card.spent)}
                      </div>
                      <div className="font-mono tabular-nums text-[10px] font-medium text-text-muted">
                        {formatBRL(
                          (card.creditLimitCents ?? 0) - card.spent,
                        )}{" "}
                        livre
                      </div>
                    </div>
                  </div>

                  <div className="h-[6px] rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${pct}%`, background: cardBarColor(pct) }}
                    />
                  </div>
                </Link>
              );
            })}

            <Link
              href={routePatrimonio("cartoes")}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-[16px] border border-dashed border-border-subtle bg-surface-1/40 px-3 py-3 text-[13px] font-bold text-text-secondary hover:bg-surface-2 transition-colors"
            >
              <Plus size={16} strokeWidth={2.4} />
              Adicionar cartão
            </Link>
          </div>

          {/* Reservas / Metas */}
          {goals.length > 0 && (
            <>
              <div className="mb-2.5 mt-6 flex items-center justify-between">
                <span className="text-[14px] font-bold text-text-primary">
                  Reservas / Metas
                </span>
                <Link
                  href={routePlanejamento("metas")}
                  className="text-[11px] font-bold text-primary hover:underline"
                >
                  Ver metas
                </Link>
              </div>
              <div className="mb-6 flex flex-col gap-2.5">
                {goals.map((g) => {
                  const pct =
                    g.targetAmountCents > 0
                      ? Math.min(
                          (g.currentAmountCents / g.targetAmountCents) * 100,
                          100,
                        )
                      : 0;
                  return (
                    <Link
                      key={g.id}
                      href={routePlanejamento("metas")}
                      className="flex items-center gap-3 rounded-[16px] border border-border-subtle bg-surface-1 px-3.5 py-3 shadow-card hover:bg-surface-2/60 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="mb-1 truncate text-[14px] font-bold text-text-primary">
                          {g.name}
                        </div>
                        <div className="h-[6px] rounded-full bg-surface-2 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono tabular-nums text-[13px] font-bold text-text-primary">
                          {formatBRL(g.currentAmountCents)}
                        </div>
                        <div className="font-mono tabular-nums text-[10px] font-medium text-text-muted">
                          de {formatBRL(g.targetAmountCents)}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </>
          )}

          {/* Faturas abertas */}
          {(() => {
            const openStatements: (typeof cardStatements)[0][] = creditCards
              .map((card) =>
                cardStatements.find(
                  (s) =>
                    s.accountId === card.id &&
                    s.status === "open" &&
                    s.totalCents > 0,
                ),
              )
              .filter((s): s is (typeof cardStatements)[0] => s != null);
            if (openStatements.length === 0) return null;
            return (
              <>
                <div className="mb-2.5 mt-6 flex items-center justify-between">
                  <span className="text-[14px] font-bold text-text-primary">
                    Faturas abertas
                  </span>
                </div>
                <div className="mb-6 flex flex-col gap-2.5">
                  {openStatements.map((s) => {
                    const card = creditCards.find(
                      (c) => c.id === s.accountId,
                    );
                    return (
                      <Link
                        key={s.id}
                        href={routePatrimonio("cartoes", { cardId: s.accountId })}
                        className="flex items-center gap-3 rounded-[16px] border border-border-subtle bg-surface-1 px-3.5 py-3 shadow-card hover:bg-surface-2/60 transition-colors"
                      >
                        <Badge
                          label={card?.name ?? "Cartão"}
                          color={card?.color ?? "#4A5568"}
                          size="md"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-[14px] font-bold text-text-primary">
                            {card?.name ?? "Cartão"}
                          </div>
                          <div className="text-[11px] font-medium text-text-muted">
                            Vence {s.dueDate.slice(-2)}/{s.dueDate.slice(5, 7)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-mono tabular-nums text-[14px] font-bold text-danger">
                            {formatBRL(s.totalCents)}
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </>
            );
          })()}

          {/* Dívidas */}
          <div className="mb-2.5 mt-6 flex items-center justify-between">
            <span className="text-[14px] font-bold text-text-primary">
              Dívidas
            </span>
          </div>
          {debts.length === 0 ? (
            <div className="mb-6 rounded-[16px] border border-border-subtle bg-surface-1 px-4 py-5 text-center text-[13px] font-medium text-text-muted">
              Nenhuma dívida registrada.
            </div>
          ) : (
            <div className="mb-6 flex flex-col gap-2.5">
              {debts.map((d) => {
                const remaining = d.totalAmountCents - d.paidAmountCents;
                const pct =
                  d.totalAmountCents > 0
                    ? (d.paidAmountCents / d.totalAmountCents) * 100
                    : 0;
                return (
                  <div
                    key={d.id}
                    className="flex items-center gap-3 rounded-[16px] border border-border-subtle bg-surface-1 px-3.5 py-3 shadow-card"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-[14px] font-bold text-text-primary">
                        {d.name}
                      </div>
                      <div className="mt-1.5 h-[6px] rounded-full bg-surface-2 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${pct}%`,
                            background: "var(--color-primary)",
                          }}
                        />
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono tabular-nums text-[14px] font-bold text-danger">
                        {formatBRL(remaining)}
                      </div>
                      <div className="text-[10px] font-medium text-text-muted">
                        restante
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}