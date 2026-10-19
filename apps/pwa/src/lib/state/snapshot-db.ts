/**
 * Snapshot DB — IndexedDB v2 offline snapshot.
 *
 * Partitioned by offlineSubjectId (the active workspace/household UUID —
 * opaque, non-credential, never derived from a credential — SPEC §8.B4,
 * D-V4-11). The SHA-256 token fingerprint stays as an ADDITIONAL defense
 * layer, never the primary key. Every envelope carries
 * lastOnlineAuthenticatedAt (SPEC §10 D1); reads fail closed when the age
 * exceeds MAX_OFFLINE_AUTH_AGE (SPEC §10 D2, default 72h, call-time env
 * `NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS`).
 *
 * Migration (T2.6): pre-T2.6 envelopes keyed by fingerprint only (no
 * subject, no age) are treated as untrusted on read — invalidated (deleted)
 * so the next online cycle re-syncs. Zero data loss: the snapshot is a
 * re-syncable cache, never the source of truth (the API is).
 *
 * On corrupt/schema/owner mismatch: delete v2 and return no data,
 * forcing online sync.
 */
import { getOfflineSubjectId } from "@/lib/auth/offline-subject";
import {
  computeOwnerKey,
  getOfflineGeneration,
  getOfflinePrincipalId,
  getOfflineWorkspaceId,
  isOfflineWorkspaceId,
} from "@/lib/auth/offline-identity";
import { getMaxOfflineAuthAgeMs, isOfflineSnapshotEnabled } from "@/lib/capabilities";
// Local types — duplicated structurally from snapshot-store, but using the real
// domain shapes from ./types (a leaf module, so no circular dependency).
// Keeping the shapes identical to snapshot-store's SnapshotDomains lets
// readV2Snapshot's return type satisfy loadSnapshotDomain's signature.
import type {
  Account, Category, Transaction, Payable, Budget, Goal, Subscription, CardStatement,
} from "./types";

export type DomainKey =
  | "accounts"
  | "categories"
  | "transactions"
  | "payables"
  | "budgets"
  | "goals"
  | "subscriptions"
  | "cardStatements";

export interface SnapshotDomains {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  payables: Payable[];
  budgets: Budget[];
  goals: Goal[];
  subscriptions: Subscription[];
  cardStatements: CardStatement[];
}

export const DB_NAME = "pi-finance-snapshot";
export const STORE_NAME = "snapshots";
export const V2_ENVELOPE_KEY = "v2";
export const V3_ENVELOPE_KEY = "v3";
export const V3_SCHEMA = 3;
export const SNAPSHOT_OPERATION_TIMEOUT_MS = 5_000;

// ── Types ──────────────────────────────────────────────────────────

interface V2Envelope {
  schema: 2;
  ownerFingerprint: string;
  /**
   * Partition key (T2.6 B4): active workspace/household UUID. Absent only
   * on legacy (pre-T2.6) envelopes, which are treated as untrusted.
   */
  offlineSubjectId?: string;
  /**
   * Last online-authenticated instant (T2.6 D1, ISO). Refreshed on every
   * online write/migration/revalidation. Absent only on legacy envelopes.
   */
  lastOnlineAuthenticatedAt?: string;
  domains: Partial<SnapshotDomains>;
  syncedAt: Partial<Record<DomainKey, string>>;
}

// ── Offline age policy (T2.6 D1-D3, ADR-015) ─────────────────────────

/**
 * Closed age-band enum for the `offline.locked` telemetry event (T0.4.4,
 * SPEC §24.4): coarse bands only — never timestamps, durations or free
 * text. Mirrors the API-side OFFLINE_AGE_BANDS allowlist.
 */
export const OFFLINE_AGE_BANDS = ["<1d", "1-7d", "7-30d", ">30d"] as const;

export type OfflineAgeBand = (typeof OFFLINE_AGE_BANDS)[number];

/**
 * Clock-skew allowance (ADR-015: tolerance registered, never authority):
 * max(5 minutes, 5% of the max age). A device clock slightly behind the
 * stamping clock must not false-lock; the allowance only EXTENDS the
 * limit, never bypasses the check.
 */
export function getOfflineClockSkewMs(maxAgeMs: number): number {
  return Math.max(5 * 60_000, maxAgeMs * 0.05);
}

export function getOfflineAgeBand(ageMs: number): OfflineAgeBand {
  const day = 24 * 3_600_000;
  if (ageMs < day) return "<1d";
  if (ageMs < 7 * day) return "1-7d";
  if (ageMs < 30 * day) return "7-30d";
  return ">30d";
}

export type OfflineLockState =
  | { state: "empty" }
  | { state: "ok"; offlineSubjectId: string; ageMs: number; ageBand: OfflineAgeBand }
  | {
      state: "locked";
      reason: "no-subject" | "expired";
      offlineSubjectId?: string;
      ageMs?: number;
      ageBand?: OfflineAgeBand;
    }
  | { state: "untrusted"; reason: "legacy-envelope" | "subject-mismatch" | "missing-age" };

/**
 * Pure lock evaluation (unit-tested; the offline shell mirrors this logic
 * in plain JS — see public/offline-shell.js — with the same 72h default
 * and skew rule, since the shell runs without the app bundle).
 */
export function evaluateOfflineLock(
  env: { offlineSubjectId?: unknown; lastOnlineAuthenticatedAt?: unknown } | null,
  subject: string | null,
  nowMs: number,
  maxAgeMs: number,
): OfflineLockState {
  if (!env) return { state: "empty" };
  // No local subject: ownership cannot be verified → fail closed. The
  // envelope is kept (it may belong to a subject restored on next login).
  if (!subject) return { state: "locked", reason: "no-subject" };
  if (typeof env.offlineSubjectId !== "string" || env.offlineSubjectId.length === 0) {
    return { state: "untrusted", reason: "legacy-envelope" };
  }
  if (env.offlineSubjectId !== subject) {
    return { state: "untrusted", reason: "subject-mismatch" };
  }
  if (typeof env.lastOnlineAuthenticatedAt !== "string") {
    return { state: "untrusted", reason: "missing-age" };
  }
  const stamped = Date.parse(env.lastOnlineAuthenticatedAt);
  if (Number.isNaN(stamped)) return { state: "untrusted", reason: "missing-age" };
  // Future stamps (clock moved backwards) clamp to zero — never negative.
  const ageMs = Math.max(0, nowMs - stamped);
  if (ageMs > maxAgeMs + getOfflineClockSkewMs(maxAgeMs)) {
    return {
      state: "locked",
      reason: "expired",
      offlineSubjectId: subject,
      ageMs,
      ageBand: getOfflineAgeBand(ageMs),
    };
  }
  return { state: "ok", offlineSubjectId: subject, ageMs, ageBand: getOfflineAgeBand(ageMs) };
}

/**
 * Read the envelope and evaluate the offline lock with live clock and
 * call-time max age. Never throws: storage failures report "empty"
 * (fail-closed at the reader, which treats non-ok as no data).
 */
export async function getOfflineSnapshotLockState(
  nowMs: number = Date.now(),
  maxAgeMs: number = getMaxOfflineAuthAgeMs(),
): Promise<OfflineLockState> {
  // D10 optional disable: no snapshot may be trusted while disabled.
  if (!isOfflineSnapshotEnabled()) return { state: "empty" };
  try {
    const env = await readV2Envelope();
    return evaluateOfflineLock(env, getOfflineSubjectId(), nowMs, maxAgeMs);
  } catch {
    return { state: "empty" };
  }
}

/**
 * Online revalidation (T2.6 D3): refresh the envelope's age stamp to now
 * after a successful online authentication, preserving domains. Returns
 * false when there is nothing to refresh. Never creates an envelope —
 * creation happens only through authenticated writes/migration.
 */
export async function refreshOfflineAuthAge(nowIso?: string): Promise<boolean> {
  // D10 optional disable: nothing to refresh while disabled.
  if (!isOfflineSnapshotEnabled()) return false;
  const at = nowIso ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) return false;
  // T07a-R3 liveness guard: same stale-commit window as the snapshot writes.
  // A teardown crossing the envelope read or the commit open must not renew
  // the stamp of a revoked session's envelope (repopulation). On abort
  // return false — the sole production caller (revalidateOfflineSession in
  // app-state-context) ignores the value (`.catch(() => false)`, always
  // unlocks + returns true), so the happy path is untouched.
  const entryGeneration = getOfflineGeneration();
  const entrySubject = getOfflineSubjectId();
  const stillValid = (): boolean =>
    getOfflineGeneration() === entryGeneration &&
    getOfflineSubjectId() === entrySubject;
  let refreshed = false;
  await withWriteLock(async () => {
    const existing = await readV2Envelope();
    if (!existing) return;
    // T07a-R2/R3: the envelope read is an awaited gap — revalidate before
    // the put.
    if (!stillValid()) return;
    existing.lastOnlineAuthenticatedAt = at;
    await writeV2Envelope(existing, stillValid);
    // The guarded put may have aborted on a teardown inside the commit open.
    refreshed = stillValid();
  });
  return refreshed;
}

// ── Database lifecycle ─────────────────────────────────────────────

/** Open (or create) the IndexedDB snapshot database with safety timeout. */
export function openSnapshotDb(timeoutMs = 5000): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not supported"));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("IndexedDB open timed out"));
    }, timeoutMs);

    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        reject(request.error);
      };
      request.onblocked = () => {
        clearTimeout(timer);
        reject(new Error("IndexedDB database blocked"));
      };
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

// ── Token fingerprint ──────────────────────────────────────────────

async function fingerprint(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Read / Write / Delete ─────────────────────────────────────────

async function readV2Envelope(): Promise<V2Envelope | null> {
  const db = await openSnapshotDb();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      db.close();
      reject(new Error("IndexedDB transaction timed out"));
    }, SNAPSHOT_OPERATION_TIMEOUT_MS);
    const finish = (value: V2Envelope | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(V2_ENVELOPE_KEY);
    req.onsuccess = () => {
      const envelope = req.result as V2Envelope | undefined;
      finish(envelope ?? null);
    };
    req.onerror = () => finish(null);
    tx.oncomplete = () => db.close();
    tx.onerror = () => fail(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => fail(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * T07a-R2 liveness predicate: re-checked after EVERY awaited step between
 * the entry gate and the final put. A teardown crossing any gap aborts the
 * write before anything hits disk — the openSnapshotDb await below is itself
 * a gap, so the guard runs after it resolves and before `store.put`.
 * Silent abort (no write, no throw): same semantics the entry gate gives a
 * revoked writer, and the caller's post-write validation (migration reread)
 * treats a missing envelope as "not applied".
 */
type LivenessGuard = () => boolean;

async function writeV2Envelope(env: V2Envelope, isStillValid?: LivenessGuard): Promise<void> {
  const db = await openSnapshotDb();
  if (isStillValid && !isStillValid()) {
    db.close();
    return;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      db.close();
      reject(new Error("IndexedDB transaction timed out"));
    }, SNAPSHOT_OPERATION_TIMEOUT_MS);
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    try {
      store.put(env, V2_ENVELOPE_KEY);
      tx.oncomplete = () => { db.close(); finish(); };
      tx.onerror = () => { db.close(); finish(tx.error); };
      tx.onabort = () => { db.close(); finish(tx.error); };
    } catch (error) {
      db.close();
      finish(error);
    }
  });
}

/** Delete the entire v2 snapshot. Idempotent. */
export async function deleteV2Snapshot(): Promise<void> {
  const db = await openSnapshotDb();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      db.close();
      resolve();
    }, SNAPSHOT_OPERATION_TIMEOUT_MS);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    try {
      store.delete(V2_ENVELOPE_KEY);
      tx.oncomplete = () => { db.close(); finish(); };
      tx.onerror = () => { db.close(); finish(); }; // swallow
      tx.onabort = () => { db.close(); finish(); }; // swallow
    } catch {
      db.close();
      finish();
    }
  });
}

/**
 * P2 cross-tab guard: delete the V2 slot ONLY while it still belongs to the
 * given owner (fingerprint + subject partition), checked and deleted inside
 * a SINGLE readwrite transaction. `withWriteLock` serializes only this
 * module instance — another tab may commit its own V2 between our commit
 * and our validation reread; an unconditional delete would destroy that
 * foreign envelope. A non-matching slot (or a read failure) is preserved.
 *
 * Liveness (teardown/rebind race): the caller's entry liveness check runs
 * BEFORE `openSnapshotDb()` — itself an awaited gap. A teardown/rebind
 * landing in that gap (plus a fresh same-owner commit from another tab)
 * would let the stale cleanup delete the new cache. The optional
 * `isStillValid` guard is therefore re-checked AFTER the open resolves and
 * again inside `getReq.onsuccess` immediately before the delete; any
 * divergence preserves the slot (fail-closed).
 */
async function deleteV2SnapshotIfOwned(
  ownerFingerprint: string,
  subject: string | null,
  isStillValid?: LivenessGuard,
): Promise<void> {
  const db = await openSnapshotDb();
  if (isStillValid && !isStillValid()) {
    db.close();
    return;
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      db.close();
      resolve();
    }, SNAPSHOT_OPERATION_TIMEOUT_MS);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(V2_ENVELOPE_KEY);
      getReq.onsuccess = () => {
        try {
          // Liveness revalidation at delete time: a teardown/rebind (or a
          // same-owner re-bind of a newer generation) crossing the commit
          // open or the get must not delete the fresh envelope.
          if (isStillValid && !isStillValid()) return;
          const env = getReq.result as V2Envelope | undefined;
          const owned =
            !!env &&
            env.schema === 2 &&
            env.ownerFingerprint === ownerFingerprint &&
            (subject === null ? !env.offlineSubjectId : env.offlineSubjectId === subject);
          if (owned) store.delete(V2_ENVELOPE_KEY);
        } catch {
          /* fall through — tx events finish */
        }
      };
      // Read failure: never delete — the slot ownership is unverified.
      tx.oncomplete = () => { db.close(); finish(); };
      tx.onerror = () => { db.close(); finish(); }; // swallow
      tx.onabort = () => { db.close(); finish(); }; // swallow
    } catch {
      db.close();
      finish();
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Read one domain from v2 snapshot.
 *
 * Fail-closed (T2.6): returns null on owner mismatch, corrupt data,
 * missing envelope, subject partition miss, missing age stamp, or expired
 * age (`offline session locked`). Untrusted envelopes (legacy without
 * subject/age, subject mismatch) are invalidated so the next online cycle
 * re-syncs; merely expired envelopes are KEPT so online revalidation can
 * unlock without a full re-sync.
 */
export async function readV2Snapshot<K extends DomainKey>(
  token: string,
  domain: K,
): Promise<{ data: SnapshotDomains[K]; syncedAt: string } | null> {
  // D10 optional disable: serve nothing while disabled.
  if (!isOfflineSnapshotEnabled()) return null;
  // T07a state gate: revocation/logout/switch clears the subject partition
  // synchronously — fail closed in the same tick without touching IndexedDB,
  // so reads stay blocked even when IDB is slow or failing. The envelope is
  // kept for its rightful owner instead of being deleted on a transient miss.
  if (getOfflineSubjectId() === null) return null;
  try {
    const fp = await fingerprint(token);
    const env = await readV2Envelope();

    if (!env || env.schema !== 2 || env.ownerFingerprint !== fp) {
      // Owner mismatch or corrupt — delete v2, return null
      if (env) await deleteV2Snapshot();
      return null;
    }

    const lock = evaluateOfflineLock(
      env,
      getOfflineSubjectId(),
      Date.now(),
      getMaxOfflineAuthAgeMs(),
    );
    if (lock.state === "locked") return null; // kept for revalidation
    if (lock.state !== "ok") {
      // Untrusted (legacy / mismatch / missing age) — invalidate, re-sync online.
      await deleteV2Snapshot();
      return null;
    }

    const data = env.domains[domain];
    const syncedAt = env.syncedAt[domain];
    if (data === undefined || syncedAt === undefined) return null;

    return { data: data as SnapshotDomains[K], syncedAt };
  } catch {
    await deleteV2Snapshot().catch(() => {});
    return null;
  }
}

export interface WriteV2SnapshotOptions {
  /**
   * Override the age stamp (tests / controlled re-stamps). Defaults to
   * now. Invalid values fall back to now — a write is always an
   * online-authenticated moment, so the stamp must exist.
   */
  lastOnlineAuthenticatedAt?: string;
  /**
   * FIX-168-FIX3 (HIGH REVIEWER-168-R2): identidade capturada pelo chamador
   * (bootstrap) antes dos gaps assíncronos. Gravações tardias cuja partição
   * corrente divergiu da esperada são descartadas — nunca re-atribuídas ao
   * subject vigente.
   */
  expectedSubject?: string | null;
}

/** Build a fresh envelope base stamped with subject + age. */
function freshEnvelope(fp: string, authenticatedAt: string, subject: string | null): V2Envelope {
  return {
    schema: 2,
    ownerFingerprint: fp,
    ...(subject ? { offlineSubjectId: subject } : {}),
    lastOnlineAuthenticatedAt: authenticatedAt,
    domains: {},
    syncedAt: {},
  };
}

function resolveAuthenticatedAt(override?: string): string {
  if (override && !Number.isNaN(Date.parse(override))) return override;
  return new Date().toISOString();
}

/**
 * Write one domain to the v2 snapshot.
 * Stamps with the token fingerprint (never the raw token) plus the
 * offlineSubjectId partition and the last-online-auth age stamp.
 */
export async function writeV2Snapshot<K extends DomainKey>(
  token: string,
  domain: K,
  data: SnapshotDomains[K],
  opts?: WriteV2SnapshotOptions,
): Promise<void> {
  // D10 optional disable: persist nothing while disabled.
  if (!isOfflineSnapshotEnabled()) return;
  // T07a: capture the offline generation BEFORE the first await. A teardown
  // (revocation/logout/switch) landing in any async gap drops the write —
  // stale responses never re-populate the snapshot.
  const entryGeneration = getOfflineGeneration();
  // FIX-168-FIX3: captura a identidade ANTES do primeiro await. O
  // fingerprint (SHA-256) e o lock de escrita cedem o event loop — uma troca
  // A→B nesse gap não pode re-atribuir o payload ao subject vigente.
  const entrySubject = getOfflineSubjectId();
  const fp = await fingerprint(token);
  const authenticatedAt = resolveAuthenticatedAt(opts?.lastOnlineAuthenticatedAt);
  const subject = getOfflineSubjectId();
  // Descarte tardio na persistência: a identidade mudou durante o
  // fingerprint, ou divergiu da capturada pelo bootstrap na entrada, ou um
  // teardown avançou a geração no gap.
  if (getOfflineGeneration() !== entryGeneration) return;
  if (subject !== entrySubject) return;
  if (opts?.expectedSubject !== undefined && subject !== opts.expectedSubject) return;
  // T07a-R2 liveness guard: re-checked after EVERY awaited step below — a
  // teardown crossing any gap aborts the write before anything hits disk.
  const stillValid = (): boolean =>
    getOfflineGeneration() === entryGeneration &&
    getOfflineSubjectId() === subject &&
    (opts?.expectedSubject === undefined || getOfflineSubjectId() === opts.expectedSubject);
  // Serialize the read-modify-write so concurrent bootstrap writes (one per
  // domain) cannot read a stale envelope and overwrite each other's data.
  await withWriteLock(async () => {
    // Revalida após a fila do lock: a seleção pode ter mudado com a escrita
    // enfileirada (cancelamento/remount não cancela gravações pendentes), ou
    // um teardown pode ter avançado a geração com a escrita enfileirada.
    if (getOfflineGeneration() !== entryGeneration) return;
    const lockedSubject = getOfflineSubjectId();
    if (lockedSubject !== subject) return;
    if (opts?.expectedSubject !== undefined && lockedSubject !== opts.expectedSubject) return;
    const existing = await readV2Envelope();
    // T07a-R2: the envelope read is an awaited gap — revalidate before
    // building the put. A teardown (or same-subject re-bind of a newer
    // generation) landing here aborts the stale write.
    if (!stillValid()) return;
    // Adopt only the same partition (fingerprint + subject). A subjectless
    // writer never adopts a subject-stamped envelope (it may belong to a
    // session whose subject was lost) — it starts a fresh base instead.
    const samePartition =
      existing &&
      existing.ownerFingerprint === fp &&
      (lockedSubject === null ? !existing.offlineSubjectId : existing.offlineSubjectId === lockedSubject);
    const base: V2Envelope = samePartition
      ? existing
      : freshEnvelope(fp, authenticatedAt, lockedSubject);

    // A new partition base already carries the stamp; an adopted envelope
    // is refreshed because this write is an online-authenticated moment.
    // Legacy adopted envelopes (no subject field) gain the current subject
    // only when one is present — never a credential-derived value.
    if (lockedSubject && !base.offlineSubjectId) base.offlineSubjectId = lockedSubject;

    // A new partition base already carries the stamp; an adopted envelope
    // is refreshed because this write is an online-authenticated moment.
    // Legacy adopted envelopes (no subject field) gain the current subject
    // only when one is present — never a credential-derived value.
    if (subject && !base.offlineSubjectId) base.offlineSubjectId = subject;
    base.lastOnlineAuthenticatedAt = authenticatedAt;
    base.domains[domain] = data;
    base.syncedAt[domain] = new Date().toISOString();

    await writeV2Envelope(base, stillValid);
  });
}

// ── Write serialization ───────────────────────────────────────────
// writeV2Snapshot is read-modify-write; bootstrap fires one write per domain
// concurrently. A single-chain lock guarantees each write observes the prior
// one's commit, eliminating lost-update races.
let writeChain: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive regardless of success/failure, but swallow rejections
  // so a single failed write does not poison later writes.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Migrate data from localStorage v1 to IndexedDB v2.
 * Validates, writes to v2, then deletes v1.
 * On v1 corruption or owner mismatch: silently clean up.
 */
export async function migrateV1toV2(token: string): Promise<void> {
  const V1_KEY = "pi-finance:snapshot:v1";

  // ── Step 1: parse v1 (migration input only) ──
  let v1: { token: string; syncedAt: Record<string, string>; data: Record<string, unknown> } | null = null;
  try {
    const raw = localStorage.getItem(V1_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.token) {
        v1 = parsed;
      } else {
        // Valid JSON but not a usable v1 envelope (wrong version / missing token):
        // not a migration source — discard to avoid stale garbage.
        localStorage.removeItem(V1_KEY);
        return;
      }
    }
  } catch {
    // Corrupt / unparseable v1 — unrecoverable. Discard safely.
    try { localStorage.removeItem(V1_KEY); } catch { /* noop */ }
    return;
  }

  if (!v1) return; // nothing to migrate

  // ── Step 2: owner check ──
  // v1 belongs to a different token/session — preserve it so the rightful
  // session can migrate it later. Never mix owners or delete another user's cache.
  if (v1.token !== token) return;

  // Cleanup identity for the failure paths below: the validation-failure
  // discard and the catch-all may only remove a V2 slot that still belongs
  // to THIS migration (fingerprint + entry subject). Armed once the entry
  // identity is captured; a foreign slot is always preserved.
  let cleanupFp: string | null = null;
  let cleanupSubject: string | null = null;
  let cleanupGeneration: number | null = null;
  let cleanupArmed = false;

  // ── Step 3: migrate under the active session, validate, then delete ──
  // All IndexedDB access is isolated: any failure PRESERVES v1 (never deletes),
  // so an interrupted migration cannot lose the only copy of the data.
  try {
    // FIX-168-FIX3: mesma captura pré-await do write — a migração não pode
    // re-atribuir o v1 de A ao subject vigente após uma troca A→B no gap do
    // fingerprint. Abortar preserva o v1 (nada é deletado aqui).
    const entrySubject = getOfflineSubjectId();
    const entryGeneration = getOfflineGeneration();
    cleanupSubject = entrySubject;
    cleanupGeneration = entryGeneration;
    // T07a-R2 liveness guard: re-checked after EVERY awaited step below.
    const stillValid = (): boolean =>
      getOfflineGeneration() === entryGeneration &&
      getOfflineSubjectId() === entrySubject;
    const fp = await fingerprint(token);
    cleanupFp = fp;
    cleanupArmed = true;
    if (getOfflineSubjectId() !== entrySubject) return;
    if (getOfflineGeneration() !== entryGeneration) return;
    // FIX-216: the whole read-modify-write + validation runs serialized
    // with the writers inside withWriteLock. A concurrent writer landing
    // between our read and our put no longer loses its domains to our
    // stale-base overwrite, and our validation reread observes the lock.
    let migrated = false;
    await withWriteLock(async () => {
      const existing = await readV2Envelope();
      // T07a-R2: the envelope read is an awaited gap — revalidate before the put.
      if (!stillValid()) return;
      const subject = getOfflineSubjectId();
      if (subject !== entrySubject) return;
      const authenticatedAt = new Date().toISOString();
      const samePartition =
        existing &&
        existing.ownerFingerprint === fp &&
        (subject === null ? !existing.offlineSubjectId : existing.offlineSubjectId === subject);
      const base: V2Envelope = samePartition
        ? existing
        : freshEnvelope(fp, authenticatedAt, subject);

      for (const domain of Object.keys(v1.data)) {
        base.domains[domain as keyof SnapshotDomains] = v1.data[domain] as never;
      }
      for (const domain of Object.keys(v1.data)) {
        // Fall back to now when the v1 envelope lacks a per-domain syncedAt so
        // the v2 read path (which requires syncedAt) never discards valid data.
        base.syncedAt[domain as DomainKey] =
          v1.syncedAt[domain] ?? new Date().toISOString();
      }
      // Migration runs inside an authenticated bootstrap: the adopted or fresh
      // base carries the current subject partition and a fresh age stamp.
      // A teardown landing anywhere in the gaps above drops the migration —
      // a stale bootstrap must never populate the snapshot.
      if (!stillValid()) return;
      if (subject && !base.offlineSubjectId) base.offlineSubjectId = subject;
      base.lastOnlineAuthenticatedAt = authenticatedAt;

      await writeV2Envelope(base, stillValid);

      // Validation: reread v2 and confirm our data actually landed in OUR
      // partition before we are allowed to delete the v1 source. Fingerprint
      // alone is not enough: an A→B switch between the commit and this reread
      // must preserve v1 for its rightful owner instead of deleting it under
      // a stale fingerprint-only validation.
      const reread = await readV2Envelope();
      const currentSubject = getOfflineSubjectId();
      const workspaceBinding = getOfflineWorkspaceId();
      const partitionOk =
        reread !== null &&
        reread.schema === 2 &&
        reread.ownerFingerprint === fp &&
        currentSubject === entrySubject &&
        (currentSubject === null
          ? !reread.offlineSubjectId
          : reread.offlineSubjectId === currentSubject) &&
        (workspaceBinding === null || workspaceBinding === currentSubject) &&
        stillValid();
      const contentOk =
        partitionOk &&
        reread !== null &&
        Object.keys(v1.data).every(
          (d) => d in reread.domains && reread.syncedAt[d as DomainKey] !== undefined,
        );

      if (!partitionOk || !contentOk) {
        // Write didn't stick — discard a partial v2 ONLY while the slot
        // still belongs to this migration. Another tab may have committed
        // its own V2 between our commit and this reread (withWriteLock is
        // local-only); that foreign envelope must survive. A teardown
        // crossing the migration (stillValid() false) also preserves: the
        // slot may already belong to a new session. v1 is always kept here.
        if (stillValid() && cleanupFp !== null) {
          await deleteV2SnapshotIfOwned(cleanupFp, cleanupSubject, stillValid).catch(() => {});
        }
        return;
      }
      migrated = true;
    });

    if (!migrated) return;

    // Success: only now delete the v1 source.
    localStorage.removeItem(V1_KEY);
  } catch {
    // Migration failed (storage/IndexedDB error). Preserve v1; discard a
    // partial v2 only when it is provably ours (see above) — never a
    // foreign slot. A teardown crossing the migration also preserves: the
    // slot may already belong to a new session (same-subject re-login would
    // otherwise lose its fresh envelope to our stale cleanup).
    if (
      cleanupArmed &&
      cleanupFp !== null &&
      cleanupGeneration !== null &&
      getOfflineGeneration() === cleanupGeneration &&
      getOfflineSubjectId() === cleanupSubject
    ) {
      // Liveness travels INTO the helper: the open + get gaps below are
      // revalidated there, so a teardown/rebind landing mid-cleanup (with a
      // fresh same-owner commit from another tab) preserves the new cache.
      const expectedGeneration = cleanupGeneration;
      const expectedSubject = cleanupSubject;
      const stillValid = (): boolean =>
        getOfflineGeneration() === expectedGeneration &&
        getOfflineSubjectId() === expectedSubject;
      await deleteV2SnapshotIfOwned(cleanupFp, cleanupSubject, stillValid).catch(() => {});
    }
  }
}

// ── V3 envelope (V4.1 Closure Phase 3, AUTH-02/AUTH-03) ──────────────
//
// Identity-keyed offline snapshot. Unlike V2 (token-fingerprint keyed),
// V3 ownership is version + principal + workspace — all opaque,
// non-authenticator identifiers bound ONLY after a server-confirmed online
// authentication (AUTH-02). No bearer, device secret, or cookie value ever
// keys, partitions, or unlocks a V3 read/write.
//
// Single-slot cache (key "v3") with an explicit ownerKey check, mirroring
// the V2 single-envelope pattern: a validated online write for the current
// owner adopts or replaces the slot; cross-owner reads fail closed WITHOUT
// deleting (the envelope may belong to another local user — logout,
// revocation, and workspace-switch purges own deletion).

interface V3Envelope {
  schema: 3;
  ownerKey: string;
  offlinePrincipalId: string;
  offlineWorkspaceId: string;
  lastOnlineAuthenticatedAt: string;
  domains: Partial<SnapshotDomains>;
  syncedAt: Partial<Record<DomainKey, string>>;
}

/** Owner args are valid iff a non-empty principal meets a UUID workspace. */
function isValidV3Owner(principalId: unknown, workspaceId: unknown): boolean {
  return (
    typeof principalId === "string" &&
    principalId.length > 0 &&
    isOfflineWorkspaceId(workspaceId)
  );
}

async function readV3Envelope(): Promise<V3Envelope | null> {
  const db = await openSnapshotDb();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      db.close();
      reject(new Error("IndexedDB transaction timed out"));
    }, SNAPSHOT_OPERATION_TIMEOUT_MS);
    const finish = (value: V3Envelope | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(V3_ENVELOPE_KEY);
    req.onsuccess = () => {
      const envelope = req.result as V3Envelope | undefined;
      finish(envelope ?? null);
    };
    req.onerror = () => finish(null);
    tx.oncomplete = () => db.close();
    tx.onerror = () => fail(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => fail(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function writeV3Envelope(env: V3Envelope, isStillValid?: LivenessGuard): Promise<void> {
  const db = await openSnapshotDb();
  // T07a-R2: same commit-open gap as writeV2Envelope — abort before the put.
  if (isStillValid && !isStillValid()) {
    db.close();
    return;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      db.close();
      reject(new Error("IndexedDB transaction timed out"));
    }, SNAPSHOT_OPERATION_TIMEOUT_MS);
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    try {
      store.put(env, V3_ENVELOPE_KEY);
      tx.oncomplete = () => { db.close(); finish(); };
      tx.onerror = () => { db.close(); finish(tx.error); };
      tx.onabort = () => { db.close(); finish(tx.error); };
    } catch (error) {
      db.close();
      finish(error);
    }
  });
}

/** Delete the V3 snapshot slot. Idempotent. */
export async function deleteV3Snapshot(): Promise<void> {
  const db = await openSnapshotDb();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      db.close();
      resolve();
    }, SNAPSHOT_OPERATION_TIMEOUT_MS);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    try {
      store.delete(V3_ENVELOPE_KEY);
      tx.oncomplete = () => { db.close(); finish(); };
      tx.onerror = () => { db.close(); finish(); }; // swallow
      tx.onabort = () => { db.close(); finish(); }; // swallow
    } catch {
      db.close();
      finish();
    }
  });
}

/**
 * Read one domain from the V3 snapshot.
 *
 * Fail-closed: null on kill-switch, invalid owner args, missing/corrupt
 * envelope, owner mismatch, unverifiable age, or expired age. Owner
 * mismatches and expired envelopes are KEPT (another local user's data, or
 * revalidatable after the next online auth); structurally untrusted
 * envelopes (wrong schema, missing age) are invalidated so the next online
 * cycle re-syncs. Storage failures return null WITHOUT deleting.
 */
export async function readV3Snapshot<K extends DomainKey>(
  principalId: string,
  workspaceId: string,
  domain: K,
): Promise<{ data: SnapshotDomains[K]; syncedAt: string } | null> {
  if (!isOfflineSnapshotEnabled()) return null;
  if (!isValidV3Owner(principalId, workspaceId)) return null;
  // T07a state gate: the caller-supplied owner args must match the LIVE
  // offline identity — a revoked/torn-down session (identity cleared
  // synchronously) reads null in the same tick, even with stale args and
  // even when IndexedDB is slow or failing. Never serve, never delete,
  // never re-attribute by heuristic.
  if (
    getOfflinePrincipalId() !== principalId ||
    getOfflineWorkspaceId() !== workspaceId
  ) {
    return null;
  }
  // T07a-R2: capture the generation — revalidated after the envelope read
  // resolves (see below).
  const entryGeneration = getOfflineGeneration();
  try {
    const env = await readV3Envelope();
    // T07a-R2: the envelope read is an awaited gap — a teardown crossing it
    // (including teardown → same-owner re-login, which moves the generation)
    // must not deliver data to the pre-teardown caller. The later purge
    // delete cannot invalidate the already-read object, so delivery itself
    // is gated here.
    if (getOfflineGeneration() !== entryGeneration) return null;
    if (
      getOfflinePrincipalId() !== principalId ||
      getOfflineWorkspaceId() !== workspaceId
    ) {
      return null;
    }
    if (!env || env.schema !== V3_SCHEMA) {
      if (env) await deleteV3Snapshot();
      return null;
    }
    if (
      env.ownerKey !== computeOwnerKey(principalId, workspaceId) ||
      env.offlinePrincipalId !== principalId ||
      env.offlineWorkspaceId !== workspaceId
    ) {
      // Cross-user / cross-workspace miss (INV-04): never serve, never
      // delete, never re-attribute by heuristic.
      return null;
    }
    const lock = evaluateOfflineLock(
      {
        offlineSubjectId: env.offlineWorkspaceId,
        lastOnlineAuthenticatedAt: env.lastOnlineAuthenticatedAt,
      },
      workspaceId,
      Date.now(),
      getMaxOfflineAuthAgeMs(),
    );
    if (lock.state === "locked") return null; // kept for revalidation
    if (lock.state !== "ok") {
      await deleteV3Snapshot();
      return null;
    }
    const data = env.domains[domain];
    const syncedAt = env.syncedAt[domain];
    if (data === undefined || syncedAt === undefined) return null;
    return { data: data as SnapshotDomains[K], syncedAt };
  } catch {
    // Fail closed without deleting: a transient storage failure must not
    // destroy another owner's envelope.
    return null;
  }
}

export interface WriteV3SnapshotOptions {
  /**
   * Override the age stamp (tests / controlled re-stamps). Defaults to
   * now. Invalid values fall back to now — a write is always an
   * online-authenticated moment, so the stamp must exist.
   */
  lastOnlineAuthenticatedAt?: string;
}

/** Build a fresh V3 envelope base stamped with owner + age. */
function freshV3Envelope(
  principalId: string,
  workspaceId: string,
  authenticatedAt: string,
): V3Envelope {
  return {
    schema: V3_SCHEMA,
    ownerKey: computeOwnerKey(principalId, workspaceId),
    offlinePrincipalId: principalId,
    offlineWorkspaceId: workspaceId,
    lastOnlineAuthenticatedAt: authenticatedAt,
    domains: {},
    syncedAt: {},
  };
}

/**
 * Write one domain to the V3 snapshot.
 *
 * The caller MUST have validated the session online and MUST know the
 * current owner: invalid owner args throw (fail-closed loud) so an
 * unattributable snapshot can never be persisted. Adopt-or-replace runs
 * serialized with the V2 write chain (shared read-modify-write lock).
 */
export async function writeV3Snapshot<K extends DomainKey>(
  principalId: string,
  workspaceId: string,
  domain: K,
  data: SnapshotDomains[K],
  opts?: WriteV3SnapshotOptions,
): Promise<void> {
  if (!isOfflineSnapshotEnabled()) return;
  if (!isValidV3Owner(principalId, workspaceId)) {
    throw new Error("offline V3 write requires a validated principal + workspace");
  }
  // T07a stale-write guard: the owner args must match the LIVE offline
  // identity both at entry and inside the serialized lock — a write spanning
  // (or starting after) a revocation/teardown is dropped, never reviving
  // snapshot data under a torn-down session. The generation covers the gap
  // the identity check cannot (re-bind with identical args after the
  // teardown): equality holds only for work that never crossed a teardown.
  const entryGeneration = getOfflineGeneration();
  if (
    getOfflinePrincipalId() !== principalId ||
    getOfflineWorkspaceId() !== workspaceId
  ) {
    return;
  }
  // T07a-R2 liveness guard: re-checked after EVERY awaited step below — a
  // teardown crossing any gap aborts the write before anything hits disk.
  const stillValid = (): boolean =>
    getOfflineGeneration() === entryGeneration &&
    getOfflinePrincipalId() === principalId &&
    getOfflineWorkspaceId() === workspaceId;
  const authenticatedAt = resolveAuthenticatedAt(opts?.lastOnlineAuthenticatedAt);
  const ownerKey = computeOwnerKey(principalId, workspaceId);
  await withWriteLock(async () => {
    if (getOfflineGeneration() !== entryGeneration) return;
    if (
      getOfflinePrincipalId() !== principalId ||
      getOfflineWorkspaceId() !== workspaceId
    ) {
      return;
    }
    const existing = await readV3Envelope();
    // T07a-R2: the envelope read is an awaited gap — revalidate before the
    // put. A teardown (or same-owner re-bind of a newer generation) landing
    // here aborts the stale write.
    if (!stillValid()) return;
    const sameOwner =
      existing !== null &&
      existing.schema === V3_SCHEMA &&
      existing.ownerKey === ownerKey &&
      existing.offlinePrincipalId === principalId &&
      existing.offlineWorkspaceId === workspaceId;
    const base: V3Envelope = sameOwner
      ? existing
      : freshV3Envelope(principalId, workspaceId, authenticatedAt);
    // An adopted envelope is refreshed because this write is an
    // online-authenticated moment.
    base.lastOnlineAuthenticatedAt = authenticatedAt;
    base.domains[domain] = data;
    base.syncedAt[domain] = new Date().toISOString();
    await writeV3Envelope(base, stillValid);
  });
}

export type V2ToV3MigrationReason =
  | "migrated"
  | "no-owner"
  | "disabled"
  | "no-source"
  | "legacy-envelope"
  | "subject-mismatch"
  | "expired-source"
  | "error";

export interface V2ToV3MigrationOptions {
  /** V2 owner key (token-derived fingerprint source). */
  token: string;
  /** Validated online session identity (AUTH-02). */
  principalId: string;
  /** Known current workspace (AUTH-02). */
  workspaceId: string;
}

/**
 * Migrate a V2 envelope into V3 (AUTH-03).
 *
 * Preconditions (caller contract — the session was validated online and
 * the current owner is known): the V2 envelope must be safely readable
 * (same token fingerprint) AND attributable (subject partition equals the
 * current workspace). Otherwise the V2 is left alone (another owner's
 * data) or invalidated (legacy, untrustworthy) and the next online cycle
 * re-syncs. Never assigns an old snapshot by heuristic.
 */
export async function migrateV2toV3(
  options: V2ToV3MigrationOptions,
): Promise<{ migrated: boolean; reason: V2ToV3MigrationReason }> {
  const { token, principalId, workspaceId } = options;
  if (!isValidV3Owner(principalId, workspaceId)) {
    return { migrated: false, reason: "no-owner" };
  }
  if (!isOfflineSnapshotEnabled()) return { migrated: false, reason: "disabled" };
  try {
    const entryGeneration = getOfflineGeneration();
    // T07a-R2 liveness guard: the migration targets identity-scoped data —
    // re-checked after EVERY awaited step below.
    const stillValid = (): boolean =>
      getOfflineGeneration() === entryGeneration &&
      getOfflinePrincipalId() === principalId &&
      getOfflineWorkspaceId() === workspaceId;
    const fp = await fingerprint(token);
    // T07a-R2: the fingerprint is an awaited gap — a teardown crossing it
    // aborts before any IndexedDB access.
    if (!stillValid()) return { migrated: false, reason: "error" };
    const v2 = await readV2Envelope();
    // T07a-R2: the envelope read is an awaited gap — revalidate before
    // trusting the source.
    if (!stillValid()) return { migrated: false, reason: "error" };
    if (!v2 || v2.schema !== 2 || v2.ownerFingerprint !== fp) {
      return { migrated: false, reason: "no-source" };
    }
    if (
      typeof v2.offlineSubjectId !== "string" ||
      v2.offlineSubjectId.length === 0
    ) {
      // Legacy envelope: unattributable by construction — invalidate,
      // re-sync online (mirrors the V2 read path).
      await deleteV2Snapshot();
      return { migrated: false, reason: "legacy-envelope" };
    }
    if (v2.offlineSubjectId !== workspaceId) {
      // Attributable to a DIFFERENT workspace: keep it for its rightful
      // owner, migrate nothing.
      return { migrated: false, reason: "subject-mismatch" };
    }
    // The V2 source must itself be trustworthy (attributable + within TTL):
    // migrating an expired/unverifiable V2 under a fresh stamp would extend
    // trust it never earned. Untrusted sources are invalidated (deleted) so
    // the next online cycle re-syncs.
    const v2lock = evaluateOfflineLock(
      {
        offlineSubjectId: v2.offlineSubjectId,
        lastOnlineAuthenticatedAt: v2.lastOnlineAuthenticatedAt,
      },
      workspaceId,
      Date.now(),
      getMaxOfflineAuthAgeMs(),
    );
    if (v2lock.state !== "ok") {
      await deleteV2Snapshot();
      return {
        migrated: false,
        reason: v2lock.state === "locked" ? "expired-source" : "legacy-envelope",
      };
    }
    const authenticatedAt = new Date().toISOString();
    const ownerKey = computeOwnerKey(principalId, workspaceId);
    // Tracks whether the guarded commit below actually landed: a teardown
    // aborting inside the lock must report "not applied" and keep the V2
    // source, never claim a migration that never hit disk.
    let applied = false;
    await withWriteLock(async () => {
      // A teardown landing anywhere in the gaps above drops the migration.
      if (!stillValid()) return;
      const existing = await readV3Envelope();
      // T07a-R2: revalidate after the envelope read, before the put.
      if (!stillValid()) return;
      const sameOwner =
        existing !== null &&
        existing.schema === V3_SCHEMA &&
        existing.ownerKey === ownerKey;
      const base: V3Envelope = sameOwner
        ? existing
        : freshV3Envelope(principalId, workspaceId, authenticatedAt);
      // Backfill ONLY: V3 (written by live online syncs) always wins over
      // the V2 source — migration fills domains V3 lacks, never overwrites.
      for (const domain of Object.keys(v2.domains) as DomainKey[]) {
        if (!(domain in base.domains)) {
          base.domains[domain] = v2.domains[domain] as never;
          base.syncedAt[domain] =
            v2.syncedAt[domain] ?? new Date().toISOString();
        }
      }
      base.lastOnlineAuthenticatedAt = authenticatedAt;
      await writeV3Envelope(base, stillValid);
      // The guarded put may have aborted on a teardown that landed inside
      // the commit open — only claim the migration when still live.
      applied = stillValid();
    });
    if (!applied) return { migrated: false, reason: "error" };
    await deleteV2Snapshot();
    return { migrated: true, reason: "migrated" };
  } catch {
    return { migrated: false, reason: "error" };
  }
}

/**
 * Evaluate the V3 offline lock with live clock and call-time max age.
 * Never throws: storage failures report "empty" (fail-closed at the
 * reader, which treats non-ok as no data).
 */
export async function getV3OfflineLockState(
  principalId: string,
  workspaceId: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = getMaxOfflineAuthAgeMs(),
): Promise<OfflineLockState> {
  if (!isOfflineSnapshotEnabled()) return { state: "empty" };
  if (!isValidV3Owner(principalId, workspaceId)) {
    return { state: "locked", reason: "no-subject" };
  }
  try {
    const env = await readV3Envelope();
    if (!env || env.schema !== V3_SCHEMA) return { state: "empty" };
    if (
      env.ownerKey !== computeOwnerKey(principalId, workspaceId) ||
      env.offlinePrincipalId !== principalId ||
      env.offlineWorkspaceId !== workspaceId
    ) {
      return { state: "untrusted", reason: "subject-mismatch" };
    }
    return evaluateOfflineLock(
      {
        offlineSubjectId: env.offlineWorkspaceId,
        lastOnlineAuthenticatedAt: env.lastOnlineAuthenticatedAt,
      },
      workspaceId,
      nowMs,
      maxAgeMs,
    );
  } catch {
    return { state: "empty" };
  }
}

export type UnreachableOfflineRoute = "offline-read-only" | "login";

/**
 * Offline routing for an unreachable session probe (AUTH-04, INV-05):
 * valid V3 ownership + age within TTL → offline read-only (INV-06: reads
 * only, no write queue exists); anything else → the offline/login screen.
 * NEVER purges here — unreachability is not a rejection, so the caller
 * must not destroy the session on this path (no false logout).
 */
export async function resolveUnreachableOfflineRoute(
  principalId: string | null,
  workspaceId: string | null,
  nowMs: number = Date.now(),
  maxAgeMs: number = getMaxOfflineAuthAgeMs(),
): Promise<UnreachableOfflineRoute> {
  if (!isOfflineSnapshotEnabled()) return "login";
  if (
    principalId === null ||
    workspaceId === null ||
    !isValidV3Owner(principalId, workspaceId)
  ) {
    return "login";
  }
  const lock = await getV3OfflineLockState(principalId, workspaceId, nowMs, maxAgeMs);
  return lock.state === "ok" ? "offline-read-only" : "login";
}
