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
import { bindSession, resolveHost, revokeSession, clearAll, getBinding, bindWithTTL, isSameHost } from './session-bindings.mjs';

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

// Spike 03A-T1 ownership filter (pure, exported for tests). Returns ONLY
// rows whose binding resolves to the calling facade's host. UNBOUND rows are
// EXCLUDED by default — never leak another host's ids/titles/directories.
// Shape-preserving for known shapes (array stays array, {data,cursor} keeps
// its envelope). P2: an UNRECOGNIZED shape (neither an array nor
// {data:[...]}) fail-closes to an empty envelope {data:[],cursor:null} —
// never the unfiltered integral (fail-open would leak every row).
export function filterSessionsForHost(result, bound) {
  const rows = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : null);
  if (!rows) return { data: [], cursor: null };
  const visible = rows.filter((row) => {
    if (!row || typeof row.id !== 'string') return false;
    let host;
    try {
      host = resolveHost(row.id);
    } catch {
      return false; // unbound/revoked/expired: hidden, never leaked
    }
    return isSameHost(host, bound);
  });
  if (Array.isArray(result)) return visible;
  return { ...result, data: visible };
}

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
      // Spike 03A: creating a session AUTO-BINDS it to this facade's frozen
      // host (session-bindings.bindSession); removing a session REVOKES its
      // binding. The facade itself keeps the exact 7-key allowlist below.
      createSession: async (title) => {
        const s = await oc.session.create({ title: title || 'ted-finance' });
        bindSession(s.id, bound);
        return s;
      },
      getSession: async (sessionID) => {
        // Spike 03A-T1: a session bound to a DIFFERENT host is blocked BEFORE
        // any row is returned (host_binding_mismatch, nothing returned,
        // nothing revoked). Unbound IDs — or IDs bound to THIS same host
        // (even revoked/expired) — fall through to the SDK: unknown IDs fail
        // with the SDK NOTFOUND, and the owner can re-get a row after a
        // restart BEFORE re-binding (test (i) pins this passthrough).
        const existing = getBinding(sessionID);
        if (existing && !isSameHost(existing.host, bound)) {
          throw new ToolError('host_binding_mismatch', 'session is bound to a different host — get blocked (nothing returned)');
        }
        return oc.session.get({ sessionID });
      },
      listSessions: async () => {
        // Spike 03A-T1: list ONLY rows whose binding resolves to THIS facade
        // host (filterSessionsForHost above: unbound/revoked/expired hidden,
        // unknown shape fail-closed to an empty envelope).
        const result = await oc.session.list();
        return filterSessionsForHost(result, bound);
      },
      removeSession: async (sessionID) => {
        // Revoke ONLY after a successful remove: revoking in a `finally`
        // would let facade A revoke another identity's binding even when the
        // remove itself failed (NOTFOUND or transport error), enabling a
        // cross-identity DoS on the process-global registry (fix-r1). On
        // failure the binding stays intact for an explicit retry/revoke.
        // Fix-r3: a session bound to a DIFFERENT host is blocked BEFORE any
        // remove call (throw host_binding_mismatch, nothing removed, nothing
        // revoked) — otherwise facade A could delete B's sqlite row AND
        // revoke B's binding via the shared DB/registry in env 'c'. Unbound
        // IDs, or IDs bound to THIS same host (even revoked/expired), proceed
        // to the remove + post-success revoke path above.
        const existing = getBinding(sessionID);
        if (existing && !isSameHost(existing.host, bound)) {
          throw new ToolError('host_binding_mismatch', 'session is bound to a different host — remove blocked (nothing removed, nothing revoked)');
        }
        const removed = await oc.session.remove({ sessionID });
        try { revokeSession(sessionID); } catch { /* revoke is best-effort */ }
        return removed;
      },
      listCatalogs: async () => ({
        agents: await summarize(oc.agent.list()),
        commands: await summarize(oc.command.list()),
        skills: await summarize(oc.skill.list()),
        plugins: await summarize(oc.plugin.list()),
        mcp: await summarize(oc.mcp.list()),
        providers: await summarize(oc.provider.list()),
        models: await summarize(oc.model.list()),
        // Spike 03A-T1: the sessions summary uses the same ownership
        // visibility as listSessions (count+ids only, but another host's ids
        // are still metadata — same helper, no new code).
        sessions: await summarize((async () => filterSessionsForHost(await oc.session.list(), bound))()),
        // 2.2.4 SDK exposes NO tool-catalog endpoint (oc.tool undefined);
        // finance tools are allowlisted here + registered natively, not enumerated.
        hasToolCatalog: oc.tool !== undefined,
      }),
      // Direct facade calls are single-shot intentions: each call mints a fresh
      // random intentionId (no session+message context to derive from, no
      // CallID on this path — correlation n/a). The native plugin path uses
      // deriveIntentionId (stable across retries); both satisfy the executor's
      // stable-intention guard, and neither accepts identity from args.
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
    // Spike 03A: the session-binding registry, exposed on the ENV (never on
    // the facade — the facade keeps its exact 7-key surface) so tests and the
    // host can bind/resolve/revoke/clear explicitly.
    bindings: { bindSession, resolveHost, revokeSession, clearAll, getBinding, bindWithTTL },
    async close() {
      await oc.close().catch(() => {});
    },
  };
}
