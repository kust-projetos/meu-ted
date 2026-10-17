import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectRegisteredTools, validateInventory } from './check-tool-capability-inventory.mjs';

test('canonical generated tools and capability inventory remain compatible', () => {
  const tools = collectRegisteredTools();
  assert.equal(tools.length, 54);
  const result = validateInventory('docs/architecture/tool-capability-inventory.md', tools);
  // CAP-075 classifies the previously missing detect_duplicate tool, so the
  // canonical registry is fully covered again: 54 tools / 75 rows, no errors.
  assert.equal(result.rows, 75);
  assert.equal(result.tools, 54);
  assert.deepEqual(result.errors, []);
});

test('validator rejects an unclassified newly registered capability', () => {
  const tools = collectRegisteredTools();
  const result = validateInventory(
    'docs/architecture/tool-capability-inventory.md',
    [...tools, 'unclassified_test_tool'],
  );
  assert.ok(result.errors.some((error) => /registered 55 tools but inventory has 75/.test(error)));
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

test('api row without method/path is a collected error, not a ReferenceError', () => {
  const tools = collectRegisteredTools();
  const source = fs.readFileSync('docs/architecture/tool-capability-inventory.md', 'utf8');
  const lines = source.split('\n');
  const index = lines.findIndex((line) => /^\| CAP-001 \|/.test(line));
  assert.notEqual(index, -1);
  // Blank the method (cell 12) and path (cell 13) of CAP-001 in the raw
  // pipe-split line: cells[0] is empty, cells[19] is empty, so method and
  // path live at indexes 12 and 13.
  const cells = lines[index].split('|');
  cells[12] = ' ';
  cells[13] = ' ';
  lines[index] = cells.join('|');
  const tmp = path.join(os.tmpdir(), `tool-inventory-api-nomethod-${Date.now()}.md`);
  fs.writeFileSync(tmp, lines.join('\n'));
  try {
    let result;
    assert.doesNotThrow(() => {
      result = validateInventory(tmp, tools);
    }, 'validator must collect row errors instead of throwing ReferenceError');
    assert.ok(
      result.errors.some((error) => /CAP-001 is api but has no method/.test(error)),
      `expected CAP-001 missing-method error, got: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(
      result.errors.some((error) => /CAP-001 is api but has no path/.test(error)),
      `expected CAP-001 missing-path error, got: ${JSON.stringify(result.errors)}`,
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('renamed tool in a 54-name list is reported in the registered direction', () => {
  const tools = collectRegisteredTools();
  assert.equal(tools.length, 54);
  const swapped = [...tools.slice(0, tools.length - 1), 'nonexistent_fake_tool_xyz'];
  const result = validateInventory('docs/architecture/tool-capability-inventory.md', swapped);
  assert.ok(
    result.errors.some((error) => /registered tool .* has no inventory row/.test(error)),
    `expected registered-direction error, got: ${JSON.stringify(result.errors)}`,
  );
});