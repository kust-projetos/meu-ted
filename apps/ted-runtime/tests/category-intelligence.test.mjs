import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateCategory, isAutocreatableCategoryName, normalizeCategoryName } from '../src/category-intelligence.mjs';
import { clearCatalog, getCatalog, recordCatalog } from '../src/category-catalog.mjs';
import { createToolExecutors, ToolError } from '../src/tool-defs.mjs';

const host = { token: 'local-test-token' };
const intention = { intentionId: 'test-intention', sessionID: 'executor-session' };
const catalogBody = {
  items: [
    { id: 'expense-id-secret', name: 'Mercado', kind: 'expense', isActive: true },
    { id: 'income-id', name: 'Mercado', kind: 'income', isActive: true },
    { id: 'inactive-id', name: 'Lazer', kind: 'expense', isActive: false },
  ],
  total: 3,
};

function executorFor(recorded, body = catalogBody) {
  return createToolExecutors(async ({ route }) => ({
    statusCode: 200,
    body: route.startsWith('/categories') ? body : {},
  }), { proposalIntents: { record: (...args) => recorded.push(args) } });
}

async function assertInvalid(promise) {
  await assert.rejects(promise, (error) => error instanceof ToolError && error.code === 'tool.invalid_args');
}

test('category create with flag off preserves legacy intent behavior', async () => {
  const previous = process.env.TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED;
  delete process.env.TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED;
  clearCatalog(intention.sessionID);
  try {
    const recorded = [];
    const tools = executorFor(recorded);
    await tools.propose_category_create({ name: 'Nova', kind: 'expense' }, host, intention);
    await tools.propose_category_create({ name: 'Mercado', kind: 'expense' }, host, { ...intention, intentionId: 'duplicate' });
    await tools.propose_category_create({ name: 'x'.repeat(61), kind: 'income' }, host, { ...intention, intentionId: 'long' });
    assert.equal(recorded.length, 3);
  } finally {
    if (previous === undefined) delete process.env.TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED;
    else process.env.TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED = previous;
  }
});

test('category create with flag on requires catalog and rejects invalid/duplicate names', async () => {
  const previous = process.env.TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED;
  process.env.TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED = '1';
  clearCatalog(intention.sessionID);
  try {
    const recorded = [];
    const tools = executorFor(recorded);
    await assertInvalid(tools.propose_category_create({ name: 'Nova', kind: 'expense' }, host, intention));
    const returned = await tools.list_categories({}, host, intention);
    assert.deepEqual(returned, catalogBody);
    await assertInvalid(tools.propose_category_create({ name: 'x'.repeat(61), kind: 'expense' }, host, intention));
    await assert.rejects(tools.propose_category_create({ name: 'Mercado', kind: 'expense' }, host, intention),
      (error) => error.code === 'tool.invalid_args' && !error.message.includes('expense-id-secret') && error.message.includes('Mercado'));
    await tools.propose_category_create({ name: 'Lazer', kind: 'income' }, host, { ...intention, intentionId: 'other-kind' });
    await tools.propose_category_create({ name: 'Lazer', kind: 'expense' }, host, { ...intention, intentionId: 'inactive' });
    await tools.propose_category_create({ name: 'Nova', kind: 'expense' }, host, { ...intention, intentionId: 'valid' });
    assert.equal(recorded.length, 3);
  } finally {
    clearCatalog(intention.sessionID);
    if (previous === undefined) delete process.env.TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED;
    else process.env.TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED = previous;
  }
});

test('category names normalize whitespace, NFC and case for comparison', () => {
  assert.equal(normalizeCategoryName('  Cafe\u0301   DA Manhã '), 'café da manhã');
});

test('autocreatable category name enforces API length and characters', () => {
  assert.equal(isAutocreatableCategoryName('a'), true);
  assert.equal(isAutocreatableCategoryName('a'.repeat(60)), true);
  assert.equal(isAutocreatableCategoryName('a'.repeat(61)), false);
  assert.equal(isAutocreatableCategoryName(' \u0000 '), false);
  assert.equal(isAutocreatableCategoryName('a\u200Bb'), false);
});

test('duplicates require active matching kind and normalized name', () => {
  const items = [
    { id: 'inactive', name: 'Lazer', kind: 'expense', isActive: false },
    { id: 'income', name: 'LAZER', kind: 'income' },
    { id: 'match', name: '  Lazer  ', kind: 'expense' },
  ];
  assert.equal(findDuplicateCategory(items, 'lazer', 'expense').id, 'match');
  assert.equal(findDuplicateCategory({}, 'lazer', 'expense'), null);
  assert.equal(findDuplicateCategory(items, '', 'expense'), null);
});

test('catalog is copied, session-isolated, and clearable', () => {
  const body = { items: [{ id: 'secret-id', name: 'Food', kind: 'expense', privateData: 'discard' }] };
  assert.equal(recordCatalog('s1', body), true);
  body.items[0].name = 'changed';
  assert.equal(getCatalog('s1')[0].name, 'Food');
  assert.equal(getCatalog('s1')[0].privateData, undefined);
  assert.equal(getCatalog('s2'), null);
  clearCatalog('s1');
  assert.equal(getCatalog('s1'), null);
});
