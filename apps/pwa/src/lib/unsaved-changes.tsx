// UnsavedChangesContext — tracks dirty state across the app.
//
// Two complementary APIs:
//
//   1. Command-layer (legacy): `trackWrite()` registers a pending write; the
//      cleanup function is called on resolve. Used by createCommands() in
//      src/lib/state/commands.ts so the SW coordinator knows when a mutation
//      is in flight.
//
//   2. Form-layer (Phase 3): `markDirty(token)` / `markClean(token)` track
//      whether a form has unsaved input edits. Tokens are opaque symbols
//      (one per form instance) so two open forms do not clobber each
//      other. `isFormDirty(token)` exposes per-form state for tests.
//
// `isDirty` (global) is true when ANY source (trackWrite or token) is dirty.
//
// Why both? TrackWrite only fires when a command has been invoked; if the
// user types into a field and pauses, the SW would still see clean state
// and could swap in a new worker mid-edit. Form-layer dirty closes that
// gap and lets each form decide when to clear (cancel/success/retain on
// failure).

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface UnsavedChangesContextValue {
  /** True if any source (trackWrite or token) is dirty. */
  isDirty: boolean;
  /**
   * Monotonically increasing revision bumped on every real dirty-state
   * transition (trackWrite acquire/release, markDirty/markClean that
   * actually changes a source). Idempotent no-ops do not bump. Lets
   * effects observe a dirty→clean round-trip within a single React batch
   * (isDirty starts/ends false, so [isDirty] alone would not rerun).
   */
  dirtyVersion: number;
  /** Synchronous current dirty query (reads live refs, no effect lag). */
  isDirtyNow: () => boolean;
  /** Register a pending write. Returns a cleanup function (call on resolve). */
  trackWrite: () => () => void;
  /** Mark a token as dirty. Idempotent. */
  markDirty: (token: symbol) => void;
  /** Clear a token. Idempotent. No-op if token was never marked. */
  markClean: (token: symbol) => void;
  /** Inspect a token's dirty state. */
  isFormDirty: (token: symbol) => boolean;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

const NULL_VALUE: UnsavedChangesContextValue = {
  isDirty: false,
  dirtyVersion: 0,
  isDirtyNow: () => false,
  trackWrite: () => () => {},
  markDirty: () => {},
  markClean: () => {},
  isFormDirty: () => false,
};

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirtyCount, setDirtyCount] = useState(0);
  const countRef = useRef(0);
  const [dirtyTokens, setDirtyTokens] = useState<ReadonlySet<symbol>>(new Set());
  const tokenSetRef = useRef<Set<symbol>>(new Set());
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const versionRef = useRef(0);

  const bumpVersion = useCallback(() => {
    versionRef.current += 1;
    setDirtyVersion(versionRef.current);
  }, []);

  const trackWrite = useCallback(() => {
    countRef.current += 1;
    setDirtyCount(countRef.current);
    bumpVersion();
    let resolved = false;
    return () => {
      if (resolved) return;
      resolved = true;
      countRef.current -= 1;
      setDirtyCount(countRef.current);
      bumpVersion();
    };
  }, [bumpVersion]);

  const markDirty = useCallback((token: symbol) => {
    if (tokenSetRef.current.has(token)) return;
    tokenSetRef.current.add(token);
    setDirtyTokens(new Set(tokenSetRef.current));
    bumpVersion();
  }, [bumpVersion]);

  const markClean = useCallback((token: symbol) => {
    if (!tokenSetRef.current.has(token)) return;
    tokenSetRef.current.delete(token);
    setDirtyTokens(new Set(tokenSetRef.current));
    bumpVersion();
  }, [bumpVersion]);

  const isFormDirty = useCallback(
    (token: symbol) => dirtyTokens.has(token),
    [dirtyTokens],
  );

  // Synchronous read backed by the same refs mutated synchronously in
  // trackWrite/release and markDirty/markClean. Stable identity so event
  // handlers (e.g. SW controllerchange) can close over it and always see
  // live state without waiting for the passive isDirty effect to flush.
  const isDirtyNow = useCallback(
    () => countRef.current > 0 || tokenSetRef.current.size > 0,
    [],
  );

  const value = useMemo<UnsavedChangesContextValue>(
    () => ({
      isDirty: dirtyCount > 0 || dirtyTokens.size > 0,
      dirtyVersion,
      isDirtyNow,
      trackWrite,
      markDirty,
      markClean,
      isFormDirty,
    }),
    [dirtyCount, dirtyTokens, dirtyVersion, trackWrite, markDirty, markClean, isFormDirty, isDirtyNow],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChanges(): UnsavedChangesContextValue {
  const ctx = useContext(UnsavedChangesContext);
  if (!ctx) throw new Error("useUnsavedChanges must be used within UnsavedChangesProvider");
  return ctx;
}

/**
 * Stable token-bound form helpers. `markDirty` and `markClean` are bound to a
 * single token so callers cannot accidentally clear a sibling form. The token
 * is auto-removed on unmount.
 *
 * Safe to call outside an UnsavedChangesProvider: returns a local-only stub
 * (still flips a local flag so tests can verify the call) without touching
 * any global state.
 */
export function useFormDirtySafe(): {
  isDirty: boolean;
  markDirty: () => void;
  markClean: () => void;
} {
  // Hooks MUST be called unconditionally at the top level.
  const [localDirty, setLocalDirty] = useState(false);
  // Symbol is created once per hook instance via lazy initializer; reading the
  // value during render is safe because it never changes for the lifetime of
  // this component.
  const [token] = useState<symbol>(() => Symbol("form"));

  const ctx = useContext(UnsavedChangesContext);
  const live = ctx !== null;

  // Latest-context ref: the context *object* is recreated on every
  // setDirtyTokens (provider value useMemo depends on dirtyTokens /
  // isFormDirty). Depending on `ctx` directly would give the bound helpers
  // below a new identity on every keystroke, and any consumer effect
  // listing them as deps (e.g. the TransactionEditSheet sync effect) would
  // re-run and reset the form to the original values (snap-back bug).
  // Reading through the ref keeps markDirty/markClean STABLE across
  // dirty-state changes; only a provider mount/unmount (live) or a new
  // token changes their identity.
  const ctxRef = useRef(ctx);
  useEffect(() => {
    ctxRef.current = ctx;
  }, [ctx]);

  useEffect(() => {
    if (!live) return;
    return () => {
      ctxRef.current?.markClean(token);
    };
  }, [live, token]);

  const isDirty = live ? ctx!.isFormDirty(token) : localDirty;

  const markDirty = useCallback(() => {
    const c = ctxRef.current;
    if (c) c.markDirty(token);
    else setLocalDirty(true);
  }, [token]);

  const markClean = useCallback(() => {
    const c = ctxRef.current;
    if (c) c.markClean(token);
    else setLocalDirty(false);
  }, [token]);

  return { isDirty, markDirty, markClean };
}

/**
 * Safe variant: returns no-op trackWrite when there is no UnsavedChangesProvider
 * ancestor. Used by commands so isolated tests do not throw.
 */
export function useUnsavedChangesSafe(): UnsavedChangesContextValue {
  return useContext(UnsavedChangesContext) ?? NULL_VALUE;
}