"use client";

import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Plus } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { formatBRL } from "@/lib/format/brl";
import type { Account, Category, Transaction } from "@/lib/state/types";

export interface RecentTransactionsCardProps {
  transactions: Transaction[];
  categories: Category[];
  accounts: Account[];
  hidden: boolean;
  onOpenRecords: () => void;
  onNewTransaction: () => void;
}

function formatShortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[3]}/${match[2]}`;
}

export function RecentTransactionsCard({
  transactions,
  categories,
  accounts,
  hidden,
  onOpenRecords,
  onNewTransaction,
}: RecentTransactionsCardProps) {
  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
  const accountMap = new Map(accounts.map((a) => [a.id, a.name]));

  const recent = transactions
    .map((tx, index) => ({ tx, index }))
    .sort((a, b) => b.tx.date.localeCompare(a.tx.date) || a.index - b.index)
    .slice(0, 5)
    .map(({ tx }) => tx);

  return (
    <section className="mt-6">
      <SectionHeader
        title="Últimos lançamentos"
        action={
          <button
            type="button"
            onClick={onOpenRecords}
            className="min-h-11 px-2 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Ver extrato
          </button>
        }
      />

      {recent.length > 0 ? (
        <div className="mt-2.5 overflow-hidden rounded-[20px] border border-border-subtle bg-surface-1 shadow-card">
          <ul
            aria-label="Últimos lançamentos"
            className="m-0 list-none divide-y divide-[var(--hairline)] p-0"
          >
            {recent.map((tx) => {
              const isIncome = tx.kind === "income";
              const isTransfer = tx.kind === "transfer";
              const categoryLabel = isTransfer
                ? "Transferência"
                : categoryMap.get(tx.categoryId) ?? "Outros";
              const accountName = accountMap.get(tx.accountId) ?? "Conta";
              const formattedValue = formatBRL(tx.amountCents);
              const signedValue = isIncome
                ? `+ ${formattedValue}`
                : isTransfer
                  ? formattedValue
                  : `- ${formattedValue}`;

              return (
                <li key={tx.id}>
                  <button
                    type="button"
                    onClick={onOpenRecords}
                    className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                        isIncome
                          ? "bg-success-tint text-success"
                          : isTransfer
                            ? "bg-info-tint text-info"
                            : "bg-danger-tint text-danger"
                      }`}
                    >
                      {isIncome ? (
                        <ArrowDownLeft size={18} />
                      ) : isTransfer ? (
                        <ArrowLeftRight size={17} />
                      ) : (
                        <ArrowUpRight size={18} />
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold text-text-primary">
                        {tx.description}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-text-muted">
                        {categoryLabel} · {accountName} · {formatShortDate(tx.date)}
                      </span>
                    </span>

                    <span
                      className={`text-money tabular shrink-0 text-right text-[14px] font-bold ${
                        hidden
                          ? "text-text-secondary"
                          : isIncome
                            ? "text-success"
                            : isTransfer
                              ? "text-info"
                              : "text-text-primary"
                      }`}
                    >
                      {hidden ? "••••" : signedValue}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="mt-2.5 flex min-h-14 items-center justify-between gap-3 rounded-[20px] border border-dashed border-border-medium bg-surface-1 px-4 py-3 text-sm text-text-muted">
          <span>Nenhum lançamento registrado ainda</span>
          <button
            type="button"
            onClick={onNewTransaction}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 px-2 font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Plus size={15} aria-hidden="true" />
            Novo lançamento
          </button>
        </div>
      )}
    </section>
  );
}

export default RecentTransactionsCard;
