/**
 * HIGH3 (round 3) — authoritative expected context for receipt binding.
 *
 * `resolveExpectedContext` derives `{ tool, entityId? }` from the
 * AUTHORITATIVE listing record (tool + target args in the API actual
 * shape) — never from the execution response, never from client input.
 * Rename/deactivate REQUIRE the account target id (ausência = sem
 * contexto = fail closed a montante); create/transactions bind kind only
 * (a entidade nasce na execução — policy distinta, sem bloquear criação
 * honesta).
 */
import { describe, expect, it } from 'vitest';
import { resolveExpectedContext } from '../src/mutations/expected-context.js';

describe('resolveExpectedContext', () => {
  it('rename com accountId vincula tool + entity', () => {
    expect(
      resolveExpectedContext({ tool: 'accounts.update', accountId: 'acc-1' }),
    ).toEqual({ tool: 'accounts.update', entityId: 'acc-1' });
  });

  it('rename com presentation account vincula entityId do label resolvido', () => {
    expect(
      resolveExpectedContext({
        tool: 'accounts.update',
        presentation: { account: { id: 'acc-9', label: 'Nubank' } },
      }),
    ).toEqual({ tool: 'accounts.update', entityId: 'acc-9' });
  });

  it('rename sem target (sem accountId nem presentation) não tem contexto', () => {
    expect(resolveExpectedContext({ tool: 'accounts.update' })).toBeUndefined();
  });

  it('deactivate sem target não tem contexto', () => {
    expect(resolveExpectedContext({ tool: 'accounts.deactivate' })).toBeUndefined();
  });

  it('deactivate com accountId vincula tool + entity', () => {
    expect(
      resolveExpectedContext({ tool: 'accounts.deactivate', accountId: 'acc-2' }),
    ).toEqual({ tool: 'accounts.deactivate', entityId: 'acc-2' });
  });

  it('create vincula só kind (entidade ainda não existe — sem bloquear)', () => {
    expect(resolveExpectedContext({ tool: 'accounts.create' })).toEqual({
      tool: 'accounts.create',
    });
  });

  it('transação vincula só kind', () => {
    expect(resolveExpectedContext({ tool: 'transactions.expense.create' })).toEqual({
      tool: 'transactions.expense.create',
    });
  });

  it('transactions.update exige e deriva o target do presentation autoritativo', () => {
    expect(resolveExpectedContext({ tool:'transactions.update' })).toBeUndefined();
    expect(resolveExpectedContext({ tool:'transactions.update', presentation:{ transactionTargetId:'tx-7' } })).toEqual({ tool:'transactions.update', entityId:'tx-7' });
  });

  it('registro ausente ou sem tool não tem contexto (nunca inventado)', () => {
    expect(resolveExpectedContext(null)).toBeUndefined();
    expect(resolveExpectedContext(undefined)).toBeUndefined();
    expect(resolveExpectedContext({ tool: '' })).toBeUndefined();
    expect(resolveExpectedContext({ tool: '   ' })).toBeUndefined();
  });
});
