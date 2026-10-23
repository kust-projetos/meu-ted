/**
 * Round3 HIGH: preflight puro do harness de validação PG.
 *
 * A suíte PG só pode tocar as duas bases descartáveis desta validação, e o
 * guard (marker pré-existente via requireTestDatabase) deve passar ANTES de
 * qualquer escrita/migration/schema/cleanup. Nenhum provisionamento
 * automático (sem CREATE DATABASE, sem criar marker): este módulo é puro
 * (sem I/O) e rejeita URL arbitrária antes de qualquer pool/conexão.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  VALIDATION_DATABASE_NAME,
  VALIDATION_LEGACY_DATABASE_NAME,
  assertValidationDatabaseUrl,
  createValidationPools,
  prepareValidationDatabases,
  validationCompanionUrl,
} from '../../src/db/validation-preflight.js';

const GOOD = 'postgresql://127.0.0.1:5433/ted_validation_20261021';
const GOOD_LOCALHOST = 'postgresql://localhost:5433/ted_validation_20261021';

describe('round3 HIGH: preflight da URL de validação (puro, sem I/O)', () => {
  it('aceita a base exata em 127.0.0.1:5433', () => {
    expect(assertValidationDatabaseUrl(GOOD).database).toBe('ted_validation_20261021');
  });

  it('aceita a forma localhost:5433', () => {
    expect(assertValidationDatabaseUrl(GOOD_LOCALHOST).database).toBe('ted_validation_20261021');
  });

  it.each([
    ['ted_local (browser)', 'postgresql://127.0.0.1:5433/ted_local'],
    ['outro banco', 'postgresql://127.0.0.1:5433/outro_banco'],
    ['prefixo do nome', 'postgresql://127.0.0.1:5433/ted_validation_20261021_x'],
    ['outro host', 'postgresql://192.168.1.10:5433/ted_validation_20261021'],
    ['hostname público', 'postgresql://db.example.com:5433/ted_validation_20261021'],
    ['sufixo malicioso', 'postgresql://localhost.evil.com:5433/ted_validation_20261021'],
    ['outra porta', 'postgresql://127.0.0.1:5432/ted_validation_20261021'],
    ['sem porta', 'postgresql://127.0.0.1/ted_validation_20261021'],
    ['protocolo estranho', 'mysql://127.0.0.1:5433/ted_validation_20261021'],
    ['lixo', 'not-a-url'],
    ['vazio', ''],
  ])('rejeita %s', (_label, url) => {
    expect(() => assertValidationDatabaseUrl(url)).toThrow();
  });

  it('companion é o nome EXATO, nunca derivado de URL arbitrária', () => {
    expect(validationCompanionUrl(GOOD)).toBe(
      'postgresql://127.0.0.1:5433/ted_validation_20261021_legacy',
    );
    expect(validationCompanionUrl(GOOD)).toContain(`/${VALIDATION_LEGACY_DATABASE_NAME}`);
    expect(VALIDATION_DATABASE_NAME).toBe('ted_validation_20261021');
    // Base arbitrária nunca gera companion: rejeita antes de derivar.
    expect(() => validationCompanionUrl('postgresql://x@db.example.com:5433/ted_local')).toThrow();
  });

  it.each([
    ['override de host via query (pg-connection-string prioriza ?host=)', `${GOOD}?host=db.example.com`],
    ['override de porta via query', `${GOOD}?port=5432`],
    ['socket via query', `${GOOD}?host=/var/run/postgresql/.s.PGSQL.5432`],
    ['override de database via query', `${GOOD}?dbname=ted_local`],
    ['opção via query', `${GOOD}?sslmode=require`],
    ['timeout via query', `${GOOD}?connect_timeout=5`],
    ['query vazia com ?', `${GOOD}?`],
    ['hash', `${GOOD}#fragmento`],
    ['hash após query', `${GOOD}?sslmode=require#x`],
  ])('rejeita %s antes de qualquer pool', (_label, url) => {
    const factory = vi.fn((cs: string) => ({ connectionString: cs }));
    expect(() => assertValidationDatabaseUrl(url)).toThrow();
    expect(() =>
      createValidationPools({ baseUrl: url, createPool: factory as never }),
    ).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it('companion nunca carrega query nem hash', () => {
    const companion = validationCompanionUrl(GOOD);
    expect(companion).not.toContain('?');
    expect(companion).not.toContain('#');
  });

  it('URL rejeitada nunca cria pool/conexão (prova nenhum write)', () => {
    const factory = vi.fn((cs: string) => ({ connectionString: cs }));
    expect(() =>
      createValidationPools({
        baseUrl: 'postgresql://127.0.0.1:5433/ted_local',
        createPool: factory as never,
      }),
    ).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it('URL válida cria exatamente os dois pools nas bases exatas', () => {
    const factory = vi.fn((cs: string) => ({ connectionString: cs }));
    const pools = createValidationPools({ baseUrl: GOOD, createPool: factory as never });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenNthCalledWith(1, GOOD);
    expect(factory).toHaveBeenNthCalledWith(
      2,
      'postgresql://127.0.0.1:5433/ted_validation_20261021_legacy',
    );
    expect(pools).toHaveProperty('main');
    expect(pools).toHaveProperty('legacy');
  });
});

describe('round4 MEDIUM: guards antes de qualquer write (fakes, sem PG)', () => {
  const WRITE_RE = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i;

  const fakePool = (queries: string[]) => ({
    query: async (text: string) => {
      queries.push(text);
      return { rows: [{ marker_value: 'm' }], rowCount: 1 };
    },
  });

  const harness = (opts: { failMain?: boolean; failLegacy?: boolean }) => {
    const queriesMain: string[] = [];
    const queriesLegacy: string[] = [];
    const calls: string[] = [];
    const main = fakePool(queriesMain);
    const legacy = fakePool(queriesLegacy);
    return {
      queriesMain,
      queriesLegacy,
      calls,
      createPool: (cs: string) => {
        calls.push(`pool:${cs}`);
        return cs.includes('legacy') ? legacy : main;
      },
      requireGuard: async (pool: unknown, operation: string) => {
        calls.push(`guard:${operation}`);
        await (pool as { query: (t: string) => Promise<unknown> }).query(
          'SELECT marker_value FROM _test_marker LIMIT 1',
        );
        if (opts.failMain && operation === 'validation-main') throw new Error('guard-main-refused');
        if (opts.failLegacy && operation === 'validation-legacy') throw new Error('guard-legacy-refused');
      },
      migrate: async (pool: unknown) => {
        calls.push(`migrate:${pool === legacy ? 'legacy' : 'main'}`);
      },
    };
  };

  it('ordem: guard-main, guard-legacy, migrate-main, migrate-legacy', async () => {
    const h = harness({});
    const pools = await prepareValidationDatabases({
      baseUrl: GOOD,
      createPool: h.createPool as never,
      requireGuard: h.requireGuard,
      migrate: h.migrate,
    });
    expect(h.calls).toEqual([
      expect.stringMatching(/^pool:postgresql:\/\/[^/]+\/ted_validation_20261021$/),
      expect.stringMatching(/^pool:postgresql:\/\/[^/]+\/ted_validation_20261021_legacy$/),
      'guard:validation-main',
      'guard:validation-legacy',
      'migrate:main',
      'migrate:legacy',
    ]);
    expect(pools).toHaveProperty('main');
    expect(pools).toHaveProperty('legacy');
  });

  it('segundo guard falha → zero migrations e zero writes (só SELECTs do guard)', async () => {
    const h = harness({ failLegacy: true });
    await expect(
      prepareValidationDatabases({
        baseUrl: GOOD,
        createPool: h.createPool as never,
        requireGuard: h.requireGuard,
        migrate: h.migrate,
      }),
    ).rejects.toThrow('guard-legacy-refused');
    expect(h.calls).not.toContain('migrate:main');
    expect(h.calls).not.toContain('migrate:legacy');
    for (const q of [...h.queriesMain, ...h.queriesLegacy]) {
      expect(q).not.toMatch(WRITE_RE);
    }
  });

  it('primeiro guard falha → nada além da tentativa de guard', async () => {
    const h = harness({ failMain: true });
    await expect(
      prepareValidationDatabases({
        baseUrl: GOOD,
        createPool: h.createPool as never,
        requireGuard: h.requireGuard,
        migrate: h.migrate,
      }),
    ).rejects.toThrow('guard-main-refused');
    expect(h.calls).not.toContain('guard:validation-legacy');
    expect(h.calls).not.toContain('migrate:main');
  });
});
