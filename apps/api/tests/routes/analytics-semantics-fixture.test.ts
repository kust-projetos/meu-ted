/**
 * G03 - `analytics-semantics.fixture.json` as a REAL aggregation test.
 *
 * The spike (A09) produced this fixture as evidence and no gate executed it.
 * The SPEC adendo 11.1 item 4 turns it into a test: cases F (card purchase vs
 * invoice payment), H (safe integers) and L (proof envelope) are the RED that
 * the three named gaps had to close; cases A-E, I-K lock that the DEFAULT
 * behaviour (basis `liquidez`) did not move by one cent.
 *
 * Backend: the in-memory store source, through the real HTTP routes
 * (`buildTestApp` + the fixture dataset), so the envelope and `basis` are
 * proven where clients actually read them. The Postgres twin of these
 * assertions (the production aggregate SQL) lives in
 * `tests/integration/postgres-analytics-semantics.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Statement } from '../../src/types/domain.js';
import { buildTestApp, TOKEN_A, TOKEN_B } from '../test-app.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';
import {
  analyticsFixture,
  expectedTransactionCount,
  fixtureAccounts,
  fixtureCase,
  fixtureCategories,
  fixtureSoftDeletedIds,
  fixtureStatements,
  fixtureTransactions,
} from '../fixtures/analytics-semantics-dataset.js';

const CLOCK = () => new Date('2026-09-07T12:00:00.000Z');
const AS_OF = '2026-09-07T12:00:00.000Z';
const H = { 'x-device-token': TOKEN_A, 'content-type': 'application/json' };
const HB = { 'x-device-token': TOKEN_B, 'content-type': 'application/json' };

/** Fields the proof envelope (G-C) must carry on EVERY analytics response. */
const ENVELOPE_FIELDS = ['transactionCount', 'asOf', 'basis', 'semanticsVersion', 'effectiveFilter', 'emptyReason'] as const;

const seedApp = () => {
  const built = buildTestApp(
    { accounts: fixtureAccounts(), categories: fixtureCategories(), transactions: fixtureTransactions() },
    CLOCK,
  );
  // Undo/soft-delete is a tombstone set in the in-memory state; the read store
  // holds the SAME Set instance, so filling it after boot is enough.
  for (const id of fixtureSoftDeletedIds()) built.state.deletedTransactions.add(id);
  // The card store owns statements outside `InMemoryState` (`_statements`).
  (built.state as unknown as { _statements: Statement[] })._statements.push(...fixtureStatements());
  return built;
};

const get = async (
  app: FastifyInstance,
  path: string,
  query: Record<string, string> = {},
  headers: Record<string, string> = H,
): Promise<Record<string, any>> => {
  const search = new URLSearchParams(query).toString();
  const res = await app.inject({ method: 'GET', url: search ? `${path}?${search}` : path, headers });
  expect(res.statusCode, `${path} ${search}`).toBe(200);
  return res.json() as Record<string, any>;
};

/** Case-driven query: the fixture's own `request.query` drives the test. */
const queryOf = (id: string): Record<string, string> => {
  const request = fixtureCase(id).request;
  expect(request.query, `${id} must declare a query`).not.toBeNull();
  return request.query as Record<string, string>;
};

const expectedOf = <T = Record<string, any>>(id: string): T => fixtureCase(id).expected as T;

describe('G03 fixture — default behaviour did NOT move (basis ausente = liquidez)', () => {
  it('A: janeiro por competência já estava certo — total, macros e pct preservados', async () => {
    const { app } = seedApp();
    const body = await get(app, '/analytics/category-breakdown', queryOf('A-competencia-vs-pagamento'));
    const expected = expectedOf<{
      totalCents: number;
      slices: Array<{ categoryId: string; name: string; totalCents: number; pct: number }>;
    }>('A-competencia-vs-pagamento');
    expect(body.totalCents).toBe(expected.totalCents);
    // Só as quatro chaves financeiro-comparadas: o fixture ainda anota o
    // defeito de rótulo (`defect`) que é contexto de spike, não contrato.
    const money = (slice: { categoryId: string; name: string; totalCents: number; pct: number }) => ({
      categoryId: slice.categoryId,
      name: slice.name,
      totalCents: slice.totalCents,
      pct: slice.pct,
    });
    expect(body.slices.map(money)).toEqual(expected.slices.map(money));
    // A compra de 20/jan entra; o pagamento de 05/fev (mesma fatura) fica fora
    // da janela - nenhum filtro novo pode mudar isso.
    expect(body.basis).toBe('liquidez');
  });

  it('B/C/D: pendente nunca entrou, soft-delete some, undo é opaco — totais intocados', async () => {
    const { app } = seedApp();
    const kpis = await get(app, '/analytics/kpis', queryOf('B-status-pending-vs-confirmed'));
    const softDelete = expectedOf<{ expenseCents: number; incomeCents: number; excludedCents: number }>('C-soft-delete');
    expect(kpis.expenseCents).toBe(softDelete.expenseCents);
    expect(kpis.incomeCents).toBe(softDelete.incomeCents);
    // O payable pending de 9.000 nunca é lido por analytics (exclusão implícita).
    const pending = expectedOf<{ pendingPayableExcludedCents: number }>('B-status-pending-vs-confirmed');
    expect(kpis.expenseCents).toBeLessThan(softDelete.expenseCents + pending.pendingPayableExcludedCents);
    // D: o valor some corretamente e não há sinal de undo - a prova disto é o
    // envelope (transactionCount), não um campo novo de estorno.
    const undo = expectedOf<{ expenseCents: number; undoneCentsObservable: number }>('D-undo-estorno');
    expect(kpis.expenseCents).toBe(undo.expenseCents);
    expect(kpis).not.toHaveProperty('undoneCents');
  });

  it('E: transferência nunca vira despesa + receita', async () => {
    const { app } = seedApp();
    const expected = expectedOf<{ incomeCents: number; expenseCents: number; transferCountedAs: string }>('E-transferencia');
    const kpis = await get(app, '/analytics/kpis', queryOf('E-transferencia'));
    expect(kpis.incomeCents).toBe(expected.incomeCents);
    expect(kpis.expenseCents).toBe(expected.expenseCents);
    // A transferência de 40.000 (2026-01-16) não aparece em nenhum agregado:
    // nenhum dos totais a carrega, e `transactionCount` também não a conta.
    expect(kpis.transactionCount).toBe(7);
    expect(expected.transferCountedAs).toBe('nenhum');
    // `destinationAccountScopedTotalCents: 0` (a assimetria do dialeto canônico,
    // que casa só `account_id` de origem) exige um id de conta UUID: o fixture
    // usa ids simbólicos e tanto a query da rota quanto o filtro do store
    // recusam. Essa metade do caso é provada na suite Postgres, com UUIDs reais.
  });

  it('G: descendentes somam uma vez só no ancestral (sem duplicação)', async () => {
    const { app } = seedApp();
    const expected = expectedOf<{ subtree: string[]; subtreeTotalCents: number }>('G-ancestral-descendentes');
    const body = await get(app, '/analytics/category-breakdown', queryOf('G-ancestral-descendentes'));
    const macro = body.slices.find((s: { categoryId: string }) => s.categoryId === 'cat-food');
    expect(macro.totalCents).toBe(expected.subtreeTotalCents);
    // Nenhum ancestral duplica o total: a soma dos slices fecha o total.
    expect(body.slices.reduce((sum: number, s: { totalCents: number }) => sum + s.totalCents, 0)).toBe(body.totalCents);
  });

  it('I: dataset maior que uma página não perde linha (250 e exatamente 200)', async () => {
    const { app } = seedApp();
    const expected = expectedOf<{ g1: { totalCents: number }; g2: { totalCents: number } }>('I-dataset-maior-que-uma-pagina');
    const april = await get(app, '/analytics/kpis', queryOf('I-dataset-maior-que-uma-pagina'));
    expect(april.expenseCents).toBe(expected.g1.totalCents);
    // g2 tem exatamente 1 página: pega o break na borda.
    const may = await get(app, '/analytics/kpis', { period: 'custom', from: '2026-05-01', to: '2026-05-31' });
    expect(may.expenseCents).toBe(expected.g2.totalCents);
  });

  it('J: dois workspaces não se enxergam e o household não vem da query', async () => {
    const { app } = seedApp();
    const expected = expectedOf<{ workspaceA: { expenseCents: number; incomeCents: number }; workspaceB: { expenseCents: number; incomeCents: number } }>(
      'J-dois-workspaces',
    );
    const a = await get(app, '/analytics/kpis', queryOf('J-dois-workspaces'));
    expect(a.expenseCents).toBe(expected.workspaceA.expenseCents);
    expect(a.incomeCents).toBe(expected.workspaceA.incomeCents);
    const b = await get(app, '/analytics/kpis', queryOf('J-dois-workspaces'), HB);
    expect(b.expenseCents).toBe(expected.workspaceB.expenseCents);
    expect(b.incomeCents).toBe(expected.workspaceB.incomeCents);
    // Mandar o outro household na query não atravessa o token.
    const spoof = await get(app, '/analytics/kpis', { ...queryOf('J-dois-workspaces'), householdId: HOUSEHOLD_A });
    expect(spoof.expenseCents).toBe(expected.workspaceA.expenseCents);
  });

  it('K: janeiro x fevereiro segue com 71.000 contra 54.500', async () => {
    const { app } = seedApp();
    const expected = expectedOf<{ januaryExpenseCents: number; februaryExpenseCents: number; deltaCents: number }>(
      'K-comparacao-entre-meses',
    );
    const january = await get(app, '/analytics/kpis', queryOf('K-comparacao-entre-meses'));
    const february = await get(app, '/analytics/kpis', { period: 'custom', from: '2026-02-01', to: '2026-02-28' });
    expect(january.expenseCents).toBe(expected.januaryExpenseCents);
    expect(february.expenseCents).toBe(expected.februaryExpenseCents);
    expect(february.expenseCents - january.expenseCents).toBe(expected.deltaCents);
  });

  it('a omissão de basis e de period mantém o preset e a semântica atuais', async () => {
    const { app } = seedApp();
    const explicit = await get(app, '/analytics/kpis', queryOf('A-competencia-vs-pagamento'));
    const viaDefault = await get(app, '/analytics/kpis', { period: 'custom', from: '2026-01-01', to: '2026-01-31' });
    expect(viaDefault.expenseCents).toBe(explicit.expenseCents);
    expect(viaDefault.basis).toBe('liquidez');
    // from/to sem period: a API cai em last30days (armadilha do spike 3.1) e o
    // envelope passa a DECLARAR isso em vez de esconder.
    const dropped = await get(app, '/analytics/kpis', { from: '2026-01-01', to: '2026-01-31' });
    expect(dropped.effectiveFilter.period).toBe('last30days');
    expect(dropped.expenseCents).not.toBe(explicit.expenseCents);
  });
});

describe('G03 fixture — F (G-A): basis=competencia tira o pagamento da fatura do agregado de despesa', () => {
  it('mesma janela, dois resultados: liquidez conta 2x a fatura, competencia conta 1x', async () => {
    const { app } = seedApp();
    const expected = expectedOf<{
      naiveExpenseCents: number;
      invoiceDoubleCountedCents: number;
      competenciaExpenseCents: number;
      categoryBreakdownTotalCents: number;
    }>('F-cartao-vs-fatura');
    const query = queryOf('F-cartao-vs-fatura');

    const liquidez = await get(app, '/analytics/kpis', query);
    expect(liquidez.expenseCents).toBe(expected.naiveExpenseCents);
    expect(liquidez.basis).toBe('liquidez');

    const competencia = await get(app, '/analytics/kpis', { ...query, basis: 'competencia' });
    expect(competencia.expenseCents).toBe(expected.competenciaExpenseCents);
    expect(competencia.basis).toBe('competencia');
    // A infla��ão é exatamente o valor das faturas pagas na janela.
    expect(liquidez.expenseCents - competencia.expenseCents).toBe(expected.invoiceDoubleCountedCents);
    // Receita nunca muda: o predicado só toca o agregado de despesa.
    expect(competencia.incomeCents).toBe(liquidez.incomeCents);

    const breakdown = await get(app, '/analytics/category-breakdown', { ...query, kind: 'expense' });
    expect(breakdown.totalCents).toBe(expected.categoryBreakdownTotalCents);
    // Os pagamentos de fatura não têm categoria, então o breakdown não os via -
    // mas o kpis via. A lacuna era essa, e ela continua visível por escrito.
    expect(breakdown.totalCents).not.toBe(liquidez.expenseCents);
  });

  it('a compra permanece na data da compra e a série diária também respeita a base', async () => {
    const { app } = seedApp();
    // 2026-01-20: compra de cart��o (statement_id) e nada mais - permanece.
    const january = await get(app, '/analytics/daily-heatmap', { to: '2026-01-20' });
    const day20 = january.weeks.flatMap((w: { days: Array<{ date: string; totalCents: number }> }) => w.days).find(
      (d: { date: string }) => d.date === '2026-01-20',
    );
    expect(day20.totalCents).toBe(30000);
    // 2026-02-05: o pagamento da fatura de janeiro - liquidez conta, competencia n��o.
    const payment = await get(app, '/analytics/daily-heatmap', { to: '2026-02-05' });
    const day05 = payment.weeks.flatMap((w: { days: Array<{ date: string; totalCents: number }> }) => w.days).find(
      (d: { date: string }) => d.date === '2026-02-05',
    );
    const paymentCompetencia = await get(app, '/analytics/daily-heatmap', { to: '2026-02-05', basis: 'competencia' });
    const day05Competencia = paymentCompetencia.weeks
      .flatMap((w: { days: Array<{ date: string; totalCents: number }> }) => w.days)
      .find((d: { date: string }) => d.date === '2026-02-05');
    expect(day05.totalCents).toBe(30000);
    expect(day05Competencia.totalCents).toBe(0);
  });

  it('um valor de basis fora do contrato é recusado (400), nunca em silêncio', async () => {
    const { app } = seedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/analytics/kpis?period=custom&from=2026-01-01&to=2026-03-31&basis=caixa',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('basis é recusado nas rotas onde ele não é uma superfície (nunca reinterpretação)', async () => {
    const { app } = seedApp();
    // budget-consumption lê o budget store; net-worth-history lê fluxos mensais.
    // Nenhuma das duas é uma base de despesa (SPEC 11.1.1 lista só as 4).
    for (const path of ['/analytics/budget-consumption', '/analytics/net-worth-history']) {
      const refused = await app.inject({ method: 'GET', url: `${path}?basis=competencia`, headers: H });
      expect(refused.statusCode, path).toBe(400);
      expect(refused.json().code, path).toBe('analytics.basis_unsupported');
      // Omitir continua válido e não muda nada.
      const accepted = await get(app, path, {});
      expect(accepted.basis, path).toBe('liquidez');
    }
  });
});

describe('G03 fixture — H (G-B): o inteiro exato atravessa a resposta', () => {
  it('kpis acima de 2^53 carrega o decimal exato e marca approximate', async () => {
    const { app } = seedApp();
    const expected = expectedOf<{ totalCentsExact: string; transactionCount: number; representableAsJsDouble: boolean }>(
      'H-safe-integers',
    );
    const body = await get(app, '/analytics/kpis', queryOf('H-safe-integers'));
    // O fixture nomeia o companheiro `totalCentsExact`; no kpis o agregado se
    // chama `expenseCents`, então o companheiro na wire é `expenseCentsExact`.
    expect(body.expenseCentsExact).toBe(expected.totalCentsExact);
    expect(body.approximate).toBe(true);
    expect(body.transactionCount).toBe(expected.transactionCount);
    // O número continua na resposta (compatibilidade) e continua sendo um double
    // que NÃO representa o valor exato: por isso `approximate`.
    expect(typeof body.expenseCents).toBe('number');
    expect(Number.isSafeInteger(body.expenseCents)).toBe(false);
    expect(BigInt(expected.totalCentsExact) - BigInt(body.expenseCents)).not.toBe(0n);
  });

  it('category-breakdown acima de 2^53 carrega o decimal exato no total e no slice', async () => {
    const { app } = seedApp();
    const expected = expectedOf<{ totalCentsExact: string }>('H-safe-integers');
    const body = await get(app, '/analytics/category-breakdown', { ...queryOf('H-safe-integers'), kind: 'expense' });
    expect(body.totalCentsExact).toBe(expected.totalCentsExact);
    expect(body.approximate).toBe(true);
    const slice = body.slices.find((s: { categoryId: string }) => s.categoryId === 'cat-utilities');
    expect(slice.totalCentsExact).toBe(expected.totalCentsExact);
    expect(slice.approximate).toBe(true);
  });

  it('totais dentro do safe integer NÃO recebem marcação (a flag é por campo)', async () => {
    const { app } = seedApp();
    const body = await get(app, '/analytics/kpis', queryOf('A-competencia-vs-pagamento'));
    expect(body).not.toHaveProperty('expenseCentsExact');
    expect(body).not.toHaveProperty('approximate');
    const breakdown = await get(app, '/analytics/category-breakdown', queryOf('A-competencia-vs-pagamento'));
    expect(breakdown).not.toHaveProperty('totalCentsExact');
    expect(breakdown.slices.every((s: Record<string, unknown>) => !('approximate' in s))).toBe(true);
  });
});

describe('G03 fixture — L (G-C): envelope de prova em TODAS as 6 rotas', () => {
  const routes: Array<{ path: string; query: Record<string, string> }> = [
    { path: '/analytics/kpis', query: { period: 'custom', from: '2026-02-01', to: '2026-02-28' } },
    { path: '/analytics/cashflow-series', query: { period: 'custom', from: '2026-02-01', to: '2026-02-28' } },
    { path: '/analytics/category-breakdown', query: { period: 'custom', from: '2026-02-01', to: '2026-02-28' } },
    { path: '/analytics/budget-consumption', query: {} },
    { path: '/analytics/daily-heatmap', query: { to: '2026-02-28' } },
    { path: '/analytics/net-worth-history', query: {} },
  ];

  it('os 6 campos do envelope existem, tipados e com semanticsVersion 1', async () => {
    const { app } = seedApp();
    for (const route of routes) {
      const body = await get(app, route.path, route.query);
      for (const field of ENVELOPE_FIELDS) expect(body, `${route.path}.${field}`).toHaveProperty(field);
      expect(body.semanticsVersion, route.path).toBe('1');
      expect(typeof body.asOf, route.path).toBe('string');
      expect(body.asOf, route.path).toBe(AS_OF);
      expect(['liquidez', 'competencia'], route.path).toContain(body.basis);
      expect(Number.isInteger(body.transactionCount), route.path).toBe(true);
      expect(typeof body.effectiveFilter, route.path).toBe('object');
    }
  });

  it('transactionCount conta income+expense da janela e bate com a derivação independente', async () => {
    const { app } = seedApp();
    const query = queryOf('L-envelope-ausente');
    const kpis = await get(app, '/analytics/kpis', query);
    const all = expectedTransactionCount({ householdId: HOUSEHOLD_A, ...toRange(query) });
    expect(kpis.transactionCount).toBe(all);
    // O breakdown lê só o que TEM categoria; a linha de 9.500 de fevereiro não
    // entra nem no total nem na contagem. A divergência com o kpis é o que o
    // envelope torna visível (era o achado do caso L).
    const breakdown = await get(app, '/analytics/category-breakdown', query);
    const categorised = expectedTransactionCount({
      householdId: HOUSEHOLD_A,
      ...toRange(query),
      kind: 'expense',
      categorisedOnly: true,
    });
    expect(breakdown.transactionCount).toBe(categorised);
    expect(categorised).toBeLessThan(all);
    const series = await get(app, '/analytics/cashflow-series', query);
    expect(series.transactionCount).toBe(all);
  });

  it('o envelope declara o filtro EFETIVO, inclusive o que a rota ignora', async () => {
    const { app } = seedApp();
    const kpis = await get(app, '/analytics/kpis', { period: 'custom', from: '2026-01-01', to: '2026-01-31' });
    expect(kpis.effectiveFilter).toEqual({ period: 'custom', from: '2026-01-01', to: '2026-01-31', accountId: null });

    // daily-heatmap não aplica o preset `period`, mas a grade tem inícios e fim
    // PRÓPRIOS: a janela declarada é a janela lida (e o início declarado é a
    // primeira célula). Declarar `from: null` aqui seria mentir sobre um filtro
    // que a rota aplica - o defeito que a rodada de correção do review fechou.
    const heatmap = await get(app, '/analytics/daily-heatmap', { period: 'custom', from: '2026-01-01', to: '2026-01-31' });
    expect(heatmap.effectiveFilter).toEqual({ period: null, from: '2026-01-05', to: '2026-01-31', accountId: null });
    expect(heatmap.weeks[0].weekStart).toBe(heatmap.effectiveFilter.from);
    // budget-consumption é household-only e não filtra por período.
    const budgets = await get(app, '/analytics/budget-consumption', { period: 'custom', from: '2026-01-01', to: '2026-01-31' });
    expect(budgets.effectiveFilter).toEqual({ period: null, from: null, to: null, accountId: null });
    const breakdown = await get(app, '/analytics/category-breakdown', { period: 'custom', from: '2026-02-01', to: '2026-02-28', kind: 'income' });
    expect(breakdown.effectiveFilter).toEqual({
      period: 'custom',
      from: '2026-02-01',
      to: '2026-02-28',
      accountId: null,
      kind: 'income',
    });
  });

  it('emptyReason é conclusivo quando não há linha, e null quando há', async () => {
    const { app } = seedApp();
    const empty = await get(app, '/analytics/kpis', { period: 'custom', from: '2025-01-01', to: '2025-01-31' });
    expect(empty.transactionCount).toBe(0);
    expect(empty.expenseCents).toBe(0);
    expect(empty.emptyReason).toBe('no_transactions_in_period');
    const withData = await get(app, '/analytics/kpis', { period: 'custom', from: '2026-01-01', to: '2026-01-31' });
    expect(withData.emptyReason).toBeNull();
    // Sem orçamento no household: motivo próprio, não "sem transações".
    const budgets = await get(app, '/analytics/budget-consumption');
    expect(budgets.items).toEqual([]);
    expect(budgets.emptyReason).toBe('no_budgets');
    expect(budgets.transactionCount).toBe(0);
  });

  it('o motivo de vazio nomeia o universo certo: existe lançamento, só que sem categoria', async () => {
    const { app } = seedApp();
    // 2026-02-12 tem exatamente uma despesa, e ela é a linha SEM categoria (9.500).
    const window = { period: 'custom', from: '2026-02-12', to: '2026-02-12' };
    const kpis = await get(app, '/analytics/kpis', window);
    expect(kpis.transactionCount).toBe(1);
    expect(kpis.expenseCents).toBe(9500);
    const breakdown = await get(app, '/analytics/category-breakdown', { ...window, kind: 'expense' });
    expect(breakdown.transactionCount).toBe(0);
    expect(breakdown.totalCents).toBe(0);
    // "no_transactions_in_period" seria MENTIRA aqui: o lançamento existe.
    expect(breakdown.emptyReason).toBe('no_categorised_transactions_in_period');
  });

  it('recusa de escopo e 401 continuam recusa - nunca viram zero com envelope', async () => {
    const built = seedApp();
    // Escopo pedido e não suportado: recusa tipada, não "0 lançamentos".
    const refused = await built.app.inject({
      method: 'GET',
      url: `/analytics/budget-consumption?accountId=${crypto.randomUUID()}`,
      headers: H,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('analytics.account_scope_unsupported');
    expect(refused.json()).not.toHaveProperty('transactionCount');

    const unauthenticated = await built.app.inject({ method: 'GET', url: '/analytics/kpis' });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).not.toHaveProperty('transactionCount');

    // E o outro workspace, que TEM linhas, continua com contagem real.
    const other = await get(built.app, '/analytics/kpis', queryOf('J-dois-workspaces'), HB);
    expect(other.transactionCount).toBe(2);
    expect(other.emptyReason).toBeNull();
  });
});

/** `{ from, to }` de uma query de período, para re-derivar contagens na fixture. */
const toRange = (query: Record<string, string>): { from: string; to: string } => ({
  from: query['from'] as string,
  to: query['to'] as string,
});

describe('G03 fixture — dataset', () => {
  it('o fixture continua íntegro: 13 casos e a marca de SPIKE só muda de propósito', () => {
    // A fixture saiu do spike como evidência; o adendo 11.1 a promoveu a insumo
    // de teste. O `status` ainda diz SPIKE-EVIDENCE-NOT-WIRED porque reescrever
    // a evidência do spike invalidaria o relatório que ele produced - o fato de
    // haver um teste que a executa é o que muda, e este arquivo é a prova.
    expect(analyticsFixture.cases.length).toBeGreaterThanOrEqual(13);
    for (const id of ['F-cartao-vs-fatura', 'H-safe-integers', 'L-envelope-ausente']) {
      expect(analyticsFixture.cases.some((entry) => entry.id === id), id).toBe(true);
    }
    expect(analyticsFixture.meta.boundaryContract).toContain('INCLUSIVA');
  });
});