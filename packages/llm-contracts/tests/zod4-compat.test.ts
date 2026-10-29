import { describe, expect, it } from 'vitest';
import { expectedVersionSchema, syncCatalogSchema, toggleEnabledSchema } from '../src/schemas.js';

describe('public schema compatibility', () => {
  it('retains explicit type errors for invalid non-missing values', () => {
    const toggle = toggleEnabledSchema.safeParse({ enabled: 'true' });
    const version = expectedVersionSchema.safeParse('1');
    expect(toggle.success).toBe(false);
    expect(version.success).toBe(false);
    if (!toggle.success) expect(toggle.error.issues[0]?.message).toBe('enabled must be boolean');
    if (!version.success) expect(version.error.issues[0]?.message).toBe('expectedVersion must be a number');
  });

  it('retains the default and rejects oversized catalog collections', () => {
    expect(syncCatalogSchema.parse({})).toEqual({ items: [] });
    const item = { providerId: 'provider', modelId: 'model' };
    expect(syncCatalogSchema.safeParse({ items: Array.from({ length: 101 }, () => item) }).success).toBe(false);
  });
});
