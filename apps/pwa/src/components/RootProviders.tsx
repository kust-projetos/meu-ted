"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { isApiConfigured } from "@/lib/api/client";
import { cleanupOrphanedLegacyTokens } from "@/lib/auth/token-store";
import { ApiUnconfiguredScreen } from "@/components/ApiUnconfiguredScreen";
import { AuthGate } from "@/features/auth/AuthGate";
import { AppStateProvider } from "@/lib/state/app-state-context";
import { SheetProvider } from "@/lib/sheet-context";
import { UnsavedChangesProvider } from "@/lib/unsaved-changes";
import { SWCoordinator } from "@/lib/sw-coordinator";
import { WorkspaceProvider } from "@/lib/auth/workspace-context";
import { ThemeProvider } from "@/lib/theme";
import { initRUM } from "@/lib/observability/web-vitals";

const subscribeToHydration = () => () => {};
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

/**
 * Provider tree (ThemeProvider > agents-sdk: AuthGate > WorkspaceProvider > AppStateProvider)
 *
 * Fail closed: on origins without a configured authoritative API, only the
 * ApiUnconfiguredScreen renders — no app content, no mock data, no AuthGate.
 *
 * Item 7 (SSR flash): this Client Component is prerendered on the server
 * (Next docs: Client Components + RSC payload prerender HTML, then hydrate),
 * where `window` is absent and the same-origin `/api/backend` default cannot
 * resolve — so the prerender MUST NOT emit ApiUnconfiguredScreen, or first
 * paint flashes a false "Configuração necessária" that hydration immediately
 * replaces with login. Until mount we render a neutral placeholder (no app
 * content, no mock data, no auth surface, no server fetch); the fail-closed
 * check below still runs on every mounted render.
 */
export function RootProviders({ children }: { children: React.ReactNode }) {
  const booted = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  useEffect(() => {
    // RUM boot (fail-closed, default OFF): initRUM never throws and returns
    // a cleanup disconnecting its observers/listener, so React StrictMode
    // mount/unmount cycles never retain or duplicate them.
    let cleanupRUM: (() => void) | undefined;
    try {
      cleanupRUM = initRUM();
    } catch {
      /* noop */
    }
    // T2.3 B3 (caminho de limpeza do B2): com NEXT_PUBLIC_LEGACY_BEARER_COMPAT
    // off, remove os tokens órfãos legados do boot; com a flag on, no-op
    // (coexistência). Best-effort, nunca quebra o boot.
    try {
      cleanupOrphanedLegacyTokens();
    } catch {
      /* noop */
    }
    return () => {
      try {
        cleanupRUM?.();
      } catch {
        /* noop */
      }
    };
  }, []);
  const pathname = usePathname();

  if (!booted) {
    return (
      <ThemeProvider>
        <div
          data-testid="root-boot-placeholder"
          role="status"
          aria-label="Carregando…"
        />
      </ThemeProvider>
    );
  }

  if (!isApiConfigured()) {
    return (
      <ThemeProvider>
        <ApiUnconfiguredScreen />
      </ThemeProvider>
    );
  }

  // Exact invite pathname only: usePathname() never carries a query string,
  // so "/convites" (or any prefix-sibling) must NOT bypass AuthGate.
  const isInviteRoute = pathname === "/convite";

  // Single SWCoordinator/UnsavedChangesProvider instance across route branch
  // changes: only the content BELOW the coordinator swaps type (invite sheet
  // vs AuthGate-gated app tree), so switching / ↔ /convite never unmounts
  // the coordinator and never loses activationRequested/activatedWorkers/
  // pendingReload state. The invite branch still bypasses AuthGate +
  // WorkspaceProvider/AppStateProvider (public token flow).
  const routeContent = isInviteRoute ? (
    <SheetProvider>{children}</SheetProvider>
  ) : (
    <AuthGate>
      <WorkspaceProvider>
        <AppStateProvider>
          <SheetProvider>{children}</SheetProvider>
        </AppStateProvider>
      </WorkspaceProvider>
    </AuthGate>
  );

  return (
    <ThemeProvider>
      <UnsavedChangesProvider>
        <SWCoordinator>{routeContent}</SWCoordinator>
      </UnsavedChangesProvider>
    </ThemeProvider>
  );
}
