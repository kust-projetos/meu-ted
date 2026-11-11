// TED restricted facade — TEST-ONLY helper (never product).
//
// The product tool path is the native plugin (src/plugin.mjs); this helper
// is a test-only convenience for identity/close guarantees. Import from here
// in tests, never from the runtime bootstrap surface.
//
// The exported facade exposes a RESTRICTED allowlist and nothing else:
//   sessions: createSession/getSession/listSessions/removeSession
//     (owner-filtered; fail-closed without a live binding)
//   finance reads: list_accounts / get_month_summary (host-bound identity
//     injected by the host; same execute fns the native plugin registers)
//
// There is NO dynamic method dispatch (no facade.call(name,...)), NO shell /
// prompt / edit / MCP / file / subagent surface, NO catalog surface (the
// spike's listCatalogs exposed GLOBAL ids — agents/commands/skills/plugins/
// mcp/providers/models — to any caller; NOT ported, P2), NO bind/rebind
// surface, and no host/token/close/registry keys. The facade is
// Object.frozen; host contexts are deep-frozen copies. Secrets never enter
// history, prompts, results, error text, or disk (see token note below).
//
// FAIL-CLOSED OWNERSHIP POSTURE (P1 limits, see README):
// - Bindings are a process-local Map (session-bindings.mjs): they prove
//   nothing durable across restarts, prove no re-authentication, and prove no
//   ADR-027 collective/private visibility. The parity matrix keeps those rows
//   NOT_PROVEN. sqlite session rows may persist, but the binding memory does
//   not — after a restart every session requires an explicit host-side
//   re-bind by the server authority before any row is visible.
// - The facade accepts NO identity fields from any caller input: the host
//   object comes from the server-side holder (bootstrap/gateway), never from
//   browser-supplied fields. sessionID alone never resolves — resolveHost
//   requires a prior host-side bind, otherwise host_context_required. There
//   is deliberately NO facade.bindSession / facade.rebind: re-binding (after
//   revoke/TTL) is a host-harness-only operation on the env's bindings
//   object, never a browser-reachable path. Token rotation presents as a
//   different host (mismatch, fail-closed); only the server authority may
//   revoke + re-bind after re-authentication.
// - Ownership visibility here is owner-only (rows whose binding resolves to
//   THIS facade host; unbound/revoked/expired rows hidden; unknown shapes
//   fail-closed to an empty envelope). ADR-027 collective visibility is NOT
//   implemented in this slice.
// - TOKEN NOTE (reviewer P2): the token lives ONLY in the process-local
//   binding Map (memory, never sqlite/disk/logs/error text). The registry
//   accessor getBinding returns the frozen host INCLUDING the token, so it
//   is test-only inside session-bindings.mjs and is NEVER exposed on the
//   facade or on the env's bindings object. No error message carries host
//   field values (generic codes only).

import { bindSession, resolveHost, revokeSession, isSameHost } from '../../src/session-bindings.mjs';
import { TOOL_DEFS } from '../../src/tool-defs.mjs';

export const FACADE_KEYS = [
  'createSession',
  'getSession',
  'listSessions',
  'removeSession',
  'list_accounts',
  'get_month_summary',
];

export { TOOL_DEFS };

function freezeHost(host) {
  if (!host || typeof host !== 'object') throw new Error('host context is required');
  for (const k of ['label', 'token', 'household', 'actorId', 'deviceId']) {
    if (typeof host[k] !== 'string' || host[k].length === 0) {
      throw new Error(`host.${k} (string) is required`);
    }
  }
  return Object.freeze({ ...host });
}

// Ownership filter (pure, exported for tests). Returns ONLY rows whose
// binding resolves to the calling facade's host. UNBOUND rows are EXCLUDED
// by default — never leak another host's ids/titles/directories.
// Shape-preserving for known shapes (array stays array, {data,cursor} keeps
// its envelope). An UNRECOGNIZED shape fail-closes to an empty envelope
// {data:[],cursor:null} — never the unfiltered integral.
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

// oc: OpenCode SDK instance (or test double with session.*).
// host: SERVER-RESOLVED host identity (never browser-supplied fields).
// executors: { list_accounts, get_month_summary } bound to a transport.
export function createFacade({ oc, host, executors }) {
  const bound = freezeHost(host);
  const newIntention = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const facade = {
    // Creating a session AUTO-BINDS it to this facade's frozen host.
    // Removing a session REVOKES its binding (only after a successful
    // remove — revoking in a `finally` would let facade A revoke another
    // identity's binding even when the remove itself failed).
    createSession: async (title) => {
      const s = await oc.session.create({ title: title || 'ted-finance' });
      bindSession(s.id, bound);
      return s;
    },
    getSession: async (sessionID) => {
      // FAIL-CLOSED (P1 correction — the spike's fall-through is NOT
      // ported): a session WITHOUT a live binding to THIS host never
      // reaches the SDK — unknown/unbound IDs throw host_context_required,
      // revoked/expired IDs throw host_binding_revoked/expired, and IDs
      // bound to a DIFFERENT host throw host_binding_mismatch. This holds
      // after a process restart too (bindings are process-local, so every
      // row requires an explicit host-side re-bind + re-authentication
      // before any metadata is returned). sessionID alone proves nothing.
      const { ToolError } = await import('../../src/tool-defs.mjs');
      const current = resolveHost(sessionID);
      if (!isSameHost(current, bound)) {
        throw new ToolError('host_binding_mismatch', 'session is bound to a different host — get blocked (nothing returned)');
      }
      return oc.session.get({ sessionID });
    },
    listSessions: async () => {
      const result = await oc.session.list();
      return filterSessionsForHost(result, bound);
    },
    removeSession: async (sessionID) => {
      // FAIL-CLOSED like getSession above: unbound/revoked/expired rows
      // never reach the SDK, so a caller holding only a sessionID cannot
      // delete another identity's sqlite row (the spike's unbound
      // fall-through is NOT ported). Revocation happens only after a
      // successful remove, so a failed remove never destroys the binding.
      const { ToolError } = await import('../../src/tool-defs.mjs');
      const current = resolveHost(sessionID);
      if (!isSameHost(current, bound)) {
        throw new ToolError('host_binding_mismatch', 'session is bound to a different host — remove blocked (nothing removed, nothing revoked)');
      }
      const removed = await oc.session.remove({ sessionID });
      try { revokeSession(sessionID); } catch { /* revoke is best-effort */ }
      return removed;
    },
    // Direct facade calls are single-shot intentions: each call mints a fresh
    // random intentionId (no session+message context on this path). The
    // native plugin path derives a stable intention per session+message;
    // both satisfy the executor's stable-intention guard, and neither
    // accepts identity from args.
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
