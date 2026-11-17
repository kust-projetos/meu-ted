import test from 'node:test';
import assert from 'node:assert/strict';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';

test('peek is non-destructive, frozen intent can be taken, and clear removes it', () => {
  const registry = createProposalIntentRegistry();
  const original = { tool: 'categories.create', normalizedArgs: { name: 'Food' } };
  registry.record('session', original);
  original.tool = 'changed';
  const peeked = registry.peek('session');
  assert.equal(peeked.tool, 'categories.create');
  assert.equal(Object.isFrozen(peeked), true);
  assert.equal(registry.peek('session'), peeked);
  assert.equal(registry.take('session'), peeked);
  assert.equal(registry.peek('session'), null);
  registry.record('session', { tool: 'categories.create' });
  registry.clear('session');
  assert.equal(registry.peek('session'), null);
});
