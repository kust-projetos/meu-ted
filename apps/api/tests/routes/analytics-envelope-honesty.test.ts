/**
 * G03 (rodada de correção do review) — o envelope declara a janela REAL.
 *
 * O review encontrou duas afirmações que a rota fazia e que a leitura não
 * cumpria:
 *
 * 1. `net-worth-history` declarava `effectiveFilter.to = today`, mas a leitura
 *    de fluxos mensais (`monthlyFlows`, store E SQL) filtra **apenas o início**
 *    — não existe limite superior. Um lançamento futuro entra na contagem, e a
 *    janela declarada mentia sobre ele.
 * 2. `daily-heatmap` aplicava o início em `end - 34 dias` e declarava
 *    `from: null`; além disso a contagem incluía linhas que a grade 4x7
 *    descarta (`buildDailyHeatmap` recorta em `gridStart`), o que permite um
 *    envelope com "células todas zeradas e `emptyReason: null`".
 *
 * Aqui a prova é a COERÊNCIA: o que o envelope declara é exatamente o universo
 * que a leitura consumiu, e a contagem bate com a derivação independente do
 * dataset (`expectedTransactionCount`).
 *
 * Backend: store in-memory pelas rotas reais, sobre o MESMO dataset do fixture
 * G03 — nada de mock: o defeito era da combinação rota+envelope.
 */

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Transaction } from '../../src/types/domain.js';
import { buildTestApp, TOKEN_A } from '../test-app.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';
import {
  expectedTransactionCount,
  fixtureAccounts,
  fixtureCategories,
  fixtureSoftDeletedIds,
  fixtureTransactions,
} from '../fixtures/analytics-semantics-dataset.js';

const CLOCK = () => new Date('2026-09-07T12:00:00.000Z');
const H = { 'x-device-token': TOKEN_A, 'content-type': 'application/json' };

/** `2026-12-01` é FUTURO em relação ao clock (2026-09-07) e ao dataset. */
const FUTURE_ROW: Transaction = {
  id: 'tx-honestidade-futuro',
  householdId: HOUSEHOLD_A,
  kind: 'expense',
  description: 'Lançamento com data futura',
  amountCents: 1234,
  date: '2026-12-01',
  accountId: 'acc-a-bank',
  categoryId: 'cat-food',
};

const seed = (extra: Transaction[] = []) => {
  const built = buildTestApp(
    {
      accounts: fixtureAccounts(),
      categories: fixtureCategories(),
      transactions: [...fixtureTransactions(), ...extra],
    },
    CLOCK,
  );
  // Soft-delete is a tombstone set in the in-memory state and the read store
  // holds the SAME Set instance, so filling it after boot is enough — without
  // this the app would still serve the two undone rows the dataset marks.
  for (const id of fixtureSoftDeletedIds()) built.state.deletedTransactions.add(id);
  return built;
};

const get = async (
  app: FastifyInstance,
  path: string,
  query: Record<string, string> = {},
): Promise<Record<string, any>> => {
  const search = new URLSearchParams(query).toString();
  const res = await app.inject({ method: 'GET', url: search ? `${path}?${search}` : path, headers: H });
  expect(res.statusCode, `${path} ${search}`).toBe(200);
  return res.json() as Record<string, any>;
};

describe('FIX 1 (heatmap): a grade e a janela declarada são a mesma coisa', () => {
  it('a janela declarada é a grade, e a contagem é o universo que a grade considera', async () => {
    const { app } = seed();
    const heatmap = await get(app, '/analytics/daily-heatmap', { to: '2026-02-05' });

    // O início declarado É a primeira célula da grade: uma janela, não duas.
    expect(heatmap.weeks[0].weekStart).toBe(heatmap.effectiveFilter.from);
    expect(heatmap.effectiveFilter.to).toBe('2026-02-05');
    // `period` continua declarado como não aplicado: a grade não usa preset.
    expect(heatmap.effectiveFilter.period).toBeNull();

    // A contagem é a derivação independente sobre a janela DECLARADA.
    const declared = expectedTransactionCount({
      householdId: HOUSEHOLD_A,
      from: heatmap.effectiveFilter.from,
      to: heatmap.effectiveFilter.to,
    });
    expect(heatmap.transactionCount).toBe(declared);
  });

  it('linha anterior ao início da grade não entra na contagem (era contada e não pintava célula)', async () => {
    const { app } = seed();
    const heatmap = await get(app, '/analytics/daily-heatmap', { to: '2026-02-05' });

    // O dataset tem uma receita em 2026-01-05: dentro da antiga janela de 35
    // dias (`end - 34`), mas ANTES do início da grade.
    const preGrid = fixtureTransactions().find((row) => row.id === 'tx-a-inc-2026-01');
    expect(preGrid?.date).toBe('2026-01-05');
    expect(preGrid!.date < heatmap.effectiveFilter.from).toBe(true);

    // Contar a janela antiga prova o defeito: ela é MAIOR porque inclui a linha
    // que a grade descarta. Depois da correção, o envelope e a grade contam a
    // mesma coisa.
    const oldWindowCount = expectedTransactionCount({
      householdId: HOUSEHOLD_A,
      from: '2026-01-02',
      to: '2026-02-05',
    });
    expect(oldWindowCount).toBeGreaterThan(heatmap.transactionCount);
    expect(heatmap.transactionCount).toBe(
      expectedTransactionCount({ householdId: HOUSEHOLD_A, from: heatmap.effectiveFilter.from, to: '2026-02-05' }),
    );
  });
});

describe('FIX 1 (net-worth-history): a janela sem limite superior não se declara fechada', () => {
  it('effectiveFilter.to é null quando a leitura de fluxos não filtra o fim', async () => {
    const { app } = seed([FUTURE_ROW]);
    const netWorth = await get(app, '/analytics/net-worth-history');

    // `monthlyFlows` filtra só `date >= since-01`: não há `to` aplicado, então
    // declarar `today` seria afirmar um filtro que a fonte nunca fez.
    expect(netWorth.effectiveFilter.to).toBeNull();
    expect(netWorth.effectiveFilter.from).toBe('2025-10-01');

    // E o `null` é NECESSÁRIO, não cosmético: o lançamento futuro está de fato
    // no universo lido (a leitura é aberta à direita).
    const closedWindowCount = expectedTransactionCount({
      householdId: HOUSEHOLD_A,
      from: '2025-10-01',
      to: '2026-09-07',
    });
    expect(netWorth.transactionCount).toBe(closedWindowCount + 1);
  });

  it('rotas que filtram `to` de verdade continuam provando que filtram', async () => {
    const { app } = seed([FUTURE_ROW]);

    // Janela pedida que CONTÉM o futuro: entra, e a janela declarada é a
    // pedida — o envelope afirma exatamente o filtro aplicado.
    const custom = await get(app, '/analytics/kpis', { period: 'custom', from: '2026-12-01', to: '2026-12-31' });
    expect(custom.effectiveFilter.to).toBe('2026-12-31');
    expect(custom.expenseCents).toBe(FUTURE_ROW.amountCents);
    expect(custom.transactionCount).toBe(1);

    // Preset (to = hoje, 2026-09-07): o futuro fica de fora, porque `to` é
    // declarado E aplicado. É a diferença entre as duas rotas acima.
    const preset = await get(app, '/analytics/kpis');
    expect(preset.effectiveFilter.to).toBe('2026-09-07');
    expect(preset.transactionCount).toBe(0);
    expect(preset.emptyReason).toBe('no_transactions_in_period');

    // O heatmap também declara e aplica `to`.
    const heatmap = await get(app, '/analytics/daily-heatmap');
    expect(heatmap.effectiveFilter.to).toBe('2026-09-07');
    expect(heatmap.transactionCount).toBe(0);
  });
});