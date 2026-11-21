"use client";

import { useEffect, useRef, useState } from "react";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { formatBRL } from "@/lib/format/brl";
import { haptic } from "@/lib/ui/haptics";
import { HERO_BACKGROUND } from "../hero";
import { Bell, Eye, EyeOff } from "lucide-react";

export interface HeroProfile {
  name: string;
  avatarColor: string;
}

interface HeroSectionProps {
  profile: HeroProfile;
  totalBalance: number | null;
  totalIncome: number | null;
  totalExpenses: number | null;
  netResult: number | null;
  /** P3 — saldo oculto (máscara) vs. visível. */
  balanceHidden: boolean;
  onToggleBalance: () => void;
  /** P4 — saldo animado (centavos) exibido quando visível. */
  animatedBalance: number;
  onOpenProfile: () => void;
  onOpenNotifications: () => void;
  /** Reservado: indica insights pendentes (sem efeito visual no header). */
  hasPendingInsights?: boolean;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "Boa madrugada";
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

export function HeroSection({
  profile,
  totalBalance,
  totalIncome,
  totalExpenses,
  netResult,
  balanceHidden,
  onToggleBalance,
  animatedBalance,
  onOpenProfile,
  onOpenNotifications,
}: HeroSectionProps) {
  // Spec AGY §1: alternância em 2 fases (fade out 90ms → troca → fade in).
  const [leaving, setLeaving] = useState(false);
  const [reducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  const timeoutRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const handleEye = () => {
    haptic(12);
    if (reducedMotion) {
      onToggleBalance();
      return;
    }
    setLeaving(true);
    timeoutRef.current = window.setTimeout(() => {
      onToggleBalance();
      setLeaving(false);
    }, 90);
  };

  // Classe de transição aplicada aos 4 valores ocultáveis (saldo + 3 mini-stats).
  const swapClass = `transition-[opacity,filter,transform] duration-[90ms] ease-[var(--easing-standard)] ${
    leaving ? "opacity-0 scale-[0.98] blur-[2px]" : "opacity-100 scale-100 blur-0"
  }`;

  return (
    <div
      data-testid="hero-area"
      className="px-5 pt-[calc(8px+env(safe-area-inset-top))] sm:px-8 lg:px-12"
      style={{
        background: HERO_BACKGROUND,
        paddingBottom: 24,
      }}
    >
      {/* Header: avatar + greeting + bell */}
      <div className="mb-5 mt-2 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onOpenProfile}
            aria-label="Abrir perfil"
            className="flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-full font-mono text-[15px] font-semibold text-white shadow-sm ring-1 ring-white/10"
            style={{ background: profile.avatarColor }}
          >
            {(profile.name ?? "?").charAt(0).toUpperCase()}
          </button>
          <div>
            <div className="text-xs text-white/70">
              {greeting()}
            </div>
            <div className="text-[15px] font-bold text-white tracking-tight">{profile.name}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="lg:hidden">
            <WorkspaceSwitcher compact variant="hero" />
          </div>
          <button
            type="button"
            aria-label="Notificações"
            onClick={onOpenNotifications}
            className="relative flex h-[38px] w-[38px] items-center justify-center rounded-full text-white transition-all hover:bg-white/20 active:scale-95"
            style={{ background: "rgba(255,255,255,.14)" }}
          >
            <Bell size={18} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Page heading */}
      <h1 className="mb-[3px] text-[10px] font-bold uppercase tracking-wider text-white/60">
        Resumo financeiro
      </h1>

      {/* Saldo */}
      <div className="mb-[5px] flex items-center gap-2 text-xs font-medium text-white/80">
        <span>Saldo total · contas</span>
        {/* P3 — ocultar/mostrar saldos (persistido); 44px touch-target */}
        <button
          type="button"
          onClick={handleEye}
          aria-pressed={balanceHidden}
          aria-label={balanceHidden ? "Mostrar saldos" : "Ocultar saldos"}
          className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 transition-all hover:bg-white/20 hover:text-white active:scale-95"
        >
          {balanceHidden ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <div
        className={`mb-[18px] font-mono tabular-nums text-[38px] sm:text-[44px] font-bold text-white tracking-tight ${swapClass}`}
        style={{ letterSpacing: "-0.02em", lineHeight: 1 }}
      >
        {totalBalance !== null ? (
          balanceHidden ? (
            <>
              <span
                data-testid="balance-hidden"
                aria-hidden="true"
                className="inline-block h-8 w-36 rounded-md bg-white/15 align-middle backdrop-blur-sm"
              />
              <span className="sr-only">Saldo oculto</span>
            </>
          ) : (
            formatBRL(animatedBalance)
          )
        ) : (
          "—"
        )}
      </div>

      {/* Mini-stats row */}
      <div className="flex gap-[9px]">
  <div
          className="flex-1 rounded-[14px] p-[10px_12px] border border-white/10"
          style={{ background: "rgba(255,255,255,.12)" }}
        >
          <div className="mb-[3px] text-[11px] font-medium text-white/70">Receitas</div>
          <div className={`overflow-hidden text-ellipsis whitespace-nowrap font-mono tabular-nums text-[13px] font-semibold text-white ${swapClass}`}>
            {totalIncome !== null ? (
              balanceHidden ? (
                <span data-testid="ministat-hidden" aria-hidden="true" className="inline-block h-4 w-16 rounded bg-white/15 align-middle backdrop-blur-sm" />
              ) : (
                formatBRL(totalIncome)
              )
            ) : (
              "—"
            )}
          </div>
        </div>
        <div
          className="flex-1 rounded-[14px] p-[10px_12px] border border-white/10"
          style={{ background: "rgba(255,255,255,.12)" }}
        >
          <div className="mb-[3px] text-[11px] font-medium text-white/70">Despesas</div>
          <div className={`overflow-hidden text-ellipsis whitespace-nowrap font-mono tabular-nums text-[13px] font-semibold text-white ${swapClass}`}>
            {totalExpenses !== null ? (
              balanceHidden ? (
                <span data-testid="ministat-hidden" aria-hidden="true" className="inline-block h-4 w-16 rounded bg-white/15 align-middle backdrop-blur-sm" />
              ) : (
                formatBRL(totalExpenses)
              )
            ) : (
              "—"
            )}
          </div>
        </div>
        <div
          className="flex-1 rounded-[14px] p-[10px_12px] border border-white/10"
          style={{ background: "rgba(255,255,255,.12)" }}
        >
          <div className="mb-[3px] text-[11px] font-medium text-white/70">Resultado</div>
          <div
            className={`overflow-hidden text-ellipsis whitespace-nowrap font-mono tabular-nums text-[13px] font-semibold ${swapClass}`}
            style={{
              color:
                netResult === null
                  ? "rgba(255,255,255,0.7)"
                  : netResult >= 0
                    ? "#7FE3B0"
                    : "#F9A8A2",
            }}
          >
            {netResult !== null ? (
              balanceHidden ? (
                <span data-testid="ministat-hidden" aria-hidden="true" className="inline-block h-4 w-16 rounded bg-white/15 align-middle backdrop-blur-sm" />
              ) : (
                formatBRL(netResult)
              )
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
