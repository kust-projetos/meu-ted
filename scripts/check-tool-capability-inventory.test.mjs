import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRegisteredTools, validateInventory } from './check-tool-capability-inventory.mjs';

test('canonical generated tools and capability inventory remain compatible', () => {
  const tools = collectRegisteredTools();
  assert.equal(tools.length, 54);
  const result = validateInventory('docs/architecture/tool-capability-inventory.md', tools);
  assert.deepEqual(result, { rows: 74, tools: 54, errors: [] });
});

test('validator rejects an unclassified newly registered capability', () => {
  const tools = collectRegisteredTools();
  const result = validateInventory(
    'docs/architecture/tool-capability-inventory.md',
    [...tools, 'unclassified_test_tool'],
  );
  assert.ok(result.errors.some((error) => /registered 55 tools but inventory has 74/.test(error)));
  assert.ok(result.errors.some((error) => /registered tool unclassifiedtest has no inventory row/.test(error)));
});

test('validator rejects an inventory that drops a capability row', () => {
  const tools = collectRegisteredTools();
  const result = validateInventory(
    'docs/architecture/tool-capability-inventory.md',
    // One registered tool short of the canonical registry: the expected row
    // count must catch the drift instead of silently passing.
    tools.slice(0, tools.length - 1),
  );
  assert.ok(result.errors.length > 0);
});