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

  it('rejects negated mutation and missing amount', () => {
    expect(parseFinancialMutation('não gastei R$ 10 no mercado')).toMatchObject({ kind: 'none', reason: 'negation' });
    expect(parseFinancialMutation('gastei no mercado')).toMatchObject({ kind: 'none', reason: 'missing_amount' });
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
