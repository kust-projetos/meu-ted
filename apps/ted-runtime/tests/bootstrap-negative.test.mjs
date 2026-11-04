// P1 RED→GREEN: bootstrap isolation guards + negative proofs
// (no catalog surface, no token in error text, exact product tool set).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

import { setupIsolation, tedConfig, writeTedConfig, loadLiveModelSelector } from '../src/bootstrap.mjs';
import { createFacade, FACADE_KEYS } from './helpers/facade.mjs';
import { productToolDefs, buildExecute } from '../src/plugin.mjs';
import { ToolError } from '../src/tool-defs.mjs';

describe('ted-runtime bootstrap isolation', () => {
  it('writes a BOM-free deny-all config and refuses a second host in-process', () => {
    const root = approvedTmpRoot('ted-iso');
    const first = setupIsolation(root, 'a');
    const cfgFile = writeTedConfig(first.dirs.config);
    assert.ok(fs.existsSync(cfgFile));
    const raw = fs.readFileSync(cfgFile);
    assert.ok(!raw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'config must be BOM-free');
    const cfg = tedConfig();
    assert.ok(cfg.policies.some((p) => p.action === 'provider.use' && p.effect === 'deny'));

    // Same host is idempotent; a second host fails closed (no global reconfig).
    const again = setupIsolation(root, 'a');
    assert.equal(again.home, first.home);
    assert.throws(() => setupIsolation(root, 'b'), /isolation_already_configured/);
  });

  it('writeTedConfig round-trips the deny-all policy', () => {
    const dir = approvedTmpRoot('ted-cfg');
    const file = writeTedConfig(dir);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(parsed.policies.some((p) => p.action === 'provider.use' && p.effect === 'deny'));
    // No redundant agent-level denies: authority is policies.tool.use.
    const perms = (parsed.agents && parsed.agents.ted && parsed.agents.ted.permissions) || [];
    assert.ok(!perms.some((p) => p && (p.action === 'shell' || p.action === 'edit' || p.action === 'subagent')), 'no redundant agent-level shell/edit/subagent denies');
    assert.ok(parsed.policies.some((p) => p.action === 'tool.use' && p.resource === 'shell:*' && p.effect === 'deny'), 'tool.use shell:* hard deny intact');
  });

  it('live scrubs saved-account ambient keys but preserves only OPENCODE_GO_API_KEY (isolated subprocess)', () => {
    // Least-privilege: saved /connect accounts live in the isolated TED
    // SQLite — ambient OPENCODE_API_KEY / OPENROUTER_API_KEY must never
    // reach the SDK, while OPENCODE_GO_API_KEY stays preserved in live.
    // Runs in a dedicated child process: setupIsolation is one-host-per-OS-
    // process, so an in-process live setup would trip the fail-closed
    // isolation guard set by the first test above. Dummies only, values
    // never asserted by content and never printed (key names only).
    const keys = ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY', 'OPENROUTER_API_KEY', 'TED_SCRUB_EXPECT_GO'];
    const saved = {};
    for (const k of keys) saved[k] = process.env[k];
    const tag = `dummy-${Math.random().toString(36).slice(2)}-not-a-secret`;
    const goSentinel = `opencode-go-${tag}`;
    try {
      process.env.OPENCODE_API_KEY = `opencode-${tag}`;
      process.env.OPENCODE_GO_API_KEY = goSentinel;
      process.env.OPENROUTER_API_KEY = `router-${tag}`;
      process.env.TED_SCRUB_EXPECT_GO = goSentinel;
      const childCode = [
        "import { setupIsolation } from './src/bootstrap.mjs';",
        "import { approvedTmpRoot } from './tests/helpers/tmp-root.mjs';",
        "const root = approvedTmpRoot('ted-scrub-live');",
        "const result = setupIsolation(root, 'scrublive', 'live');",
        'const failures = [];',
        'const present = (k) => process.env[k] !== undefined;',
        "if (!present('OPENCODE_GO_API_KEY')) failures.push('OPENCODE_GO_API_KEY missing (must be preserved in live)');",
        "if (process.env.OPENCODE_GO_API_KEY !== process.env.TED_SCRUB_EXPECT_GO) failures.push('OPENCODE_GO_API_KEY altered (must be preserved exactly)');",
        "if (present('OPENCODE_API_KEY')) failures.push('OPENCODE_API_KEY present (must be scrubbed in live)');",
        "if (present('OPENROUTER_API_KEY')) failures.push('OPENROUTER_API_KEY present (must be scrubbed in live)');",
        'const scrubbed = (result && result.scrubbed) || [];',
        "if (!scrubbed.includes('OPENCODE_API_KEY')) failures.push('OPENCODE_API_KEY not reported in scrubbed list');",
        "if (!scrubbed.includes('OPENROUTER_API_KEY')) failures.push('OPENROUTER_API_KEY not reported in scrubbed list');",
        "if (scrubbed.includes('OPENCODE_GO_API_KEY')) failures.push('OPENCODE_GO_API_KEY wrongly reported in scrubbed list');",
        "if (failures.length > 0) { process.stderr.write('live scrub proof failed: ' + failures.join('; ') + '\\n'); process.exit(1); }",
        'process.exit(0);',
      ].join('\n');
      const cwd = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      const res = spawnSync(process.execPath, ['--input-type=module', '--eval', childCode], {
        cwd,
        env: { ...process.env },
        encoding: 'utf8',
      });
      assert.ok(!res.error, `live scrub subprocess must spawn (key names only): ${String((res.error && res.error.message) || res.error).slice(0, 200)}`);
      const out = `${res.stdout || ''}${res.stderr || ''}`;
      assert.ok(!out.includes(tag), 'subprocess output must never contain dummy credential values');
      assert.equal(res.status, 0, `live scrub subprocess must pass (key names only): ${String(res.stderr || '').slice(0, 300)}`);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe('ted-runtime negative proofs (reviewer P1/P2)', () => {
  it('facade exposes no catalog, no bind/rebind, no dynamic dispatch', () => {
    assert.deepEqual([...FACADE_KEYS].sort(), ['createSession', 'getSession', 'listSessions', 'removeSession', 'get_month_summary', 'list_accounts'].sort());
    const facade = createFacade({ oc: { session: {} }, host: { label: 'a', token: 't', household: 'H', actorId: 'a', deviceId: 'd' }, executors: {} });
    for (const k of ['listCatalogs', 'bindSession', 'rebind', 'call', 'shell', 'prompt', 'getBinding', 'bindings']) {
      assert.ok(!(k in facade), `facade must not expose ${k}`);
    }
  });

  it('product registers exactly the two read tools with complete schemas', () => {
    const defs = productToolDefs();
    assert.deepEqual(defs.map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
    for (const d of defs) {
      assert.ok(d.input && d.input.type === 'object', `${d.name} input schema`);
      assert.ok(d.output && d.output.type === 'object', `${d.name} output schema`);
    }
  });

  it('error text never carries the token', async () => {
    const secret = 'tok-super-secret-123';
    const { createToolExecutors } = await import('../src/tool-defs.mjs');
    const boom = async () => ({ statusCode: 403, body: { error: 'x' } });
    const ex = createToolExecutors(boom);
    const host = { label: 'a', token: secret, household: 'H', actorId: 'a', deviceId: 'd' };
    const err = await ex.list_accounts({}, host, { intentionId: 'int-1' }).catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.ok(!String(err.message).includes(secret), 'message must not contain token');
    assert.ok(!JSON.stringify(err.details ?? {}).includes(secret), 'details must not contain token');
  });

  it('plugin execute fails closed without a live binding (hostless blocked)', async () => {
    const { clearAll } = await import('../src/session-bindings.mjs');
    clearAll();
    const run = async () => { throw new Error('must not reach transport'); };
    const exec = buildExecute({ name: 'list_accounts' }, run);
    // PR290: the native permission gate runs before host resolve, so a
    // permission-less hostless call fails closed at the permission gate
    // (still fail-closed, never the executor).
    const err = await exec({}, { sessionID: 'ses_unknown_xyz' }, {}).catch((e) => e);
    assert.match(String(err.message || err), /permission assertion unavailable|host-bound session context is required/);
  });
});
