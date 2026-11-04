// PR290-08 TDD: tool error hygiene — generic transport failures and upstream
// bodies must never reach the native tool/model context with raw text.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createToolExecutors, ToolError } from '../src/tool-defs.mjs';
import { buildExecute } from '../src/plugin.mjs';
import { bindSession, clearAll } from '../src/session-bindings.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'token-a',
  household: 'H_A',
  actorId: 'actor-a',
  deviceId: 'device-a',
});

const SECRET = 'sk-live-SECRETKEY-999-abcdef';

describe('tool error hygiene (PR290-08)', () => {
  it('generic transport throw stays tool.transport without raw text', async () => {
    const leaky = async () => {
      throw new Error(`connection reset by dependency: key=${SECRET}`);
    };
    const ex = createToolExecutors(leaky);
    const err = await ex.list_accounts({}, host, { intentionId: 'int-hyg-1' }).catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'tool.transport');
    assert.ok(!String(err.message).includes(SECRET), 'message must not contain raw dependency text');
    assert.ok(!JSON.stringify(err.details ?? {}).includes(SECRET), 'details must not contain raw dependency text');
  });

  it('non-2xx with secret-like body keeps safe status/code but no body in details', async () => {
    const body = { error: 'upstream says no', secret: SECRET, token: 'tok-leak-xyz' };
    const ex = createToolExecutors(async () => ({ statusCode: 500, body }));
    const err = await ex.list_accounts({}, host, { intentionId: 'int-hyg-2' }).catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'tool.upstream_500');
    assert.equal(err.statusCode, 500);
    assert.match(String(err.message), /upstream 500/);
    assert.ok(!String(err.message).includes(SECRET), 'message must not contain raw body text');
    assert.ok(!JSON.stringify(err.details ?? {}).includes(SECRET), 'details must not contain raw body');
    assert.equal(err.details && err.details.body, undefined, 'upstream body must not travel in details');
    assert.equal(err.body, undefined, 'upstream body must not travel on err.body');
  });

  it('buildExecute wraps an unexpected raw Error after allow with a generic safe message', async () => {
    clearAll();
    bindSession('ses_hyg1', { ...host });
    const run = async () => {
      throw new Error(`boom dependency detail ${SECRET}`);
    };
    const exec = buildExecute({ name: 'list_accounts' }, run, async () => {});
    const err = await exec(
      {},
      { sessionID: 'ses_hyg1', messageID: 'm1', id: 'call-1' },
      {},
    ).catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'tool.transport');
    assert.ok(!String(err.message).includes(SECRET), 'plugin wrapper must not propagate raw text');
    assert.ok(!JSON.stringify(err.details ?? {}).includes(SECRET), 'plugin wrapper details must not contain raw text');
    clearAll();
  });
});
