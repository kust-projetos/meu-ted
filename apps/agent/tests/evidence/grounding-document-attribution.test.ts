import { describe, expect, it } from 'vitest';
import { validateGroundedClaims } from '../../src/evidence/grounding-validator.js';
import { createGroundedResponseWithRetry } from '../../src/responses/grounded-response.js';
import { renderVisionFields } from '../../src/multimodal/groq-vision.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

/**
 * V1-GROUND-ATTRIBUTION: attachment-only monetary support is admitted only on
 * POSITIVE EXPLICIT ATTRIBUTION — the reply must say the document reports the
 * figure. The previous rule was a deny-list of registered-state words alone,
 * which is not provenance: "A fatura é R$ 42,50 na Conta principal" names no
 * registered marker, yet it presents the figure as workspace state, and a
 * document can never prove that.
 *
 * The deny-list stays as ADDITIONAL defense and WINS: a sentence that both
 * attributes and asserts registered state ("O documento informa que seu saldo
 * registrado é R$ 42,50") still fails closed.
 *
 * The boundary is the SAME on the percent axis, and figure-free claims
 * (dates, names) keep their existing document support untouched.
 */

const envelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'api.balance', retrievedAt: '2026-10-09T12:00:00Z', status: 'ok', data }],
});

/** The account name always travels as evidence, so name claims never mask a money assertion. */
const withName = (data: unknown): EvidenceEnvelope => envelope({ accountName: 'Conta principal', ...(data as Record<string, unknown>) });

/** Live attachment-turn shape: no usable finance rows in the tool envelope. */
const EMPTY_TOOLS = envelope([]);
const BLOCK_42_50 = ['dados extraidos do anexo: valor 42,50 R$ vencimento 2026-10-09'];
const BLOCK_PERCENT = ['taxa de juros: 12,5%'];

describe('V1-GROUND-ATTRIBUTION: document-only money needs positive attribution', () => {
  it('ACCEPTS money explicitly attributed to the document', () => {
    expect(validateGroundedClaims('O documento informa R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('No anexo consta R$42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('Segundo o documento, o total é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('De acordo com o anexo, o valor é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('O valor no documento é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    // Compound relations are natural pt-BR and stay attributed.
    expect(validateGroundedClaims('Conforme consta no documento, a fatura é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('Como mostra o PDF, o valor é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('Pelos dados do anexo, o total é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    // The attribution itself may span a line break (a labelled block renders so).
    expect(validateGroundedClaims('O documento informa:\nR$ 42,50', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
  });

  it('REJECTS unattributed document money, with no registered marker anywhere', () => {
    // The deny-list alone cannot decide this: nothing here asserts registered
    // state, and the document still must not prove the workspace's figures.
    const unattributed = [
      'A fatura é R$ 42,50 na Conta principal.',
      'O total é R$ 42,50.',
      'O saldo da sua conta:\nR$42,50',
      'Resumo\nO total\nR$42,50',
    ];
    for (const text of unattributed) {
      const result = validateGroundedClaims(text, EMPTY_TOOLS, BLOCK_42_50);
      expect(result.valid).toBe(false);
      expect(result.counts.money).toBeGreaterThanOrEqual(1);
    }
  });

  it('REJECTS an attributed claim whose figure is absent from the block', () => {
    expect(validateGroundedClaims('O documento informa R$ 88,88.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(false);
  });

  it('REJECTS a negated attribution (the figure is claimed as NOT reported)', () => {
    // "informa" only counts when the relation is affirmative: a document noun
    // followed by a negation is not attribution, and the claim fails closed.
    expect(validateGroundedClaims('O documento não informa R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(false);
  });

  it('never false-accepts when the SAME sentence also asserts registered state', () => {
    // Defense in depth: the deny-list WINS over the positive attribution.
    expect(validateGroundedClaims('O documento informa que seu saldo registrado é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(false);
    expect(validateGroundedClaims('Segundo o anexo, seu saldo atual é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(false);
    expect(validateGroundedClaims('O documento informa que a despesa lançada é R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(false);
  });

  it('keeps authoritative API money grounding the same claim with NO document attribution', () => {
    // Backend evidence is authoritative: attribution is required ONLY for
    // attachment-only support, never for a contract-typed money field.
    const api = envelope({ balanceCents: 4250, accountName: 'Conta principal' });
    expect(validateGroundedClaims('A fatura é R$ 42,50 na Conta principal.', api, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('Seu saldo é R$ 42,50 na Conta principal.', api).valid).toBe(true);
    // A mixed reply: the registered sentence rides on the API, the documented
    // one rides on its attribution.
    expect(
      validateGroundedClaims(
        'A fatura é R$ 42,50 na Conta principal. O documento informa R$ 42,50.',
        api,
        BLOCK_42_50,
      ).valid,
    ).toBe(true);
  });
});

describe('V1-GROUND-ATTRIBUTION: the same boundary on the percent axis', () => {
  it('ACCEPTS a percent explicitly attributed to the document', () => {
    expect(validateGroundedClaims('O documento informa que a taxa é 12,5%.', EMPTY_TOOLS, BLOCK_PERCENT).valid).toBe(true);
    expect(validateGroundedClaims('Segundo o anexo, a taxa é 12,5%.', EMPTY_TOOLS, BLOCK_PERCENT).valid).toBe(true);
    expect(validateGroundedClaims('A taxa do documento é 12%.', EMPTY_TOOLS, ['taxa de juros: 12%']).valid).toBe(true);
    expect(validateGroundedClaims('O documento informa:\n12,5%', EMPTY_TOOLS, BLOCK_PERCENT).valid).toBe(true);
  });

  it('REJECTS an unattributed percent supported only by the block', () => {
    const result = validateGroundedClaims('A taxa é 12,5%.', EMPTY_TOOLS, BLOCK_PERCENT);
    expect(result.valid).toBe(false);
    expect(result.counts.percent).toBe(1);
    expect(validateGroundedClaims('Sua alocação registrada:\n12,5%', EMPTY_TOOLS, BLOCK_PERCENT).valid).toBe(false);
  });

  it('never false-accepts when the same sentence also asserts registered state', () => {
    expect(validateGroundedClaims('O documento informa que sua alocação registrada é 12,5%.', EMPTY_TOOLS, BLOCK_PERCENT).valid).toBe(false);
  });

  it('keeps the contract-declared percent field independent of any attribution', () => {
    expect(validateGroundedClaims('A taxa é 12,5%.', envelope({ savingsRatePct: 12.5 })).valid).toBe(true);
    expect(validateGroundedClaims('Você usou 80% do orçamento.', envelope({ percentUsed: 80 })).valid).toBe(true);
  });
});

describe('V1-GROUND-ATTRIBUTION: figure-free document claims need no attribution', () => {
  it('keeps block dates and names supported without attribution', () => {
    const block = ['fatura do cartao Nubank total R$ 999,00 Conta principal vencimento 2026-03-12'];
    expect(validateGroundedClaims('Vence em 12/03/2026 na Conta principal.', EMPTY_TOOLS, block).valid).toBe(true);
    expect(validateGroundedClaims('No cartao Nubank está tudo certo.', EMPTY_TOOLS, block).valid).toBe(true);
    // The same block still grounds the money claim once it is attributed.
    expect(validateGroundedClaims('Segundo o anexo, a fatura é R$ 999 na Conta principal.', EMPTY_TOOLS, block).valid).toBe(true);
  });
});

describe('V1-GROUND-E2E: publication enforces the attribution boundary', () => {
  const collector = (): { events: Array<{ type: string; fields: Record<string, unknown> }>; sink: (type: string, fields: Record<string, unknown>) => void } => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    return { events, sink: (type, fields) => events.push({ type, fields }) };
  };

  it('publishes an attributed document figure verbatim', async () => {
    const result = await createGroundedResponseWithRetry('O documento informa R$ 42,50.', EMPTY_TOOLS, {
      attachmentTexts: BLOCK_42_50,
      sink: () => {},
    });
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(result.text).toBe('O documento informa R$ 42,50.');
  });

  it('falls back safe for an unattributed document figure, even after one correction', async () => {
    const { events, sink } = collector();
    const result = await createGroundedResponseWithRetry('A fatura é R$ 42,50 na Conta principal.', withName({}), {
      attachmentTexts: BLOCK_42_50,
      // A stubborn correction that repeats the same unattributed claim.
      retry: async () => 'A fatura é R$ 42,50 na Conta principal.',
      sink,
      intentionId: 'intent-unattributed-money',
    });
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(result.text).not.toContain('42,50');
    expect(result.text).toMatch(/Não foi possível consultar/);
    expect(events.filter((event) => event.type === 'agent.grounding.rejected')).toHaveLength(1);
  });

  it('publishes an attributed document percent verbatim', async () => {
    const result = await createGroundedResponseWithRetry('Segundo o anexo, a taxa é 12,5%.', EMPTY_TOOLS, {
      attachmentTexts: BLOCK_PERCENT,
      sink: () => {},
    });
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(result.text).toBe('Segundo o anexo, a taxa é 12,5%.');
  });

  it('falls back safe for an unattributed document percent', async () => {
    const { events, sink } = collector();
    const result = await createGroundedResponseWithRetry('A taxa é 12,5%.', EMPTY_TOOLS, {
      attachmentTexts: BLOCK_PERCENT,
      sink,
      intentionId: 'intent-unattributed-percent',
    });
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(result.text).not.toContain('12,5%');
    expect(events.filter((event) => event.type === 'agent.grounding.rejected')).toHaveLength(1);
  });

  it('still publishes an API-grounded figure on an attachment turn with no attribution', async () => {
    const result = await createGroundedResponseWithRetry('A fatura é R$ 42,50 na Conta principal.', envelope({ balanceCents: 4250, accountName: 'Conta principal' }), {
      attachmentTexts: BLOCK_42_50,
      sink: () => {},
    });
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(result.text).toBe('A fatura é R$ 42,50 na Conta principal.');
  });
});

/**
 * V1-GROUND-ATTRIBUTION-CLAUSE (final review P1): the attribution must GOVERN
 * the figure. Matching a document reference anywhere in the sentence accepted
 * two shapes the rule exists to refuse:
 *
 *   1. "O documento informa a data, mas o total da sua fatura é R$42,50" — the
 *      attribution sits in the FIRST clause and the figure in the adversative
 *      SECOND one, so the document never vouched for the amount.
 *   2. "O valor não está no documento: o total é R$42,50" — a NEGATED reference
 *      laundered into provenance.
 *
 * Both now fail closed: the attribution must sit in the SAME local clause as
 * the figure (an adversative/concessive break ends the clause), and a negated
 * reference never counts. A comma, a colon and a LINE BREAK are NOT breaks —
 * "O documento informa:\nR$ 42,50" is how a labelled block renders, and the
 * attribution must keep governing the figure across it. The registered-state
 * deny-list stays additional, and API typed evidence never needs attribution.
 */
describe('V1-GROUND-ATTRIBUTION-CLAUSE: the attribution must govern the figure', () => {
  it('ACCEPTS an attribution in the same clause as the figure, including across a line break', () => {
    expect(validateGroundedClaims('O documento informa o total: R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('No anexo consta R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('O documento informa:\nR$ 42,50', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    // The figure may also follow the attribution inside the very same clause.
    expect(validateGroundedClaims('R$ 42,50, conforme o documento informa.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
  });

  it('REJECTS the reviewer example: the figure sits in an adversative second clause', () => {
    for (const text of [
      'O documento informa a data, mas o total da sua fatura é R$42,50',
      'O documento informa a data, mas o total da sua fatura é R$42,50.',
      'O anexo traz a data. O total da fatura, porém, é R$42,50.',
      'Conforme o PDF, a data é 09/10/2026; o total, entretanto, é R$42,50.',
    ]) {
      const result = validateGroundedClaims(text, EMPTY_TOOLS, BLOCK_42_50);
      expect(result.valid).toBe(false);
      expect(result.counts.money).toBe(1);
    }
  });

  it('REJECTS the reviewer example: a negated document reference is not provenance', () => {
    for (const text of [
      'O valor não está no documento: o total é R$42,50',
      'O valor não está no documento: o total é R$42,50.',
      'Não encontrei o valor no documento, então o total é R$42,50.',
      'O documento não informa o total, que é R$42,50.',
    ]) {
      const result = validateGroundedClaims(text, EMPTY_TOOLS, BLOCK_42_50);
      expect(result.valid).toBe(false);
      expect(result.counts.money).toBe(1);
    }
  });

  it('keeps a POSITIVE attribution after a negated one or an adversative clause (no over-blocking)', () => {
    expect(validateGroundedClaims('O documento não informa a data, mas o anexo informa R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    expect(validateGroundedClaims('Não consegui ler a data, mas o PDF informa o total: R$ 42,50.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
  });

  it('REJECTS the coordinated example: an affirmative `e` starts a new clause (final review P2)', () => {
    // V1-GROUND-ATTRIBUTION-COORDINATION-AFFIRMATIVE: the adversative list
    // left one hole — a COORDINATING `e`. In "O documento informa a data e o
    // total da sua fatura é R$ 42,50" the attribution sits in the FIRST
    // conjunct and the figure in the second, whose own predicate the document
    // never vouched for, so an attachment block holding the figure must not
    // ground it. `e` now breaks the clause exactly like `mas` does.
    const money = validateGroundedClaims('O documento informa a data e o total da sua fatura é R$ 42,50.', EMPTY_TOOLS, ['valor: 42,50 R$']);
    expect(money.valid).toBe(false);
    expect(money.counts.money).toBe(1);
    // The same boundary holds on the percent axis.
    const percent = validateGroundedClaims('O documento informa a data e a taxa de juros é 12,5%.', EMPTY_TOOLS, ['taxa: 12,5%']);
    expect(percent.valid).toBe(false);
    expect(percent.counts.percent).toBe(1);
  });

  it('PRESERVES the direct and multi-line citation forms the rule exists to protect', () => {
    // A comma, a colon and a LINE BREAK are still not breaks, and a negation
    // AFTER the figure still denies another object, not this figure.
    expect(validateGroundedClaims('O documento informa: R$ 42,50.', EMPTY_TOOLS, ['valor: 42,50 R$']).valid).toBe(true);
    expect(validateGroundedClaims('O documento informa:\nR$ 42,50', EMPTY_TOOLS, ['valor: 42,50 R$']).valid).toBe(true);
    expect(validateGroundedClaims('O documento informa o total de R$ 42,50 e não informa a data.', EMPTY_TOOLS, ['valor: 42,50 R$']).valid).toBe(true);
  });

  it('binds the percent axis to the same clause and refuses a negated source', () => {
    expect(validateGroundedClaims('O documento informa a taxa:\n12,5%', EMPTY_TOOLS, BLOCK_PERCENT).valid).toBe(true);
    expect(validateGroundedClaims('O documento informa a data, mas a taxa é 12,5%.', EMPTY_TOOLS, BLOCK_PERCENT).valid).toBe(false);
    expect(validateGroundedClaims('A taxa não está no documento: ela é 12,5%.', EMPTY_TOOLS, BLOCK_PERCENT).valid).toBe(false);
  });

  it('leaves API typed evidence untouched: no attribution is required and the currency tag still governs', () => {
    const api = envelope({ balanceCents: 4250, accountName: 'Conta principal' });
    expect(validateGroundedClaims('O total é R$ 42,50 na Conta principal.', api).valid).toBe(true);
    // A foreign claim is still refused even with the block figure present.
    expect(validateGroundedClaims('O total é US$ 42,50 na Conta principal.', api, BLOCK_42_50).valid).toBe(false);
  });
});

/**
 * V1-GROUND-ATTRIBUTION-MARKER (final review P1): on the admitted attachment
 * axis, money evidence must carry an EXPLICIT monetary marker (`R$`, `BRL`,
 * `reais`, or a supported currency marker). The bare BR-decimal support-side
 * superset turned any unmarked decimal inside the block into implicit BRL
 * evidence, so an UNKNOWN UNIT (`12,50 hectares`, not in the closed unit list)
 * and an UNKNOWN CURRENCY code (`BDT 42,50`, outside the closed foreign list)
 * both grounded a reais claim. Exact cents, the sign and the known-currency
 * discipline are unchanged for marked figures.
 */
describe('V1-GROUND-ATTRIBUTION-MARKER: only a marked figure is document-money evidence', () => {
  it('ACCEPTS a valid cited PDF figure (exact cents and sign preserved)', () => {
    expect(validateGroundedClaims('O documento informa R$ 42,50.', EMPTY_TOOLS, ['fatura do cartao — valor: 42,50 R$ — vencimento 09/10/2026']).valid).toBe(true);
    expect(validateGroundedClaims('O documento informa -R$ 42,50.', EMPTY_TOOLS, ['fatura — valor: -42.50 R$']).valid).toBe(true);
    expect(validateGroundedClaims('O documento informa R$ 42,50.', EMPTY_TOOLS, ['fatura — valor: 42.49 R$']).valid).toBe(false);
  });

  it('ACCEPTS a valid cited Gemini figure (real renderer output) and refuses its unreadable-currency sibling', () => {
    const fields = { merchant: 'Padaria', date: '2026-10-09', amount: '42.50', currency: 'BRL', suggestedCategory: 'Padaria', confidence: 'high' };
    expect(renderVisionFields(fields)).toContain('valor: 42.50 BRL');
    expect(validateGroundedClaims('O documento informa R$ 42,50.', EMPTY_TOOLS, [renderVisionFields(fields)]).valid).toBe(true);
    // `currency: unknown` stays honest and never becomes implicit reais.
    expect(validateGroundedClaims('O documento informa R$ 42,50.', EMPTY_TOOLS, [renderVisionFields({ ...fields, currency: 'unknown' })]).valid).toBe(false);
  });

  it('REJECTS an unknown unit (hectares) laundered into implicit BRL evidence', () => {
    for (const block of [
      ['área cultivada: 12,50 hectares'],
      ['área cultivada: 12,50 hectare'],
      ['produtividade de 12,50 hectares por talhao'],
    ]) {
      const result = validateGroundedClaims('O documento informa R$ 12,50.', EMPTY_TOOLS, block);
      expect(result.valid).toBe(false);
      expect(result.counts.money).toBe(1);
    }
  });

  it('REJECTS an unknown currency code (BDT) laundered into implicit BRL evidence', () => {
    for (const block of [
      ['total BDT 42,50'],
      ['total: BDT 42,50'],
      ['valor 42,50 BDT'],
    ]) {
      const result = validateGroundedClaims('O documento informa R$ 42,50.', EMPTY_TOOLS, block);
      expect(result.valid).toBe(false);
      expect(result.counts.money).toBe(1);
    }
  });

  it('keeps the marked requirement on the block side only: claims still need no marker in financial context', () => {
    const api = envelope({ balanceCents: 4250, accountName: 'Conta principal' });
    expect(validateGroundedClaims('O saldo total é 42,50 na Conta principal.', api).valid).toBe(true);
  });
});

describe('V1-GROUND-E2E: publication enforces the clause bound and the marker requirement', () => {
  it('publishes a valid cited PDF figure and a valid cited document percent verbatim', async () => {
    const pdf = await createGroundedResponseWithRetry('O documento informa R$ 42,50.', EMPTY_TOOLS, {
      attachmentTexts: ['fatura do cartao — valor: 42,50 R$ — vencimento 09/10/2026'],
      sink: () => {},
    });
    expect(pdf).toMatchObject({ grounded: true, rejected: false });
    expect(pdf.text).toBe('O documento informa R$ 42,50.');
    const percent = await createGroundedResponseWithRetry('Segundo o anexo, a taxa é 12,5%.', EMPTY_TOOLS, {
      attachmentTexts: BLOCK_PERCENT,
      sink: () => {},
    });
    expect(percent).toMatchObject({ grounded: true, rejected: false });
    expect(percent.text).toBe('Segundo o anexo, a taxa é 12,5%.');
  });

  it('publishes a valid cited Gemini figure verbatim, with exact cents', async () => {
    const fields = { merchant: 'Padaria', date: '2026-10-09', amount: '42.50', currency: 'BRL', suggestedCategory: 'Padaria', confidence: 'high' };
    const result = await createGroundedResponseWithRetry('O documento informa R$ 42,50.', EMPTY_TOOLS, {
      attachmentTexts: [renderVisionFields(fields)],
      sink: () => {},
    });
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(result.text).toBe('O documento informa R$ 42,50.');
  });

  it('falls back safe for the adversative reviewer example, even after one stubborn correction', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    let attempts = 0;
    const result = await createGroundedResponseWithRetry('O documento informa a data, mas o total da sua fatura é R$42,50.', EMPTY_TOOLS, {
      attachmentTexts: BLOCK_42_50,
      retry: async () => {
        attempts += 1;
        return 'O documento informa a data, mas o total da sua fatura é R$42,50.';
      },
      sink: (type, fields) => events.push({ type, fields }),
      intentionId: 'intent-clause-adversative',
      traceId: 'trace-clause-adversative',
    });
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(result.text).not.toContain('42,50');
    expect(result.text).toMatch(/Não foi possível consultar/);
    expect(events.filter((event) => event.type === 'agent.grounding.rejected')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent.grounding.correction_attempted')).toHaveLength(1);
  });

  it('falls back safe for the negated reviewer example, even after one stubborn correction', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    let attempts = 0;
    const result = await createGroundedResponseWithRetry('O valor não está no documento: o total é R$42,50.', EMPTY_TOOLS, {
      attachmentTexts: BLOCK_42_50,
      retry: async () => {
        attempts += 1;
        return 'O valor não está no documento: o total é R$42,50.';
      },
      sink: (type, fields) => events.push({ type, fields }),
      intentionId: 'intent-clause-negated',
    });
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(result.text).not.toContain('42,50');
    expect(events.filter((event) => event.type === 'agent.grounding.rejected')).toHaveLength(1);
  });

  it('falls back safe for the coordinated `e` example, even after one stubborn correction', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const text = 'O documento informa a data e o total da sua fatura é R$ 42,50.';
    const result = await createGroundedResponseWithRetry(text, EMPTY_TOOLS, {
      attachmentTexts: ['valor: 42,50 R$'],
      retry: async () => text,
      sink: (type, fields) => events.push({ type, fields }),
      intentionId: 'intent-clause-coordination',
      traceId: 'trace-clause-coordination',
    });
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(result.text).not.toContain('42,50');
    expect(result.text).toMatch(/Não foi possível consultar/);
    expect(events.filter((event) => event.type === 'agent.grounding.rejected')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent.grounding.correction_attempted')).toHaveLength(1);
  });

  it('falls back safe for an unknown unit and an unknown currency in the block', async () => {
    for (const [block, intentionId] of [
      [['área cultivada: 12,50 hectares'], 'intent-unit-hectares'],
      [['total BDT 42,50'], 'intent-currency-bdt'],
    ] as ReadonlyArray<readonly [string[], string]>) {
      const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
      const result = await createGroundedResponseWithRetry('O documento informa R$ 42,50.', EMPTY_TOOLS, {
        attachmentTexts: block,
        retry: async () => 'O documento informa R$ 42,50.',
        sink: (type, fields) => events.push({ type, fields }),
        intentionId,
      });
      expect(result).toMatchObject({ grounded: false, rejected: true });
      expect(result.text).not.toContain('42,50');
      expect(events.filter((event) => event.type === 'agent.grounding.rejected')).toHaveLength(1);
    }
  });

  it('publishes the correction retry that actually attributes the figure to the document', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const result = await createGroundedResponseWithRetry('O total da sua fatura é R$42,50.', EMPTY_TOOLS, {
      attachmentTexts: BLOCK_42_50,
      retry: async () => 'O anexo informa o total: R$42,50.',
      sink: (type, fields) => events.push({ type, fields }),
      intentionId: 'intent-clause-corrected',
    });
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(result.text).toBe('O anexo informa o total: R$42,50.');
    expect(events.map((event) => event.type)).toEqual([
      'agent.grounding.correction_attempted',
      'agent.grounding.correction_completed',
      'agent.grounding.validated',
    ]);
  });
});
