"use client";

import { useMemo } from "react";
import Link from "next/link";
import { formatBRL } from "@/lib/format/brl";
import type { Account, CardStatement, Transaction } from "@/lib/state/types";
import { resolveCardOutstanding } from "@/lib/cards/card-debt";
import { routePatrimonio } from "@/lib/routes";

interface CardRow {
  card: Account;
  spent: number;
  limit: number;
  pct: number;
  barColor: string;
}

interface CreditCardsCardProps {
  cards: Account[];
  statements: CardStatement[];
  transactions: Transaction[];
  onOpenCard: (id: string) => void;
}

export function CreditCardsCard({ cards, statements, transactions, onOpenCard }: CreditCardsCardProps) {
  const cardSpending: CardRow[] = useMemo(
    () =>
      cards.map((card) => {
        const stmts = statements
          .filter((s) => s.accountId === card.id)
          .sort((a, b) => b.cycleYearMonth.localeCompare(a.cycleYearMonth));
        // ADR-018: outstanding debt comes from authoritative card.balanceCents
        // when canonical; the latest-statement total is legacy fallback only.
        const statementFallbackCents = stmts[0]?.totalCents ?? transactions
          .filter((t) => t.accountId === card.id && t.kind === "expense")
          .reduce((s, t) => s + t.amountCents, 0);
        const spent = resolveCardOutstanding(card, { statementFallbackCents })
          .outstandingCents;
        const limit = card.creditLimitCents ?? 1;
        const pct = Math.min((spent / limit) * 100, 100);
        const barColor =
          pct > 90
            ? "var(--color-danger)"
            : pct > 70
              ? "var(--color-warning)"
              : "var(--color-primary)";
        return { card, spent, limit, pct, barColor };
      }),
    [cards, statements, transactions],
  );

  if (cards.length === 0) return null;

  const totalCardSpent = cardSpending.reduce((s, c) => s + c.spent, 0);
  const totalCardLimit = cardSpending.reduce((s, c) => s + c.limit, 0);
  const totalCardAvail = totalCardLimit - totalCardSpent;

  return (
    <div className="mb-[14px] rounded-[18px] border border-border-subtle bg-surface-1 px-4 py-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[14px] font-bold text-text-primary">Cartões de crédito</span>
        <Link
          href={routePatrimonio("cartoes")}
          className="text-[11px] font-bold text-primary hover:underline"
        >
          Ver tudo
        </Link>
      </div>

      {/* Aggregate: fatura / limite livre / limite total */}
      <div className="mb-3 flex items-end justify-between rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3">
        <div className="text-center">
          <div className="mb-[2px] text-[10px] font-bold uppercase tracking-wider text-text-muted">Fatura atual</div>
          <div className="font-mono tabular-nums text-[20px] font-bold leading-none text-danger">
            {formatBRL(totalCardSpent)}
          </div>
        </div>
        <div className="text-center">
          <div className="mb-[2px] text-[10px] font-bold uppercase tracking-wider text-text-muted">Limite total</div>
          <div className="font-mono tabular-nums text-[13px] font-semibold text-text-primary">
            {formatBRL(totalCardLimit)}
          </div>
        </div>
        <div className="text-right">
          <div className="mb-[2px] text-[10px] font-bold uppercase tracking-wider text-text-muted">Limite livre</div>
          <div className="font-mono tabular-nums text-[13px] font-bold text-primary">
            {formatBRL(totalCardAvail)}
          </div>
        </div>
      </div>

      {/* Per-card tiles */}
      <div className="flex flex-col gap-2">
        {cardSpending.map((c) => (
          <button
            key={c.card.id}
            type="button"
            data-testid="card-row"
            onClick={() => onOpenCard(c.card.id)}
            aria-label={`Abrir ${c.card.name} em Cartões`}
            className="flex w-full items-center gap-3 rounded-[14px] border border-border-subtle bg-surface-2/60 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2"
          >
            <span
              className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] font-mono text-[11px] font-bold text-white shadow-xs"
              style={{ background: c.card.color ?? "#4A5568" }}
            >
              {(c.card.name ?? "?").charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <span className="truncate text-[13px] font-bold text-text-primary">{c.card.name}</span>
                <span className="rounded-full bg-surface-1 border border-border-subtle px-2 py-0.5 font-mono text-[10px] font-bold text-text-secondary">
                  {c.pct.toFixed(0)}%
                </span>
              </div>
              <div className="h-[5px] rounded-full bg-surface-3 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${c.pct}%`, background: c.barColor }}
                />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-medium text-text-muted">
                {c.card.closingDay && (
                  <span>Fecha dia {c.card.closingDay}</span>
                )}
                {c.card.dueDay && (
                  <span>Vence dia {c.card.dueDay}</span>
                )}
                <span>Limite {formatBRL(c.limit)}</span>
                <span>{formatBRL(c.limit - c.spent)} livre</span>
              </div>
            </div>
            <span className="font-mono tabular-nums text-[13px] font-bold text-danger flex-none">{formatBRL(c.spent)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
