"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  CreditCard,
  BarChart3,
  Home,
  Receipt,
  ReceiptText,
  TrendingDown,
  TrendingUp,
  X,
  type LucideProps,
} from "lucide-react";
import { haptic } from "@/lib/ui/haptics";

export type NavItem = "home" | "records" | "cards" | "reports";

interface BottomNavProps {
  active: NavItem | null;
  onNavClick: (item: NavItem) => void;
}

interface ItemDef {
  key: NavItem;
  label: string;
  Icon: ComponentType<LucideProps>;
}

const ITEMS: ItemDef[] = [
  { key: "home", label: "Início", Icon: Home },
  { key: "records", label: "Extrato", Icon: Receipt },
  // Primary navigation: Início, Extrato, Cartões, Relatórios.
  { key: "cards", label: "Cartões", Icon: CreditCard },
  { key: "reports", label: "Relatórios", Icon: BarChart3 },
];

type QuickActionKind = "expense" | "income" | "transfer" | "receipt";

interface QuickActionDef {
  key: QuickActionKind;
  label: string;
  Icon: ComponentType<LucideProps>;
}

const QUICK_ACTIONS: QuickActionDef[] = [
  { key: "expense", label: "Despesa", Icon: TrendingDown },
  { key: "income", label: "Receita", Icon: TrendingUp },
  { key: "transfer", label: "Transferência", Icon: ArrowLeftRight },
  { key: "receipt", label: "Ler Comprovante", Icon: ReceiptText },
];

function NavButton({
  item,
  isActive,
  onClick,
}: {
  item: ItemDef;
  isActive: boolean;
  onClick: () => void;
}) {
  const ItemIcon = item.Icon;
  return (
    <button
      onClick={() => {
        haptic(8);
        onClick();
      }}
      aria-current={isActive ? "page" : undefined}
      className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-[16px] px-1 pt-1.5 transition-all duration-200 focus-visible:outline-none ${
        isActive ? "bg-primary-tint" : "bg-transparent"
      }`}
      style={{
        color: isActive
          ? "var(--color-primary)"
          : "var(--color-text-muted)",
      }}
    >
      <ItemIcon size={24} strokeWidth={1.9} />
      {/* Spec AGY §4.3: dot esmeralda 4px sob o ícone ativo (transparente p/ não deslocar layout) */}
      <span
        aria-hidden="true"
        className={`h-1 w-1 rounded-full transition-all duration-200 ${
          isActive ? "bg-primary opacity-100" : "bg-transparent opacity-0"
        }`}
      />
      <span
        className={`text-[11px] ${
          isActive ? "font-bold" : "font-medium"
        } text-center`}
      >
        {item.label}
      </span>
    </button>
  );
}

export function BottomNav({
  active,
  onNavClick,
}: BottomNavProps) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        // §24 disclosure pattern: Escape closes and returns focus to the
        // disclosure button so keyboard users are not stranded.
        fabRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  function runQuickAction(action: QuickActionKind) {
    setMenuOpen(false);
    haptic(8);
    if (action === "receipt") {
      // Direciona leitura de comprovante para o assistente TED com contexto.
      router.push("/ted?from=comprovante");
      return;
    }
    // Reuses the capture (preselected) sheet mode via the AppShell listener.
    window.dispatchEvent(
      new CustomEvent("pwa:open-tx", { detail: { kind: action } }),
    );
  }

  return (
    <nav
      data-nav="bottom"
      className="fixed bottom-0 inset-x-0 z-20 mx-auto flex max-w-[var(--shell-max-w)] items-stretch justify-around border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      style={{ height: "var(--tab-bar-height)" }}
    >
      {/* Items: left side (Início, Extrato) */}
      {ITEMS.slice(0, 2).map((item) => (
        <NavButton
          key={item.key}
          item={item}
          isActive={active === item.key}
          onClick={() => onNavClick(item.key)}
        />
      ))}

      {/* FAB — central: opens the quick-action menu */}
      <div
        className="relative flex flex-none flex-col items-center justify-start"
        style={{ width: 64 }}
      >
        <button
          ref={fabRef}
          onClick={() => {
            haptic(8);
            setMenuOpen((open) => !open);
          }}
          className="relative -top-2.5 flex h-[48px] w-[48px] flex-none items-center justify-center rounded-full text-white shadow-fab transition-transform active:scale-95 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
          style={{
            background: "linear-gradient(145deg, var(--primary), var(--primary-dark))",
          }}
          aria-label="Novo lançamento"
          aria-expanded={menuOpen}
          aria-controls="quick-actions"
        >
          {menuOpen ? (
            <X size={24} strokeWidth={2.6} />
          ) : (
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          )}
        </button>
        <span
          aria-hidden="true"
          data-testid="fab-visible-label"
          className="-mt-1.5 text-center text-[11px] font-bold text-primary"
        >
          Lançar
        </span>

        {menuOpen && (
          <>
            <div
              className="fixed inset-0"
              aria-hidden="true"
              onClick={() => setMenuOpen(false)}
            />
            {/* §24: disclosure popup — a named group of plain buttons instead
                of an incomplete ARIA menu (which would promise arrow-key
                navigation and item focus that were never implemented). */}
            <div
              id="quick-actions"
              role="group"
              aria-label="Ações de novo lançamento"
              className="absolute bottom-full left-1/2 mb-3 flex w-[218px] -translate-x-1/2 flex-col gap-1 rounded-[18px] border border-border-subtle bg-surface-1 p-2 shadow-elevated"
            >
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => runQuickAction(action.key)}
                  className="flex min-h-[44px] items-center gap-3 rounded-[12px] px-3 py-2 text-left transition-colors hover:bg-surface-2 active:bg-surface-2"
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-primary-tint text-primary">
                    <action.Icon size={17} strokeWidth={2} />
                  </span>
                  <span className="text-[13px] font-bold text-text-primary">
                    {action.label}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Items: right side (Cartões, Relatórios) */}
      {ITEMS.slice(2).map((item) => (
        <NavButton
          key={item.key}
          item={item}
          isActive={active === item.key}
          onClick={() => onNavClick(item.key)}
        />
      ))}
    </nav>
  );
}

export default BottomNav;
