import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');

for (const job of ['api:', 'agent:', 'pwa:', 'postgres:', 'docker:', 'write-policy:']) {
  test(`root CI declares ${job.slice(0, -1)} job`, () => {
    assert.match(workflow, new RegExp(`\\n  ${job}`));
  });
}

test('root CI runs the write policy checker', () => {
  assert.match(workflow, /pnpm write-policy:check/);
  assert.match(workflow, /node --test scripts\/check-write-policy\.test\.mjs/);
});

test('root CI lints shared contracts and enforces the PWA command boundary (T13 GOV-06/07)', () => {
  assert.match(workflow, /pnpm --filter @pi-finance\/llm-contracts --fail-if-no-match lint/);
  assert.match(workflow, /pnpm boundary:check/);
});

test('root CI runs workspace builds and tests', () => {
  assert.match(workflow, /pnpm --filter meu-ted-api --fail-if-no-match build/);
  assert.match(workflow, /pnpm --filter pi-finance-agent --fail-if-no-match build/);
  assert.match(workflow, /pnpm --filter pwa --fail-if-no-match build/);
  assert.match(workflow, /pnpm --filter meu-ted-api --fail-if-no-match test/);
  assert.match(workflow, /pnpm --filter pi-finance-agent --fail-if-no-match test/);
  assert.match(workflow, /pnpm --filter pi-finance-agent --fail-if-no-match eval:ted-v2/);
  assert.match(workflow, /pnpm --filter pwa --fail-if-no-match test/);
  assert.match(workflow, /pnpm architecture:check/);
  assert.doesNotMatch(workflow, /whatsapp-bridge|bridge:/);
  assert.doesNotMatch(workflow, /node-version: ['"]20['"]/);
});

test('root CI covers the PWA Cloudflare build in the main gate', () => {
  assert.match(workflow, /\n  pwa-cloudflare:/);
  assert.match(workflow, /pnpm --dir apps\/pwa build:cloudflare/);
  assert.match(workflow, /needs: \[.*pwa-cloudflare.*\]/);
});

test('workspace CI filters fail when a package is absent', () => {
  assert.match(workflow, /--fail-if-no-match/);
});

test('root CI runs disposable Postgres without an optional skip', () => {
  assert.doesNotMatch(workflow, /if: vars\.DATABASE_URL_TEST/);
  assert.match(workflow, /DATABASE_URL_TEST: postgres:\/\/test:test@localhost/);
  assert.match(workflow, /DB_TEST_MARKER:/);
});

test('root CI builds both production containers', () => {
  assert.match(workflow, /docker build .*apps\/api\/Dockerfile/);
  assert.match(workflow, /docker build .*apps\/codex-broker\/Dockerfile/);
  assert.match(workflow, /pnpm container:smoke/);
});

test('root CI contains no removed Bridge or Pi-extension job', () => {
  assert.doesNotMatch(workflow, /whatsapp-bridge|financial-tools|docker\/pi-stack|pi-finance-pi-stack/i);
});

test('deployment workflows gate on CI + PWA CI success and Node 22', () => {
  const pwaDeploy = fs.readFileSync('.github/workflows/pwa-deploy.yml', 'utf8');
  const agentDeploy = fs.readFileSync('.github/workflows/agent-deploy.yml', 'utf8');
  const pwaCi = fs.readFileSync('.github/workflows/pwa-ci.yml', 'utf8');
  for (const deploy of [pwaDeploy, agentDeploy]) {
    assert.match(deploy, /workflow_run:/);
    assert.match(deploy, /workflows:\s*\["CI", "PWA CI"\]/);
    assert.match(deploy, /workflow_run\.conclusion == 'success'/);
    assert.match(deploy, /workflow_run\.head_sha/);
    assert.doesNotMatch(deploy, /workflow_dispatch:/);
    // Deploy gate: both workflows must be green for the deployed SHA.
    assert.match(deploy, /needs: \[gate\]/);
    assert.match(deploy, /listWorkflowRunsForRepo/);
    // Strict gate: missing run for either workflow fails closed (no skip).
    assert.match(deploy, /runs\.length === 0/);
    assert.match(deploy, /Deploy blocked: no /);
    assert.doesNotMatch(deploy, /skipping that requirement/);
    assert.doesNotMatch(deploy, /\bcontinue;/);
    // Failed run blocks; both green reaches the pass message.
    assert.match(deploy, /latest\.conclusion !== 'success'/);
    assert.match(deploy, /Deploy blocked: .*latest conclusion/);
    assert.match(deploy, /Deploy gate passed/);
  }
  assert.doesNotMatch(pwaCi, /node-version:\s*\[20\]/);
  assert.match(pwaCi, /node-version:\s*\[22\]/);
});

test('deployment gate fails closed: missing/failed PWA CI blocks, both green allows', () => {
  const pwaDeploy = fs.readFileSync('.github/workflows/pwa-deploy.yml', 'utf8');
  const agentDeploy = fs.readFileSync('.github/workflows/agent-deploy.yml', 'utf8');
  for (const deploy of [pwaDeploy, agentDeploy]) {
    // Missing PWA CI run for the SHA → gate blocks (fail closed).
    assert.match(deploy, /no \$\{name\} run found/);
    assert.match(deploy, /Re-run \$\{name\} for this SHA/);
    assert.match(deploy, /setFailed\(`Deploy blocked: no /);
    // Failed PWA CI run → gate blocks.
    assert.match(deploy, /setFailed\(`Deploy blocked: .*latest conclusion/);
    // Both CI + PWA CI success → gate allows (pass message only after the loop).
    assert.match(deploy, /Deploy gate passed for/);
  }
});

test('deployment workflows chain an automatic read-only post-deploy smoke', () => {
  const pwaDeploy = fs.readFileSync('.github/workflows/pwa-deploy.yml', 'utf8');
  const agentDeploy = fs.readFileSync('.github/workflows/agent-deploy.yml', 'utf8');
  for (const deploy of [pwaDeploy, agentDeploy]) {
    assert.match(deploy, /\n  smoke:/);
    assert.match(deploy, /needs: \[deploy\]/);
    assert.match(deploy, /curl -fsS/);
    assert.doesNotMatch(deploy, /curl[^|]*(-X POST|-X PUT|-X PATCH|-X DELETE|--data| -d )/);
  }
  // PWA smoke reuses the read-only production-smoke project pinned to the SHA.
  assert.match(pwaDeploy, /--project=production-smoke/);
  assert.match(pwaDeploy, /E2E_PRODUCTION_SMOKE: "1"/);
  // Agent smoke hits only public GET health endpoints.
  assert.match(agentDeploy, /\/health/);
});
