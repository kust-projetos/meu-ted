/**
 * Offline identity (V4.1 Closure Phase 3, AUTH-02 / INV-03 / INV-04).
 *
 * Non-authenticator identifiers persisted ONLY after a server-confirmed
 * online authentication (callers bind from the session probe identity —
 * `session.user` — never from a bearer, device secret, or cookie value):
 *
 * ```text
 * offlinePrincipalId = authenticated user identity (opaque, non-secret)
 * offlineWorkspaceId = active workspace UUID (opaque, non-secret)
 * ownerKey           = "v3" + principal + workspace (the V3 snapshot key)
 * ```
 *
 * These identifiers grant nothing: they never reach the API, never act as
 * a bearer, and never authenticate. They only partition the offline
 * snapshot cache (INV-04: user A / workspace X is unreadable as B or Y).
 * Removed on logout/revocation; rebound (workspace side) on workspace
 * switch (AUTH-T06/T07).
 */

export const OFFLINE_PRINCIPAL_STORAGE_KEY = "pi-finance:offline-principal";
export const OFFLINE_WORKSPACE_STORAGE_KEY = "pi-finance:offline-workspace";

import { clearOfflineSubjectId } from "@/lib/auth/offline-subject";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof globalThis !== "undefined" && (globalThis as { localStorage?: Storage }).localStorage) {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  }
  return null;
}

function isPrincipalId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/** Public validator: workspace bindings accept UUIDs only. */
export function isOfflineWorkspaceId(value: unknown): value is string {
  return isWorkspaceId(value);
}

/** Authenticated user identity bound for offline partitioning; null when absent. */
export function getOfflinePrincipalId(): string | null {
  try {
    const raw = getStorage()?.getItem(OFFLINE_PRINCIPAL_STORAGE_KEY);
    return isPrincipalId(raw) ? (raw as string) : null;
  } catch {
    return null;
  }
}

/**
 * Persist the server-confirmed user identity. Fail-closed: empty values are
 * refused without writing. Call ONLY after a valid online authentication.
 */
export function setOfflinePrincipalId(principalId: string): boolean {
  if (!isPrincipalId(principalId)) return false;
  try {
    getStorage()?.setItem(OFFLINE_PRINCIPAL_STORAGE_KEY, principalId);
    return true;
  } catch {
    return false;
  }
}

/** Active workspace bound for offline partitioning; null when absent/invalid. */
export function getOfflineWorkspaceId(): string | null {
  try {
    const raw = getStorage()?.getItem(OFFLINE_WORKSPACE_STORAGE_KEY);
    return isWorkspaceId(raw) ? (raw as string) : null;
  } catch {
    return null;
  }
}

/**
 * Persist the active workspace binding. Accepts ONLY UUIDs (fail-closed).
 * Called from the workspace choke point after valid auth — never from a
 * credential.
 */
export function setOfflineWorkspaceId(workspaceId: string): boolean {
  if (!isWorkspaceId(workspaceId)) return false;
  try {
    getStorage()?.setItem(OFFLINE_WORKSPACE_STORAGE_KEY, workspaceId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind both sides of the offline identity at once. Returns true only when
 * both persisted. Call ONLY after a valid online authentication.
 */
export function bindOfflineIdentity(principalId: string, workspaceId: string): boolean {
  if (!isPrincipalId(principalId) || !isWorkspaceId(workspaceId)) return false;
  const principalOk = setOfflinePrincipalId(principalId);
  const workspaceOk = setOfflineWorkspaceId(workspaceId);
  // T07a-R2: a fresh online-authenticated binding starts a new generation —
  // work suspended across a teardown → re-bind boundary never validates
  // against the pre-teardown generation, even for the same owner.
  if (principalOk && workspaceOk) advanceOfflineGeneration();
  return principalOk && workspaceOk;
}

/**
 * Logical V3 owner key: version + principal + workspace. Plain
 * concatenation is sufficient — both parts are opaque non-secrets, and the
 * key must be computable synchronously on every read. (SPEC AUTH-02
 * permits a SHA-256 derivation instead; raw parts are equally non-secret.)
 */
export function computeOwnerKey(principalId: string, workspaceId: string): string {
  return `v3:${principalId}:${workspaceId}`;
}

// ── Offline generation gate (T07a) ────────────────────────────────────
// Monotonic in-memory generation bumped synchronously on every teardown
// entry (authoritative revocation, logout, principal/workspace switch).
// Snapshot read/write paths consult synchronous identity state plus this
// generation, so a teardown takes effect in the same tick — never
// storage-dependent. There is intentionally no reset: fresh post-teardown
// work captures the current generation at entry, so equality checks pass
// for legitimate new work and fail only for work that spanned a teardown.
// A process reload resets the counter alongside all in-memory state (the
// persisted identity itself keeps gating reads).
let offlineGeneration = 0;

/** Current offline generation (monotonic; in-memory only, never persisted). */
export function getOfflineGeneration(): number {
  return offlineGeneration;
}

/**
 * Advance the generation. Called synchronously at teardown entry so that
 * any snapshot write already in flight is stale by the time it resumes.
 */
export function advanceOfflineGeneration(): void {
  offlineGeneration += 1;
}

/**
 * Authoritative-revocation teardown (T07a): bump the generation and clear
 * the offline identity (principal + workspace binding + subject partition)
 * SYNCHRONOUSLY, so subsequent reads fail closed in the same tick even when
 * IndexedDB is slow or failing. Snapshots (V2/V3) and the age stamp are
 * purged by the caller's canonical session cleanup alongside this.
 */
export function noteAuthoritativeRevocation(): void {
  advanceOfflineGeneration();
  clearOfflineIdentity();
}

/**
 * Full identity teardown (logout / 401 / 403 revocation — AUTH-T04/05/06):
 * principal + workspace binding + subject partition. The age stamp and
 * snapshots are cleared by the caller's session cleanup alongside this.
 */
export function clearOfflineIdentity(): void {
  try {
    getStorage()?.removeItem(OFFLINE_PRINCIPAL_STORAGE_KEY);
  } catch {
    /* noop */
  }
  clearOfflineWorkspaceBinding();
}

/**
 * Workspace-side teardown (workspace switch — AUTH-T07): the workspace
 * binding + subject partition are cleared while the user principal
 * survives for rebinding. The caller also purges the snapshot and the age
 * stamp so workspace X data can never appear as workspace Y.
 */
export function clearOfflineWorkspaceBinding(): void {
  try {
    getStorage()?.removeItem(OFFLINE_WORKSPACE_STORAGE_KEY);
  } catch {
    /* noop */
  }
  try {
    clearOfflineSubjectId();
  } catch {
    /* noop */
  }
}
