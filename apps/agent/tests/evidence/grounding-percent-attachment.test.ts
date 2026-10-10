import { describe, expect, it } from 'vitest';
import { validateGroundedClaims } from '../../src/evidence/grounding-validator.js';
import { createGroundedResponseWithRetry } from '../../src/responses/grounded-response.js';
import { isAutoExecutionEligible } from '../../src/safety/auto-execution.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

/**
 * V1-GROUND-PERCENT-ATTACHMENT (PR #129 P2): the percent axis now admits
 * the SAME `%`-marked figure from server-side attachment-extracted text,
 * exactly like money/date/name already do — but ONLY when the matching `%`
 * evidence is present. The axes stay distinct (money never grounds a ratio,
 * a ratio never grounds money) and the support stays read-narration only:
 * no mutation/approval path consumes it and no authorization surface opens.
 *
 * V1-GROUND-ATTRIBUTION: like money, that admitted support requires POSITIVE
 * document attribution in the claim sentence — the block alone is not
 * provenance.
 */
const envelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'api.analytics', retrievedAt: '2026-10-09T12:00:00Z', status: 'ok', data }],
});

/** The live attachment-turn shape: no usable finance rows in the envelope. */
const EMPTY_TOOLS = envelope([]);

describe('V1-GROUND-PERCENT-ATTACHMENT: a percent is grounded by matching % evidence', () => {
  // V1-GROUND-ATTRIBUTION: the admitted block only supports a percent the reply
  // ATTRIBUTES to the document ("Segundo o anexo, …") — the same boundary the
  // money axis obeys.
  it('grounds a response percent by the same % figure in the admitted block', () => {
    expect(validateGroundedClaims('Segundo o anexo, sua alocação é 12,5% este mês.', EMPTY_TOOLS, ['taxa de poupança: 12,5%']).valid).toBe(true);
  });

  it('grounds the alternate decimal spelling when the block prints 12.50%', () => {
    expect(validateGroundedClaims('Segundo o anexo, a taxa é 12,5%.', EMPTY_TOOLS, ['taxa: 12.50%']).valid).toBe(true);
  });

  it('REJECTS a percent whose figure is absent from the block', () => {
    const result = validateGroundedClaims('Segundo o anexo, a taxa é 90%.', EMPTY_TOOLS, ['taxa: 12,5%']);
    expect(result.valid).toBe(false);
    expect(result.counts.percent).toBe(1);
  });

  it('REJECTS an UNATTRIBUTED percent even with the matching figure in the block', () => {
    // The block wording is irrelevant: provenance is decided on the CLAIM
    // sentence, and only the reply can attribute the figure to the document.
    const result = validateGroundedClaims('A taxa é 12,5%.', EMPTY_TOOLS, ['taxa de juros informada no anexo']);
    expect(result.valid).toBe(false);
    expect(result.counts.percent).toBe(1);
    expect(validateGroundedClaims('A taxa é 12,5%.', EMPTY_TOOLS).valid).toBe(false);
  });

  it('keeps % distinct from money: block money never grounds a percent claim', () => {
    expect(validateGroundedClaims('A taxa é 12,5%.', EMPTY_TOOLS, ['taxa de juros: R$ 12,50']).valid).toBe(false);
  });

  it('keeps % distinct from money: block percent never grounds a money claim', () => {
    const result = validateGroundedClaims('A taxa é R$ 12,50.', EMPTY_TOOLS, ['taxa: 12,5%']);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBe(1);
    expect(result.counts.percent).toBe(0);
  });

  it('still grounds a percent by the percentage-declared field of the read contract', () => {
    expect(validateGroundedClaims('Sua alocação é 12,5%.', envelope({ savingsRatePct: 12.5 })).valid).toBe(true);
    expect(validateGroundedClaims('Você usou 80% do orçamento.', envelope({ percentUsed: 80 })).valid).toBe(true);
  });

  it('keeps counts, totals, limits and money fields unable to ground a percent', () => {
    for (const data of [{ transactionCount: 12, total: 12, limit: 12 }, { feeCents: 1250 }, { allocation: 12.5 }]) {
      const result = validateGroundedClaims('Segundo o anexo, a taxa é 12,5%.', envelope(data), ['taxa: 12,5%']);
      // The block percent grounds the claim; the re-pin is that the count /
      // money / unclassified fields themselves never do.
      expect(result.valid).toBe(true);
      expect(validateGroundedClaims('Segundo o anexo, a taxa é 12,5%.', envelope(data)).valid).toBe(false);
    }
  });

  it('keeps the sign discipline on the attachment axis', () => {
    expect(validateGroundedClaims('Segundo o anexo, a taxa é -12,5%.', EMPTY_TOOLS, ['taxa: -12,5%']).valid).toBe(true);
    expect(validateGroundedClaims('Segundo o anexo, a taxa é 12,5%.', EMPTY_TOOLS, ['taxa: -12,5%']).valid).toBe(false);
    expect(validateGroundedClaims('Segundo o anexo, a taxa é -12,5%.', EMPTY_TOOLS, ['taxa: 12,5%']).valid).toBe(false);
  });

  it('tool evidence grounds a registered percent; document evidence cannot (provenance symmetry)', () => {
    expect(validateGroundedClaims('Sua alocação registrada é 12,5%.', envelope({ savingsRatePct: 12.5 })).valid).toBe(true);
    expect(validateGroundedClaims('Sua alocação registrada é 12,5%.', EMPTY_TOOLS, ['taxa: 12,5%']).valid).toBe(false);
  });

  it('keeps the multiline registered protection on the percent axis (a line break is not a sentence end)', () => {
    expect(validateGroundedClaims('Sua alocação registrada:\n12,5%', EMPTY_TOOLS, ['taxa: 12,5%']).valid).toBe(false);
    expect(validateGroundedClaims('O documento informa:\n12,5%', EMPTY_TOOLS, ['taxa: 12,5%']).valid).toBe(true);
  });

  it('publishes a percent grounded by the admitted block through the grounded response path', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const result = await createGroundedResponseWithRetry('Segundo o anexo, sua alocação é 12,5% este mês.', EMPTY_TOOLS, {
      attachmentTexts: ['taxa de poupança: 12,5%'],
      sink: (type, fields) => events.push({ type, fields }),
    });
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(result.text).toBe('Segundo o anexo, sua alocação é 12,5% este mês.');
  });

  it('exposes no authorization surface: percent support stays read-narration only', async () => {
    const result = await createGroundedResponseWithRetry('Segundo o anexo, sua alocação é 12,5% este mês.', EMPTY_TOOLS, {
      attachmentTexts: ['taxa de poupança: 12,5%'],
      sink: () => {},
    });
    expect(Object.keys(result).sort()).toEqual(['grounded', 'rejected', 'text']);
    const validation = validateGroundedClaims('Segundo o anexo, sua alocação é 12,5% este mês.', EMPTY_TOOLS, ['taxa de poupança: 12,5%']);
    expect(Object.keys(validation).sort()).toEqual(['counts', 'unsupportedClaims', 'valid']);
  });

  it('a percent-bearing attachment turn is still not auto-executable (no authorization from grounding)', () => {
    expect(isAutoExecutionEligible({
      tool: 'transactions.expense.create',
      missingFields: [],
      ambiguity: null,
      latestActorText: 'A taxa é 12,5% este mês.',
      attachments: [{ type: 'pdf', name: 'fatura.pdf' }],
    })).toBe(false);
  });
});
