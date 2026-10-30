// TED runtime spike harness (Steps 0-1). One identity per OS process.
// Usage: node run-identity.mjs <a|b> <command> [args...]
// TED_HOME_ROOT env must point at experiments/ted-runtime.
// Exposes ONLY the TED allowlist surface. Admin natives (shell/prompt/edit/
// subagent/mcp-connect) are REMOVED here, never called, except the single
// contained shell-bypass-probe that documents 2.2.4 native behavior.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');

const [identity, command, ...args] = process.argv.slice(2);
if (!['a', 'b'].includes(identity)) {
  console.error('identity must be a or b');
  process.exit(2);
}

const { setupIsolation } = require('./env.cjs');
const { writeTedConfig } = require('./ted-config.cjs');
const iso = setupIsolation(identity);
writeTedConfig(iso.dirs.config);
process.chdir(iso.dirs.workspace);

function duKB(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else bytes += fs.statSync(p).size;
      } catch { /* racing tmp files */ }
    }
  };
  try { walk(dir); } catch { /* missing dir */ }
  return Math.round(bytes / 1024);
}

async function boot() {
  const { OpenCode } = await import('@opencode/sdk');
  const t0 = performance.now();
  const oc = await OpenCode.create({
    config: { directory: iso.dirs.config, project: false },
    database: { path: iso.dirs.db },
  });
  const bootMs = Math.round((performance.now() - t0) * 10) / 10;
  return { oc, bootMs };
}

async function main() {
  const started = Date.now();
  const emit = (obj) => {
    console.log(JSON.stringify({ identity, command, ...obj }));
  };
  switch (command) {
    case 'env-dump': {
      emit({
        home: iso.home,
        openCodeTestHome: process.env.OPENCODE_TEST_HOME,
        xdg: {
          config: process.env.XDG_CONFIG_HOME,
          data: process.env.XDG_DATA_HOME,
          cache: process.env.XDG_CACHE_HOME,
          state: process.env.XDG_STATE_HOME,
        },
        cwd: process.cwd(),
        scrubbed: iso.scrubbed,
        userHome: require('os').homedir(),
      });
      return;
    }
    case 'config': {
      const { oc } = await boot();
      try { emit({ entries: await oc.config.get() }); }
      finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'create-session': {
      const { oc, bootMs } = await boot();
      try {
        const s = await oc.session.create({ title: args[0] || 'synthetic' });
        emit({ bootMs, id: s.id, title: s.title, elapsedMs: Date.now() - started });
      } finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'get-session': {
      const { oc } = await boot();
      try {
        const s = await oc.session.get({ sessionID: args[0] });
        emit({ found: true, session: { id: s.id, title: s.title } });
      } catch (e) {
        emit({ found: false, error: String(e && e.message ? e.message : e).slice(0, 200) });
      } finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'list-sessions': {
      const { oc } = await boot();
      try {
        const l = await oc.session.list();
        emit({ count: (l.data || []).length, ids: (l.data || []).map((s) => s.id) });
      } finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'remove-session': {
      const { oc } = await boot();
      try {
        await oc.session.remove({ sessionID: args[0] });
        emit({ removed: true });
      } catch (e) {
        emit({ removed: false, error: String(e && e.message ? e.message : e).slice(0, 200) });
      } finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'inventory': {
      const { oc, bootMs } = await boot();
      try {
        const summarize = async (name, fn) => {
          try {
            const r = await fn();
            const data = r && r.data ? r.data : r;
            const ids = Array.isArray(data) ? data.map((d) => d.id || d.name) : [];
            return { ok: true, count: ids.length, ids: ids.slice(0, 60), bytes: JSON.stringify(r).length };
          } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
          }
        };
        emit({
          bootMs,
          config: await oc.config.get(),
          agents: await summarize('agents', () => oc.agent.list()),
          commands: await summarize('commands', () => oc.command.list()),
          skills: await summarize('skills', () => oc.skill.list()),
          plugins: await summarize('plugins', () => oc.plugin.list()),
          mcp: await summarize('mcp', () => oc.mcp.list()),
          providers: await summarize('providers', () => oc.provider.list()),
          models: await summarize('models', () => oc.model.list()),
          sessions: await summarize('sessions', () => oc.session.list()),
          hasToolCatalogEndpoint: oc.tool === undefined,
        });
      } finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'facade-shape': {
      // The TED surface is this file's command switch. Admin natives that
      // exist on the SDK but are never invoked here:
      const removed = ['shell', 'prompt', 'edit', 'subagent', 'mcp-connect', 'pty-create'];
      const { oc } = await boot();
      try {
        const nativeHas = {
          'shell': typeof oc.session.shell === 'function',
          'prompt': typeof oc.session.prompt === 'function',
        };
        emit({ exposed: [], removed, nativeHas });
      } finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'restart-probe': {
      const { oc, bootMs } = await boot();
      try {
        const rssMB = Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
        emit({ bootMs, rssMB, diskKB: duKB(iso.home), elapsedMs: Date.now() - started });
      } finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'shell-bypass-probe': {
      // ONE contained probe documenting 2.2.4 native behavior: session.shell
      // (direct API) vs the loaded deny policy. Marker lives inside the
      // isolated home and is deleted afterwards. Synthetic only.
      const { oc } = await boot();
      try {
        const cfg = await oc.config.get();
        const policyLoaded = cfg.some(
          (e) => e.type === 'document' && e.info && e.info.policies,
        );
        const s = await oc.session.create({ title: 'bypass-probe' });
        const marker = path.join(iso.dirs.tmp, 'SHELL_BYPASS_MARKER.txt');
        try { fs.unlinkSync(marker); } catch {}
        let result = 'UNKNOWN';
        try {
          await oc.session.shell({ sessionID: s.id, command: `echo MARKER` });
          await new Promise((r) => setTimeout(r, 1200));
          result = 'ALLOWED';
        } catch (e) {
          result = 'DENIED:' + String(e && e.message ? e.message : e).slice(0, 160);
        }
        let sideEffect = false;
        try {
          // shell ran async; check common outcome via shell list if available
          const shells = await oc.shell.list().catch(() => null);
          sideEffect = !!(shells && JSON.stringify(shells).length);
        } catch {}
        await oc.session.remove({ sessionID: s.id }).catch(() => {});
        try { fs.unlinkSync(marker); } catch {}
        emit({ policyLoaded, result, shellListObserved: sideEffect });
      } finally { await oc.close().catch(() => {}); }
      return;
    }
    case 'negative-tests': {
      const { oc } = await boot();
      const tests = [];
      const t = async (name, fn) => {
        try {
          const detail = await fn();
          tests.push({ name, pass: detail.pass, detail: detail.detail });
        } catch (e) {
          tests.push({ name, pass: false, detail: 'THREW ' + String(e && e.message ? e.message : e).slice(0, 160) });
        }
      };
      const failClosed = (v) => ({ pass: v.startsWith('DENIED') || v.startsWith('NOTFOUND') || v.startsWith('ABSENT'), detail: v });
      await t('unknown-session-get-404', async () => {
        try {
          await oc.session.get({ sessionID: 'ses_doesnotexist0000000000' });
          return { pass: false, detail: 'unexpectedly found' };
        } catch (e) { return failClosed('NOTFOUND ' + String(e && e.message ? e.message : e).slice(0, 120)); }
      });
      await t('remove-unknown-session-fails', async () => {
        try {
          await oc.session.remove({ sessionID: 'ses_doesnotexist0000000000' });
          return { pass: false, detail: 'unexpectedly removed' };
        } catch (e) { return failClosed('NOTFOUND ' + String(e && e.message ? e.message : e).slice(0, 120)); }
      });
      await t('mcp-empty-no-servers', async () => {
        const m = await oc.mcp.list();
        const n = (m.data || []).length;
        return { pass: n === 0, detail: `servers=${n}` };
      });
      await t('no-credentials-present', async () => {
        const leaked = ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLOUDFLARE_API_TOKEN', 'DATABASE_URL']
          .filter((k) => process.env[k] !== undefined);
        return { pass: leaked.length === 0, detail: leaked.length ? 'LEAKED:' + leaked.join(',') : 'scrubbed/absent' };
      });
      await t('config-has-no-personal-paths', async () => {
        const cfg = await oc.config.get();
        const bad = JSON.stringify(cfg).includes('Users');
        return { pass: !bad, detail: bad ? 'personal path leaked' : 'isolated only' };
      });
      await t('synthetic-title-roundtrip', async () => {
        const s = await oc.session.create({ title: 'neg-synth' });
        const g = await oc.session.get({ sessionID: s.id });
        await oc.session.remove({ sessionID: s.id });
        return { pass: g.id === s.id, detail: 'created+read+removed ' + s.id.slice(0, 12) };
      });
      try { emit({ tests }); }
      finally { await oc.close().catch(() => {}); }
      return;
    }
    default:
      console.error('unknown command: ' + command);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: String((e && e.stack) || e).slice(0, 800) }));
  process.exit(1);
});
