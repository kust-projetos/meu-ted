// Spike 01 gate tests (Steps 0-1). Deterministic, no LLM, no network beyond
// localhost/registry (already installed). Spawns isolated harness processes.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TED = path.join(HERE, '..');
const BOOT = path.join(TED, 'bootstrap');
const RUN = path.join(BOOT, 'run-identity.mjs');
const HOME_A = path.join(TED, '.ted-home-a');
const HOME_B = path.join(TED, '.ted-home-b');

function run(identity, cmd, args = []) {
  const out = execFileSync(process.execPath, [RUN, identity, cmd, ...args], {
    cwd: BOOT,
    env: { ...process.env, TED_HOME_ROOT: TED },
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(String(out));
}

describe('spike-01 steps 0-1', () => {
  it('G0-01 versions pinned in manifest, no latest', () => {
    const m = JSON.parse(fs.readFileSync(path.join(TED, 'manifest.json'), 'utf8'));
    for (const [k, v] of Object.entries(m.versions)) {
      assert.match(v.version, /^\d+\.\d+\.\d+$/, `${k} pinned`);
      assert.ok(v.tarball && v.integrity && v.shasum, `${k} has tarball+integrity+shasum`);
    }
    assert.ok(!JSON.stringify(m).includes('latest'), 'no latest');
  });

  it('G1-01/G1-02 boot isolated: env dump shows isolated paths, no personal config', () => {
    const a = run('a', 'env-dump');
    assert.ok(a.home.startsWith(TED), 'home under experiments');
    assert.ok(!a.home.includes('Users'), 'not user home');
    assert.ok(a.scrubbed.length > 0, 'secrets scrubbed');
    const cfg = run('a', 'config').entries;
    const paths = cfg.map((e) => e.path || '');
    assert.ok(paths.every((p) => !p.includes('Users\\walis\\.config') && !p.includes('Users/walis/.config')), 'no personal config loaded: ' + paths.join(','));
  });

  it('G0-04 permissions effective: deny policy loaded; direct shell bypass documented', () => {
    const cfg = run('a', 'config').entries;
    const doc = cfg.find((e) => e.type === 'document' && e.info && (e.info.policies || e.info.permissions));
    assert.ok(doc, 'ted policy document loaded');
    const bypass = run('a', 'shell-bypass-probe');
    assert.equal(bypass.policyLoaded, true);
    assert.ok(['ALLOWED', 'DENIED'].includes(bypass.result), 'probe recorded');
  });

  it('G1-03 sessions per identity with isolated state', () => {
    const sa = run('a', 'create-session', ['synthetic-alpha']);
    const sb = run('b', 'create-session', ['synthetic-beta']);
    assert.ok(sa.id && sb.id && sa.id !== sb.id, 'distinct sessions');
    assert.equal(run('b', 'get-session', [sa.id]).found, false, 'B cannot see A session');
    assert.equal(run('a', 'get-session', [sa.id]).found, true, 'A sees own session');
    run('a', 'remove-session', [sa.id]);
    run('b', 'remove-session', [sb.id]);
  });

  it('G1-04 persistence after restart', () => {
    const created = run('a', 'create-session', ['persist-check']);
    const reopened = run('a', 'get-session', [created.id]);
    assert.equal(reopened.found, true, 'session survives process restart');
    assert.equal(reopened.session.id, created.id);
    run('a', 'remove-session', [created.id]);
    assert.equal(run('a', 'get-session', [created.id]).found, false, 'removed stays removed');
  });

  it('G1-06/G1-07 admin surface removed; restart reproducible with timing', () => {
    const f = run('a', 'facade-shape');
    for (const k of ['shell', 'prompt', 'edit', 'subagent', 'mcp-connect']) {
      assert.equal(f.exposed.includes(k), false, `${k} not exposed`);
    }
    const r = run('a', 'restart-probe');
    assert.ok(typeof r.bootMs === 'number' && r.bootMs >= 0, 'boot timed');
    assert.ok(r.rssMB > 0 && r.diskKB >= 0, 'rss/disk measured');
  });

  it('G1-08 negative tests all fail-closed', () => {
    const n = run('a', 'negative-tests');
    for (const t of n.tests) assert.equal(t.pass, true, `${t.name}: ${t.detail}`);
  });
});
