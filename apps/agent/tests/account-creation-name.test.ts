/**
 * account-name-extraction (TASK_ID: account-name-extraction) — RED tests for
 * the follow-up name bug: "nubank o saldo atual é 145" extracted "nubank é"
 * (copula leaked into the draft name), which would persist a bad account
 * name on confirm.
 */
import { describe, expect, it } from 'vitest';
import { extractAccountName } from '../src/mutations/account-creation.js';

describe('account-name-extraction follow-up', () => {
  it('(1) "nubank o saldo atual é 145" → "nubank" (no verb leak)', () => {
    expect(extractAccountName('nubank o saldo atual é 145')).toBe('nubank');
  });

  it('(2) "conta nubank com saldo 145" → "nubank"', () => {
    expect(extractAccountName('conta nubank com saldo 145')).toBe('nubank');
  });

  it('(3) multi-word names preserved: "Banco do Brasil" stays intact', () => {
    expect(extractAccountName('criar conta Banco do Brasil com saldo 100')).toBe('Banco do Brasil');
  });

  it('(3b) trailing copula trimmed but interior kept: "Banco do Brasil é" → intact', () => {
    expect(extractAccountName('Banco do Brasil o saldo atual é 100')).toBe('Banco do Brasil');
  });
});
