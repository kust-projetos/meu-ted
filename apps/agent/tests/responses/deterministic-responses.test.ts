import { describe, expect, it } from 'vitest';
import { renderInconclusive, renderMutationResult } from '../../src/responses/deterministic-responses.js';

/**
 * R01 (SPEC "prova de resultado e resposta tipada"): an inconclusive
 * mutation outcome means the write WAS SENT and the result is unknown — the
 * effect may well have committed. The reply must therefore:
 *
 *  1. never claim success;
 *  2. never claim ABSENCE of effect ("Nada foi criado/cancelado") — that is
 *     an unproven assertion of fact;
 *  3. name what is unknown and point at the safe next step (check the
 *     transactions before retrying, so the user can spot a duplicate);
 *  4. agree with NO gender, so it reads correctly for any `subject` —
 *     nothing in the sentence may agree with the subject noun.
 */
describe('renderInconclusive — honest uncertainty (R01)', () => {
  it('never asserts that nothing was created or cancelled', () => {
    const text = renderInconclusive();
    expect(text).not.toMatch(/nada (foi|há) (criado|criada|cancelado|cancelada|gravado|gravada|registrado|registrada|lançado|lançada)/i);
    expect(text).not.toMatch(/não (foi|há) (criado|criada|cancelado|cancelada|gravado|gravada|registrado|registrada)/i);
  });

  it('never claims the mutation succeeded', () => {
    const text = renderInconclusive();
    expect(text).not.toMatch(/sucesso|concluíd|lançad|registrad|realizada|efetuada|processada/i);
  });

  it('states the uncertainty and gives the safe next step', () => {
    const text = renderInconclusive();
    expect(text).toMatch(/não pôde ser confirmado/i);
    expect(text).toMatch(/verifique seus lançamentos/i);
    expect(text).toMatch(/antes de tentar de novo/i);
  });

  it('agrees with no gender: only the subject varies between calls', () => {
    const defaultText = renderInconclusive();
    const masculine = renderInconclusive('pagamento');
    // Everything but the subject is identical — so no participle or adjective
    // can disagree with a subject of a different grammatical gender.
    expect(defaultText.replace('operação', '<subject>')).toBe(masculine.replace('pagamento', '<subject>'));
    expect(masculine).not.toMatch(/\b(concluída|concluído|realizada|realizado|efetuada|efetuado|processada|processado)\b/i);
  });

  it('pins the approved copy for the default subject', () => {
    expect(renderInconclusive()).toBe(
      'operação em processamento: o resultado não pôde ser confirmado. Verifique seus lançamentos antes de tentar de novo.',
    );
  });
});

describe('renderMutationResult — outcome copy por kind (contas)', () => {
  it('desativação relata conta desativada, nunca lançamento', () => {
    expect(renderMutationResult('succeeded', 'operação', { mutationKind: 'accounts.deactivate' })).toBe(
      'Conta desativada com sucesso.',
    );
  });

  it('criação relata conta criada, nunca lançamento', () => {
    expect(renderMutationResult('succeeded', 'operação', { mutationKind: 'accounts.create' })).toBe(
      'Conta criada com sucesso.',
    );
  });

  it('renomeação relata conta renomeada, nunca lançamento', () => {
    expect(renderMutationResult('succeeded', 'operação', { mutationKind: 'accounts.update' })).toBe(
      'Conta renomeada com sucesso.',
    );
  });

  it('renomeação de categoria relata categoria renomeada, nunca lançamento', () => {
    expect(renderMutationResult('succeeded', 'operação', { mutationKind: 'categories.update' })).toBe(
      'Categoria renomeada com sucesso.',
    );
  });

  it('falha de renomeação nunca afirma sucesso', () => {
    expect(renderMutationResult('failed', 'operação', { mutationKind: 'accounts.update' })).toBe(
      'Não foi possível concluir a operação.',
    );
  });

  it('transação e kinds desconhecidos mantêm o copy legado byte-idêntico', () => {
    expect(renderMutationResult('succeeded')).toBe('Lançamento registrado com sucesso.');
    expect(renderMutationResult('succeeded', 'operação', { mutationKind: 'transactions.expense.create' })).toBe(
      'Lançamento registrado com sucesso.',
    );
    expect(renderMutationResult('succeeded', 'operação', {})).toBe('Lançamento registrado com sucesso.');
  });
});