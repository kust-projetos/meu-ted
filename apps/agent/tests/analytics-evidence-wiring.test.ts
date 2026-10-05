/**
 * A04/A09 pós-G03 — o envelope de prova das leituras de analytics ligado ao
 * CAMINHO DE EVIDÊNCIA do turno.
 *
 * Antes desta fatia o envelope existia (`analytics-envelope.ts`) e era anexado
 * ao payload que a TOOL devolve ao modelo, mas o `EvidenceEnvelope` do
 * orquestrador — a evidência que o turno realmente apresenta e sobre a qual a
 * resposta é grounded — nunca carregava a prova: uma leitura de analytics
 * planejada pelo turno não produzia item de evidência nenhum.
 *
 * Contrato testado:
 * - envelope presente (da API, G03) → a evidência cita a janela, a fronteira,
 *   a base efetiva e os decimais exatos;
 * - envelope ausente/inválido → degradação honesta: item `error` tipado com
 *   `data: null`, NENHUM número no envelope serializado;
 * - janela vazia declarada pela API → `empty`/`period_empty`, nunca `ok` com
 *   zeros;
 * - a borda da tool expõe o mesmo bloco de prova ao modelo (paralelo ao bloco
 *   `evidence` das tools web da A12).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_EVIDENCE_UNAVAILABLE_PREFIX,
  declareAnalyticsEnvelope,
  renderAnalyticsEvidence,
} from '../src/agent-config/analytics-envelope.js';
import { buildExposedTools } from '../src/agent-config/tools.js';
import { createChannelGrounding, type ChannelReadTools } from '../src/orchestration/channel-evidence.js';
import type { TurnInput, TurnPlan } from '../src/orchestration/conversation-orchestrator.js';
import * as apiClient from '../src/tools/api-client.js';
import { generatedHttpTools } from '../src/generated/http-tools.js';

const input: TurnInput = {
  intentionId: 'intent-a09-evidence',
  traceId: 'intent-a09-evidence',
  text: 'como estou em janeiro?',
  actorId: 'actor-a09',
  workspaceId: 'ws-a09',
  role: 'member',
  deviceId: null,
  attachments: [],
  channel: 'pwa-rest',
};

/** `general` has no domain fallback read, so exactly the planned read runs. */
const planFor = (operation: string): TurnPlan => ({
  version: '2',
  mode: 'read',
  domain: 'general',
  skillNames: ['relatorios'],
  requestedOperations: [{ name: operation, kind: 'read' }],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

const readTools = (overrides: Partial<ChannelReadTools>): ChannelReadTools => {
  const unused = async () => { throw new Error('read.not_planned'); };
  return {
    listAccounts: unused,
    listRecentTransactions: unused,
    getMonthSummary: unused,
    listStatements: unused,
    listAccountsPayable: unused,
    listBudgets: unused,
    listGoals: unused,
    listCategories: unused,
    analyticsKpis: unused,
    analyticsCategoryBreakdown: unused,
    ...overrides,
  } as ChannelReadTools;
};

/**
 * The REAL `GET /analytics/kpis` body (plus the `success: true` the generated
 * projection adds for a spec with no `result`). Flat by construction: the route
 * spreads `period`, the totals and the G03 proof envelope on the same object —
 * there is no nested `proof` object, and NO `balanceCents` (net worth is
 * `netLiquidBalanceCents`/`netWorthCents`). The old fixture carried a
 * `balanceCents` the API never sends and omitted every field it does.
 */
const kpisPayload = (basis: 'liquidez' | 'competencia' = 'competencia') => ({
  success: true,
  period: { from: '2026-01-01', to: '2026-01-31' },
  previousPeriod: { from: '2025-12-02', to: '2025-12-31' },
  accountsTotalCents: 180000,
  dueSoonCents: 0,
  openInvoices: { committedCents: 0, limitCents: 500000, utilizationPct: 0 },
  netLiquidBalanceCents: 180000,
  savingsRatePct: 12.5,
  savingsRateTargetPct: 20,
  previousSavingsRatePct: 5,
  fixedVsDiscretionary: {
    scope: 'household',
    fixedCents: 90000,
    discretionaryCents: 120000,
    fixedPctOfIncome: 37.5,
    subscriptionsCents: 90000,
  },
  incomeCents: 240000,
  expenseCents: 210000,
  previousIncomeCents: 200000,
  previousExpenseCents: 190000,
  netWorthCents: 180000,
  // Proof envelope (G03), flat on the same object.
  transactionCount: 18,
  asOf: '2026-02-01T12:00:00.000Z',
  basis,
  semanticsVersion: '1',
  effectiveFilter: { period: 'custom', from: '2026-01-01', to: '2026-01-31', accountId: null },
  emptyReason: null,
});

/** The REAL `GET /analytics/category-breakdown` body: `slices` + the same proof. */
const breakdownPayload = (totalCents: number) => ({
  success: true,
  period: { from: '2026-01-01', to: '2026-01-31' },
  kind: 'expense',
  totalCents,
  slices: [
    { categoryId: '00000000-0000-4000-8000-000000000001', name: 'Alimentação', totalCents: 100000, pct: 50, color: '#0E8C5A' },
  ],
  transactionCount: 1,
  asOf: '2026-02-01T12:00:00.000Z',
  basis: 'liquidez' as const,
  semanticsVersion: '1',
  effectiveFilter: { period: 'custom', from: '2026-01-01', to: '2026-01-31', accountId: null, kind: 'expense' },
  emptyReason: null,
});

const envelopeFor = async (operation: string, tools: Partial<ChannelReadTools>) => {
  const grounding = createChannelGrounding({ respond: async () => 'unused', readTools: readTools(tools) });
  const envelope = await grounding.evidenceProvider(input, planFor(operation));
  if (!envelope) throw new Error('envelope.expected');
  return envelope;
};

describe('envelope de analytics no caminho de evidência do turno (A04/A09 pós-G03)', () => {
  it('RED: analytics_kpis produz item de evidência COM o envelope de prova da API', async () => {
    const envelope = await envelopeFor('analytics_kpis', { analyticsKpis: async () => kpisPayload() });
    expect(envelope.items).toHaveLength(1);
    const item = envelope.items[0];
    expect(item?.status).toBe('ok');
    expect(item?.source).toBe('api.analytics.kpis');
    // A janela e a fronteira que produziram os números viajam com eles.
    expect(item?.data).toMatchObject({
      effectivePeriod: { from: '2026-01-01', to: '2026-01-31', toExclusive: '2026-02-01' },
      boundary: 'inclusive',
      basis: 'competencia',
      transactionCount: 18,
      semanticsVersion: '1',
    });
    expect(item?.data).not.toHaveProperty('agentRequestedBasis');
  });

  it('RED: analytics_category_breakdown carrega o decimal exato e a flag approximate (G-B)', async () => {
    const unsafe = 10_000_000_000_040_000;
    const envelope = await envelopeFor('analytics_category_breakdown', {
      analyticsCategoryBreakdown: async () => breakdownPayload(unsafe),
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('ok');
    expect(item?.source).toBe('api.analytics.category-breakdown');
    expect(item?.data).toMatchObject({
      approximate: true,
      totalCentsExact: String(unsafe),
      effectivePeriod: { from: '2026-01-01', to: '2026-01-31', toExclusive: '2026-02-01' },
    });
  });

  it('RED: sem envelope utilizável a leitura vira FALHA tipada, sem nenhum número', async () => {
    // A API respondeu, mas sem a janela que produziu os totais: declarar uma
    // janela seria inventar prova (R04) e ancorar os números sem a fonte.
    const envelope = await envelopeFor('analytics_kpis', {
      analyticsKpis: async () => ({ success: true, incomeCents: 240000, expenseCents: 210000, transactionCount: 18 }),
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('error');
    expect(item?.reason).toBe('permanent_error');
    expect(item?.data).toBeNull();
    expect(JSON.stringify(envelope)).not.toContain('incomeCents');
    expect(JSON.stringify(envelope)).not.toContain('240000');
  });

  it('RED: janela vazia declarada pela API é ausência tipada, nunca `ok` com zeros', async () => {
    const envelope = await envelopeFor('analytics_kpis', {
      analyticsKpis: async () => ({
        ...kpisPayload(),
        incomeCents: 0,
        expenseCents: 0,
        transactionCount: 0,
        // Closed enum (apps/api/src/analytics/types.ts): 'no_transactions_in_period'
        // is what `kpis` declares for an empty window.
        emptyReason: 'no_transactions_in_period',
      }),
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('empty');
    expect(item?.reason).toBe('period_empty');
    expect(JSON.stringify(envelope)).not.toContain('240000');
  });

  it('RED: a base pedida é declarada à parte quando a API não declara a base efetiva', async () => {
    const { basis: _omitted, ...withoutBasis } = kpisPayload();
    const envelope = await envelopeFor('analytics_kpis', { analyticsKpis: async () => withoutBasis });
    const item = envelope.items[0];
    expect(item?.status).toBe('ok');
    expect(item?.data).not.toHaveProperty('basis');
    expect(item?.data).toHaveProperty('agentRequestedBasis', 'liquidez');
  });

  it('RED: falha de transporte na leitura de analytics continua um erro classificado', async () => {
    const envelope = await envelopeFor('analytics_kpis', {
      analyticsKpis: async () => {
        throw Object.assign(new Error('HTTP 403'), { statusCode: 403, code: 'api.request_failed' });
      },
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('error');
    expect(item?.reason).toBe('forbidden');
    expect(item?.data).toBeNull();
  });
});

describe('bloco de prova das leituras de analytics (render)', () => {
  it('declara janela, fronteira, base efetiva e decimais exatos', () => {
    const unsafe = 10_000_000_000_040_000;
    const rendered = renderAnalyticsEvidence(
      declareAnalyticsEnvelope(breakdownPayload(unsafe)),
      { tool: 'analytics_category_breakdown' },
    );
    expect(rendered).toContain('analytics_category_breakdown');
    expect(rendered).toContain('2026-01-01');
    expect(rendered).toContain('2026-02-01');
    expect(rendered).toContain('inclusiva');
    expect(rendered).toContain(String(unsafe));
  });

  it('NUNCA afirma uma base que a leitura não declarou; publica o que o agente pediu', () => {
    const { basis: _omitted, ...withoutBasis } = kpisPayload();
    const rendered = renderAnalyticsEvidence(declareAnalyticsEnvelope(withoutBasis), { tool: 'analytics_kpis' });
    expect(rendered).toContain('liquidez');
    expect(rendered).not.toContain('base efetiva: competencia');
  });

  it('envelope ausente → linha honesta, sem números', () => {
    const rendered = renderAnalyticsEvidence(declareAnalyticsEnvelope({ incomeCents: 240000 }), {
      tool: 'analytics_kpis',
    });
    expect(rendered).toContain(ANALYTICS_EVIDENCE_UNAVAILABLE_PREFIX);
    expect(rendered).not.toContain('240000');
    expect(rendered).not.toContain('effectivePeriod');
  });

  it('respeita o teto de caracteres do bloco', () => {
    const rendered = renderAnalyticsEvidence(declareAnalyticsEnvelope(kpisPayload()), { tool: 'analytics_kpis', charBudget: 80 });
    expect(rendered.length).toBeLessThanOrEqual(80);
  });
});

describe('borda da tool expõe o bloco de prova ao modelo', () => {
  const ctx = {
    delegatedToken: 'delegated-test-token',
    apiOrigin: 'https://api.example.test',
    workspaceId: 'ws-1',
    actorId: 'actor-1',
    intentionId: 'intent-1',
    lastUserMessage: 'como estou em janeiro?',
  };

  const callAnalytics = async (name: string, params: Record<string, unknown>) => {
    const tools = buildExposedTools([name], ctx);
    return (await (tools[name] as { execute: (p: unknown) => Promise<unknown> }).execute(params)) as Record<string, unknown>;
  };

  it('RED: o resultado da tool carrega a prova (janela + base) junto do payload', async () => {
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue(kpisPayload() as never);
    try {
      const result = await callAnalytics('analytics_kpis', {
        period: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
        basis: 'competencia',
      });
      const evidence = String(result.evidence ?? '');
      expect(evidence).toContain('analytics_kpis');
      expect(evidence).toContain('2026-01-31');
      expect(evidence).toContain('competencia');
      // O payload continua intacto: o bloco é ADITIVO.
      expect(result.incomeCents).toBe(240000);
    } finally {
      spy.mockRestore();
    }
  });

  it('RED: payload sem envelope devolve a recusa E a degradação honesta, sem números', async () => {
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue({ success: true, incomeCents: 240000 } as never);
    try {
      const result = await callAnalytics('analytics_kpis', {
        period: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(result).toMatchObject({ ok: false, reason: 'missing_effective_period' });
      const evidence = String(result.evidence ?? '');
      expect(evidence).toContain(ANALYTICS_EVIDENCE_UNAVAILABLE_PREFIX);
      expect(evidence).not.toContain('240000');
    } finally {
      spy.mockRestore();
    }
  });

  it('a leitura de analytics na evidência pede period=custom (a API descartaria from/to)', async () => {
    const spy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValue(kpisPayload() as never);
    try {
      const grounding = createChannelGrounding({ respond: async () => 'unused' });
      await grounding.evidenceProvider(input, planFor('analytics_kpis'));
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , options] = spy.mock.calls[0] as [string, string, { query?: Record<string, unknown> }];
      expect(options.query).toMatchObject({ period: 'custom' });
      expect(String(options.query?.from)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(options.query?.to)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      spy.mockRestore();
      apiClient.clearGlobalApiContext();
    }
    // O tool gerado existe com o nome usado no mapeamento.
    expect(generatedHttpTools.some((tool) => tool.name === 'analytics_kpis')).toBe(true);
    expect(generatedHttpTools.some((tool) => tool.name === 'analytics_category_breakdown')).toBe(true);
  });
});
