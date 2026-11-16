import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalPolicy, isAutoCreatableCategory } from '../../src/approvals/policy.js';
import { getApprovalToolContract } from '../../src/approvals/tool-registry.js';

afterEach(() => vi.unstubAllEnvs());

describe('Pending V2 category auto-creation policy', () => {
  const decide = (args: unknown) => createApprovalPolicy().evaluateMutation({
    tool: 'categories.create', args, complete: true, explicitIntent: true,
  });

  it('keeps categories manual with flag off and exact flag parsing', () => {
    for (const value of [undefined, '', 'true', ' 1 ']) {
      if (value === undefined) vi.stubEnv('PENDING_V2_CATEGORY_AUTOCREATE_ENABLED', '');
      else vi.stubEnv('PENDING_V2_CATEGORY_AUTOCREATE_ENABLED', value);
      expect(isAutoCreatableCategory({ name: 'Streaming', kind: 'expense' })).toBe(false);
      expect(decide({ name: 'Streaming', kind: 'expense' }).action).toBe('require_confirmation');
    }
  });

  it('auto-executes only a root category with a bounded, clean name and known kind', () => {
    vi.stubEnv('PENDING_V2_CATEGORY_AUTOCREATE_ENABLED', '1');
    expect(decide({ name: 'Streaming', kind: 'expense' }).action).toBe('auto_execute');
    expect(decide({ name: 'Alimentação'.normalize('NFD'), kind: 'expense' }).action).toBe('auto_execute');
    for (const args of [
      { name: 'x'.repeat(61), kind: 'expense' },
      { name: '', kind: 'expense' },
      { name: 'a\nb', kind: 'expense' },
      { name: 'Stream\u200Bing', kind: 'expense' },
      { name: '\u200DStreaming\u200D', kind: 'expense' },
      { name: 'Streaming', kind: 'other' },
      { name: 'Streaming', kind: 'expense', parentId: '00000000-0000-4000-8000-000000000001' },
      { name: 'Streaming', kind: 'expense', other: true },
    ]) {
      expect(decide(args).action).toBe('require_confirmation');
    }
    expect(getApprovalToolContract('categories.create')?.autoExecutionEligible).toBe(true);
    for (const tool of ['transactions.expense.create', 'transactions.income.create'] as const) {
      expect(getApprovalToolContract(tool)?.autoExecutionEligible).toBe(true);
      expect(createApprovalPolicy().evaluateMutation({
        tool, amountCents: 100, complete: true, explicitIntent: true,
      })).toEqual({ action: 'auto_execute', risk: 'low', reason: 'explicit_low_risk' });
    }
    expect(getApprovalToolContract('accounts.create')?.autoExecutionEligible).toBe(false);
    expect(getApprovalToolContract('transactions.transfer.create')?.autoExecutionEligible).toBe(false);
  });

  it('surfaces a duplicate as a typed 409 and creates nothing', async () => {
    vi.stubEnv('PENDING_V2_CATEGORY_AUTOCREATE_ENABLED', '1');
    const { createInMemoryStores } = await import('../../src/writes/in-memory.js');
    const { writes, state } = createInMemoryStores();
    await writes.createCategory('ws', { name: 'Café', kind: 'expense' });
    const executor = getApprovalToolContract('categories.create')!.executor;
    await expect(executor({
      writes, workspaceId: 'ws', args: { name: 'CAFÉ', kind: 'expense' },
      idempotencyKey: 'duplicate-category', actorId: 'actor',
    })).rejects.toMatchObject({ statusCode: 409, code: 'in_use' });
    expect(state.categories).toHaveLength(1);
  });
});
