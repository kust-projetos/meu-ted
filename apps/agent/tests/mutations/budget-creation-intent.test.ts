import { describe, expect, it } from 'vitest';
import { budgetPeriodOf, isBudgetCreationIntent } from '../../src/mutations/budget-creation-intent.js';

describe('budget creation intent', () => {
  it.each(['Crie um orçamento mensal', 'Cadastrar budget anual', 'Adicionar orçamento trimestral', 'Definir orçamento', 'Montar orçamento'])('detects %s', (text) => expect(isBudgetCreationIntent(text)).toBe(true));
  it.each(['Quanto custa um orçamento?', 'Qual orçamento devo criar?', 'Como criar um orçamento?', 'Posso criar um orçamento?', 'Não crie um orçamento', 'Cancele e crie um orçamento', 'Crie um orçamento e liste meus gastos', 'O orçamento mensal é útil'])('rejects %s', (text) => expect(isBudgetCreationIntent(text)).toBe(false));
  it.each([['orçamento mensal', 'monthly'], ['orçamento trimestral', 'quarterly'], ['orçamento anual', 'yearly'], ['orçamento de 12 meses', 'yearly'], ['orçamento', 'monthly']])('resolves period for %s', (text, expected) => expect(budgetPeriodOf(text)).toBe(expected));
});
