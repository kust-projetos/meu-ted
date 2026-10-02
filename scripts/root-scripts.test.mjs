import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const api = JSON.parse(fs.readFileSync('apps/api/package.json', 'utf8'));
const agent = JSON.parse(fs.readFileSync('apps/agent/package.json', 'utf8'));
const pwa = JSON.parse(fs.readFileSync('apps/pwa/package.json', 'utf8'));
const workspaceGate = fs.readFileSync('scripts/run-workspace-gate.mjs', 'utf8');

for (const [name, manifest] of Object.entries({ api, pwa })) {
  test(`${name} exposes lint, typecheck, test and build`, () => {
    for (const script of ['lint', 'typecheck', 'test', 'build']) {
      assert.equal(typeof manifest.scripts[script], 'string', `${name}.${script}`);
    }
  });
}

test('agent exposes typecheck, test and build', () => {
  for (const script of ['typecheck', 'test', 'build']) {
    assert.equal(typeof agent.scripts[script], 'string', `agent.${script}`);
  }
});

test('root gates all active apps', () => {
  for (const packageName of ['@pi-finance/llm-contracts', 'meu-ted-api', 'pi-finance-agent', 'pi-finance-codex-broker', 'pwa']) {
    assert.match(workspaceGate, new RegExp(packageName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')));
  }
  for (const script of ['test', 'build']) {
    assert.match(root.scripts[script], /meu-ted-api/);
    assert.match(root.scripts[script], /pi-finance-agent/);
    assert.match(root.scripts[script], /pi-finance-codex-broker/);
    assert.match(root.scripts[script], /pwa/);
  }
  assert.match(root.scripts.lint, /meu-ted-api/);
  assert.match(root.scripts.lint, /pwa/);
  assert.equal(root.scripts.typecheck, 'node scripts/run-workspace-gate.mjs typecheck');
  assert.equal(root.scripts['architecture:check'], 'node scripts/check-agent-v2-invariants.mjs');
});
