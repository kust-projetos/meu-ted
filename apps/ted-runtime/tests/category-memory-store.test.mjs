import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';
import { openCategoryMemoryStore } from '../src/category-memory-store.mjs';

test('category memory is scoped, tombstoned, expires, and closes', () => {
  const dir = approvedTmpRoot('category-memory');
  const store = openCategoryMemoryStore({ dbPath: path.join(dir, 'memory.sqlite'), ttlMs: 1000 });
  const entry = { workspaceId: 'w', actorId: 'a', target: 'conversation-1', field: 'category' };
  assert.equal(store.remember({ ...entry, value: 'Alimentação' }), true);
  assert.equal(store.recall(entry).value, 'Alimentação');
  assert.equal(store.recall({ ...entry, actorId: 'b' }), null);
  store.forget(entry);
  assert.equal(store.remember({ ...entry, value: 'Lazer' }), false);
  assert.equal(store.recall(entry), null);
  assert.equal(store.sweepExpired(Date.now() + 2000), 1);
  store.close();
  assert.equal(fs.existsSync(path.join(dir, 'memory.sqlite')), true);
});

test('scope row cap evicts ordinary memory but preserves active forget tombstones through sweep', () => {
  const dir = approvedTmpRoot('category-memory-cap');
  const store = openCategoryMemoryStore({ dbPath: path.join(dir, 'memory.sqlite') });
  const scope = { workspaceId: 'w', actorId: 'a', field: 'category' };
  const forgotten = { ...scope, target: 'forgotten' };
  store.forget(forgotten);
  for (let i = 0; i < 201; i++) store.remember({ ...scope, target: `target-${i}`, value: `Category ${i}` });
  assert.equal(store.recall(forgotten), null);
  assert.equal(store.remember({ ...forgotten, value: 'Relearned' }), false);
  store.sweepExpired(Date.now());
  assert.equal(store.remember({ ...forgotten, value: 'Still forgotten' }), false);
  assert.equal(store.recall({ ...scope, target: 'target-200' }).value, 'Category 200');
  store.close();
});
