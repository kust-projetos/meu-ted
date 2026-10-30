/**
 * G2 relaxações autorizadas (uso pessoal, operador 29/10) — caracterização TDD.
 *
 * Escopo estrito: SOMENTE harness POC + testes. Nenhum código de produção
 * (router/executor/API writers/PWA) é tocado aqui.
 *
 * - G2b: entidade period YYYY-MM idêntica (fold exato) ao arg yearMonth NÃO
 *   emite `context-period-yearmonth-mismatch`; divergente emite e FAIL.
 * - G2c: comparação semântica de description usa fold (NFD+lowercase);
 *   API preserva casing original (prova em
 *   `apps/api/tests/routes/transactions-write.test.ts`); IDs seguem exatos.
 * - G2d: resposta anual via analytics custom (from/to ano completo + basis
 *   explícita) é critério revisado válido para "quanto gastei em 2020?"
 *   (alternativa à clarificação que pede mês/período). O oráculo histórico
 *   F1-B017 NÃO muda silenciosamente: a revisão vive em EXTENSIONS e o FAIL
 *   histórico do B0 permanece registrado.
 */
import { describe, expect, it } from 'vitest';
import { runF2A1 } from './evaluation-runner.js';
import { F2A1_LOCAL_CANDIDATES, F2A1_LOCAL_JOURNEYS } from './f2a1-candidates.js';
import { F2A1_SCENARIOS } from './f2a1-oracles.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('G2 relaxações autorizadas (uso pessoal 29/10) — RED antes do fix', () => {
  it('G2b: period YYYY-MM idêntico (fold exato) ao yearMonth não emite mismatch; divergente FAIL', () => {
    const journeys = clone(F2A1_LOCAL_JOURNEYS.J09 as readonly unknown[]) as Array<{
      interpretation: Record<string, unknown>;
    }>;
    const identicalRow = runF2A1({ journeys: { J09: journeys } }).journeys.find(
      (item) => item.comparison.corpusId === 'J09',
    )?.turns[1];
    expect(identicalRow?.verdict).toBe('PASS');
    expect(identicalRow?.contextReasons ?? []).not.toContain('context-period-yearmonth-mismatch');

    const divergent = clone(F2A1_LOCAL_JOURNEYS.J09 as readonly unknown[]) as Array<{
      interpretation: Record<string, unknown>;
    }>;
    divergent[1]!.interpretation.entities = [{ kind: 'period', value: '2026-10', provenance: 'corpus-context' }];
    const divergentRow = runF2A1({ journeys: { J09: divergent } }).journeys.find(
      (item) => item.comparison.corpusId === 'J09',
    )?.turns[1];
    expect(divergentRow?.contextBinding).toBe('mismatch');
    expect(divergentRow?.contextReasons).toContain('context-period-yearmonth-mismatch');
  });

  it('G2c: `Mercado` vs oráculo `mercado` equivale por fold; IDs divergentes continuam FAIL', () => {
    const b013 = clone(F2A1_LOCAL_CANDIDATES['F2A1-B013-catalog']) as {
      interpretation: Record<string, unknown>;
    };
    b013.interpretation.args = {
      ...(b013.interpretation.args as Record<string, unknown>),
      description: 'Mercado',
    };
    b013.interpretation.entities = [
      { kind: 'amount', value: '2500', provenance: 'utterance' },
      { kind: 'description', value: 'Mercado', provenance: 'utterance' },
    ];
    const row = runF2A1({ scenarios: { 'F2A1-B013-catalog': b013 } }).scenarios.find(
      (item) => item.corpusId === 'F2A1-B013-catalog',
    );
    expect(row?.verdict).toBe('PASS');
    expect(row?.args).toBe('match');
    expect(row?.entities).toBe('match');
    expect(row?.contextBinding).toBe('match');

    const badId = clone(F2A1_LOCAL_CANDIDATES['F2A1-B013-catalog']) as {
      interpretation: Record<string, unknown>;
    };
    badId.interpretation.args = {
      ...(badId.interpretation.args as Record<string, unknown>),
      categoryId: '99999999-0000-4000-8000-000000000099',
    };
    const badRow = runF2A1({ scenarios: { 'F2A1-B013-catalog': badId } }).scenarios.find(
      (item) => item.corpusId === 'F2A1-B013-catalog',
    );
    expect(badRow?.verdict).toBe('FAIL');
    expect(badRow?.contextReasons).toContain(
      'context-unknown-category-id:99999999-0000-4000-8000-000000000099',
    );
  });

  it('G2d: B017-annual registrada como extensão explícita; oráculo histórico intacto e FAIL B0 preservado', () => {
    expect(F2A1_SCENARIOS['F1-B017']?.clarificationRequired).toBe(true);
    expect(F2A1_SCENARIOS['F1-B017']?.expectedMissingFields).toEqual(['period']);
    const result = runF2A1({});
    const annual = result.extensions.find((item) => item.id === 'B017-annual');
    expect(annual).toBeDefined();
    expect(annual?.comparableCriterion).toContain('custom');
    expect(annual?.justification).toContain('2026-10-29');

    const b017Reproduction = {
      interpretation: {
        intent: 'read',
        operation: 'spending_insights',
        args: { period: '2020' },
        contextProvenance: { origin: 'local-fixture', corpusId: 'F1-B017' },
        entities: [{ kind: 'period', value: '2020', provenance: 'utterance' }],
        ambiguities: [],
        missingFields: [],
        clarification: null,
        requestedAction: 'spending_insights',
      },
    };
    const b0Row = runF2A1({ scenarios: { 'F1-B017': b017Reproduction } }).scenarios.find(
      (item) => item.corpusId === 'F1-B017',
    );
    expect(b0Row?.verdict).toBe('FAIL');
  });
});
