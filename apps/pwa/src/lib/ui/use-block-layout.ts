"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { clampLayout, layoutStorageKey, moveBlock, reorderBlock, type BlockLayoutMode, type BlockLayoutSchema, type BlockLayoutState } from "./block-layout";

export type Options = { workspaceId?: string | null; surface: "home" | "reports"; schema: BlockLayoutSchema; defaultMode?: BlockLayoutMode };
const legacyKey = "meu-ted:report-blocks";
const migrationKey = "meu-ted:block-layout:v2:legacy-report-import";

function read(key: string, options: Options): BlockLayoutState {
  const initial = clampLayout(null, options.schema, options.defaultMode ?? "complete");
  try {
    const storage = window.localStorage;
    const existing = storage.getItem(key);
    if (existing !== null) return clampLayout(JSON.parse(existing), options.schema, options.defaultMode ?? "complete");
    // Legacy layout was global: import once for the first workspace to read reports; retain the source untouched.
    if (options.surface === "reports" && storage.getItem(migrationKey) !== "1") {
      const legacy = storage.getItem(legacyKey);
      if (legacy !== null) {
        const imported = clampLayout({ ...JSON.parse(legacy) as object, mode: "complete" }, options.schema, "complete");
        storage.setItem(key, JSON.stringify({ ...imported, migrationVersion: 1 }));
        storage.setItem(migrationKey, "1");
        return imported;
      }
      storage.setItem(migrationKey, "1");
    }
  } catch { /* unavailable or corrupt storage: continue with defaults */ }
  return initial;
}

export function useBlockLayout(options: Options) {
  const key = layoutStorageKey(options);
  const [state, setState] = useState(() => clampLayout(null, options.schema, options.defaultMode ?? "complete"));
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(read(key, options));
    setHydrated(true);
  // Schema is treated as a stable component contract.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(key, JSON.stringify({ ...state, migrationVersion: 1 })); } catch { /* storage may be unavailable */ }
  }, [key, state, hydrated]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== key || event.newValue === null) return;
      try { setState(clampLayout(JSON.parse(event.newValue), options.schema, options.defaultMode ?? "complete")); } catch { /* ignore malformed peer data */ }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key, options.schema, options.defaultMode]);
  const setMode = useCallback((mode: BlockLayoutMode) => setState(prev => clampLayout({ ...prev, mode }, options.schema, mode)), [options.schema]);
  const toggle = useCallback((id: string) => setState(prev => {
    if (!options.schema.all.includes(id)) return prev;
    const shown = prev.hidden.includes(id);
    return clampLayout({ ...prev, overrides: { ...prev.overrides, [id]: shown ? "shown" : "hidden" } }, options.schema, prev.mode);
  }), [options.schema]);
  const move = useCallback((id: string, direction: -1 | 1) => setState(prev => ({ ...prev, order: moveBlock(prev.order, id, direction) })), []);
  const reorder = useCallback((id: string, toIndex: number) => setState(prev => ({
    ...prev, order: reorderBlock(prev.order, prev.order.indexOf(id), toIndex),
  })), []);
  const reset = useCallback(() => setState(prev => clampLayout(null, options.schema, prev.mode)), [options.schema]);
  const visible = useMemo(() => state.order.filter(id => !state.hidden.includes(id)), [state]);
  return { state, visible, mode: state.mode, setMode, toggle, move, reorder, reset };
}
