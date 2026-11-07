// P1 model config: native selection + legitimate override merge (no
// inference, no SDK, no network).
//
// Proves: test profile sets NO `model` selector (isolated); live profile
// selects the native default from the repo-owned template
// `src/live-model.json` (currently `opencode-go/deepseek-v4.1-flash` — data,
// never a JS literal, changes without production-code edits);
// writeTedConfig preserves a legitimate native `model` override byte-for-byte
// (no overwrite, no credential touch) while still refusing any other
// divergence (policies/agents/default_agent must match; extra catalog keys
// stay refused).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tedConfig, writeTedConfig, loadLiveModelSelector } from '../src/bootstrap.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const NATIVE_DEFAULT = 'opencode-go/deepseek-v4.1-flash';
const USER_OVERRIDE = 'opencode-go/other-model';

describe('native model selection/merge (no inference)', () => {
  it('test stays model-free; live selects the template default (no JS literal)', () => {
    const tmpl = JSON.parse(fs.readFileSync(new URL('../src/live-model.json', import.meta.url), 'utf8'));
    assert.equal(tmpl.model, NATIVE_DEFAULT, 'repo-owned template holds the current default');
    assert.equal(loadLiveModelSelector(), NATIVE_DEFAULT, 'live selector loads from the template, not JS');
    const testCfg = tedConfig('test');
    assert.ok(!('model' in testCfg), 'test: no model selector (isolated)');
    assert.ok(!('providers' in testCfg), 'test: no injected catalog');
    const liveCfg = tedConfig('live');
    assert.equal(liveCfg.model, NATIVE_DEFAULT, 'live: native selector from the template');
    assert.ok(!('providers' in liveCfg), 'live: no injected catalog');
  });

  it('writeTedConfig preserves a legitimate native model override without rewriting', () => {
    const dir = approvedTmpRoot('ted-model-merge');
    const file = writeTedConfig(dir, 'live');
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(base.model, NATIVE_DEFAULT, 'written live base carries the template default');

    // Legitimate user override: our exact config + different native `model` only.
    const overridden = `${JSON.stringify({ ...base, model: USER_OVERRIDE }, null, 2)}\n`;
    fs.writeFileSync(file, overridden, 'utf8');
    const before = fs.readFileSync(file, 'utf8');
    const returned = writeTedConfig(dir, 'live');
    assert.equal(returned, file);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'legitimate model override preserved byte-for-byte (never overwritten)');
    assert.equal(JSON.parse(before).model, USER_OVERRIDE, 'user native override applies without code changes');
  });

  it('writeTedConfig still refuses non-model divergence and malformed selectors', () => {
    const dir = approvedTmpRoot('ted-model-refuse');
    const file = writeTedConfig(dir, 'live');
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));

    // Dropped deny: still refused (user work preserved, boot fails closed).
    const weakened = { ...base, policies: base.policies.slice(1) };
    fs.writeFileSync(file, `${JSON.stringify(weakened, null, 2)}\n`, 'utf8');
    assert.throws(() => writeTedConfig(dir, 'live'), /different content|overwrite|refus/);

    // Extra catalog block beyond `model`: still refused.
    const withProviders = { ...base, model: NATIVE_DEFAULT, providers: { x: {} } };
    fs.writeFileSync(file, `${JSON.stringify(withProviders, null, 2)}\n`, 'utf8');
    assert.throws(() => writeTedConfig(dir, 'live'), /different content|overwrite|refus/);

    // Malformed selectors are not legitimate overrides: refused.
    for (const bad of ['', 'no-slash', 'a/b/c', 42, null]) {
      const badCfg = { ...base, model: bad };
      fs.writeFileSync(file, `${JSON.stringify(badCfg, null, 2)}\n`, 'utf8');
      assert.throws(() => writeTedConfig(dir, 'live'), /different content|overwrite|refus/, `malformed model ${JSON.stringify(bad)} refused`);
    }
  });

  it('writeTedConfig round-trips byte-identical base (idempotent resume)', () => {
    const dir = approvedTmpRoot('ted-model-idem');
    const first = writeTedConfig(dir, 'test');
    const second = writeTedConfig(dir, 'test');
    assert.equal(second, first);
    assert.ok(!('model' in JSON.parse(fs.readFileSync(first, 'utf8'))));
    void path;
  });
});
