"use client";

import Link from "next/link";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import { useState, useRef, useEffect, useMemo } from "react";
import { Check, ChevronDown, Users } from "lucide-react";

function workspaceInitials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

function workspaceColor(name: string, kind: string): string {
  if (kind === "personal") return "var(--primary)";
  // Deterministic hue from name for shared workspaces
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hues = [152, 202, 262, 32, 12, 172];
  const hue = hues[hash % hues.length]!;
  return `hsl(${hue} 58% 38%)`;
}

export interface WorkspaceSwitcherProps {
  compact?: boolean;
  variant?: "default" | "hero";
}

function isAuthorizationError(error: string | null | undefined): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("token inválido") ||
    normalized.includes("token invalido") ||
    normalized.includes("unauthorized") ||
    normalized.includes("não autorizado") ||
    normalized.includes("nao autorizado") ||
    normalized.includes("forbidden") ||
    normalized.includes("sessão expirada") ||
    normalized.includes("sessao expirada") ||
    normalized.includes("auth.") ||
    normalized.includes("401") ||
    normalized.includes("403")
  );
}

export function WorkspaceSwitcher({
  compact = false,
  variant = "default",
}: WorkspaceSwitcherProps) {
  const ws = useWorkspaceSafe();
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const workspaces = useMemo(
    () => (ws?.workspaces ?? []).filter((workspace) => workspace.status !== "archived"),
    [ws?.workspaces],
  );
  const activeWorkspace = ws?.activeWorkspace;
  const selectWorkspace = ws?.selectWorkspace;
  const loading = ws?.loading ?? false;
  const error = ws?.error ?? null;
  const isAuth = Boolean(ws?.isAuthError || isAuthorizationError(error));

  const currentName = useMemo(
    () =>
      activeWorkspace?.name ??
      (workspaces.length > 0 ? "Selecionar espaço" : "Sem espaços"),
    [activeWorkspace, workspaces]
  );

  if (!ws) return null;

  if (loading) {
    return (
      <div
        data-variant={variant}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 shadow-sm ${
          variant === "hero"
            ? "border-white/15 bg-white/[0.14] text-white/70"
            : "border-border-subtle bg-surface-1 text-text-muted"
        } ${
          compact ? "text-xs max-w-[150px]" : "text-sm max-w-[200px]"
        }`}
      >
        <span
          className={`h-5 w-5 animate-pulse rounded-full ${
            variant === "hero" ? "bg-white/20" : "bg-surface-2"
          }`}
        />
        <span className="truncate">Carregando…</span>
      </div>
    );
  }

  if (error && workspaces.length === 0) {
    if (isAuth) {
      return (
        <div
          data-variant={variant}
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${
            variant === "hero"
              ? "border-danger/40 bg-danger/20 text-danger"
              : "border-danger/30 bg-danger-tint text-danger"
          } ${
            compact ? "text-xs" : "text-sm"
          }`}
        >
          <span className="h-2 w-2 rounded-full bg-danger" />
          <span className="truncate">Não autorizado</span>
        </div>
      );
    }

    // A3: sem "Offline" solto (lê-se como "sem internet"). Copy clara de que
    // são os dados locais do workspace que estão sendo exibidos.
    return (
      <div
        data-variant={variant}
        title="Sem conexão – dados locais"
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${
          variant === "hero"
            ? "border-warning/40 bg-warning/20 text-warning"
            : "border-warning/30 bg-warning-tint text-warning"
        } ${
          compact ? "text-xs" : "text-sm"
        }`}
      >
        <span className="h-2 w-2 flex-none rounded-full bg-text-muted" aria-hidden="true" />
        <span className="truncate">Sem conexão</span>
      </div>
    );
  }

  const activeColor = activeWorkspace
    ? workspaceColor(activeWorkspace.name, activeWorkspace.kind)
    : "var(--primary)";

  // Cross-workspace write guard: the dropdown only closes AFTER the switch
  // fully commits (API client header + state), so the visible label can
  // never announce a workspace whose writes would still target another one.
  // Switch failures are modeled in context error state (never a rejection),
  // but with a non-empty list the switcher used to hide that error when the
  // menu closed. Keep the close + coherent label, and surface the reason
  // inline via aria-live (no browser alert).
  async function handleSelect(workspaceId: string): Promise<void> {
    if (!selectWorkspace || pendingId) return;
    setPendingId(workspaceId);
    setSwitchError(null);
    try {
      await selectWorkspace(workspaceId);
    } catch (cause) {
      // selectWorkspace models failures in context error state and never
      // rejects by contract — this guard keeps a future/foreign rejection
      // from escaping the `void` onClick as an unhandled rejection, and
      // surfaces its reason inline so the closed menu never swallows it.
      setSwitchError(
        cause instanceof Error ? cause.message : "Não foi possível trocar de espaço.",
      );
    } finally {
      setPendingId(null);
      setOpen(false);
    }
  }

  // Inline failure reason shown even when the list is non-empty: prefer the
  // just-captured rejection, else the modeled context error. Rendered below
  // (menu stays closed, label/header stay as committed).
  const visibleSwitchError =
    switchError ?? (workspaces.length > 0 ? error : null);

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      <button
        type="button"
        aria-label="Selecionar espaço"
        aria-expanded={open}
        aria-haspopup="listbox"
        data-variant={variant}
        onClick={() => setOpen((prev) => !prev)}
        className={`group flex items-center gap-2 rounded-full border pl-1.5 pr-3 py-1 text-left shadow-sm transition-all focus:outline-none ${
          variant === "hero"
            ? "border-white/15 bg-white/[0.14] text-white hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/40"
            : "border-border-subtle bg-surface-1 text-text-primary hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-primary"
        } ${
          compact
            ? "text-xs max-w-[160px] sm:max-w-[200px]"
            : "text-sm max-w-[220px] sm:max-w-[280px]"
        } ${
          open
            ? variant === "hero"
              ? "border-white/40 ring-1 ring-white/30 shadow-md"
              : "border-primary ring-1 ring-primary/20 shadow-md"
            : ""
        }`}
      >
        <span
          className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white shadow-xs"
          style={{ background: activeColor }}
          aria-hidden="true"
        >
          {workspaceInitials(currentName)}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[12px] font-bold leading-none tracking-tight ${
              variant === "hero" ? "text-white" : "text-text-primary"
            }`}
          >
            {currentName}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`flex-none transition-transform duration-200 ${
            variant === "hero"
              ? open
                ? "rotate-180 text-white"
                : "text-white/70 group-hover:text-white"
              : open
                ? "rotate-180 text-text-primary"
                : "text-text-muted group-hover:text-text-primary"
          }`}
        />
      </button>
      {visibleSwitchError && (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="workspace-switch-error"
          className={`mt-1 max-w-[280px] truncate rounded-full border px-3 py-1 text-xs font-semibold ${
            variant === "hero"
              ? "border-danger/40 bg-danger/20 text-danger"
              : "border-danger/30 bg-danger-tint text-danger"
          }`}
          title={visibleSwitchError}
        >
          {visibleSwitchError}
        </div>
      )}

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[300px] max-w-[calc(100vw-1.5rem)] origin-top-right overflow-hidden rounded-[18px] border border-border-subtle bg-surface-1 shadow-elevated animate-fade-in">
          <div className="bg-surface-2/50 px-4 py-3 border-b border-border-subtle">
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
              Seus Workspaces
            </div>
            <div className="text-[12px] font-semibold text-text-secondary">
              {workspaces.length}{" "}
              {workspaces.length === 1
                ? "workspace disponível"
                : "workspaces disponíveis"}
            </div>
          </div>
          <div role="listbox" className="max-h-64 overflow-y-auto p-1.5 space-y-1">
            {workspaces.map((w) => {
              const isSelected = w.id === activeWorkspace?.id;
              const color = workspaceColor(w.name, w.kind);
              return (
                <button
                  key={w.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={pendingId !== null}
                  aria-busy={pendingId === w.id}
                  onClick={() => void handleSelect(w.id)}
                  className={`flex w-full items-center gap-3 rounded-[12px] px-3 py-2 text-left transition-all ${
                    isSelected
                      ? "bg-primary-tint text-primary font-bold shadow-xs"
                      : "text-text-primary hover:bg-surface-2"
                  }`}
                >
                  <span
                    className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-xs font-bold text-white shadow-xs"
                    style={{ background: color }}
                  >
                    {workspaceInitials(w.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-[13px] ${
                        isSelected ? "font-bold text-primary" : "font-semibold"
                      }`}
                    >
                      {w.name}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-text-muted">
                        {w.kind === "personal" ? "Pessoal" : "Compartilhado"}
                      </span>
                      {isSelected && (
                        <span className="text-[10px] font-semibold text-primary">
                          • Ativo
                        </span>
                      )}
                    </div>
                  </div>
                  {isSelected && (
                    <Check size={16} className="text-primary flex-none" />
                  )}
                </button>
              );
            })}
            {workspaces.length === 0 && (
              <div className="px-3 py-8 text-center">
                <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-text-muted">
                  <Users size={20} />
                </div>
                <div className="text-sm font-semibold text-text-primary">
                  Nenhum espaço
                </div>
                <div className="text-xs text-text-muted">
                  Você ainda não participa de nenhum espaço.
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border-subtle bg-surface-2/30 px-3 py-2">
            <Link
              href="/workspaces"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between rounded-[10px] px-2 py-2 text-[11px] font-bold text-primary transition-colors hover:bg-primary-tint"
            >
              <span>Gerenciar espaços</span>
              <span aria-hidden="true">&gt;</span>
            </Link>
            <p className="px-2 pt-1 text-[10px] text-text-muted">
              Trocar de espaço sincroniza dados do ambiente selecionado.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkspaceSwitcher;
