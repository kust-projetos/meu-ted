import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = path.join(HERE, 'container-smoke.mjs');
const SOURCE = fs.readFileSync(SMOKE, 'utf8');

// ── Static contract: bounded fetch, no unsettled top-level await ──────────
// Fails on the pre-fix script (bare `await fetch(url)` with no AbortController
// / timer, which leaves an unreferenced pending promise → Node 22 exit 13).
test('container-smoke bounds every health fetch with AbortController + timer', () => {
  assert.match(SOURCE, /new AbortController/);
  assert.match(SOURCE, /setTimeout/);
  assert.match(SOURCE, /clearTimeout/);
  assert.match(SOURCE, /signal/);
  assert.match(SOURCE, /abort/i);
});

test('container-smoke cancels the response body and reports health RED', () => {
  assert.match(SOURCE, /body\?\.cancel|arrayBuffer|cancel\(\)/);
  assert.match(SOURCE, /health RED/);
});

test('container-smoke keeps the canonical 40 x 500ms window with a global deadline', () => {
  assert.match(SOURCE, /40/);
  assert.match(SOURCE, /500/);
  assert.match(SOURCE, /DEADLINE|deadline/);
});

// ── Hermetic subprocess harness (fake docker shim, no real images) ─────────
// The smoke script honours SMOKE_DOCKER_SHIM: when set it shells out to
// `node <shim> <args>` instead of the real `docker` binary, so the tests run
// hermetically on Linux CI and Windows alike with no PATH shadowing.
function writeFakeDocker(binDir, stateDir) {
  const shimPath = path.join(binDir, 'fake-docker.mjs');
  const shim = `
import fs from 'node:fs';
import path from 'node:path';
const stateDir = process.env.FAKE_DOCKER_STATE_DIR;
const apiPort = process.env.FAKE_API_PORT;
const brokerPort = process.env.FAKE_BROKER_PORT;
const args = process.argv.slice(2);
const cmd = args[0];
const log = (f, line) => fs.appendFileSync(path.join(stateDir, f), line + '\\n');
if (cmd === 'info') { process.stdout.write('26.0.0\\n'); process.exit(0); }
if (cmd === 'run') {
  const nameIdx = args.indexOf('--name');
  const name = nameIdx >= 0 ? args[nameIdx + 1] : 'unknown';
  log('containers.log', name);
  fs.writeFileSync(path.join(stateDir, 'container-' + name), name);
  process.stdout.write('fake-id-' + name + '\\n');
  process.exit(0);
}
if (cmd === 'inspect') {
  const format = args[args.indexOf('--format') + 1] ?? '';
  const container = args[args.length - 1] ?? '';
  if (format.includes('NetworkSettings.Ports')) {
    const port = container.includes('api-smoke') ? apiPort : brokerPort;
    process.stdout.write(String(port) + '\\n');
    process.exit(0);
  }
  if (format.includes('.Config.User')) {
    process.stdout.write('appuser\\n');
    process.exit(0);
  }
  process.stdout.write('\\n');
  process.exit(0);
}
if (cmd === 'logs') {
  const container = args[args.length - 1] ?? '';
  process.stdout.write('fake logs for ' + container + '\\n');
  process.exit(0);
}
if (cmd === 'rm') {
  const container = args[args.length - 1] ?? '';
  log('removed.log', container);
  try { fs.rmSync(path.join(stateDir, 'container-' + container), { force: true }); } catch {}
  process.exit(0);
}
console.error('unknown fake docker command: ' + args.join(' '));
process.exit(1);
`;
  fs.writeFileSync(shimPath, shim, 'utf8');
  return shimPath;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function runSmoke({ apiPort, brokerPort, stateDir, shimPath, extraEnv = {}, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(process.execPath, [SMOKE], {
      env: {
        ...process.env,
        SMOKE_DOCKER_SHIM: shimPath,
        FAKE_DOCKER_STATE_DIR: stateDir,
        FAKE_API_PORT: String(apiPort),
        FAKE_BROKER_PORT: String(brokerPort),
        // Fast hermetic bounds; production defaults stay canonical
        // (40 attempts x 500ms ~= 20s, 1s per-request, 20s global deadline).
        SMOKE_FETCH_TIMEOUT_MS: '200',
        SMOKE_DEADLINE_MS: '2000',
        SMOKE_RETRY_INTERVAL_MS: '50',
        SMOKE_MAX_ATTEMPTS: '40',
        ...extraEnv,
      },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      if (stdout.length < 65536) stdout += d.toString('utf8').slice(0, 65536 - stdout.length);
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < 65536) stderr += d.toString('utf8').slice(0, 65536 - stderr.length);
    });
    child.on('error', (err) => finish({ status: null, stdout, stderr, error: String(err), timedOut: false }));
    child.on('close', (code) => finish({ status: code, stdout, stderr, timedOut: false }));
  });
}

async function withHarness(healthHandler, fn) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-bin-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-state-'));
  const shimPath = writeFakeDocker(binDir, stateDir);
  const apiPort = await freePort();
  const brokerPort = await freePort();
  const sockets = new Set();
  const make = () => {
    const server = http.createServer(healthHandler);
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    return server;
  };
  const api = make();
  const broker = make();
  await new Promise((r) => api.listen(apiPort, '127.0.0.1', r));
  await new Promise((r) => broker.listen(brokerPort, '127.0.0.1', r));
  try {
    await fn({ apiPort, brokerPort, stateDir, binDir, shimPath });
  } finally {
    await new Promise((r) => api.close(r));
    await new Promise((r) => broker.close(r));
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function removedContainers(stateDir, binDir) {
  // The shim records removals; stateDir may already be removed on failure —
  // callers read it inside withHarness.
  void binDir;
  const f = path.join(stateDir, 'removed.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

test('hermetic: delayed health passes and owned containers are cleaned up', { timeout: 60000 }, async () => {
  let hits = 0;
  await withHarness(
    (req, res) => {
      hits += 1;
      if (hits < 4) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('warming');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    },
    async ({ apiPort, brokerPort, stateDir, binDir, shimPath }) => {
      const r = await runSmoke({ apiPort, brokerPort, stateDir, binDir, shimPath });
      assert.equal(r.timedOut, false, `smoke hung: ${r.stderr.slice(0, 500)}`);
      assert.equal(r.status, 0, `stdout=${r.stdout.slice(0, 500)} stderr=${r.stderr.slice(0, 500)}`);
      assert.match(r.stdout, /GREEN/);
      const removed = removedContainers(stateDir, binDir);
      assert.equal(removed.length, 2, `expected 2 owned cleanups, got ${JSON.stringify(removed)}`);
    },
  );
});

test('hermetic: never-responding health fails RED with exit 1 (never 13) and still cleans up', { timeout: 60000 }, async () => {
  await withHarness(
    () => {
      // Accept the socket and never respond: the pre-fix bare
      // `await fetch(url)` never settles here (Node 22 exit 13 / CI hang).
      // The bounded fetch must abort per request, hit the global deadline,
      // and exit 1 with a useful health RED diagnostic.
    },
    async ({ apiPort, brokerPort, stateDir, binDir, shimPath }) => {
      const started = Date.now();
      const r = await runSmoke({ apiPort, brokerPort, stateDir, binDir, shimPath, timeoutMs: 30000 });
      const elapsed = Date.now() - started;
      assert.equal(r.timedOut, false, 'smoke hung past the harness timeout');
      assert.equal(r.status, 1, `expected exit 1, got ${r.status} stdout=${r.stdout.slice(0, 300)} stderr=${r.stderr.slice(0, 500)}`);
      assert.notEqual(r.status, 13, 'regression: unsettled top-level await (exit 13)');
      assert.match(r.stderr, /health RED/);
      assert.ok(elapsed < 30000, `bounded run took ${elapsed}ms`);
      const removed = removedContainers(stateDir, binDir);
      assert.equal(removed.length, 2, `expected 2 owned cleanups, got ${JSON.stringify(removed)}`);
    },
  );
});
