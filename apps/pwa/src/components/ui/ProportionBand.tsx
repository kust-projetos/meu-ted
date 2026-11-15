import type { CSSProperties } from "react";

export interface ProportionSegment {
  label: string;
  pct: number;
  colorToken: string;
  amount?: string;
}

export interface ProportionBandProps {
  segments: ProportionSegment[];
  className?: string;
}

function tokenColor(value: string): string {
  return value.startsWith("var(") ||
    value.startsWith("#") ||
    /^(rgb|hsl|oklch|color)\(/i.test(value)
    ? value
    : `var(--${value})`;
}

export function ProportionBand({
  segments,
  className = "",
}: ProportionBandProps) {
  const summary = segments
    .map(({ label, pct }) => `${label}: ${pct}%`)
    .join(", ");
  return (
    <div className={className}>
      <div
        role="img"
        aria-label={
          summary
            ? `Proporção por categoria — ${summary}`
            : "Sem dados de proporção"
        }
        className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2"
      >
        {segments.map((segment, index) => (
          <span
            key={`${segment.label}-${index}`}
            aria-hidden="true"
            className="h-full"
            style={
              {
                width: `${Math.max(0, segment.pct)}%`,
                backgroundColor: tokenColor(segment.colorToken),
              } satisfies CSSProperties
            }
          />
        ))}
      </div>
      <ul className="mt-3 grid list-none grid-cols-2 gap-x-4 gap-y-2 p-0 sm:grid-cols-3">
        {segments.map((segment, index) => (
          <li key={`${segment.label}-${index}`} className="min-w-0 text-sm">
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: tokenColor(segment.colorToken) }}
              />
              <span className="truncate text-text-secondary">
                {segment.label}
              </span>
            </span>
            <span className="ml-4 block tabular text-xs text-text-muted">
              {segment.pct}%{segment.amount ? ` · ${segment.amount}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ProportionBand;
