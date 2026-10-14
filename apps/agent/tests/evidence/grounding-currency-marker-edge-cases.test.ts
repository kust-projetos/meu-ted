import { describe, expect, it } from 'vitest';
import { validateGroundedClaims } from '../../src/evidence/grounding-validator.js';
import { createGroundedResponseWithRetry } from '../../src/responses/grounded-response.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

/**
 * Final static adversarial findings (Debugger round) on the currency/marker
 * boundary. All four are small regex/parser fixes around ONE invariant: a
 * figure may only be read as BRL when the text really says so — never by a
 * marker that was skipped, separated, contradicted or borrowed.
 *
 *   1. `BDT - 42,50` — an unknown code with the sign DETACHED from the digits
 *      must still be tagged UNKNOWN, not leak through the bare path as BRL.
 *   2. `R$ - 42,50` — the same detached sign after a real marker must keep the
 *      NEGATIVE value (no sign laundering against positive API cents).
 *   3. `42,50 PIX` — a suffix PAYMENT acronym is not a unit of measure: the
 *      figure stays a money claim (groundable, but never free).
 *   4. `BDT 42,50 reais` — two markers DISAGREEING about the same figure
 *      invalidate it on BOTH the claim axis and the document axis.
 *   5. Attribution is not borrowed across a coordinated clause: a figure whose
 *      own clause NEGATES the document relation is not document-reported.
 */

const envelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'api.balance', retrievedAt: '2026-10-09T12:00:00Z', status: 'ok', data }],
});

const EMPTY_TOOLS = envelope([]);
const BLOCK_42_50 = ['dados extraidos do anexo: valor 42,50 R$ vencimento 2026-10-09'];
const POSITIVE_WALLET = envelope({ balanceCents: 4250, accountName: 'Conta principal' });
const NEGATIVE_WALLET = envelope({ balanceCents: -4250, accountName: 'Conta principal' });
const NO_MONEY = envelope({ note: 'sem valores' });

describe('V1-GROUND-CURRENCY-SPACED-SIGN: an unknown code keeps its tag when the sign is detached', () => {
  it('REJECTS "BDT - 42,50" as UNKNOWN even against the matching POSITIVE BRL cents', () => {
    // The detached sign once fell outside FIGURE, so the marked rule never
    // matched and the bare rule read +42,50 as implicit reais.
    const result = validateGroundedClaims('O total é BDT - 42,50.', POSITIVE_WALLET);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBe(1);
    // The label names the marker the reply used, and the SIGN survives.
    expect(result.unsupportedClaims.some((claim) => claim.startsWith('BDT -4250'))).toBe(true);
    expect(result.unsupportedClaims.some((claim) => claim.includes('R$'))).toBe(false);
  });

  it('keeps the UNKNOWN tag on the document axis as well', () => {
    const result = validateGroundedClaims('O documento informa R$ 42,50.', EMPTY_TOOLS, ['total BDT - 42,50']);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBe(1);
  });

  it('still reads a plain "BDT 42,50" (attached sign) as UNKNOWN', () => {
    const result = validateGroundedClaims('O total é BDT 42,50.', POSITIVE_WALLET);
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims.some((claim) => claim.startsWith('BDT 4250'))).toBe(true);
  });
});

describe('V1-GROUND-SIGN-SPACED: "R$ - 42,50" stays negative', () => {
  it('REJECTS the spaced sign against the same POSITIVE value (no sign laundering)', () => {
    const result = validateGroundedClaims('O total é R$ - 42,50.', POSITIVE_WALLET);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBe(1);
    expect(result.unsupportedClaims.some((claim) => claim.includes('-4250'))).toBe(true);
  });

  it('ACCEPTS the spaced sign against the NEGATIVE value', () => {
    expect(validateGroundedClaims('O total é R$ - 42,50.', NEGATIVE_WALLET).valid).toBe(true);
  });

  it('keeps the same spaced-sign reading for the other supported markers', () => {
    expect(validateGroundedClaims('O total é US$ - 42,50.', POSITIVE_WALLET).valid).toBe(false);
    expect(validateGroundedClaims('O total é BRL - 42,50.', POSITIVE_WALLET).valid).toBe(false);
  });
});

describe('V1-GROUND-PAYMENT-TAIL: a suffix payment acronym is not a unit', () => {
  it('REJECTS "42,50 PIX" as an ungrounded money claim when the API has no amount', () => {
    const result = validateGroundedClaims('O pagamento de 42,50 PIX foi processado.', NO_MONEY);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBe(1);
    expect(result.unsupportedClaims.some((claim) => claim.includes('4250'))).toBe(true);
  });

  it('ACCEPTS the same claim when the API carries the matching cents', () => {
    expect(validateGroundedClaims('O pagamento de 42,50 PIX foi processado.', POSITIVE_WALLET).valid).toBe(true);
  });

  it('treats the DOC and TED suffixes the same way', () => {
    expect(validateGroundedClaims('A transferência de 42,50 DOC foi processada.', NO_MONEY).valid).toBe(false);
    expect(validateGroundedClaims('A transferência de 42,50 TED foi processada.', NO_MONEY).valid).toBe(false);
    expect(validateGroundedClaims('A transferência de 42,50 TED foi processada.', POSITIVE_WALLET).valid).toBe(true);
  });

  it('REJECTS a bare suffix when the payment acronym is the ONLY financial context', () => {
    // V1-GROUND-PAYMENT-CONTEXT (final review P2): `hasUnknownUnitTail`
    // already keeps the acronym from reading as a unit, but
    // `BARE_MONEY_CONTEXT` only named `pix`, so a bare `42,50 TED` /
    // `42,50 DOC` in a sentence with NO other finance keyword was not a
    // claim at all — and an unchallenged figure publishes against an empty
    // envelope. The acronym is a financial context exactly like `pix`.
    for (const text of [
      'Recebi 42,50 PIX ontem.',
      'Recebi 42,50 TED ontem.',
      'Recebi 42,50 DOC ontem.',
    ]) {
      const rejected = validateGroundedClaims(text, NO_MONEY);
      expect(rejected.valid).toBe(false);
      expect(rejected.counts.money).toBe(1);
      expect(rejected.unsupportedClaims.some((claim) => claim.includes('4250'))).toBe(true);
      // Accepted ONLY with the matching API cents.
      const accepted = validateGroundedClaims(text, POSITIVE_WALLET);
      expect(accepted.valid).toBe(true);
      expect(accepted.counts.money).toBe(0);
    }
  });

  it('E2E: publishes every PIX/TED/DOC bare suffix verbatim when the API carries the cents', async () => {
    for (const text of ['Recebi 42,50 PIX ontem.', 'Recebi 42,50 TED ontem.', 'Recebi 42,50 DOC ontem.']) {
      const result = await createGroundedResponseWithRetry(text, POSITIVE_WALLET, { sink: () => {} });
      expect(result).toMatchObject({ grounded: true, rejected: false });
      expect(result.text).toBe(text);
    }
  });

  it('E2E: falls back safe for a TED/DOC bare suffix with no API money, even after one stubborn correction', async () => {
    for (const [text, intentionId] of [
      ['Recebi 42,50 TED ontem.', 'intent-bare-suffix-ted'],
      ['Recebi 42,50 DOC ontem.', 'intent-bare-suffix-doc'],
    ] as ReadonlyArray<readonly [string, string]>) {
      const events: Array<{ type: string }> = [];
      const result = await createGroundedResponseWithRetry(text, NO_MONEY, {
        retry: async () => text,
        sink: (type) => events.push({ type }),
        intentionId,
      });
      expect(result).toMatchObject({ grounded: false, rejected: true });
      expect(result.text).not.toContain('42,50');
      expect(result.text).toMatch(/Não foi possível consultar/);
      expect(events.filter((event) => event.type === 'agent.grounding.rejected')).toHaveLength(1);
    }
  });
});

describe('V1-GROUND-MARKER-CONFLICT: disagreeing markers invalidate the figure', () => {
  it('REJECTS "BDT 42,50 reais" as a claim even against the matching BRL cents', () => {
    const result = validateGroundedClaims('O total é BDT 42,50 reais.', POSITIVE_WALLET);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBe(1);
    // The rejected claim names the UNKNOWN marker, never plain reais.
    expect(result.unsupportedClaims.some((claim) => claim.startsWith('BDT'))).toBe(true);
    expect(result.unsupportedClaims.some((claim) => claim.startsWith('R$'))).toBe(false);
  });

  it('REJECTS the same conflict on the document axis (the reais suffix no longer grounds it)', () => {
    const result = validateGroundedClaims('O documento informa R$ 42,50.', EMPTY_TOOLS, ['total BDT 42,50 reais']);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBe(1);
  });

  it('keeps AGREEING markers harmless (the same currency marked twice is not a conflict)', () => {
    expect(validateGroundedClaims('O total é R$ 42,50 reais.', POSITIVE_WALLET).valid).toBe(true);
    expect(validateGroundedClaims('O total é BRL 42,50.', POSITIVE_WALLET).valid).toBe(true);
  });
});

describe('V1-GROUND-ATTRIBUTION-CLAUSE: a negated coordinated clause is not provenance', () => {
  it('REJECTS publication for a figure whose own clause denies the document relation', async () => {
    const text = 'O documento informa a data e não informa o total de R$ 42,50.';
    const result = validateGroundedClaims(text, EMPTY_TOOLS, BLOCK_42_50);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBe(1);

    const events: Array<{ type: string }> = [];
    const published = await createGroundedResponseWithRetry(text, EMPTY_TOOLS, {
      attachmentTexts: BLOCK_42_50,
      // A stubborn correction that repeats the same coordinated negation.
      retry: async () => text,
      sink: (type) => events.push({ type }),
      intentionId: 'intent-coordinated-negation',
    });
    expect(published).toMatchObject({ grounded: false, rejected: true });
    expect(published.text).not.toContain('42,50');
    expect(published.text).toMatch(/Não foi possível consultar/);
    expect(events.filter((event) => event.type === 'agent.grounding.rejected')).toHaveLength(1);
  });

  it('PRESERVES the direct citations the rule exists to protect', () => {
    expect(validateGroundedClaims('O documento informa: R$42.50', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    // The attribution may follow the figure inside the same clause.
    expect(validateGroundedClaims('R$ 42,50, conforme o documento informa.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
    // A negation AFTER the figure denies another object, not this figure.
    expect(validateGroundedClaims('O documento informa o total de R$ 42,50 e não informa a data.', EMPTY_TOOLS, BLOCK_42_50).valid).toBe(true);
  });
});
