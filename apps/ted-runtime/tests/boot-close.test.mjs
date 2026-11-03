// Prova da garantia de close no boot (sem SDK real — host falso injetado
// via deps.sdkModule). Falhas pós-create (factory, shape, wirePlugin)
// DEVEM fechar o host antes de rejeitar: sem fibers/locks vivos.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTedEnvironment } from '../src/bootstrap.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

function fakeSdk({ onClose, plugin } = {}) {
  const oc = {
    closed: 0,
    close: async () => { oc.closed++; if (onClose) await onClose(); },
    session: {
      create: async ({ title }) => ({ id: `ses_${Math.random().toString(36).slice(2, 8)}`, title }),
      get: async ({ sessionID }) => ({ id: sessionID }),
      list: async () => [],
      remove: async ({ sessionID }) => ({ id: sessionID, removed: true }),
      active: async () => ({}),
    },
  };
  if (plugin !== undefined) oc.plugin = plugin;
  return { oc, sdkModule: { OpenCode: { create: async () => oc } } };
}

const host = Object.freeze({ label: 'a', token: 't', household: 'H', actorId: 'a', deviceId: 'd' });
// Um host por processo: os 3 testes compartilham a mesma raiz+identidade
// (via resume idempotente) para não reconfigurar os globals no meio do arquivo.
const ROOT = approvedTmpRoot('ted-bootclose');

describe('boot close guarantee (fake host)', () => {
  it('transportFactory que lança fecha o host antes de rejeitar', async () => {
    const { oc, sdkModule } = fakeSdk({ plugin: async () => {} });
    await assert.rejects(
      () => createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => { throw new Error('boom-factory'); }, deps: { sdkModule } }),
      /boom-factory/,
    );
    assert.equal(oc.closed, 1, 'host fechado exatamente uma vez na falha da factory');
  });

  it('wirePlugin que falha (sem oc.plugin) fecha o host antes de rejeitar', async () => {
    const { oc, sdkModule } = fakeSdk(); // sem plugin
    await assert.rejects(
      () => createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } }),
      /oc\.plugin/,
    );
    assert.equal(oc.closed, 1, 'host fechado exatamente uma vez na falha do wire');
  });

  it('caminho feliz expõe só revoke/clear no registry e fecha sob demanda', async () => {
    const { oc, sdkModule } = fakeSdk({ plugin: async () => ({ id: 'ted-finance' }) });
    const env = await createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } });
    assert.deepEqual(Object.keys(env.bindings).sort(), ['clearAll', 'revokeSession']);
    assert.ok(!('bindSession' in env.bindings) && !('resolveHost' in env.bindings), 'sem bind/resolve direto no env do produto');
    const facade = env.facadeFor(host);
    assert.ok(typeof facade.createSession === 'function');
    await env.close();
    assert.equal(oc.closed, 1);
  });

  it('serverOps expõe rebind autenticado privado (get+bind) sem vazar oc', async () => {
    const bound = [];
    const { oc, sdkModule } = fakeSdk({ plugin: async () => ({ id: 'ted-finance' }) });
    oc.session.prompt = async () => ({ id: 'inbox_1' });
    oc.session.interrupt = async () => ({ ok: true });
    oc.message = { list: async () => ({ data: [], cursor: { previous: null, next: null } }) };
    const env = await createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } });
    assert.ok(env.serverOps && typeof env.serverOps.bindAuthenticatedSession === 'function');
    assert.ok(typeof env.serverOps.createNativeSession === 'function');
    assert.ok(typeof env.serverOps.createPromptHost === 'function');
    assert.ok(!('oc' in env) && !('session' in env) && JSON.stringify(Object.keys(env)).length > 0, 'oc bruto nunca exposto no env');
    // bindAuthenticatedSession faz get ANTES do bind (prova de existência nativa).
    const { bindSession, resolveHost } = await import('../src/session-bindings.mjs');
    const calls = [];
    const origGet = oc.session.get;
    oc.session.get = async (a) => { calls.push(['get', a.sessionID]); return origGet(a); };
    const hostB = Object.freeze({ label: 'srv', token: 'tok', household: 'H', actorId: 'a', deviceId: 'd' });
    await env.serverOps.bindAuthenticatedSession('ses_X', hostB);
    assert.deepEqual(calls, [['get', 'ses_X']]);
    assert.equal(resolveHost('ses_X').actorId, 'a', 'bind efetivo após get');
    // createNativeSession cria via SDK (sem prompt, sem inferência).
    const id = await env.serverOps.createNativeSession();
    assert.ok(typeof id === 'string' && id.startsWith('ses_'));
    // createPromptHost entrega turnos com interrupt no cancelamento.
    const ph = env.serverOps.createPromptHost({ timeoutMs: 300, pollIntervalMs: 20 });
    const ctl = new AbortController();
    const pending = ph.chat({ sessionID: id, text: 'x?', intentionId: 'srv-1', signal: ctl.signal });
    ctl.abort();
    const err = await pending.catch((e) => e);
    assert.equal(err.code, 'prompt.cancelled');
    await env.close();
    assert.equal(oc.closed, 1);
    bound.push(1);
    void bound;
  });
});

describe('shared native session serialized rebinding with idle + quarantine (fake SDK, real bindings)', () => {
  const hostA = Object.freeze({ label: 'ted-gateway', token: 'tok-A', household: 'H_A', actorId: 'actor-A', deviceId: 'dev-A' });
  const hostB = Object.freeze({ label: 'ted-gateway', token: 'tok-B', household: 'H_A', actorId: 'actor-B', deviceId: 'dev-B' });

  function sharedSdk({ activeImpl = async () => ({}), delayInterruptMs = 0 } = {}) {
    const seenHosts = [];
    const activeCalls = [];
    const oc = {
      closed: 0,
      close: async () => { oc.closed++; },
      plugin: async () => ({ id: 'ted-finance' }),
      session: {
        create: async () => ({ id: 'ses_shared_1' }),
        get: async ({ sessionID }) => ({ id: sessionID }),
        active: async (requestOptions) => { activeCalls.push(requestOptions ?? null); return activeImpl(); },
        interrupt: async () => { if (delayInterruptMs) await new Promise((r) => setTimeout(r, delayInterruptMs)); return { ok: true }; },
      },
    };
    return { oc, sdkModule: { OpenCode: { create: async () => oc } }, seenHosts, activeCalls };
  }

  it('actor A tool callback sees A host; queued B cannot enter before idle; after idle B sees B host', async () => {
    const { createTedEnvironment } = await import('../src/bootstrap.mjs');
    let active = {}; // idle at entry; A marks busy during its guarded window
    const { oc, sdkModule } = sharedSdk({ activeImpl: async () => ({ ...active }) });
    const { clearAll } = await import('../src/session-bindings.mjs');
    clearAll();
    const env = await createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } });
    try {
      const order = [];
      const aFn = async () => {
        active = { ses_shared_1: { type: 'running' } };
        const { resolveHost } = await import('../src/session-bindings.mjs');
        order.push(`A:${resolveHost('ses_shared_1').actorId}`);
        await new Promise((r) => setTimeout(r, 30));
        active = {}; // A quiesces before returning; wrapper still proves idle on exit
        return 'A-done';
      };
      const bFn = async () => {
        const { resolveHost } = await import('../src/session-bindings.mjs');
        if (Object.keys(active).length !== 0) throw new Error('B entered before SDK session quiesced');
        order.push(`B:${resolveHost('ses_shared_1').actorId}`);
        return 'B-done';
      };
      const pA = env.serverOps.withAuthenticatedSession('ses_shared_1', hostA, aFn, { idleTimeoutMs: 500, idlePollMs: 5 });
      await new Promise((r) => setTimeout(r, 5)); // let A bind first
      const pB = env.serverOps.withAuthenticatedSession('ses_shared_1', hostB, bFn, { idleTimeoutMs: 500, idlePollMs: 5 });
      const [rA, rB] = await Promise.all([pA, pB]);
      assert.equal(rA, 'A-done');
      assert.equal(rB, 'B-done');
      assert.deepEqual(order, ['A:actor-A', 'B:actor-B']);
    } finally {
      await env.close();
      const { clearAll: clearAfter } = await import('../src/session-bindings.mjs');
      clearAfter();
    }
    assert.equal(oc.closed, 1);
  });

  it('abort/interrupt active session does not permit rebind until inactive; timeout quarantines and later use fails closed', async () => {
    const { createTedEnvironment } = await import('../src/bootstrap.mjs');
    const { clearAll, isQuarantined } = await import('../src/session-bindings.mjs');
    clearAll();
    // active() never clears: the session never quiesces.
    const { oc, sdkModule } = sharedSdk({ activeImpl: async () => ({ ses_shared_1: { type: 'running' } }) });
    const env = await createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } });
    try {
      const err = await env.serverOps.withAuthenticatedSession('ses_shared_1', hostA, async () => 'never', { idleTimeoutMs: 80, idlePollMs: 5 }).catch((e) => e);
      assert.match(String(err.code || err.message), /quarantined|busy|idle/i);
      assert.equal(isQuarantined('ses_shared_1'), true);
      const later = await env.serverOps.withAuthenticatedSession('ses_shared_1', hostB, async () => 'must-not-run', { idleTimeoutMs: 80, idlePollMs: 5 }).catch((e) => e);
      assert.match(String(later.code || later.message), /quarantined/i);
    } finally {
      await env.close();
      const { clearAll: clearAfterQ } = await import('../src/session-bindings.mjs');
      clearAfterQ();
    }
    assert.equal(oc.closed, 1);
  });
});

describe('strict session.active quiescence gate (fail-closed, 2.2.4 exact map)', () => {
  const hostA = Object.freeze({ label: 'ted-gateway', token: 'tok-A', household: 'H_A', actorId: 'actor-A', deviceId: 'dev-A' });
  const hostB = Object.freeze({ label: 'ted-gateway', token: 'tok-B', household: 'H_A', actorId: 'actor-B', deviceId: 'dev-B' });

  function strictSdk({ activeImpl = async () => ({}), onClose } = {}) {
    const oc = {
      closed: 0,
      close: async () => { oc.closed++; if (onClose) await onClose(); },
      plugin: async () => ({ id: 'ted-finance' }),
      bootSignals: [],
      session: {
        create: async () => ({ id: 'ses_strict_1' }),
        get: async ({ sessionID }) => ({ id: sessionID }),
        active: async (requestOptions) => {
          oc.bootSignals.push(requestOptions && requestOptions.signal !== undefined ? requestOptions.signal : null);
          return activeImpl();
        },
      },
    };
    return { oc, sdkModule: { OpenCode: { create: async () => oc } } };
  }

  it('isSessionActiveMap: exact 2.2.4 record only — {} idle, busy entry running; arrays/null/Set/wrappers rejected', async () => {
    const mod = await import('../src/bootstrap.mjs');
    assert.equal(typeof mod.isSessionActiveMap, 'function', 'bootstrap must export isSessionActiveMap');
    const { isSessionActiveMap } = mod;
    assert.equal(isSessionActiveMap({}), true, 'empty record is idle');
    assert.equal(isSessionActiveMap({ ses_1: { type: 'running' } }), true, 'busy record is proof of activity');
    assert.equal(isSessionActiveMap(null), false);
    assert.equal(isSessionActiveMap(undefined), false);
    assert.equal(isSessionActiveMap([]), false, 'array is not proof');
    assert.equal(isSessionActiveMap(['ses_1']), false, 'array of ids is not proof');
    assert.equal(isSessionActiveMap(new Set(['ses_1'])), false, 'Set is not proof');
    assert.equal(isSessionActiveMap('ses_1'), false);
    assert.equal(isSessionActiveMap(42), false);
    assert.equal(isSessionActiveMap({ data: {} }), false, '{data} envelope is not the direct record');
    assert.equal(isSessionActiveMap({ sessions: [] }), false);
    assert.equal(isSessionActiveMap({ ses_1: { type: 'idle' } }), false, 'non-running value is not proof');
    assert.equal(isSessionActiveMap({ ses_1: 'running' }), false, 'string value is not proof');
    assert.equal(isSessionActiveMap({ ses_1: null }), false);
    assert.equal(isSessionActiveMap({ ses_1: ['running'] }), false);
  });

  it('boot fails closed when oc.session.active is missing and closes the SDK', async () => {
    const { createTedEnvironment } = await import('../src/bootstrap.mjs');
    const oc = {
      closed: 0,
      close: async () => { oc.closed++; },
      plugin: async () => ({ id: 'ted-finance' }),
      session: {
        create: async () => ({ id: 'ses_x' }),
        get: async ({ sessionID }) => ({ id: sessionID }),
      },
    };
    const sdkModule = { OpenCode: { create: async () => oc } };
    await assert.rejects(
      () => createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } }),
      /session\.active/,
    );
    assert.equal(oc.closed, 1, 'SDK closed exactly once on missing active gate');
  });

  it('boot fails closed when active returns a non-map shape and closes the SDK', async () => {
    const { createTedEnvironment } = await import('../src/bootstrap.mjs');
    for (const bad of [['ses_x'], null, { data: { ses_x: { type: 'running' } } }, { ses_x: { type: 'idle' } }]) {
      const { oc, sdkModule } = strictSdk({ activeImpl: async () => bad });
      await assert.rejects(
        () => createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } }),
        /session\.active/i,
        `boot must refuse shape ${JSON.stringify(bad)}`,
      );
      assert.equal(oc.closed, 1, `SDK closed exactly once for shape ${JSON.stringify(bad)}`);
      const { clearAll } = await import('../src/session-bindings.mjs');
      clearAll();
    }
  });

  it('boot probe passes an AbortSignal to session.active', async () => {
    const { createTedEnvironment } = await import('../src/bootstrap.mjs');
    const { clearAll } = await import('../src/session-bindings.mjs');
    clearAll();
    const { oc, sdkModule } = strictSdk({ activeImpl: async () => ({}) });
    const env = await createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } });
    try {
      assert.ok(oc.bootSignals.length >= 1, 'boot probed session.active at least once');
      assert.ok(oc.bootSignals[0] instanceof AbortSignal, 'boot passes an AbortSignal in requestOptions');
    } finally {
      await env.close();
      clearAll();
    }
  });

  it('hanging active() during withAuthenticatedSession exits bounded, revokes+quarantines, next actor fails closed', { timeout: 8000 }, async () => {
    const { createTedEnvironment } = await import('../src/bootstrap.mjs');
    const bindings = await import('../src/session-bindings.mjs');
    bindings.clearAll();
    // active() never settles — the old unbounded await would stick the per-session queue forever.
    const { oc, sdkModule } = strictSdk({ activeImpl: () => new Promise(() => {}) });
    // Boot gate itself would hang on this double; bypass the gate for this
    // unit by booting with a healthy probe then swapping in the hanging impl.
    let hang = false;
    const { oc: ocBoot, sdkModule: sdkBoot } = strictSdk({ activeImpl: async () => (hang ? new Promise(() => {}) : ({})) });
    const env = await createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule: sdkBoot } });
    hang = true;
    // Swap the live host's probe to the hanging one (same oc object the env closed over).
    ocBoot.session.active = oc.session.active;
    try {
      const started = Date.now();
      const err = await env.serverOps.withAuthenticatedSession('ses_hang_1', hostA, async () => 'never-runs', { idleTimeoutMs: 200, idlePollMs: 10 }).catch((e) => e);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 4000, `bounded exit (elapsed ${elapsed}ms < 4000ms)`);
      assert.match(String(err.code || err.message), /quarantined/i, 'hang classifies as cannot-prove-idle with quarantine');
      assert.equal(bindings.isQuarantined('ses_hang_1'), true, 'session quarantined after hanging probe');
      const later = await env.serverOps.withAuthenticatedSession('ses_hang_1', hostB, async () => 'must-not-run', { idleTimeoutMs: 200, idlePollMs: 10 }).catch((e) => e);
      assert.match(String(later.code || later.message), /quarantined/i, 'next actor fails closed on quarantined session');
    } finally {
      await env.close();
      bindings.clearAll();
    }
    assert.equal(ocBoot.closed, 1);
  });

  it('rejected active probe quarantines the session and fails the queued actor closed', async () => {
    const { createTedEnvironment } = await import('../src/bootstrap.mjs');
    const bindings = await import('../src/session-bindings.mjs');
    bindings.clearAll();
    let fail = false;
    const { oc, sdkModule } = strictSdk({
      activeImpl: async () => {
        if (fail) throw new Error('probe-boom');
        return {};
      },
    });
    const env = await createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } });
    try {
      fail = true; // boot probe already passed with {}; only operation probes reject
      const err = await env.serverOps.withAuthenticatedSession('ses_rej_1', hostA, async () => 'never-runs', { idleTimeoutMs: 200, idlePollMs: 10 }).catch((e) => e);
      assert.match(String(err.code || err.message), /quarantined/i);
      assert.equal(bindings.isQuarantined('ses_rej_1'), true, 'rejected probe quarantines');
      const later = await env.serverOps.withAuthenticatedSession('ses_rej_1', hostB, async () => 'must-not-run', { idleTimeoutMs: 200, idlePollMs: 10 }).catch((e) => e);
      assert.match(String(later.code || later.message), /quarantined/i);
    } finally {
      await env.close();
      bindings.clearAll();
    }
    assert.equal(oc.closed, 1);
  });

  it('every operation probe passes an AbortSignal to session.active', async () => {
    const { createTedEnvironment } = await import('../src/bootstrap.mjs');
    const bindings = await import('../src/session-bindings.mjs');
    bindings.clearAll();
    const seen = [];
    const { oc, sdkModule } = strictSdk({
      activeImpl: async () => ({}),
    });
    const origActive = oc.session.active;
    oc.session.active = async (requestOptions) => {
      seen.push(requestOptions && requestOptions.signal !== undefined ? requestOptions.signal : null);
      return origActive(requestOptions);
    };
    const env = await createTedEnvironment({ root: ROOT, identity: 'a', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } });
    try {
      const out = await env.serverOps.withAuthenticatedSession('ses_sig_1', hostA, async () => 'ok', { idleTimeoutMs: 500, idlePollMs: 10 });
      assert.equal(out, 'ok');
      const opSignals = seen.slice(1); // first entry is the boot probe
      assert.ok(opSignals.length >= 2, 'pre + post operation probes ran');
      for (const sig of opSignals) assert.ok(sig instanceof AbortSignal, 'operation probe receives an AbortSignal');
    } finally {
      await env.close();
      bindings.clearAll();
    }
  });
});
