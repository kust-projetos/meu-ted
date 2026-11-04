// Real-boot probe — runs ONLY as dedicated subprocesses (spawned by
// tests/real-sdk.test.mjs, one process per phase). Never imported by the
// suite process: env mutation (setupIsolation scrub) and the OpenCode boot
// stay inside each child, so the parent session's cwd/env are untouched.
//
// Usage:
//   node real-boot-probe.mjs boot <root>
//     -> { ok, phase:'boot', sessionId } (fresh home, first wire + session)
//   node real-boot-probe.mjs restart <root> <sessionId>
//     -> { ok, phase:'restart', checks } (SEPARATE process: sqlite row
//        persists, binding memory gone, re-wire + explicit re-bind recover)
//   node real-boot-probe.mjs catalog <root>
//     -> BLOCKED proof (setup only runs at prompt — no inference authorized)
//   node real-boot-probe.mjs entrypoint <root>
//     -> { ok, phase:'entrypoint', host, port } (real src/main.mjs
//        startTedRuntime: SDK boot, 127.0.0.1 + ephemeral port, clean close,
//        natural return; zero prompts, zero API calls, no Docker)
//
// The SDK is imported by BARE specifier '@opencode/sdk' (declared dep,
// exact 2.2.4) and ONLY AFTER setupIsolation — importing before isolation
// would capture the real process roots. If the dep is not installed the
// import fails EXPLICITLY (no skip, no fake pass).
// Temp dirs come from the parent (approved folder); nothing is deleted.
// NO process.exit before finally: success returns NATURALLY after the
// awaited oc.close(), so orderly shutdown + sqlite persistence are proven,
// not skipped. The post-restart re-bind is an EXPLICIT NON-AUTHENTICATED
// host-side bind (harness stand-in for the P2 gateway) — labeled as such,
// never as authenticated re-auth.

const [phase, root, arg] = process.argv.slice(2);

class ProbeFail extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`);
    this.step = step;
    this.detail = String(detail ?? '').slice(0, 800);
  }
}
const fail = (step, detail) => { throw new ProbeFail(step, detail); };

let outcome = null;
try {
  const { setupIsolation, writeTedConfig, wirePlugin, isSessionActiveMap } = await import('../../src/bootstrap.mjs');
  const { createFacade } = await import('./facade.mjs');
  const { createToolExecutors } = await import('../../src/tool-defs.mjs');
  const { defineTedFinancePlugin } = await import('../../src/plugin.mjs');
  const { bindSession } = await import('../../src/session-bindings.mjs');

  // Isolation FIRST — the SDK import below must observe the isolated roots.
  const iso = setupIsolation(root, 'realsdk');
  writeTedConfig(iso.dirs.config);

  let sdk;
  try {
    sdk = await import('@opencode/sdk');
  } catch (e) {
    fail('sdk-unavailable', `bare import '@opencode/sdk' failed post-isolation (dep not installed?) — ${e && e.code ? e.code : e}`);
  }
  if (!sdk.OpenCode || typeof sdk.OpenCode.create !== 'function') fail('sdk-shape', 'OpenCode.create missing');
  const transport = async () => ({ statusCode: 200, body: { items: [], total: 0 } });
  const host = Object.freeze({ label: 'r', token: 'tok-r', household: 'H_R', actorId: 'a-r', deviceId: 'd-r' });

  if (phase === 'boot') {
    const oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });
    let promptCalled = false;
    try {
      if (typeof oc.plugin !== 'function') fail('plugin-iface', `oc.plugin is ${typeof oc.plugin}`);
      await wirePlugin(oc, defineTedFinancePlugin(() => transport));
      let seen = false;
      for (let i = 0; i < 40 && !seen; i++) {
        const listed = typeof oc.plugin.list === 'function' ? await oc.plugin.list() : null;
        seen = JSON.stringify(listed ?? null).toLowerCase().includes('ted-finance');
        if (!seen) await new Promise((r) => setTimeout(r, 250));
      }
      if (!seen) fail('register', 'ted-finance ausente após wirePlugin + poll');
      const facade = createFacade({ oc, host, executors: createToolExecutors(transport) });
      const s = await facade.createSession('prova-real');
      const got = await facade.getSession(s.id);
      if (got.id !== s.id) fail('session', `get ${got.id} != created ${s.id}`);
      const listedSessions = await facade.listSessions();
      const rows = Array.isArray(listedSessions) ? listedSessions : listedSessions.data;
      if (!rows.some((r) => r.id === s.id)) fail('session-list', 'sessão própria invisível ao dono');

      // A/B isolation: a second identity never sees the first session.
      const hostB = Object.freeze({ label: 'r', token: 'tok-r-B', household: 'H_R', actorId: 'a-r-B', deviceId: 'd-r-B' });
      const facadeB = createFacade({ oc, host: hostB, executors: createToolExecutors(transport) });
      const sB = await facadeB.createSession('prova-real-B');
      const rowsA = await facade.listSessions().then((r) => (Array.isArray(r) ? r : r.data));
      const rowsB = await facadeB.listSessions().then((r) => (Array.isArray(r) ? r : r.data));
      if (rowsA.some((r) => r.id === sB.id)) fail('ab-isolation', 'identidade B visível para A');
      if (rowsB.some((r) => r.id === s.id)) fail('ab-isolation', 'identidade A visível para B');
      const forbidden = await facadeB.getSession(s.id).catch((e) => e);
      if (!forbidden || (forbidden.code !== 'host_binding_mismatch' && forbidden.code !== 'host_context_required')) {
        fail('ab-get', `get cross-host deveria falhar fechado, obteve: ${JSON.stringify(forbidden && forbidden.code)}`);
      }

      // Native method surface (existence/shape, zero provider contact —
      // session.prompt is NEVER invoked: no inference, no cost).
      const methods = {
        sessionCreate: typeof oc.session?.create,
        sessionGet: typeof oc.session?.get,
        sessionActive: typeof oc.session?.active,
        sessionPrompt: typeof oc.session?.prompt,
        sessionInterrupt: typeof oc.session?.interrupt,
        sessionContext: typeof oc.session?.context,
        messageList: typeof oc.message?.list,
        eventSubscribe: typeof oc.event?.subscribe,
      };
      for (const [k, v] of Object.entries(methods)) {
        if (v !== 'function') fail('native-methods', `${k} is ${v} (expected function)`);
      }
      // Activity-probe surface (pinned 2.2.4, zero inference — session.prompt
      // is NEVER invoked): session.active accepts {signal}, returns the
      // direct record map (isSessionActiveMap), and a freshly created session
      // is NOT listed as active (observed idle `{}` post-create).
      {
        const activeCtl = new AbortController();
        const activeMap = await oc.session.active({ signal: activeCtl.signal });
        if (!isSessionActiveMap(activeMap)) {
          fail('active-shape', `session.active did not return the direct 2.2.4 record map: ${JSON.stringify(activeMap).slice(0, 200)}`);
        }
        if (Object.prototype.hasOwnProperty.call(activeMap, s.id)) {
          fail('active-leak', 'freshly created session listed as active right after session.create');
        }
        if (Object.prototype.hasOwnProperty.call(activeMap, sB.id)) {
          fail('active-leak', 'second freshly created session listed as active right after session.create');
        }
      }
      // Native message list shape WITHOUT a provider: empty page envelope
      // `{ data: [], cursor: { previous, next } }`, asc + desc accepted.
      for (const order of ['asc', 'desc']) {
        const page = await oc.message.list({ sessionID: s.id, limit: 10, order });
        if (!Array.isArray(page?.data)) fail('message-list-shape', `order=${order}: data is not an array`);
        if (!page?.cursor || !('previous' in page.cursor) || !('next' in page.cursor)) {
          fail('message-list-shape', `order=${order}: cursor envelope missing`);
        }
      }
      // context is unpaginated context query (array), NOT a turn result.
      const ctxRows = await oc.session.context({ sessionID: s.id });
      if (!Array.isArray(ctxRows)) fail('context-shape', `session.context returned ${typeof ctxRows} (expected array)`);
      // Admitted-prompt result shape pinned from the INSTALLED 2.2.4 types
      // (no provider call — static proof against the declared dependency):
      // SessionPromptOutput = { data: SessionInboxUser } (admit, not output).
      const { readFileSync, readdirSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const pathMod = await import('node:path');
      const sdkDist = pathMod.dirname(fileURLToPath(import.meta.resolve('@opencode/sdk')));
      // sdkDist depth varies (symlinked workspace path vs realpath .pnpm
      // path), so walk upward for the .pnpm root holding the sibling
      // @opencode+client@2.2.4_* dir instead of assuming a fixed depth.
      let pnpmRoot = null;
      let cursor = sdkDist;
      for (let i = 0; i < 10; i++) {
        let entries = [];
        try {
          entries = readdirSync(cursor);
        } catch { break; }
        if (entries.some((d) => d.startsWith('@opencode+client@2.2.4'))) {
          pnpmRoot = cursor;
          break;
        }
        const parent = pathMod.resolve(cursor, '..');
        if (parent === cursor) break;
        cursor = parent;
      }
      if (!pnpmRoot) fail('types-missing', `installed @opencode/client@2.2.4 dir not found above ${sdkDist}`);
      const clientDir = readdirSync(pnpmRoot).find((d) => d.startsWith('@opencode+client@2.2.4'));
      if (!clientDir) fail('types-missing', `installed @opencode/client@2.2.4 dir not found under ${pnpmRoot}`);
      const typesPath = pathMod.join(pnpmRoot, clientDir, 'node_modules', '@opencode', 'client', 'dist', 'promise', 'generated', 'types.d.ts');
      let typesText = '';
      try {
        typesText = readFileSync(typesPath, 'utf8');
      } catch (e) {
        fail('types-missing', `installed client types unreadable: ${typesPath}`);
      }
      if (!/SessionPromptOutput = \{\s*data: SessionInboxUser/.test(typesText)) {
        fail('prompt-shape', 'installed 2.2.4 types do not map prompt output to SessionInboxUser');
      }
      if (!/SessionMessageUser = \{[\s\S]*?type: "user"/.test(typesText)) {
        fail('user-shape', 'installed 2.2.4 types: SessionMessageUser lacks type:"user"');
      }
      if (!/SessionMessageAssistant = \{[\s\S]*?type: "assistant"/.test(typesText)) {
        fail('assistant-shape', 'installed 2.2.4 types: SessionMessageAssistant lacks type:"assistant"');
      }

      // Exact two finance tools with complete schemas; deny-all policy holds
      // (non-finance surface stays blocked); facade allowlist intact.
      const { productToolDefs, PRODUCT_TOOL_NAMES } = await import('../../src/plugin.mjs');
      const defs = productToolDefs();
      if (JSON.stringify(defs.map((d) => d.name).sort()) !== JSON.stringify([...PRODUCT_TOOL_NAMES].sort())) {
        fail('tool-catalog', `product defs != ${PRODUCT_TOOL_NAMES.join(',')}`);
      }
      for (const def of defs) {
        if (!def.input || !def.output) fail('tool-schema', `${def.name}: input+output schemas required`);
      }
      const { tedConfig } = await import('../../src/bootstrap.mjs');
      const policy = JSON.stringify(tedConfig());
      for (const denied of ['shell', 'subagent']) {
        if (!policy.includes(denied)) fail('deny-policy', `deny-all sem ${denied}`);
      }
      const { FACADE_KEYS } = await import('./facade.mjs');
      if (JSON.stringify([...FACADE_KEYS].sort()) !== JSON.stringify(['createSession', 'getSession', 'get_month_summary', 'listSessions', 'list_accounts', 'removeSession'])) {
        fail('facade-drift', `facade keys: ${FACADE_KEYS.join(',')}`);
      }
      // Effective catalog (`ctx.tool.list()`) fires ONLY inside real plugin
      // setup, which runs on the prompt loop — pending-provider by design
      // (prompt never invoked here). The seam is unit-proven (wiring tests);
      // live capture is reported as pending, never fabricated.
      outcome = { ok: true, phase: 'boot', sessionId: s.id, promptCalled, checks: { nativeMethods: true, sessionActiveProbe: true, messageListShape: true, abIsolation: true, toolDefs: PRODUCT_TOOL_NAMES, denyPolicy: true, effectiveCatalogLive: 'pending-provider' } };
    } finally {
      await oc.close().catch(() => {});
    }
  } else if (phase === 'restart') {
    const sessionId = arg;
    if (!sessionId) fail('args', 'restart exige <sessionId>');
    const oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });
    try {
      // Fresh process: nenhum binding sobreviveu. getSession SEM re-bind
      // deve falhar fechado mesmo com a linha sqlite persistida.
      const facade = createFacade({ oc, host, executors: createToolExecutors(transport) });
      const preErr = await facade.getSession(sessionId).catch((e) => e);
      const preFailClosed = preErr && (preErr.code === 'host_context_required' || preErr.code === 'host_binding_revoked' || preErr.code === 'host_binding_expired');
      if (!preFailClosed) fail('restart-failclosed', `get sem re-bind deveria falhar fechado, obteve: ${JSON.stringify(preErr && (preErr.code || preErr.message))}`);
      // Registro é por-boot: host fresco não lista sem wire.
      const fresh = typeof oc.plugin.list === 'function' ? await oc.plugin.list() : null;
      const freshHas = JSON.stringify(fresh ?? null).toLowerCase().includes('ted-finance');
      await wirePlugin(oc, defineTedFinancePlugin(() => transport));
      let reseens = false;
      for (let i = 0; i < 40 && !reseens; i++) {
        const relisted = typeof oc.plugin.list === 'function' ? await oc.plugin.list() : null;
        reseens = JSON.stringify(relisted ?? null).toLowerCase().includes('ted-finance');
        if (!reseens) await new Promise((r) => setTimeout(r, 250));
      }
      if (!reseens) fail('restart-rewire', 're-wire pós-restart não registrou');
      // Recuperação EXPLÍCITA NÃO AUTENTICADA (stand-in de harness para o
      // gateway P2, que fará re-bind somente após reautenticação): re-bind
      // host-side direto, depois get. NÃO é prova de reautenticação.
      bindSession(sessionId, host);
      const got = await facade.getSession(sessionId);
      if (got.id !== sessionId) fail('restart-rebind', 'get pós re-bind divergiu');
      outcome = { ok: true, phase: 'restart', checks: { preFailClosed: true, freshHasPlugin: freshHas, rewired: reseens, reboundGet: true, reboundAuthenticated: false } };
    } finally {
      await oc.close().catch(() => {});
    }
  } else if (phase === 'catalog') {
    // Live effective-catalog proof: BLOCKED BY DESIGN in pinned 2.2.4.
    // Plugin setup (the only surface where ctx.tool.list() reflects the
    // runnable catalog) fires ONLY when a prompt runs — proven by direct
    // observation: 20s idle post-wire fires no setup, and neither does
    // session.create. Triggering setup requires oc.session.prompt, which is
    // an inference request attempt, and no paid/real inference is
    // authorized here. So this phase proves the boundary instead of
    // fabricating a catalog: session.create (NOT inference) still proves
    // agent:'ted', session.prompt is hard-guarded to zero calls, and the
    // absent setup is observed failing closed as catalog-blocked.
    // If a future SDK ever fires setup without a prompt, the captured
    // branch below asserts the EXACT gated catalog with zero prompt calls.
    const { defineTedFinancePlugin, PRODUCT_TOOL_NAMES } = await import('../../src/plugin.mjs');
    const { tedConfig } = await import('../../src/bootstrap.mjs');
    const oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });
    try {
      let captured = null;
      let captureError = null;
      let promptCalls = 0;
      await wirePlugin(oc, defineTedFinancePlugin(() => transport, {
        onEffectiveTools: (names, err) => { captured = names; captureError = err ? String((err && err.message) || err) : null; },
      }));
      const created = await oc.session.create({ title: 'catalog-probe', agent: 'ted' });
      const createdAgent = created && created.agent;
      if (createdAgent !== 'ted') fail('catalog-agent', `real session must explicitly use agent 'ted', got ${JSON.stringify(createdAgent)}`);
      // Hard guard: session.prompt must NEVER run in this proof — any call
      // fails the phase (it would be an inference request attempt).
      const promptGuard = oc.session.prompt;
      void promptGuard;
      oc.session.prompt = (async () => {
        promptCalls++;
        throw new Error('catalog-guard: session.prompt must never run in the catalog proof (unauthorized inference attempt)');
      });
      for (let i = 0; i < 40 && captured === null && captureError === null; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (promptCalls !== 0) fail('catalog-prompted', `session.prompt was invoked ${promptCalls}x during the catalog proof — inference is not authorized`);
      if (captureError) fail('catalog-list', `ctx.tool.list() failed inside setup: ${captureError}`);
      if (!Array.isArray(captured)) {
        fail('catalog-blocked', 'plugin setup did not run without a prompt in pinned 2.2.4 (20s wire-idle + session.create observed idle); live catalog requires session.prompt, an unauthorized inference attempt — proof BLOCKED, zero prompts issued, nothing fabricated');
      }
      const deniedResources = new Set(
        (tedConfig().policies || []).filter((p) => p && p.action === 'tool.use' && p.effect === 'deny').map((p) => String(p.resource)),
      );
      const uncovered = captured.filter((name) => !PRODUCT_TOOL_NAMES.includes(name) && !deniedResources.has(`${name}:*`));
      if (uncovered.length !== 0) fail('catalog-gating', `effective tools without a pinned tool.use deny: ${uncovered.slice().sort().join(',')}`);
      outcome = {
        ok: true,
        phase: 'catalog',
        sessionAgent: createdAgent,
        promptCalls,
        observed: captured.slice().sort(),
      };
    } finally {
      await oc.close().catch(() => {});
    }
  } else if (phase === 'entrypoint') {
    // Real application entrypoint proof (no fakes, no seams): boots the
    // actual src/main.mjs startTedRuntime with the real SDK under an
    // isolated home, a syntactically valid loopback API origin on an
    // unused port, and an ephemeral gateway port. No gateway request is
    // ever made (a single unknown-route GET only proves the listener is
    // alive — it never reaches identity/transport/prompt), so zero
    // inference and zero API/data access occur. Clean close + natural
    // return prove orderly shutdown (no forced exit).
    // NOTE: this subprocess already isolated as 'realsdk' above (one host
    // per process), so the entrypoint reuses the same root + identity.
    const { startTedRuntime } = await import('../../src/main.mjs');
    const handle = await startTedRuntime({
      env: {
        TED_RUNTIME_HOME: root,
        TED_RUNTIME_IDENTITY: 'realsdk',
        TED_API_BASE_URL: 'http://127.0.0.1:9',
        TED_GATEWAY_PORT: '0',
        TED_REQUEST_TIMEOUT_MS: '10000',
      },
    }).catch((e) => fail('entrypoint-boot', `startTedRuntime failed: ${String((e && e.message) || e).slice(0, 300)}`));
    try {
      const host = handle && handle.info && handle.info.host;
      const port = handle && handle.info && handle.info.port;
      if (host !== '127.0.0.1') fail('entrypoint-listen', `gateway must listen on 127.0.0.1, got ${JSON.stringify(host)}`);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('entrypoint-listen', `gateway must report an ephemeral port, got ${JSON.stringify(port)}`);
      // Liveness without identity/transport/prompt: unknown routes 404
      // before any resolution. Proves a real HTTP listener, zero inference.
      let status = -1;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/ted-runtime-probe-no-such-route`);
        status = res.status;
        await res.arrayBuffer().catch(() => {});
      } catch (e) {
        fail('entrypoint-listen', `loopback listener did not answer: ${String((e && e.message) || e).slice(0, 200)}`);
      }
      if (status !== 404) fail('entrypoint-listen', `unknown route must 404 without touching identity, got ${status}`);
      outcome = { ok: true, phase: 'entrypoint', host, port, promptCalls: 0, apiCalls: 0 };
    } finally {
      try {
        await handle.close();
      } catch (e) {
        fail('entrypoint-close', `clean close failed: ${String((e && e.message) || e).slice(0, 300)}`);
      }
    }
  } else {
    fail('args', `phase desconhecida: ${phase} (boot|restart|catalog|entrypoint)`);
  }
} catch (e) {
  if (e instanceof ProbeFail) {
    console.log(JSON.stringify({ ok: false, phase, step: e.step, detail: e.detail }));
  } else {
    console.log(JSON.stringify({ ok: false, phase, step: 'exception', detail: ((e && e.stack) || (e && e.message) || String(e)).slice(0, 800) }));
  }
  process.exitCode = 1;
  process.exit(process.exitCode);
}
// Caminho de sucesso: retorno NATURAL (sem process.exit antes do finally).
console.log(JSON.stringify(outcome));
process.exitCode = 0;
