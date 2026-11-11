// Live model default (TDD RED): native OpenCode `model` selector for the
// isolated live profile — zero inference, zero network to paid providers.
//
// Proves with the REAL SDK 2.2.4 (fetch guarded, session.prompt hard-guarded
// to zero calls): the product live config resolves its native default to
// `opencode-go/deepseek-v4.1-flash` via the repo-owned template
// `src/live-model.json` (never a JS literal, never user-config inheritance),
// and a legitimate native model-only override resolves too. The test profile
// stays isolated (no model, deny-all). No fallback/paid prompt runs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupIsolation, tedConfig } from '../src/bootstrap.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const FIXTURE_PACKAGE = '@opencode/ai/providers/openai-compatible';
const FIXTURE_BASE_URL = 'http://127.0.0.1:9/v1';
const NATIVE_DEFAULT = 'opencode-go/deepseek-v4.1-flash';
const OVERRIDE_MODEL = 'opencode-go/other-model';

function fixtureModels() {
  const mk = (id, name) => ({
    name,
    modelID: id,
    capabilities: { input: ['text'], output: ['text'] },
    limit: { context: 8000, output: 2000 },
  });
  return {
    'deepseek-v4.1-flash': mk('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash (local fixture mirror)'),
    'other-model': mk('other-model', 'Other Model (override target)'),
  };
}

async function bootWithModel({ iso, file, modelSelector }) {
  const base = tedConfig('live');
  assert.equal(base.model, NATIVE_DEFAULT, 'product live config selects the native default from src/live-model.json (not JS, not user config)');
  const cfg = {
    ...base,
    ...(modelSelector !== undefined ? { model: modelSelector } : {}),
    providers: {
      'opencode-go': {
        name: 'Test local opencode-go fixture (never dialed: loopback baseURL, dummy apiKey)',
        package: FIXTURE_PACKAGE,
        settings: { baseURL: FIXTURE_BASE_URL, apiKey: 'test-fixture-not-a-secret' },
        models: fixtureModels(),
      },
    },
  };
  fs.mkdirSync(iso.dirs.config, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  const realFetch = globalThis.fetch;
  const seenFetch = [];
  globalThis.fetch = (async (url, init) => {
    let u = url;
    try {
      u = String(url && url.url ? url.url : url);
    } catch { /* keep original */ }
    seenFetch.push(`${(init && init.method) || 'GET'} ${String(u).slice(0, 220)}`);
    throw new Error('guard: no fetch may succeed in the live model-default proof (zero-network fixture)');
  });
  let oc = null;
  try {
    const sdk = await import('@opencode/sdk');
    oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });
    try {
      let promptCalls = 0;
      oc.session.prompt = (async () => {
        promptCalls++;
        throw new Error('guard: session.prompt must never run in the live model-default proof (zero inference)');
      });
      const rawDefault = await oc.model.default();
      const resolved = rawDefault && rawDefault.data !== undefined ? rawDefault.data : rawDefault;
      return { resolved, promptCalls, seenFetch, iso, file };
    } finally {
      if (oc) await oc.close().catch(() => {});
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('live model default (real SDK 2.2.4, zero inference)', () => {
  it('product live default resolves to DeepSeek; legitimate override resolves too (one isolation, zero inference)', { timeout: 180000 }, async () => {
    // Template is the ONLY source of the default string (outside JS logic).
    const tmpl = JSON.parse(fs.readFileSync(new URL('../src/live-model.json', import.meta.url), 'utf8'));
    assert.equal(tmpl.model, NATIVE_DEFAULT, 'repo-owned template holds the current default');
    const live = tedConfig('live');
    assert.equal(live.model, NATIVE_DEFAULT, 'live model comes from the template, not a JS literal');
    assert.ok(!('providers' in live), 'live injects no catalog (native resolves)');
    const testCfg = tedConfig();
    assert.ok(!('model' in testCfg), 'test profile stays isolated (no model)');

    // One host per OS process: a single isolation for both boots. The second
    // boot reuses the SAME config dir with a rewritten model-only override
    // (direct file write, never writeTedConfig overwrite) — no re-isolation.
    const root = approvedTmpRoot('ted-live-default');
    const iso = setupIsolation(root, 'livemodel-default');
    const file = path.join(iso.dirs.config, 'opencode.json');

    const first = await bootWithModel({ iso, file });
    assert.deepEqual(
      first.resolved && { id: first.resolved.id, modelID: first.resolved.modelID, providerID: first.resolved.providerID },
      { id: 'deepseek-v4.1-flash', modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
      'effective model.default() is DeepSeek for the product live default',
    );
    assert.equal(first.promptCalls, 0, 'zero session.prompt calls (no inference, no cost)');
    assert.deepEqual(
      first.seenFetch.filter((u) => u.includes('127.0.0.1:9')),
      [],
      'zero requests to the fixture provider (neither inference POST nor catalog GET)',
    );

    const second = await bootWithModel({ iso, file, modelSelector: OVERRIDE_MODEL });
    assert.deepEqual(
      second.resolved && { id: second.resolved.id, modelID: second.resolved.modelID, providerID: second.resolved.providerID },
      { id: 'other-model', modelID: 'other-model', providerID: 'opencode-go' },
      'legitimate native model override resolves via the same native selector',
    );
    assert.equal(second.promptCalls, 0, 'zero session.prompt calls on the override path too');
    assert.deepEqual(
      second.seenFetch.filter((u) => u.includes('127.0.0.1:9')),
      [],
      'zero requests to the fixture provider on the override path too',
    );
  });
});
