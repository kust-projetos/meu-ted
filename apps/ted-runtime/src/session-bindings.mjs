// Host-bound session bindings — P1 product copy.
//
// In-memory registry Map<sessionID, Binding> linking a native OpenCode
// sessionID to a FROZEN host identity {label, token, household, actorId,
// deviceId}. Reviewed from the runtime spike; behavior preserved, comments
// trimmed. Security: error messages never carry tokens or host field values;
// this module never reads process.env; model-chosen IDs (messageID/callID)
// are never identity — only the host-passed sessionID key resolves.

import { ToolError } from './tool-defs.mjs';

const HOST_FIELDS = ['label', 'token', 'household', 'actorId', 'deviceId'];

const store = new Map();
// Quarantined native sessions: idle could not be proven after a bounded
// wait, so the session may still be running with a stale host. Revoked AND
// blocked for every future bind/resolve/rotate — fail closed; open a new
// conversation (new native session) instead. Process-local like bindings.
const quarantined = new Set();

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

export function isSameHost(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return sameHost(a, b);
}

function isExpired(binding) {
  return typeof binding.expiresAt === 'number' && Date.now() > binding.expiresAt;
}

export function bindSession(sessionID, host, opts = {}) {
  requireSessionID(sessionID);
  if (quarantined.has(sessionID)) {
    throw new ToolError(
      'host_binding_quarantined',
      'session was quarantined after a busy timeout — it may still be running with a stale host; open a new conversation',
    );
  }
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
  if (quarantined.has(sessionID)) {
    throw new ToolError(
      'host_binding_quarantined',
      'session was quarantined after a busy timeout — it may still be running with a stale host; open a new conversation',
    );
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

export function isQuarantined(sessionID) {
  return typeof sessionID === 'string' && quarantined.has(sessionID);
}

// Server-only controlled rotation (called ONLY under the serverOps
// per-session queue after idle has been proven — never revoke/replace while
// a previous prompt/tool could still execute). Fails closed on quarantine.
export function rotateSessionBinding(sessionID, host) {
  requireSessionID(sessionID);
  if (quarantined.has(sessionID)) {
    throw new ToolError(
      'host_binding_quarantined',
      'session was quarantined after a busy timeout — it may still be running with a stale host; open a new conversation',
    );
  }
  const frozen = validateHost(host);
  const prev = store.get(sessionID);
  if (prev) prev.revoked = true;
  const binding = {
    sessionID,
    host: frozen,
    boundAt: Date.now(),
    expiresAt: null,
    revoked: false,
  };
  store.set(sessionID, binding);
  return binding;
}

export function quarantineSession(sessionID) {
  if (typeof sessionID === 'string' && sessionID.length > 0) {
    quarantined.add(sessionID);
    const binding = store.get(sessionID);
    if (binding) binding.revoked = true;
    return true;
  }
  return false;
}

export function clearAll() {
  store.clear();
  quarantined.clear();
}

export function getBinding(sessionID) {
  return store.get(sessionID);
}
