"use client";

import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import BottomSheet from "@/components/BottomSheet";
import NewTransactionSheet from "@/components/NewTransactionSheet";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import SidebarRail from "@/components/SidebarRail";
import { Bell } from "lucide-react";
import { useIsOverlayOpen } from "@/lib/ui/overlay-a11y";
import type { NavItem } from "@/components/BottomNav";
import type { SaveData } from "@/components/NewTransactionSheet";
import { useAppState } from "@/lib/state/app-state-context";
import { useSheet } from "@/lib/sheet-context";
import { useUnsavedChangesSafe } from "@/lib/unsaved-changes";
import { recordAdoptionEvent } from "@/lib/api/adoption";
import { TedChatLauncher } from "@/features/ted/TedChatLauncher";
import { SwipeNav } from "@/lib/ui/swipe-nav";
import { fetchPendingMe } from "@/lib/api/auth";

interface AppShellProps {
  children: ReactNode;
}

export type OpenTransactionDetail = {
  kind: "expense" | "income" | "transfer";
  description?: string;
  flowId?: string;
};

export function parseOpenTransactionEvent(
  event: Event,
): OpenTransactionDetail | undefined {
  const detail = (event as CustomEvent<OpenTransactionDetail>).detail;
  return detail?.kind ? detail : undefined;
}

let _txCounter = 100;

function nextId(): string {
  _txCounter += 1;
  return `tx-${_txCounter}`;
}

export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMode, setSheetMode] = useState<"new" | "preselected">(
    "new",
  );
  const [preselectedKind, setPreselectedKind] = useState<
    "expense" | "income" | "transfer"
  >("expense");
  const [initialDescription, setInitialDescription] = useState("");
  const [captureFlowId, setCaptureFlowId] = useState<string | undefined>();
  const {
    accounts,
    categories,
    transactions,
    addTransaction,
    createTransfer,
    addAccount,
    addCategory,
    addCard,
    createInstallments,
    createCardPurchase,
    readOnly,
  } = useAppState();
  const { sheetKind, closeSheet } = useSheet();
  const { isDirty } = useUnsavedChangesSafe();
  // A1/A7: floating elements (TED FAB hides itself; invite badge hides here)
  // must not clash with open overlays.
  const overlayOpen = useIsOverlayOpen();
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState<NavItem | null>(null);
  const [pendingInviteCount, setPendingInviteCount] = useState(0);

  // Load pending invites count for badge
  // §24: HTTP must not run in useLayoutEffect (blocking paint for a network
  // round-trip buys nothing here — no DOM measurement involved).
  useEffect(() => {
    let cancelled = false;
    fetchPendingMe()
      .then((res) => { if (!cancelled) setPendingInviteCount(res.total); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Derive sheet open/mode from context (no setState-in-effect)
  const effectiveSheetOpen = sheetOpen || sheetKind !== null;
  const effectiveSheetMode: "new" | "preselected" = sheetKind
    ? "preselected"
    : sheetMode;
  const effectivePreselectedKind: "expense" | "income" | "transfer" =
    sheetKind ?? preselectedKind;

  // Listen for fallback event from pages that don't have context access
  // §24 exception (kept as useLayoutEffect, documented): child pages like
  // CaptureBridge dispatch "pwa:open-tx" from their own passive effects,
  // which run bottom-up BEFORE parent passive effects. A useEffect here
  // would attach this window listener too late and silently drop the first
  // capture event (regression caught by CaptureAppShell.integration.test).
  useLayoutEffect(() => {
    function handler(e: Event) {
      const detail = parseOpenTransactionEvent(e);
      if (detail) {
        setPreselectedKind(detail.kind);
        setInitialDescription(detail.description ?? "");
        setCaptureFlowId(detail.flowId);
        if (detail.flowId)
          void recordAdoptionEvent("capture_started", {
            flowId: detail.flowId,
          });
        setSheetMode("preselected");
        setSheetOpen(true);
      }
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pwa:open-tx", handler);
      return () => window.removeEventListener("pwa:open-tx", handler);
    }
  }, []);

  const activeNav: NavItem | null =
    pathname === "/"
      ? "home"
      : pathname === "/registros"
        ? "records"
        : pathname === "/compromissos"
          ? "compromissos"
          : pathname === "/hub" || pathname?.startsWith("/hub/")
            ? "hub"
            : null;

  // B1: top-5 most-used categories feed the picker's "Mais usadas" section.
  const recentCategoryIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tx of transactions ?? []) {
      if (!tx.categoryId) continue;
      counts.set(tx.categoryId, (counts.get(tx.categoryId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);
  }, [transactions]);

  function openSheetLocal() {
    setSheetMode("new");
    setInitialDescription("");
    setCaptureFlowId(undefined);
    setSheetOpen(true);
  }

  function closeSheetLocal() {
    setSheetOpen(false);
    setInitialDescription("");
    setCaptureFlowId(undefined);
    closeSheet();
    setDiscardOpen(false);
    setPendingNav(null);
  }

  function navigateTo(item: NavItem) {
    if (item === "home") router.push("/");
    else if (item === "records") router.push("/registros");
    else if (item === "compromissos") router.push("/compromissos");
    else if (item === "hub") router.push("/hub");
  }

  /** Close sheet, but confirm first when the form has unsaved edits. */
  function requestCloseSheet() {
    if (
      isDirty &&
      (effectiveSheetMode === "new" || effectiveSheetMode === "preselected")
    ) {
      setPendingNav(null);
      setDiscardOpen(true);
      return;
    }
    closeSheetLocal();
  }

  function handleNavClick(item: NavItem) {
    // Navigating away while the tx sheet is dirty also needs confirm.
    if (
      isDirty &&
      effectiveSheetOpen &&
      (effectiveSheetMode === "new" || effectiveSheetMode === "preselected")
    ) {
      setPendingNav(item);
      setDiscardOpen(true);
      return;
    }
    closeSheetLocal();
    navigateTo(item);
  }

  function confirmDiscard() {
    const nav = pendingNav;
    closeSheetLocal();
    if (nav) navigateTo(nav);
  }

  async function handleSave(data: SaveData) {
    try {
      // #185: a chave de idempotência da intent (mintada pelo sheet, uma por
      // intent) é repassada verbatim a cada mutator — a camada commands a
      // preserva, então retries/replays dedupam em vez de duplicar.
      const idOption =
        data.idempotencyKey !== undefined ? { idempotencyKey: data.idempotencyKey } : {};
      if (data.kind === "transfer") {
        await createTransfer({
          description: data.description || "Transferência",
          amountCents: data.amountCents,
          date: data.date,
          fromAccountId: data.fromAccountId ?? "",
          toAccountId: data.toAccountId ?? "",
          ...idOption,
        });
      } else if (data.originKind === "card" && data.accountId) {
        // H-01: the card nature is preserved to the executor — invoice path
        // only; income on a card is rejected (the API answers 422 as well).
        if (data.kind !== "expense") {
          throw new Error("Apenas despesas podem usar cartão.");
        }
        if (data.installmentsTotal && data.installmentsTotal > 1) {
          await createInstallments({
            accountId: data.accountId,
            description: data.description,
            totalAmountCents: data.amountCents,
            purchaseDate: data.date,
            installmentsTotal: data.installmentsTotal,
            categoryId: data.categoryId,
            ...(data.subcategoryId ? { subcategoryId: data.subcategoryId } : {}),
            ...(data.notes ? { notes: data.notes } : {}),
            ...idOption,
          });
        } else {
          await createCardPurchase({
            accountId: data.accountId,
            description: data.description,
            amountCents: data.amountCents,
            date: data.date,
            categoryId: data.categoryId,
            ...(data.subcategoryId ? { subcategoryId: data.subcategoryId } : {}),
            ...(data.notes ? { notes: data.notes } : {}),
            ...idOption,
          });
        }
      } else {
        await addTransaction({
          id: nextId(),
          description: data.description,
          amountCents: data.amountCents,
          date: data.date,
          kind: data.kind,
          categoryId: data.categoryId ?? "",
          accountId: data.accountId ?? "",
          ...(data.notes ? { notes: data.notes } : {}),
          ...idOption,
        });
      }
      if (captureFlowId)
        void recordAdoptionEvent("capture_completed", {
          flowId: captureFlowId,
        });
      if (!readOnly) closeSheetLocal();
    } catch (e) {
      throw e;
    }
  }

  return (
    <div className="flex min-h-dvh w-full bg-bg">
      {/* Atmosphere canvas: fixed top glow, rendered once (item premium 2) */}
      <div className="atmosphere" aria-hidden="true" />
      {/* Desktop Sidebar Rail */}
      <SidebarRail onNewTransaction={() => openSheetLocal()} />

      {/* Main Content Shell */}
      <div
        data-shell="root"
        className="relative mx-auto flex min-h-dvh w-full max-w-[var(--shell-max-w)] lg:max-w-none flex-1 flex-col bg-bg transition-all"
      >
        <div className="flex-1 w-full max-w-7xl mx-auto">
          <SwipeNav>{children}</SwipeNav>
        </div>

        {/* Mobile Bottom Navigation (4 tabs + FAB quick menu) */}
        <BottomNav
          active={activeNav}
          onNavClick={handleNavClick}
        />

        {/* New Transaction sheet (generic + preselected capture modes) */}
        <BottomSheet
          open={effectiveSheetOpen}
          onClose={requestCloseSheet}
          title={
            effectiveSheetMode === "new"
              ? "Novo lançamento"
              : effectivePreselectedKind === "expense"
                ? "Nova despesa"
                : effectivePreselectedKind === "income"
                  ? "Nova receita"
                  : "Nova transferência"
          }
        >
          <NewTransactionSheet
            key={effectivePreselectedKind}
            accounts={accounts}
            categories={categories}
            onSave={handleSave}
            onAddCategory={addCategory}
            onAddAccount={addAccount}
            onAddCard={addCard}
            initialTab={effectivePreselectedKind}
            initialDescription={initialDescription}
            recentCategoryIds={recentCategoryIds}
          />
        </BottomSheet>

        <ConfirmActionDialog
          open={discardOpen}
          title="Descartar alterações?"
          message="Você tem alterações não salvas. Deseja sair sem salvar?"
          confirmLabel="Descartar"
          cancelLabel="Continuar editando"
          danger
          onConfirm={confirmDiscard}
          onCancel={() => {
            setDiscardOpen(false);
            setPendingNav(null);
          }}
        />

        <TedChatLauncher />
        {pendingInviteCount > 0 && !overlayOpen && (
          <div data-testid="pending-invites-badge" className="fixed bottom-20 right-5 z-50 flex items-center gap-2 rounded-full bg-primary px-3 py-2 text-[12px] font-bold text-primary-foreground shadow-elevated" aria-label={`${pendingInviteCount} convite(s) pendente(s)`}>
            <Bell size={14} strokeWidth={2.4} aria-hidden="true" />
            <span>{pendingInviteCount}</span>
          </div>
        )}
      </div>
    </div>
  );
}
