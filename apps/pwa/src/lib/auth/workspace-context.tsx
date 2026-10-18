"use client";

import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isApiConfigured, clearActiveWorkspaceId, setActiveWorkspaceId, ApiError } from "@/lib/api/client";
import { clearSensitiveSession } from "@/lib/session";
import { closeAllSockets } from "./socket-registry";
import {
  clearActiveWorkspacePreference,
  readActiveWorkspacePreference,
  writeActiveWorkspacePreference,
} from "./active-workspace-preference";
import { getOfflinePrincipalId, getOfflineWorkspaceId, clearOfflineWorkspaceBinding } from "./offline-identity";
import { getSessionStatus } from "./session-authority";
import { useSession } from "./session-context";
import { getV3OfflineLockState } from "@/lib/state/snapshot-db";
import {
  acceptOwnershipTransfer,
  acceptWorkspaceInvite,
  createOwnershipTransfer,
  createWorkspace as createWorkspaceRequest,
  createWorkspaceInvite,
  fetchOwnershipTransfers,
  fetchPendingInvites,
  fetchWorkspaceMembers,
  fetchWorkspaces,
  leaveWorkspace,
  removeWorkspaceMember,
  renameWorkspace as renameWorkspaceRequest,
  resendWorkspaceInvite,
  revokeWorkspaceInvite,
  archiveWorkspace as archiveWorkspaceRequest,
  restoreWorkspace as restoreWorkspaceRequest,
  fetchDeletionInventory as fetchDeletionInventoryRequest,
  deleteWorkspace as deleteWorkspaceRequest,
  type EmptyDeposit,
  type DeleteConfirmationInput,
  type DeletionInventory,
  type DeleteReceipt,
  type OwnershipTransfer,
  type PendingInvite,
  type Workspace,
  type WorkspaceMember,
} from "@/lib/api/workspaces";
import { requestAgentEmptyAttestation as requestAgentEmptyAttestationRequest } from "@/lib/api/agent-client";
import { isMembershipRevocation } from "./auth-state-machine";

/**
 * FIX-168 (P0 #168): falha de auth/membership ESTRITA — só o que prova
 * sessão morta ou membership revogado limpa header/binding e sinaliza
 * `isAuthError`:
 * - 401 qualquer code (sessão expirada/inválida — contrato inalterado);
 * - 403 SOMENTE com o code de revogação do allowlist
 *   (auth.workspace_forbidden — sem membership ativo).
 *
 * Todo outro 403 — auth.workspace_required (header ausente após
 * archive/clear), permission/scope denials, 403 sem code — NÃO é falha de
 * auth: a sessão pode seguir válida e a seleção anterior confirmada deve
 * ser preservada. Tratar qualquer 403 como logout era o multiplicador dos
 * 403 em massa (#168): um 403 stale virava purge+login indevidos.
 */
function getFailureStatus(cause: unknown): number | undefined {
  if (cause instanceof ApiError) return cause.status;
  if (cause && typeof cause === "object" && "status" in cause) {
    const status = (cause as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function getFailureCode(cause: unknown): string | undefined {
  if (cause instanceof ApiError) {
    return cause.code.length > 0 ? cause.code : undefined;
  }
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : undefined;
  }
  return undefined;
}

function isAuthFailure(cause: unknown): boolean {
  const status = getFailureStatus(cause);
  if (status === 401) return true;
  if (status === 403) {
    return isMembershipRevocation(status, getFailureCode(cause));
  }
  if (cause instanceof Error) {
    const msg = cause.message.toLowerCase();
    // Sem status: só sinais 401-like ou o literal de revogação contam.
    // "forbidden"/"403"/"auth." genéricos NÃO — sem code não há como
    // distinguir revogação real de header stale (FIX-168).
    if (msg.includes("auth.workspace_forbidden")) return true;
    return (
      msg.includes("token inválido") ||
      msg.includes("token invalido") ||
      msg.includes("unauthorized") ||
      msg.includes("não autorizado") ||
      msg.includes("nao autorizado") ||
      msg.includes("sessão expirada") ||
      msg.includes("sessao expirada") ||
      msg.includes("401")
    );
  }
  return false;
}

const MOCK_DEFAULT_WORKSPACE: Workspace = {
  id: "mock-workspace",
  name: "Minhas Finanças",
  kind: "personal",
  role: "owner",
  status: "active",
};

export interface WorkspaceContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  members: WorkspaceMember[];
  pendingInvites: PendingInvite[];
  ownershipTransfers: OwnershipTransfer[];
  loading: boolean;
  membersLoading: boolean;
  pendingInvitesLoading: boolean;
  ownershipTransfersLoading: boolean;
  error: string | null;
  isAuthError?: boolean;
  /**
   * T07c — explicit offline workspace state. `isOfflineReadOnly` is true
   * only when a load failed on the network while the session authority is
   * `unreachable` AND the V3 envelope for the bound (principal, workspace)
   * identity is valid and within TTL: reads stay restricted to the linked
   * workspace, mutations stay closed until a server revalidation.
   * `offlineWorkspaceId` is the linkage UUID only — membership, role, and
   * status are never synthesized from a locally stored id. When offline
   * reads are closed, `offlineBlockedReason` names the explicit blocked
   * cause instead of a silent read-heavy fallback.
   */
  isOfflineReadOnly: boolean;
  offlineWorkspaceId: string | null;
  offlineBlockedReason: OfflineWorkspaceBlockReason | null;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  refreshPendingInvites: () => Promise<void>;
  refreshOwnershipTransfers: () => Promise<void>;
  createWorkspace: (input: { name: string; kind: "personal" | "shared" }) => Promise<Workspace>;
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  restoreWorkspace: (workspaceId: string) => Promise<void>;
  fetchDeletionInventory: (workspaceId: string) => Promise<DeletionInventory>;
  /**
   * FIX-WS-D2-R4 — prova HMAC de vazio do lado Agent (passo 2 do fluxo:
   * inventário PG → atestação Agent → delete API). O PWA só transporta.
   */
  requestAgentEmptyAttestation: (workspaceId: string, inventoryVersion: string) => Promise<EmptyDeposit>;
  deleteWorkspace: (workspaceId: string, confirmation: DeleteConfirmationInput) => Promise<DeleteReceipt>;
  inviteMember: (email: string) => Promise<void>;
  resendInvite: (inviteId: string) => Promise<void>;
  revokeInvite: (inviteId: string) => Promise<void>;
  acceptInvite: (token: string) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  transferOwnership: (toUserId: string) => Promise<void>;
  acceptTransfer: (transferId: string) => Promise<void>;
  leave: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Resolve which workspace becomes active after a (re)load.
 *
 * D1 (ADR-027) deterministic fallback: the server lists workspaces ordered
 * by (active first, personal before shared, created_at, id), i.e. oldest
 * active personal → oldest active shared → id. Priority here: the in-memory
 * selection (same-mount switches/refreshes) → the persisted preference,
 * honored ONLY when still present and non-archived in the server-side list
 * (the list is the authority; principal-bound, never cross-user) → the
 * first non-archived workspace of the D1-ordered list. The caller persists
 * the outcome so a stale stored id is overwritten by the fallback. Writes
 * never resolve silently: every financial/device path requires an explicit
 * x-workspace-id header (auth.workspace_required without it).
 */
function resolveActiveWorkspaceId(
  list: Workspace[],
  current: string | undefined,
  principalId: string | null,
): string | undefined {
  // D2: `archived` e `deleted` nunca viram ativo. Status ausente conta
  // como elegível (o schema defaultea para active em payloads legados).
  const eligible = (id: string | null | undefined): id is string =>
    typeof id === "string" &&
    list.some((workspace) => workspace.id === id && workspace.status !== "archived" && workspace.status !== "deleted");
  if (eligible(current)) return current;
  const stored = principalId ? readActiveWorkspacePreference(principalId) : null;
  if (eligible(stored)) return stored;
  return list.find((workspace) => workspace.status !== "archived" && workspace.status !== "deleted")?.id;
}

/**
 * Persist the resolved active workspace bound to the current principal.
 * No-op without a principal (fail-closed: never store a UUID for an
 * unknown user); clears the entry when there is no active workspace.
 */
function persistActiveWorkspacePreference(workspaceId: string | undefined): void {
  try {
    const principalId = getOfflinePrincipalId();
    if (!principalId) return;
    if (workspaceId) writeActiveWorkspacePreference(principalId, workspaceId);
    else clearActiveWorkspacePreference();
  } catch {
    /* noop */
  }
}

/**
 * T07c — explicit blocked causes for the offline workspace route. `revoked`
 * is the single server-confirmed membership revocation
 * (403 auth.workspace_forbidden, T07a semantics); the offline lock states
 * map to `no-binding` (no usable identity linkage), `no-snapshot` (nothing
 * readable for this binding), and `expired` (a stale envelope, never data).
 */
export type OfflineWorkspaceBlockReason =
  | "no-binding"
  | "no-snapshot"
  | "expired"
  | "revoked";

/**
 * Explicit offline copy: announces the linked-workspace read-only state
 * without mimicking any auth signal (it must never contain the literals
 * WorkspaceSwitcher classifies as authorization errors).
 */
export const OFFLINE_WORKSPACE_READONLY_MESSAGE =
  "Sem conexão — dados locais do workspace vinculado (somente leitura).";

/**
 * Evaluate the offline workspace route for the current session authority
 * and bound identity. Returns null when the offline route does not apply
 * (any non-unreachable authority — explicit rejections purge + login and
 * never land here — or an evaluation failure, which keeps the generic
 * error path). Never synthesizes membership: the read-only mode carries
 * the linkage UUID only, never a role/status.
 */
async function evaluateOfflineWorkspaceState(): Promise<
  | { mode: "offline-read-only"; workspaceId: string }
  | { mode: "blocked"; reason: Exclude<OfflineWorkspaceBlockReason, "revoked"> }
  | null
> {
  if (getSessionStatus().status !== "unreachable") return null;
  const principalId = getOfflinePrincipalId();
  const workspaceId = getOfflineWorkspaceId();
  if (!principalId || !workspaceId) return { mode: "blocked", reason: "no-binding" };
  let lock;
  try {
    lock = await getV3OfflineLockState(principalId, workspaceId);
  } catch {
    return null;
  }
  if (lock.state === "ok") return { mode: "offline-read-only", workspaceId };
  if (lock.state === "locked") {
    return { mode: "blocked", reason: lock.reason === "expired" ? "expired" : "no-binding" };
  }
  return { mode: "blocked", reason: "no-snapshot" };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() =>
    isApiConfigured() ? [] : [MOCK_DEFAULT_WORKSPACE],
  );
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | undefined>(() =>
    isApiConfigured() ? undefined : MOCK_DEFAULT_WORKSPACE.id,
  );
  const activeWorkspaceIdRef = useRef<string | undefined>(
    isApiConfigured() ? undefined : MOCK_DEFAULT_WORKSPACE.id,
  );
  /**
   * Load generation: every boot/refresh captures `seq` + the principal seen
   * at start. After EACH await the callback must confirm it is still the
   * latest request for the same principal before ANY setState, header write,
   * or preference write — otherwise a stale request (A) resolving after a
   * logout/login (B) would apply A's list/header/preference under B.
   */
  const loadSeqRef = useRef(0);
  /**
   * Latest committed list for failure-path restore ONLY. The selection
   * destination is never validated against this ref — membership always
   * comes from the fresh server list fetched inside `selectWorkspace`, so a
   * callback captured before `refreshWorkspaces()` (e.g. createWorkspace's
   * `await refresh + await select(newId)`) still selects the new workspace.
   */
  const workspacesRef = useRef<Workspace[]>(workspaces);
  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [ownershipTransfers, setOwnershipTransfers] = useState<OwnershipTransfer[]>([]);
  const [loading, setLoading] = useState(() => isApiConfigured());
  const [membersLoading, setMembersLoading] = useState(false);
  const [pendingInvitesLoading, setPendingInvitesLoading] = useState(false);
  const [ownershipTransfersLoading, setOwnershipTransfersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState(false);
  const [isOfflineReadOnly, setIsOfflineReadOnly] = useState(false);
  const [offlineWorkspaceId, setOfflineWorkspaceId] = useState<string | null>(null);
  const [offlineBlockedReason, setOfflineBlockedReason] =
    useState<OfflineWorkspaceBlockReason | null>(null);
  /**
   * T07c: a load parked the provider in offline/blocked state — the next
   * transition INTO an authenticated authority must revalidate
   * membership/lifecycle server-side before mutations reopen. Consumed
   * before the refresh so a failed revalidation never loops.
   */
  const needsRevalidationRef = useRef(false);
  const { session } = useSession();

  /**
   * T07c shared failure path for boot + refreshWorkspaces. Auth failures
   * keep the fail-closed purge (T07a single revocation signal untouched);
   * non-auth failures consult the offline route when the authority is
   * unreachable. Runs synchronously through the purge; the offline
   * evaluation is the only awaited gap, re-validated for staleness.
   */
  const applyLoadFailure = useCallback(
    async (cause: unknown, isStale: () => boolean): Promise<void> => {
      const auth = isAuthFailure(cause);
      if (auth) {
        // Explicit auth/membership failure (401/403): the previously
        // validated active workspace is no longer server-confirmed under
        // this principal — fail closed instead of preserving it. Non-auth
        // network failures keep the last validated selection below.
        activeWorkspaceIdRef.current = undefined;
        setActiveWorkspaceIdState(undefined);
        clearActiveWorkspaceId();
        persistActiveWorkspacePreference(undefined);
        try {
          clearOfflineWorkspaceBinding();
        } catch {
          /* noop */
        }
        // T07c: the server-confirmed revocation is a named blocked cause; a
        // 401 session expiry stays modeled by isAuthError alone (never
        // mislabeled as a membership revocation).
        const revoked =
          isMembershipRevocation(getFailureStatus(cause) ?? -1, getFailureCode(cause)) ||
          (cause instanceof Error &&
            cause.message.toLowerCase().includes("auth.workspace_forbidden"));
        setIsOfflineReadOnly(false);
        setOfflineWorkspaceId(null);
        setOfflineBlockedReason(revoked ? "revoked" : null);
      } else {
        const offline = await evaluateOfflineWorkspaceState();
        if (isStale()) return;
        if (offline?.mode === "offline-read-only") {
          setIsOfflineReadOnly(true);
          setOfflineWorkspaceId(offline.workspaceId);
          setOfflineBlockedReason(null);
          needsRevalidationRef.current = true;
          setIsAuthError(false);
          setError(OFFLINE_WORKSPACE_READONLY_MESSAGE);
          return;
        }
        if (offline) {
          setIsOfflineReadOnly(false);
          setOfflineWorkspaceId(null);
          setOfflineBlockedReason(offline.reason);
          needsRevalidationRef.current = true;
        }
      }
      setIsAuthError(auth);
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os workspaces.");
    },
    [],
  );

  const refreshWorkspaces = useCallback(async () => {
    if (!isApiConfigured()) {
      setWorkspaces([MOCK_DEFAULT_WORKSPACE]);
      setActiveWorkspaceIdState(MOCK_DEFAULT_WORKSPACE.id);
      activeWorkspaceIdRef.current = MOCK_DEFAULT_WORKSPACE.id;
      setLoading(false);
      return;
    }
    const seq = (loadSeqRef.current += 1);
    const startPrincipal = getOfflinePrincipalId();
    // Superseded: a newer boot/refresh owns provider state now.
    // Stale: superseded OR the principal changed mid-flight — this request
    // must never apply workspace data, header, preference, or error.
    const isSuperseded = () => seq !== loadSeqRef.current;
    const isStale = () =>
      isSuperseded() || getOfflinePrincipalId() !== startPrincipal;
    try {
      const next = await fetchWorkspaces();
      if (isStale()) return;
      setError(null);
      setIsAuthError(false);
      setIsOfflineReadOnly(false);
      setOfflineWorkspaceId(null);
      setOfflineBlockedReason(null);
      needsRevalidationRef.current = false;
      const current = activeWorkspaceIdRef.current;
      const selected = resolveActiveWorkspaceId(next, current, getOfflinePrincipalId());
      if (current && selected !== current) {
        setLoading(true);
        closeAllSockets("workspace access revoked");
        // V41C FIX 3 (AUTH-T07): the revocation-triggered auto-switch purges
        // the workspace-side offline binding (workspace id, subject
        // partition, age stamp) — binding X must never survive as Y. The
        // user principal survives for rebinding; tokens are untouched.
        await clearSensitiveSession({ clearV1Snapshot: true, clearProfile: true, clearWorkspaceBinding: true });
        // The purge above is awaited: the principal may have changed (or a
        // newer load started) while it ran — re-validate before writing.
        if (isStale()) return;
      }
      // All workspace-data writes happen only after the final validation, so
      // a stale list can never flash (or persist) under a new principal.
      setWorkspaces(next);
      activeWorkspaceIdRef.current = selected;
      setActiveWorkspaceIdState(selected);
      if (selected) setActiveWorkspaceId(selected);
      else clearActiveWorkspaceId();
      persistActiveWorkspacePreference(selected);
    } catch (cause) {
      if (isStale()) return;
      await applyLoadFailure(cause, isStale);
      if (isStale()) return;
      throw cause;
    } finally {
      // Identity-free spinner reset: a principal switch with no newer request
      // still releases the spinner; a superseded request leaves it to its owner.
      if (!isSuperseded()) setLoading(false);
    }
  }, [applyLoadFailure]);

  useEffect(() => {
    if (!isApiConfigured()) {
      return;
    }
    let cancelled = false;
    const seq = (loadSeqRef.current += 1);
    const startPrincipal = getOfflinePrincipalId();
    const isSuperseded = () => cancelled || seq !== loadSeqRef.current;
    const isStale = () =>
      isSuperseded() || getOfflinePrincipalId() !== startPrincipal;
    async function load() {
      try {
        const next = await fetchWorkspaces();
        if (isStale()) return;
        setError(null);
        setIsAuthError(false);
        setIsOfflineReadOnly(false);
        setOfflineWorkspaceId(null);
        setOfflineBlockedReason(null);
        needsRevalidationRef.current = false;
        const current = activeWorkspaceIdRef.current;
        const selected = resolveActiveWorkspaceId(next, current, getOfflinePrincipalId());
        if (current && selected !== current) {
          setLoading(true);
          closeAllSockets("workspace access revoked");
          // V41C FIX 3 (AUTH-T07): same binding purge as refreshWorkspaces —
          // see the note above.
          await clearSensitiveSession({ clearV1Snapshot: true, clearProfile: true, clearWorkspaceBinding: true });
          // Same re-validation as refreshWorkspaces: the purge is awaited.
          if (isStale()) return;
        }
        setWorkspaces(next);
        activeWorkspaceIdRef.current = selected;
        setActiveWorkspaceIdState(selected);
        if (selected) setActiveWorkspaceId(selected);
        else clearActiveWorkspaceId();
        persistActiveWorkspacePreference(selected);
      } catch (cause) {
        if (isStale()) return;
        await applyLoadFailure(cause, isStale);
      } finally {
        if (!isSuperseded()) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      // Invalidate in-flight loads so a late resolution after unmount (e.g.
      // logout remount) can never apply header/preference writes.
      loadSeqRef.current += 1;
      clearActiveWorkspaceId();
    };
  }, [applyLoadFailure]);

  // T07c: reconnection revalidates membership/lifecycle before mutations
  // reopen. Fires only on a transition INTO an authenticated authority
  // while a previous load parked the provider offline/blocked — the flag
  // is consumed before the refresh so a failed revalidation never loops.
  // Workspace mutations themselves always revalidate server-side; the
  // AppState write guard additionally requires an authenticated authority.
  useEffect(() => {
    if (session.status !== "authenticated") return;
    if (!needsRevalidationRef.current) return;
    needsRevalidationRef.current = false;
    void refreshWorkspaces().catch(() => {
      /* the failure is modeled in context error state by the refresh itself */
    });
  }, [session.status, refreshWorkspaces]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  const refreshMembers = useCallback(async () => {
    if (!activeWorkspace || !isApiConfigured()) {
      setMembers([]);
      return;
    }
    setMembersLoading(true);
    try {
      const nextMembers = await fetchWorkspaceMembers(activeWorkspace.id);
      setMembers(nextMembers);
    } catch (cause) {
      throw cause;
    } finally {
      setMembersLoading(false);
    }
  }, [activeWorkspace]);

  const refreshPendingInvites = useCallback(async () => {
    if (!activeWorkspace || !isApiConfigured() || activeWorkspace.kind !== "shared" || activeWorkspace.role !== "owner") {
      setPendingInvites([]);
      return;
    }
    setPendingInvitesLoading(true);
    try {
      const invites = await fetchPendingInvites(activeWorkspace.id);
      setPendingInvites(invites);
    } catch {
      // Do not overwrite on transient errors
    } finally {
      setPendingInvitesLoading(false);
    }
  }, [activeWorkspace]);

  const refreshOwnershipTransfers = useCallback(async () => {
    if (!activeWorkspace || !isApiConfigured() || activeWorkspace.kind !== "shared") {
      setOwnershipTransfers([]);
      return;
    }
    setOwnershipTransfersLoading(true);
    try {
      const transfers = await fetchOwnershipTransfers(activeWorkspace.id);
      setOwnershipTransfers(transfers);
    } catch {
      // 403 or non-authorized fallback
      setOwnershipTransfers([]);
    } finally {
      setOwnershipTransfersLoading(false);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    let cancelled = false;
    async function loadDetails() {
      if (!activeWorkspace || !isApiConfigured()) {
        if (!cancelled) {
          setMembers([]);
          setPendingInvites([]);
          setOwnershipTransfers([]);
        }
        return;
      }
      if (activeWorkspace.kind === "shared") {
        try {
          const nextMembers = await fetchWorkspaceMembers(activeWorkspace.id);
          if (!cancelled) setMembers(nextMembers);
        } catch {}

        if (activeWorkspace.role === "owner") {
          try {
            const nextInvites = await fetchPendingInvites(activeWorkspace.id);
            if (!cancelled) setPendingInvites(nextInvites);
          } catch {}
        } else {
          if (!cancelled) setPendingInvites([]);
        }

        try {
          const nextTransfers = await fetchOwnershipTransfers(activeWorkspace.id);
          if (!cancelled) setOwnershipTransfers(nextTransfers);
        } catch {
          if (!cancelled) setOwnershipTransfers([]);
        }
      } else {
        if (!cancelled) {
          setMembers([]);
          setPendingInvites([]);
          setOwnershipTransfers([]);
        }
      }
    }
    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace]);

  const selectWorkspace = useCallback(async (workspaceId: string) => {
    // Server-authoritative list known at call time: the ONLY membership
    // truth the non-auth failure path may restore. The destination itself
    // is NEVER validated against this ref — it may be a workspace created
    // after this callback was captured (createWorkspace's refresh+select).
    // Membership always comes from the fresh server list below.
    const knownWorkspaces = workspacesRef.current;
    const current = activeWorkspaceIdRef.current;
    // No early-return on same-active: the switcher allows selecting the
    // active option, and the cached list may be stale (membership revoked
    // or workspace archived since). The destination — even when it equals
    // the current selection — is always revalidated against a fresh
    // server list below. A still-valid same-active reasserts list/header/
    // preference without the switch purge; a revoked/archived same-active
    // falls back (or fails closed) like any other revoked destination.
    const isSameActive = current !== undefined && current === workspaceId;
    // Manual-selection generation: invalidates in-flight boot/refresh loads
    // so a stale refresh resolving later can never overwrite this selection.
    // The principal seen at start is captured alongside — after EACH await
    // the selection must still be the latest request for the SAME principal
    // before ANY setState, header write, or preference write.
    const seq = (loadSeqRef.current += 1);
    const startPrincipal = getOfflinePrincipalId();
    // Superseded: a newer boot/refresh/selection owns provider state now.
    // Stale: superseded OR the principal changed mid-flight (logout/login
    // as B during A's switch) — the old selection must commit nothing.
    const isSuperseded = () => seq !== loadSeqRef.current;
    const isStale = () =>
      isSuperseded() || getOfflinePrincipalId() !== startPrincipal;
    setLoading(true);
    try {
      if (current && !isSameActive) {
        closeAllSockets("workspace access revoked");
        clearActiveWorkspaceId();
        // Phase 3 (AUTH-T07): switching workspaces purges the snapshot slots
        // (V1/V2/V3) + profile AND clears the workspace-side offline binding
        // (workspace id, subject partition, age stamp) — workspace X data can
        // never appear as workspace Y. The user principal survives for
        // rebinding on the next online sync; tokens are untouched (no logout).
        // IDB NON-BLOCKER (reviewed): V2/V3 deletes use fixed slots, so a
        // deferred purge racing a later login as B may delete B's freshly
        // written cache (resync loss only — slots are not cross-user readable,
        // so no cross-data leak). Never claim the snapshot survives the race.
        await clearSensitiveSession({ clearV1Snapshot: true, clearProfile: true, clearWorkspaceBinding: true });
        // The purge above is awaited: the principal may have changed (or a
        // newer load/selection started) while it ran — re-validate before
        // writing anything.
        if (isStale()) return;
      }
      // Server-side revalidation ALWAYS runs — even with no active workspace
      // (e.g. after a failure cleared the selection) and even when the
      // destination equals the current selection (same-active revalidation).
      // The destination is never trusted from `knownWorkspaces` alone: it
      // may have been removed/archived while stale. The purge above stays
      // gated on a cross-workspace switch (nothing workspace-side to tear
      // down without a selection, and no purge for a still-valid
      // same-active revalidation).
      const fresh = await fetchWorkspaces();
      if (isStale()) return;
      if (!fresh.some((workspace) => workspace.id === workspaceId && workspace.status !== "archived" && workspace.status !== "deleted")) {
        // Adopt the server truth instead of the revoked destination: fall
        // back under the same principal and persist the fallback so no
        // label/header divergence is left behind.
        const fallback = resolveActiveWorkspaceId(fresh, current, getOfflinePrincipalId());
        if (isSameActive && current && fallback !== current) {
          // Same-active revoked/archived: the active workspace changes as a
          // result, so run the same workspace-side teardown as an
          // auto-switch (sockets + snapshot/profile + binding purge).
          // The cross-workspace path already purged before revalidation.
          closeAllSockets("workspace access revoked");
          clearActiveWorkspaceId();
          await clearSensitiveSession({ clearV1Snapshot: true, clearProfile: true, clearWorkspaceBinding: true });
          if (isStale()) return;
        }
        setError(null);
        setIsAuthError(false);
        setWorkspaces(fresh);
        activeWorkspaceIdRef.current = fallback;
        setActiveWorkspaceIdState(fallback);
        if (fallback) setActiveWorkspaceId(fallback);
        else clearActiveWorkspaceId();
        persistActiveWorkspacePreference(fallback);
        return;
      }
      setWorkspaces(fresh);
      if (isStale()) return;
      // Label, header, and preference commit atomically only after the final
      // validation — a stale selection never writes header/preference.
      // A revalidated destination clears any prior selection error so the
      // switcher alert cannot outlive the committed header/label.
      setError(null);
      setIsAuthError(false);
      activeWorkspaceIdRef.current = workspaceId;
      setActiveWorkspaceIdState(workspaceId);
      setActiveWorkspaceId(workspaceId);
      persistActiveWorkspacePreference(workspaceId);
    } catch (cause) {
      // Revalidation failed (network/5xx/auth, with or without a prior
      // purge): the header may already be cleared but state/label/preference
      // still name `current`.
      // Leaving that split silently would show label X with header
      // Y/undefined, and rejecting would escape as an unhandled rejection
      // through `void` callers — so restore a coherent safe state and
      // surface a modeled error instead (this function never rejects).
      // A stale failure commits nothing: the newer request (or the new
      // principal's own boot) owns header/state/preference now.
      if (isStale()) return;
      const auth = isAuthFailure(cause);
      if (auth) {
        // Auth/permission failure (401/403): the previous binding is no
        // longer server-confirmed under this principal — never restore it.
        // Fail closed on no workspace (header/ref/state/preference cleared)
        // with the auth error below, never on the unvalidated destination.
        activeWorkspaceIdRef.current = undefined;
        setActiveWorkspaceIdState(undefined);
        clearActiveWorkspaceId();
        persistActiveWorkspacePreference(undefined);
        // SAME-ACTIVE FIX (HIGH): a same-current selection skips the
        // pre-revalidation purge, so without this the offline workspace
        // binding + subject partition + age stamp would survive an explicit
        // revocation. Purge the workspace side (principal preserved) only
        // while still the latest request for the same principal; the purge
        // is awaited, so re-validate before publishing the modeled error.
        const failurePrincipal = getOfflinePrincipalId();
        if (failurePrincipal !== null && failurePrincipal === startPrincipal) {
          await clearSensitiveSession({ clearWorkspaceBinding: true });
          if (isStale()) return;
        }
      } else {
        const principal = getOfflinePrincipalId();
        const restorable =
          principal !== null &&
          principal === startPrincipal &&
          current !== undefined &&
          knownWorkspaces.some(
            (workspace) => workspace.id === current && workspace.status !== "archived" && workspace.status !== "deleted",
          );
        if (restorable && current !== undefined) {
          // `current` was a member in the server-authoritative list known at
          // call time and the principal is unchanged: re-assert it everywhere
          // (ref/state/header/preference) so no divergence is left behind.
          activeWorkspaceIdRef.current = current;
          setActiveWorkspaceIdState(current);
          setActiveWorkspaceId(current);
          persistActiveWorkspacePreference(current);
        } else {
          // No valid membership to fall back to — fail closed on no workspace
          // with the error below, never on the unvalidated destination.
          activeWorkspaceIdRef.current = undefined;
          setActiveWorkspaceIdState(undefined);
          clearActiveWorkspaceId();
          persistActiveWorkspacePreference(undefined);
        }
      }
      setIsAuthError(auth);
      setError(cause instanceof Error ? cause.message : "Não foi possível trocar de espaço.");
      return;
    } finally {
      // Identity-free spinner reset: a principal switch with no newer request
      // still releases the spinner; a superseded selection leaves it to its
      // owner so the spinner can never get stuck nor flash early.
      if (!isSuperseded()) setLoading(false);
    }
  }, []);

  const renameWorkspace = useCallback(async (workspaceId: string, name: string) => {
    await renameWorkspaceRequest(workspaceId, name);
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  const archiveWorkspace = useCallback(async (workspaceId: string) => {
    await archiveWorkspaceRequest(workspaceId);
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  const restoreWorkspace = useCallback(async (workspaceId: string) => {
    await restoreWorkspaceRequest(workspaceId);
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  const fetchDeletionInventory = useCallback(async (workspaceId: string) => {
    return fetchDeletionInventoryRequest(workspaceId);
  }, []);

  const requestAgentEmptyAttestation = useCallback(async (workspaceId: string, inventoryVersion: string) => {
    return requestAgentEmptyAttestationRequest(workspaceId, inventoryVersion);
  }, []);

  const deleteWorkspace = useCallback(async (workspaceId: string, confirmation: DeleteConfirmationInput) => {
    const receipt = await deleteWorkspaceRequest(workspaceId, confirmation);
    await refreshWorkspaces();
    return receipt;
  }, [refreshWorkspaces]);

  const createWorkspace = useCallback(async (input: { name: string; kind: "personal" | "shared" }) => {
    // Create generation: capture (do NOT bump) the load generation + the
    // principal seen at start. A newer manual selection/refresh/boot bumps
    // loadSeqRef, so any change means this create is stale.
    const startSeq = loadSeqRef.current;
    const startPrincipal = getOfflinePrincipalId();
    const isCreateStale = () =>
      loadSeqRef.current !== startSeq || getOfflinePrincipalId() !== startPrincipal;
    const created = await createWorkspaceRequest(input);
    // A manual selection (or logout/login) that landed while the create was
    // pending owns provider state now — stop without refresh/select so the
    // newer selection (or the new principal's own boot) is never overwritten.
    // The workspace was already created server-side under A; it is returned
    // for the caller but never auto-selected here, and nothing is cleaned up.
    if (isCreateStale()) return created;
    const seqBeforeRefresh = loadSeqRef.current;
    await refreshWorkspaces();
    // The create's own refresh bumped exactly once (seqBeforeRefresh + 1).
    // A principal change or any extra bump means external work started
    // during the refresh — stop before the auto-select.
    if (getOfflinePrincipalId() !== startPrincipal) return created;
    if (loadSeqRef.current !== seqBeforeRefresh + 1) return created;
    await selectWorkspace(created.id);
    return created;
  }, [refreshWorkspaces, selectWorkspace]);

  const inviteMember = useCallback(async (email: string) => {
    if (!activeWorkspace) throw new Error("Selecione um workspace compartilhado.");
    await createWorkspaceInvite(activeWorkspace.id, email);
    await refreshPendingInvites();
  }, [activeWorkspace, refreshPendingInvites]);

  const resendInvite = useCallback(async (inviteId: string) => {
    if (!activeWorkspace) throw new Error("Selecione um workspace compartilhado.");
    await resendWorkspaceInvite(activeWorkspace.id, inviteId);
    await refreshPendingInvites();
  }, [activeWorkspace, refreshPendingInvites]);

  const revokeInvite = useCallback(async (inviteId: string) => {
    if (!activeWorkspace) throw new Error("Selecione um workspace compartilhado.");
    await revokeWorkspaceInvite(activeWorkspace.id, inviteId);
    await refreshPendingInvites();
  }, [activeWorkspace, refreshPendingInvites]);

  const acceptInvite = useCallback(async (token: string) => {
    await acceptWorkspaceInvite(token.trim());
    await refreshWorkspaces();
    // The accepted membership only becomes visible after the members and
    // pending lists reload (item 9: list must update after accepting).
    await Promise.all([refreshMembers(), refreshPendingInvites()]);
  }, [refreshWorkspaces, refreshMembers, refreshPendingInvites]);

  const removeMember = useCallback(async (userId: string) => {
    if (!activeWorkspace) throw new Error("Selecione um workspace.");
    await removeWorkspaceMember(activeWorkspace.id, userId);
    await refreshMembers();
  }, [activeWorkspace, refreshMembers]);

  const transferOwnership = useCallback(async (toUserId: string) => {
    if (!activeWorkspace) throw new Error("Selecione um workspace.");
    await createOwnershipTransfer(activeWorkspace.id, toUserId);
    await refreshOwnershipTransfers();
  }, [activeWorkspace, refreshOwnershipTransfers]);

  const acceptTransfer = useCallback(async (transferId: string) => {
    if (!activeWorkspace) throw new Error("Selecione um workspace.");
    await acceptOwnershipTransfer(activeWorkspace.id, transferId);
    await refreshWorkspaces();
    await refreshMembers();
    await refreshOwnershipTransfers();
  }, [activeWorkspace, refreshMembers, refreshOwnershipTransfers, refreshWorkspaces]);

  const leave = useCallback(async () => {
    if (!activeWorkspace) throw new Error("Selecione um workspace.");
    await leaveWorkspace(activeWorkspace.id);
    await refreshWorkspaces();
  }, [activeWorkspace, refreshWorkspaces]);

  const value = useMemo<WorkspaceContextValue>(() => ({
    workspaces,
    activeWorkspace,
    members,
    pendingInvites,
    ownershipTransfers,
    loading,
    membersLoading,
    pendingInvitesLoading,
    ownershipTransfersLoading,
    error,
    isAuthError,
    isOfflineReadOnly,
    offlineWorkspaceId,
    offlineBlockedReason,
    selectWorkspace,
    refreshWorkspaces,
    refreshMembers,
    refreshPendingInvites,
    refreshOwnershipTransfers,
    createWorkspace,
    renameWorkspace,
    archiveWorkspace,
    restoreWorkspace,
    fetchDeletionInventory,
    requestAgentEmptyAttestation,
    deleteWorkspace,
    inviteMember,
    resendInvite,
    revokeInvite,
    acceptInvite,
    removeMember,
    transferOwnership,
    acceptTransfer,
    leave,
  }), [workspaces, activeWorkspace, members, pendingInvites, ownershipTransfers, loading, membersLoading, pendingInvitesLoading, ownershipTransfersLoading, error, isAuthError, isOfflineReadOnly, offlineWorkspaceId, offlineBlockedReason, selectWorkspace, refreshWorkspaces, refreshMembers, refreshPendingInvites, refreshOwnershipTransfers, createWorkspace, renameWorkspace, archiveWorkspace, restoreWorkspace, fetchDeletionInventory, requestAgentEmptyAttestation, deleteWorkspace, inviteMember, resendInvite, revokeInvite, acceptInvite, removeMember, transferOwnership, acceptTransfer, leave]);

  if (loading) return <main className="flex h-dvh items-center justify-center text-text-secondary">Carregando workspaces…</main>;
  return (
    <WorkspaceContext.Provider value={value}>
      <Fragment key={activeWorkspaceId ?? "no-workspace"}>{children}</Fragment>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return context;
}

export function useWorkspaceSafe(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}
