import { describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_BASES,
  ANALYTICS_BOUNDARY,
  DEFAULT_ANALYTICS_BASIS,
  MAX_SAFE_CENTS,
  declareAnalyticsEnvelope,
  normalizeAnalyticsQuery,
} from '../src/agent-config/analytics-envelope.js';
import {
  CORE_READ_TOOLS,
  MAX_EXPOSED_TOOLS,
  buildExposedTools,
  selectToolsFor,
  toolSkillLines,
  toolSkillMap,
} from '../src/agent-config/tools.js';
import * as apiClient from '../src/tools/api-client.js';
import { generatedHttpTools } from '../src/generated/http-tools.js';

const ANALYTICS_TOOLS = ['analytics_kpis', 'analytics_category_breakdown'] as const;

/**
 * kpis payload shape as really sent by `GET /analytics/kpis` (routes/analytics.ts),
 * INCLUDING the G03 proof envelope: `basis` is the EFFECTIVE basis the API
 * applied, and it is the agent's job to propagate it, not to replace it.
 */
const kpisResponse = (from: string, to: string, basis: 'liquidez' | 'competencia' = 'liquidez') => ({
  period: { from, to },
  previousPeriod: { from: '2025-12-01', to: '2025-12-31' },
  netLiquidBalanceCents: 120000,
  accountsTotalCents: 150000,
  dueSoonCents: 30000,
  openInvoices: { committedCents: 45000, limitCents: 100000, utilizationPct: 45 },
  savingsRatePct: 12.5,
  savingsRateTargetPct: 20,
  previousSavingsRatePct: 8,
  fixedVsDiscretionary: {
    scope: 'household',
    fixedCents: 40000,
    discretionaryCents: 20000,
    fixedPctOfIncome: 25,
    subscriptionsCents: 10000,
  },
  incomeCents: 240000,
  expenseCents: 210000,
  previousIncomeCents: 200000,
  previousExpenseCents: 192000,
  netWorthCents: 105000,
  transactionCount: 18,
  asOf: '2026-02-01T12:00:00.000Z',
  basis,
  semanticsVersion: '1',
  effectiveFilter: { period: 'custom', from, to, accountId: null },
  emptyReason: null,
});

describe('normalizeAnalyticsQuery (A09/R09 — spike §3.1 armadilha 1)', () => {
  it('expande yearMonth em período custom inclusivo do mês inteiro', () => {
    expect(normalizeAnalyticsQuery({ yearMonth: '2026-01' })).toEqual({
      ok: true,
      query: { period: 'custom', from: '2026-01-01', to: '2026-01-31' },
    });
    // Fevereiro bissexto e mês de 30 dias: o limite é sempre o último dia real.
    expect(normalizeAnalyticsQuery({ yearMonth: '2024-02' })).toEqual({
      ok: true,
      query: { period: 'custom', from: '2024-02-01', to: '2024-02-29' },
    });
    expect(normalizeAnalyticsQuery({ yearMonth: '2026-04' })).toEqual({
      ok: true,
      query: { period: 'custom', from: '2026-04-01', to: '2026-04-30' },
    });
  });

  it('NUNCA emite from/to sem period (impossível por construção)', () => {
    const normalized = normalizeAnalyticsQuery({ from: '2026-03-01', to: '2026-03-31' });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    // O tipo declara `period: 'custom'` como obrigatório; a asserção runtime
    // fecha o contrato para quem chama por JS/dado não tipado.
    expect(normalized.query).toEqual({ period: 'custom', from: '2026-03-01', to: '2026-03-31' });
    expect(Object.keys(normalized.query)).toContain('period');
  });

  it('rejeita período incompleto, invertido ou inválido em vez de cair no preset', () => {
    expect(normalizeAnalyticsQuery({ from: '2026-03-01' })).toMatchObject({
      ok: false,
      reason: 'invalid_range',
    });
    expect(normalizeAnalyticsQuery({ from: '2026-03-31', to: '2026-03-01' })).toMatchObject({
      ok: false,
      reason: 'invalid_range',
    });
    expect(normalizeAnalyticsQuery({ from: '2026-02-30', to: '2026-03-05' })).toMatchObject({
      ok: false,
      reason: 'invalid_range',
    });
    expect(normalizeAnalyticsQuery({})).toMatchObject({ ok: false, reason: 'missing_range' });
    expect(normalizeAnalyticsQuery({ yearMonth: '2026-13' })).toMatchObject({
      ok: false,
      reason: 'invalid_year_month',
    });
    expect(normalizeAnalyticsQuery({ yearMonth: '2026-1' })).toMatchObject({
      ok: false,
      reason: 'invalid_year_month',
    });
  });

  it('G-A: `basis` só vai na wire quando pedido, e um valor fora do contrato é recusado', () => {
    // Omissão = liquidez: NADA é enviado, a API aplica o default dela.
    const omitted = normalizeAnalyticsQuery({ yearMonth: '2026-01' });
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    expect(omitted.query).not.toHaveProperty('basis');
    // Pedido explícito: viaja, e viaja junto do período custom.
    expect(normalizeAnalyticsQuery({ yearMonth: '2026-01', basis: 'competencia' })).toEqual({
      ok: true,
      query: { period: 'custom', from: '2026-01-01', to: '2026-01-31', basis: 'competencia' },
    });
    expect(ANALYTICS_BASES).toEqual(['liquidez', 'competencia']);
    expect(DEFAULT_ANALYTICS_BASIS).toBe('liquidez');
    // Base inválida é recusada, nunca descartada: cair para liquidez responderia
    // a janela certa com a SEMÂNTICA errada.
    const invalid = normalizeAnalyticsQuery({ yearMonth: '2026-01', basis: 'caixa' as never });
    expect(invalid).toMatchObject({ ok: false, reason: 'invalid_basis' });
    expect('query' in invalid).toBe(false);
  });

  it('recusa daily-heatmap no caminho custom (a rota ignora period/from — armadilha 2)', () => {
    const rejected = normalizeAnalyticsQuery({
      tool: 'analytics_daily_heatmap',
      yearMonth: '2026-01',
    });
    expect(rejected).toMatchObject({ ok: false, reason: 'daily_heatmap_ignores_period' });
    // Nenhum período é devolvido: a janela da rota é a grade fixa (4 semanas
    // terminando em `to`) e não pode ser declarada como a janela pedida.
    expect('query' in rejected).toBe(false);
    // As duas tools expostas aceitam o caminho custom normalmente.
    for (const tool of ANALYTICS_TOOLS) {
      expect(normalizeAnalyticsQuery({ tool, yearMonth: '2026-01' }).ok).toBe(true);
    }
  });
});

describe('declareAnalyticsEnvelope (A09/R09 — fronteira inclusiva → exclusiva)', () => {
  it('declara effectivePeriod com toExclusive = dia seguinte (mesmo instante do fim inclusivo)', () => {
    const result = declareAnalyticsEnvelope(kpisResponse('2026-01-01', '2026-01-31'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.effectivePeriod).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      toExclusive: '2026-02-01',
    });
    expect(result.response.boundary).toBe(ANALYTICS_BOUNDARY);
    // G-A: a base EFETIVA é a da API, propagada verbatim.
    expect(result.response.basis).toBe('liquidez');
    // O corpo original permanece intacto (o envelope é aditivo).
    expect(result.response.incomeCents).toBe(240000);
    expect(result.response.previousPeriod).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('G03: a base da API vence a intenção do agente, nos dois sentidos', () => {
    // A API aplicou `liquidez`; o agente pediu `competencia`. O que vale é o que
    // a leitura fez - mentir sobre a base seria inventar prova.
    const declared = declareAnalyticsEnvelope(kpisResponse('2026-01-01', '2026-01-31', 'liquidez'), {
      requestedBasis: 'competencia',
    });
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(declared.response.basis).toBe('liquidez');
    expect(declared.response).not.toHaveProperty('agentRequestedBasis');

    // E quando a API declara `competencia`, ela é propagada.
    const competencia = declareAnalyticsEnvelope(kpisResponse('2026-01-01', '2026-01-31', 'competencia'));
    expect(competencia.ok).toBe(true);
    if (!competencia.ok) return;
    expect(competencia.response.basis).toBe('competencia');
  });

  it('G03: sem base declarada pela API o agente NÃO afirma base nenhuma', () => {
    const { basis: _ignored, ...withoutBasis } = kpisResponse('2026-01-01', '2026-01-31');
    const result = declareAnalyticsEnvelope(withoutBasis);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Afirmar `competencia` sobre uma leitura sem base declarada seria invenção.
    expect(result.response).not.toHaveProperty('basis');
    expect(result.response.agentRequestedBasis).toBe(DEFAULT_ANALYTICS_BASIS);
  });

  it('G03: um effectivePeriod vindo da API é preservado e o do agente fica ao lado', () => {
    const result = declareAnalyticsEnvelope({
      ...kpisResponse('2026-01-01', '2026-01-31'),
      effectivePeriod: { from: '2026-01-01', to: '2026-01-31', toExclusive: '2026-02-01' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.effectivePeriod).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      toExclusive: '2026-02-01',
    });
    expect(result.response.agentEffectivePeriod).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      toExclusive: '2026-02-01',
    });
  });

  it('calcula toExclusive em virada de ano e ano bissexto', () => {
    const cases: Array<[string, string, string]> = [
      ['2025-12-01', '2025-12-31', '2026-01-01'],
      ['2024-02-01', '2024-02-29', '2024-03-01'],
      ['2026-01-01', '2026-01-01', '2026-01-02'],
    ];
    for (const [from, to, expected] of cases) {
      const result = declareAnalyticsEnvelope(kpisResponse(from, to));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.response.effectivePeriod as { toExclusive: string }).toExclusive).toBe(expected);
    }
  });

  it('NÃO anexa envelope quando a resposta não traz período Effective (fail-closed, sem inventar janela)', () => {
    const withoutPeriod = declareAnalyticsEnvelope({ incomeCents: 1, expenseCents: 2 });
    expect(withoutPeriod).toMatchObject({ ok: false, reason: 'missing_effective_period' });
    expect('response' in withoutPeriod).toBe(false);
  });

  it('G-B: totalCents acima de MAX_SAFE_INTEGER ganha string decimal e flag approximate', () => {
    const unsafe = 10_000_000_000_040_000; // > 2^53: o double já perdeu centavos
    expect(unsafe).toBeGreaterThan(MAX_SAFE_CENTS);
    const result = declareAnalyticsEnvelope({
      period: { from: '2026-06-01', to: '2026-06-30' },
      kind: 'expense',
      totalCents: unsafe,
      slices: [
        { categoryId: 'cat-food', name: 'Alimentação', totalCents: unsafe, pct: 100, color: '#0E8C5A' },
        { categoryId: 'cat-fuel', name: 'Combustível', totalCents: 1000, pct: 0, color: null },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.totalCentsExact).toBe(String(unsafe));
    expect(result.response.approximate).toBe(true);
    const slices = result.response.slices as Array<Record<string, unknown>>;
    expect(slices[0]).toMatchObject({ totalCentsExact: String(unsafe), approximate: true });
    // Um total seguro não é marcado: a flag é por campo, não por resposta.
    expect(slices[1]).not.toHaveProperty('approximate');
  });

  it('mantém totalCents intacto quando está dentro do safe integer', () => {
    const result = declareAnalyticsEnvelope({
      period: { from: '2026-01-01', to: '2026-01-31' },
      totalCents: 281375,
      slices: [{ categoryId: 'cat-food', name: 'Alimentação', totalCents: 281375, pct: 100, color: null }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.totalCents).toBe(281375);
    expect(result.response).not.toHaveProperty('totalCentsExact');
    expect(result.response).not.toHaveProperty('approximate');
  });

  it('G03: o decimal exato da API NUNCA é sobrescrito pelo double local', () => {
    // G-B na API: o banco devolve o decimal exato; o number já perdeu centavos.
    // Trocar a prova da API pelo `String(double)` traria a perda de volta.
    const result = declareAnalyticsEnvelope({
      period: { from: '2026-06-01', to: '2026-06-30' },
      totalCents: 10000000000000000,
      totalCentsExact: '10000000000000001',
      approximate: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.totalCentsExact).toBe('10000000000000001');
    expect(result.response.approximate).toBe(true);
    expect(BigInt(result.response.totalCentsExact as string)).not.toBe(BigInt(result.response.totalCents as number));
  });
});

describe('curadoria das tools de analytics (A09 — precedente budget_trends)', () => {
  it('expõe as duas tools no catálogo com skill de relatórios', () => {
    const map = toolSkillMap();
    const lines = toolSkillLines();
    expect(map['analytics_kpis']).toBe('relatorios');
    expect(map['analytics_category_breakdown']).toBe('relatorios');
    expect(lines).toContain('analytics_kpis (relatorios): KPIs do período: receitas, despesas, saldo e faturas em aberto');
    expect(lines).toContain('analytics_category_breakdown (relatorios): gastos ou receitas por categoria no período');
    // Precedente budget_trends: entra pela skill, não pelo core de leituras.
    expect(CORE_READ_TOOLS).not.toContain('analytics_kpis');
    expect(CORE_READ_TOOLS).not.toContain('analytics_category_breakdown');
  });

  it('selectToolsFor mantém as duas tools e respeita o teto de 20', () => {
    const names = selectToolsFor(['relatorios']);
    for (const tool of ANALYTICS_TOOLS) expect(names).toContain(tool);
    expect(names.length).toBeLessThanOrEqual(MAX_EXPOSED_TOOLS);
    const large = selectToolsFor(['registros', 'relatorios', 'contas-cartoes', 'compromissos', 'orcamentos-metas']);
    expect(large.length).toBeLessThanOrEqual(MAX_EXPOSED_TOOLS);
  });

  it('NÃO bloqueia as leituras de analytics como mutação (prefixo de leitura registrado)', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(kpisResponse('2026-01-01', '2026-01-31')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const tools = buildExposedTools(['analytics_kpis'], {
        delegatedToken: 'delegated-test-token',
        apiOrigin: 'https://api.example.test',
        workspaceId: 'ws-1',
        actorId: 'actor-1',
        intentionId: 'intent-1',
        lastUserMessage: 'como estou em janeiro?',
      });
      const result = (await (tools['analytics_kpis'] as { execute: (p: unknown) => Promise<unknown> }).execute({
        period: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
      })) as Record<string, unknown>;
      expect(result).not.toHaveProperty('blocked');
      expect(result.incomeCents).toBe(240000);
    } finally {
      globalThis.fetch = realFetch;
      apiClient.clearGlobalApiContext();
    }
  });
});

/**
 * A09/FIX B1 — o normalizador e o envelope só existemiam como módulo: a tool
 * gerada era chamada DIRETO, então nenhum dos dois rodava no caminho
 * executável. Estes testes exercitam a BORDA (`buildExposedTools`), que é o que
 * o modelo de fato chama.
 */
describe('borda executável das tools de analytics (A09/FIX B1)', () => {
  const ctx = {
    delegatedToken: 'delegated-test-token',
    apiOrigin: 'https://api.example.test',
    workspaceId: 'ws-1',
    actorId: 'actor-1',
    intentionId: 'intent-1',
    lastUserMessage: 'como estou em janeiro?',
  };
  const withFetch = async (
    payload: unknown,
    run: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = realFetch;
      apiClient.clearGlobalApiContext();
    }
  };
  const call = async (name: string, params: Record<string, unknown>) => {
    const tools = buildExposedTools([name], ctx);
    return (await (tools[name] as { execute: (p: unknown) => Promise<unknown> }).execute(params)) as Record<string, unknown>;
  };

  it('RED: uma resposta SEM período utilizável é recusada — nenhum envelope é declarado', async () => {
    const result = await withFetch({ incomeCents: 1, expenseCents: 2 }, () => call('analytics_kpis', {
      period: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
    }));
    // Fail-closed: o modelo não recebe os números sem a janela que os produziu.
    expect(result).toMatchObject({ ok: false, reason: 'missing_effective_period' });
    expect(result).not.toHaveProperty('incomeCents');
    expect(result).not.toHaveProperty('effectivePeriod');
  });

  it('RED: totalCents fora do safe integer chega ao modelo com approximate:true', async () => {
    const unsafe = 10_000_000_000_040_000;
    const result = await withFetch(
      {
        period: { from: '2026-01-01', to: '2026-01-31' },
        kind: 'expense',
        basis: 'liquidez',
        totalCents: unsafe,
        slices: [],
      },
      () => call('analytics_category_breakdown', {
        period: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
        kind: 'expense',
      }),
    );
    expect(result).toMatchObject({
      approximate: true,
      totalCentsExact: String(unsafe),
      effectivePeriod: { from: '2026-01-01', to: '2026-01-31', toExclusive: '2026-02-01' },
      boundary: ANALYTICS_BOUNDARY,
      basis: 'liquidez',
    });
  });

  it('G03: basis=competencia sai na wire e a base declarada pela API volta no payload', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(kpisResponse('2026-01-01', '2026-01-31', 'competencia')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const result = await call('analytics_kpis', {
        period: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
        basis: 'competencia',
      });
      const url = String(fetchMock.mock.calls[0]?.[0] as unknown);
      expect(url).toContain('basis=competencia');
      // E a resposta é o que a APIsays: o envelope do agente não a contradiz.
      expect(result.basis).toBe('competencia');
      expect(result.transactionCount).toBe(18);
      expect(result.semanticsVersion).toBe('1');
    } finally {
      globalThis.fetch = realFetch;
      apiClient.clearGlobalApiContext();
    }
  });

  it('G03: um basis inválido é recusado ANTES da rede (fail-closed no parâmetro)', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const result = await call('analytics_kpis', {
        period: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
        basis: 'caixa',
      });
      expect(result).toMatchObject({ ok: false, reason: 'invalid_basis' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      apiClient.clearGlobalApiContext();
    }
  });

  it('RED: uma janela incompleta/inválida é recusada ANTES da rede (fail-closed no parâmetro)', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      // `period=custom` sem intervalo: a API cairia em last30days em silêncio.
      const incomplete = await call('analytics_kpis', { period: 'custom' });
      expect(incomplete).toMatchObject({ ok: false, reason: 'missing_range' });
      const invalid = await call('analytics_kpis', { period: 'custom', from: '2026-02-30', to: '2026-03-05' });
      expect(invalid).toMatchObject({ ok: false, reason: 'invalid_range' });
      // Nenhuma das recusas chegou à API.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      apiClient.clearGlobalApiContext();
    }
  });

  it('RED: yearMonth é normalizado em período custom antes de sair para a wire', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(kpisResponse('2026-01-01', '2026-01-31')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const result = await call('analytics_kpis', { period: 'custom', yearMonth: '2026-01' });
      expect(result).toMatchObject({ success: true, incomeCents: 240000 });
      const url = String(fetchMock.mock.calls[0]?.[0] as unknown);
      expect(url).toContain('period=custom');
      expect(url).toContain('from=2026-01-01');
      expect(url).toContain('to=2026-01-31');
    } finally {
      globalThis.fetch = realFetch;
      apiClient.clearGlobalApiContext();
    }
  });

  it('RED: o slice sintético "Outras" (6ª categoria) passa pelo envelope sem rejeição', async () => {
    // compute.ts:203 empilha a cauda como `categoryId: 'outras'` quando há mais
    // de 5 macros: o payload real viola um schema UUID-only (FIX B2).
    const result = await withFetch(
      {
        period: { from: '2026-01-01', to: '2026-01-31' },
        kind: 'expense',
        totalCents: 210000,
        slices: [
          { categoryId: '00000000-0000-4000-8000-000000000001', name: 'Alimentação', totalCents: 50000, pct: 23.8, color: '#0E8C5A' },
          { categoryId: '00000000-0000-4000-8000-000000000002', name: 'Moradia', totalCents: 40000, pct: 19, color: '#0E8C5A' },
          { categoryId: '00000000-0000-4000-8000-000000000003', name: 'Transporte', totalCents: 30000, pct: 14.3, color: '#0E8C5A' },
          { categoryId: '00000000-0000-4000-8000-000000000004', name: 'Saúde', totalCents: 30000, pct: 14.3, color: '#0E8C5A' },
          { categoryId: '00000000-0000-4000-8000-000000000005', name: 'Lazer', totalCents: 40000, pct: 19, color: '#0E8C5A' },
          { categoryId: 'outras', name: 'Outras', totalCents: 20000, pct: 9.5, color: '#9AA5A0' },
        ],
      },
      () => call('analytics_category_breakdown', {
        period: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
        kind: 'expense',
      }),
    );
    expect(result).not.toMatchObject({ ok: false });
    const slices = result.slices as Array<Record<string, unknown>>;
    expect(slices).toHaveLength(6);
    expect(slices[5]).toMatchObject({ categoryId: 'outras', name: 'Outras', totalCents: 20000 });
    expect(result.effectivePeriod).toEqual({ from: '2026-01-01', to: '2026-01-31', toExclusive: '2026-02-01' });
  });
});

describe('tool gerada de analytics (integração com a borda de request)', () => {
  it('analytics_kpis lê /analytics/kpis e nunca envia householdId na wire', async () => {
    const tool = generatedHttpTools.find((candidate) => candidate.name === 'analytics_kpis');
    expect(tool).toBeDefined();

    // Fake no mesmo seam que `MutationApiClient` injeta (`deps.request`), sem rede.
    const request = vi.fn().mockResolvedValue(kpisResponse('2026-01-01', '2026-01-31'));
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockImplementation(request as never);

    try {
      const result = (await tool!.execute(
        'analytics-kpis-call',
        {
          householdId: '11111111-1111-4111-8111-111111111111',
          period: 'custom',
          from: '2026-01-01',
          to: '2026-01-31',
        },
        undefined,
        undefined,
        { delegatedToken: 'delegated-test-token', apiOrigin: 'https://api.example.test' },
      )) as Record<string, unknown>;

      expect(result).toMatchObject({ success: true, incomeCents: 240000 });
      expect(request).toHaveBeenCalledTimes(1);
      const [method, path, opts] = request.mock.calls[0] as [string, string, { query?: Record<string, unknown> }];
      expect(method).toBe('GET');
      expect(path).toBe('/analytics/kpis');
      expect(opts?.query).toEqual({ period: 'custom', from: '2026-01-01', to: '2026-01-31' });
      expect(opts?.query).not.toHaveProperty('householdId');
    } finally {
      spy.mockRestore();
    }
  });

  it('analytics_category_breakdown envia period+kind e expõe slices no payload real', async () => {
    const tool = generatedHttpTools.find((candidate) => candidate.name === 'analytics_category_breakdown');
    expect(tool).toBeDefined();

    const request = vi.fn().mockResolvedValue({
      period: { from: '2026-01-01', to: '2026-01-31' },
      kind: 'expense',
      totalCents: 210000,
      slices: [{ categoryId: 'cat-food', name: 'Alimentação', totalCents: 210000, pct: 100, color: '#0E8C5A' }],
    });
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockImplementation(request as never);

    try {
      const result = (await tool!.execute('analytics-breakdown-call', {
        period: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
        kind: 'expense',
      })) as Record<string, unknown>;
      expect(result).toMatchObject({ success: true, kind: 'expense', totalCents: 210000 });
      const [, , opts] = request.mock.calls[0] as [string, string, { query?: Record<string, unknown> }];
      expect(opts?.query).toEqual({ period: 'custom', from: '2026-01-01', to: '2026-01-31', kind: 'expense' });
    } finally {
      spy.mockRestore();
    }
  });
});