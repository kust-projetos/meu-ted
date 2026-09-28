/**
 * Active workspace preference (cross-workspace write guard).
 *
 * The active workspace id is an opaque, NON-SECRET UUID (never a credential
 * or authority): it only records which workspace the user last selected so a
 * full reload remounts the provider on the same workspace instead of falling
 * back to the first one. The server-side `fetchWorkspaces()` list stays the
 * sole authority — a stored id is honored ONLY when it is still present and
 * non-archived in that list.
 *
 * Cross-user exposure is prevented by binding the entry to the
 * server-confirmed principal (`offline-principal`, written by AuthGate from
 * the session probe): a read returns the workspace id ONLY when the stored
 * principal matches the current one. The entry is wiped on full identity
 * teardown (logout / 401 / 403 revocation) alongside the offline identity.
 */

export const ACTIVE_WORKSPACE_PREFERENCE_STORAGE_KEY =
  "pi-finance:active-workspace-preference";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredPreference {
  principalId: string;
  workspaceId: string;
}

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

/**
 * Read the stored workspace id, but ONLY when it is bound to
 * `currentPrincipalId`. Returns null when absent, corrupt, bound to another
 * principal, or not a UUID (fail-closed).
 */
export function readActiveWorkspacePreference(
  currentPrincipalId: string | null | undefined,
): string | null {
  if (!isPrincipalId(currentPrincipalId)) return null;
  try {
    const raw = getStorage()?.getItem(ACTIVE_WORKSPACE_PREFERENCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { principalId, workspaceId } = parsed as Partial<StoredPreference>;
    if (principalId !== currentPrincipalId) return null;
    return isWorkspaceId(workspaceId) ? (workspaceId as string) : null;
  } catch {
    return null;
  }
}

/**
 * Persist the active workspace for `principalId`. Fail-closed: refuses
 * empty principals and non-UUID workspace ids without writing.
 */
export function writeActiveWorkspacePreference(
  principalId: string,
  workspaceId: string,
): boolean {
  if (!isPrincipalId(principalId) || !isWorkspaceId(workspaceId)) return false;
  try {
    const stored: StoredPreference = { principalId, workspaceId };
    getStorage()?.setItem(
      ACTIVE_WORKSPACE_PREFERENCE_STORAGE_KEY,
      JSON.stringify(stored),
    );
    return true;
  } catch {
    return false;
  }
}

/** Remove the stored preference (logout / revocation / no workspace). */
export function clearActiveWorkspacePreference(): void {
  try {
    getStorage()?.removeItem(ACTIVE_WORKSPACE_PREFERENCE_STORAGE_KEY);
  } catch {
    /* noop */
  }
}
