export type BlockLayoutMode = "essential" | "complete";
export type BlockLayoutState = {
  order: string[];
  hidden: string[];
  mode: BlockLayoutMode;
  overrides: Record<string, "shown" | "hidden">;
};
export type BlockLayoutSchema = { all: string[]; essentialDefaultHidden: string[] };

export function layoutStorageKey(scope: { workspaceId?: string | null; surface: "home" | "reports" }) {
  return `meu-ted:block-layout:v2:${scope.workspaceId ?? "default"}:${scope.surface}`;
}

export function clampLayout(raw: unknown, schema: BlockLayoutSchema, mode?: BlockLayoutMode): BlockLayoutState;
export function clampLayout(raw: unknown, schema: string[]): { order: string[]; hidden: string[] };
export function clampLayout(raw: unknown, schema: BlockLayoutSchema | string[], mode: BlockLayoutMode = "complete") {
  const all = Array.isArray(schema) ? schema : schema.all;
  const presetHidden = !Array.isArray(schema) && mode === "essential" ? schema.essentialDefaultHidden : [];
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const order = Array.isArray(record.order) ? record.order.filter((id): id is string => typeof id === "string" && all.includes(id)) : [];
  for (const id of all) if (!order.includes(id)) order.push(id);
  const overrides: Record<string, "shown" | "hidden"> = {};
  if (record.overrides && typeof record.overrides === "object") {
    for (const [id, value] of Object.entries(record.overrides)) {
      if (all.includes(id) && (value === "shown" || value === "hidden")) overrides[id] = value;
    }
  } else if (Array.isArray(record.hidden)) {
    for (const id of record.hidden) if (typeof id === "string" && all.includes(id)) overrides[id] = "hidden";
  }
  if (Array.isArray(schema)) {
    const hidden = Array.isArray(record.hidden) ? record.hidden.filter((id): id is string => typeof id === "string" && all.includes(id)) : [];
    return { order: [...new Set(order)], hidden: [...new Set(hidden)] };
  }
  const hidden = all.filter(id => overrides[id] ? overrides[id] === "hidden" : presetHidden.includes(id));
  return { order: [...new Set(order)], hidden, mode, overrides };
}

export function moveBlock(order: string[], id: string, direction: -1 | 1): string[] {
  const from = order.indexOf(id);
  return from < 0 ? [...order] : reorderBlock(order, from, from + direction);
}
export function reorderBlock(order: string[], fromIndex: number, toIndex: number): string[] {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= order.length || toIndex < 0 || toIndex >= order.length) return [...order];
  const next = [...order];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item!);
  return next;
}
