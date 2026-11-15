"use client";

export type DonutSlice = {
  id: string;
  name: string;
  valueCents: number;
  color?: string | null;
};

const FALLBACK_PALETTE = ["#0E8C5A", "#3E6FB0", "#B7791F", "#C8483B", "#805AD5"];

/**
 * Donut de categorias em SVG próprio (sem dependências). Máximo de fatias
 * decidido pelo chamador (a API já agrega o restante em "Outras"); ao
 * tocar numa fatia o centro exibe o valor dela.
 */
export function DonutChart({
  slices,
  size = 180,
  thickness = 12,
  formatValue,
  selectedId,
  onSelect,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  formatValue: (cents: number) => string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.valueCents), 0);
  const active = slices.find((slice) => slice.id === selectedId) ?? slices[0];
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const summary =
    slices.length === 0
      ? "Sem dados de categorias"
      : `Donut com ${slices.length} fatias, total ${formatValue(total)}: ` +
        slices.map((slice) => `${slice.name} ${formatValue(slice.valueCents)}`).join(", ");

  const handleSelect = (id: string) => {
    if (onSelect) onSelect(id);
  };

  return (
    <div className="flex items-center gap-4">
      <div className="relative flex-none" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={summary}
          className="[&_circle]:transition-all [&_circle]:duration-300 [&_circle]:motion-reduce:transition-none"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={thickness}
            className="stroke-[var(--surface-2)]"
          />
          {slices.map((slice, index) => {
            const fraction = total > 0 ? Math.max(0, slice.valueCents) / total : 0;
            const dash = fraction * circumference;
            const gap = circumference - dash;
            const rotation = slices
              .slice(0, index)
              .reduce((sum, previous) => sum + (total > 0 ? Math.max(0, previous.valueCents) / total : 0), 0) * 360;
            const dimmed = active && slice.id !== active.id;
            return (
              <g key={slice.id}>
                <title>{`${slice.name}: ${formatValue(slice.valueCents)}`}</title>
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={slice.color ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length]}
                  strokeWidth={active?.id === slice.id ? thickness + 2 : thickness}
                  strokeDasharray={`${dash} ${gap}`}
                  strokeLinecap="butt"
                  transform={`rotate(${rotation} ${size / 2} ${size / 2})`}
                  opacity={dimmed ? 0.35 : 1}
                  onClick={() => handleSelect(slice.id)}
                  style={onSelect ? { cursor: "pointer" } : undefined}
                />
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
          <span className="max-w-[70%] truncate text-[11px] font-bold uppercase tracking-wider text-text-muted">
            {active?.name ?? "—"}
          </span>
          <span className="text-[16px] font-bold tabular-nums text-text-primary" data-testid="donut-center-value">
            {formatValue(active?.valueCents ?? 0)}
          </span>
        </div>
        <ul className="sr-only">
          {slices.map((slice) => (
            <li key={slice.id}>{`${slice.name}: ${formatValue(slice.valueCents)}`}</li>
          ))}
        </ul>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {slices.map((slice, index) => (
          <li key={slice.id}>
            <button
              type="button"
              onClick={onSelect ? () => onSelect(slice.id) : undefined}
              aria-pressed={active?.id === slice.id}
              aria-label={`${slice.name}, ${formatValue(slice.valueCents)}`}
              className={`flex min-h-11 w-full items-center gap-2 rounded-[10px] px-2 py-1 text-left transition-colors ${
                active?.id === slice.id ? "bg-surface-2" : "hover:bg-surface-2/60"
              }`}
            >
              <span
                className="h-2.5 w-2.5 flex-none rounded-full"
                style={{ background: slice.color ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text-primary">{slice.name}</span>
              <span className="shrink-0 text-[12px] font-bold tabular-nums text-text-secondary">{formatValue(slice.valueCents)} · {total > 0 ? `${((slice.valueCents / total) * 100).toFixed(1).replace(".", ",")}%` : "0,0%"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
