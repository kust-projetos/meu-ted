import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Wrangler 4.114 / Miniflare 4.20260722 declare `engines: { node: '>=22.0.0' }`,
// so no workspace manifest may advertise Node 20 support. The contract floor
// `>=22.12.0` keeps the pre-existing 22 patch floor, covers the Node 24
// production images, and adds no broader compatibility fiction.
const MANIFESTS = [
  'package.json',
  'apps/pwa/package.json',
  'apps/agent/package.json',
  'apps/api/package.json',
  'packages/llm-contracts/package.json',
];

const EXPECTED_NODE_RANGE = '>=22.12.0';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(relativePath, 'utf8'));
}

let wranglerEngines = null;
try {
  wranglerEngines = readJson('apps/pwa/node_modules/wrangler/package.json').engines ?? null;
} catch {
  wranglerEngines = null;
}

test('no workspace manifest claims Node 20 support', () => {
  for (const manifestPath of MANIFESTS) {
    const manifest = readJson(manifestPath);
    const range = manifest.engines?.node;
    assert.equal(range, EXPECTED_NODE_RANGE, `${manifestPath} engines.node`);
    assert.doesNotMatch(range, /(^|[^\d])20\./, `${manifestPath} must not reference Node 20`);
  }
});

test('resolved wrangler floor (Node >=22) stays satisfied by the contract', {
  skip: wranglerEngines ? false : 'wrangler not installed; run pnpm install to verify the floor linkage',
}, () => {
  const floor = Number.parseInt(wranglerEngines.node.match(/>=\s*(\d+)/)?.[1] ?? '0', 10);
  assert.ok(floor >= 22, `resolved wrangler engines floor must stay >=22 (got ${wranglerEngines.node})`);
  assert.equal(EXPECTED_NODE_RANGE, '>=22.12.0');
});

test('project baseline doc matches the engine floor', () => {
  const notes = fs.readFileSync('AGENTS.md', 'utf8');
  assert.match(notes, /Node\.js >= 22\.12\.0/);
  assert.doesNotMatch(notes, /Node\.js >= 20/);
});

test('production images run Node >=22', () => {
  for (const dockerfile of ['apps/api/Dockerfile']) {
    const body = fs.readFileSync(dockerfile, 'utf8');
    assert.match(body, /^FROM node:(2[2-9]|[3-9][0-9])/m, `${dockerfile} base image`);
  }
});
