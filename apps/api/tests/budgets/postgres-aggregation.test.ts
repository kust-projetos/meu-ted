/**
 * API-06 — agregação SQL dos budgets no Postgres (sem N+1).
 *
 * Invariantes documentadas aqui (espelham `getPeriodBounds` em
 * `src/budgets/postgres.ts`, idênticas às queries por-linha anteriores):
 * - boundaries INCLUSIVOS nos dois lados: `t.date >= start AND t.date <= end`,
 *   com `start`/`end` em `YYYY-MM-DD` calculados em JS (UTC);
 * - precisão em centavos inteiros: `amount_cents` é BIGINT, `SUM` agregado no
 *   Postgres e convertido com `Number()` (sem float intermediário);
 * - moeda: budgets não carregam moeda própria; o gasto soma `amount_cents`
 *   da mesma categoria/household, mesma unidade dos dois lados;
 * - workspace sempre filtrado: `b.household_id = $1` + join por
 *   `t.household_id = b.household_id`;
 * - pool: no máximo 2 queries por operação (budgets + 1 agregação), sem
 *   concorrência paralela — single-shot sequencial.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPostgresBudgetStore } from '../../src/budgets/postgres.js';

type Row = Record<string, unknown>;

const budgetRow = (overrides: Partial<Row> = {}): Row => ({
  id: 'b1',
  household_id: 'h1',
  category_id: 'c1',
  name: 'Mercado',
  amount_cents: 100_000,
  period: 'monthly',
  start_date: new Date('2026-06-01T00:00:00.000Z'),
  alert_threshold: 80,
  rollover: false,
  ...overrides,
});

const makePool = (handler: (text: string, values: unknown[]) => { rows: Row[] }) => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return handler(text, values);
    }),
  } as never;
  return { pool, calls };
};

describe('postgres listBudgets aggregation (API-06)', () => {
  it('issues exactly 2 queries for N budgets and maps spent per budget', async () => {
    const { pool, calls } = makePool((text) => {
      if (text.includes('GROUP BY')) {
        return { rows: [{ budget_id: 'b1', spent: '60000' }, { budget_id: 'b2', spent: '0' }] };
      }
      return {
        rows: [
          budgetRow({ id: 'b1', category_id: 'c1', amount_cents: 100_000 }),
          budgetRow({ id: 'b2', category_id: 'c2', amount_cents: 200_000, period: 'quarterly' }),
          budgetRow({ id: 'b3', category_id: 'c3', amount_cents: 300_000, period: 'yearly' }),
        ],
      };
    });
    const store = createPostgresBudgetStore(pool);

    const items = await store.listBudgets('h1');

    expect(calls).toHaveLength(2);
    const agg = calls[1]!;
    expect(agg.text).toContain('GROUP BY');
    expect(agg.text).toContain('household_id');
    // Boundaries inclusivas preservadas: date >= start AND date <= end.
    expect(agg.text).toContain('>=');
    expect(agg.text).toContain('<=');
    // Workspace como primeiro parâmetro do escopo.
    expect(agg.values[0]).toBe('h1');
    // Budgets com períodos distintos caem na mesma agregação (CASE por período).
    expect(agg.text).toContain('monthly');
    expect(agg.text).toContain('quarterly');

    const byId = new Map(items.map((b) => [b.id, b]));
    expect(byId.get('b1')).toMatchObject({ spentCents: 60000, remainingCents: 40000, percentUsed: 60 });
    expect(byId.get('b2')).toMatchObject({ spentCents: 0, remainingCents: 200_000, percentUsed: 0 });
    // Sem linha agregada => gasto 0 (LEFT JOIN), não NaN/undefined.
    expect(byId.get('b3')).toMatchObject({ spentCents: 0, remainingCents: 300_000, percentUsed: 0 });
    // Ordenação por percentUsed desc preservada.
    expect(items[0]!.id).toBe('b1');
  });
});

describe('postgres getBudgetTrends aggregation (API-06)', () => {
  it('issues a single aggregation query for N months scoped to workspace/categoria', async () => {
    const { pool, calls } = makePool((text, values) => {
      if (text.includes('GROUP BY')) {
        // Ecoa os meses pedidos com gasto fixo para validar o mapeamento.
        const months = [values[2], values[5], values[8]];
        return { rows: months.map((ym, i) => ({ ym, spent: String((i + 1) * 1000) })) };
      }
      return { rows: [budgetRow({ id: 'b1', amount_cents: 100_000 })] };
    });
    const store = createPostgresBudgetStore(pool);

    const trends = await store.getBudgetTrends('h1', 'b1', 3);

    expect(calls).toHaveLength(2);
    const agg = calls[1]!;
    expect(agg.text).toContain('GROUP BY');
    expect(agg.text).toContain('household_id');
    expect(agg.values[0]).toBe('h1');
    expect(agg.values[1]).toBe('c1');
    // Uma única query cobre os 3 meses (sem laço por mês).
    expect(agg.text.match(/::date/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(trends).toHaveLength(3);
    expect(trends[0]!.budgetCents).toBe(100_000);
    expect(trends.map((t) => t.yearMonth)).toEqual([...trends.map((t) => t.yearMonth)].sort());
    for (const t of trends) {
      expect(typeof t.spentCents).toBe('number');
      expect(Number.isInteger(t.spentCents)).toBe(true);
    }
  });

  it('regression T12d: monthsBack=3 anchored on 2026-03-31 yields 3 distinct months (no doubled March)', async () => {
    // Ancora no dia 31: `setUTCMonth` sobre Mar-31 transborda Fev (31/Fev ->
    // 3-Mar), repetindo "2026-03" no VALUES; o `GROUP BY m.ym` do Postgres
    // somaria AMBAS as entradas (despesa 1000 em março => 2000). O mock
    // abaixo modela esse GROUP BY: spent = ocorrências do ym × 1000.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
      const { pool, calls } = makePool((text, values) => {
        if (text.includes('GROUP BY')) {
          const requested = [values[2], values[5], values[8]];
          const counts = new Map<unknown, number>();
          for (const ym of requested) counts.set(ym, (counts.get(ym) ?? 0) + 1);
          return { rows: [...counts].map(([ym, n]) => ({ ym, spent: String(n * 1000) })) };
        }
        return { rows: [budgetRow({ id: 'b1', amount_cents: 100_000 })] };
      });
      const store = createPostgresBudgetStore(pool);

      const trends = await store.getBudgetTrends('h1', 'b1', 3);

      // Probe de contagem preservado: budget + 1 agregação.
      expect(calls).toHaveLength(2);
      const agg = calls[1]!;
      const ymParams = [agg.values[2], agg.values[5], agg.values[8]];
      expect(ymParams).toEqual(['2026-01', '2026-02', '2026-03']);
      expect(new Set(ymParams).size).toBe(3);
      // Bounds derivam dos ym normalizados: mês corrente cobre Mar inteiro.
      expect(agg.values).toContain('2026-01-01');
      expect(agg.values).toContain('2026-01-31');
      expect(agg.values).toContain('2026-02-01');
      expect(agg.values).toContain('2026-02-28');
      expect(agg.values).toContain('2026-03-01');
      expect(agg.values).toContain('2026-03-31');
      // Lista exata em ordem ascendente (mesma ordenação do SQL atual).
      expect(trends.map((t) => t.yearMonth)).toEqual(['2026-01', '2026-02', '2026-03']);
      // Despesa de 1000 centavos em março aparece UMA vez, não dobrada.
      expect(trends[2]).toMatchObject({ yearMonth: '2026-03', spentCents: 1000 });
    } finally {
      vi.useRealTimers();
    }
  });
});
