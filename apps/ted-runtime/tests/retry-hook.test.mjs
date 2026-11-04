// PR290-RETRY-HOOK — TDD contract: native session retry hook vetoes
// automatic retries for TED sessions (user explicit no-retry rule).
// Supported boundary only: session.hook('retry') with
// SessionRetry.decision = {retry:false}|{retry:true,delay:number}
// (installed 2.2.4 session.d.ts). No config field, no fixture header.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defineTedFinancePlugin } from '../src/plugin.mjs';

function fakeCtx(captured) {
  return {
    permission: { assert: async () => {} },
    session: {
      hook: async (name, cb) => {
        captured.push({ name, cb });
        return { dispose: async () => {} };
      },
    },
    tool: {
      list: async () => [],
      transform: async (fn) => { fn({ add: () => {} }); },
    },
  };
}

describe('PR290-RETRY-HOOK: session retry veto (ted only)', () => {
  it('vetoes a retry proposal for ted, leaves non-ted untouched', async () => {
    const captured = [];
    const pluginDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }));
    await pluginDef.setup(fakeCtx(captured));
    const retry = captured.find((h) => h.name === 'retry');
    assert.ok(retry, 'plugin must register the native session retry hook');
    const tedEvent = { agent: 'ted', decision: { retry: true, delay: 1000 }, attempt: 1 };
    await retry.cb(tedEvent);
    assert.deepEqual(tedEvent.decision, { retry: false }, 'ted retry proposal must be vetoed (no delay, no repeat)');
    const otherEvent = { agent: 'other', decision: { retry: true, delay: 1000 }, attempt: 1 };
    await otherEvent.decision && retry.cb(otherEvent);
    assert.deepEqual(otherEvent.decision, { retry: true, delay: 1000 }, 'non-ted sessions must not be affected');
  });

  it('fails plugin setup closed when the native session hook is unavailable', async () => {
    const pluginDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }));
    let added = 0;
    await assert.rejects(
      () => pluginDef.setup({
        permission: { assert: async () => {} },
        tool: { transform: async (fn) => { fn({ add: () => { added++; } }); } },
      }),
      /session\.hook|retry/i,
      'missing native retry hook must fail setup closed before tools register',
    );
    assert.equal(added, 0, 'no tools may register when the retry veto cannot be installed');
  });
});
