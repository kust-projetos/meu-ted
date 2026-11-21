"use client";

import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import Link from "next/link";
import {
  CalendarClock,
  ChevronRight,
  Compass,
  Flag,
  FolderOpen,
  Landmark,
  Layers,
  Menu,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
  Target,
  User,
  Wallet,
  X,
  type LucideProps,
} from "lucide-react";
import { useTheme } from "@/lib/theme";

export interface AppFloatingMenuProps {
  onOpenCustomize?: () => void;
  compact?: boolean;
  menuId?: string;
}

interface QuickModuleLink {
  href: string;
  label: string;
  Icon: ComponentType<LucideProps>;
}

const QUICK_MODULES: QuickModuleLink[] = [
  { href: "/compromissos", label: "Compromissos", Icon: CalendarClock },
  { href: "/hub/patrimonio?aba=contas", label: "Contas", Icon: Wallet },
  { href: "/hub/planejamento", label: "Planejamento", Icon: Target },
  { href: "/hub/planejamento?aba=metas", label: "Metas", Icon: Flag },
  { href: "/hub/patrimonio?aba=patrimonio", label: "Patrimônio", Icon: Landmark },
  { href: "/hub/categorias", label: "Categorias", Icon: FolderOpen },
];

export function AppFloatingMenu({
  onOpenCustomize,
  compact = false,
  menuId,
}: AppFloatingMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const panelId = menuId ?? `app-floating-menu-${generatedId}`;
  const { resolvedTheme, toggleTheme } = useTheme();

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={`relative ${open ? "z-[60]" : ""}`}>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px]"
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
      )}

      <button
        ref={triggerRef}
        type="button"
        aria-label="Abrir menu"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        className={`relative z-50 flex items-center justify-center rounded-full border border-border-subtle bg-surface-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          compact ? "h-9 w-9" : "h-11 w-11"
        }`}
      >
        {open ? (
          <X size={compact ? 18 : 20} aria-hidden="true" />
        ) : (
          <Menu size={compact ? 18 : 20} aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Menu de navegação"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[308px] max-w-[calc(100vw-2rem)] origin-top-right overflow-hidden rounded-[20px] border border-border-medium bg-surface-1 p-2 shadow-elevated animate-fade-in"
        >
          <div className="flex items-center gap-2.5 rounded-[14px] bg-surface-2/60 px-3 py-2.5">
            <img
              src="/brand/ted-launcher.png"
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 shrink-0 rounded-full object-cover ring-1 ring-primary/25"
            />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-bold leading-tight text-text-primary">
                Meu Ted
              </p>
              <p className="truncate text-[11px] text-text-muted">
                Menu rápido
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1 px-0.5 py-1.5">
            {QUICK_MODULES.map((item) => {
              const ItemIcon = item.Icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-11 items-center gap-1.5 rounded-[12px] px-2 py-2 text-xs font-semibold text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <ItemIcon
                    size={16}
                    aria-hidden="true"
                    className="shrink-0 text-primary"
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>

          <Link
            href="/hub"
            onClick={() => setOpen(false)}
            className="flex min-h-11 w-full items-center justify-between rounded-[12px] px-3 py-2 text-xs font-bold text-primary transition-colors hover:bg-primary-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="flex items-center gap-2">
              <Compass size={16} aria-hidden="true" />
              Explorar todos os módulos
            </span>
            <ChevronRight size={15} aria-hidden="true" />
          </Link>

          <div className="my-1.5 border-t border-[var(--hairline)]" />

          <div className="space-y-0.5">
            <Link
              href="/perfil"
              onClick={() => setOpen(false)}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left text-xs font-semibold text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <User
                size={16}
                aria-hidden="true"
                className="shrink-0 text-text-secondary"
              />
              <span>Meu Perfil</span>
            </Link>

            {onOpenCustomize && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenCustomize();
                }}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left text-xs font-semibold text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <SlidersHorizontal
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-text-secondary"
                />
                <span>Personalizar início</span>
              </button>
            )}

            <button
              type="button"
              aria-label="Alternar tema"
              onClick={toggleTheme}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left text-xs font-semibold text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {resolvedTheme === "dark" ? (
                <Sun
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-warning"
                />
              ) : (
                <Moon
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-primary"
                />
              )}
              <span>
                {resolvedTheme === "dark" ? "Tema claro" : "Tema escuro"}
              </span>
            </button>

            <div className="grid grid-cols-2 gap-1 pt-0.5">
              <Link
                href="/workspaces"
                onClick={() => setOpen(false)}
                className="flex min-h-11 items-center gap-1.5 rounded-[12px] px-2 py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Layers size={15} aria-hidden="true" className="shrink-0" />
                <span className="truncate">Meus Espaços</span>
              </Link>
              <Link
                href="/hub/configuracoes"
                onClick={() => setOpen(false)}
                className="flex min-h-11 items-center gap-1.5 rounded-[12px] px-2 py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Settings size={15} aria-hidden="true" className="shrink-0" />
                <span className="truncate">Configurações</span>
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AppFloatingMenu;
