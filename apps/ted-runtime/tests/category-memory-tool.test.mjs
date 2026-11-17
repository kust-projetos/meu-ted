import test from 'node:test';
import assert from 'node:assert/strict';
import { productToolDefs } from '../src/plugin.mjs';
import { createToolExecutors, validateToolArgs } from '../src/tool-defs.mjs';

test('recall tool is separately gated and trusts identity only from verified host', async () => {
  assert.equal(productToolDefs({}).some((d) => d.name === 'recall_category_preference'), false);
  assert.equal(productToolDefs({ TED_OPENCODE_CATEGORY_MEMORY_ENABLED: '1' }).some((d) => d.name === 'recall_category_preference'), true);
  assert.throws(() => validateToolArgs('recall_category_preference', { workspace: 'forged' }), /forbidden key/);
  let scope;
  const executors = createToolExecutors(async () => { throw new Error('must not call transport'); });
  const output = await executors.recall_category_preference({}, {
    household: 'verified-workspace', actorId: 'verified-actor', conversationId: 'stable-conversation',
    categoryMemoryStore: { recall(input) { scope = input; return { field: 'category', value: 'Food', updatedAt: 123 }; } },
  });
  assert.deepEqual(scope, { workspaceId: 'verified-workspace', actorId: 'verified-actor', target: 'stable-conversation', field: 'category' });
  assert.deepEqual(output, { items: [{ field: 'category', value: 'Food', updatedAt: 123 }] });
  assert.equal(JSON.stringify(output).includes('verified-'), false);
  await assert.rejects(executors.recall_category_preference({}, { household: 'w', actorId: 'a' }), /verified identity\/store/);
});
