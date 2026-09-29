/**
 * SWCoordinator — registers /sw.js, handles kill-switch, and coordinates
 * waiting-worker activation based on UnsavedChanges dirty state.
 *
 * Provider tree (RootProviders):
 *   UnsavedChangesProvider > SWCoordinator > AppStateProvider > SheetProvider
 *
 * Clean + waiting → postMessage CLEAN_UPDATE → skipWaiting → single reload
 * Dirty + waiting → retain waiting worker (no message, no reload)
 */

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { recordAdoptionEvent } from "@/lib/api/adoption";
const CACHE_PREFIX = "pi-finance";

export function useSWCoordinator() {
  const { isDirty } = useUnsavedChanges();
  return { isDirty };
}

/**
 * Injectable reload indirection. Production calls `window.location.reload()`;
 * tests spy on `reloadAdapter.reload` (jsdom's Location#reload is not
 * mockable — it throws "Not implemented: navigation").
 */
export const reloadAdapter = {
  reload: () => window.location.reload(),
};

function clearPiFinanceCaches() {
  if (!("caches" in globalThis)) return;
  void caches.keys().then((names) => {
    names
      .filter((n) => n.startsWith(CACHE_PREFIX))
      .forEach((n) => void caches.delete(n));
  });
}

export function consumeAdoptionMarker(
  value: string,
): { eventType: "notification_opened"; cleanPath: string } | undefined {
  const url = new URL(value, "https://pi-finance.local");
  if (url.searchParams.get("pwa_adoption") !== "notification_opened")
    return undefined;
  url.searchParams.delete("pwa_adoption");
  const cleanPath = `${url.pathname}${url.search}${url.hash}`;
  return { eventType: "notification_opened", cleanPath };
}
/**
 * Deferred-reload state for the controllerchange race.
 *
 * CLEAN_UPDATE may be sent while clean, but the user can become dirty before
 * `controllerchange` fires (skipWaiting already happened — it cannot be
 * undone). Reloading immediately would discard edits, so a dirty
 * controllerchange only marks a pending reload; the single reload happens
 * when the form becomes clean.
 */
export type SWReloadState = {
  reloaded: boolean;
  pendingReload: boolean;
};

export const initialSWReloadState: SWReloadState = {
  reloaded: false,
  pendingReload: false,
};

/**
 * Pure transition for a `controllerchange` event. Single shared mechanism
 * used by every controllerchange callback through the current dirty ref.
 * - Already reloaded → no duplicate reload.
 * - Dirty → defer (pending, no reload yet).
 * - Clean → reload immediately, exactly once.
 */
export function resolveControllerChange(
  state: SWReloadState,
  isDirty: boolean,
): { next: SWReloadState; shouldReload: boolean } {
  if (state.reloaded) return { next: state, shouldReload: false };
  if (isDirty)
    return {
      next: { reloaded: false, pendingReload: true },
      shouldReload: false,
    };
  return {
    next: { reloaded: true, pendingReload: false },
    shouldReload: true,
  };
}

/**
 * Pure transition for the form becoming clean while a reload is pending.
 * Fires the single deferred reload, or does nothing when there is nothing
 * pending / the reload already happened.
 */
export function resolveBecameClean(state: SWReloadState): {
  next: SWReloadState;
  shouldReload: boolean;
} {
  if (state.reloaded) return { next: state, shouldReload: false };
  if (!state.pendingReload) return { next: state, shouldReload: false };
  return {
    next: { reloaded: true, pendingReload: false },
    shouldReload: true,
  };
}
/**
 * Apply CLEAN_UPDATE to a waiting worker when the form is clean.
 * Returns true if a message was sent (caller should expect activation/reload).
 */
export function activateWaitingIfClean(
  registration: ServiceWorkerRegistration | null | undefined,
  isDirty: boolean,
): boolean {
  if (!registration) return false;
  const waiting = registration.waiting;
  if (!waiting) return false;
  if (isDirty) return false;
  waiting.postMessage({ type: "CLEAN_UPDATE" });
  return true;
}

export function SWCoordinator({ children }: { children: ReactNode }) {
  const { isDirty, isDirtyNow, dirtyVersion } = useUnsavedChanges();
  // isDirtyNow is a stable callback reading the provider's live refs
  // (countRef/tokenSetRef mutated synchronously in trackWrite/markDirty),
  // so closing over it in mount-once effects still observes current state
  // with no passive-effect lag.
  const reloadStateRef = useRef<SWReloadState>({ ...initialSWReloadState });
  // Set the first time CLEAN_UPDATE is posted (either activation path).
  // Guards the persistent controllerchange listener: a controllerchange
  // without a prior activation request does nothing.
  const activationRequestedRef = useRef(false);
  // Identity of waiting workers that already received CLEAN_UPDATE. Shared
  // by the register() and getRegistration() paths so the same worker is
  // never messaged twice (e.g. register waiting + getRegistration polling
  // the same worker, or repeated dirty→clean cycles). A distinct waiting
  // worker object (new version) is still activatable. Recorded only when
  // CLEAN_UPDATE was actually sent.
  const activatedWorkersRef = useRef<WeakSet<ServiceWorker>>(
    new WeakSet<ServiceWorker>(),
  );
  const bootRef = useRef(false);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (typeof window === "undefined" || !("serviceWorker" in navigator))
      return;
    const marker = consumeAdoptionMarker(window.location.href);
    if (marker) {
      void recordAdoptionEvent(marker.eventType);
      window.history.replaceState(null, "", marker.cleanPath);
    }
    const onMessage = (
      event: MessageEvent<{ type?: string; eventType?: string }>,
    ) => {
      if (event.data?.type === "ADOPTION_EVENT" && event.data.eventType) {
        void recordAdoptionEvent(
          event.data.eventType as Parameters<typeof recordAdoptionEvent>[0],
        );
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    void fetch("/pwa-control", { cache: "no-store" })
      .then((res) => res.json())
      .then((body: { enabled?: boolean }) => {
        if (body?.enabled === false) {
          void navigator.serviceWorker.getRegistrations().then((regs) => {
            regs.forEach((r) => void r.unregister());
          });
          clearPiFinanceCaches();
        }
      })
      .catch(() => {
        /* pwa-control may be unavailable during SSG */
      });

    let registration: ServiceWorkerRegistration | null = null;
    let cancelled = false;
    const statechangeCleanups: Array<() => void> = [];

    // Single persistent listener for the coordinator lifetime. Shared by
    // both the register() and getRegistration() activation paths.
    const onControllerChange = () => {
      if (!activationRequestedRef.current) return;
      const dirty = isDirtyNow();
      const { next, shouldReload } = resolveControllerChange(
        reloadStateRef.current,
        dirty,
      );
      reloadStateRef.current = next;
      if (shouldReload) reloadAdapter.reload();
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    const maybeActivate = (reg: ServiceWorkerRegistration) => {
      if (cancelled) return;
      if (reloadStateRef.current.reloaded) return;
      if (reloadStateRef.current.pendingReload) return;
      const waiting = reg.waiting;
      if (!waiting) return;
      if (activatedWorkersRef.current.has(waiting)) return;
      const dirty = isDirtyNow();
      if (dirty) return;
      const sent = activateWaitingIfClean(reg, dirty);
      if (sent) {
        activatedWorkersRef.current.add(waiting);
        activationRequestedRef.current = true;
      }
    };

    const onUpdateFound = () => {
      if (cancelled) return;
      if (!registration) return;
      const installing = registration.installing;
      if (!installing) return;
      const onStateChange = () => {
        if (cancelled) return;
        if (installing.state === "installed" && registration) {
          maybeActivate(registration);
        }
      };
      installing.addEventListener("statechange", onStateChange);
      statechangeCleanups.push(() => {
        installing.removeEventListener("statechange", onStateChange);
      });
    };

    void Promise.resolve()
      .then(() => navigator.serviceWorker.register("/sw.js"))
      .then((reg) => {
        if (cancelled) return;
        if (!reg) return;
        registration = reg;
        if (reg.waiting) maybeActivate(reg);
        reg.addEventListener("updatefound", onUpdateFound);
        void reg.update().catch(() => {});
      })
      .catch(() => {
        /* registration can fail offline / file:// / blocked SW (serviceWorkers:block may yield undefined) */
      });

    return () => {
      cancelled = true;
      bootRef.current = false;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      if (registration) {
        registration.removeEventListener("updatefound", onUpdateFound);
      }
      while (statechangeCleanups.length > 0) {
        const cleanup = statechangeCleanups.pop();
        cleanup?.();
      }
    };
  }, [isDirtyNow]);

  // When form becomes clean while a worker is waiting, activate once.
  // Guarded by the synchronous dirty query + effect cancellation so a query
  // started while clean that resolves after the form becomes dirty (or after
  // unmount) never posts CLEAN_UPDATE. No controllerchange attach here: the
  // single persistent listener above handles it, so it persists through
  // dirty→clean. A controllerchange that fired while dirty only marks a
  // pending reload (skipWaiting cannot be undone); becoming clean drains it
  // with exactly one reload. Pending state lives in reloadStateRef shared
  // across both effects.
  // dirtyVersion forces a rerun on every real dirty-state transition, so a
  // markDirty → controllerchange → markClean round-trip inside ONE React
  // batch (isDirty starts/ends false) still drains a pending reload.
  useEffect(() => {
    void dirtyVersion;
    if (isDirty) return;
    if (!("serviceWorker" in navigator)) return;
    if (!isDirtyNow() && reloadStateRef.current.pendingReload) {
      const { next, shouldReload } = resolveBecameClean(
        reloadStateRef.current,
      );
      reloadStateRef.current = next;
      if (shouldReload) reloadAdapter.reload();
      if (reloadStateRef.current.reloaded) return;
    }
    let cancelled = false;
    void navigator.serviceWorker.getRegistration().then((reg) => {
      if (cancelled) return;
      if (!reg?.waiting) return;
      if (reloadStateRef.current.reloaded) return;
      if (reloadStateRef.current.pendingReload) return;
      if (activatedWorkersRef.current.has(reg.waiting)) return;
      const dirty = isDirtyNow();
      if (dirty) return;
      const sent = activateWaitingIfClean(reg, dirty);
      if (sent && !reloadStateRef.current.reloaded) {
        if (cancelled) return;
        if (isDirtyNow()) return;
        if (reloadStateRef.current.pendingReload) return;
        activatedWorkersRef.current.add(reg.waiting);
        activationRequestedRef.current = true;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isDirty, isDirtyNow, dirtyVersion]);

  return <>{children}</>;
}
