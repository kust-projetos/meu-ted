import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInvariants } from './check-agent-v2-invariants.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const fixtures = (...names) => path.join(ROOT, '__fixtures__', 'agent-v2-invariants', ...names);
const A5_DENYLIST_PARSER = 'apps/agent/src/poc-structured/structured-interpretation.ts';

test('accepts a compliant V2 production fixture', () => {
  const result = checkInvariants(fixtures('compliant'));
  assert.deepEqual(result.diagnostics, []);
});

test('reports each architectural invariant violation with stable codes', () => {
  const result = checkInvariants(fixtures('violations'));
  assert.deepEqual(new Set(result.diagnostics.map((item) => item.code)), new Set([
    'A2_EXEC_ACTION',
    'A3_DIRECT_NAMESPACE',
    'A4_WRITE_CAPABILITY_OUTSIDE_EXECUTOR',
    'A5_MUTATION_ISSUER_OUTSIDE_EXECUTOR',
    'A6_BINDING_MANIFEST_INCOMPLETE',
    'A7_PWA_DIRECT_PENDING_OPERATION',
    'A8_PWA_ATTESTATION_EXPOSURE',
  ]));
});

test('excludes docs, tests, fixtures and generated files from production scan', () => {
  const result = checkInvariants(fixtures('excluded'));
  assert.deepEqual(result.diagnostics, []);
});

test('exempts only the exact readonly denylist definition in the structured POC parser', () => {
  const result = checkInvariants(fixtures('a5-denylist', 'allowed'));
  assert.deepEqual(result.diagnostics, []);
});

test('keeps the A5 denylist member in place instead of deleting it to silence the gate', () => {
  const source = readFileSync(fixtures('a5-denylist', 'allowed', A5_DENYLIST_PARSER), 'utf8');
  assert.match(source, /FORBIDDEN_NORMALIZED_KEYS[\s\S]*'mutationApproved'/);
});

test('still reports A5 issuers injected around or outside the exact denylist definition', () => {
  const result = checkInvariants(fixtures('a5-denylist', 'rejected'));
  assert.deepEqual(new Set(result.diagnostics.map((item) => item.code)), new Set([
    'A5_MUTATION_ISSUER_OUTSIDE_EXECUTOR',
  ]));
  const perFile = new Map();
  for (const item of result.diagnostics) {
    perFile.set(item.file, (perFile.get(item.file) ?? 0) + 1);
  }
  // Any non-string member (object/array/computed) fails the whole constant
  // closed, so even its own direct string member flags again. Declaration-
  // adjacent objects and quoted keys stay violations too.
  assert.equal(perFile.get(A5_DENYLIST_PARSER), 6);
  const structuredLines = result.diagnostics
    .filter((item) => item.file === A5_DENYLIST_PARSER)
    .map((item) => item.line)
    .sort((left, right) => left - right);
  assert.deepEqual(structuredLines, [1, 4, 6, 7, 10, 11]);
  // A renamed constant is not the recognized denylist definition.
  assert.equal(perFile.get('apps/agent/src/poc-structured/renamed-denylist.ts'), 1);
  // A quoted string in an unrelated file stays a violation.
  assert.equal(perFile.get('apps/agent/src/unrelated-issuer.ts'), 1);
  assert.equal(result.diagnostics.length, 8);
});
