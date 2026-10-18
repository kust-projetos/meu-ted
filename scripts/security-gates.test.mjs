import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const secretScript = fs.readFileSync('scripts/security-secrets.mjs', 'utf8');
const containerScript = fs.readFileSync('scripts/security-containers.mjs', 'utf8');
const gitleaksConfig = fs.readFileSync('.gitleaks.toml', 'utf8');
const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const apiDockerfile = fs.readFileSync('apps/api/Dockerfile', 'utf8');
const brokerDockerfile = fs.readFileSync('apps/codex-broker/Dockerfile', 'utf8');

for (const name of ['security:secrets', 'security:deps', 'security:containers']) {
  test(`package exposes ${name}`, () => {
    assert.equal(typeof packageJson.scripts[name], 'string');
    assert.notEqual(packageJson.scripts[name].trim(), '');
  });
}

test('secret gate uses a cross-platform script with pinned Gitleaks, read-only source, and redaction', () => {
  assert.equal(packageJson.scripts['security:secrets'], 'node scripts/security-secrets.mjs');
  assert.match(secretScript, /zricethezav\/gitleaks:v8\.24\.2/);
  assert.match(secretScript, /detect/);
  assert.match(secretScript, /--config=\/repo\/\.gitleaks\.toml/);
  assert.match(secretScript, /:ro/);
  assert.match(secretScript, /--redact/);
  assert.match(secretScript, /--exit-code/);
  assert.match(secretScript, /shell: false/);
});

test('Gitleaks allowlist is limited to deleted historical test fixtures', () => {
  assert.match(gitleaksConfig, /bridge-full-coverage/);
  assert.match(gitleaksConfig, /tools-contract/);
  assert.match(gitleaksConfig, /idempotency/);
  assert.match(gitleaksConfig, /deterministic non-secret identifiers/);
});

test('dependency gate audits dependencies', () => {
  const command = packageJson.scripts['security:deps'];
  assert.match(command, /pnpm audit/);
  assert.match(command, /--audit-level(?:=| )(?:moderate|critical)/);
});

test('container gate fails on high or critical vulnerabilities for both CI images', () => {
  assert.equal(packageJson.scripts['security:containers'], 'node scripts/security-containers.mjs');
  assert.match(containerScript, /aquasec\/trivy:0\.58\.1/);
  assert.match(containerScript, /trivy-cache:\/root\/\.cache\/trivy/);
  assert.match(containerScript, /--exit-code/);
  assert.match(containerScript, /HIGH,CRITICAL/);
  assert.match(containerScript, /pi-finance-api:ci/);
  assert.match(containerScript, /pi-finance-codex-broker:ci/);
  assert.match(containerScript, /shell: false/);
});

test('runtime images install dependencies and exclude package-manager stores', () => {
  assert.match(apiDockerfile, /pnpm install --frozen-lockfile/);
  assert.match(brokerDockerfile, /pnpm install --frozen-lockfile/);
  assert.match(apiDockerfile, /FROM node:24-alpine/);
});

test('CI security job runs scans and global gate depends on it', () => {
  assert.match(workflow, /\n  security:/);
  assert.match(workflow, /pnpm security:secrets/);
  assert.match(workflow, /pnpm security:deps/);
  assert.match(workflow, /security/);
  assert.match(workflow, /needs: \[.*security.*\]/);
});

test('security job has no production credentials or deployment commands', () => {
  const security = workflow.slice(workflow.indexOf('\n  security:'));
  assert.doesNotMatch(security, /DATABASE_URL(?!_TEST)/);
  assert.doesNotMatch(security, /wrangler deploy|pm2|ssh|curl .*prod/i);
});

// ── T02 fail-closed matrix: hermetic subprocesses with an empty PATH so no
// scanner binary can be resolved. CI=true must never exit 0 without a scan;
// local (non-CI) keeps the documented explicit skips.
function runGateScript(script, extraEnv = {}) {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-path-'));
  try {
    return spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { PATH: emptyDir, SystemRoot: process.env.SystemRoot, ...extraEnv },
      timeout: 60000,
    });
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
}

test('secret gate is fail-closed in CI when no scanner is available', () => {
  const result = runGateScript('scripts/security-secrets.mjs', { CI: 'true' });
  assert.notEqual(
    result.status,
    0,
    `expected non-zero exit in CI without a scanner, got 0: ${(result.stdout || '').slice(0, 300)}`,
  );
});

test('container gate is fail-closed in CI when docker is absent', () => {
  const result = runGateScript('scripts/security-containers.mjs', { CI: 'true' });
  assert.notEqual(
    result.status,
    0,
    `expected non-zero exit in CI without docker, got 0: ${(result.stdout || '').slice(0, 300)}`,
  );
});

test('gates keep the documented explicit local skips outside CI', () => {
  for (const script of ['scripts/security-secrets.mjs', 'scripts/security-containers.mjs']) {
    const result = runGateScript(script, {});
    assert.equal(
      result.status,
      0,
      `expected local explicit skip (exit 0) for ${script}, got ${result.status}: ${((result.stdout || '') + (result.stderr || '')).slice(0, 300)}`,
    );
  }
});

// ── Injectable gate matrix (no real scanner; fakes derive from the contract).
test('secret gate timeout: fail-closed in CI, explicit skip locally', async () => {
  const { executeSecretsGate } = await import('./security-secrets.mjs');
  const fake = {
    checkBinary: async () => true,
    runWithTimeout: async () => ({ status: 0, timedOut: true }),
  };
  const ci = await executeSecretsGate({ env: { CI: 'true' }, platform: 'linux', ...fake });
  assert.equal(ci.exitCode, 1);
  const local = await executeSecretsGate({ env: {}, platform: 'linux', ...fake });
  assert.equal(local.exitCode, 0);
  assert.match(local.reason || '', /Skipping local scan/);
});

test('secret gate scanner/missing-binary/spawn-error matrix', async () => {
  const { executeSecretsGate } = await import('./security-secrets.mjs');
  const noneAvailable = { checkBinary: async () => false, runWithTimeout: async () => ({ status: 0, timedOut: false }) };
  assert.equal((await executeSecretsGate({ env: { CI: 'true' }, platform: 'linux', ...noneAvailable })).exitCode, 1);
  assert.equal((await executeSecretsGate({ env: {}, platform: 'linux', ...noneAvailable })).exitCode, 0);

  const detection = { checkBinary: async () => true, runWithTimeout: async () => ({ status: 1, timedOut: false }) };
  assert.equal((await executeSecretsGate({ env: { CI: 'true' }, platform: 'linux', ...detection })).exitCode, 1);
  assert.equal((await executeSecretsGate({ env: {}, platform: 'linux', ...detection })).exitCode, 1);

  const spawnError = {
    checkBinary: async () => true,
    runWithTimeout: async () => ({ status: 1, timedOut: false, error: new Error('spawn ENOENT') }),
  };
  assert.equal((await executeSecretsGate({ env: { CI: 'true' }, platform: 'linux', ...spawnError })).exitCode, 1);
  assert.equal((await executeSecretsGate({ env: {}, platform: 'linux', ...spawnError })).exitCode, 1);

  const clean = { checkBinary: async () => true, runWithTimeout: async () => ({ status: 0, timedOut: false }) };
  assert.equal((await executeSecretsGate({ env: { CI: 'true' }, platform: 'linux', ...clean })).exitCode, 0);
});

// Scope note: the gate spawns the scanner with stdio:'inherit', so live
// scanner output goes straight to the terminal uncaptured — this test cannot
// observe it. What it does guarantee is the gate's own channel: the
// result.reason strings returned for logging never carry detection content.
// Pipeline-level redaction of the scanner output itself stays with --redact.
test('secret gate error reasons never carry detection content', async () => {
  const { executeSecretsGate } = await import('./security-secrets.mjs');
  const marker = 'SECRET_MARKER_XYZ_123';
  const leaked = { checkBinary: async () => true, runWithTimeout: async () => ({ status: 1, timedOut: false, output: marker }) };
  const result = await executeSecretsGate({ env: { CI: 'true' }, platform: 'linux', ...leaked });
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.reason || '', new RegExp(marker));
});

test('secret gate timeout deadline is configurable and bounded', async () => {
  const { parseGitleaksTimeoutMs } = await import('./security-secrets.mjs');
  assert.equal(parseGitleaksTimeoutMs({}), 20000);
  assert.equal(parseGitleaksTimeoutMs({ SECURITY_GITLEAKS_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(parseGitleaksTimeoutMs({ SECURITY_GITLEAKS_TIMEOUT_MS: 'not-a-number' }), 20000);
  assert.equal(parseGitleaksTimeoutMs({ SECURITY_GITLEAKS_TIMEOUT_MS: '1' }), 1000);
  assert.equal(parseGitleaksTimeoutMs({ SECURITY_GITLEAKS_TIMEOUT_MS: '9999999' }), 120000);
});

test('container gate docker-absent/finding/spawn-error matrix', async () => {
  const { executeContainersGate } = await import('./security-containers.mjs');
  assert.equal((await executeContainersGate({ env: { CI: 'true' }, dockerAvailable: false, runImage: () => ({ status: 0 }) })).exitCode, 1);
  assert.equal((await executeContainersGate({ env: {}, dockerAvailable: false, runImage: () => ({ status: 0 }) })).exitCode, 0);

  const findings = { env: { CI: 'true' }, dockerAvailable: true, runImage: () => ({ status: 1 }) };
  const failed = await executeContainersGate(findings);
  assert.equal(failed.exitCode, 1);

  const spawnError = {
    env: { CI: 'true' },
    dockerAvailable: true,
    runImage: () => ({ status: null, error: new Error('spawn ENOENT') }),
  };
  assert.equal((await executeContainersGate(spawnError)).exitCode, 1);

  const clean = { env: { CI: 'true' }, dockerAvailable: true, runImage: () => ({ status: 0 }) };
  assert.equal((await executeContainersGate(clean)).exitCode, 0);
});
