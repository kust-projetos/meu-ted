import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryPayableStore } from '../../src/payables/in-memory.js';
import type { PayableStore } from '../../src/payables/store.js';
import { HOUSEHOLD_A } from '../fixtures/seed.js';

describe('G2.2.5 — Unit of Work contracts', () => {
  it('exposes one atomic command for payable plus template creation', async () => {
    const { state } = createInMemoryStores();
    const store: PayableStore = createInMemoryPayableStore(state);

    const payable = await store.createPayableWithTemplate(HOUSEHOLD_A, {
      payable: {
        accountId: crypto.randomUUID(),
        description: 'Internet',
        amountCents: 9990,
        dueDate: '2026-08-10',
        type: 'recurring',
        frequency: 'monthly',
      },
      template: {
        accountId: crypto.randomUUID(),
        name: 'Internet template',
        description: 'Internet',
        amountCents: 9990,
        frequency: 'monthly',
        dayOfMonth: 10,
      },
    });

    expect(payable.householdId).toBe(HOUSEHOLD_A);
    expect(state).toHaveProperty('_payables');
    expect((state as { _templates?: unknown[] })._templates).toHaveLength(1);
  });

  it('routes payable creation through the composite keyed command', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../src/routes/payables.ts'), 'utf8');
    // V4.1 Phase 3 (UOW2): keyed producers run the store effect on the
    // idempotency claim client via the dispatcher — never directly.
    expect(source).toContain('runPayableMutation');
    expect(source).toContain(`'createWithTemplate'`);
    expect(source).not.toContain('await opts.payableStore.createPayable(ctx.householdId, {');
    expect(source).not.toContain('await opts.payableStore.createPayableWithTemplate(');
  });

  it.each([
    ['cards/postgres.ts', 'createCardPurchase'],
    ['cards/postgres.ts', 'createRecurringPurchase'],
    ['cards/postgres.ts', 'updatePurchase'],
    ['cards/postgres.ts', 'updateCard'],
    ['goals/postgres.ts', 'contributeToGoal'],
    ['payables/postgres.ts', 'markPayablePaid'],
    ['payables/postgres.ts', 'undoPayablePayment'],
    ['payables/postgres.ts', 'createPayableWithTemplate'],
  ])('%s:%s has a transaction boundary', (file, method) => {
    const source = readFileSync(resolve(import.meta.dirname, `../../src/${file}`), 'utf8');
    const start = source.indexOf(`async ${method}`);
    const end = source.indexOf('\n    async ', start + 1);
    const block = source.slice(start, end === -1 ? undefined : end);
    expect(block).toContain('withTransaction(pool');
  });
});
