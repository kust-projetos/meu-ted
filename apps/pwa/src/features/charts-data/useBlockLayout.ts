"use client";

import { useCallback, useEffect, useState } from "react";
import { clampLayout as clampNew, moveBlock } from "@/lib/ui/block-layout";
export { moveBlock, reorderBlock, layoutStorageKey } from "@/lib/ui/block-layout";
export type { BlockLayoutMode, BlockLayoutState, BlockLayoutSchema } from "@/lib/ui/block-layout";
export { useBlockLayout as useWorkspaceBlockLayout } from "@/lib/ui/use-block-layout";

export type BlockLayout = { order: string[]; hidden: string[] };
export function clampLayout(raw: unknown, defaultOrder: string[]): BlockLayout {
  return clampNew(raw, defaultOrder) as BlockLayout;
}
/** Backwards-compatible adapter; new surfaces should use @/lib/ui/use-block-layout. */
export function useBlockLayout(storageKey: string, defaultOrder: string[]) {
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<BlockLayout>(() => {
    try {
      const raw = typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
      return clampLayout(raw ? JSON.parse(raw) : null, defaultOrder);
    } catch { return clampLayout(null, defaultOrder); }
  });
  useEffect(() => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* storage unavailable */ }
  }, [storageKey, layout]);
  const toggle = useCallback((id: string) => setLayout(prev => ({
    order: prev.order,
    hidden: prev.hidden.includes(id) ? prev.hidden.filter(item => item !== id) : [...prev.hidden, id],
  })), []);
  const move = useCallback((id: string, direction: -1 | 1) => setLayout(prev => ({ ...prev, order: moveBlock(prev.order, id, direction) })), []);
  const reset = useCallback(() => setLayout({ order: [...defaultOrder], hidden: [] }), [defaultOrder]);
  return { layout, visible: layout.order.filter(id => !layout.hidden.includes(id)), editing, setEditing, toggle, move, reset, hydrated: true };
}
