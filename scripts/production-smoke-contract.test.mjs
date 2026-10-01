import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflow = fs.readFileSync('.github/workflows/production-smoke.yml', 'utf8');
const config = fs.readFileSync('apps/pwa/e2e/playwright.config.ts', 'utf8');
const localE2eRunner = fs.readFileSync('apps/pwa/e2e/run-ci.sh', 'utf8');
const smoke = fs.readFileSync('apps/pwa/e2e/specs/production-smoke.spec.ts', 'utf8');
const runbook = fs.readFileSync('docs/runbooks/pwa-cloudflare-release.md', 'utf8');
const buildInfoRoute = fs.readFileSync('apps/pwa/src/app/api/build-info/route.ts', 'utf8');
const apiHealth = fs.readFileSync('apps/api/src/routes/index.ts', 'utf8');
const agentWorker = fs.readFileSync('apps/agent/src/worker.ts', 'utf8');

test('production smoke is manual and receives an explicit deployed URL', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /E2E_PRODUCTION_URL/);
  assert.match(workflow, /E2E_PRODUCTION_SMOKE: "1"/);
  assert.match(workflow, /--project=production-smoke/);
});

test('production smoke does not start local fixture servers', () => {
  assert.match(config, /PRODUCTION_SMOKE \? undefined : \[/);
  assert.match(config, /E2E_PRODUCTION_URL is required/);
  assert.match(smoke, /gotoReadOnly/);
  assert.match(smoke, /production smoke emitted writes/);
  assert.match(smoke, /\["GET", "HEAD", "OPTIONS"\]/);
});

test('local PWA E2E runner pins both API paths to local fixtures and clears live opt-ins', () => {
  // Static pins that remain meaningful on the runner source: bearer compat
  // stays literally off, the runner never shells to `next start`, and the
  // four gates keep their projects/flags. Port NUMBERS are not pinned here
  // (they moved to ${E2E_*_PORT} overrides with fixture defaults) — the
  // behavioral tests below prove defaults + overrides + clearing instead.
  assert.match(localE2eRunner, /export NEXT_PUBLIC_LEGACY_BEARER_COMPAT="off"/);
  assert.doesNotMatch(localE2eRunner, /next start --port/);
  assert.match(localE2eRunner, /--project=functional-mobile/);
  assert.match(localE2eRunner, /--output=test-results\/functional-mobile/);
  assert.match(localE2eRunner, /--workers=1 --retries=1/);
  assert.match(localE2eRunner, /--project=pwa-runtime/);
  assert.match(localE2eRunner, /--project=push-runtime/);
  assert.match(localE2eRunner, /--project=functional-desktop/);
  assert.match(localE2eRunner, /export PWA_LIVE_E2E="0"/);
  assert.match(localE2eRunner, /export E2E_PRODUCTION_SMOKE="0"/);
  assert.match(localE2eRunner, /export E2E_PRODUCTION_URL=""/);
  assert.match(localE2eRunner, /export PWA_AGENT_PROXY_ORIGIN=""/);
  assert.match(localE2eRunner, /export AGENT_ORIGIN=""/);
  assert.match(localE2eRunner, /export NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL=""/);
  // `standalone-server.mjs` is owned by the Playwright config's webServer
  // section, not the runner (the old runner-source assertion pointed at the
  // wrong file).
  assert.match(config, /standalone-server\.mjs/);
});

// ── Behavioral runner contract: actual run, fake pnpm captures env ─────────
// The runner executes in a bash (Git Bash on Windows, PATH bash elsewhere)
// where `pnpm` is an exported shell function logging every invocation plus
// the environment it observed; build and gates succeed instantly (no
// browser, no servers). FAIL_* seeds prove clearing beats caller-provided
// live/production values. Spawn uses argv (no shell, no history).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'apps', 'pwa', 'e2e', 'run-ci.sh');

function resolveBash() {
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(gitBash)) return gitBash;
  }
  return 'bash';
}

function toPosix(p) {
  if (process.platform !== 'win32') return p;
  const m = /^([A-Za-z]):[\\/]/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`;
}

// Runner-managed keys: scrubbed from the child env so each case controls
// them deterministically (ambient dotenv/CI values cannot leak in).
const RUNNER_KEYS = [
  'E2E_FIXTURE_PORT',
  'E2E_NEXT_PORT',
  'E2E_HARNESS_PORT',
  'NEXT_PUBLIC_PI_FINANCE_API_BASE_URL',
  'NEXT_PUBLIC_LEGACY_BEARER_COMPAT',
  'PWA_BACKEND_PROXY_ORIGIN',
  'NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL',
  'PWA_AGENT_PROXY_ORIGIN',
  'AGENT_ORIGIN',
  'ALLOW_LOCAL_ORIGIN',
  'PWA_LIVE_E2E',
  'PWA_LIVE_BASE_URL',
  'E2E_PRODUCTION_SMOKE',
  'E2E_PRODUCTION_URL',
];

function childEnv(seeds) {
  const env = { ...process.env };
  for (const k of RUNNER_KEYS) delete env[k];
  return { ...env, ...seeds };
}

function runRunner(seeds, { timeoutMs = 90000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-contract-'));
  const callLog = path.join(tmp, 'calls.log');
  fs.writeFileSync(callLog, '');
  // The fake lives in a temp .sh file (sourced by path, not argv): long
  // multi-line `bash -c` payloads are mangled by Windows argv handling.
  const preludePath = path.join(tmp, 'prelude.sh');
  const fake = [
    'pnpm() {',
    // One logical line: shell continuations need trailing backslashes
    // (a bare newline would terminate the printf command).
    '  printf \'CALL|%s|API=%s|PROXY=%s|BEARER=%s|AGENTPUB=%s|AGENTPROXY=%s|AGENTORIGIN=%s|ALLOWLOCAL=%s|LIVE=%s|LIVEBASE=%s|SMOKE=%s|SMOKEURL=%s|FPORT=%s|NPORT=%s|HPORT=%s\\n\' \\',
    '    "$*" "${NEXT_PUBLIC_PI_FINANCE_API_BASE_URL:-}" "${PWA_BACKEND_PROXY_ORIGIN:-}" "${NEXT_PUBLIC_LEGACY_BEARER_COMPAT:-}" \\',
    '    "${NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL:-}" "${PWA_AGENT_PROXY_ORIGIN:-}" "${AGENT_ORIGIN:-}" "${ALLOW_LOCAL_ORIGIN:-}" \\',
    '    "${PWA_LIVE_E2E:-}" "${PWA_LIVE_BASE_URL:-}" "${E2E_PRODUCTION_SMOKE:-}" "${E2E_PRODUCTION_URL:-}" \\',
    '    "${E2E_FIXTURE_PORT:-}" "${E2E_NEXT_PORT:-}" "${E2E_HARNESS_PORT:-}" >> "$CALL_LOG";',
    '  return 0;',
    '}',
    'export -f pnpm',
    `exec bash "${toPosix(RUNNER)}"`,
  ].join('\n');
  fs.writeFileSync(preludePath, fake, 'utf8');
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(r);
    };
    let child;
    try {
      child = spawn(resolveBash(), [toPosix(preludePath)], {
        env: { ...childEnv(seeds), CALL_LOG: toPosix(callLog) },
        windowsHide: true,
      });
    } catch (err) {
      finish({ status: null, calls: [], error: String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ status: null, calls: [], error: 'timeout', timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      if (stdout.length < 65536) stdout += d.toString('utf8').slice(0, 65536 - stdout.length);
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < 65536) stderr += d.toString('utf8').slice(0, 65536 - stderr.length);
    });
    child.on('error', (err) => {
      finish({ status: null, calls: [], error: String(err), timedOut: false });
    });
    child.on('close', (code) => {
      const calls = fs
        .existsSync(callLog)
        ? fs
            .readFileSync(callLog, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('CALL|'))
            .map((l) => {
              const parts = l.split('|');
              const env = {};
              for (const p of parts.slice(2)) {
                const i = p.indexOf('=');
                if (i > 0) env[p.slice(0, i)] = p.slice(i + 1);
              }
              return { args: parts[1] ?? '', env };
            })
        : [];
      finish({ status: code, calls, stdout, stderr, timedOut: false });
    });
  });
}

function buildCall(calls) {
  return calls.find((c) => c.args.includes('build:next:cloudflare'));
}

function gateCalls(calls) {
  return calls.filter((c) => c.args.includes('playwright test'));
}

test('runner behavior: fixture defaults pin both API paths locally (4010)', { timeout: 120000 }, async () => {
  const r = await runRunner({});
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0);
  const build = buildCall(r.calls);
  assert.ok(build, 'expected the Next build invocation');
  assert.equal(build.env.API, 'http://127.0.0.1:4010');
  assert.equal(build.env.PROXY, 'http://127.0.0.1:4010');
  assert.equal(build.env.FPORT, '4010');
  assert.equal(build.env.NPORT, '3001');
  assert.equal(build.env.HPORT, '3000');
  // Live/production opt-ins stay cleared even with no caller seeds.
  assert.equal(build.env.BEARER, 'off');
  assert.equal(build.env.AGENTPUB, '');
  assert.equal(build.env.AGENTPROXY, '');
  assert.equal(build.env.AGENTORIGIN, '');
  assert.equal(build.env.ALLOWLOCAL, '0');
  assert.equal(build.env.LIVE, '0');
  assert.equal(build.env.SMOKE, '0');
  assert.equal(build.env.SMOKEURL, '');
  // Every gate inherits the same fixture-only environment.
  for (const g of gateCalls(r.calls)) {
    assert.equal(g.env.API, 'http://127.0.0.1:4010');
    assert.equal(g.env.SMOKE, '0');
  }
});

test('runner behavior: port overrides relocate fixtures (4110) and seeded prod values are cleared', { timeout: 120000 }, async () => {
  const r = await runRunner({
    E2E_FIXTURE_PORT: '4110',
    E2E_NEXT_PORT: '3101',
    E2E_HARNESS_PORT: '3100',
    // Seeded deployed values: the runner must clear every one of these.
    E2E_PRODUCTION_SMOKE: '1',
    E2E_PRODUCTION_URL: 'https://pwa.example.test',
    PWA_LIVE_E2E: '1',
    PWA_LIVE_BASE_URL: 'https://pwa.example.test',
    PWA_AGENT_PROXY_ORIGIN: 'https://agent.example.test',
    AGENT_ORIGIN: 'https://agent.example.test',
    NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL: 'https://agent.example.test',
    ALLOW_LOCAL_ORIGIN: '1',
  });
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0);
  const build = buildCall(r.calls);
  assert.ok(build, 'expected the Next build invocation');
  assert.equal(build.env.API, 'http://127.0.0.1:4110');
  assert.equal(build.env.PROXY, 'http://127.0.0.1:4110');
  assert.equal(build.env.LIVEBASE, 'http://127.0.0.1:3100');
  assert.equal(build.env.BEARER, 'off');
  assert.equal(build.env.AGENTPUB, '');
  assert.equal(build.env.AGENTPROXY, '');
  assert.equal(build.env.AGENTORIGIN, '');
  assert.equal(build.env.ALLOWLOCAL, '0');
  assert.equal(build.env.LIVE, '0');
  assert.equal(build.env.SMOKE, '0');
  assert.equal(build.env.SMOKEURL, '');
  for (const g of gateCalls(r.calls)) {
    assert.equal(g.env.API, 'http://127.0.0.1:4110');
    assert.equal(g.env.SMOKE, '0');
    assert.equal(g.env.SMOKEURL, '');
  }
});

test('runbook documents smoke before and rollback after a release', () => {
  assert.match(runbook, /Production smoke \(post-deploy, read-only\)/i);
  assert.match(runbook, /wrangler rollback/);
  assert.match(runbook, /same read-only production smoke workflow/i);
});

test('release identity is exposed by all three runtimes (V4.1 Task 9.9)', () => {
  assert.match(buildInfoRoute, /build-info/);
  assert.match(buildInfoRoute, /getBuildInfo/);
  assert.match(apiHealth, /gitSha/);
  assert.match(apiHealth, /BUILD_SHA/);
  assert.match(agentWorker, /buildSha/);
  assert.match(agentWorker, /BUILD_SHA/);
});

test('production smoke confirms the deployed SHA (V4.1 Task 9.10)', () => {
  assert.match(smoke, /SMOKE-05/);
  assert.match(smoke, /\/api\/build-info/);
  assert.match(smoke, /EXPECTED_SHA/);
});
