import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGatewayServer } from '../src/server.mjs';

test('gateway validates required dependencies before opening optional memory store', () => {
  assert.throws(() => createGatewayServer({ categoryMemoryDbPath: path.join('Z:\\\\nonexistent-root', 'memory.sqlite') }), /resolveIdentity is required/);
});
