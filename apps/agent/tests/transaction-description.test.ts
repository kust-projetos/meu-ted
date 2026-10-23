import { describe, expect, it } from 'vitest';
import { hasTransactionDescriptionSignal, parseTransactionDescriptionEdit, resolveTransactionDescriptionTarget } from '../src/mutations/transaction-description.js';

const tx = (id: string, description: string, scopeId = 'ws') => ({ id, description, amountCents:1500, date:'2026-10-20', accountId:'acc', kind:'expense' as const, scopeId });

describe('transactions.update deterministic description flow', () => {
  it('parses explicit old-to-new text without treating decision words as new descriptions', () => {
    expect(hasTransactionDescriptionSignal('altere a descrição do lançamento Mercado para Feira')).toBe(true);
    expect(parseTransactionDescriptionEdit('altere a descrição do lançamento Mercado para Feira da semana')).toEqual({ targetHint:'Mercado', description:'Feira da semana' });
    expect(parseTransactionDescriptionEdit('altere a descrição do lançamento Mercado')).toEqual({ targetHint:'Mercado' });
    expect(parseTransactionDescriptionEdit('altere a descrição do lançamento Mercado para cancelar')).toEqual({ targetHint:'Mercado' });
    expect(hasTransactionDescriptionSignal('não altere o lançamento')).toBe(false);
  });

  it('resolves only one exact in-scope simple transaction, never a partial or newest match', () => {
    expect(resolveTransactionDescriptionTarget('Mercado', [tx('tx-1','Mercado')], 'ws')).toMatchObject({kind:'resolved',transaction:{id:'tx-1'}});
    expect(resolveTransactionDescriptionTarget('Mercado', [tx('tx-1','Mercado'),tx('tx-2','Mercado')], 'ws')).toEqual({kind:'ambiguous'});
    expect(resolveTransactionDescriptionTarget('Merc', [tx('tx-1','Mercado')], 'ws')).toEqual({kind:'missing'});
    expect(resolveTransactionDescriptionTarget('Mercado', [tx('tx-1','Mercado','other')], 'ws')).toEqual({kind:'missing'});
  });
});
