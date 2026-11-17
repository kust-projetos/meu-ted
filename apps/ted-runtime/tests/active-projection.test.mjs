import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_PENDING_OPERATION_KEYS, projectActivePendingOperations } from '../src/active-projection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pwaSource = fs.readFileSync(path.join(root, 'apps/pwa/src/lib/api/agent-client.ts'), 'utf8');

it('projects only the strict PWA keys and drops malformed rows individually', () => {
  const projected = projectActivePendingOperations({ items: [
    { id:'1', status:'proposed', tool:'categories.create', createdAt:'now', expiresAt:'later', payableId:'secret', extra:'drop', presentation:null },
    { id:'2', tool:'transactions.expense.create', createdAt:'now', expiresAt:'later' },
    { id:'3', status:'failed', tool:'x', createdAt:'now', expiresAt:'later', presentation:{ unexpected:true } },
  ], total:99 });
  assert.equal(projected.total, 2);
  assert.deepEqual(projected.items[0], {
    id:'1',status:'proposed',tool:'categories.create',createdAt:'now',expiresAt:'later',presentation:null,
  });
  assert.deepEqual(projected.items[1].presentation, { unexpected:true });
});

it('keeps gateway allowlist in parity with activePendingOperationSchema', () => {
  const start = pwaSource.indexOf('const activePendingOperationSchema =');
  assert.notEqual(start, -1);
  const end = pwaSource.indexOf('.strict()', start);
  assert.notEqual(end, -1);
  const schema = pwaSource.slice(start, end);
  const pwaKeys = [...schema.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort();
  assert.deepEqual([...ACTIVE_PENDING_OPERATION_KEYS].sort(), pwaKeys);
});
