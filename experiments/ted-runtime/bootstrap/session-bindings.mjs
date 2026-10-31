// Host-bound session bindings (spike 03A).
//
// In-memory registry Map<sessionID, Binding> linking an OpenCode native
// sessionID (from Tool.Context: sessionID/agent/messageID/id + signal —
// 2.2.4 Tool.Context = {sessionID, agent, messageID, id:CallID, progress}
// per bootstrap/node_modules/@opencode/schema/dist/tool.d.ts:10-16 and
// bootstrap/node_modules/@opencode/plugin/dist/promise/tool.d.ts:9-15) to a
// FROZEN host identity {label, token, household, actorId, deviceId}.
//
// Rules:
//   - bindSession(sessionID, host) freezes + validates the host (all 5 fields
//     non-empty strings, else tool.invalid_args). Re-binding the SAME host
//     (all fields equal) is idempotent. Re-binding a DIFFERENT host throws
//     host_binding_mismatch WITHOUT overwriting — an explicit revokeSession
//     is required first. A revoked or expired previous binding may be
//     replaced by a fresh bind.
//   - resolveHost(sessionID) returns the frozen host or throws a typed code:
//     host_context_required (absent/unknown), host_binding_revoked,
//     host_binding_expired (Date.now() > expiresAt).
//   - revokeSession(sessionID) marks revoked (tolerant: unknown IDs no-op).
//   - clearAll() drops the whole map (tests + restart simulation: sqlite
//     session rows persist, but THIS memory does not).
//   - getBinding(sessionID) exposes the record for tests only.
//   - bindWithTTL(sessionID, host, ttlMs) sets expiresAt for timeout tests.
//
// Security: error messages NEVER carry tokens or host field values (generic
// codes only); this module NEVER reads process.env; model-chosen IDs
// (messageID/callID) are NEVER treated as identity — only the host-passed
// sessionID key resolves, and only to a host the HOST bound.

import { ToolError } from './ted-finance-tools.mjs';

const HOST_FIELDS = ['label', 'token', 'household', 'actorId', 'deviceId'];

const store = new Map();

function requireSessionID(sessionID) {
  if (typeof sessionID !== 'string' || sessionID.length === 0) {
    throw new ToolError('tool.invalid_args', 'sessionID (string, non-empty) is required');
  }
  return sessionID;
}

function validateHost(host) {
  if (!host || typeof host !== 'object') {
    throw new ToolError('tool.invalid_args', 'host context is required');
  }
  for (const key of HOST_FIELDS) {
    if (typeof host[key] !== 'string' || host[key].length === 0) {
      throw new ToolError('tool.invalid_args', `host.${key} (string, non-empty) is required`);
    }
  }
  return Object.freeze({ ...host });
}

function sameHost(a, b) {
  return HOST_FIELDS.every((key) => a[key] === b[key]);
}

// Spike 03A fix-r3: host-equality predicate for the gateway's removeSession
// ownership check (compares the 5 frozen host fields; never touches values
// beyond equality — no token/logic leaves this module).
export function isSameHost(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return sameHost(a, b);
}

function isExpired(binding) {
  return typeof binding.expiresAt === 'number' && Date.now() > binding.expiresAt;
}

export function bindSession(sessionID, host, opts = {}) {
  requireSessionID(sessionID);
  const frozen = validateHost(host);
  const ttlMs = opts && opts.ttlMs;
  const expiresAt = typeof ttlMs === 'number' ? Date.now() + ttlMs : null;
  const prev = store.get(sessionID);
  if (prev && !prev.revoked && !isExpired(prev)) {
    if (sameHost(prev.host, frozen)) return prev; // idempotent re-bind
    throw new ToolError(
      'host_binding_mismatch',
      'session is already bound to a different host — explicit revoke is required before re-binding',
    );
  }
  const binding = {
    sessionID,
    host: frozen,
    boundAt: Date.now(),
    expiresAt,
    revoked: false,
  };
  store.set(sessionID, binding);
  return binding;
}

export function bindWithTTL(sessionID, host, ttlMs) {
  return bindSession(sessionID, host, { ttlMs });
}

export function resolveHost(sessionID) {
  if (typeof sessionID !== 'string' || sessionID.length === 0) {
    throw new ToolError('host_context_required', 'host-bound session context is required — hostless execution is blocked by design');
  }
  const binding = store.get(sessionID);
  if (!binding) {
    throw new ToolError('host_context_required', 'host-bound session context is required — unknown session (bind it first)');
  }
  if (binding.revoked) {
    throw new ToolError('host_binding_revoked', 'session binding was revoked — explicit re-bind is required');
  }
  if (isExpired(binding)) {
    throw new ToolError('host_binding_expired', 'session binding has expired — explicit re-bind is required');
  }
  return binding.host;
}

export function revokeSession(sessionID) {
  const binding = store.get(sessionID);
  if (binding) binding.revoked = true;
  return Boolean(binding);
}

export function clearAll() {
  store.clear();
}

export function getBinding(sessionID) {
  return store.get(sessionID);
}
