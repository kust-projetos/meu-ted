import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInMemoryStores } from '../../src/writes/in-memory.js';

describe('keyed transaction description foundation', () => {
  it('edits only the description, uses exact CAS, and replays its original snapshot', async () => {
    const { state, writes } = createInMemoryStores();
    const tx = {
      id: randomUUID(), householdId: 'description-workspace', kind: 'expense' as const,
      description: '  Original  ', amountCents: 1234, date: '2026-10-20', accountId: randomUUID(), notes: 'keep',
    };
    state.transactions.push(tx);
    const input = { transactionId: tx.id, description: 'Nova descrição', expectedDescription: '  Original  ' };
    const first = await writes.editTransactionDescription(tx.householdId, input, { idempotencyKey: 'description-key', actorId: 'actor-server' });
    expect(first.description).toBe('Nova descrição');
    expect(state.transactions[0]).toMatchObject({ ...tx, description: 'Nova descrição' });
    const replay = await writes.editTransactionDescription(tx.householdId, input, { idempotencyKey: 'description-key', actorId: 'actor-server' });
    expect(replay.description).toBe('Nova descrição');
    await expect(writes.editTransactionDescription(tx.householdId,
      { ...input, description: 'Outro' }, { idempotencyKey: 'description-key', actorId: 'actor-server' }))
      .rejects.toMatchObject({ code: 'idempotency.conflict' });
    await expect(writes.editTransactionDescription(tx.householdId,
      { ...input, transactionId: randomUUID() }, { idempotencyKey: 'other-key', actorId: 'actor-server' }))
      .rejects.toMatchObject({ code: 'not_found' });
    state.deletedTransactions.add(tx.id);
    expect((await writes.editTransactionDescription(tx.householdId, input, { idempotencyKey: 'description-key', actorId: 'actor-server' })).description)
      .toBe('Nova descrição'); // completed replay precedes current eligibility
    expect(tx).toMatchObject({ amountCents: 1234, date: '2026-10-20', notes: 'keep' });
  });

  it('rejects unsupported transaction kind and linked payment rows without changing data', async () => {
    const { state, writes } = createInMemoryStores();
    const transfer = { id: randomUUID(), householdId: 'description-workspace', kind: 'transfer' as const,
      description: 'Transfer', amountCents: 700, date: '2026-10-20', accountId: randomUUID() };
    state.transactions.push(transfer);
    await expect(writes.editTransactionDescription(transfer.householdId,
      { transactionId: transfer.id, description: 'Edited', expectedDescription: 'Transfer' },
      { idempotencyKey: 'transfer-key', actorId: 'actor-server' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(transfer.description).toBe('Transfer');
  });

  it('validates description lengths while preserving an exact, untrimmed expected value', async () => {
    const { state, writes } = createInMemoryStores();
    const tx = { id: randomUUID(), householdId: 'description-workspace', kind: 'income' as const,
      description: 'old', amountCents: 500, date: '2026-10-20', accountId: randomUUID() };
    state.transactions.push(tx);
    await expect(writes.editTransactionDescription(tx.householdId,
      { transactionId: tx.id, description: '  ', expectedDescription: 'old' }, { idempotencyKey: 'invalid', actorId: 'actor-server' }))
      .rejects.toMatchObject({ code: 'validation.invalid' });
    await expect(writes.editTransactionDescription(tx.householdId,
      { transactionId: tx.id, description: 'new', expectedDescription: ' old ' }, { idempotencyKey: 'stale', actorId: 'actor-server' }))
      .rejects.toMatchObject({ code: 'transaction.description_conflict' });
    await expect(writes.editTransactionDescription(tx.householdId,
      { transactionId: tx.id, description: ' old ', expectedDescription: 'old' }, { idempotencyKey: 'noop', actorId: 'actor-server' }))
      .rejects.toMatchObject({ code: 'validation.invalid' });
    expect(tx.description).toBe('old');
  });

  it('same-key concurrent calls produce one effect and return detached snapshots', async () => {
    const { state, writes } = createInMemoryStores();
    const tx = { id: randomUUID(), householdId: 'description-workspace', kind: 'expense' as const,
      description: 'old', amountCents: 500, date: '2026-10-20', accountId: randomUUID() };
    state.transactions.push(tx);
    const input = { transactionId: tx.id, description: 'new', expectedDescription: 'old' };
    const [left, right] = await Promise.all([
      writes.editTransactionDescription(tx.householdId, input, { idempotencyKey: 'parallel', actorId: 'actor-server' }),
      writes.editTransactionDescription(tx.householdId, input, { idempotencyKey: 'parallel', actorId: 'actor-server' }),
    ]);
    left.description = 'caller mutation';
    expect(right.description).toBe('new');
    expect((await writes.editTransactionDescription(tx.householdId, input, { idempotencyKey: 'parallel', actorId: 'actor-server' })).description).toBe('new');
  });

  it('conservatively rejects any persisted card-purchase link', async () => {
    const { state, writes } = createInMemoryStores();
    const tx = { id: randomUUID(), householdId: 'description-workspace', kind: 'expense' as const,
      description: 'card', amountCents: 500, date: '2026-10-20', accountId: randomUUID() };
    state.transactions.push(tx);
    (state as unknown as { _cardPurchases: Array<{ transactionId: string }> })._cardPurchases = [{ transactionId: tx.id }];
    await expect(writes.editTransactionDescription(tx.householdId,
      { transactionId: tx.id, description: 'new', expectedDescription: 'card' }, { idempotencyKey: 'card-link', actorId: 'actor-server' }))
      .rejects.toMatchObject({ code: 'unsupported' });
    expect(tx.description).toBe('card');
  });
});
