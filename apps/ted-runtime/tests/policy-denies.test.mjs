// PR290-POLICY-DENY-BY-DEFAULT-06 — TDD RED: native deny-by-default policy audit
// correction (official OpenCode V2, local SDK 2.2.4 declarations).
//
// Corrected understanding (was: "new tools default ask"):
// - Agent.Info default permissions include `{action:'*',resource:'*',effect:'allow'}`
//   (local proof: node_modules/@opencode/schema agent.js `default()`), so a new
//   native action CAN match that base wildcard allow unless the TED agent adds a
//   restrictive rule. Unmatched checks using `ask` does NOT save us.
// - Therefore agents.ted carries an explicit native allowlist: FIRST
//   `{action:'*',resource:'*',effect:'deny'}`, then `allow` ONLY for the new
//   namespaced custom action `ted.finance.read` with EXACT resources for the
//   current product read tools (no finance wildcards, no broad allow).
// - Plugin tools only enforce permission checks they explicitly assert
//   (Plugin 2.2.4 `ctx.permission.assert`); a policy `allow` never grants.
//   The execute path asserts BEFORE host resolve / executor / HTTP, failing
//   closed when the permission API/context is missing. This is the native
//   permission mechanism — not a new auth system.
// - `policies.tool.use` hard denies stay as the host/admin backstop
//   (provider deny-all + live specific opencode-go allow, no fallback).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tedConfig } from '../src/bootstrap.mjs';
import {
  PRODUCT_TOOL_NAMES,
  P3_READ_TOOL_NAMES,
  P3_WRITE_TOOL_NAMES,
  productToolDefs,
  defineTedFinancePlugin,
  buildExecute,
  TED_FINANCE_PERMISSION_ACTION,
  TED_FINANCE_PERMISSION_RESOURCES,
} from '../src/plugin.mjs';
import { bindSession, clearAll } from '../src/session-bindings.mjs';

const EXPECTED_TOOL_USE_DENIES = [
  'shell:*', 'edit:*', 'write:*', 'subagent:*',
  'glob:*', 'grep:*', 'read:*', 'patch:*', 'question:*', 'skill:*',
  'webfetch:*', 'websearch:*', 'models:*',
  'list_mcp_resources:*', 'read_mcp_resource:*',
  'session_move:*', 'session_rename:*',
  'worktree_create:*', 'worktree_list:*', 'worktree_remove:*',
];

// Exact product finance resources the native allowlist may name (no wildcards).
// Includes the local-only P3 proposal intent; tedConfig() default carries the
// read permissions (P3 writes are an explicit local opt-in).
const EXPECTED_FINANCE_RESOURCES = [...PRODUCT_TOOL_NAMES, ...P3_READ_TOOL_NAMES, ...P3_WRITE_TOOL_NAMES].sort();
const DEFAULT_FINANCE_RESOURCES = [...PRODUCT_TOOL_NAMES, ...P3_READ_TOOL_NAMES].sort();

function agentPerms(profile) {
  const cfg = tedConfig(profile);
  return (cfg.agents && cfg.agents.ted && cfg.agents.ted.permissions) || [];
}

describe('PR290 deny-by-default: agents.ted explicit native allowlist', () => {
  it('exports the single namespaced finance action with exact resources (no wildcards)', () => {
    assert.equal(TED_FINANCE_PERMISSION_ACTION, 'ted.finance.read');
    assert.deepEqual([...TED_FINANCE_PERMISSION_RESOURCES].sort(), [...EXPECTED_FINANCE_RESOURCES].sort());
    for (const r of TED_FINANCE_PERMISSION_RESOURCES) {
      assert.ok(!r.includes('*'), `finance resource must be exact, got ${r}`);
    }
  });

  it('ted agent denies everything by default, then allows ONLY the finance reads', () => {
    for (const profile of ['test', 'live']) {
      const perms = agentPerms(profile);
      assert.ok(perms.length >= 4, `${profile}: deny-all + 3 finance allows expected`);
      assert.deepEqual(
        perms[0],
        { action: '*', resource: '*', effect: 'deny' },
        `${profile}: first entry must be the wildcard deny`,
      );
      const allows = perms.slice(1);
      assert.deepEqual(
        allows.map((p) => p.resource).sort(),
        [...DEFAULT_FINANCE_RESOURCES].sort(),
        `${profile}: default allowlist must name exactly the product finance reads`,
      );
      for (const p of allows) {
        assert.equal(p.action, 'ted.finance.read', `${profile}: finance allow must use the namespaced action`);
        assert.equal(p.effect, 'allow', `${profile}: finance entries must allow`);
        assert.ok(!String(p.resource).includes('*'), `${profile}: no wildcard on finance resources`);
      }
      // No broad allow survives: every allow entry is the finance action.
      for (const p of perms) {
        if (p.effect === 'allow') {
          assert.equal(p.action, 'ted.finance.read', `${profile}: no broad allow allowed`);
        }
      }
    }
  });

  it('the local P3 writes opt-in adds exactly the proposal permissions', () => {
    for (const profile of ['test', 'live']) {
      const cfg = tedConfig(profile, { p3Writes: true });
      const perms = (cfg.agents && cfg.agents.ted && cfg.agents.ted.permissions) || [];
      assert.deepEqual(perms[0], { action: '*', resource: '*', effect: 'deny' });
      const allows = perms.slice(1);
      assert.deepEqual(allows.map((p) => p.resource).sort(), [...EXPECTED_FINANCE_RESOURCES].sort());
      for (const p of allows) assert.equal(p.action, 'ted.finance.read');
      for (const resource of ['propose_card_purchase', 'propose_expense', 'propose_income', 'propose_transfer', 'propose_statement_payment']) {
        assert.deepEqual(allows.find((p) => p.resource === resource), {
          action: 'ted.finance.read',
          resource,
          effect: 'allow',
        });
      }
    }
  });

  it('unknown/new SDK action matches the wildcard deny with no allow (deny-by-default)', () => {
    for (const profile of ['test', 'live']) {
      const perms = agentPerms(profile);
      const unknown = { action: 'evil.new_tool', resource: 'evil.new_tool:run' };
      const matchingAllows = perms.filter(
        (p) => p.effect === 'allow' && (p.action === unknown.action || p.action === '*'),
      );
      assert.deepEqual(matchingAllows, [], `${profile}: unknown action must have no allow entry`);
      const wildcardDeny = perms.find((p) => p.action === '*' && p.resource === '*' && p.effect === 'deny');
      assert.ok(wildcardDeny, `${profile}: wildcard deny must cover the unknown action`);
    }
  });

  it('keeps provider deny-all + live specific opencode-go allow + every tool.use hard deny (backstop)', () => {
    for (const profile of ['test', 'live']) {
      const cfg = tedConfig(profile);
      for (const resource of EXPECTED_TOOL_USE_DENIES) {
        assert.ok(
          (cfg.policies || []).some((p) => p && p.action === 'tool.use' && p.resource === resource && p.effect === 'deny'),
          `${profile}: missing tool.use deny for ${resource}`,
        );
      }
      const providerPolicies = (cfg.policies || []).filter((p) => p && p.action === 'provider.use');
      assert.ok(providerPolicies.some((p) => p.resource === '*' && p.effect === 'deny'), `${profile}: provider.use deny-all intact`);
    }
    const live = tedConfig('live');
    assert.deepEqual(
      (live.policies || []).filter((p) => p && p.action === 'provider.use'),
      [
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: 'opencode-go', effect: 'allow' },
      ],
      'live: deny-all + specific opencode-go allow only (no fallback)',
    );
  });
});

describe('PR290 deny-by-default: plugin execute asserts the native permission first', () => {
  it('asserts ted.finance.read/[toolName] with the real invocation context BEFORE transport', async () => {
    clearAll();
    const host = { label: 'a', token: 'tok-p290', household: 'H_A', actorId: 'actor-a', deviceId: 'dev-a' };
    bindSession('ses_P290A', { ...host });
    const seenAssert = [];
    const seenTransport = [];
    const run = async (input, h, opts) => {
      seenTransport.push({ input, token: h.token });
      return { items: [], total: 0 };
    };
    // PR290-07: the assert comes from plugin setup (setup-captured), never
    // from the execution context — the execute ctx below carries NO
    // permission property (Plugin 2.2.4 ToolContext has none).
    const setupAssert = async (input) => {
      seenAssert.push(input);
      assert.equal(input.action, 'ted.finance.read');
      assert.deepEqual(input.resources, ['list_accounts']);
      assert.equal(input.sessionID, 'ses_P290A');
      assert.deepEqual(input.source, { type: 'tool', messageID: 'msg-1', id: 'call-1' });
      assert.equal(input.agent, 'ted');
    };
    const exec = buildExecute({ name: 'list_accounts' }, run, setupAssert);
    const ctx = {
      sessionID: 'ses_P290A',
      messageID: 'msg-1',
      id: 'call-1',
      agent: 'ted',
      signal: new AbortController().signal,
    };
    const out = await exec({}, ctx);
    assert.deepEqual(out.output, { items: [], total: 0 });
    assert.equal(seenAssert.length, 1, 'exactly one native permission assertion');
    assert.equal(seenTransport.length, 1, 'transport runs only after the allow');
  });

  it('fails closed when the permission API is missing (no silent allow)', async () => {
    clearAll();
    const host = { label: 'a', token: 'tok-p290', household: 'H_A', actorId: 'actor-a', deviceId: 'dev-a' };
    bindSession('ses_P290B', { ...host });
    let reached = false;
    const exec = buildExecute({ name: 'list_accounts' }, async () => { reached = true; return {}; });
    const err = await exec({}, { sessionID: 'ses_P290B', messageID: 'm1', id: 'c1' }).catch((e) => e);
    assert.match(String(err.message || err), /permission.*(unavailable|missing|required)|failing closed/i);
    assert.equal(reached, false, 'executor must not run without the native assertion');
  });

  it('fails closed when the native assertion denies (transport never runs)', async () => {
    clearAll();
    const host = { label: 'a', token: 'tok-p290', household: 'H_A', actorId: 'actor-a', deviceId: 'dev-a' };
    bindSession('ses_P290C', { ...host });
    let reached = false;
    // PR290-07: denial arrives via the setup-captured assert; the execute
    // ctx carries no permission. The surfaced error is generic (no raw
    // denial detail leaks) and the executor/HTTP path never runs.
    const denyAssert = async () => {
      const e = new Error('deny: ted.finance.read not allowed here');
      e.name = 'Tool.Error';
      throw e;
    };
    const exec = buildExecute({ name: 'get_month_summary' }, async () => { reached = true; return {}; }, denyAssert);
    const ctx = {
      sessionID: 'ses_P290C',
      messageID: 'm2',
      id: 'c2',
      agent: 'ted',
    };
    const err = await exec({ yearMonth: '2026-10' }, ctx).catch((e) => e);
    assert.match(String(err.message || err), /permission denied|not allowed|forbidden/i);
    assert.equal(reached, false, 'deny must block the executor/HTTP path');
  });
});

describe('PR290-07: permission assert is captured at plugin setup (execute ToolContext has no permission)', () => {
  it('setup-captured assert runs with session/source/action/resource BEFORE transport; execute ctx carries NO permission', async () => {
    clearAll();
    const host = { label: 'a', token: 'tok-p290-setup', household: 'H_A', actorId: 'actor-a', deviceId: 'dev-a' };
    bindSession('ses_P290S', { ...host });
    const seenAssert = [];
    const seenTransport = [];
    const transport = async (args) => {
      seenTransport.push(args);
      return { statusCode: 200, body: { items: [], total: 0 } };
    };
    const pluginDef = defineTedFinancePlugin(() => transport);
    const added = [];
    await pluginDef.setup({
      permission: { assert: async (input) => { seenAssert.push({ ...input }); } },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn) => { fn({ add: (t) => added.push(t) }); } },
    });
    const tool = added.find((t) => t.name === 'list_accounts');
    assert.ok(tool, 'list_accounts registered');
    // Normal execution context (Plugin 2.2.4 ToolContext): session/message/
    // call identity + agent + signal — NO permission property.
    const execCtx = {
      sessionID: 'ses_P290S',
      messageID: 'msg-s1',
      id: 'call-s1',
      agent: 'ted',
      signal: new AbortController().signal,
    };
    assert.ok(!('permission' in execCtx), 'execute ctx must not carry permission (setup-captured only)');
    const out = await tool.execute({}, execCtx);
    assert.deepEqual(out.output, { items: [], total: 0 });
    assert.equal(seenAssert.length, 1, 'exactly one setup-captured assertion');
    assert.deepEqual(seenAssert[0], {
      sessionID: 'ses_P290S',
      agent: 'ted',
      action: 'ted.finance.read',
      resources: ['list_accounts'],
      source: { type: 'tool', messageID: 'msg-s1', id: 'call-s1' },
    });
    assert.equal(seenTransport.length, 1, 'transport runs only after the allow');
    assert.equal(seenTransport[0].host.token, 'tok-p290-setup');
  });

  it('setup fails closed when ctx.permission.assert is absent (no tools registered)', async () => {
    const added = [];
    const pluginDef = defineTedFinancePlugin(() => async () => ({ statusCode: 200, body: {} }));
    await assert.rejects(
      () => pluginDef.setup({ tool: { transform: async (fn) => { fn({ add: (t) => added.push(t) }); } } }),
      /permission.*(unavailable|missing|required)|failing closed/i,
    );
    assert.deepEqual(added, [], 'no tool registered when setup cannot capture the native assertion');
  });

  it('native denial blocks executor/HTTP and leaks no raw detail (no token, no denial internals)', async () => {
    clearAll();
    const secret = 'tok-p290-deny-secret';
    const host = { label: 'a', token: secret, household: 'H_A', actorId: 'actor-a', deviceId: 'dev-a' };
    bindSession('ses_P290N', { ...host });
    let reached = false;
    const denyAssert = async () => {
      const e = new Error('deny: ted.finance.read not allowed here [backend-reason-xyz]');
      e.name = 'Tool.Error';
      throw e;
    };
    const exec = buildExecute({ name: 'get_month_summary' }, async () => { reached = true; return {}; }, denyAssert);
    const err = await exec({ yearMonth: '2026-10' }, { sessionID: 'ses_P290N', messageID: 'm9', id: 'c9', agent: 'ted' }).catch((e) => e);
    assert.match(String(err.message || err), /permission denied|not allowed|forbidden/i);
    assert.equal(reached, false, 'deny must block the executor/HTTP path');
    assert.ok(!String(err.message || err).includes(secret), 'denial text must not leak the host token');
    assert.ok(!String(err.message || err).includes('backend-reason-xyz'), 'no raw denial detail leaks');
  });
});

describe('PR290 deny-by-default: real SDK 2.2.4 no-inference/no-prompt policy proof', () => {
  it('pins SDK+plugin 2.2.4, writes the deny-by-default config, keeps registration (zero prompts, zero fetch)', async () => {
    // Guard: this proof never performs inference or network I/O. Any
    // session.prompt or fetch call fails the test immediately.
    let promptCalls = 0;
    let fetchCalls = 0;
    const guardFetch = async () => { fetchCalls++; throw new Error('fetch must not run in the policy proof'); };

    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(pkg.dependencies['@opencode/sdk'], '2.2.4', 'SDK pinned exactly 2.2.4');
    assert.equal(pkg.dependencies['@opencode/plugin'], '2.2.4', 'plugin pinned exactly 2.2.4');

    // Config on disk (what the real boot writes) carries the allowlist.
    const { writeTedConfig } = await import('../src/bootstrap.mjs');
    const { approvedTmpRoot } = await import('./helpers/tmp-root.mjs');
    for (const profile of ['test', 'live']) {
      const dir = approvedTmpRoot(`ted-p290-${profile}-${Date.now().toString(36)}`);
      const file = writeTedConfig(dir, profile);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const perms = (parsed.agents && parsed.agents.ted && parsed.agents.ted.permissions) || [];
      assert.deepEqual(perms[0], { action: '*', resource: '*', effect: 'deny' }, `${profile}: on-disk wildcard deny first`);
      assert.deepEqual(
        perms.slice(1).map((p) => p.resource).sort(),
        [...DEFAULT_FINANCE_RESOURCES].sort(),
        `${profile}: on-disk default finance allowlist exact`,
      );
    }

    // Product plugin registration still works with a local oc double —
    // no session.prompt, no fetch, no provider involved.
    const defs = productToolDefs();
    assert.deepEqual(defs.map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
    const registered = [];
    const oc = {
      plugin: async (def) => { registered.push(def); return { id: def.id }; },
      session: {
        prompt: async () => { promptCalls++; throw new Error('session.prompt must not run in the policy proof'); },
      },
    };
    const { wirePlugin } = await import('../src/bootstrap.mjs');
    const pluginDef = defineTedFinancePlugin(() => guardFetch);
    await wirePlugin(oc, pluginDef);
    assert.deepEqual(registered.map((d) => d.id), ['ted-finance']);
    const added = [];
    // PR290-07: permission.assert is captured at setup (Plugin 2.2.4 setup
    // Context); the allow double below stands in for the native setup API.
    await registered[0].setup({
      permission: { assert: async () => {} },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn) => { fn({ add: (t) => added.push(t) }); } },
    });
    assert.deepEqual(added.map((t) => t.name).sort(), ['get_month_summary', 'list_accounts']);
    // Every registered product tool goes through the setup-captured
    // permission assertion: with an unbound session the execute wrapper
    // fails closed at host resolve (never the executor).
    for (const t of added) {
      const err = await t.execute({}, { sessionID: 'ses_unused', messageID: 'm', id: 'c' }).catch((e) => e);
      assert.match(String(err.message || err), /permission|host-bound/i, `${t.name}: fail-closed without host binding`);
    }
    assert.equal(promptCalls, 0, 'zero session.prompt calls (no inference, no model)');
    assert.equal(fetchCalls, 0, 'zero fetch calls (local policy proof only)');

    // Precise scope note (not an engine claim): the effective in-engine
    // evaluation of these rules (ctx.permission.assert inside a live prompt
    // loop) is NOT proven here — plugin setup only runs on a prompt in
    // pinned 2.2.4 (see tests/real-sdk.test.mjs catalog BLOCKED proof), and
    // triggering it would be an unauthorized inference attempt. What IS
    // proven: the on-disk/requested config the engine loads is deny-by-default
    // with the exact finance allowlist, and our execute path cannot bypass
    // the native assertion (fails closed without it).
  });
});
