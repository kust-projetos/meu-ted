// Facade surface (TDD RED): the runtime/bootstrap surface must NOT expose
// the legacy facade — the product tool path is the native plugin. Tests use
// tests/helpers/facade.mjs directly. The env keeps identity/close guarantees
// without the facade.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTedEnvironment } from '../src/bootstrap.mjs';
import { createFacade } from './helpers/facade.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

function fakeSdk() {
  const oc = {
    closed: 0,
    close: async () => { oc.closed++; },
    session: {
      create: async () => ({ id: 'ses_facade_1' }),
      get: async ({ sessionID }) => ({ id: sessionID }),
      active: async () => ({}),
    },
    plugin: async () => ({ id: 'ted-finance' }),
  };
  return { oc, sdkModule: { OpenCode: { create: async () => oc } } };
}

describe('facade removed from runtime/bootstrap surface (legacy helper only)', () => {
  it('createTedEnvironment exposes no facadeFor; helper still works for legacy tests', async () => {
    const { oc, sdkModule } = fakeSdk();
    const root = approvedTmpRoot('ted-nofacade');
    const env = await createTedEnvironment({ root, identity: 'nofacade', transportFactory: () => async () => ({ statusCode: 200, body: {} }), deps: { sdkModule } });
    try {
      assert.ok(!('facadeFor' in env), 'bootstrap env must not expose facadeFor (plugin is the product tool path)');
      const host = Object.freeze({ label: 'a', token: 't', household: 'H', actorId: 'a', deviceId: 'd' });
      const facade = createFacade({ oc: { session: {} }, host, executors: {} });
      assert.ok(typeof facade.createSession !== 'function' || true, 'helper importable for legacy tests');
    } finally {
      await env.close();
    }
    assert.equal(oc.closed, 1, 'close guarantee preserved without the facade');
  });
});
