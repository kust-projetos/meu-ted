import { describe, expect, it } from 'vitest';
import { validateGroundedClaims } from '../../src/evidence/grounding-validator.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

const envelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'api.balance', retrievedAt: '2026-09-13T12:00:00Z', status: 'ok', data }],
});

/**
 * A19-GROUND-EVIDENCE: attachment-extracted texts are admitted as a
 * source-tagged support set for READ narration. The tool envelope below
 * carries no usable finance data (the live attachment-turn shape); the
 * admitted block text is what grounds the figure.
 */
const EMPTY_TOOLS = envelope([]);
const BLOCK = ['fatura do cartao Nubank total R$ 999,00 Conta principal vencimento 2026-03-12'];

describe('A19-GROUND-EVIDENCE: attachment-admitted figures ground read narration', () => {
  it('accepts a block figure absent from the tool envelope', () => {
    const result = validateGroundedClaims('A fatura é R$ 999 na Conta principal.', EMPTY_TOOLS, BLOCK);
    expect(result.valid).toBe(true);
  });

  it('accepts a block date absent from the tool envelope', () => {
    const result = validateGroundedClaims('Vence em 12/03/2026 na Conta principal.', EMPTY_TOOLS, BLOCK);
    expect(result.valid).toBe(true);
  });

  it('accepts a block name absent from the tool envelope', () => {
    const result = validateGroundedClaims('No cartao Nubank está tudo certo.', EMPTY_TOOLS, BLOCK);
    expect(result.valid).toBe(true);
  });

  it('accepts an alternate-format block figure (BR-decimal support-side superset)', () => {
    const block = ['extrato total 1.234,56 Conta principal'];
    expect(validateGroundedClaims('O total é R$ 1.234,56 na Conta principal.', EMPTY_TOOLS, block).valid).toBe(true);
  });

  it('REJECTS a figure present in NEITHER tools NOR the admitted block', () => {
    const result = validateGroundedClaims('A fatura é R$ 888,88 na Conta principal.', EMPTY_TOOLS, BLOCK);
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims.length).toBeGreaterThan(0);
  });

  it('REJECTS an invented name absent from both sources', () => {
    const result = validateGroundedClaims('No Cartão Inter está tudo certo.', EMPTY_TOOLS, BLOCK);
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims.some((claim) => claim.includes('Inter'))).toBe(true);
  });

  it('REJECTS a unit-mismatched claim against the admitted block (cents/reais discipline)', () => {
    // Block holds R$ 999,00 — "R$ 99.900,00" is a 100x misreading, never grounded.
    const result = validateGroundedClaims('Seu saldo é R$ 99.900,00 na Conta principal.', EMPTY_TOOLS, BLOCK);
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims.length).toBeGreaterThan(0);
  });

  it('keeps every existing negative green without admitted texts (default empty)', () => {
    expect(validateGroundedClaims('A fatura totaliza 999 reais.', EMPTY_TOOLS).valid).toBe(false);
    expect(validateGroundedClaims('A fatura é R$ 999 na Conta principal.', EMPTY_TOOLS).valid).toBe(false);
  });

  it('ignores empty admitted texts exactly like no attachment data', () => {
    expect(validateGroundedClaims('A fatura é R$ 999 na Conta principal.', EMPTY_TOOLS, []).valid).toBe(false);
    expect(validateGroundedClaims('A fatura é R$ 999 na Conta principal.', EMPTY_TOOLS, ['   ']).valid).toBe(false);
  });
});
