// P2 real-history probe — runs ONLY as dedicated subprocesses (spawned by
// tests/p2-real-history.test.mjs, one process per phase). Never imported by
// the suite process: env mutation (setupIsolation scrub) and the OpenCode
// boot stay inside each child, so the parent session's cwd/env are untouched.
//
// Usage:
//   node p2-real-history-probe.mjs seed <root>
//     -> { ok, phase:'seed', sessionId, conversationId, ... } (fresh home,
//        synthetic transcript imported via the OFFICIAL 2.2.4 operation
//        oc.experimental.session.import, read back via oc.message.list,
//        conversation metadata persisted via the real conversation store)
//   node p2-real-history-probe.mjs serve <root> <sessionId> <conversationId> <userId> <assistantId>
//     -> { ok, phase:'serve-ready', port, base, ... } (SEPARATE process: SAME
//        base reopened through the real path — createTedEnvironment + real
//        conversation store + real loopback gateway + real createPromptHost;
//        session.prompt guarded to throw before delegating; keeps the gateway
//        alive on 127.0.0.1 until a stdin command closes it; stdin lines:
//        'fail' (readHistory throws synthetic), 'recover'/'ok'/'heal'
//        (restore), 'stats' (counters), 'close'/'exit'/'quit' (orderly close).
//        Test-only fault seam for PWA proxy/client proof; no inference.)
//   node p2-real-history-probe.mjs recover <root> <sessionId> <conversationId> <userId> <assistantId>
//     -> { ok, phase:'recover', checks } (SEPARATE process: SAME base
//        reopened through the real path — createTedEnvironment + real
//        conversation store + real loopback gateway + real createPromptHost;
//        history read inside the real withAuthenticatedSession; session.prompt
//        guarded to throw before delegating; no inference, no provider, no
//        external network, no financial tools, no API/DB beyond loopback)
//
// Pinned 2.2.4 pagination contract: a non-empty page returns an opaque `next`
// cursor that encodes order/direction. The server rejects cursor+order
// together ('Cursor cannot be combined with order'); continuation uses the
// cursor alone. The adapter follows that contract. This test retains a direct
// negative probe for the invalid parameter combination. This is a current
// reproduction; it does not establish the unavailable exception from the
// original live run.
//
// The SDK is imported by BARE specifier '@opencode/sdk' (declared dep, exact
// 2.2.4) and ONLY AFTER setupIsolation — importing before isolation would
// capture the real process roots. If the dep is not installed the import
// fails EXPLICITLY (no skip, no fake pass). Temp dirs come from the parent
// (approved folder); nothing is deleted. NO process.exit before finally:
// success returns NATURALLY after the awaited close(), so orderly shutdown
// + sqlite persistence are proven, not skipped.
//
// LIMITS (declared, not hidden): the transcript is SYNTHETIC and sanitized
// (fixed user/assistant texts below — never real LLM output, never financial
// data); it is imported through the official transfer.import operation, not
// produced by a model. What is proven real: SQLite persistence of the
// imported messages across OS processes, conversation-metadata persistence,
// the exact real-server pagination contract, gateway history DTO, authenticated
// binding lifecycle, fail-closed access checks, and controlled history-error
// recovery — with zero session.prompt calls. This is not a PWA/browser E2E or
// proof of an LLM-generated response.

const [phase, root, argSessionId, argConversationId, argUserId, argAssistantId] = process.argv.slice(2);

const IDENTITY = 'p2hist';
// Synthetic test-only identity (never a live actor/device; never copied
// from any trace): the seam the recovery phase resolves credentials to.
const ACTOR = 'test-actor-p2-history';
const DEVICE = 'test-device-p2-history-01';
const WS = 'H_P2HIST';
const SESSION_COOKIE = 'p2-seam-session=valid';
// Synthetic sanitized transcript (NOT model output): fixed user question +
// fixed assistant answer carrying a recognizable financial-looking string.
const USER_TEXT = 'qual foi meu gasto em junho?';
const ASST_TEXT = 'gasto de R$ 117,50 em junho (2 transacoes) — sintese sintetica de teste, sem LLM';
const TURN_COUNT = 60;
const userId = (index) => `msg_p2_user_${String(index).padStart(2, '0')}`;
const assistantId = (index) => `msg_p2_assistant_${String(index).padStart(2, '0')}`;
const userText = (index) => index === 0 ? USER_TEXT : `pergunta sintetica ${index}`;
const assistantText = (index) => index === 0 ? ASST_TEXT : `resposta sintetica ${index}`;

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
  if (!root || typeof root !== 'string') fail('args', 'root is required');
  const { setupIsolation, writeTedConfig } = await import('../../src/bootstrap.mjs');

  if (phase === 'seed') {
    // Isolation FIRST — the SDK import below must observe the isolated roots.
    const iso = setupIsolation(root, IDENTITY);
    writeTedConfig(iso.dirs.config);

    let sdk;
    try {
      sdk = await import('@opencode/sdk');
    } catch (e) {
      fail('sdk-unavailable', `bare import '@opencode/sdk' failed post-isolation (dep not installed?) — ${e && e.code ? e.code : e}`);
    }
    if (!sdk.OpenCode || typeof sdk.OpenCode.create !== 'function') fail('sdk-shape', 'OpenCode.create missing');
    const oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });
    try {
      // Guard: session.prompt must NEVER run in this proof (no inference).
      let promptCalls = 0;
      const origPrompt = oc.session && oc.session.prompt ? oc.session.prompt.bind(oc.session) : null;
      void origPrompt;
      if (oc.session) {
        oc.session.prompt = (async () => {
          promptCalls++;
          throw new Error('p2-real-history-guard: session.prompt must never run in the seed phase (no inference)');
        });
      }
      if (!oc.experimental || !oc.experimental.session || typeof oc.experimental.session.import !== 'function') {
        fail('import-unavailable', 'oc.experimental.session.import is not a function on the installed SDK — refusing to fabricate persistence');
      }
      // Template session establishes a valid projectID/location for the
      // import (creation only — no prompt, no inference).
      const tpl = await oc.session.create({ title: 'p2hist-template', agent: 'ted' });
      if (!tpl || typeof tpl.id !== 'string') fail('template', 'session.create did not return an id');
      const tplInfo = await oc.session.get({ sessionID: tpl.id });
      if (!tplInfo || typeof tplInfo.projectID !== 'string' || !tplInfo.location) {
        fail('template-info', 'session.get did not return projectID/location for the import template');
      }
       // Synthetic sanitized transcript: stable ids, ordered timestamps.
       const T0 = Date.now();
       const SES = 'ses_0123456789abcdef012345';
       const UMSG = userId(0);
       const AMSG = assistantId(0);
       const messages = [];
       for (let i = 0; i < TURN_COUNT; i++) {
         const created = T0 + i * 2000;
         messages.push({ id: userId(i), type: 'user', text: userText(i), time: { created } });
         messages.push({
           id: assistantId(i), type: 'assistant', agent: 'ted',
           model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
           content: [{ type: 'text', text: assistantText(i) }],
           time: { created: created + 1000, completed: created + 1200 },
           finish: 'stop',
         });
       }
      const imported = await oc.experimental.session.import({
        info: {
          id: SES,
          projectID: tplInfo.projectID,
          agent: 'ted',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
           time: { created: T0, updated: T0 + TURN_COUNT * 2000 },
          title: 'p2-real-history',
          location: tplInfo.location,
        },
        messages,
      });
      const importedId = (imported && imported.id) || SES;
      if (importedId !== SES) fail('import-id', `imported session id diverged: ${importedId}`);
      // Diagnóstico honesto do que o transfer.import persistiu (stderr não
      // quebra o JSON do stdout — o pai usa a última linha do stdout).
      try {
        const exported = await oc.experimental.session.export({ sessionID: SES });
        const expMsgs = (exported && exported.messages) || (exported && exported.data && exported.data.messages) || null;
        console.error(`[p2hist-seed] export messages: ${JSON.stringify((expMsgs || []).map((m) => ({ id: m && m.id, type: m && m.type })))}`);
      } catch (e) {
        console.error(`[p2hist-seed] export failed: ${String((e && e.message) || e).slice(0, 200)}`);
      }
       // Proof of direct SDK page shape plus bounded adapter traversal through
       // the real message.list surface (no direct sqlite access).
       const page = await oc.message.list({ sessionID: SES, limit: 50, order: 'asc' });
       const rows = Array.isArray(page) ? page : page && page.data;
       if (!Array.isArray(rows)) fail('message-list-shape', 'oc.message.list did not return an array envelope');
       if (rows.length !== 50 || rows[0]?.id !== UMSG) fail('message-list-page', `first asc page shape diverged: ${rows.length} rows`);
       const { createPromptHost } = await import('../../src/prompt.mjs');
       const history = await createPromptHost({ oc }).readHistory({ sessionID: SES, ownerActor: ACTOR });
       const ids = history.map((m) => m && m.id);
       const expectedIds = Array.from({ length: TURN_COUNT }, (_, i) => [userId(i), assistantId(i)]).flat();
       if (ids.length !== expectedIds.length || ids.some((id, i) => id !== expectedIds[i])) {
         fail('message-list-content', `expected ${expectedIds.length} ordered ids; got ${ids.length}, first=${ids.slice(0, 4).join(',')}`);
       }
       if (new Set(ids).size !== ids.length) fail('message-list-duplicates', 'SDK history contains duplicate ids');
       if (history[0].content !== USER_TEXT) fail('message-list-user', 'user row text diverged');
       if (history[1].content !== ASST_TEXT) fail('message-list-assistant', 'assistant row text diverged');
       if (history.at(-1).id !== assistantId(TURN_COUNT - 1)) fail('message-list-last', 'last assistant message id diverged');
      // session.context is a query (array), never a message write.
      const ctxRows = await oc.session.context({ sessionID: SES });
      if (!Array.isArray(ctxRows)) fail('context-shape', `session.context returned ${typeof ctxRows} (expected array)`);
      // Persisted conversation metadata linking to the native session.
      const { createConversationStore } = await import('../../src/conversations.mjs');
      const store = createConversationStore({ persistDir: iso.dirs.state });
      const rec = store.create({ workspace: WS, ownerActor: ACTOR, deviceId: DEVICE, visibility: 'workspace' });
      store.attachRuntime(rec.conversationId, SES, ACTOR);
      const reread = store.get(rec.conversationId, { actorId: ACTOR, workspace: WS, deviceId: DEVICE });
      if (reread.runtimeSessionId !== SES) fail('registry', 'conversation store did not persist the runtime binding');
      if (promptCalls !== 0) fail('seed-prompted', `session.prompt ran ${promptCalls}x in the seed phase`);
      outcome = {
        ok: true, phase: 'seed', sessionId: SES, conversationId: rec.conversationId,
         userMessageId: UMSG, assistantMessageId: AMSG, lastMessageId: assistantId(TURN_COUNT - 1),
         userText: USER_TEXT, assistantText: ASST_TEXT, messageCount: expectedIds.length,
        promptCalls,
        checks: { importInterface: true, messageListRead: true, contextArray: true, registryAttached: true },
      };
    } finally {
      await oc.close().catch(() => {});
    }
  } else if (phase === 'recover') {
    const sessionId = argSessionId;
    const conversationId = argConversationId;
     const userMessageId = argUserId;
     const assistantMessageId = argAssistantId;
     if (!sessionId || !conversationId || !userMessageId || !assistantMessageId) {
       fail('args', 'recover exige <sessionId> <conversationId> <userId> <assistantId>');
     }
     if (userMessageId !== userId(0) || assistantMessageId !== assistantId(0)) {
       fail('args', 'recover ids do not match the imported transcript fixture');
     }
    // Real path, manual wiring mirroring src/main.mjs (which calls
    // createTedEnvironment without a deps passthrough, so the prompt-guard
    // seam below is injected here instead of through startTedRuntime):
    // createTedEnvironment (real) + conversation store (real) + gateway
    // (real) + createPromptHost (real) + withAuthenticatedSession (real).
    // Seams (declared): (1) deps.sdkModule wraps the REAL 2.2.4 binary to
    // count/guard session.prompt and count message.list — no behavior change
    // otherwise; (2) resolveIdentity is a synthetic credential seam
    // returning the fixed test identity for the controlled cookie/device
    // pair and typed auth failures otherwise (it never dials any API).
    const { createTedEnvironment } = await import('../../src/bootstrap.mjs');
    let promptCalls = 0;
    let messageLists = 0;
    let transportCalls = 0;
    let liveOc = null;
    const sdkModule = {
      OpenCode: {
        create: async (opts) => {
          // Lazy import INSIDE create: runs after setupIsolation (which
          // createTedEnvironment performs before touching deps.sdkModule),
          // so the real SDK still captures the isolated roots.
          const real = await import('@opencode/sdk');
          const oc = await real.OpenCode.create(opts);
          liveOc = oc;
          if (oc.message && typeof oc.message.list === 'function') {
            const origList = oc.message.list.bind(oc.message);
            oc.message.list = async (args) => { messageLists++; return origList(args); };
          }
          if (oc.session) {
            oc.session.prompt = (async () => {
              promptCalls++;
              throw Object.assign(
                new Error('p2-real-history-guard: session.prompt must never run (no inference, no provider)'),
                { code: 'p2.prompt_guarded' },
              );
            });
          }
          return oc;
        },
      },
    };
    const transportFactory = () => (async () => {
      transportCalls++;
      return { statusCode: 200, body: { items: [], total: 0 } };
    });
    const tedEnv = await createTedEnvironment({ root, identity: IDENTITY, transportFactory, deps: { sdkModule } });
    let gw = null;
    try {
      const { createConversationStore } = await import('../../src/conversations.mjs');
      const { createGatewayServer } = await import('../../src/server.mjs');
      const { HISTORY_UNAVAILABLE_MESSAGE } = await import('../../src/prompt.mjs');
      const { GatewayError } = await import('../../src/gateway.mjs');
      const { getBinding } = await import('../../src/session-bindings.mjs');
      const store = createConversationStore({ persistDir: tedEnv.dirs.state });
      // The registry row written by the seed process must be visible here
      // (same root + identity => same persistDir, fresh process load).
      const meta = store.get(conversationId, { actorId: ACTOR, workspace: WS, deviceId: DEVICE });
      if (meta.runtimeSessionId !== sessionId) {
        fail('registry-reopen', `persisted runtime binding diverged: ${meta.runtimeSessionId} != ${sessionId}`);
      }
      const realHost = tedEnv.serverOps.createPromptHost();
      const ctl = { failRead: false, insideBinding: 'unseen' };
      const promptHost = {
        chat: (args) => realHost.chat(args),
        readRawMessages: (args) => realHost.readRawMessages(args),
        readHistory: async (args) => {
          const b = getBinding(args.sessionID);
          ctl.insideBinding = (b && !b.revoked) ? `bound:${b.host.actorId}` : 'missing-or-revoked';
          if (ctl.failRead) throw new Error('synthetic native history failure: connection reset');
          return realHost.readHistory(args);
        },
      };
      async function fakeResolveIdentity({ cookie, deviceToken }) {
        if (deviceToken !== DEVICE) {
          throw new GatewayError('auth.device_required', 'device credential is required (synthetic seam)');
        }
        const parts = String(cookie || '').split(';').map((p) => p.trim());
        if (!parts.includes(SESSION_COOKIE)) {
          throw new GatewayError('auth.session_required', 'synthetic session cookie required');
        }
        return { actorId: ACTOR, workspace: WS, deviceId: DEVICE };
      }
      gw = createGatewayServer({
        resolveIdentity: fakeResolveIdentity,
        store,
        promptHost,
        createRuntimeSession: async () => ({ runtimeSessionId: await tedEnv.serverOps.createNativeSession() }),
        withAuthenticatedSession: tedEnv.serverOps.withAuthenticatedSession,
      });
      const info = await gw.listen({ port: 0, host: '127.0.0.1' });
      if (info.host !== '127.0.0.1') fail('listen', `gateway must stay loopback, got ${info.host}`);
      const base = `http://${info.host}:${info.port}`;
      const HIST = (ws) => `/agents/finance-chat-agent/${encodeURIComponent(ws)}/rpc/history`;
       // Real-server pagination contract (2.2.4): order and direction are
       // encoded in the opaque cursor. Verify asc and desc continuations with
       // cursor-only requests, plus rejection of cursor+order.
      {
        const rawPage = await liveOc.message.list({ sessionID: sessionId, limit: 50, order: 'asc' });
        const rawRows = Array.isArray(rawPage) ? rawPage : rawPage && rawPage.data;
        const next = rawPage && rawPage.cursor && rawPage.cursor.next;
        console.error(`[p2hist-recover] contract page1: rows=${Array.isArray(rawRows) ? rawRows.length : typeof rawRows} next=${typeof next}`);
         if (!Array.isArray(rawRows) || rawRows.length !== 50 || rawRows[0]?.id !== userId(0) || typeof next !== 'string' || next.length === 0) {
           fail('pagination-contract', `page1 shape diverged: rows=${Array.isArray(rawRows) ? rawRows.length : typeof rawRows} next=${typeof next}`);
         }
         const p2 = await liveOc.message.list({ sessionID: sessionId, limit: 50, cursor: next });
         const r2 = Array.isArray(p2) ? p2 : p2 && p2.data;
         const n2 = p2 && p2.cursor && p2.cursor.next;
         console.error(`[p2hist-recover] contract asc cursor-only page2: rows=${Array.isArray(r2) ? r2.length : typeof r2} next=${typeof n2}`);
         if (!Array.isArray(r2) || r2.length !== 50 || r2[0]?.id !== userId(25) || typeof n2 !== 'string') {
           fail('pagination-contract', 'asc cursor-only continuation diverged (expected ordered middle page)');
         }
         const desc1 = await liveOc.message.list({ sessionID: sessionId, limit: 50, order: 'desc' });
         const descRows1 = Array.isArray(desc1) ? desc1 : desc1 && desc1.data;
         const descNext1 = desc1 && desc1.cursor && desc1.cursor.next;
         if (!Array.isArray(descRows1) || descRows1.length !== 50 || descRows1[0]?.id !== assistantId(TURN_COUNT - 1) || typeof descNext1 !== 'string') {
           fail('pagination-desc', 'desc first page shape/order diverged');
         }
         const desc2 = await liveOc.message.list({ sessionID: sessionId, limit: 50, cursor: descNext1 });
         const descRows2 = Array.isArray(desc2) ? desc2 : desc2 && desc2.data;
         const descNext2 = desc2 && desc2.cursor && desc2.cursor.next;
         if (!Array.isArray(descRows2) || descRows2.length !== 50 || descRows2[0]?.id !== assistantId(34) || typeof descNext2 !== 'string') {
           fail('pagination-desc', 'desc cursor-only continuation diverged (expected ordered middle page)');
         }
        const comboErr = await liveOc.message.list({ sessionID: sessionId, limit: 50, order: 'asc', cursor: next }).then(
          () => null,
          (e) => e,
        );
        console.error(`[p2hist-recover] contract page2 cursor+order: ${comboErr ? `threw: ${String((comboErr && comboErr.message) || comboErr).slice(0, 120)}` : 'UNEXPECTEDLY OK'}`);
        if (!comboErr || !String((comboErr && comboErr.message) || comboErr).includes('Cursor cannot be combined with order')) {
          fail('pagination-contract', 'cursor+order no longer rejected — re-evaluate the healthy-GET block below');
        }
      }
      const pinCookie = `ted-runtime-conversation=opencode.${conversationId}`;
      const goodHeaders = {
        cookie: `${SESSION_COOKIE}; ${pinCookie}`,
        'x-device-token': DEVICE,
        'x-workspace-id': WS,
      };
      const getJson = async (res) => {
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { _raw: text }; }
      };
      // 1. Healthy GET: same session/conversation, ids/content/order/dedup.
      const healthy = await fetch(`${base}${HIST(WS)}`, { headers: goodHeaders });
      const healthyDto = await getJson(healthy);
      if (healthy.status !== 200) {
        console.error(`[p2hist-recover] healthy GET ${healthy.status}: ${JSON.stringify(healthyDto).slice(0, 500)}`);
        fail('healthy-status', `healthy history GET returned ${healthy.status} (real-server pagination contract above)`);
      }
      if (!healthyDto || !Array.isArray(healthyDto.items)) fail('healthy-dto', 'history DTO lacks {items}');
      const gotIds = healthyDto.items.map((i) => i && i.id);
       const expectedIds = Array.from({ length: TURN_COUNT }, (_, i) => [userId(i), assistantId(i)]).flat();
       if (gotIds.length !== expectedIds.length || gotIds.some((id, i) => id !== expectedIds[i])) {
         fail('healthy-ids', `expected ${expectedIds.length} ordered ids, got ${gotIds.length}`);
       }
      if (healthyDto.items[0].role !== 'user' || healthyDto.items[0].content !== USER_TEXT) {
        fail('healthy-user', 'user item content diverged');
      }
      if (healthyDto.items[1].role !== 'assistant' || healthyDto.items[1].content !== ASST_TEXT) {
        fail('healthy-assistant', 'assistant item content diverged');
      }
      const [c0, c1] = [healthyDto.items[0].createdAt, healthyDto.items[1].createdAt];
      if (!(c0 && c1 && Date.parse(c1) > Date.parse(c0))) fail('healthy-order', 'assistant createdAt is not after user createdAt');
       for (const it of healthyDto.items) {
         if ('runtimeSessionId' in it) fail('healthy-leak', 'native session id leaked into history DTO');
       }
       if (new Set(gotIds).size !== gotIds.length) fail('healthy-duplicates', 'history DTO contains duplicate ids');
      if (ctl.insideBinding !== `bound:${ACTOR}`) fail('binding-inside', `valid read did not run under a live binding (saw ${ctl.insideBinding})`);
      const after = getBinding(sessionId);
      if (!(after && after.revoked === true)) fail('binding-revoked', 'binding did not stay revoked after the guarded window');
      // 2. Repeat GET: identical body (order + dedup stable).
      const repeat = await fetch(`${base}${HIST(WS)}`, { headers: goodHeaders });
      const repeatDto = await getJson(repeat);
      if (repeat.status !== 200 || JSON.stringify(repeatDto) !== JSON.stringify(healthyDto)) {
        fail('repeat-stable', 'repeat GET diverged (order/dedup unstable)');
      }
      // 3. Fail-closed negatives: no message.list beyond the healthy reads.
      const listsBeforeNeg = messageLists;
      const badDevice = await fetch(`${base}${HIST(WS)}`, {
        headers: { ...goodHeaders, 'x-device-token': 'wrong-device' },
      });
      if (badDevice.status !== 401) fail('neg-device-status', `invalid device returned ${badDevice.status} (expected 401)`);
      const badCookie = await fetch(`${base}${HIST(WS)}`, {
        headers: { cookie: pinCookie, 'x-device-token': DEVICE, 'x-workspace-id': WS },
      });
      if (badCookie.status !== 401) fail('neg-cookie-status', `invalid session returned ${badCookie.status} (expected 401)`);
      const cross = await fetch(`${base}${HIST('H_OTHER')}`, {
        headers: { ...goodHeaders, 'x-workspace-id': 'H_OTHER' },
      });
      if (cross.status !== 403) fail('neg-cross-status', `cross-workspace returned ${cross.status} (expected 403)`);
      const unknownPin = await fetch(`${base}${HIST(WS)}`, {
        headers: {
          cookie: `${SESSION_COOKIE}; ted-runtime-conversation=opencode.00000000-0000-4000-8000-000000000000`,
          'x-device-token': DEVICE, 'x-workspace-id': WS,
        },
      });
      if (unknownPin.status !== 404) fail('neg-unknown-status', `unknown conversation returned ${unknownPin.status} (expected 404)`);
      if (messageLists !== listsBeforeNeg) fail('neg-native', 'denied history reached the native message surface');
      // 4. Controlled failure ONLY at the promptHost.readHistory frontier,
      // after a healthy GET: 503 history.unavailable, fixed message, no
      // native detail, no prompt.failed; then restore and recover same IDs.
      ctl.failRead = true;
      const broken = await fetch(`${base}${HIST(WS)}`, { headers: goodHeaders });
      const brokenDto = await getJson(broken);
      const brokenRaw = JSON.stringify(brokenDto);
      ctl.failRead = false;
      if (broken.status !== 503) fail('fail-status', `injected read failure returned ${broken.status} (expected 503)`);
      if (brokenDto.code !== 'history.unavailable') fail('fail-code', `expected history.unavailable, got ${brokenDto.code}`);
      if (brokenDto.message !== HISTORY_UNAVAILABLE_MESSAGE) fail('fail-message', 'failure message is not the fixed safe message');
      if (brokenRaw.includes('prompt.failed')) fail('fail-origin', 'history failure surfaced as prompt.failed');
      if (brokenRaw.includes('connection reset')) fail('fail-detail', 'native error detail leaked to the client');
      if (brokenRaw.includes(sessionId)) fail('fail-leak', 'native session id leaked into the failure body');
      const recovered = await fetch(`${base}${HIST(WS)}`, { headers: goodHeaders });
      const recoveredDto = await getJson(recovered);
      if (recovered.status !== 200) fail('recover-status', `post-failure GET returned ${recovered.status}`);
      const recIds = recoveredDto.items.map((i) => i && i.id);
       if (recIds.length !== expectedIds.length || recIds.some((id, i) => id !== expectedIds[i])) {
         fail('recover-ids', `post-failure GET ids diverged: expected ${expectedIds.length}, got ${recIds.length}`);
      }
      if (promptCalls !== 0) fail('recover-prompted', `session.prompt ran ${promptCalls}x (no inference allowed)`);
      if (transportCalls !== 0) fail('recover-transport', `finance transport called ${transportCalls}x on the history path`);
      outcome = {
        ok: true, phase: 'recover', sessionId, conversationId,
        promptCalls, transportCalls, messageLists,
        insideBinding: ctl.insideBinding,
        afterBindingRevoked: Boolean(after && after.revoked === true),
        items: healthyDto.items,
        checks: {
          healthyDto: true, orderDedup: true, bindingInside: true, bindingRevoked: true,
          negativesFailClosed: true, failureIs503: true, fixedMessage: true,
          recoverySameIds: true, zeroPrompt: true, zeroTransport: true,
        },
      };
    } finally {
      try { if (gw) await gw.close(); } catch { /* settle never fails */ }
      await tedEnv.close().catch(() => {});
    }
  } else if (phase === 'serve') {
    const sessionId = argSessionId;
    const conversationId = argConversationId;
    const userMessageId = argUserId;
    const assistantMessageId = argAssistantId;
    if (!sessionId || !conversationId || !userMessageId || !assistantMessageId) {
      fail('args', 'serve exige <sessionId> <conversationId> <userId> <assistantId>');
    }
    if (userMessageId !== userId(0) || assistantMessageId !== assistantId(0)) {
      fail('args', 'serve ids do not match the imported transcript fixture');
    }
    // Same real path as recover (createTedEnvironment + real conversation
    // store + real loopback gateway + real createPromptHost + real
    // withAuthenticatedSession), but the gateway STAYS UP until stdin says
    // otherwise so the PWA proxy/client test can drive it over HTTP.
    // Seams (declared, test-only): (1) deps.sdkModule wraps the REAL 2.2.4
    // binary to count/guard session.prompt and count message.list; (2)
    // synthetic credential seam (controlled cookie/device pair); (3)
    // stdin-driven readHistory fault flag ('fail' throws a synthetic error
    // at the promptHost.readHistory frontier, 'recover' restores).
    const { createTedEnvironment } = await import('../../src/bootstrap.mjs');
    let promptCalls = 0;
    let messageLists = 0;
    let transportCalls = 0;
    const sdkModule = {
      OpenCode: {
        create: async (opts) => {
          const real = await import('@opencode/sdk');
          const oc = await real.OpenCode.create(opts);
          if (oc.message && typeof oc.message.list === 'function') {
            const origList = oc.message.list.bind(oc.message);
            oc.message.list = async (args) => { messageLists++; return origList(args); };
          }
          if (oc.session) {
            oc.session.prompt = (async () => {
              promptCalls++;
              throw Object.assign(
                new Error('p2-real-history-guard: session.prompt must never run (no inference, no provider)'),
                { code: 'p2.prompt_guarded' },
              );
            });
          }
          return oc;
        },
      },
    };
    const transportFactory = () => (async () => {
      transportCalls++;
      return { statusCode: 200, body: { items: [], total: 0 } };
    });
    const tedEnv = await createTedEnvironment({ root, identity: IDENTITY, transportFactory, deps: { sdkModule } });
    let gw = null;
    try {
      const { createConversationStore } = await import('../../src/conversations.mjs');
      const { createGatewayServer } = await import('../../src/server.mjs');
      const { getBinding } = await import('../../src/session-bindings.mjs');
      const store = createConversationStore({ persistDir: tedEnv.dirs.state });
      const meta = store.get(conversationId, { actorId: ACTOR, workspace: WS, deviceId: DEVICE });
      if (meta.runtimeSessionId !== sessionId) {
        fail('registry-reopen', `persisted runtime binding diverged: ${meta.runtimeSessionId} != ${sessionId}`);
      }
      const realHost = tedEnv.serverOps.createPromptHost();
      const ctl = { failRead: false };
      const promptHost = {
        chat: (args) => realHost.chat(args),
        readRawMessages: (args) => realHost.readRawMessages(args),
        readHistory: async (args) => {
          void getBinding(args.sessionID);
          if (ctl.failRead) throw new Error('synthetic native history failure: connection reset');
          return realHost.readHistory(args);
        },
      };
      async function fakeResolveIdentity({ cookie, deviceToken }) {
        const { GatewayError } = await import('../../src/gateway.mjs');
        if (deviceToken !== DEVICE) {
          throw new GatewayError('auth.device_required', 'device credential is required (synthetic seam)');
        }
        const parts = String(cookie || '').split(';').map((p) => p.trim());
        if (!parts.includes(SESSION_COOKIE)) {
          throw new GatewayError('auth.session_required', 'synthetic session cookie required');
        }
        return { actorId: ACTOR, workspace: WS, deviceId: DEVICE };
      }
      gw = createGatewayServer({
        resolveIdentity: fakeResolveIdentity,
        store,
        promptHost,
        createRuntimeSession: async () => ({ runtimeSessionId: await tedEnv.serverOps.createNativeSession() }),
        withAuthenticatedSession: tedEnv.serverOps.withAuthenticatedSession,
      });
      const info = await gw.listen({ port: 0, host: '127.0.0.1' });
      if (info.host !== '127.0.0.1') fail('listen', `gateway must stay loopback, got ${info.host}`);
      const base = `http://${info.host}:${info.port}`;
      console.log(JSON.stringify({
        ok: true, phase: 'serve-ready', sessionId, conversationId,
        userMessageId, assistantMessageId,
        port: info.port, base,
        sessionCookie: SESSION_COOKIE, deviceToken: DEVICE, workspace: WS,
        messageCount: TURN_COUNT * 2,
      }));
      // Stdin command loop — keeps the event loop alive for gateway I/O.
      // Replies are single JSON lines on stdout; diagnostics go to stderr.
      process.stdin.setEncoding('utf8');
      let buf = '';
      let closing = false;
      const stats = () => ({ ok: true, phase: 'serve-stats', promptCalls, messageLists, transportCalls, failRead: ctl.failRead });
      await new Promise((resolve) => {
        const onData = (chunk) => {
          buf += String(chunk);
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim().toLowerCase();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            if (line === 'fail' || line === 'failread' || line === 'fail_read') {
              ctl.failRead = true;
              console.log(JSON.stringify({ ok: true, phase: 'serve-ctl', failRead: true }));
            } else if (line === 'recover' || line === 'ok' || line === 'heal' || line === 'restore') {
              ctl.failRead = false;
              console.log(JSON.stringify({ ok: true, phase: 'serve-ctl', failRead: false }));
            } else if (line === 'stats' || line === 'counters' || line === 'status') {
              console.log(JSON.stringify(stats()));
            } else if (line === 'close' || line === 'exit' || line === 'quit' || line === 'done') {
              closing = true;
              try { process.stdin.removeListener('data', onData); } catch { /* noop */ }
              try { process.stdin.pause(); } catch { /* noop */ }
              resolve();
              break;
            } else {
              console.log(JSON.stringify({ ok: false, phase: 'serve-ctl', step: 'serve-args', detail: `unknown serve command: ${line.slice(0, 80)}` }));
            }
          }
        };
        process.stdin.on('data', onData);
        process.stdin.on('end', () => { if (!closing) { closing = true; resolve(); } });
        process.stdin.resume();
      });
      console.log(JSON.stringify({
        ok: true, phase: 'serve-closed', sessionId, conversationId,
        promptCalls, messageLists, transportCalls,
      }));
    } finally {
      try { if (gw) await gw.close(); } catch { /* settle never fails */ }
      await tedEnv.close().catch(() => {});
    }
  } else {
    fail('args', `phase desconhecida: ${phase} (seed|recover|serve)`);
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
