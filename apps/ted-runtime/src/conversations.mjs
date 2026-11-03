// TED conversation registry — P1 product (server-side only).
//
// What this IS: a persisted registry of conversation METADATA linking one
// opaque conversationId to its canonical workspace, owner actor, device,
// visibility, native runtimeSessionId, and runtime owner. It is NOT a
// second conversational store, NOT a SQLite manager, NOT a transcript, and
// NOT a memory: no message content, prompts, tokens, or credentials are
// ever recorded here. Native OpenCode sessions remain the only
// conversational storage (sqlite via the SDK database.path); this file
// only remembers which native session belongs to which conversation and
// under which visibility it may be shown.
//
// Cookie contract (browser pin, aligned with the same-origin proxy):
//   - Name: `ted-runtime-conversation`.
//   - Scope: Path `/api/agent/agents/finance-chat-agent/<encoded-workspace>/rpc`
//     (one pin per workspace path — clearing one workspace never logs out
//     another), HttpOnly, SameSite=Lax, Max-Age 30d (2592000), `Secure`
//     only when the trusted forwarded origin is HTTPS.
//   - Values: exact sentinel `agent` for A0, or `opencode.<opaque-uuid>`
//     for B. The cookie NEVER carries the native runtimeSessionId — the
//     mapping opaque-id -> runtimeSessionId lives ONLY in this server-side
//     registry and is consulted after identity revalidation.
//   - The PWA proxy selects: A0 by default when the flag is OFF, preserves
//     the `agent` pin when the flag turns ON, routes an `opencode.*` pin to
//     B even when the flag later turns OFF, and routes an explicit
//     `/rpc/session/new` to B when the flag is ON (A0 when OFF). The gateway
//     below serves ONLY B: an `agent` pin or a foreign/invalid B value fails
//     closed here (typed error, no silent fallback to A0 — routing back is
//     the proxy's decision, and only the correctly scoped cookie is cleared).
//
// Access rule (checked on EVERY B request AFTER identity revalidation):
//   - `private` conversations: only the owner actor, inside the same
//     canonical workspace.
//   - `workspace` conversations (default, ADR-027): any authenticated
//     member of the same canonical workspace (identity.workspace must
//     equal record.workspace — cross-workspace reads fail closed).
//   - No cookie + B selected may create/attach a workspace-visible session
//     and set the B cookie. On B `/rpc/session/new` a new B session is
//     created and the B cookie is set; the renewal DTO carries the opaque
//     conversationId in `sessionId`.
//
// Concurrency: same-conversation turns are serialized through a
// per-conversation promise chain (`withTurnLock`) so the process-local
// tool host binding cannot race across identities.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CONVERSATION_COOKIE = 'ted-runtime-conversation';
export const CONVERSATION_COOKIE_MAX_AGE = 2592000; // 30d
export const CONVERSATION_VISIBILITIES = ['workspace', 'private'];

const OPAQUE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ConversationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ConversationError';
    this.code = code;
    this.details = details;
  }
}

export function validateVisibility(visibility) {
  if (!CONVERSATION_VISIBILITIES.includes(visibility)) {
    throw new ConversationError('conversation.invalid_visibility', `visibility must be one of ${CONVERSATION_VISIBILITIES.join(',')}`);
  }
  return visibility;
}

// Parses the conversation cookie from a raw Cookie header. Returns:
//   { pin: 'a0' }                        — exact sentinel `agent`
//   { pin: 'b', conversationId }          — `opencode.<opaque-uuid>`
//   { pin: 'none' }                      — header/cookie absent
//   { pin: 'invalid', raw: true }         — present but neither (fail closed;
//                                          `raw` is a boolean marker only —
//                                          the value itself is never returned,
//                                          so callers cannot log it by mistake)
export function parseConversationCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return { pin: 'none' };
  const parts = cookieHeader.split(';');
  let value = null;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== CONVERSATION_COOKIE) continue;
    value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
  }
  if (value === null || value === '') return { pin: 'none' };
  if (value === 'agent') return { pin: 'a0' };
  if (value.startsWith('opencode.')) {
    const id = value.slice('opencode.'.length);
    if (OPAQUE_ID_RE.test(id)) return { pin: 'b', conversationId: id };
  }
  return { pin: 'invalid', raw: true };
}

export function scopedCookiePath(workspaceId) {
  return `/api/agent/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc`;
}

// `secure`: true only when the trusted forwarded origin is HTTPS (the proxy
// tells the gateway; the gateway never sniffs the browser directly).
export function serializeConversationCookie(workspaceId, conversationId, { secure = false } = {}) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new ConversationError('conversation.invalid_args', 'workspaceId is required for cookie scope');
  }
  if (typeof conversationId !== 'string' || !OPAQUE_ID_RE.test(conversationId)) {
    throw new ConversationError('conversation.invalid_args', 'opaque conversationId is required for the B cookie');
  }
  const segments = [
    `${CONVERSATION_COOKIE}=opencode.${conversationId}`,
    `Path=${scopedCookiePath(workspaceId)}`,
    `Max-Age=${CONVERSATION_COOKIE_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) segments.push('Secure');
  return segments.join('; ');
}

// Expires exactly the scoped cookie (same Path — otherwise the browser
// keeps the pin). Used ONLY for the workspace scope of the failing B
// request; other workspaces' pins are untouched.
export function clearConversationCookie(workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new ConversationError('conversation.invalid_args', 'workspaceId is required to clear the scoped cookie');
  }
  return [
    `${CONVERSATION_COOKIE}=expired`,
    `Path=${scopedCookiePath(workspaceId)}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
}

function nowIso() {
  return new Date().toISOString();
}

function checkRecordShape(record) {
  if (!record || typeof record !== 'object') return false;
  if (!(
    typeof record.conversationId === 'string' && OPAQUE_ID_RE.test(record.conversationId) &&
    typeof record.workspace === 'string' && record.workspace.length > 0 &&
    typeof record.ownerActor === 'string' && record.ownerActor.length > 0 &&
    typeof record.deviceId === 'string' && record.deviceId.length > 0 &&
    CONVERSATION_VISIBILITIES.includes(record.visibility) &&
    (record.runtimeSessionId === null || typeof record.runtimeSessionId === 'string')
  )) return false;
  return checkIntentionsShape(record.intentions);
}

// Intention replay metadata: per-conversation map intentionId ->
// { status: 'pending'|'completed', userMessageId?, turnId?, actorId?,
//   createdAt, updatedAt }. IDs, author actor, and status ONLY — never prompt
// text, output, tokens, or transcripts. Anything else on disk is corruption
// (fail closed).
const INTENTION_STATUSES = ['pending', 'completed'];

function checkIntentionsShape(intentions) {
  if (intentions === undefined) return true; // pre-intention records normalize on load
  if (!intentions || typeof intentions !== 'object' || Array.isArray(intentions)) return false;
  for (const [key, value] of Object.entries(intentions)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) return false;
    if (!value || typeof value !== 'object') return false;
    if (!INTENTION_STATUSES.includes(value.status)) return false;
    for (const idKey of ['userMessageId', 'turnId', 'actorId']) {
      if (value[idKey] !== undefined && (typeof value[idKey] !== 'string' || value[idKey].length === 0)) return false;
    }
    for (const tKey of ['createdAt', 'updatedAt']) {
      if (typeof value[tKey] !== 'string' || value[tKey].length === 0) return false;
    }
    // Structural guarantee: only id/status/author/timestamp keys may persist.
    for (const k of Object.keys(value)) {
      if (!['status', 'userMessageId', 'turnId', 'actorId', 'createdAt', 'updatedAt'].includes(k)) return false;
    }
  }
  return true;
}

// Predicate over an ALREADY-REVALIDATED gateway identity
// ({ actorId, workspace, deviceId }) and a stored record. Pure, exported
// for tests. Never consults client claims — the identity argument must be
// the output of resolveGatewayIdentity, not request fields.
export function canAccessConversation(record, identity) {
  if (!record || !identity) return false;
  if (typeof identity.workspace !== 'string' || identity.workspace !== record.workspace) return false;
  if (typeof identity.actorId !== 'string' || identity.actorId.length === 0) return false;
  if (record.visibility === 'private' && identity.actorId !== record.ownerActor) return false;
  return true;
}

// persistDir: directory holding conversations.json (the SDK state dir).
// File write is atomic (tmp + rename); a corrupt file fails closed on load
// (never silently reset — the operator must inspect), an absent file starts
// empty. Lock chains are process-local.
export function createConversationStore({ persistDir } = {}) {
  if (typeof persistDir !== 'string' || persistDir.length === 0) {
    throw new ConversationError('conversation.invalid_args', 'persistDir is required');
  }
  const file = path.join(persistDir, 'conversations.json');
  const records = new Map();
  const locks = new Map();
  // Durable first-writer-wins index for lost-cookie retries:
  // JSON.stringify([workspace, ownerActor, intentionId]) -> conversationId.
  // IDs only (no text/output/token); the conversation record itself stays
  // the authority for visibility and runtime binding.
  const intentionOwners = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return; // fresh state dir
      throw new ConversationError('conversation.store_unreadable', 'conversation store unreadable — refusing to start over it');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConversationError('conversation.store_corrupt', 'conversation store is corrupt — refusing to reset it silently');
    }
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items)) {
      throw new ConversationError('conversation.store_corrupt', 'conversation store has an unknown shape — refusing to adopt it');
    }
    for (const record of items) {
      if (!checkRecordShape(record)) {
        throw new ConversationError('conversation.store_corrupt', 'conversation store holds a malformed record — refusing to adopt it');
      }
      if (record.intentions === undefined) record.intentions = {};
      records.set(record.conversationId, { ...record });
    }
    const rawIndex = !Array.isArray(parsed) && parsed && typeof parsed === 'object' ? parsed.intentionIndex : undefined;
    if (rawIndex !== undefined) {
      if (!rawIndex || typeof rawIndex !== 'object' || Array.isArray(rawIndex)) {
        throw new ConversationError('conversation.store_corrupt', 'conversation intention index has an unknown shape — refusing to adopt it');
      }
      for (const [k, v] of Object.entries(rawIndex)) {
        if (typeof v !== 'string' || !OPAQUE_ID_RE.test(v)) {
          throw new ConversationError('conversation.store_corrupt', 'conversation intention index holds a malformed conversation id — refusing to adopt it');
        }
        let parts;
        try {
          parts = JSON.parse(k);
        } catch {
          throw new ConversationError('conversation.store_corrupt', 'conversation intention index holds a malformed key — refusing to adopt it');
        }
        if (!Array.isArray(parts) || parts.length !== 3 || parts.some((p) => typeof p !== 'string' || p.length === 0 || p.length > 256)) {
          throw new ConversationError('conversation.store_corrupt', 'conversation intention index holds a malformed key — refusing to adopt it');
        }
        if (!records.has(v)) {
          throw new ConversationError('conversation.store_corrupt', 'conversation intention index points at an unknown conversation — refusing to adopt it');
        }
        const indexed = records.get(v);
        if (indexed.workspace !== parts[0] || indexed.ownerActor !== parts[1]) {
          throw new ConversationError('conversation.store_corrupt', 'conversation intention index disagrees with the record workspace/owner — refusing to adopt it');
        }
        intentionOwners.set(k, v);
      }
    }
  }

  function persist() {
    const payload = JSON.stringify({ version: 1, items: [...records.values()], intentionIndex: Object.fromEntries(intentionOwners) }, null, 2) + '\n';
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, { encoding: 'utf8' });
    fs.renameSync(tmp, file);
  }

  function requireLoaded() {
    load();
  }

  return {
    create({ workspace, ownerActor, deviceId, visibility = 'workspace' } = {}) {
      requireLoaded();
      if (typeof workspace !== 'string' || workspace.length === 0) {
        throw new ConversationError('conversation.invalid_args', 'canonical workspace is required (never a client claim)');
      }
      if (typeof ownerActor !== 'string' || ownerActor.length === 0) {
        throw new ConversationError('conversation.invalid_args', 'owner actor is required (verified identity)');
      }
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        throw new ConversationError('conversation.invalid_args', 'device is required (verified identity)');
      }
      validateVisibility(visibility);
      const conversationId = randomUUID();
      const stamped = nowIso();
      const record = {
        conversationId,
        workspace,
        ownerActor,
        deviceId,
        visibility,
        runtimeSessionId: null,
        runtimeOwner: null,
        messageCount: 0,
        intentions: {},
        createdAt: stamped,
        updatedAt: stamped,
      };
      records.set(conversationId, record);
      persist();
      return { ...record };
    },

    // Authenticated read: returns a copy ONLY when the verified identity
    // satisfies the visibility predicate; otherwise throws (private →
    // conversation.not_found to avoid oracle, cross-workspace → forbidden).
    // Every B request calls this AFTER resolveGatewayIdentity.
    get(conversationId, identity) {
      requireLoaded();
      const record = records.get(conversationId);
      if (!record) throw new ConversationError('conversation.not_found', 'conversation not found');
      if (!identity || typeof identity.workspace !== 'string') {
        throw new ConversationError('conversation.forbidden', 'verified identity is required before metadata');
      }
      if (identity.workspace !== record.workspace) {
        throw new ConversationError('conversation.forbidden', 'conversation belongs to another workspace');
      }
      if (record.visibility === 'private' && identity.actorId !== record.ownerActor) {
        throw new ConversationError('conversation.not_found', 'conversation not found');
      }
      return { ...record };
    },

    // Binds the native runtime session AFTER the access check above has
    // passed. The ONLY writer of runtimeSessionId; rebinds across
    // identities/owners are refused (explicit revoke path, not silent
    // takeover). Returns a copy.
    attachRuntime(conversationId, runtimeSessionId, runtimeOwner) {
      requireLoaded();
      const record = records.get(conversationId);
      if (!record) throw new ConversationError('conversation.not_found', 'conversation not found');
      if (typeof runtimeSessionId !== 'string' || runtimeSessionId.length === 0) {
        throw new ConversationError('conversation.invalid_args', 'runtimeSessionId is required');
      }
      if (record.runtimeSessionId !== null && record.runtimeSessionId !== runtimeSessionId) {
        throw new ConversationError('conversation.runtime_conflict', 'conversation already attached to another runtime session — explicit reset required');
      }
      record.runtimeSessionId = runtimeSessionId;
      record.runtimeOwner = typeof runtimeOwner === 'string' ? runtimeOwner : null;
      record.updatedAt = nowIso();
      persist();
      return { ...record };
    },

    noteTurn(conversationId) {
      requireLoaded();
      const record = records.get(conversationId);
      if (!record) throw new ConversationError('conversation.not_found', 'conversation not found');
      record.messageCount += 1;
      record.updatedAt = nowIso();
      persist();
      return { ...record };
    },

    resetRuntime(conversationId) {
      requireLoaded();
      const record = records.get(conversationId);
      if (!record) throw new ConversationError('conversation.not_found', 'conversation not found');
      record.runtimeSessionId = null;
      record.runtimeOwner = null;
      record.updatedAt = nowIso();
      persist();
      return { ...record };
    },

    // Intention replay registry (cross-restart duplicate protection).
    //
    // The prompt host's seen-set is process-local: after a restart it is
    // empty and a retried PWA turn would issue a SECOND native prompt for
    // the same intentionId. These methods persist id+status metadata ONLY
    // (no prompt text, no output, no token, no transcript) so the gateway
    // can decide WITHOUT prompting again: completed → rebuild from native
    // history; pending/admitted → typed in-progress; absent → claim+prompt.
    //
    // Callers MUST consult store.get(conversationId, identity) first (the
    // visibility check lives there); these methods take the bare id because
    // they run inside the already-authorized turn lock.
    getIntention(conversationId, intentionId) {
      requireLoaded();
      const record = records.get(conversationId);
      if (!record) throw new ConversationError('conversation.not_found', 'conversation not found');
      if (typeof intentionId !== 'string' || intentionId.length === 0) {
        throw new ConversationError('conversation.invalid_args', 'intentionId is required');
      }
      const entry = (record.intentions ?? {})[intentionId];
      return entry ? { ...entry } : null;
    },

    claimIntention(conversationId, intentionId) {
      requireLoaded();
      const record = records.get(conversationId);
      if (!record) throw new ConversationError('conversation.not_found', 'conversation not found');
      if (typeof intentionId !== 'string' || intentionId.length === 0 || intentionId.length > 256) {
        throw new ConversationError('conversation.invalid_args', 'intentionId (string, non-empty) is required');
      }
      if (record.intentions === undefined) record.intentions = {};
      if (record.intentions[intentionId]) {
        throw new ConversationError('conversation.intention_duplicate', 'intention already claimed — retry reuses native history, never a second prompt');
      }
      const stamped = nowIso();
      record.intentions[intentionId] = { status: 'pending', createdAt: stamped, updatedAt: stamped };
      record.updatedAt = stamped;
      persist();
      return { ...record.intentions[intentionId] };
    },

    settleIntention(conversationId, intentionId, patch = {}) {
      requireLoaded();
      const record = records.get(conversationId);
      if (!record) throw new ConversationError('conversation.not_found', 'conversation not found');
      if (record.intentions === undefined) record.intentions = {};
      const entry = record.intentions[intentionId];
      if (!entry) throw new ConversationError('conversation.intention_not_found', 'intention was never claimed — refusing to invent history');
      const allowed = new Set(['status', 'userMessageId', 'turnId', 'actorId']);
      for (const k of Object.keys(patch)) {
        if (!allowed.has(k)) {
          throw new ConversationError('conversation.invalid_args', `intention field '${k}' is not metadata — refused (ids/status/author only)`);
        }
      }
      if (patch.status !== undefined && !INTENTION_STATUSES.includes(patch.status)) {
        throw new ConversationError('conversation.invalid_args', 'intention status must be pending|completed');
      }
      for (const idKey of ['userMessageId', 'turnId', 'actorId']) {
        if (patch[idKey] !== undefined && (typeof patch[idKey] !== 'string' || patch[idKey].length === 0)) {
          throw new ConversationError('conversation.invalid_args', `intention ${idKey} must be a non-empty string id`);
        }
      }
      Object.assign(entry, patch, { updatedAt: nowIso() });
      record.updatedAt = entry.updatedAt;
      persist();
      return { ...entry };
    },

    // Durable lost-cookie retry index: first-writer-wins mapping
    // (workspace, ownerActor, intentionId) -> conversationId. IDs only.
    // The caller MUST still authorize via get(conversationId, identity)
    // before touching any native handle — this lookup is routing, not access.
    findConversationForRetry({ workspace, ownerActor, intentionId } = {}) {
      requireLoaded();
      if (typeof workspace !== 'string' || workspace.length === 0) return null;
      if (typeof ownerActor !== 'string' || ownerActor.length === 0) return null;
      if (typeof intentionId !== 'string' || intentionId.length === 0 || intentionId.length > 256) return null;
      const found = intentionOwners.get(JSON.stringify([workspace, ownerActor, intentionId])) ?? null;
      if (found === null) return null;
      // Defense in depth: the index is routing, not authority — a record that
      // no longer matches its key fails closed to null (no wrong routing).
      const record = records.get(found);
      if (!record) return null;
      if (record.workspace !== workspace || record.ownerActor !== ownerActor) return null;
      return found;
    },

    // Records the first writer; NEVER overwrites: a retry racing the first
    // request resolves to the first conversation instead of minting a second
    // session/prompt. Returns { conversationId, created }.
    recordIntentionOwner({ workspace, ownerActor, intentionId, conversationId } = {}) {
      requireLoaded();
      if (typeof workspace !== 'string' || workspace.length === 0) {
        throw new ConversationError('conversation.invalid_args', 'workspace is required for the retry index');
      }
      if (typeof ownerActor !== 'string' || ownerActor.length === 0) {
        throw new ConversationError('conversation.invalid_args', 'owner actor is required for the retry index');
      }
      if (typeof intentionId !== 'string' || intentionId.length === 0 || intentionId.length > 256) {
        throw new ConversationError('conversation.invalid_args', 'intentionId (string, non-empty) is required');
      }
      if (typeof conversationId !== 'string' || !OPAQUE_ID_RE.test(conversationId)) {
        throw new ConversationError('conversation.invalid_args', 'opaque conversationId is required for the retry index');
      }
      if (!records.has(conversationId)) {
        throw new ConversationError('conversation.not_found', 'conversation not found for the retry index');
      }
      const record = records.get(conversationId);
      if (record.workspace !== workspace || record.ownerActor !== ownerActor) {
        throw new ConversationError('conversation.invalid_args', 'retry index workspace/owner disagrees with the conversation record — refusing to route to another conversation');
      }
      const key = JSON.stringify([workspace, ownerActor, intentionId]);
      const existing = intentionOwners.get(key);
      if (existing) return { conversationId: existing, created: false };
      intentionOwners.set(key, conversationId);
      persist();
      return { conversationId, created: true };
    },

    // Test-only seam: number of live per-conversation turn locks. Used by the
    // withTurnLock leak regression; not a production diagnostic surface.
    lockCount() {
      return locks.size;
    },

    // Serializes same-conversation turns so the process-local tool host
    // binding cannot race across identities. Failures run the chain
    // (queue never wedges) but still reject the caller. The stored tail is
    // the settled promise itself (with a detached catch for unhandled
    // rejections), so completion — success or failure — always releases the
    // entry instead of leaking it.
    withTurnLock(conversationId, fn) {
      if (typeof conversationId !== 'string' || conversationId.length === 0) {
        return Promise.reject(new ConversationError('conversation.invalid_args', 'conversationId is required for the turn lock'));
      }
      if (typeof fn !== 'function') {
        return Promise.reject(new ConversationError('conversation.invalid_args', 'turn function is required'));
      }
      const tail = locks.get(conversationId) ?? Promise.resolve();
      const run = tail.then(() => fn(), () => fn());
      const settled = run.then(
        (value) => {
          if (locks.get(conversationId) === settled) locks.delete(conversationId);
          return value;
        },
        (e) => {
          if (locks.get(conversationId) === settled) locks.delete(conversationId);
          throw e;
        },
      );
      locks.set(conversationId, settled);
      settled.catch(() => {});
      return run;
    },
  };
}
