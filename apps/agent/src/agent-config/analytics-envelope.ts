/**
 * A09 / SPEC R09 — normalização da janela e envelope das leituras de analytics.
 *
 * O spike (`docs/reports/2026-10-04-ted-inteligente-v1-a09-spike.md`) provou que
 * o caminho de REUSO (`period=custom`) responde 5 das 7 perguntas-alvo sem API
 * nova, e nomeou duas armadilhas de contrato que este módulo fecha:
 *
 * 1. **`from`/`to` são silenciosamente ignorados sem `period`.** `resolveRange`
 *    (`apps/api/src/analytics/compute.ts`) cai em `last30days` e descarta a
 *    janela pedida SEM erro. Por isso `normalizeAnalyticsQuery` só produz
 *    `{period:'custom', from, to}` — o tipo torna impossível emitir `from`/`to`
 *    sem o preset, e a mesma exigência está na entrada `x-pi-tool` das tools.
 * 2. **`daily-heatmap` ignora `period` e `from`** (janela fixa de 35 dias,
 *    `routes/analytics.ts:210-212`). Pedir um mês para essa rota e receber 35
 *    dias é uma janela errada sem aviso; aqui a normalização RECUSA o caminho
 *    custom em vez de declarar como efetiva uma janela que a rota não usou.
 *
 * O envelope é ADITIVO e declarativo: ele não muda a semântica de `from`/`to`
 * (inclusiva na API, `date >= from AND date <= to`) e apenas torna explícito o
 * intervalo que o consumers já usava — `toExclusive` é o MESMO instante do fim
 * inclusivo (o dia seguinte), sem incluir o primeiro dia do mês seguinte.
 *
 * Limites declarados aqui, deliberadamente NÃO resolvidos (G03 decide):
 * - **G-A** (competência x liquidação de fatura): compra e pagamento da mesma
 *   fatura são ambos `kind='expense'`; nenhuma camada de leitura separa os dois.
 * - **G-B** (integridade de `totalCents`): `SUM(...)::text` seguido de `Number()`
 *   perde centavos acima de 2^53. O envelope NÃO recupera o inteiro exato — a
 *   API não o transporta — apenas se recusa a apresentar um double fora do
 *   safe integer como total exato: publica a forma decimal do valor recebido e
 *   marca `approximate: true` para o consumidor decidir.
 * - **G-C** (envelope de prova): `transactionCount`, `asOf`, `semanticsVersion`
 *   e `effectiveFilter` não existem na API. `basis` e `boundary` são declarados
 *   aqui; o resto continua ausente, e o aviso das lacunas vive no relatório da
 *   fatia, não no payload entregue ao modelo.
 */

export const ANALYTICS_BASIS = 'competencia_transactions_date' as const;
export const ANALYTICS_BOUNDARY = 'inclusive' as const;

/** `Number.MAX_SAFE_INTEGER` nomeado: o limite de cents que ainda é exato. */
export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

/**
 * Rotas cujo período NÃO é o da query (spike §3.1, armadilha 2). O caminho
 * custom é recusado para elas — `daily-heatmap` não é tool do agente, e o
 * registro existe para que a ferramenta permaneça honesta se vier a ser exposta.
 */
export const PERIOD_IGNORING_TOOLS = ['analytics_daily_heatmap'] as const;
export type PeriodIgnoringTool = (typeof PERIOD_IGNORING_TOOLS)[number];

export const ANALYTICS_QUERY_REJECTIONS = [
  'daily_heatmap_ignores_period',
  'missing_range',
  'invalid_range',
  'invalid_year_month',
] as const;
export type AnalyticsQueryRejection = (typeof ANALYTICS_QUERY_REJECTIONS)[number];

export type AnalyticsQueryInput = Readonly<{
  /** Tool que vai consumir a query (opcional; sem ela a checagem é pulada). */
  tool?: string;
  yearMonth?: string;
  from?: string;
  to?: string;
}>;

/**
 * `period` é `'custom'` por construção: o tipo impede `from`/`to` sem preset,
 * que é exatamente a armadilha que o spike encontrou.
 */
export type NormalizedAnalyticsQuery = Readonly<{ period: 'custom'; from: string; to: string }>;

export type NormalizeAnalyticsQueryResult =
  | Readonly<{ ok: true; query: NormalizedAnalyticsQuery }>
  | Readonly<{ ok: false; reason: AnalyticsQueryRejection; message: string }>;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

/** Calendário real (o mesmo critério de `shared/iso-date.ts`): `2026-02-31` falha. */
const isCalendarDate = (value: string): boolean => {
  if (!ISO_DATE_RE.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** Último dia real do mês (2024-02 → 29), calculado em UTC sem `new Date(string)`. */
const lastDayOfMonth = (yearMonth: string): string => {
  const [yearText, monthText] = yearMonth.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
};

/** Next day in UTC — the same instant as the inclusive end, with no date drift. */
const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const reject = (reason: AnalyticsQueryRejection, message: string): NormalizeAnalyticsQueryResult => ({
  ok: false,
  reason,
  message,
});

/**
 * Converte a intenção de período em uma query `period=custom` segura, ou recusa
 * com um motivo tipado. Nunca devolve um período ausente e nunca "corrige" uma
 * janela inválida num preset — um período errado silencioso é pior que uma
 * recusa (spike §3.1).
 */
export const normalizeAnalyticsQuery = (input: AnalyticsQueryInput): NormalizeAnalyticsQueryResult => {
  if (input.tool && (PERIOD_IGNORING_TOOLS as readonly string[]).includes(input.tool)) {
    return reject(
      'daily_heatmap_ignores_period',
      'analytics_daily_heatmap ignora period e from (janela fixa de 35 dias): não posso declarar um período custom para ela.',
    );
  }

  if (input.yearMonth !== undefined) {
    const yearMonth = input.yearMonth;
    if (!YEAR_MONTH_RE.test(yearMonth)) {
      return reject('invalid_year_month', `yearMonth inválido: ${yearMonth} (esperado YYYY-MM).`);
    }
    const month = Number(yearMonth.slice(5, 7));
    if (month < 1 || month > 12) {
      return reject('invalid_year_month', `yearMonth inválido: ${yearMonth} (mês fora de 01..12).`);
    }
    return { ok: true, query: { period: 'custom', from: `${yearMonth}-01`, to: lastDayOfMonth(yearMonth) } };
  }

  if (input.from === undefined && input.to === undefined) {
    return reject('missing_range', 'Informe yearMonth ou from+to: sem isso a API cairia em last30days.');
  }
  if (input.from === undefined || input.to === undefined) {
    return reject('invalid_range', 'period=custom exige from E to (a API rejeita período incompleto).');
  }
  if (!isCalendarDate(input.from) || !isCalendarDate(input.to)) {
    return reject('invalid_range', `Intervalo inválido: ${input.from}..${input.to} (use YYYY-MM-DD do calendário real).`);
  }
  if (input.from > input.to) {
    return reject('invalid_range', `Intervalo invertido: from (${input.from}) é depois de to (${input.to}).`);
  }
  return { ok: true, query: { period: 'custom', from: input.from, to: input.to } };
};

export type AnalyticsEffectivePeriod = Readonly<{ from: string; to: string; toExclusive: string }>;

export type AnalyticsEnvelopeResult =
  | Readonly<{ ok: true; response: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; reason: 'missing_effective_period'; message: string }>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readRange = (value: unknown): AnalyticsEffectivePeriod | null => {
  const range = asRecord(value);
  if (!range) return null;
  const { from, to } = range;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (!isCalendarDate(from) || !isCalendarDate(to)) return null;
  return { from, to, toExclusive: addDays(to, 1) };
};

/**
 * Forma decimal do valor recebido. NÃO é o inteiro autoritativo: acima de 2^53
 * o `Number()` da API já perdeu centavos (G-B), e o wire não carrega o texto
 * exato. A flag `approximate` é o que mantém a afirmação honesta.
 */
const exactDecimalOf = (value: number): string => (Number.isInteger(value) ? value.toFixed(0) : String(value));

/**
 * Marca todo `totalCents` fora do safe integer com a forma decimal recebida +
 * `approximate: true`, recursivamente (top-level e `slices[]`). Um total seguro
 * não é tocado: a flag é por campo, não por resposta.
 */
const annotateUnsafeTotals = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => annotateUnsafeTotals(item));
  const record = asRecord(value);
  if (!record) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    output[key] = annotateUnsafeTotals(child);
  }
  const total = output['totalCents'];
  if (typeof total === 'number' && Math.abs(total) > MAX_SAFE_CENTS) {
    output['totalCentsExact'] = exactDecimalOf(total);
    output['approximate'] = true;
  }
  return output;
};

/**
 * Anexa ao payload o período efetivo, a fronteira e a base, sem reescrever
 * nenhum campo da resposta. Sem `period` utilizável, NÃO há envelope: declarar
 * uma janela que a rota não usou seria inventar prova (mesma disciplina de R04
 * — uma falha de leitura nunca vira "não há dados").
 */
export const declareAnalyticsEnvelope = (response: unknown): AnalyticsEnvelopeResult => {
  const record = asRecord(response);
  const effectivePeriod = readRange(record?.['period']);
  if (!record || !effectivePeriod) {
    return {
      ok: false,
      reason: 'missing_effective_period',
      message: 'A resposta de analytics não traz um período utilizável; nenhum envelope é declarado.',
    };
  }
  return {
    ok: true,
    response: Object.freeze({
      ...(annotateUnsafeTotals(record) as Record<string, unknown>),
      effectivePeriod,
      boundary: ANALYTICS_BOUNDARY,
      basis: ANALYTICS_BASIS,
    }),
  };
};