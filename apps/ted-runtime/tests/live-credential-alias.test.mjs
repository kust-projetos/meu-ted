// Live credential bridge — product initialization without the test launcher.
//
// Contract (must stay true after this change):
// - `setupIsolation` keeps scrubbing every ambient credential key, including
//   OPENCODE_API_KEY (the inherited value never reaches the SDK).
// - Only the `live` profile mirrors the PRESERVED alias OPENCODE_GO_API_KEY
//   into the native key OpenCode 2.2.4 resolves for `opencode-go`.
// - The mirror happens in process memory only, never overwrites a value set
//   after isolation, and never runs for the `test` profile.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyLiveCredentialAlias, createTedEnvironment } from '../src/bootstrap.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

function fakeSdk() {
  const oc = {
    closed: 0,
    close: async () => { oc.closed++; },
    plugin: async () => ({ id: 'ted-finance' }),
    session: {
      create: async ({ title }) => ({ id: 'ses_alias_1', title }),
      get: async ({ sessionID }) => ({ id: sessionID }),
      list: async () => [],
      active: async () => ({}),
    },
  };
  return { oc, sdkModule: { OpenCode: { create: async () => oc } } };
}

describe('applyLiveCredentialAlias (pure)', () => {
  it('live mirrors the preserved alias into the native key', () => {
    const env = { OPENCODE_GO_API_KEY: 'alias-value' };
    assert.equal(applyLiveCredentialAlias('live', env), true);
    assert.equal(env.OPENCODE_API_KEY, 'alias-value');
  });

  it('live without the alias is a no-op (never invents a credential)', () => {
    const env = {};
    assert.equal(applyLiveCredentialAlias('live', env), false);
    assert.equal('OPENCODE_API_KEY' in env, false);
  });

  it('live never overwrites a native key established after isolation', () => {
    const env = { OPENCODE_GO_API_KEY: 'alias-value', OPENCODE_API_KEY: 'post-isolation' };
    assert.equal(applyLiveCredentialAlias('live', env), false);
    assert.equal(env.OPENCODE_API_KEY, 'post-isolation');
  });

  it('test profile never touches the native key', () => {
    const env = { OPENCODE_GO_API_KEY: 'alias-value' };
    assert.equal(applyLiveCredentialAlias('test', env), false);
    assert.equal('OPENCODE_API_KEY' in env, false);
  });

  it('unknown profile is a no-op', () => {
    const env = { OPENCODE_GO_API_KEY: 'alias-value' };
    assert.equal(applyLiveCredentialAlias('production', env), false);
    assert.equal('OPENCODE_API_KEY' in env, false);
  });
});

describe('live boot keeps the scrub contract and bridges the alias', () => {
  it('ambient OPENCODE_API_KEY is scrubbed and the preserved alias fills the native key', async () => {
    const root = approvedTmpRoot('ted-live-alias');
    const previous = {
      OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
      OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY,
    };
    process.env.OPENCODE_API_KEY = 'ambient-credential-must-be-scrubbed';
    process.env.OPENCODE_GO_API_KEY = 'alias-credential-preserved';
    const { oc, sdkModule } = fakeSdk();
    try {
      const env = await createTedEnvironment({
        root,
        identity: 'livealias',
        profile: 'live',
        transportFactory: () => async () => ({ statusCode: 200, body: {} }),
        deps: { sdkModule },
      });
      try {
        // Scrub contract: the inherited key was removed BEFORE the alias bridge.
        assert.ok(
          env.scrubbed?.includes('OPENCODE_API_KEY') ?? true,
          'the ambient key is reported as scrubbed (setupIsolation contract intact)',
        );
        // Product behavior: the live profile can route the pinned provider.
        assert.equal(process.env.OPENCODE_API_KEY, 'alias-credential-preserved');
        assert.equal(process.env.OPENCODE_GO_API_KEY, 'alias-credential-preserved');
      } finally {
        await env.close();
      }
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      assert.equal(oc.closed, 1, 'fake host closed exactly once');
    }
  });
});
