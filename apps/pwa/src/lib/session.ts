/**
 * Clear sensitive session data on logout / 401 expiry.
 *
 * Each store (token, v1 localStorage snapshot, profile, in-memory state,
 * v2 IndexedDB snapshot) is attempted independently. A failure in one store
 * never aborts the others, every attempt is awaited, and no rejection can
 * escape (logout must never throw or leave an unhandled rejection).
 *
 * Granular flags allow selective cleanup:
 * - `clearToken` removes the auth token from localStorage.
 * - `clearV1Snapshot` removes the v1 offline snapshot AND v2 (IndexedDB) snapshot.
 * - `clearProfile` removes the persisted profile.
 * - `clearMemory` is a callback to reset in-memory state (set state to initial values).
 *
 * Idempotent: calling multiple times is safe.
 * Does NOT touch Cache Storage (static app-shell caches intentionally remain).
 */

import { clearToken, clearSessionToken } from "@/lib/auth/token-store";
import { clearOfflineSubjectId } from "@/lib/auth/offline-subject";
import {
  clearOfflineIdentity,
  clearOfflineWorkspaceBinding,
} from "@/lib/auth/offline-identity";
import { clearActiveWorkspacePreference } from "@/lib/auth/active-workspace-preference";
import { deleteV2Snapshot, deleteV3Snapshot } from "@/lib/state/snapshot-db";
import { clearActiveWorkspaceId } from "@/lib/api/client";
import { clearAgentSession } from "@/lib/api/agent-auth";

const SNAPSHOT_KEY = "pi-finance:snapshot:v1";
const PROFILE_KEY = "pi-finance:profile";

/**
 * Last online-authenticated instant (V4 T2.6, SPEC §10 D1, ADR-015).
 *
 * ISO instant persisted at every online-authenticated moment (login,
 * refresh, successful authenticated bootstrap) and consumed by the offline
 * age check (`MAX_OFFLINE_AUTH_AGE`): `now - lastOnlineAuthenticatedAt`
 * beyond the limit locks the offline session. Writes offline stay
 * prohibited regardless. Opaque timestamp, never a credential.
 */
export const LAST_ONLINE_AUTH_STORAGE_KEY = "pi-finance:last-online-authenticated-at";

/** Stamp the last online-authenticated instant (defaults to now). Fail-closed: invalid instants are refused without writing. */
export function stampLastOnlineAuthenticatedAt(isoNow?: string): boolean {
  const at = isoNow ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) return false;
  try {
    localStorage.setItem(LAST_ONLINE_AUTH_STORAGE_KEY, at);
    return true;
  } catch {
    return false;
  }
}

/** Read the stamped instant; null when absent or corrupt (no implicit trust). */
export function getLastOnlineAuthenticatedAt(): string | null {
  try {
    const raw = localStorage.getItem(LAST_ONLINE_AUTH_STORAGE_KEY);
    if (!raw) return null;
    return Number.isNaN(Date.parse(raw)) ? null : raw;
  } catch {
    return null;
  }
}

export function clearLastOnlineAuthenticatedAt(): void {
  try {
    localStorage.removeItem(LAST_ONLINE_AUTH_STORAGE_KEY);
  } catch {
    /* noop */
  }
}

export interface ClearSessionOptions {
  clearToken?: boolean;
  clearV1Snapshot?: boolean;
  clearProfile?: boolean;
  /**
   * Full offline-identity teardown (logout / 401 / 403 revocation —
   * AUTH-T04/05/06): principal + workspace binding + subject partition.
   * Pair with clearToken + clearV1Snapshot for a complete logout purge.
   */
  clearOfflineIdentity?: boolean;
  /**
   * Workspace-side teardown (workspace switch — AUTH-T07): workspace
   * binding + subject partition + age stamp are cleared while the user
   * principal survives for rebinding. Pair with clearV1Snapshot (which
   * also deletes V3) so workspace X data can never appear as workspace Y.
   */
  clearWorkspaceBinding?: boolean;
  /** Callback to reset in-memory state (e.g. set states to initial values). */
  clearMemory?: () => void;
}

/**
 * Clear sensitive session data.
 * Each store is attempted independently; all are awaited; no rejection escapes.
 * All flags default to `false` — opt-in per call.
 */
export async function clearSensitiveSession(
  options: ClearSessionOptions,
): Promise<void> {
  const {
    clearToken: doToken = false,
    clearV1Snapshot: doSnapshot = false,
    clearProfile: doProfile = false,
    clearOfflineIdentity: doOfflineIdentity = false,
    clearWorkspaceBinding: doWorkspaceBinding = false,
    clearMemory,
  } = options;

  // Independent tasks — each isolated so one store's failure cannot abort
  // cleanup of the others. Every task is awaited via allSettled below.
  const tasks: Promise<void>[] = [];

  if (doToken) {
    tasks.push(
      Promise.resolve().then(() => { try { clearToken(); } catch { /* noop */ } }),
    );
    tasks.push(
      Promise.resolve().then(() => { try { clearSessionToken(); } catch { /* noop */ } }),
    );
    tasks.push(
      Promise.resolve().then(() => { try { localStorage.removeItem("pi-finance:session-token"); } catch { /* noop */ } }),
    );
    tasks.push(
      Promise.resolve().then(() => { try { clearActiveWorkspaceId(); } catch { /* noop */ } }),
    );
    // T2.2 B4: logout com limpeza de token também limpa o offlineSubjectId
    // (a repartição offline cai junto com a sessão; T2.6 detalha o lock).
    // Troca de workspace (sem clearToken) preserva o subject até o re-set.
    tasks.push(
      Promise.resolve().then(() => { try { clearOfflineSubjectId(); } catch { /* noop */ } }),
    );
    // T2.6 D1: o carimbo de última autenticação online cai junto — sem ele,
    // qualquer snapshot residual seria avaliado contra idade ausente
    // (não-confiável) em vez de parecer válido.
    tasks.push(
      Promise.resolve().then(() => { try { clearLastOnlineAuthenticatedAt(); } catch { /* noop */ } }),
    );
  }
  if (doSnapshot) {
    tasks.push(
      Promise.resolve().then(() => {
        try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* noop */ }
      }),
    );
  }
  if (doProfile) {
    tasks.push(
      Promise.resolve().then(() => {
        try { localStorage.removeItem(PROFILE_KEY); } catch { /* noop */ }
      }),
    );
  }
  // Phase 3 (AUTH-T06/T07): explicit offline-identity teardown per case.
  // Logout/revocation clears principal + workspace + subject; workspace
  // switch clears the workspace side (binding + subject + stamp) while the
  // user principal survives for rebinding.
  if (doOfflineIdentity) {
    tasks.push(
      Promise.resolve().then(() => { try { clearOfflineIdentity(); } catch { /* noop */ } }),
    );
    tasks.push(
      Promise.resolve().then(() => { try { clearLastOnlineAuthenticatedAt(); } catch { /* noop */ } }),
    );
    // The active-workspace preference is bound to the principal being torn
    // down — a later login (possibly another user on a shared device) must
    // never remount on the previous session's workspace.
    tasks.push(
      Promise.resolve().then(() => { try { clearActiveWorkspacePreference(); } catch { /* noop */ } }),
    );
  }
  if (doWorkspaceBinding) {
    // Workspace-switch teardown ordering guarantee (AUTH-T07 race review):
    // these localStorage clears are queued as microtasks AT CALL TIME, so
    // they always complete before any LATER task (e.g. B's login/binding)
    // can run — a B binding written after this call starts can never be
    // clobbered by it. The only deferred work below is the IndexedDB
    // snapshot deletes, which never touch localStorage keys; and this path
    // never touches the principal-bound active-workspace preference, so B's
    // fresh preference survives unconditionally. Callers additionally guard
    // every post-purge write with a generation + principal check, so even a
    // principal switch landing mid-purge commits nothing under the new
    // principal. Covered by `workspace-stale-load` (deferred-IDB + B
    // binding test).
    tasks.push(
      Promise.resolve().then(() => { try { clearOfflineWorkspaceBinding(); } catch { /* noop */ } }),
    );
    tasks.push(
      Promise.resolve().then(() => { try { clearLastOnlineAuthenticatedAt(); } catch { /* noop */ } }),
    );
  }
  if (clearMemory) {
    tasks.push(
      Promise.resolve().then(() => { try { clearMemory(); } catch { /* noop */ } }),
    );
  }
  if (doSnapshot) {
    // v2 IndexedDB snapshot — independent of the v1 localStorage delete above.
    // IDB NON-BLOCKER (reviewed): V2/V3 deletes use fixed slots, so a
    // deferred purge racing a later login as B may delete B's freshly
    // written cache (resync loss only — slots are never cross-user readable,
    // so no cross-data leak). Never claim the purged snapshot survives.
    tasks.push(deleteV2Snapshot().catch(() => { /* noop */ }));
    // Phase 3: the snapshot purge always includes the V3 slot, so a
    // workspace switch or logout can never leave identity-keyed data behind.
    tasks.push(deleteV3Snapshot().catch(() => { /* noop */ }));
  }

  // H-13: THE central agent cleanup — cache + every in-flight agent
  // connection, unconditional. Any session cleanup may imply a context
  // change (logout, 401, user switch, workspace switch, unmount), and the
  // bearer is cheap to re-mint (single-use per call). This single call site
  // is the whole contract: no caller needs its own agent cleanup.
  tasks.push(
    Promise.resolve().then(() => { try { clearAgentSession(); } catch { /* noop */ } }),
  );

  // Await every attempt. allSettled guarantees no rejection escapes even if a
  // store fails, and all stores are attempted regardless of earlier failures.
  await Promise.allSettled(tasks);
}
