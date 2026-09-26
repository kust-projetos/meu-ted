"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import BottomSheet from "@/components/BottomSheet";
import PushNotificationsCard from "./PushNotificationsCard";
import { useAppState } from "@/lib/state/app-state-context";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import { routeCompromissos, routePatrimonio, routePlanejamento } from "@/lib/routes";
import { resolveCardOutstanding } from "@/lib/cards/card-debt";

interface NotificationsSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId?: string;
  /**
   * Inline mode renders the panel content without the BottomSheet wrapper
   * (used by the /hub/alertas Financeiras tab, item 13). Defaults to sheet.
   */
  inline?: boolean;
}

const DISMISSED_STORAGE_KEY = "pi-finance:notifications-dismissed";

type AlertSection = "urgent" | "today" | "soon";

interface AlertItem {
  id: string;
  section: AlertSection;
  typeLabel: string;
  title: string;
  detail: string;
  href: string;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAhead(iso: string): number {
  const d = new Date(iso + "T12:00:00");
  const today = new Date(todayISO() + "T12:00:00");
  return Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function fmtBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

export default function NotificationsSheet({
  open,
  onClose,
  workspaceId,
  inline = false,
}: NotificationsSheetProps) {
  const router = useRouter();
  const { payables, budgets, transactions, accounts, cardStatements, goals } = useAppState();
  const workspace = useWorkspaceSafe();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open && !inline) return;
    try {
      const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setDismissed(new Set(JSON.parse(raw) as string[]));
    } catch {
      // ignore
    }
  }, [open, inline]);

  const items = useMemo<AlertItem[]>(() => {
    const now = todayISO();
    const list: AlertItem[] = [];

    // ── Payables: overdue (urgent), due today (today), due ≤7d (soon) ──
    for (const p of payables) {
      if (p.status === "paid" || p.status === "cancelled") continue;
      const overdue = p.status === "overdue" || p.dueDate < now;
      const ahead = daysAhead(p.dueDate);
      const amount = fmtBRL(p.amountCents);
      if (overdue) {
        list.push({
          id: `payable:${p.id}`,
          section: "urgent",
          typeLabel: "Conta a pagar",
          title: `${p.description} vencida`,
          detail: `${amount} • venceu em ${p.dueDate}`,
          href: routeCompromissos("a-pagar"),
        });
      } else if (ahead <= 0) {
        list.push({
          id: `payable:${p.id}`,
          section: "today",
          typeLabel: "Conta a pagar",
          title: `${p.description} vence hoje`,
          detail: amount,
          href: routeCompromissos("a-pagar"),
        });
      } else if (ahead <= 7) {
        list.push({
          id: `payable:${p.id}`,
          section: "soon",
          typeLabel: "Conta a pagar",
          title: `${p.description} vence em ${ahead} ${ahead === 1 ? "dia" : "dias"}`,
          detail: `${amount} • ${p.dueDate}`,
          href: routeCompromissos("a-pagar"),
        });
      }
    }

    // ── Budgets: ≥100% urgent, ≥90% soon ──
    for (const b of budgets) {
      if (b.amountCents <= 0) continue;
      const ratio = b.spentCents / b.amountCents;
      if (ratio < 0.9) continue;
      const spent = fmtBRL(b.spentCents);
      const total = fmtBRL(b.amountCents);
      const section: AlertSection = ratio >= 1 ? "urgent" : "soon";
      list.push({
        id: `budget:${b.id}`,
        section,
        typeLabel: "Orçamento",
        title: `Orçamento ${b.name} ${ratio >= 1 ? "estourou" : "quase no limite"}`,
        detail: `${(ratio * 100).toFixed(0)}% usado (${spent} de ${total})`,
        href: routePlanejamento("orcamentos"),
      });
    }

    // ── Cards: by statement total vs limit ──
    const creditCards = accounts.filter((a) => a.kind === "credit_card");
    for (const card of creditCards) {
      const limit = card.creditLimitCents ?? 0;
      if (limit <= 0) continue;
      const latestStmt = cardStatements
        .filter((s) => s.accountId === card.id)
        .sort((a, b) => b.cycleYearMonth.localeCompare(a.cycleYearMonth))[0];
      // ADR-018: utilization is outstanding / limit when canonical; the
      // latest-statement total is legacy fallback only.
      const statementFallbackCents = latestStmt?.totalCents ?? transactions
        .filter((t) => t.accountId === card.id && t.kind === "expense")
        .reduce((s, t) => s + t.amountCents, 0);
      const spent = resolveCardOutstanding(card, { statementFallbackCents })
        .outstandingCents;
      if (spent === 0) continue;
      const ratio = spent / limit;
      let section: AlertSection | null = null;
      if (ratio > 1) section = "urgent";
      else if (ratio >= 0.95) section = "urgent";
      else if (ratio >= 0.9) section = "today";
      else if (ratio >= 0.8) section = "soon";
      if (!section) continue;
      const spentBRL = fmtBRL(spent);
      const limitBRL = fmtBRL(limit);
      list.push({
        id: `card:${card.id}`,
        section,
        typeLabel: "Cartão",
        title: `${card.name} — ${(ratio * 100).toFixed(0)}% do limite`,
        detail: `${spentBRL} usado de ${limitBRL}`,
        href: routePatrimonio("cartoes", { cardId: card.id }),
      });
    }

    // ── Goals: check if goal is on track or stalled ──
    for (const g of goals) {
      if (g.targetAmountCents <= 0) continue;
      const pct = (g.currentAmountCents / g.targetAmountCents) * 100;
      if (pct >= 100) continue; // achieved → not an alert
      if (pct <= 10) {
        list.push({
          id: `goal:${g.id}`,
          section: "soon",
          typeLabel: "Meta",
          title: `${g.name} — só ${pct.toFixed(0)}% concluída`,
          detail: `${fmtBRL(g.currentAmountCents)} de ${fmtBRL(g.targetAmountCents)}`,
          href: routePlanejamento("metas"),
        });
      }
    }

    // ── Sort by section urgency then by spent/ratio ──
    const sectionRank = { urgent: 0, today: 1, soon: 2 };
    list.sort((a, b) => sectionRank[a.section] - sectionRank[b.section]);
    return list;
  }, [payables, budgets, transactions, accounts, cardStatements, goals]);

  const visible = useMemo(
    () => items.filter((i) => !dismissed.has(i.id)),
    [items, dismissed],
  );

  const grouped = useMemo(() => {
    const g: { section: AlertSection; items: AlertItem[] }[] = [];
    for (const section of ["urgent", "today", "soon"] as AlertSection[]) {
      const filtered = visible.filter((i) => i.section === section);
      if (filtered.length > 0) g.push({ section, items: filtered });
    }
    return g;
  }, [visible]);

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // noop
    }
  };

  const goToItem = (href: string) => {
    if (!inline) onClose();
    router.push(href);
  };

  const sectionLabel = (s: AlertSection): string => {
    switch (s) {
      case "urgent": return "Urgente";
      case "today": return "Hoje";
      case "soon": return "Em breve";
    }
  };

  const sectionColor = (s: AlertSection): string => {
    switch (s) {
      case "urgent": return "var(--color-danger)";
      case "today": return "var(--color-warning)";
      case "soon": return "var(--color-info)";
    }
  };

  const panel = (
    <>
      <PushNotificationsCard workspaceId={workspaceId ?? workspace?.activeWorkspace?.id} />
      <div className="mb-4 rounded-[18px] bg-fill-light p-4">
        <div className="mb-1 text-[15px] font-bold text-text-primary">
          Alertas do Meu Ted
        </div>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Priorizados por urgência com base nos seus dados reais.
        </p>
      </div>

      {items.length === 0 && (
        <div className="rounded-[16px] border border-border bg-fill-light px-4 py-6 text-center text-[13px] text-text-muted">
          Nada urgente agora. Quando aparecer, você verá aqui.
        </div>
      )}

      {items.length > 0 && visible.length === 0 && (
        <div className="rounded-[16px] border border-border bg-fill-light px-4 py-6 text-center text-[13px] text-text-muted">
          Tudo limpo — você dispensou os avisos desta seção.
        </div>
      )}

      {grouped.map((g) => (
        <div key={g.section} className="mb-4">
          <div
            className="mb-2 flex items-center gap-2 text-[13px] font-bold"
            style={{ color: sectionColor(g.section) }}
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: sectionColor(g.section) }} />
            {sectionLabel(g.section)}
          </div>
          <div className="flex flex-col gap-2.5" data-testid={`notifications-section-${g.section}`}>
            {g.items.map((it) => (
              <div
                key={it.id}
                data-testid="notification-item"
                className="flex items-start gap-3 rounded-[16px] border border-border bg-fill-light px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <span
                    data-testid="notification-type-label"
                    className="mb-1 inline-block rounded-full bg-surface px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                    style={{ color: sectionColor(g.section) }}
                  >
                    {it.typeLabel}
                  </span>
                  <div className="mb-0.5 text-[14px] font-semibold text-text-primary">
                    {it.title}
                  </div>
                  <div className="mb-2 text-[12px] leading-relaxed text-text-secondary">
                    {it.detail}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => goToItem(it.href)}
                      className="rounded-full bg-primary px-3 py-1 text-[11px] font-bold text-white"
                    >
                      Abrir
                    </button>
                    <button
                      type="button"
                      onClick={() => dismiss(it.id)}
                      className="text-[11px] font-semibold text-text-muted"
                    >
                      Dispensar
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {!inline && grouped.length > 0 && (
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded-[14px] bg-primary py-[15px] text-center text-[15px] font-bold text-white transition-opacity hover:opacity-90"
        >
          Fechar
        </button>
      )}
    </>
  );

  if (inline) return <div>{panel}</div>;
  return (
    <BottomSheet open={open} onClose={onClose} title="Notificações">
      {panel}
    </BottomSheet>
  );
}
