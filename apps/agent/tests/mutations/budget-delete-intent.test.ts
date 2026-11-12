import { describe, expect, it } from 'vitest';
import { isBudgetDeleteIntent } from '../../src/mutations/budget-delete-intent.js';

describe('isBudgetDeleteIntent', () => {
  it.each(['apague o orçamento', 'remova o budget de mercado', 'exclua orçamento'])('detects %s', (text) => expect(isBudgetDeleteIntent(text)).toBe(true));
  it.each(['crie o orçamento de mercado', 'aumente o orçamento', 'quanto gastei no mercado?', 'não apague o orçamento', 'apague o orçamento e crie outro', 'apague o orçamento e ajuste o teto'])('rejects %s', (text) => expect(isBudgetDeleteIntent(text)).toBe(false));
});
