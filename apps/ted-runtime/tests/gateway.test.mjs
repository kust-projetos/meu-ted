// P1 gateway identity tests (doubles only — no API, no SDK).
// Proves: loopback-only origin, 401/403/timeout mapping, A/B workspace
// isolation via canonical mint, device agreement, and secret redaction.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GatewayError,
  assertLoopbackApiOrigin,
  redactForLog,
  resolveGatewayIdentity,
} from '../src/gateway.mjs';

function jwt(sub, deviceId) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub, ...(deviceId ? { deviceId } : {}) })}.sig`;
}

const TOKEN = 'dev-tok-AAA';
const COOKIE = 'better-auth.session_token=sess-AAA';

function stubFetch({ mintStatus = 200, mintBody = null, deviceStatus = 200, deviceBody = null, onRequest = null, hang = false } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (onRequest) onRequest(url, init);
    if (hang) {
      // Never resolves on its own; honors abort like a real fetch so the
      // gateway timeout path can be exercised without hanging the suite.
      return new Promise((_, rej) => {
        const sig = init && init.signal;
        if (sig && typeof sig.addEventListener === 'function') {
          if (sig.aborted) {
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        }
      });
    }
    if (url.endsWith('/auth/agent-token')) {
      return { status: mintStatus, json: async () => mintBody };
    }
    if (url.endsWith('/auth/devices/me')) {
      return { status: deviceStatus, json: async () => deviceBody };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { seen, fetchImpl };
}

const MINT_OK = () => ({ token: jwt('actor-A', 'dev-A'), workspace: 'H_A', role: 'owner' });
const DEVICE_OK = () => ({ deviceId: 'dev-A', householdId: 'H_A' });

describe('gateway identity resolution (server-side only)', () => {
  it('resolves actor/workspace/role/device from the API authority', async () => {
    const { seen, fetchImpl } = stubFetch({ mintBody: MINT_OK(), deviceBody: DEVICE_OK() });
    const id = await resolveGatewayIdentity({
      apiBaseUrl: 'http://127.0.0.1:8787', cookie: COOKIE, deviceToken: TOKEN, workspaceId: 'H_A', fetchImpl,
    });
    assert.deepEqual(id, { actorId: 'actor-A', workspace: 'H_A', role: 'owner', deviceId: 'dev-A', deviceHousehold: 'H_A' });
    assert.equal(seen.length, 2);
    // Mint carries cookie + explicit workspace + device; never a bearer.
    const mintHeaders = seen[0].init.headers;
    assert.equal(mintHeaders.cookie, COOKIE);
    assert.equal(mintHeaders['x-workspace-id'], 'H_A');
    assert.equal(mintHeaders['x-device-token'], TOKEN);
    assert.ok(!('authorization' in mintHeaders));
    // Device resolution carries ONLY the device token.
    assert.deepEqual(seen[1].init.headers, { 'x-device-token': TOKEN, accept: 'application/json' });
    assert.equal(seen[0].init.redirect, 'manual');
  });

  it('canonical mint workspace wins: request hint for H_B is rejected when authority says H_A', async () => {
    const { fetchImpl } = stubFetch({ mintBody: MINT_OK(), deviceBody: DEVICE_OK() });
    const id = await resolveGatewayIdentity({
      apiBaseUrl: 'http://127.0.0.1:8787', cookie: COOKIE, deviceToken: TOKEN, workspaceId: 'H_B', fetchImpl,
    });
    // The mint was issued for H_A (canonical) — the gateway returns the
    // authority workspace, so the server layer can refuse the H_B path.
    assert.equal(id.workspace, 'H_A');
    assert.equal(id.deviceHousehold, 'H_A');
  });

  it('maps 401/403/timeout to typed errors without secrets', async () => {
    const s401 = stubFetch({ mintStatus: 401, mintBody: { code: 'auth.session_required' } });
    const e401 = await resolveGatewayIdentity({
      apiBaseUrl: 'http://127.0.0.1:9', cookie: COOKIE, deviceToken: TOKEN, workspaceId: 'H_A', fetchImpl: s401.fetchImpl,
    }).catch((e) => e);
    assert.equal(e401.code, 'auth.session_required');

    const s403 = stubFetch({ mintStatus: 403, mintBody: { code: 'auth.workspace_forbidden' } });
    const e403 = await resolveGatewayIdentity({
      apiBaseUrl: 'http://127.0.0.1:9', cookie: COOKIE, deviceToken: TOKEN, workspaceId: 'H_X', fetchImpl: s403.fetchImpl,
    }).catch((e) => e);
    assert.equal(e403.code, 'auth.workspace_forbidden');

    const hanging = stubFetch({ hang: true });
    const eTimeout = await resolveGatewayIdentity({
      apiBaseUrl: 'http://127.0.0.1:9', cookie: COOKIE, deviceToken: TOKEN, workspaceId: 'H_A',
      fetchImpl: hanging.fetchImpl, timeoutMs: 30,
    }).catch((e) => e);
    assert.equal(eTimeout.code, 'gateway.timeout');
    assert.ok(!String(eTimeout.message).includes(TOKEN));
    assert.ok(!String(eTimeout.message).includes(COOKIE));
  });

  it('device mismatch fails closed: household B device cannot act in workspace A', async () => {
    const { fetchImpl } = stubFetch({
      mintBody: { token: jwt('actor-A', 'dev-B'), workspace: 'H_A', role: 'member' },
      deviceBody: { deviceId: 'dev-B', householdId: 'H_B' },
    });
    const err = await resolveGatewayIdentity({
      apiBaseUrl: 'http://127.0.0.1:9', cookie: COOKIE, deviceToken: 'dev-tok-BBB', workspaceId: 'H_A', fetchImpl,
    }).catch((e) => e);
    assert.equal(err.code, 'auth.workspace_forbidden');
  });

  it('minted-device claim disagreeing with resolved device fails closed', async () => {
    const { fetchImpl } = stubFetch({
      mintBody: { token: jwt('actor-A', 'dev-OTHER'), workspace: 'H_A', role: 'member' },
      deviceBody: DEVICE_OK(),
    });
    const err = await resolveGatewayIdentity({
      apiBaseUrl: 'http://127.0.0.1:9', cookie: COOKIE, deviceToken: TOKEN, workspaceId: 'H_A', fetchImpl,
    }).catch((e) => e);
    assert.equal(err.code, 'auth.workspace_forbidden');
  });

  it('refuses non-loopback API origins (no secrets to remote hosts)', async () => {
    const { fetchImpl } = stubFetch({ mintBody: MINT_OK(), deviceBody: DEVICE_OK() });
    for (const origin of ['https://api.example.com', 'http://192.168.1.10:3000', 'http://api.internal:3000/']) {
      const err = await resolveGatewayIdentity({
        apiBaseUrl: origin, cookie: COOKIE, deviceToken: TOKEN, workspaceId: 'H_A', fetchImpl,
      }).catch((e) => e);
      assert.ok(err instanceof GatewayError, origin);
      assert.equal(err.code, 'gateway.invalid_origin');
    }
    assert.throws(() => assertLoopbackApiOrigin('http://127.0.0.1:3000/api'), /bare origin/);
  });

  it('missing cookie/device fails closed before any I/O', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error('must not be called'); };
    const e1 = await resolveGatewayIdentity({ apiBaseUrl: 'http://127.0.0.1:9', cookie: '', deviceToken: TOKEN, workspaceId: 'H_A', fetchImpl }).catch((e) => e);
    assert.equal(e1.code, 'auth.session_required');
    const e2 = await resolveGatewayIdentity({ apiBaseUrl: 'http://127.0.0.1:9', cookie: COOKIE, deviceToken: '', workspaceId: 'H_A', fetchImpl }).catch((e) => e);
    assert.equal(e2.code, 'auth.device_required');
    assert.equal(calls, 0);
  });

  it('redactForLog strips credentials and never the structure', () => {
    const out = redactForLog({
      cookie: COOKIE,
      'x-device-token': TOKEN,
      nested: { token: 'tok-secret', workspace: 'H_A' },
      list: [{ authorization: 'Bearer x' }, { ok: 1 }],
    });
    const flat = JSON.stringify(out);
    assert.ok(!flat.includes(COOKIE) && !flat.includes(TOKEN) && !flat.includes('Bearer x') && !flat.includes('tok-secret'));
    assert.ok(flat.includes('H_A'));
    assert.equal(out.cookie, '[redacted]');
  });
});
