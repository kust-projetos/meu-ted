"use client";

import { ChevronRight, Sparkles } from "lucide-react";
import { formatBRL } from "@/lib/format/brl";
import { routeCompromissos, routePatrimonio, routePlanejamento } from "@/lib/routes";
import type { Account, Payable, QuickInsight } from "@/lib/state/types";
import type { InsightItem } from "../hooks/useFallbackInsights";

export interface AiGuidanceCardProps {
  insights: InsightItem[];
  quickInsights?: QuickInsight[];
  cards: Array<{ card: Account; outstanding: number; limit: number }>;
  payables: Payable[];
  hidden: boolean;
  onNavigate: (route: string) => void;
  onAskTed: () => void;
}

interface GuidanceEntry {
  key: string;
  color: string;
  title: string;
  body: string;
  route?: string;
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function maskMoney(text: string, hidden: boolean): string {
  if (!hidden) return text;
  return text.replace(/R\$\s?[\d.,]+/g, "R$ ••••");
}

function resolveGuidanceRoute(title: string): string | undefined {
  const normalized = normalizeTitle(title);
  if (normalized.includes("orcamento")) return routePlanejamento("orcamentos");
  if (normalized.includes("conta a vencer") || normalized.includes("vencimento")) {
    return routeCompromissos("a-pagar");
  }
  if (normalized.includes("categoria") || normalized.includes("alimenta")) {
    return "/registros";
  }
  if (normalized.includes("cartao") || normalized.includes("limite")) {
    return routePatrimonio("cartoes");
  }
  if (normalized.includes("sobra")) {
    return "/hub/relatorios";
  }
  return undefined;
}

function severityColor(severity: QuickInsight["severity"]): string {
  if (severity === "good") return "var(--color-primary)";
  if (severity === "warn") return "var(--color-warning)";
  return "var(--color-info)";
}

export function AiGuidanceCard({
  insights,
  quickInsights,
  cards,
  payables,
  hidden,
  onNavigate,
  onAskTed,
}: AiGuidanceCardProps) {
  const seenTitles = new Set<string>();
  const entries: GuidanceEntry[] = [];

  const pushEntry = (entry: Omit<GuidanceEntry, "key">) => {
    const norm = normalizeTitle(entry.title);
    if (!norm || seenTitles.has(norm)) return;
    seenTitles.add(norm);
    entries.push({ ...entry, key: `${norm}-${entries.length}` });
  };

  for (const qi of quickInsights ?? []) {
    if (!qi.title || !qi.body) continue;
    pushEntry({
      color: severityColor(qi.severity),
      title: qi.title,
      body: qi.body,
      route: resolveGuidanceRoute(qi.title),
    });
  }

  for (const item of insights) {
    if (!item.title || !item.body) continue;
    pushEntry({
      color: item.color,
      title: item.title,
      body: item.body,
      route: resolveGuidanceRoute(item.title),
    });
  }

  const highUsageCard = cards.find(
    (c) => c.limit > 0 && c.outstanding / c.limit >= 0.7,
  );
  if (highUsageCard) {
    const pct = Math.round((highUsageCard.outstanding / highUsageCard.limit) * 100);
    const available = Math.max(0, highUsageCard.limit - highUsageCard.outstanding);
    pushEntry({
      color: pct >= 85 ? "var(--color-danger)" : "var(--color-warning)",
      title: `Atenção ao limite · ${highUsageCard.card.name}`,
      body: `Fatura atual usa ${pct}% do limite. Ainda restam ${formatBRL(available)} disponíveis no cartão.`,
      route: routePatrimonio("cartoes", { cardId: highUsageCard.card.id }),
    });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const overduePayables = payables.filter(
    (p) => p.status === "overdue" || (p.status === "pending" && p.dueDate < todayIso),
  );
  if (overduePayables.length > 0 && entries.length < 4) {
    const overdueTotal = overduePayables.reduce((sum, p) => sum + p.amountCents, 0);
    pushEntry({
      color: "var(--color-danger)",
      title:
        overduePayables.length === 1
          ? "Compromisso em atraso"
          : `${overduePayables.length} compromissos em atraso`,
      body: `Priorize a quitação de ${formatBRL(overdueTotal)} para manter suas finanças em dia.`,
      route: routeCompromissos("a-pagar"),
    });
  }

  const visibleEntries = entries.slice(0, 4);

  return (
    <section className="mt-5" aria-label="Orientações do TED">
      <div className="overflow-hidden rounded-[20px] border border-border-subtle bg-surface-1 shadow-card">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--hairline)] bg-surface-2/40 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src="/brand/ted-launcher.png"
              alt=""
              width={30}
              height={30}
              className="h-[30px] w-[30px] shrink-0 rounded-full object-cover ring-1 ring-primary/25"
            />
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-bold leading-tight text-text-primary">
                Orientações do TED
              </h2>
              <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
                <Sparkles size={11} aria-hidden="true" />
                IA · seus registros
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onAskTed}
            className="min-h-11 shrink-0 rounded-full px-3 text-xs font-semibold text-primary transition-colors hover:bg-primary-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Perguntar ao TED
          </button>
        </div>

        {visibleEntries.length > 0 ? (
          <div className="divide-y divide-[var(--hairline)]">
            {visibleEntries.map((entry) => {
              const inner = (
                <>
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-bold text-text-primary">
                      {entry.title}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-text-secondary">
                      {maskMoney(entry.body, hidden)}
                    </span>
                  </span>
                  {entry.route && (
                    <ChevronRight
                      size={15}
                      aria-hidden="true"
                      className="mt-1 shrink-0 text-text-muted"
                    />
                  )}
                </>
              );

              return entry.route ? (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => onNavigate(entry.route!)}
                  className="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                >
                  {inner}
                </button>
              ) : (
                <div
                  key={entry.key}
                  className="flex items-start gap-3 px-4 py-3"
                >
                  {inner}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-4 py-4 text-xs leading-relaxed text-text-muted">
            Sem orientações por enquanto. Conforme seus registros entram, o TED destaca padrões e próximos passos aqui.
          </p>
        )}
      </div>
    </section>
  );
}

export default AiGuidanceCard;
