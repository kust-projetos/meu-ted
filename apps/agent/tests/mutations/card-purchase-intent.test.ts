import { describe, expect, it } from 'vitest';
import { hasInstallmentIntent, hasWholeEntityName, isCardPurchaseIntent } from '../../src/mutations/card-purchase-intent.js';

describe('isCardPurchaseIntent', () => {
  it('recognizes explicit card purchases but excludes statement, debit and read intents', () => {
    expect(isCardPurchaseIntent('Comprei R$ 120 no cartão Nubank')).toBe(true);
    expect(isCardPurchaseIntent('Comprei R$ 120 no cartão em 05/11')).toBe(true);
    expect(isCardPurchaseIntent('Comprei R$ 120 no débito')).toBe(false);
    expect(isCardPurchaseIntent('paguei a fatura do cartão Nubank')).toBe(false);
    expect(isCardPurchaseIntent('quanto gastei no cartão Nubank?')).toBe(false);
  });

  it.each(['R$ 600 em 3 vezes no cartão Nubank', 'R$ 50 em 12 parcelas no cartão Nubank', 'parcelei 600 no cartão Nubank', 'R$ 600 parcelado no cartão Nubank', 'R$ 600 em três vezes no cartão Nubank', 'R$ 600 na prestação do cartão Nubank', 'R$ 600 em parcelas no cartão Nubank', 'R$ 600 parcelas no cartão Nubank', 'dividi R$ 600 no cartão Nubank', 'valor dividido no cartão Nubank', 'compra dividida no cartão Nubank', 'R$ 600 a prazo no cartão Nubank', 'R$ 600 em 3× no cartão Nubank', 'R$ 600 em quinze vezes no cartão Nubank', 'R$ 600 em dezesseis vezes no cartão Nubank', 'R$ 600 em dezessete vezes no cartão Nubank', 'R$ 600 em dezoito vezes no cartão Nubank', 'R$ 600 em dezenove vezes no cartão Nubank', 'R$ 600 em vinte vezes no cartão Nubank', 'R$ 600 em trinta vezes no cartão Nubank', 'Comprei R$ 600 em 3x, no cartão Nubank', 'Comprei R$ 600 no cartão Nubank em 10x.', '(3x)'])('fails closed for installment wording: %s', (text) => {
    expect(hasInstallmentIntent(text)).toBe(true);
  });

  it.each(['Comprei R$ 3 no cartão Nubank e comprei 3 xícaras', 'Comprei R$ 12 no cartão Nubank e comprei 12 pratos'])('does not mistake item counts for installments: %s', (text) => {
    expect(hasInstallmentIntent(text)).toBe(false);
  });

  it('matches entity names on word boundaries', () => {
    expect(hasWholeEntityName('Comprei R$ 120 no cartão Nubank', 'Nubank')).toBe(true);
    expect(hasWholeEntityName('Comprei no cartão Visa, abri o menu', 'Nu')).toBe(false);
    expect(hasWholeEntityName('Comprei uma caixa de som', 'Caixa')).toBe(false);
    expect(hasWholeEntityName('Comprei uma caixa de som', 'Caixa de som')).toBe(true);
    expect(hasWholeEntityName('acessei a internet', 'Inter')).toBe(false);
  });
});
