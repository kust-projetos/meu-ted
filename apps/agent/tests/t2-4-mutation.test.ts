import { describe, expect, it, vi } from 'vitest';
import { parseFinancialMutation } from '../src/mutations/financial-parser.js';
import { resolveEntity } from '../src/tools/entity-resolution.js';
import { MutationExecutor } from '../src/mutations/mutation-executor.js';

describe('T2.4 mutation pipeline', () => {
  it('parses decimal money as integer cents and relative date', () => {
    const result = parseFinancialMutation('Gastei R$ 12,34 no mercado ontem');
    expect(result).toMatchObject({ kind: 'expense', amountCents: 1234, description: 'mercado' });
    if (result.kind !== 'none') expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('prefers the explicit R$ amount when an account name contains a digit', () => {
    const marker = 'Teste E2E mobile TED marker';
    const result = parseFinancialMutation(`Na conta Conta E2E Mobile abc123, categoria Lanche, hoje gastei R$ 12,34 ${marker}`);
    expect(result).toMatchObject({ kind: 'expense', amountCents: 1234, description: marker });
  });

  it('rejects negated mutation and missing amount', () => {
    expect(parseFinancialMutation('não gastei R$ 10 no mercado')).toMatchObject({ kind: 'none', reason: 'negation' });
    expect(parseFinancialMutation('gastei no mercado')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
  });

  it('parses Brazilian thousands with R$ prefix as full value', () => {
    expect(parseFinancialMutation('Gastei R$ 1.234,56 no mercado')).toMatchObject({ kind: 'expense', amountCents: 123456 });
  });

  it('rejects malformed R$ currency without partial match', () => {
    expect(parseFinancialMutation('Gastei R$ 12,345 no mercado')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
  });

  it('rejects grouped amount above MAX_SAFE_INTEGER', () => {
    expect(parseFinancialMutation('Gastei R$ 90.071.992.547.409,92 no mercado')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
  });

  it('fails closed on malformed R$ token even with later valid R$ token', () => {
    expect(parseFinancialMutation('Gastei R$ 12,345 e R$ 20 no mercado')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
    expect(parseFinancialMutation('Gastei R$ 10 e R$ 20 no mercado')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
  });

  it('fails closed on malformed R$ marker without falling back to bare digits', () => {
    expect(parseFinancialMutation('Gastei R$ -12,34 no mercado')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
    expect(parseFinancialMutation('Gastei R$ no mercado 20')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
  });

  it('rejects multi-action utterances as unsupported', () => {
    expect(parseFinancialMutation('Gastei 10 no mercado e recebi 20')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('parses receita as income', () => {
    expect(parseFinancialMutation('Receita R$ 100,00')).toMatchObject({ kind: 'income', amountCents: 10000 });
  });

  it('accepts single finite verb with context nouns as one action', () => {
    expect(parseFinancialMutation('Recebi R$ 100 de salário')).toMatchObject({ kind: 'income', amountCents: 10000 });
    expect(parseFinancialMutation('Gastei R$ 10 numa compra')).toMatchObject({ kind: 'expense', amountCents: 1000 });
  });

  it('ignores digits in account names for unprefixed amounts after a mutation verb', () => {
    const result = parseFinancialMutation('Na conta Conta E2E Mobile abc123, hoje gastei 12,34 mercado');
    expect(result).toMatchObject({ kind: 'expense', amountCents: 1234, description: 'mercado' });
  });

  it('rejects noun-only multi-intent utterance without finite verbs as unsupported', () => {
    expect(parseFinancialMutation('Receita 10 e despesa 20')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('gives finite verbs priority over contextual nouns of the opposite type', () => {
    expect(parseFinancialMutation('Gastei R$ 10 com receita')).toMatchObject({ kind: 'expense', amountCents: 1000 });
    expect(parseFinancialMutation('Paguei R$ 10 de salário')).toMatchObject({ kind: 'expense', amountCents: 1000 });
    expect(parseFinancialMutation('Recebi R$ 10 de compra')).toMatchObject({ kind: 'income', amountCents: 1000 });
  });

  it('accepts noun-only same-type pairs with an explicit amount', () => {
    expect(parseFinancialMutation('Receita de salário R$ 100')).toMatchObject({ kind: 'income', amountCents: 10000 });
    expect(parseFinancialMutation('Despesa de compra R$ 10')).toMatchObject({ kind: 'expense', amountCents: 1000 });
  });

  it('fails closed when a single action lists two amounts joined by e', () => {
    expect(parseFinancialMutation('Gastei R$ 10 e 20 de gorjeta')).toMatchObject({ kind: 'none', reason: 'unsupported' });
    expect(parseFinancialMutation('Gastei 10 e 20 no mercado')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('fails closed on comma enumeration after the primary amount', () => {
    expect(parseFinancialMutation('Gastei R$ 10 no mercado, 20 de gorjeta')).toMatchObject({ kind: 'none', reason: 'unsupported' });
    expect(parseFinancialMutation('Gastei 10 no mercado, 20')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('fails closed on comma-list secondary amount with descriptive label', () => {
    expect(parseFinancialMutation('Gastei R$ 10 no mercado, gorjeta 20')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('fails closed on connector secondary amount with monetary label', () => {
    expect(parseFinancialMutation('Gastei R$ 10 no mercado e gorjeta 20')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('fails closed on labelled secondary amount with natural qualifiers', () => {
    expect(parseFinancialMutation('Gastei R$ 10 no mercado, gorjeta de 20')).toMatchObject({ kind: 'none', reason: 'unsupported' });
    expect(parseFinancialMutation('Gastei R$ 10 no mercado e a gorjeta 20')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('does not treat a date after comma as a second money value', () => {
    expect(parseFinancialMutation('Gastei R$ 10 no mercado, dia 29/09')).toMatchObject({ kind: 'expense', amountCents: 1000 });
  });

  it('keeps live-like E2E marker as single amount without comma/account false positive', () => {
    const marker = 'Teste E2E mobile TED marker';
    const result = parseFinancialMutation(`Na conta Conta E2E Mobile abc123, categoria Lanche, hoje gastei R$ 12,34 ${marker}`);
    expect(result).toMatchObject({ kind: 'expense', amountCents: 1234 });
    if (result.kind !== 'none') expect(result.description).toBe(marker);
  });

  it('fails closed when a plausible amount precedes the explicit R$ amount', () => {
    expect(parseFinancialMutation('Gastei 10 e R$ 20 no mercado')).toMatchObject({ kind: 'none', reason: 'unsupported' });
    expect(parseFinancialMutation('Gastei 10 no mercado e R$ 20 de gorjeta')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('treats lancei/lancar as neutral without forced expense direction', () => {
    expect(parseFinancialMutation('Lancei uma receita R$ 100')).toMatchObject({ kind: 'income', amountCents: 10000 });
    expect(parseFinancialMutation('Lancei uma despesa R$ 100')).toMatchObject({ kind: 'expense', amountCents: 10000 });
    expect(parseFinancialMutation('Lancei R$ 100 no mercado')).toMatchObject({ kind: 'none', reason: 'unsupported' });
    expect(parseFinancialMutation('Lancei receita e despesa R$ 100')).toMatchObject({ kind: 'none', reason: 'unsupported' });
  });

  it('rejects explicit R$ dot-decimal as malformed Brazilian currency', () => {
    expect(parseFinancialMutation('Gastei R$ 12.34 no mercado')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
  });

  it('resolves only an unambiguous entity and asks for similar names', async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ id: '1', name: 'Nubank Reserva' }, { id: '2', name: 'Nubank Reserve' }] });
    await expect(resolveEntity({ type: 'account', query: 'Nubank', request })).rejects.toMatchObject({ code: 'entity.ambiguous' });
  });

  it('executes with opaque attestation and derives success from API result', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'pending-1', status: 'succeeded', execution: { status: 'succeeded', operationId: 'mut-pending-1', receipt: { mutationId: 'mut-pending-1', mutationKind: 'transactions.expense.create', status: 'succeeded', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'], operationId: 'pending-1', entity: { type: 'transaction', id: 'mut-pending-1' } } } });
    const executor = new MutationExecutor({ request });
    const result = await executor.execute({ operationId: 'pending-1', attestation: 'a'.repeat(32), identity: { workspaceId: 'w', actorId: 'a', deviceId: 'd' } });
    expect(result).toEqual({ status: 'succeeded', operationId: 'pending-1', receipt: { mutationId: 'mut-pending-1', mutationKind: 'transactions.expense.create', status: 'succeeded', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'], operationId: 'pending-1', entity: { type: 'transaction', id: 'mut-pending-1' } } });
    expect(request).toHaveBeenCalledWith('POST', '/pending-operations/v2/pending-1/execute', expect.objectContaining({ body: { attestation: 'a'.repeat(32) } }));
  });
});
