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
 * 2. **`daily-heatmap` ignora `period` e `from`** (a grade é fixa: 4 semanas
 *    de segunda, terminando em `to`, em `routes/analytics.ts`). Pedir um mês
 *    para essa rota e receber a grade é uma janela errada sem aviso; aqui a
 *    normalização RECUSA o caminho custom em vez de declarar como efetiva uma
 *    janela que a rota não usou. A API agora declara a janela REAL da grade em
 *    `effectiveFilter.from`/`to` (G03), então ninguém precisa adivinhar.
 *
 * O envelope é ADITIVO e declarativo: ele não muda a semântica de `from`/`to`
 * (inclusiva na API, `date >= from AND date <= to`) e apenas torna explícito o
 * intervalo que o consumers já usava - `toExclusive` é o MESMO instante do fim
 * inclusivo (o dia seguinte), sem incluir o primeiro dia do mês seguinte.
 *
 * **G03 (2026-10-04, SPEC adendo 11.1) fechou G-A/G-B/G-C na API.** O que muda
 * aqui é a AUTORIDADE, não a forma:
 *
 * - `basis` passou a ser parâmetro (`liquidez` | `competencia`, omissão =
 *   `liquidez`) e a resposta declara a base EFETIVA que ela aplicou. O agente
 *   propaga esse valor verbatim; quando a API não declara nenhum, o agente NÃO
 *   afirma uma base que a leitura não provou - publica o que ELE pediu, em
 *   `agentRequestedBasis`. Um envelope que afirma mais do que a fonte
 *   documentou é pior do que um envelope ausente.
 * - O inteiro exato agora vem da API (`totalCentsExact` + `approximate`, G-B).
 *   O anotador local só age quando a API NÃO traz o decimal - e nunca
 *   sobrescreve o valor dela pelo double local, que já perdeu centavos.
 * - A API ainda não declara `effectivePeriod`; quando passar a declarar, a do
 *   agente vai para `agentEffectivePeriod` em vez de sobrescrever a da API.
 */

import { truncateSafely } from '../dlp/redaction.js';

export const ANALYTICS_BOUNDARY = 'inclusive' as const;

/** G-A na vocabulary da API (o wire fala `liquidez`/`competencia`). */
export const ANALYTICS_BASES = ['liquidez', 'competencia'] as const;
export type AnalyticsBasis = (typeof ANALYTICS_BASES)[number];

/**
 * Omissão = `liquidez`, que é o comportamento histórico da API. O default é
 * declarado aqui para que um chamador que pense em `competencia` saiba que
 * precisa pedi-lo explicitamente.
 */
export const DEFAULT_ANALYTICS_BASIS: AnalyticsBasis = 'liquidez';

const isAnalyticsBasis = (value: unknown): value is AnalyticsBasis =>
  typeof value === 'string' && (ANALYTICS_BASES as readonly string[]).includes(value);

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
  'invalid_basis',
] as const;
export type AnalyticsQueryRejection = (typeof ANALYTICS_QUERY_REJECTIONS)[number];

export type AnalyticsQueryInput = Readonly<{
  /** Tool que vai consumir a query (opcional; sem ela a checagem é pulada). */
  tool?: string;
  yearMonth?: string;
  from?: string;
  to?: string;
  /**
   * G-A: base do agregado de despesa. Ausente = `liquidez` (default da API) e
   * NADA é enviado — pedir `competencia` é uma decisão, não um detalhe.
   */
  basis?: AnalyticsBasis;
}>;

/**
 * `period` é `'custom'` por construção: o tipo impede `from`/`to` sem preset,
 * que é exatamente a armadilha que o spike encontrou. `basis` só aparece quando
 * foi pedido explicitamente.
 */
export type NormalizedAnalyticsQuery = Readonly<{
  period: 'custom';
  from: string;
  to: string;
  basis?: AnalyticsBasis;
}>;

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
      'analytics_daily_heatmap ignora period e from (a grade é fixa: 4 semanas terminando em to): não posso declarar um período custom para ela.',
    );
  }

  // Uma base fora do contrato é recusada, nunca descartada em silêncio: cair
  // para `liquidez` responderia uma janela certa com a SEMÂNTICA errada.
  if (input.basis !== undefined && !isAnalyticsBasis(input.basis)) {
    return reject(
      'invalid_basis',
      `basis inválido: ${String(input.basis)} (esperado ${ANALYTICS_BASES.join(' | ')}).`,
    );
  }
  const basis = input.basis === undefined ? {} : { basis: input.basis };

  if (input.yearMonth !== undefined) {
    const yearMonth = input.yearMonth;
    if (!YEAR_MONTH_RE.test(yearMonth)) {
      return reject('invalid_year_month', `yearMonth inválido: ${yearMonth} (esperado YYYY-MM).`);
    }
    const month = Number(yearMonth.slice(5, 7));
    if (month < 1 || month > 12) {
      return reject('invalid_year_month', `yearMonth inválido: ${yearMonth} (mês fora de 01..12).`);
    }
    return { ok: true, query: { period: 'custom', from: `${yearMonth}-01`, to: lastDayOfMonth(yearMonth), ...basis } };
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
  return { ok: true, query: { period: 'custom', from: input.from, to: input.to, ...basis } };
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
 * o `Number()` da API já perdeu centavos (G-B), e o wire carrega o decimal
 * exato em `totalCentsExact`. A flag `approximate` é o que mantém a afirmação
 * honesta.
 */
const exactDecimalOf = (value: number): string => (Number.isInteger(value) ? value.toFixed(0) : String(value));

/**
 * G-B: marca todo `totalCents` fora do safe integer com `approximate: true`
 * (recursivamente, top-level e `slices[]`) e, **só quando a API não trouxe o
 * decimal**, com a forma decimal local.
 *
 * O decimal da API é a autoridade e nunca é sobrescrito pelo double local: ele
 * já perdeu centavos, e trocar a prova autoritativa por uma aproximação seria
 * pior do que não ter prova. Um total seguro não é tocado — a flag é por campo.
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
    if (output['totalCentsExact'] === undefined) output['totalCentsExact'] = exactDecimalOf(total);
    output['approximate'] = true;
  }
  return output;
};

export type DeclareAnalyticsEnvelopeOptions = Readonly<{
  /**
   * Base que o agente pediu. Só é publicado em `agentRequestedBasis`, e apenas
   * quando a API NÃO declarou `basis` — ver `declareAnalyticsEnvelope`.
   */
  requestedBasis?: AnalyticsBasis;
}>;

/**
 * Anexa ao payload o período efetivo e a fronteira, sem reescrever nenhum
 * campo da resposta. Sem `period` utilizável, NÃO há envelope: declarar uma
 * janela que a rota não usou seria inventar prova (mesma disciplina de R04 —
 * uma falha de leitura nunca vira "não há dados").
 *
 * **Colisões com o envelope da API (G03).** A API agora declara `basis`
 * (efetiva), `transactionCount`, `asOf`, `semanticsVersion`, `effectiveFilter`
 * e o inteiro exato. A política aqui é "a fonte ganha":
 *
 * - `basis`: o valor da API é propagado verbatim. Sem ele, o agente NÃO afirma
 *   base nenhuma (afirmar `competencia` sobre uma leitura feita em `liquidez`
 *   seria inventar prova) e publica `agentRequestedBasis`.
 * - `effectivePeriod`: a API ainda não o declara; se vier, a versão do agente
 *   passa para `agentEffectivePeriod` e a da API é preservada.
 * - `totalCentsExact`/`approximate`: preservados; o anotador local só completa
 *   o que falta.
 */
/**
 * A04/A09 pós-G03 — bloco de PROVA para o caminho de evidência.
 *
 * O envelope aditivo vive dentro do payload, mas o modelo precisa de uma linha
 * curta que declare, ao lado de cada afirmação, QUE janela e QUE base a produziram.
 * O bloco é derivado do MESMO envelope (nada é re-declarado aqui), então ele não
 * pode afirmar mais do que a leitura provou:
 *
 * - base: a EFETIVA da API quando declarada; senão apenas o que o agente pediu
 *   (`agentRequestedBasis`), com a ausência nomeada — nunca `competencia` sobre
 *   uma leitura feita em `liquidez`;
 * - totais: o decimal exato quando o `totalCents` saiu do safe integer (G-B),
 *   marcado como double aproximado;
 * - envelope ausente: uma linha de INDISPONIBILIDADE e nenhum número, porque
 *   "não sei de qual janela veio" não pode virar um total assertado.
 */
export const ANALYTICS_EVIDENCE_CHARS = 600;
export const ANALYTICS_EVIDENCE_UNAVAILABLE_PREFIX = 'PROVA ANALYTICS — indisponível:';
export const ANALYTICS_EVIDENCE_PREFIX = 'PROVA ANALYTICS';

export type RenderAnalyticsEvidenceOptions = Readonly<{
  /** Tool que produziu a leitura (`analytics_kpis` / `analytics_category_breakdown`). */
  tool?: string;
  charBudget?: number;
}>;

const capWithMarker = (value: string, max: number): string => {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  const head = truncateSafely(value, max - 1);
  return head === '' ? '…' : `${head}…`;
};

const readPeriod = (value: unknown): { from: string; to: string; toExclusive?: string } | null => {
  const range = asRecord(value);
  if (!range) return null;
  const { from, to } = range;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  return {
    from,
    to,
    ...(typeof range['toExclusive'] === 'string' ? { toExclusive: range['toExclusive'] } : {}),
  };
};

/** pt-BR label of the declared boundary; the raw wire value stays on the payload. */
const BOUNDARY_LABEL: Record<string, string> = { inclusive: 'inclusiva' };
const boundaryLabel = (value: unknown): string =>
  BOUNDARY_LABEL[String(value ?? ANALYTICS_BOUNDARY)] ?? String(value ?? ANALYTICS_BOUNDARY);

const readNumber = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : null;

/**
 * Renders the proof line from an ALREADY declared envelope. Taking the
 * declaration (instead of the raw payload) is what makes duplication
 * impossible: there is exactly one place where the window/base is declared.
 */
export const renderAnalyticsEvidence = (
  declared: AnalyticsEnvelopeResult,
  options: RenderAnalyticsEvidenceOptions = {},
): string => {
  const budget = Number.isFinite(options.charBudget) ? Math.floor(options.charBudget as number) : ANALYTICS_EVIDENCE_CHARS;
  if (!declared.ok) {
    return capWithMarker(
      `${ANALYTICS_EVIDENCE_UNAVAILABLE_PREFIX} ${declared.message} Nenhum número desta leitura pode ser afirmado.`,
      budget,
    );
  }
  const response = declared.response;
  const period = readPeriod(response['effectivePeriod']);
  // Um envelope `ok` sempre tem período; a checagem é a rede de segurança para
  // um chamador que construiu o objeto à mão.
  if (!period) {
    return capWithMarker(
      `${ANALYTICS_EVIDENCE_UNAVAILABLE_PREFIX} a resposta não traz a janela efetiva; nenhum envelope é declarado. Nenhum número desta leitura pode ser afirmado.`,
      budget,
    );
  }
  const declaredBasis = isAnalyticsBasis(response['basis']) ? response['basis'] : null;
  const requestedBasis = isAnalyticsBasis(response['agentRequestedBasis']) ? response['agentRequestedBasis'] : null;
  const exactTotal = typeof response['totalCentsExact'] === 'string' ? response['totalCentsExact'] : null;
  const approximate = response['approximate'] === true;
  const emptyReason = typeof response['emptyReason'] === 'string' && response['emptyReason'] !== ''
    ? response['emptyReason']
    : null;
  const parts = [
    options.tool ? `tool: ${options.tool}` : null,
    `janela: ${period.from} a ${period.to}${period.toExclusive ? ` (limite exclusivo ${period.toExclusive}` : ''}, fronteira ${boundaryLabel(response['boundary'])}${period.toExclusive ? ')' : ''}`,
    declaredBasis
      ? `base efetiva: ${declaredBasis}`
      : `base pedida: ${requestedBasis ?? DEFAULT_ANALYTICS_BASIS} (a leitura não declarou base efetiva)`,
    readNumber(response['transactionCount']) === null ? null : `lançamentos: ${String(response['transactionCount'])}`,
    typeof response['asOf'] === 'string' ? `apurado em: ${response['asOf']}` : null,
    typeof response['semanticsVersion'] === 'string' ? `semântica: ${response['semanticsVersion']}` : null,
    exactTotal === null ? null : `total exato: ${exactTotal}${approximate ? ' (double aproximado — o decimal é a prova)' : ''}`,
    emptyReason === null ? null : `sem lançamentos: ${emptyReason}`,
  ].filter((part): part is string => part !== null && part !== '');
  return capWithMarker([`${ANALYTICS_EVIDENCE_PREFIX} —`, ...parts].join(' '), budget);
};

export const declareAnalyticsEnvelope = (
  response: unknown,
  options: DeclareAnalyticsEnvelopeOptions = {},
): AnalyticsEnvelopeResult => {
  const record = asRecord(response);
  const effectivePeriod = readRange(record?.['period']);
  if (!record || !effectivePeriod) {
    return {
      ok: false,
      reason: 'missing_effective_period',
      message: 'A resposta de analytics não traz um período utilizável; nenhum envelope é declarado.',
    };
  }
  const declaredPeriod = readRange(record['effectivePeriod']);
  const declaredBasis = isAnalyticsBasis(record['basis']) ? record['basis'] : undefined;
  return {
    ok: true,
    response: Object.freeze({
      ...(annotateUnsafeTotals(record) as Record<string, unknown>),
      ...(declaredPeriod ? { effectivePeriod: declaredPeriod, agentEffectivePeriod: effectivePeriod } : { effectivePeriod }),
      boundary: ANALYTICS_BOUNDARY,
      ...(declaredBasis
        ? { basis: declaredBasis }
        : { agentRequestedBasis: options.requestedBasis ?? DEFAULT_ANALYTICS_BASIS }),
    }),
  };
};