// TED restricted gateway (spike 02, §3 facade boundary).
//
// ONLY this internal module holds the full OpenCode SDK instance. The exported
// facade object exposes a RESTRICTED allowlist and nothing else:
//   sessions: createSession/getSession/listSessions/removeSession
//   read-only catalogs: listCatalogs (agents/commands/skills/plugins/mcp/
//     providers/models/sessions counts+ids; there is NO tool-catalog endpoint
//     in 2.2.4 — hasToolCatalog:false documents the limit)
//   finance: list_accounts / get_month_summary (same execute functions the
//     native plugin registers; host-bound identity injected by the host)
//
// There is NO dynamic method dispatch (no facade.call(name,...)), NO shell /
// prompt / edit / MCP / file / subagent surface, and no host/token/close
// keys. The facade is Object.frozen; host contexts are deep-frozen copies.
// Secrets never enter history, prompts, or results (transport scrubs).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TOOL_DEFS, createToolExecutors, ToolError } from './ted-finance-tools.mjs';
import { callFinance } from './finance-transport.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireHere = createRequire(path.join(HERE, 'run-identity.mjs'));

const FACADE_KEYS = [
  'createSession',
  'getSession',
  'listSessions',
  'removeSession',
  'listCatalogs',
  'list_accounts',
  'get_month_summary',
];

function freezeHost(host) {
  if (!host || typeof host !== 'object') throw new ToolError('tool.invalid_args', 'host context is required');
  for (const k of ['label', 'token', 'household', 'actorId', 'deviceId']) {
    if (typeof host[k] !== 'string' || host[k].length === 0) {
      throw new ToolError('tool.invalid_args', `host.${k} (string) is required`);
    }
  }
  return Object.freeze({ ...host });
}

function summarize(promise) {
  return promise.then(
    (r) => {
      const data = r && r.data ? r.data : r;
      const ids = Array.isArray(data) ? data.map((d) => d.id || d.name) : [];
      return { count: ids.length, ids: ids.slice(0, 80) };
    },
    (e) => ({ error: String((e && e.message) || e).slice(0, 160) }),
  );
}

export { TOOL_DEFS, FACADE_KEYS };

export async function createTedEnvironment({ identity = 'c' } = {}) {
  const { setupIsolation } = requireHere('./env.cjs');
  const { writeTedConfig } = requireHere('./ted-config.cjs');
  const iso = setupIsolation(identity);
  writeTedConfig(iso.dirs.config);
  process.chdir(iso.dirs.workspace);

  const { OpenCode } = await import('@opencode/sdk');
  const oc = await OpenCode.create({
    config: { directory: iso.dirs.config, project: false },
    database: { path: iso.dirs.db },
  });
  const executors = createToolExecutors(callFinance);

  function facadeFor(host) {
    const bound = freezeHost(host);
    const newIntention = () =>
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const facade = {
      createSession: (title) => oc.session.create({ title: title || 'ted-finance' }),
      getSession: (sessionID) => oc.session.get({ sessionID }),
      listSessions: () => oc.session.list(),
      removeSession: (sessionID) => oc.session.remove({ sessionID }),
      listCatalogs: async () => ({
        agents: await summarize(oc.agent.list()),
        commands: await summarize(oc.command.list()),
        skills: await summarize(oc.skill.list()),
        plugins: await summarize(oc.plugin.list()),
        mcp: await summarize(oc.mcp.list()),
        providers: await summarize(oc.provider.list()),
        models: await summarize(oc.model.list()),
        sessions: await summarize(oc.session.list()),
        // 2.2.4 SDK exposes NO tool-catalog endpoint (oc.tool undefined);
        // finance tools are allowlisted here + registered natively, not enumerated.
        hasToolCatalog: oc.tool !== undefined,
      }),
      list_accounts: (args, opts) =>
        executors.list_accounts(args, bound, { ...(opts || {}), intentionId: newIntention() }),
      get_month_summary: (args, opts) =>
        executors.get_month_summary(args, bound, { ...(opts || {}), intentionId: newIntention() }),
    };
    const keys = Object.keys(facade).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...FACADE_KEYS].sort())) {
      throw new Error(`facade surface drift: ${keys.join(',')}`);
    }
    return Object.freeze(facade);
  }

  return {
    identity,
    facadeFor,
    async close() {
      await oc.close().catch(() => {});
    },
  };
}
