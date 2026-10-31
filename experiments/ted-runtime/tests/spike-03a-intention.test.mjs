// Spike 03A remediation T3: separate the native CallID from the financial intention.
//
// RED-first: pre-fix, the plugin defaults intentionId to the native callID
// (ctx.id) — two distinct CallIDs yield distinct intentions, so a retry mints
// a NEW intention instead of reusing the stable one. These tests FAIL pre-fix
// (the `deriveIntentionId` import itself does not exist, and the structural
// assertions document the ctx.id fallback) and go GREEN after the fix.
//
// Minimal contract (pinned here, no authorization framework):
//   - deriveIntentionId({sessionID, messageID|clientMessageId}) is STABLE:
//     same session+message => same intention across retries (CallIDs differ,
//     intention equal). Distinct sessions/messages => distinct intentions.
//     Extra fields (callID, turns) NEVER perturb the derivation.
//   - The plugin NEVER uses ctx.id as intentionId. ctx.id travels ONLY as
//     technical correlation (opts.callId). intentionId is never read from
//     tool args (FORBIDDEN_KEYS already blocks it — pinned behaviorally).
//   - Every finance executor call requires a stable opts.intentionId
//     (tool.invalid_args when absent — the future write-path guard); hostless
//     execution still fail-closes host_context_required regardless of args.
//   - For reads, CallID correlation may ride along in opts; for writes (none
//     exist in this spike) the executor comment requires stable intentionId
//     + a valid binding — enforced by the same two guards above.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deriveIntentionId, createToolExecutors } from '../bootstrap/ted-finance-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(HERE, '..', 'bootstrap');
const TED = path.join(HERE, '..');
const requireBoot = createRequire(path.join(BOOT, 'run-identity.mjs'));

process.env.TED_HOME_ROOT = TED;
const { setupIsolation } = requireBoot('./env.cjs');

// Synthetic identities (same store as spike-02/03a). Never real credentials.
const HOST_A = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
const HOST_B = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };

let seq = 0;
function synthCtx(sessionID, messageID, callID, extra) {
  seq += 1;
  return { sessionID, agent: 'ted', messageID: messageID || `msg-t3-${seq}`, id: callID || `call-t3-${seq}`, ...(extra || {}) };
}

let gw;
let env;
let bindings;
const tools = {};
const errorTexts = [];

function codeOf(err) {
  return (err && err.metadata && err.metadata.code) || (err && err.code);
}

async function capture(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    errorTexts.push(String((error && error.message) || error));
    return { ok: false, error };
  }
}

describe('spike-03a T3 intention: stable intentionId, CallID as correlation only', () => {
  before(async () => {
    setupIsolation('c');
    gw = await import('../bootstrap/ted-gateway.mjs');
    env = await gw.createTedEnvironment({ identity: 'c' });
    bindings = env.bindings;

    delete process.env.TED_FINANCE_MARKER_FILE; // stub ctx: no marker side effects
    const plugin = (await import('../bootstrap/plugins/ted-finance/index.mjs')).default;
    assert.equal(plugin.id, 'ted-finance');
    await plugin.setup({
      tool: {
        transform: async (cb) => { cb({ add: (t) => { tools[t.name] = t; } }); },
        list: async () => [],
      },
    });
    assert.ok(tools.list_accounts && tools.get_month_summary, 'both finance tools captured via native transform');
  });

  after(async () => {
    try { bindings.clearAll(); } catch { /* best effort */ }
    await env.close().catch(() => {});
  });

  it('(T3-a) deriveIntentionId is stable across retries (CallIDs differ, intention equal)', () => {
    const retry1 = deriveIntentionId({ sessionID: 'sT3-A', messageID: 'msg-t3-1' });
    assert.equal(typeof retry1, 'string');
    assert.ok(retry1.length > 0, 'intention is a non-empty string');
    const retry2 = deriveIntentionId({ sessionID: 'sT3-A', messageID: 'msg-t3-1' });
    assert.equal(retry2, retry1, 'same session+message must derive the same intention across retries');
    const alias = deriveIntentionId({ sessionID: 'sT3-A', clientMessageId: 'msg-t3-1' });
    assert.equal(alias, retry1, 'clientMessageId alias derives identically to messageID');
    const withCall = deriveIntentionId({ sessionID: 'sT3-A', messageID: 'msg-t3-1', callID: 'call-t3-other' });
    assert.equal(withCall, retry1, 'a different CallID must not perturb the derived intention');
  });

  it('(T3-b) distinct sessions/messages derive distinct intentions', () => {
    const base = deriveIntentionId({ sessionID: 'sT3-A', messageID: 'msg-t3-1' });
    assert.notEqual(deriveIntentionId({ sessionID: 'sT3-A', messageID: 'msg-t3-2' }), base, 'different message => different intention');
    assert.notEqual(deriveIntentionId({ sessionID: 'sT3-B', messageID: 'msg-t3-1' }), base, 'different session => different intention');
  });

  it('(T3-c) missing session/message fails closed with tool.invalid_args', () => {
    for (const bad of [{}, { sessionID: 's' }, { messageID: 'm' }, { sessionID: '', messageID: 'm' }, { sessionID: 's', messageID: '' }, null]) {
      assert.throws(
        () => deriveIntentionId(bad),
        (e) => e && e.code === 'tool.invalid_args',
        `deriveIntentionId(${JSON.stringify(bad)}) must throw tool.invalid_args`,
      );
    }
  });

  it('(T3-d) forged intentionId via tool args is rejected (FORBIDDEN_KEYS pin)', async () => {
    bindings.bindSession('sT3-forge', HOST_A);
    const r1 = await capture(tools.list_accounts.execute({ intentionId: 'forged-intention' }, synthCtx('sT3-forge')));
    assert.equal(r1.ok, false, 'forged intentionId in args must be rejected');
    assert.equal(codeOf(r1.error), 'tool.invalid_args');
    const r2 = await capture(
      tools.get_month_summary.execute({ yearMonth: '2026-06', intentionId: 'forged-too' }, synthCtx('sT3-forge')),
    );
    assert.equal(r2.ok, false);
    assert.equal(codeOf(r2.error), 'tool.invalid_args');
  });

  it('(T3-e) executor requires a stable intentionId; hostless still fail-closed', async () => {
    const execs = createToolExecutors(async () => ({ statusCode: 200, body: { ok: true } }));
    // Missing intentionId: rejected BEFORE transport (future write-path guard).
    const r1 = await capture(execs.list_accounts({}, HOST_A, {}));
    assert.equal(r1.ok, false, 'executor without opts.intentionId must fail');
    assert.equal(codeOf(r1.error), 'tool.invalid_args');
    // Hostless: blocked regardless of intention (existing fail-closed, pinned).
    const r2 = await capture(execs.list_accounts({}, null, { intentionId: 'int-stable-1' }));
    assert.equal(r2.ok, false);
    assert.equal(codeOf(r2.error), 'host_context_required');
    // Stable intention + CallID correlation: accepted, body passes through.
    const ok = await execs.list_accounts(
      {},
      HOST_A,
      { intentionId: deriveIntentionId({ sessionID: 's', messageID: 'm' }), callId: 'call-correlation-only' },
    );
    assert.deepEqual(ok, { ok: true });
  });

  it('(T3-f) plugin retry with distinct CallIDs shares one intention (structural + identical outputs)', async () => {
    bindings.bindSession('sT3-retry', HOST_A);
    const r1 = await tools.get_month_summary.execute(
      { yearMonth: '2026-06' },
      synthCtx('sT3-retry', 'msg-t3-same', 'call-t3-first'),
    );
    const r2 = await tools.get_month_summary.execute(
      { yearMonth: '2026-06' },
      synthCtx('sT3-retry', 'msg-t3-same', 'call-t3-second'),
    );
    assert.deepEqual(r2.output, r1.output, 'retry with a new CallID returns the same result');
    // Structural (same precedent as test (r4)): the CallID-as-intention
    // fallback is gone; derivation + correlation are explicit in source.
    const src = fs.readFileSync(path.join(BOOT, 'plugins', 'ted-finance', 'index.mjs'), 'utf8');
    assert.ok(src.includes('deriveIntentionId'), 'plugin must derive the intention via deriveIntentionId');
    assert.ok(!src.includes('? id'), 'plugin must not fall back to ctx.id (CallID) as intentionId');
    assert.ok(src.includes('callId'), 'CallID travels as technical correlation only');
  });

  it('(T3-g) hostile opts.host/route/method never reach the transport (P1)', async () => {
    const seen = [];
    const execs = createToolExecutors(async (t) => {
      seen.push(t);
      return { statusCode: 200, body: { ok: true } };
    });
    const stable = deriveIntentionId({ sessionID: 'sT3-g', messageID: 'msg-t3-g' });
    const ac = new AbortController();
    const body = await execs.list_accounts(
      {},
      HOST_A,
      {
        intentionId: stable,
        callId: 'call-t3-g',
        host: HOST_B, route: '/evil', method: 'POST', // hostile: must be ignored
        seed: 'empty', fault: null, workspaceId: 'w', tokenStore: 'ts', access: 'a',
        delayMs: 11, timeoutMs: 5000, signal: ac.signal,
      },
    );
    assert.deepEqual(body, { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, HOST_A, 'transport must receive the bound host, never opts.host');
    assert.equal(seen[0].host.token, 'dev-token-1');
    assert.equal(seen[0].route, '/accounts', 'route stays derived, never opts.route');
    assert.equal(seen[0].method, 'GET', 'method stays GET, never opts.method');
    // Allowlisted test-only passthrough is preserved.
    assert.equal(seen[0].intentionId, stable);
    assert.equal(seen[0].callId, 'call-t3-g');
    assert.equal(seen[0].seed, 'empty');
    assert.equal(seen[0].delayMs, 11);
    assert.equal(seen[0].timeoutMs, 5000);
    assert.equal(seen[0].signal, ac.signal);
    assert.equal(seen[0].workspaceId, 'w');
    assert.equal(seen[0].tokenStore, 'ts');
    assert.equal(seen[0].access, 'a');
  });

  it('(T3-h) plugin transports the derived intention: retries share it, CallIDs differ (P2)', async () => {
    const { buildExecute } = await import('../bootstrap/plugins/ted-finance/index.mjs');
    assert.equal(typeof buildExecute, 'function', 'plugin must export the execute builder (derivation lives in the plugin)');
    bindings.bindSession('sT3-cap', HOST_A);
    const seen = [];
    const stubRun = async (input, host, opts) => {
      seen.push({ input, host, opts });
      return { ok: true };
    };
    const execute = buildExecute({ name: 'list_accounts' }, stubRun);
    const ac = new AbortController();
    const r1 = await execute({}, synthCtx('sT3-cap', 'msg-cap-1', 'call-cap-first'), { delayMs: 7 });
    const r2 = await execute(
      {},
      { ...synthCtx('sT3-cap', 'msg-cap-1', 'call-cap-second'), signal: ac.signal },
      {},
    );
    const r3 = await execute({}, synthCtx('sT3-cap', 'msg-cap-2', 'call-cap-third'), {});
    assert.deepEqual(r1.output, { ok: true });
    assert.equal(seen.length, 3);
    const [c1, c2, c3] = seen.map((s) => s.opts);
    assert.equal(c1.intentionId, c2.intentionId, 'same session+message across retries => same intention');
    assert.notEqual(c1.callId, c2.callId, 'retries mint distinct CallIDs');
    assert.notEqual(c1.intentionId, c3.intentionId, 'distinct messages => distinct intentions');
    assert.notEqual(c1.intentionId, c1.callId, 'intentionId is never the CallID');
    assert.equal(c1.intentionId, deriveIntentionId({ sessionID: 'sT3-cap', messageID: 'msg-cap-1' }));
    assert.equal(seen[0].host.token, 'dev-token-1', 'resolved host travels to the executor');
    assert.equal(c2.signal, ac.signal, 'live ctx signal is forwarded');
    assert.equal(c1.delayMs, 7, 'tool-call opts passthrough (delayMs) preserved');
  });
});
