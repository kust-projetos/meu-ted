import { describe, expect, it } from 'vitest';
import { requiresExpectedEntity, resolveExpectedContext } from '../../src/mutations/expected-context.js';

describe('expected context — payables (V1 completion)', () => {
  it('payables.create binds kind only (the payable does not exist yet)', () => {
    expect(requiresExpectedEntity('payables.create')).toBe(false);
    expect(resolveExpectedContext({ tool: 'payables.create', accountId: 'account-1' })).toEqual({
      tool: 'payables.create',
    });
  });

  it('payables.pay requires the pre-existing payable id', () => {
    expect(requiresExpectedEntity('payables.pay')).toBe(true);
    expect(resolveExpectedContext({ tool: 'payables.pay' })).toBeUndefined();
    expect(resolveExpectedContext({ tool: 'payables.pay', payableId: '  ' })).toBeUndefined();
    expect(resolveExpectedContext({ tool: 'payables.pay', payableId: ' payable-1 ' })).toEqual({
      tool: 'payables.pay',
      entityId: 'payable-1',
    });
  });
});
