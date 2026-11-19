import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryMemoryFingerprint, normalizeMemoryValue, isForgetTombstoneActive, shouldReplaceMemory } from '../src/category-memory-core.mjs';

test('fingerprint is stable, normalized and scoped', () => {
  const a = categoryMemoryFingerprint({ workspaceId: ' w ', actorId: 'a', target: ' café ', field: 'category' });
  assert.equal(a, categoryMemoryFingerprint({ workspaceId: 'w', actorId: 'a', target: 'café', field: 'category' }));
  assert.notEqual(a, categoryMemoryFingerprint({ workspaceId: 'x', actorId: 'a', target: 'café', field: 'category' }));
  assert.equal(
    categoryMemoryFingerprint({ workspaceId: 'w', actorId: 'a', target: 'Mercado', field: 'category' }),
    categoryMemoryFingerprint({ workspaceId: 'w', actorId: 'a', target: 'mercado', field: 'category' }),
  );
});

test('normalization rejects controls and secret-like values', () => {
  assert.equal(normalizeMemoryValue('  Café  '), 'Café');
  for (const value of ['x\u0000y', 'x\u200By', '550e8400-e29b-41d4-a716-446655440000', 'sk_abcdefghijklmnop']) assert.equal(normalizeMemoryValue(value), null);
});

test('active tombstones prevent learning; newer/confident values replace while duplicates do not', () => {
  const tombstone = { value: 'x', tombstoneAt: 10, expiresAt: 100 };
  assert.equal(isForgetTombstoneActive(tombstone, 50), true);
  assert.equal(shouldReplaceMemory(tombstone, { value: 'y', updatedAt: 60, confidence: 1 }, 50), false);
  assert.equal(shouldReplaceMemory({ value: 'x', updatedAt: 10 }, { value: 'x', updatedAt: 20 }, 30), false);
  assert.equal(shouldReplaceMemory({ value: 'x', updatedAt: 10 }, { value: 'y', updatedAt: 20 }, 30), true);
});
