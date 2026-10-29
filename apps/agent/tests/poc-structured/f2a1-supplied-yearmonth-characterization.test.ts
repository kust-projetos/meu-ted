/**
 * F1-B036 + J09 supplied-yearMonth characterization — strict offline, no inference.
 *
 * Scope (delegated): F1-B036 and J09 T1/T2 only.
 *
 * Lacuna documentada (não regra universal):
 * - os valores `yearMonth` (`2026-10` / `2026-09`) são DERIVADOS de
 *   `suppliedValues` (`currentYearMonth` / `previousYearMonth`) + `referenceDate`,
 *   NÃO texto literal do turno;
 * - o oráculo F2A1 exige `entities: [{ kind:'period', provenance:'utterance' }]`;
 * - o binder (`checkContextBinding` em `evaluation-runner.ts`) aceita o ARG
 *   `yearMonth` quando há evidência declarada (valores/texto/histórico/data) e
 *   NÃO valida entidades `period` — `utterance` é `continue` (pula) e `period`
 *   com outra proveniência sequer tem checagem (só `account`/`category` têm).
 *
 * Garantias:
 * - Offline: só parser puro (`parseStructuredLLMOutput`) + runner puro
 *   (`runF2A1`). Sem provider, fetch, credencial, inferência ou evidência real.
 * - NÃO altera parser, lógica, oráculos, inferência nem evidências: lê
 *   `F2A1_INPUTS` / `F2A1_SCENARIOS` / `F2A1_JOURNEYS` / `F2A1_LOCAL_*`
 *   read-only; reproduções sintéticas são inline (formas B0 reais transcritas
 *   como síntese, sem copiar envelope/prompt de diretório gitignored).
 * - Asserts comportamentais independentes (fold/texto/valores/runner) — cada
 *   `it` prova uma faceta sem presumir as demais.
 * - NÃO afirma regra universal ("todo derivado deveria ser corpus-context",
 *   "binder deveria validar período", comportamento de produção, API): apenas
 *   caracteriza o descompasso observável nos três casos.
 */
import { describe, expect, it } from 'vitest';
import { parseStructuredLLMOutput } from '../../src/poc-structured/structured-interpretation.js';
import { runF2A1 } from './evaluation-runner.js';
import { F2A1_LOCAL_CANDIDATES, F2A1_LOCAL_JOURNEYS } from './f2a1-candidates.js';
import { F2A1_INPUTS } from './f2a1-inputs.js';
import { F2A1_JOURNEYS, F2A1_SCENARIOS } from './f2a1-oracles.js';

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Reprodução sintética de forma B0 real (J09:T2, campanha 2026-10-29, lida
// read-only; envelope/prompt excluídos): `get_month_summary` com `period`
// (NÃO `yearMonth`), entidade `period` com proveniência NÃO-utterance.
// Aqui instanciada para os três casos como variante `corpus-context` com o
// valor CORRETO — isola proveniência sem misturar erro de valor/chave.
const b0StyleProvenanceMismatch = (
  corpusId: 'F1-B036' | 'J09',
  turnIndex: number | undefined,
  yearMonth: string,
) => ({
  interpretation: {
    intent: 'read',
    operation: 'get_month_summary',
    args: { yearMonth },
    contextProvenance:
      turnIndex === undefined
        ? { origin: 'f1-corpus-text', corpusId }
        : { origin: 'f1-journey-turn', corpusId, turnIndex },
    entities: [{ kind: 'period', value: yearMonth, provenance: 'corpus-context' }],
    ambiguities: [],
    missingFields: [],
    clarification: null,
  },
});

describe('F1-B036 + J09 supplied-yearMonth — caracterização offline (lacuna, sem regra universal)', () => {
  it('valores yearMonth são derivados de suppliedValues, não texto literal', () => {
    const b036 = F2A1_INPUTS['F1-B036']!;
    const j09t1 = F2A1_INPUTS['J09:T1']!;
    const j09t2 = F2A1_INPUTS['J09:T2']!;

    // Textos literais NÃO contêm o yearMonth.
    expect(fold(b036.currentText)).not.toContain('2026-10');
    expect(fold(j09t1.currentText)).not.toContain('2026-10');
    expect(fold(j09t2.currentText)).not.toContain('2026-09');
    for (const entry of j09t2.history) {
      expect(fold(entry.text)).not.toContain('2026-09');
    }

    // Valores deriváveis estão em suppliedValues (+ referenceDate congelada).
    expect(b036.suppliedValues).toMatchObject({ currentYearMonth: '2026-10' });
    expect(j09t1.suppliedValues).toMatchObject({ currentYearMonth: '2026-10' });
    expect(j09t2.suppliedValues).toMatchObject({
      currentYearMonth: '2026-10',
      previousYearMonth: '2026-09',
    });
    expect(b036.referenceDate).toBe('2026-10-24');
    // Independente: a data de referência evidencia o mês corrente, não o anterior.
    expect(fold(j09t1.referenceDate)).toContain('2026-10');
    expect(fold(j09t2.referenceDate)).not.toContain('2026-09');

    // Oráculo exige o valor nos args nos três casos.
    expect(F2A1_SCENARIOS['F1-B036']?.expectedArgs).toMatchObject({ yearMonth: '2026-10' });
    expect(F2A1_JOURNEYS.J09?.[0]?.expectedArgs).toMatchObject({ yearMonth: '2026-10' });
    expect(F2A1_JOURNEYS.J09?.[1]?.expectedArgs).toMatchObject({ yearMonth: '2026-09' });
  });

  it('oráculo espera proveniência utterance para o período derivado', () => {
    expect(F2A1_SCENARIOS['F1-B036']?.expectedEntities).toEqual([
      { kind: 'period', value: '2026-10', provenance: 'utterance' },
    ]);
    expect(F2A1_JOURNEYS.J09?.[0]?.expectedEntities).toEqual([
      { kind: 'period', value: '2026-10', provenance: 'utterance' },
    ]);
    expect(F2A1_JOURNEYS.J09?.[1]?.expectedEntities).toEqual([
      { kind: 'period', value: '2026-09', provenance: 'utterance' },
    ]);
  });

  it('binder aceita os args yearMonth derivados (match) nos três casos locais', () => {
    const b036Parsed = parseStructuredLLMOutput(clone(F2A1_LOCAL_CANDIDATES['F1-B036']));
    expect(b036Parsed.operation).toBe('get_month_summary');
    expect(b036Parsed.args).toMatchObject({ yearMonth: '2026-10' });

    const result = runF2A1({
      scenarios: F2A1_LOCAL_CANDIDATES,
      journeys: F2A1_LOCAL_JOURNEYS,
    });
    const b036Row = result.scenarios.find((row) => row.corpusId === 'F1-B036');
    expect(b036Row?.verdict).toBe('PASS');
    expect(b036Row?.args).toBe('match');
    expect(b036Row?.entities).toBe('match');
    expect(b036Row?.contextBinding).toBe('match');
    expect(b036Row?.contextReasons).not.toContain('context-unevidenced-arg:yearMonth');

    const j09 = result.journeys.find((item) => item.comparison.corpusId === 'J09');
    expect(j09?.semanticVerdict).toBe('PASS');
    expect(j09?.turns).toHaveLength(2);
    for (const [index, want] of (['2026-10', '2026-09'] as const).entries()) {
      const turn = j09?.turns[index];
      expect(turn?.verdict).toBe('PASS');
      expect(turn?.args).toBe('match');
      expect(turn?.inputContext?.suppliedValues).toMatchObject(
        index === 0 ? { currentYearMonth: want } : { previousYearMonth: want },
      );
      expect(turn?.contextBinding).toBe('match');
      expect(turn?.contextReasons).not.toContain('context-unevidenced-arg:yearMonth');
    }
  });

  it('binder não valida entidade period com proveniência utterance (oráculo sim)', () => {
    // Args corretos, entidade utterance com valor divergente: o binder ignora
    // entidades utterance (`continue`) e não tem checagem para `period`.
    const good = clone(
      F2A1_LOCAL_CANDIDATES['F1-B036'],
    ) as { interpretation: Record<string, unknown> };
    const divergent = clone(good);
    divergent.interpretation = {
      ...good.interpretation,
      entities: [{ kind: 'period', value: '1999-01', provenance: 'utterance' }],
    };
    expect(() => parseStructuredLLMOutput(divergent)).not.toThrow();

    const row = runF2A1({ scenarios: { 'F1-B036': divergent } }).scenarios.find(
      (item) => item.corpusId === 'F1-B036',
    );
    expect(row?.entities).toBe('mismatch');
    expect(row?.verdict).toBe('FAIL');
    // Binder continua match: nenhuma razão de entidade/arg é emitida.
    expect(row?.contextBinding).toBe('match');
    expect(row?.contextReasons).not.toContain('context-unevidenced-arg:yearMonth');
    expect(row?.contextReasons.filter((reason) => reason.startsWith('context-unknown'))).toEqual(
      [],
    );
    // Oráculo inalterado: continua exigindo utterance 2026-10.
    expect(F2A1_SCENARIOS['F1-B036']?.expectedEntities).toEqual([
      { kind: 'period', value: '2026-10', provenance: 'utterance' },
    ]);
  });

  it('forma estilo-B0 com proveniência corpus-context: args match, entidades mismatch, binder match', () => {
    // F1-B036 sintético estilo-B0 (valor correto, proveniência não-utterance).
    const b036B0 = b0StyleProvenanceMismatch('F1-B036', undefined, '2026-10');
    expect(() => parseStructuredLLMOutput(clone(b036B0))).not.toThrow();
    const b036Row = runF2A1({ scenarios: { 'F1-B036': b036B0 } }).scenarios.find(
      (item) => item.corpusId === 'F1-B036',
    );
    expect(b036Row?.args).toBe('match');
    expect(b036Row?.entities).toBe('mismatch');
    expect(b036Row?.verdict).toBe('FAIL');
    expect(b036Row?.contextBinding).toBe('match');

    // J09:T1 estilo-B0 (outro turno preservado como local bom).
    const j09Good = clone(F2A1_LOCAL_JOURNEYS.J09 as readonly unknown[]);
    const t1B0 = b0StyleProvenanceMismatch('J09', 0, '2026-10');
    expect(() => parseStructuredLLMOutput(clone(t1B0))).not.toThrow();
    const t1Result = runF2A1({ journeys: { J09: [t1B0, j09Good[1]] } });
    const t1Journey = t1Result.journeys.find((item) => item.comparison.corpusId === 'J09');
    expect(t1Journey?.turns[0]?.args).toBe('match');
    expect(t1Journey?.turns[0]?.entities).toBe('mismatch');
    expect(t1Journey?.turns[0]?.verdict).toBe('FAIL');
    expect(t1Journey?.turns[0]?.contextBinding).toBe('match');
    expect(t1Journey?.turns[1]?.verdict).toBe('PASS');

    // J09:T2 estilo-B0 (espelha a forma B0 real `period/corpus-context` com a
    // chave corrigida para `yearMonth`, isolando só a proveniência).
    const t2B0 = b0StyleProvenanceMismatch('J09', 1, '2026-09');
    expect(() => parseStructuredLLMOutput(clone(t2B0))).not.toThrow();
    const t2Result = runF2A1({ journeys: { J09: [j09Good[0], t2B0] } });
    const t2Journey = t2Result.journeys.find((item) => item.comparison.corpusId === 'J09');
    expect(t2Journey?.turns[1]?.args).toBe('match');
    expect(t2Journey?.turns[1]?.entities).toBe('mismatch');
    expect(t2Journey?.turns[1]?.verdict).toBe('FAIL');
    expect(t2Journey?.turns[1]?.contextBinding).toBe('match');
    expect(t2Journey?.turns[0]?.verdict).toBe('PASS');
  });
});
