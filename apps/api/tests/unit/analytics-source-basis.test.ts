/**
 * G03 (rodada de correção do review) — `basis=competencia` no dialeto legado é
 * RECUSA TIPADA, não erro de SQL.
 *
 * `competencia` depende de `transactions.statement_payment_id` (V056), que é
 * `canonical-only` (`read-models/sql/migrate.ts:100`). `production-routes.ts`
 * monta a fonte com `legacy: true`, então um pedido VÁLIDO
 * (`basis=competencia` numa rota de despesa) estourava "column does not exist"
 * no Postgres — 500 em vez de uma recusa 400 que o cliente entende.
 *
 * A prova aqui é tripla e não usa banco:
 * 1. a recusa acontece ANTES da query (o pool registra zero chamadas);
 * 2. ela é tipada (o mesmo `code` de H-10, com mensagem honesta sobre o motivo);
 * 3. `liquidez` — o DEFAULT — continua funcionando no legado, byte a byte.
 */

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createSqlAnalyticsSource,
  householdScope,
  type AnalyticsSource,
  type StoreBackedDeps,
} from '../../src/analytics/source.js';
import { registerAnalyticsRoutes } from '../../src/routes/analytics.js';
import { createInMemoryReadModelStore } from '../../src/read-models/store.js';
import { createInMemoryCardStore } from '../../src/cards/in-memory.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { fixtureAccounts, fixtureCategories } from '../fixtures/analytics-semantics-dataset.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';

const CLOCK = () => new Date('2026-09-07T12:00:00.000Z');
const TOKEN = 'g03-fix2-token';

/**
 * Pool stub: registra o SQL recebido e devolve agregados vazios. Se uma
 * consulta com `statement_payment_id` chegar aqui, o teste falha — que é
 * exatamente o que a recusa antecipada precisa garantir.
 */
const stubPool = () => {
  const queries: string[] = [];
  return {
    queries,
    query: async (text: string) => {
      queries.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
};

const stores = (): StoreBackedDeps => {
  const accounts = fixtureAccounts();
  const categories = fixtureCategories();
  const { state } = createInMemoryStores({ accounts, categories, transactions: [] });
  return {
    store: createInMemoryReadModelStore({ accounts, categories }),
    cardStore: createInMemoryCardStore(state),
  };
};

const appFor = async (source: AnalyticsSource): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  registerAnalyticsRoutes(app, {
    source,
    resolveToken: async (token: string | undefined) => {
      if (token !== TOKEN) throw Object.assign(new Error('invalid'), { statusCode: 401, code: 'auth.invalid_token' });
      return { deviceId: 'fix2-device', householdId: HOUSEHOLD_A, userId: null };
    },
    clock: CLOCK,
  });
  await app.ready();
  return app;
};

const H = { 'x-device-token': TOKEN, 'content-type': 'application/json' };

/** As três leituras de despesa que aceitam `basis`. */
const EXPENSE_READS: Array<(source: AnalyticsSource) => Promise<unknown>> = [
  (source) => source.sumByKind(HOUSEHOLD_A, '2026-01-01', '2026-03-31', householdScope(), { basis: 'competencia' }),
  (source) => source.dailySums(HOUSEHOLD_A, '2026-01-01', '2026-03-31', householdScope(), { basis: 'competencia' }),
  (source) =>
    source.categorySums(HOUSEHOLD_A, '2026-01-01', '2026-03-31', 'expense', householdScope(), { basis: 'competencia' }),
];

describe('FIX 2 (fonte): a fonte declara se `competencia` existe no seu dialeto', () => {
  it('legado declara indisponível e recusa ANTES de qualquer query', async () => {
    const pool = stubPool();
    const source = createSqlAnalyticsSource(pool, { legacy: true, stores: stores() });
    expect(source.competenciaBasis).toBe('unavailable');

    for (const read of EXPENSE_READS) {
      await expect(read(source)).rejects.toMatchObject({
        statusCode: 400,
        code: 'analytics.basis_unsupported',
      });
    }
    // Nenhum SQL foi montado: a coluna que não existe nunca chegou ao banco.
    expect(pool.queries).toEqual([]);
  });

  it('canônico declara disponível e o predicado V056 entra no SQL', async () => {
    const pool = stubPool();
    const source = createSqlAnalyticsSource(pool, { stores: stores() });
    expect(source.competenciaBasis).toBe('available');

    await source.sumByKind(HOUSEHOLD_A, '2026-01-01', '2026-03-31', householdScope(), { basis: 'competencia' });
    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0]).toMatch(/statement_payment_id IS NULL/);
  });

  it('legado com liquidez (DEFAULT) continua consultando e respondendo', async () => {
    const pool = stubPool();
    const source = createSqlAnalyticsSource(pool, { legacy: true, stores: stores() });

    const sum = await source.sumByKind(HOUSEHOLD_A, '2026-01-01', '2026-03-31', householdScope());
    expect(sum).toEqual({ income: { cents: 0 }, expense: { cents: 0 }, transactionCount: 0 });
    expect(pool.queries).toHaveLength(1);
    // O default não carrega predicado nenhum (o SQL de liquidez é o de sempre).
    expect(pool.queries[0]).not.toMatch(/statement_payment_id/);
  });
});

describe('FIX 2 (rota): o cliente recebe 400 tipado, nunca 500 de coluna', () => {
  it('as 4 rotas de despesa recusam `competencia` no legado com o código de H-10', async () => {
    const pool = stubPool();
    const app = await appFor(createSqlAnalyticsSource(pool, { legacy: true, stores: stores() }));
    try {
      for (const path of [
        '/analytics/kpis',
        '/analytics/cashflow-series',
        '/analytics/category-breakdown',
        '/analytics/daily-heatmap',
      ]) {
        const refused = await app.inject({ method: 'GET', url: `${path}?basis=competencia`, headers: H });
        expect(refused.statusCode, path).toBe(400);
        expect(refused.json().code, path).toBe('analytics.basis_unsupported');
        // A recusa não é um "zero" nem um envelope: é erro.
        expect(refused.json(), path).not.toHaveProperty('transactionCount');
        // E a mensagem diz o motivo real (dialeto legado), não "não se aplica".
        expect(refused.json().message, path).toMatch(/legacy/i);
      }
      // Nenhuma consulta foi tentada: a recusa precede o SQL.
      expect(pool.queries).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('liquidizade (default) e `liquidez` explícito seguem 200 no legado', async () => {
    const pool = stubPool();
    const app = await appFor(createSqlAnalyticsSource(pool, { legacy: true, stores: stores() }));
    try {
      const omitted = await app.inject({ method: 'GET', url: '/analytics/kpis', headers: H });
      expect(omitted.statusCode).toBe(200);
      expect(omitted.json().basis).toBe('liquidez');
      expect(pool.queries.length).toBeGreaterThan(0);

      const explicit = await app.inject({ method: 'GET', url: '/analytics/kpis?basis=liquidez', headers: H });
      expect(explicit.statusCode).toBe(200);
      expect(explicit.json().basis).toBe('liquidez');
    } finally {
      await app.close();
    }
  });
});