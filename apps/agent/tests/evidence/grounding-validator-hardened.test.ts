import { describe, expect, it, vi } from 'vitest';
import { validateGroundedClaims } from '../../src/evidence/grounding-validator.js';
import { createGroundedResponseWithRetry } from '../../src/responses/grounded-response.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

const envelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'api.balance', retrievedAt: '2026-09-13T12:00:00Z', status: 'ok', data }],
});

describe('AGENT-005 hardened grounding validator', () => {
  it('validates percentages against the envelope', () => {
    const env = envelope({ allocation: 12.5, accountName: 'Conta principal' });
    expect(validateGroundedClaims('Sua alocação é 12,5% na Conta principal.', env).valid).toBe(true);
    expect(validateGroundedClaims('Sua alocação é 99% na Conta principal.', env).valid).toBe(false);
  });

  it('validates dates in dd/mm/yyyy, "12 de março" and ISO formats', () => {
    const env = envelope({ dueDate: '2026-03-12', accountName: 'Conta principal' });
    expect(validateGroundedClaims('Vence em 12/03/2026 na Conta principal.', env).valid).toBe(true);
    expect(validateGroundedClaims('Vence em 12 de março na Conta principal.', env).valid).toBe(true);
    expect(validateGroundedClaims('Vence em 2026-03-12 na Conta principal.', env).valid).toBe(true);
    const unsupported = validateGroundedClaims('Vence em 25/12/2026 na Conta principal.', env);
    expect(unsupported.valid).toBe(false);
    expect(unsupported.unsupportedClaims.length).toBeGreaterThan(0);
  });

  it('validates account/card/category names case- and accent-insensitively', () => {
    const env = envelope({ accountName: 'Conta principal', cardName: 'Cartão Nubank' });
    expect(validateGroundedClaims('Na conta principal está tudo certo.', env).valid).toBe(true);
    expect(validateGroundedClaims('No cartao Nubank está tudo certo.', env).valid).toBe(true);
    const unsupported = validateGroundedClaims('No Cartão Inter está tudo certo.', env);
    expect(unsupported.valid).toBe(false);
    expect(unsupported.unsupportedClaims.some((claim) => claim.includes('Inter'))).toBe(true);
  });

  it('still accepts plain grounded text without claims', () => {
    const env = envelope({ balanceCents: 12345 });
    expect(validateGroundedClaims('Posso ajudar com consultas e orientações.', env).valid).toBe(true);
  });

  it('performs ONE structured correction retry, then falls back safe and emits a sanitized event', async () => {
    const env = envelope({ balanceCents: 12345, accountName: 'Conta principal' });
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const retry = vi.fn(async (claims: readonly string[]) => {
      expect(claims.length).toBeGreaterThan(0);
      return 'Seu saldo é R$ 123,45 na Conta principal.';
    });
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry,
      sink: (type, fields) => events.push({ type, fields }),
      intentionId: 'intent-1',
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(result.text).toContain('123,45');
    expect(events).toHaveLength(0);
  });

  // R10: `onRecoveryAttempted` is purely OBSERVATIONAL (it charges the turn's
  // shared recovery budget). A throwing hook must never skip the correction
  // retry nor be mistaken for a usage denial raised by the retry itself.
  it('still runs the correction retry when the observational hook throws', async () => {
    const env = envelope({ balanceCents: 12345, accountName: 'Conta principal' });
    const retry = vi.fn(async () => 'Seu saldo é R$ 123,45 na Conta principal.');
    let hookCalls = 0;
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry,
      onRecoveryAttempted: () => {
        hookCalls += 1;
        throw new Error('budget.sink_unavailable');
      },
      sink: () => {},
    });
    expect(hookCalls).toBe(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(result.text).toContain('123,45');
  });

  it('swallows a quota-shaped hook failure instead of turning it into a passthrough', async () => {
    const env = envelope({ balanceCents: 12345, accountName: 'Conta principal' });
    const retry = vi.fn(async () => 'Seu saldo é R$ 123,45 na Conta principal.');
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry,
      onRecoveryAttempted: () => {
        throw Object.assign(new Error('agent.quota_exceeded'), {
          code: 'agent.quota_exceeded',
          status: 429,
          __usageQuotaPassthrough: true,
        });
      },
      sink: () => {},
    });
    // The denial came from the hook, not from a reservation the retry asked
    // for: the turn keeps the retry's own (successful) outcome.
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ grounded: true, rejected: false });
  });

  it('preserves the usage-quota passthrough raised by the retry itself', async () => {
    const env = envelope({ balanceCents: 12345, accountName: 'Conta principal' });
    await expect(
      createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
        retry: async () => {
          throw Object.assign(new Error('agent.quota_exceeded'), {
            code: 'agent.quota_exceeded',
            status: 429,
            __usageQuotaPassthrough: true,
          });
        },
        onRecoveryAttempted: () => {},
        sink: () => {},
      }),
    ).rejects.toMatchObject({ code: 'agent.quota_exceeded', status: 429 });
  });

  it('emits agent.grounding.rejected without raw payload when the retry still fails', async () => {
    const env = envelope({ balanceCents: 12345, accountName: 'Conta principal' });
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry: async () => 'Seu saldo é R$ 888,88 na Conta principal.',
      sink: (type, fields) => events.push({ type, fields }),
      intentionId: 'intent-9',
      traceId: 'trace-9',
    });
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(result.text).toMatch(/Não foi possível consultar/);
    expect(result.text).not.toMatch(/999,99|888,88/);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('agent.grounding.rejected');
    expect(JSON.stringify(events[0]!.fields)).not.toMatch(/999,99|888,88|Conta principal/);
  });
});

describe('A19-GROUND-FORMATS: alternate pt-BR money shapes are financial claims', () => {
  // No money anywhere in evidence: every shape below MUST be rejected.
  const noMoney = envelope({ note: 'sem valores' });
  // Evidence holding exactly R$ 999,00: every shape below MUST pass.
  const with999 = envelope({ balanceCents: 99900, accountName: 'Conta principal' });

  it.each([
    ['reais bare integer', 'A fatura totaliza 999 reais.'],
    ['R$ integer with space', 'A fatura totaliza R$ 999.'],
    ['R$ integer no space', 'A fatura totaliza R$999.'],
    ['reais with BR decimals', 'A fatura totaliza 999,00 reais.'],
    ['reais with thousands', 'A fatura totaliza 1.234,56 reais.'],
    ['US$ prefixed', 'O total é US$ 999,00.'],
    ['bare $ prefixed', 'O total é $ 999,00.'],
    ['bare decimal in financial context', 'O saldo total é 999,00.'],
    ['canonical (already covered)', 'Seu saldo é R$ 999,99.'],
  ])('rejects %s without evidence', (_label, text) => {
    const result = validateGroundedClaims(text, noMoney);
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims.length).toBeGreaterThan(0);
  });

  it.each([
    ['reais bare integer', 'A fatura é 999 reais na Conta principal.'],
    ['R$ integer with space', 'Seu saldo é R$ 999 na Conta principal.'],
    ['R$ integer no space', 'Seu saldo é R$999 na Conta principal.'],
    ['reais with BR decimals', 'A fatura é 999,00 reais na Conta principal.'],
    ['US$ prefixed', 'O total é US$ 999,00 na Conta principal.'],
    ['bare decimal in financial context', 'O saldo total é 999,00 na Conta principal.'],
    ['canonical (already covered)', 'Seu saldo é R$ 999,00 na Conta principal.'],
  ])('passes %s when the figure is in the tool envelope', (_label, text) => {
    expect(validateGroundedClaims(text, with999).valid).toBe(true);
  });

  it('rejects a correction retry that smuggles an unverified alternate-shape figure', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const result = await createGroundedResponseWithRetry('A fatura totaliza 999 reais.', noMoney, {
      retry: async () => 'Correcao: a fatura totaliza 999 reais.',
      sink: (type, fields) => events.push({ type, fields }),
      intentionId: 'intent-smuggle',
    });
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(result.text).toMatch(/Não foi possível consultar/);
    expect(result.text).not.toMatch(/999/);
    expect(events.some((event) => event.type === 'agent.grounding.rejected')).toBe(true);
  });

  it('documents the number-words residual: spelled-out amounts are regex-invisible', () => {
    // "quarenta e dois reais" carries a money claim no regex can delimit.
    // Accepted residual: mitigated by the DATA-precedence instruction and the
    // correction retry, never by weakening detection of delimited shapes.
    expect(validateGroundedClaims('A fatura totaliza quarenta e dois reais.', noMoney).valid).toBe(true);
  });
});

describe('A19-GROUND-FIX2: unit-preserving money grounding + singular "real"', () => {
  // P1: a raw cents field (balanceCents 99900 = R$ 999,00) must NEVER ground
  // a reais-denominated reading of the same digits ("R$ 99.900,00").
  it('rejects R$ 99.900,00 against a balanceCents 99900 envelope (unit mismatch)', () => {
    const env = envelope({ balanceCents: 99900, accountName: 'Conta principal' });
    const result = validateGroundedClaims('Seu saldo é R$ 99.900,00 na Conta principal.', env);
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims.length).toBeGreaterThan(0);
  });

  // P1 control: a genuinely reais-denominated field still grounds a reais claim.
  it('still grounds a reais claim against a reais-denominated field', () => {
    const env = envelope({ total: 999, accountName: 'Conta principal' });
    expect(validateGroundedClaims('A fatura é 999 reais na Conta principal.', env).valid).toBe(true);
  });

  // P2: the singular "1 real" is a financial claim, not claim-free prose.
  it('rejects singular "1 real" without evidence', () => {
    const env = envelope({ note: 'sem valores' });
    const result = validateGroundedClaims('A tarifa é 1 real.', env);
    expect(result.valid).toBe(false);
    expect(result.unsupportedClaims.length).toBeGreaterThan(0);
  });

  // P2 control: singular "1 real" passes when the figure is in the envelope.
  it('accepts singular "1 real" with matching evidence', () => {
    const env = envelope({ feeCents: 100 });
    expect(validateGroundedClaims('A tarifa é 1 real.', env).valid).toBe(true);
  });
});
