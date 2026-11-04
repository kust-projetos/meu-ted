// TED local gateway entrypoint — SDK-backed, loopback only.
//
//   node apps/ted-runtime/src/main.mjs
//
// Boots ONE isolated OpenCode environment (static package instance identity,
// persistent isolated home), wires the real HTTP finance transport against a
// loopback API origin, and serves the B gateway on 127.0.0.1 only. No prompt
// is issued at startup (no inference at boot or at session creation — the
// prompt loop runs only per PWA request). Credentials are never logged or
// copied into config here: the default `test` profile scrubs all
// configured credential vars before the SDK import and the ted policy denies
// provider.use; the explicit `live` profile (TED_RUNTIME_PROFILE=live, read
// ONLY here and forwarded explicitly) preserves ONLY OPENCODE_GO_API_KEY from
// SCRUB_VARS (missing credentials are handled by native OpenCode itself;
// value never logged/read here).
//
// Importing this module has NO side effects (no listener, no signal traps):
// the executable path runs only when the module IS the invoked CLI script.
// Tests import { startTedRuntime } with injected seams (no SDK, no network).
//
// Env (all validated; loopback only, never production):
//   TED_RUNTIME_HOME      persistent isolated home root
//                         (default: ~/.ted-runtime)
//   TED_RUNTIME_IDENTITY  single-host identity, one path segment
//                         (default: local)
//   TED_API_BASE_URL      bare loopback origin of the authorizing API
//                         (default: http://127.0.0.1:3001 — ted-local api)
//   TED_GATEWAY_PORT      local listen port (default: 3101; host is ALWAYS
//                         127.0.0.1 — non-loopback listen is refused)
//   TED_REQUEST_TIMEOUT_MS per-request timeout ms (default: 90000)
//   TED_RUNTIME_PROFILE  runtime profile: `test` (default, deny-all, no
//                        model, SCRUB_VARS scrubbed) or `live`
//                        (explicit; native model selected from repo-owned
//                        template src/live-model.json — current native default
//                        opencode-go/deepseek-v4.1-flash — + specific
//                        provider.use opencode-go allow appended;
//                        preserves ONLY OPENCODE_GO_API_KEY,
//                        never logged/read here)

import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOME = path.join(os.homedir(), '.ted-runtime');
const DEFAULT_IDENTITY = 'local';
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3001';
const DEFAULT_PORT = 3101;
const DEFAULT_TIMEOUT_MS = 90000;

// Test seam: every collaborator injectable; defaults are the real modules.
// `env` overrides process.env per key (explicit arg wins, then process.env,
// then documented loopback defaults) so tests never depend on ambient env.
export async function startTedRuntime({ env = {}, deps = {} } = {}) {
  const readEnv = (key, fallback) => {
    const fromArg = env[key];
    if (typeof fromArg === 'string' && fromArg.length > 0) return fromArg;
    const fromProcess = process.env[key];
    if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess;
    return fallback;
  };
  const {
    createTedEnvironment = (await import('./bootstrap.mjs')).createTedEnvironment,
    createConversationStore = (await import('./conversations.mjs')).createConversationStore,
    createGatewayServer = (await import('./server.mjs')).createGatewayServer,
    resolveGatewayIdentity = (await import('./gateway.mjs')).resolveGatewayIdentity,
    assertLoopbackApiOrigin = (await import('./gateway.mjs')).assertLoopbackApiOrigin,
    HttpFinanceTransport = (await import('./transport.mjs')).HttpFinanceTransport,
  } = deps;

  const home = readEnv('TED_RUNTIME_HOME', DEFAULT_HOME);
  const identity = readEnv('TED_RUNTIME_IDENTITY', DEFAULT_IDENTITY);
  const apiBaseUrl = readEnv('TED_API_BASE_URL', DEFAULT_API_BASE_URL);
  if (typeof apiBaseUrl !== 'string' || apiBaseUrl.length === 0) {
    throw new Error('main: TED_API_BASE_URL is required (bare loopback http(s) origin, never production)');
  }
  assertLoopbackApiOrigin(apiBaseUrl);
  const port = Number.parseInt(readEnv('TED_GATEWAY_PORT', String(DEFAULT_PORT)), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`main: TED_GATEWAY_PORT must be a valid port (got ${readEnv('TED_GATEWAY_PORT', '(default)')})`);
  }
  const requestTimeoutMs = Number.parseInt(readEnv('TED_REQUEST_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)), 10);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(`main: TED_REQUEST_TIMEOUT_MS must be a positive integer (got ${readEnv('TED_REQUEST_TIMEOUT_MS', '(default)')})`);
  }
  // Profile is validated inside bootstrap (unknown rejects before boot);
  // read here so the resolved value is forwarded explicitly to the env boot.
  const profile = readEnv('TED_RUNTIME_PROFILE', 'test');

  const transportFactory = () => new HttpFinanceTransport({ baseUrl: apiBaseUrl }).call;
  const tedEnv = await createTedEnvironment({ root: home, identity, transportFactory, profile });

  // Anything below can still fail (unreadable/corrupt store dir, gateway
  // construction, listen). The booted SDK environment (sqlite locks, fibers)
  // must never leak: close it — and the gateway if already constructed —
  // exactly once before rethrowing. (Failures INSIDE createTedEnvironment,
  // before it returns, are the boot's own close guarantee; the process env
  // mutated by setupIsolation is intentionally not restored — one host per
  // process, fail closed — and the CLI below exits non-zero instead of
  // keeping an unusable process alive.)
  let gateway;
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try {
      if (gateway) await gateway.close();
    } catch { /* settle never fails */ }
    try {
      await tedEnv.close();
    } catch { /* settle never fails */ }
  }
  try {
    // Conversation metadata lives under the SDK-isolated state dir (server
    // side only; opaque ids + ids/status metadata, never transcripts).
    const store = createConversationStore({ persistDir: tedEnv.dirs.state });
    const promptHost = tedEnv.serverOps.createPromptHost();

    gateway = createGatewayServer({
      resolveIdentity: ({ cookie, deviceToken, workspaceId, signal }) =>
        resolveGatewayIdentity({ apiBaseUrl, cookie, deviceToken, workspaceId, signal }),
      store,
      promptHost,
      createRuntimeSession: async () => ({ runtimeSessionId: await tedEnv.serverOps.createNativeSession() }),
      withAuthenticatedSession: (sessionID, host, fn, opts) =>
        tedEnv.serverOps.withAuthenticatedSession(sessionID, host, fn, opts),
      requestTimeoutMs,
    });

    // Host is ALWAYS loopback — never from env, never production.
    const info = await gateway.listen({ port, host: '127.0.0.1' });
    return { info, close, gateway, store };
  } catch (e) {
    await close().catch(() => {});
    throw e;
  }
}

// Executable path: only when THIS file is the invoked CLI script.
// Importing the module (tests, harnesses) starts nothing.
const invokedAsCli =
  typeof process.argv?.[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsCli) {
  let handle = null;
  const shutdown = (signalName) => {
    try {
      console.log(JSON.stringify({ ok: true, shuttingDown: signalName }));
    } catch { /* settle never fails */ }
    if (handle) handle.close().catch(() => {});
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  startTedRuntime().then(
    (h) => {
      handle = h;
      console.log(JSON.stringify({ ok: true, host: h.info.host, port: h.info.port }));
    },
    (e) => {
      console.error(
        JSON.stringify({ ok: false, code: (e && e.code) || 'main.failed', message: String((e && e.message) || e).slice(0, 300) }),
      );
      process.exitCode = 1;
    },
  );
}
