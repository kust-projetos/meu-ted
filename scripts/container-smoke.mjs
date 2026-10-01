#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const suffix = `${Date.now()}-${process.pid}`;
const containers = [];

const docker = (args, options = {}) => {
  const bin = DOCKER_SHIM ? process.execPath : DOCKER_BIN;
  const fullArgs = DOCKER_SHIM ? [DOCKER_SHIM, ...args] : args;
  return execFileSync(bin, fullArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const numEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Canonical CI window: 40 attempts x 500ms ~= 20s of polling per container.
// A bare `await fetch(url)` can hang forever on an accepted-but-silent
// socket (unsettled top-level await → Node 22 exit 13), so every request is
// bounded by REQUEST_TIMEOUT_MS and the whole wait by DEADLINE_MS. The
// per-request timer is a referenced setTimeout that aborts the fetch, then
// is always cleared in `finally`; the response body is cancelled to free
// the socket. SMOKE_* overrides exist only to keep hermetic tests fast.
const REQUEST_TIMEOUT_MS = numEnv('SMOKE_FETCH_TIMEOUT_MS', 1000);
const DEADLINE_MS = numEnv('SMOKE_DEADLINE_MS', 20000);
const RETRY_INTERVAL_MS = numEnv('SMOKE_RETRY_INTERVAL_MS', 500);
const MAX_ATTEMPTS = Math.floor(numEnv('SMOKE_MAX_ATTEMPTS', 40));

// Test seam for hermetic tests (fake docker shim, no real images):
// when SMOKE_DOCKER_SHIM points at a script, `docker()` shells out to
// `node <shim> <args>` instead of the real `docker` binary. Production
// behaviour is unchanged (both vars unset).
const DOCKER_BIN = process.env.SMOKE_DOCKER_BIN ?? 'docker';
const DOCKER_SHIM = process.env.SMOKE_DOCKER_SHIM ?? '';

const start = (name, image, containerPort, env = []) => {
  const container = `${name}-${suffix}`;
  // Do not use --rm: an early bootstrap failure must remain inspectable long
  // enough for this script to include its logs, then `finally` removes it.
  const args = ['run', '--detach', '--name', container, '--publish', `127.0.0.1::${containerPort}`];
  for (const [key, value] of env) args.push('--env', `${key}=${value}`);
  args.push(image);
  docker(args);
  containers.push(container);
  const port = docker(['inspect', '--format', `{{(index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort}}`, container]);
  const user = docker(['inspect', '--format', '{{.Config.User}}', container]);
  if (!user) throw new Error(`${name} image must run as a non-root user`);
  return { container, port };
};

const waitForHealth = async (name, port) => {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + DEADLINE_MS;
  let lastError = 'not started';
  for (let attempt = 0; attempt < MAX_ATTEMPTS && Date.now() < deadline; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) {
        try { await response.body?.cancel?.(); } catch {}
        console.log(`${name} health GREEN (${url})`);
        return;
      }
      lastError = `HTTP ${response.status}`;
      try { await response.body?.cancel?.(); } catch {}
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        lastError = `timeout after ${REQUEST_TIMEOUT_MS}ms`;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearTimeout(timer);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(RETRY_INTERVAL_MS, remaining));
  }
  throw new Error(`${name} health RED: ${lastError}`);
};

try {
  docker(['info', '--format', '{{.ServerVersion}}']);
  const api = start('pi-finance-api-smoke', 'pi-finance-api:ci', 3001, [
    ['NODE_ENV', 'test'],
    ['MIGRATIONS_MODE', 'disabled'],
  ]);
  // Fail-closed broker startup (V4.1 Phase 8) refuses to boot in production
  // mode without a strong signing key and an explicit private-network escape
  // hatch. Both values below are disposable smoke literals: never shipped,
  // never used as a real secret, and not the rejected insecure fallback.
  const broker = start('pi-finance-codex-broker-smoke', 'pi-finance-codex-broker:ci', 3005, [
    ['CODEX_SIGNING_KEY', 'smoke-disposable-signing-key-0123456789abcdef0123456789abcdef'],
    ['BROKER_TRUST_PRIVATE_NETWORK', '1'],
  ]);
  await waitForHealth('API', api.port);
  await waitForHealth('Codex Broker', broker.port);
  console.log('Container smoke GREEN: API and Codex Broker are non-root and healthy.');
} catch (error) {
  for (const container of containers) {
    try {
      const logs = docker(['logs', container]);
      if (logs) console.error(`--- ${container} logs ---\n${logs}`);
    } catch {}
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const container of containers.reverse()) {
    try { docker(['rm', '--force', container]); } catch {}
  }
}
