"use client";

export type HeatmapWeek = {
  weekStart: string;
  days: { date: string; totalCents: number; level: 0 | 1 | 2 | 3 | 4 }[];
};

const OPACITY: Record<number, number> = { 0: 0, 1: 0.22, 2: 0.45, 3: 0.7, 4: 1 };

/**
 * Heatmap semanal 7 linhas x 4 semanas estilo GitHub. Intensidade em
 * esmeralda sobre carvão/superfície via tokens (theme-aware).
 */
export function WeeklyHeatmap({
  weeks,
  formatValue,
}: {
  weeks: HeatmapWeek[];
  formatValue: (cents: number) => string;
}) {
  const peak = weeks.flatMap((week) => week.days).reduce((max, day) => Math.max(max, day.totalCents), 0);
  const summary =
    peak <= 0
      ? "Mapa de calor sem gastos no período"
      : `Mapa de calor de gastos, pico de ${formatValue(peak)} por dia`;
  if (weeks.length === 0 || weeks.every((week) => week.days.length === 0)) {
    return <p className="py-4 text-center text-sm text-text-muted">Sem dados no período.</p>;
  }
  return (
    <div>
      <div
        className="grid grid-cols-4 gap-1.5"
        role="img"
        aria-label={summary}
      >
        {weeks.map((week) => (
          <div key={week.weekStart} className="grid grid-rows-7 gap-1.5" aria-hidden="true">
            {week.days.map((day) => (
              <div
                key={day.date}
                title={`${day.date}: ${formatValue(day.totalCents)}`}
                aria-label={`${day.date}: ${formatValue(day.totalCents)}`}
                className="aspect-square w-full rounded-[4px] border border-border-subtle transition-all duration-300 motion-reduce:transition-none"
                style={
                  day.level === 0
                    ? { background: "var(--surface-2)" }
                    : { background: "var(--primary)", opacity: OPACITY[day.level] }
                }
              />
            ))}
          </div>
        ))}
      </div>
      <ul className="sr-only">
        {weeks.flatMap((week) =>
          week.days.map((day) => (
            <li key={day.date}>{`${day.date}: ${formatValue(day.totalCents)}`}</li>
          )),
        )}
      </ul>
      <div className="mt-2 flex items-center justify-end gap-1" aria-hidden="true">
        <span className="text-[10px] font-semibold text-text-muted">Menos</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className="h-2.5 w-2.5 rounded-[3px] border border-border-subtle"
            style={
              level === 0
                ? { background: "var(--surface-2)" }
                : { background: "var(--primary)", opacity: OPACITY[level] }
            }
          />
        ))}
        <span className="text-[10px] font-semibold text-text-muted">Mais</span>
      </div>
    </div>
  );
}
