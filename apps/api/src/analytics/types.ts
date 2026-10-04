/**
 * Analytics foundation (item 14, etapa A): KPI/series DTOs and query shapes.
 *
 * Period presets mirror the PWA filter drawer: last30days | lastMonth |
 * thisYear | custom (from/to required). accountId optionally scopes every
 * computation to a single account.
 */

import { z } from 'zod';
import { isoDateSchema as isoDate } from '../shared/iso-date.js';

export const analyticsPeriodSchema = z.enum(['last30days', 'lastMonth', 'thisYear', 'custom']);

/**
 * G-A (SPEC adendo 11.1.1): base do agregado de DESPESA, opt-in.
 *
 * - `liquidez` (DEFAULT, omissao): comportamento atual byte a byte. A compra no
 *   cartao e o pagamento da MESMA fatura contam como duas despesas.
 * - `competencia`: linhas com `statement_payment_id` (pagamento de fatura,
 *   V056) saem do agregado de despesa; a compra permanece na data da compra.
 *
 * O parametro so existe nas agregacoes de despesa (`kpis`, `cashflow-series`,
 * `category-breakdown`, `daily-heatmap`) e nunca e aplicado a receita.
 */
export const analyticsBasisSchema = z.enum(['liquidez', 'competencia']);

export type AnalyticsBasis = z.infer<typeof analyticsBasisSchema>;

export const DEFAULT_ANALYTICS_BASIS: AnalyticsBasis = 'liquidez';

/**
 * G-C (SPEC adendo 11.1.3): envelope de prova, aditivo em TODAS as 6 rotas.
 *
 * `semanticsVersion` sobe quando o SIGNIFICADO de um campo muda (nao quando um
 * campo novo aparece - campos novos sao aditivos e versionados por presenca).
 * `emptyReason` e conclusivo: `null` quando ha evidencia no payload; um motivo
 * fechado quando nao ha. Timeout e 403 nunca entram aqui - eles continuam
 * erro, nunca "zero" (R04/R09).
 */
export const ANALYTICS_SEMANTICS_VERSION = '1' as const;

export const ANALYTICS_EMPTY_REASONS = [
  'no_transactions_in_period',
  'no_categorised_transactions_in_period',
  'no_budgets',
] as const;

export type AnalyticsEmptyReason = (typeof ANALYTICS_EMPTY_REASONS)[number];

/**
 * Filtros REALMENTE aplicados. `null` significa "nao aplicado" - e o que
 * torna a rota honesta: `daily-heatmap` ignora `period`/`from` e
 * `budget-consumption` nao filtra por periodo, entao declaram `null` em vez de
 * repassar a janela pedida.
 */
export type AnalyticsEffectiveFilter = {
  period: string | null;
  from: string | null;
  to: string | null;
  accountId: string | null;
  kind?: 'expense' | 'income';
};

export type AnalyticsProofEnvelope = {
  transactionCount: number;
  asOf: string;
  basis: AnalyticsBasis;
  semanticsVersion: typeof ANALYTICS_SEMANTICS_VERSION;
  effectiveFilter: AnalyticsEffectiveFilter;
  emptyReason: AnalyticsEmptyReason | null;
};

export const analyticsBaseSchema = z.object({
  period: analyticsPeriodSchema.optional(),
  from: isoDate
    .optional(),
  to: isoDate
    .optional(),
  accountId: z.string().uuid().optional(),
  basis: analyticsBasisSchema.optional(),
});

export const analyticsQuerySchema = analyticsBaseSchema.superRefine((value, ctx) => {
  if (value.period === 'custom' && (!value.from || !value.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'custom period requires from and to' });
  }
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from must not be after to' });
  }
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export type AnalyticsRange = { from: string; to: string };

export type CategoryBreakdownQuery = AnalyticsQuery & { kind?: 'expense' | 'income' };

export const categoryBreakdownQuerySchema = analyticsBaseSchema
  .extend({
    kind: z.enum(['expense', 'income']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.period === 'custom' && (!value.from || !value.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'custom period requires from and to' });
    }
    if (value.from && value.to && value.from > value.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from must not be after to' });
    }
  });

export type MoneyPoint = { date: string; valueCents: number };

export type KpiDelta = { valueCents: number | null; pct: number | null };

export type AnalyticsKpis = {
  period: AnalyticsRange;
  previousPeriod: AnalyticsRange;
  netLiquidBalanceCents: number;
  accountsTotalCents: number;
  dueSoonCents: number;
  openInvoices: { committedCents: number; limitCents: number; utilizationPct: number | null };
  savingsRatePct: number | null;
  savingsRateTargetPct: number;
  previousSavingsRatePct: number | null;
  fixedVsDiscretionary: FixedVsDiscretionary;
  incomeCents: number;
  expenseCents: number;
  previousIncomeCents: number;
  previousExpenseCents: number;
  netWorthCents: number;
} & ExactCentsCompanions<['incomeCents', 'expenseCents', 'previousIncomeCents', 'previousExpenseCents']>;

/**
 * G-B: `<campo>Exact` + `approximate: true` aparecem **apenas** no agregado que
 * passou de 2^53. Dentro do safe integer o payload é byte-idêntico ao anterior.
 * `approximate: true` marca o OBJETO que contém pelo menos um agregado não-exato
 * (percentuais derivados dele também são aproximados); o decimal exato de cada
 * campo vem no seu próprio `<campo>Exact`.
 */
export type ExactCentsCompanions<Fields extends readonly string[]> = {
  approximate?: true;
} & { [K in Fields[number] as `${K}Exact`]?: string };

/**
 * H-10: fixed-vs-discretionary always declares its universe. `scope`
 * tells whether `fixedCents` covers the household or one account;
 * `subscriptionsCents` is the household-wide subscriptions component —
 * included in `fixedCents` only when scope is 'household'.
 */
export type FixedVsDiscretionary = {
  scope: 'household' | 'account';
  fixedCents: number;
  discretionaryCents: number;
  fixedPctOfIncome: number | null;
  subscriptionsCents: number;
};

export type CashflowSeries = {
  period: AnalyticsRange;
  current: MoneyPoint[];
  previous: MoneyPoint[];
};

export type CategorySlice = {
  categoryId: string;
  name: string;
  totalCents: number;
  pct: number;
  color: string | null;
} & ExactCentsCompanions<['totalCents']>;

export type CategoryBreakdown = {
  period: AnalyticsRange;
  kind: 'expense' | 'income';
  totalCents: number;
  slices: CategorySlice[];
} & ExactCentsCompanions<['totalCents']>;

export type BudgetConsumptionItem = {
  budgetId: string;
  name: string;
  categoryId: string;
  spentCents: number;
  amountCents: number;
  pctUsed: number;
  overBudget: boolean;
  thresholdBreached: boolean;
};

export type HeatmapDay = { date: string; totalCents: number; level: 0 | 1 | 2 | 3 | 4 };
export type HeatmapWeek = { weekStart: string; days: HeatmapDay[] };

export type DailyHeatmap = {
  endDate: string;
  weeks: HeatmapWeek[];
};

export type NetWorthPoint = { month: string; netWorthCents: number };

/**
 * G-C wire shapes: the pure payload plus the proof envelope. Split from the
 * payload types on purpose - `compute.ts` builds the payload from aggregates
 * alone and has no clock, no query and no basis, so the envelope is attached by
 * the route, which is the only layer that knows all three.
 */
export type AnalyticsKpisResponse = AnalyticsKpis & AnalyticsProofEnvelope;
export type CashflowSeriesResponse = CashflowSeries & AnalyticsProofEnvelope;
export type CategoryBreakdownResponse = CategoryBreakdown & AnalyticsProofEnvelope;
export type DailyHeatmapResponse = DailyHeatmap & AnalyticsProofEnvelope;
export type NetWorthHistoryResponse = { months: NetWorthPoint[] } & AnalyticsProofEnvelope;

/**
 * G-C: `budget-consumption` does not read `transactions` (spentCents comes from
 * the budget store), so `transactionCount` is always 0 and the empty reason
 * names budgets, never "no transactions".
 */
export type BudgetConsumptionResponse = {
  items: BudgetConsumptionItem[];
  total: number;
  scope: 'household';
} & AnalyticsProofEnvelope;
