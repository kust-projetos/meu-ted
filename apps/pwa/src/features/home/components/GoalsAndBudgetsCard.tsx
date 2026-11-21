"use client";

import { useState } from "react";
import { ChevronRight, ShieldCheck, Target } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { formatBRL } from "@/lib/format/brl";
import type { Budget, Goal, Transaction } from "@/lib/state/types";

export interface GoalsAndBudgetsCardProps {
  budgets: Budget[];
  goals: Goal[];
  transactions: Transaction[];
  hidden: boolean;
  onOpenBudgets: () => void;
  onOpenGoals: () => void;
}

export function GoalsAndBudgetsCard({
  budgets,
  goals,
  transactions,
  hidden,
  onOpenBudgets,
  onOpenGoals,
}: GoalsAndBudgetsCardProps) {
  const [tab, setTab] = useState<"budgets" | "goals">(
    budgets.length > 0 || goals.length === 0 ? "budgets" : "goals",
  );

  const today = new Date();
  const currentYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

  const budgetRows = budgets
    .filter((b) => b.amountCents > 0)
    .map((b) => {
      const realSpent =
        b.spentCents > 0
          ? b.spentCents
          : transactions
              .filter(
                (t) =>
                  t.kind === "expense" &&
                  t.categoryId === b.categoryId &&
                  t.date.startsWith(currentYm),
              )
              .reduce((sum, t) => sum + t.amountCents, 0);
      const pct = Math.round((realSpent / b.amountCents) * 100);
      return { budget: b, spent: realSpent, pct };
    })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 4);

  const goalRows = goals
    .filter((g) => g.targetAmountCents > 0)
    .map((g) => {
      const pct = Math.min(
        100,
        Math.round((g.currentAmountCents / g.targetAmountCents) * 100),
      );
      const remaining = Math.max(0, g.targetAmountCents - g.currentAmountCents);
      return { goal: g, pct, remaining };
    })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 4);

  return (
    <section className="mt-6">
      <SectionHeader
        title="Metas e orçamentos"
        action={
          <button
            type="button"
            onClick={tab === "budgets" ? onOpenBudgets : onOpenGoals}
            className="min-h-11 px-2 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Planejar
          </button>
        }
      />

      <div className="mt-2.5 overflow-hidden rounded-[20px] border border-border-subtle bg-surface-1 p-4 sm:p-5 shadow-card">
        <div
          role="group"
          aria-label="Metas e orçamentos"
          className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1"
        >
          <button
            type="button"
            aria-pressed={tab === "budgets"}
            onClick={() => setTab("budgets")}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              tab === "budgets"
                ? "bg-surface-1 text-text-primary shadow-xs"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            <span>Orçamentos</span>
            {budgets.length > 0 && (
              <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                {budgets.length}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-pressed={tab === "goals"}
            onClick={() => setTab("goals")}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              tab === "goals"
                ? "bg-surface-1 text-text-primary shadow-xs"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            <span>Metas</span>
            {goals.length > 0 && (
              <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                {goals.length}
              </span>
            )}
          </button>
        </div>

        {tab === "budgets" ? (
          budgetRows.length > 0 ? (
            <div className="mt-4 space-y-4">
              {budgetRows.map(({ budget, spent, pct }) => {
                const overBudget = pct >= 100;
                const nearLimit = !overBudget && pct >= 85;
                const remaining = budget.amountCents - spent;
                const barWidth = hidden ? 0 : Math.min(100, Math.max(4, pct));
                return (
                  <div key={budget.id} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[13px] font-semibold text-text-primary">
                        {budget.name}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          overBudget
                            ? "bg-danger-tint text-danger"
                            : nearLimit
                              ? "bg-warning-tint text-warning"
                              : "bg-surface-2 text-text-secondary"
                        }`}
                      >
                        {overBudget
                          ? `Estourou (${pct}%)`
                          : nearLimit
                            ? `Atenção · ${pct}%`
                            : `${pct}%`}
                      </span>
                    </div>

                    <div
                      aria-hidden="true"
                      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
                    >
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          overBudget
                            ? "bg-danger"
                            : nearLimit
                              ? "bg-warning"
                              : "bg-primary"
                        }`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
                      <span className="text-money tabular">
                        {hidden ? "••••" : formatBRL(spent)} de{" "}
                        {hidden ? "••••" : formatBRL(budget.amountCents)}
                      </span>
                      <span
                        className={`text-money tabular font-semibold ${
                          overBudget ? "text-danger" : "text-text-secondary"
                        }`}
                      >
                        {overBudget
                          ? `Excedeu ${hidden ? "••••" : formatBRL(Math.abs(remaining))}`
                          : `Restam ${hidden ? "••••" : formatBRL(remaining)}`}
                      </span>
                    </div>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={onOpenBudgets}
                className="flex min-h-11 w-full items-center justify-between border-t border-[var(--hairline)] pt-3 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span>Ver todos os orçamentos</span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="mt-4 flex min-h-14 items-center justify-between gap-3 rounded-xl border border-dashed border-border-medium px-3.5 py-2.5 text-sm text-text-muted">
              <span>Nenhum orçamento definido ainda</span>
              <button
                type="button"
                onClick={onOpenBudgets}
                className="min-h-11 shrink-0 px-2 font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Criar orçamento
              </button>
            </div>
          )
        ) : goalRows.length > 0 ? (
          <div className="mt-4 space-y-4">
            {goalRows.map(({ goal, pct, remaining }) => {
              const Icon = goal.goalType === "emergency_fund" ? ShieldCheck : Target;
              const done = pct >= 100;
              return (
                <div key={goal.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-text-primary">
                      <Icon
                        size={15}
                        aria-hidden="true"
                        className="shrink-0 text-primary"
                      />
                      <span className="truncate">{goal.name}</span>
                    </span>
                    <span
                      className={`shrink-0 text-xs font-bold ${
                        done ? "text-success" : "text-primary"
                      }`}
                    >
                      {pct}%
                    </span>
                  </div>

                  <div
                    aria-hidden="true"
                    className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        done ? "bg-success" : "bg-primary"
                      }`}
                      style={{
                        width: `${hidden ? 0 : Math.max(4, pct)}%`,
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
                    <span className="text-money tabular">
                      {hidden ? "••••" : formatBRL(goal.currentAmountCents)} de{" "}
                      {hidden ? "••••" : formatBRL(goal.targetAmountCents)}
                    </span>
                    <span className="text-money tabular font-semibold text-text-secondary">
                      {done
                        ? "Meta atingida!"
                        : `Faltam ${hidden ? "••••" : formatBRL(remaining)}`}
                    </span>
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              onClick={onOpenGoals}
              className="flex min-h-11 w-full items-center justify-between border-t border-[var(--hairline)] pt-3 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span>Ver todas as metas</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="mt-4 flex min-h-14 items-center justify-between gap-3 rounded-xl border border-dashed border-border-medium px-3.5 py-2.5 text-sm text-text-muted">
            <span>Nenhuma meta cadastrada ainda</span>
            <button
              type="button"
              onClick={onOpenGoals}
              className="min-h-11 shrink-0 px-2 font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Criar meta
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export default GoalsAndBudgetsCard;
