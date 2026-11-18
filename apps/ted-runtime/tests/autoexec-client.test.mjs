import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoExecClient } from '../src/autoexec-client.mjs';

const serviceToken = 's'.repeat(32);
const base = { apiBaseUrl: 'http://127.0.0.1:3001', serviceToken };
const ok = (data, status = 200) => ({ status, ok: status < 300, async json() { return data; } });
test('fails closed on absent/short service token and unauthorized origins', () => {
  for (const token of [undefined, 'short']) assert.throws(() => createAutoExecClient({ ...base, serviceToken: token }), /autoexec unavailable/);
  assert.throws(() => createAutoExecClient({ ...base, apiBaseUrl: 'https://example.invalid' }), /autoexec unavailable/);
  assert.doesNotThrow(() => createAutoExecClient({ ...base, apiBaseUrl: 'https://api.internal', allowedApiOrigins: ['https://api.internal'] }));
});

test('uses manual redirects, scoped credentials and maps real V2 response contracts', async () => {
  const seen = [];
  const responses = [
    { token: 'minted', expiresAt: 'later' }, { id: 'pending', existing: false },
    { id: 'pending', status: 'confirmed', attestation: 'a'.repeat(32) },
    { id: 'pending', status: 'succeeded', execution: { status: 'succeeded' } },
  ];
  const client = createAutoExecClient({ ...base, fetchImpl: async (url, options) => { seen.push({ url, options }); return ok(responses.shift()); } });
  await client.mint({ workspaceId: 'w', actorId: 'a', deviceId: 'd', intentionId: 'i' });
  assert.deepEqual(await client.propose({ token: 'bearer', workspaceId: 'w', actorId: 'a', deviceId: 'd', idempotencyKey: 'key', normalizedArgs: { name: 'Food', kind: 'expense' } }), { operationId: 'pending', existing: false });
  assert.equal((await client.authorize({ token: 'bearer', workspaceId: 'w', actorId: 'a', deviceId: 'd', operationId: 'pending' })).status, 'confirmed');
  assert.equal((await client.execute({ token: 'bearer', workspaceId: 'w', actorId: 'a', deviceId: 'd', operationId: 'pending', attestation: 'a'.repeat(32) })).status, 'succeeded');
  assert.ok(seen.every(({ options }) => options.redirect === 'manual'));
  assert.equal(seen[0].url, 'http://127.0.0.1:3001/auth/agent/autoexec-token');
  assert.equal(seen[0].options.headers['x-agent-autoexec-service-token'], serviceToken);
  assert.equal(seen[0].options.headers.authorization, undefined);
  for (const { options } of seen.slice(1)) {
    assert.equal(options.headers.authorization, 'Bearer bearer');
    assert.equal(options.headers['x-workspace-id'], 'w');
    assert.equal(options.headers['x-actor-id'], 'a');
    assert.equal(options.headers['x-device-id'], 'd');
    assert.equal(options.headers['x-agent-autoexec-service-token'], undefined);
  }
  assert.equal(seen[1].options.headers['Idempotency-Key'], 'key');
});

test('uses caller-supplied mint path and service header name', async () => {
  let request;
  const client = createAutoExecClient({
    ...base,
    mintPath: '/auth/agent/category-autoexec-token',
    serviceHeaderName: 'x-agent-category-autoexec-service-token',
    fetchImpl: async (url, options) => { request = { url, options }; return ok({ token: 'minted' }); },
  });
  await client.mint({ workspaceId: 'w', actorId: 'a', deviceId: 'd', intentionId: 'i' });
  assert.equal(request.url, 'http://127.0.0.1:3001/auth/agent/category-autoexec-token');
  assert.equal(request.options.headers['x-agent-category-autoexec-service-token'], serviceToken);
  assert.equal(request.options.headers['x-agent-autoexec-service-token'], undefined);
});

test('preserves existing:true from the V2 propose response', async () => {
  const client = createAutoExecClient({
    ...base,
    fetchImpl: async () => ok({ id: 'pending-existing', existing: true }),
  });
  assert.deepEqual(await client.propose({
    token: 'bearer', workspaceId: 'w', actorId: 'a', deviceId: 'd',
    idempotencyKey: 'key', normalizedArgs: { name: 'Food', kind: 'expense' },
  }), { operationId: 'pending-existing', existing: true });
});

test('redirect and timeout fail with safe fixed errors', async () => {
  const redirect = createAutoExecClient({ ...base, fetchImpl: async () => ok({}, 302) });
  await assert.rejects(redirect.mint({}), (e) => e.code === 'upstream_error' && !e.message.includes(serviceToken));
  const timeout = createAutoExecClient({ ...base, timeoutMs: 1, fetchImpl: async (_u, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error(serviceToken), { name: 'AbortError' }))) ) });
  await assert.rejects(timeout.mint({}), (e) => e.code === 'uncertain' && !e.message.includes(serviceToken));
});
