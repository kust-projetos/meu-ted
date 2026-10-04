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
