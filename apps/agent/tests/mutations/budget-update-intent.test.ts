import { describe, expect, it } from 'vitest';
import { extractBudgetUpdateAmount, hasThresholdIntent, isBudgetUpdateIntent, thresholdOf } from '../../src/mutations/budget-update-intent.js';

describe('budget update intent', () => {
  it.each(['Aumente o orçamento de mercado para 600', 'Ajuste o teto do budget alimentação para R$ 700'])('detects: %s', (text) => expect(isBudgetUpdateIntent(text)).toBe(true));
  it.each(['Quanto é o orçamento de mercado?', 'Não aumente o orçamento de mercado', 'Não quero mudar o orçamento de mercado', 'Crie orçamento para mercado', 'Aumente o orçamento de mercado e compre pão', 'Cancele o orçamento de mercado'])('rejects: %s', (text) => expect(isBudgetUpdateIntent(text)).toBe(false));
  it('uses the value after para and leaves threshold out of the ceiling', () => {
    expect(extractBudgetUpdateAmount('Aumente orçamento de mercado de 500 para 600', ['mercado'])).toBe(60000);
    expect(extractBudgetUpdateAmount('Aumente orçamento de mercado de 500 para ficar em 600', ['mercado'])).toBe(60000);
    expect(extractBudgetUpdateAmount('Aumente orçamento de mercado, alerta em 90%', ['mercado'])).toBeUndefined();
  });
  it('extracts a valid alert threshold', () => {
    expect(hasThresholdIntent('alerta em 90%')).toBe(true);
    expect(thresholdOf('alerta em 90%')).toBe(90);
    expect(hasThresholdIntent('limite de 80%')).toBe(true);
    expect(thresholdOf('limite de 80%')).toBe(80);
    expect(hasThresholdIntent('ajuste o limite do orçamento para 600')).toBe(false);
    expect(thresholdOf('limiar 101')).toBeUndefined();
  });
});
