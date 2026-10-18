import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/lib/test-utils";
import { WorkspaceProvider, useWorkspace } from "../workspace-context";
import { SessionProvider, useSession } from "../session-context";
import {
  resetSessionStatus,
  setSessionStatus,
  getSessionStatus,
} from "../session-authority";
import {
  setOfflinePrincipalId,
  setOfflineWorkspaceId,
  getOfflinePrincipalId,
} from "../offline-identity";
import { writeV3Snapshot, resolveUnreachableOfflineRoute } from "@/lib/state/snapshot-db";
import { AuthGate } from "@/features/auth/AuthGate";

/**
 * T07c — contexto de workspace: cold boot unreachable (PWA).
 *
 * Aceite:
 * - cold boot unreachable com V3 válido habilita apenas leitura do
 *   workspace vinculado (sem sintetizar membership/owner a partir do ID
 *   local);
 * - nenhum snapshot / expirado / revogado dá estado bloqueado explícito;
 * - reconexão revalida membership/lifecycle antes de reabrir mutações;
 * - arquivado continua read-only; deleted nunca renasce por cache.
 */

const PRINCIPAL = "user-t07c";
const WS_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const WS_OTHER = "11111111-2222-4333-8444-555555555555";

const api = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceMembers: vi.fn(),
  fetchPendingInvites: vi.fn(),
  fetchOwnershipTransfers: vi.fn(),
  createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  fetchDeletionInventory: vi.fn(),
  requestAgentEmptyAttestation: vi.fn(),
  deleteWorkspace: vi.fn(),
  createWorkspaceInvite: vi.fn(),
  resendWorkspaceInvite: vi.fn(),
  revokeWorkspaceInvite: vi.fn(),
  acceptWorkspaceInvite: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  createOwnershipTransfer: vi.fn(),
  acceptOwnershipTransfer: vi.fn(),
  fetchOwnershipTransfersList: vi.fn(),
  closeAllSockets: vi.fn(),
}));
const clientState = vi.hoisted(() => ({ active: undefined as string | undefined }));
vi.mock("@/lib/api/workspaces", () => api);
vi.mock("../socket-registry", () => ({ closeAllSockets: api.closeAllSockets }));
vi.mock("@/lib/api/client", () => ({
  isApiConfigured: () => true,
  getAuthToken: () => "user-1",
  setActiveWorkspaceId: vi.fn((id: string) => {
    clientState.active = id;
  }),
  getActiveWorkspaceId: vi.fn(() => clientState.active),
  clearActiveWorkspaceId: vi.fn(() => {
    clientState.active = undefined;
  }),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

/**
 * T07c-F1: controllable gate on the V3 lock read. Lets a test park the
 * offline evaluation mid-await (entry checks done, IndexedDB read pending),
 * flip the session authority, then release — proving the post-await
 * authority re-check. Default: passthrough to the real implementation.
 */
const v3Gate = vi.hoisted(() => ({
  deferred: null as null | Promise<void>,
  resolve: null as null | (() => void),
  entered: false,
}));
/**
 * T07c-F2R2-F3-F1: controllable gate on the V3 snapshot delete. Lets a test
 * hold `clearSensitiveSession`'s async purge pending while a stale probe
 * response arrives — proving the expiry-entry invalidation. Default:
 * passthrough (the delete still runs after release, so the purge is real).
 */
const purgeGate = vi.hoisted(() => ({
  armed: false,
  entered: false,
  promise: null as null | Promise<void>,
  resolve: null as null | (() => void),
}));
vi.mock("@/lib/state/snapshot-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/snapshot-db")>();
  return {
    ...actual,
    getV3OfflineLockState: (...args: Parameters<typeof actual.getV3OfflineLockState>) => {
      if (v3Gate.deferred) {
        v3Gate.entered = true;
        return v3Gate.deferred.then(() => actual.getV3OfflineLockState(...args));
      }
      return actual.getV3OfflineLockState(...args);
    },
    deleteV3Snapshot: () => {
      if (purgeGate.armed && purgeGate.promise) {
        purgeGate.entered = true;
        return purgeGate.promise.then(() => actual.deleteV3Snapshot());
      }
      return actual.deleteV3Snapshot();
    },
  };
});
function armV3Gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  v3Gate.deferred = promise;
  v3Gate.resolve = resolve;
  v3Gate.entered = false;
}
function releaseV3Gate() {
  v3Gate.resolve?.();
  v3Gate.deferred = null;
  v3Gate.resolve = null;
}
function armPurgeGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  purgeGate.promise = promise;
  purgeGate.resolve = resolve;
  purgeGate.armed = true;
  purgeGate.entered = false;
}
function releasePurgeGate() {
  purgeGate.armed = false;
  purgeGate.resolve?.();
  purgeGate.promise = null;
  purgeGate.resolve = null;
}

/**
 * T07c-F2R2: controllable session-probe transport. The mocked
 * `@/lib/api/client` apiFetch routes `/auth/session` through this gate so
 * tests can pend, fail, or answer the probe deterministically while the
 * REAL fetchSession classification + REAL AuthGate wiring run.
 */
const transport = vi.hoisted(() => ({
  sessionProbe: "unreachable" as "unreachable" | "user" | "empty" | "generic403" | "server500",
  userId: "",
  sessionCalls: [] as string[],
  probeGateArmed: false,
  probeGateEntered: false,
  probeGatePromise: null as null | Promise<unknown>,
  probeGateResolve: null as null | ((v: unknown) => void),
}));
let MockApiError: new (status: number, code: string, message: string) => Error;
function armProbeGate() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  transport.probeGatePromise = promise;
  transport.probeGateResolve = resolve;
  transport.probeGateArmed = true;
  transport.probeGateEntered = false;
}
function releaseProbeGate(value: unknown) {
  transport.probeGateArmed = false;
  transport.probeGateResolve?.(value);
  transport.probeGatePromise = null;
  transport.probeGateResolve = null;
}
function userProbeBody(userId: string): unknown {
  return { user: { id: userId, email: "u@example.com", name: "U" }, session: {} };
}

type LooseContext = {
  isOfflineReadOnly?: unknown;
  offlineWorkspaceId?: unknown;
  offlineBlockedReason?: unknown;
};

function Probe() {
  const ctx = useWorkspace() as unknown as LooseContext & {
    activeWorkspace: { name: string } | null;
    workspaces: Array<{ id: string; name: string; role?: string; status?: string }>;
    loading: boolean;
    error: string | null;
    isAuthError?: boolean;
  };
  return (
    <>
      <div data-testid="active">{ctx.activeWorkspace?.name ?? "none"}</div>
      <div data-testid="loading">{String(ctx.loading)}</div>
      <div data-testid="error">{ctx.error ?? "no-error"}</div>
      <div data-testid="is-auth-error">{String(ctx.isAuthError ?? false)}</div>
      <div data-testid="is-offline-read-only">{String(ctx.isOfflineReadOnly ?? false)}</div>
      <div data-testid="offline-workspace-id">{(ctx.offlineWorkspaceId as string | null) ?? "none"}</div>
      <div data-testid="offline-blocked-reason">{(ctx.offlineBlockedReason as string | null) ?? "none"}</div>
      <div data-testid="workspaces-count">{ctx.workspaces.length}</div>
      <div data-testid="workspaces-json">{JSON.stringify(ctx.workspaces)}</div>
    </>
  );
}

async function seedValidV3() {
  setOfflinePrincipalId(PRINCIPAL);
  setOfflineWorkspaceId(WS_UUID);
  await writeV3Snapshot(PRINCIPAL, WS_UUID, "accounts", [
    {
      id: "a1",
      name: "Conta Offline",
      kind: "checking",
      initialBalanceCents: 0,
      status: "active",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      balanceCents: 100_00,
    },
  ] as never);
}

beforeEach(async () => {
  localStorage.clear();
  clientState.active = undefined;
  resetSessionStatus();
  vi.clearAllMocks();
  // Release any gate leaked by a failed test; the torn-down continuation is
  // stale-guarded and commits nothing.
  releaseV3Gate();
  v3Gate.entered = false;
  releasePurgeGate();
  purgeGate.entered = false;
  // Reset the probe transport and (re)install the routing apiFetch impl —
  // set after clearAllMocks so it always survives it.
  transport.sessionProbe = "unreachable";
  transport.userId = PRINCIPAL;
  transport.sessionCalls = [];
  releaseProbeGate(undefined);
  transport.probeGateEntered = false;
  const client = (await import("@/lib/api/client")) as unknown as {
    apiFetch: Mock;
    ApiError: new (status: number, code: string, message: string) => Error;
  };
  MockApiError = client.ApiError;
  client.apiFetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/auth/session")) {
      transport.sessionCalls.push(u);
      if (transport.probeGateArmed && transport.probeGatePromise) {
        transport.probeGateEntered = true;
        return transport.probeGatePromise;
      }
      if (transport.sessionProbe === "unreachable") throw new TypeError("fetch failed");
      if (transport.sessionProbe === "user") return userProbeBody(transport.userId);
      if (transport.sessionProbe === "empty") return { user: null, session: {} };
      if (transport.sessionProbe === "generic403") {
        throw new MockApiError(403, "auth.forbidden", "Forbidden");
      }
      throw new MockApiError(500, "internal", "Server error");
    }
    if (u.includes("/auth/sign-in/email")) return { user: { email: "b@example.com" } };
    if (u.includes("/auth/devices/register")) {
      return { token: "dev-b", deviceId: "d1", householdId: "h1" };
    }
    return undefined;
  });
  const dbs = await indexedDB.databases();
  for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
  api.fetchWorkspaceMembers.mockResolvedValue([]);
  api.fetchPendingInvites.mockResolvedValue([]);
  api.fetchOwnershipTransfers.mockResolvedValue([]);
});

afterEach(() => {
  localStorage.clear();
  resetSessionStatus();
});

describe("T07c: cold boot unreachable + V3 válido → leitura do workspace vinculado", () => {
  it("habilita modo offline read-only restrito ao workspace vinculado, sem sintetizar membership", async () => {
    setSessionStatus({ status: "unreachable", offlinePrincipalId: PRINCIPAL });
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");
    expect(screen.getByTestId("offline-workspace-id")).toHaveTextContent(WS_UUID);
    expect(screen.getByTestId("offline-blocked-reason")).toHaveTextContent("none");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
    // Nenhum membership/owner sintetizado a partir do ID local.
    expect(screen.getByTestId("workspaces-count")).toHaveTextContent("0");
    expect(screen.getByTestId("workspaces-json")).not.toHaveTextContent("owner");
    expect(screen.getByTestId("workspaces-json")).not.toHaveTextContent("member");
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("false");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    // Estado explícito (cópia offline, nunca sinal de auth).
    expect(screen.getByTestId("error")).toHaveTextContent("Sem conexão");
  });
});

describe("T07c: sem snapshot / expirado / sem binding → bloqueado explícito", () => {
  it("sem snapshot dá bloqueado explícito no-snapshot (nunca leitura silenciosa)", async () => {
    setSessionStatus({ status: "unreachable", offlinePrincipalId: PRINCIPAL });
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("offline-blocked-reason")).toHaveTextContent("no-snapshot");
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
    expect(screen.getByTestId("workspaces-count")).toHaveTextContent("0");
  });

  it("snapshot expirado dá bloqueado explícito expired", async () => {
    setSessionStatus({ status: "unreachable", offlinePrincipalId: PRINCIPAL });
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await writeV3Snapshot(PRINCIPAL, WS_UUID, "accounts", [{ id: "a1" }] as never, {
      lastOnlineAuthenticatedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(),
    });
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("offline-blocked-reason")).toHaveTextContent("expired");
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
  });

  it("sem binding dá bloqueado explícito no-binding", async () => {
    setSessionStatus({ status: "unreachable" });
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("offline-blocked-reason")).toHaveTextContent("no-binding");
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false");
  });

  it("revogação 403 auth.workspace_forbidden dá bloqueado explícito revoked com flag de auth", async () => {
    setSessionStatus({
      status: "authenticated",
      user: { userId: PRINCIPAL },
    });
    const { ApiError } = (await import("@/lib/api/client")) as unknown as {
      ApiError: new (status: number, code: string, message: string) => Error;
    };
    api.fetchWorkspaces.mockRejectedValue(
      new ApiError(403, "auth.workspace_forbidden", "Acesso ao workspace proibido."),
    );

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("is-auth-error")).toHaveTextContent("true");
    expect(screen.getByTestId("offline-blocked-reason")).toHaveTextContent("revoked");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
  });

  it("401 sessão expirada não é rotulada como revoked", async () => {
    setSessionStatus({
      status: "authenticated",
      user: { userId: PRINCIPAL },
    });
    const { ApiError } = (await import("@/lib/api/client")) as unknown as {
      ApiError: new (status: number, code: string, message: string) => Error;
    };
    api.fetchWorkspaces.mockRejectedValue(
      new ApiError(401, "auth.session_expired", "Sessão expirada"),
    );

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );

    expect(await screen.findByTestId("is-auth-error")).toHaveTextContent("true");
    expect(screen.getByTestId("offline-blocked-reason")).toHaveTextContent("none");
  });
});

describe("T07c: reconexão revalida membership/lifecycle antes de reabrir mutações", () => {
  it("revalida no flip unreachable→authenticated: arquivado nunca vira ativo (fallback honesto)", async () => {
    setSessionStatus({ status: "unreachable", offlinePrincipalId: PRINCIPAL });
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValueOnce(new Error("fetch failed"));
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_UUID, name: "Vinculado", kind: "personal", role: "owner", status: "archived" },
      { id: WS_OTHER, name: "Equipe", kind: "shared", role: "member", status: "active" },
    ]);

    const unreachable = {
      expireSession: () => {},
      session: { status: "unreachable", offlinePrincipalId: PRINCIPAL } as const,
    };
    const { rerender } = render(
      <SessionProvider value={unreachable}>
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </SessionProvider>,
    );
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");

    rerender(
      <SessionProvider
        value={{
          expireSession: () => {},
          session: { status: "authenticated", user: { userId: PRINCIPAL } },
        }}
      >
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </SessionProvider>,
    );

    // Membership/lifecycle revalidados contra o servidor: o arquivado não
    // assume; o ativo elegível assume; o modo offline cai.
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Equipe");
    });
    await waitFor(() =>
      expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("offline-workspace-id")).toHaveTextContent("none");
    expect(screen.getByTestId("offline-blocked-reason")).toHaveTextContent("none");
    expect(api.fetchWorkspaces.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("deleted não renasce por cache: ausente na lista do servidor nunca volta", async () => {
    setSessionStatus({ status: "unreachable", offlinePrincipalId: PRINCIPAL });
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValueOnce(new Error("fetch failed"));
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_OTHER, name: "Equipe", kind: "shared", role: "member", status: "active" },
    ]);

    const { rerender } = render(
      <SessionProvider
        value={{
          expireSession: () => {},
          session: { status: "unreachable", offlinePrincipalId: PRINCIPAL } as const,
        }}
      >
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </SessionProvider>,
    );
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");

    rerender(
      <SessionProvider
        value={{
          expireSession: () => {},
          session: { status: "authenticated", user: { userId: PRINCIPAL } },
        }}
      >
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Equipe");
    });
    expect(screen.getByTestId("workspaces-json")).not.toHaveTextContent(WS_UUID);
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false");
  });
});

describe("T07c-F1: flip de autoridade durante o V3 read em await", () => {
  it("flip mid-await com efeito disponível: revalida exatamente uma vez, nunca estaciona offline", async () => {
    setSessionStatus({ status: "unreachable", offlinePrincipalId: PRINCIPAL });
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValueOnce(new Error("fetch failed"));
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_OTHER, name: "Equipe", kind: "shared", role: "member", status: "active" },
    ]);

    armV3Gate();
    const { rerender } = render(
      <SessionProvider
        value={{
          expireSession: () => {},
          session: { status: "unreachable", offlinePrincipalId: PRINCIPAL } as const,
        }}
      >
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </SessionProvider>,
    );
    // A avaliação offline está estacionada no gate (entry checks feitos,
    // V3 read pendente) — o flip abaixo cai dentro do await.
    await waitFor(() => expect(v3Gate.entered).toBe(true));

    rerender(
      <SessionProvider
        value={{
          expireSession: () => {},
          session: { status: "authenticated", user: { userId: PRINCIPAL } },
        }}
      >
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </SessionProvider>,
    );
    releaseV3Gate();

    // O efeito consumiu o flag armado na entrada (F1-a) e revalidou; o
    // caminho direto pós-await virou no-op (flag já consumida) — bounded:
    // exatamente boot + 1 revalidação, sem terceiro refresh.
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Equipe");
    });
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false");
    expect(screen.getByTestId("offline-workspace-id")).toHaveTextContent("none");
    expect(screen.getByTestId("offline-blocked-reason")).toHaveTextContent("none");
    expect(api.fetchWorkspaces.mock.calls.length).toBe(2);
  });

  it("flip mid-await sem efeito (contexto congelado): não aplica offline, revalida direto uma vez", async () => {
    setSessionStatus({ status: "unreachable", offlinePrincipalId: PRINCIPAL });
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValueOnce(new Error("fetch failed"));
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_OTHER, name: "Equipe", kind: "shared", role: "member", status: "active" },
    ]);

    armV3Gate();
    // SessionProvider congelado em unreachable e nunca re-renderizado: o
    // efeito não enxerga o flip (só o caminho direto F1-b pode revalidar).
    // Sem isso, o fallback de useSession releria o módulo no re-render do
    // próprio apply e o teste não discriminaria o buraco.
    render(
      <SessionProvider
        value={{
          expireSession: () => {},
          session: { status: "unreachable", offlinePrincipalId: PRINCIPAL } as const,
        }}
      >
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </SessionProvider>,
    );
    await waitFor(() => expect(v3Gate.entered).toBe(true));

    // Flip visível só no store modular (efeito cego a ele).
    setSessionStatus({ status: "authenticated", user: { userId: PRINCIPAL } });
    releaseV3Gate();

    // O resultado do await pertence à autoridade superada: nunca vira
    // isOfflineReadOnly=true sob authenticated — limpa e revalida direto.
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Equipe");
    });
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false");
    expect(screen.getByTestId("offline-workspace-id")).toHaveTextContent("none");
    expect(screen.getByTestId("offline-blocked-reason")).toHaveTextContent("none");
    expect(api.fetchWorkspaces.mock.calls.length).toBe(2);
  });
});

describe("T07c-F2: recuperação real via AuthGate (online → reprobe → flip → revalidação)", () => {
  it("network recovery dispara reprobe, flipa para authenticated e o provider revalida", async () => {
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValueOnce(new Error("fetch failed"));
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_OTHER, name: "Equipe", kind: "shared", role: "member", status: "active" },
    ]);

    // Fluxo real: AuthGate de verdade (boot probe indisponível → unlock
    // offline via V3) com WorkspaceProvider de verdade embaixo.
    render(
      <AuthGate>
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </AuthGate>,
    );

    // Boot real estacionou offline (sem transição fabricada).
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");
    expect(getSessionStatus().status).toBe("unreachable");
    expect(transport.sessionCalls.length).toBe(1);

    // A rede volta: o `online` do browser dispara o reprobe do AuthGate.
    transport.sessionProbe = "user";
    window.dispatchEvent(new Event("online"));

    // Flip real da autoridade → efeito do provider revalida membership.
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Equipe");
    });
    expect(getSessionStatus().status).toBe("authenticated");
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false");
    // Boot + exatamente 1 reprobe (sem loops, sem polling): eventos `online`
    // adicionais com autoridade authenticated são no-op.
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await waitFor(() => {
      expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("false");
    });
    expect(transport.sessionCalls.length).toBe(2);
    expect(api.fetchWorkspaces.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

/** Botão que expõe o expireSession real do SessionProvider (shell unlocked). */
function SessionControls() {
  const { expireSession } = useSession();
  return <button onClick={() => void expireSession()}>expire-session</button>;
}

async function submitLoginAs(email = "b@example.com", password = "password123!") {
  const emailInput = await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
  fireEvent.change(emailInput, { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText(/••••/), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /Entrar/i }));
}

describe("T07c-F2R2-F1: reprobe tardio não sobrescreve autoridade mais nova (epoch)", () => {
  it("resposta atrasada após expireSession: sem mudança de autoridade, sem re-bind", async () => {
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <AuthGate>
        <SessionControls />
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </AuthGate>,
    );
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");

    // Reprobe pende no gate; antes de resolver, a sessão expira de verdade.
    armProbeGate();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(transport.probeGateEntered).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "expire-session" }));

    // Purge + login executados pelo caminho canônico.
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(getSessionStatus().status).toBe("unauthenticated");
    expect(getOfflinePrincipalId()).toBeNull();

    // O reprobe tardio resolve com um usuário válido — deve ser descartado.
    await act(async () => {
      releaseProbeGate(userProbeBody(PRINCIPAL));
    });

    // Nada mudou: sem re-bind do principal antigo, sem flip para authenticated.
    expect(getSessionStatus().status).toBe("unauthenticated");
    expect(getOfflinePrincipalId()).toBeNull();
    expect(screen.queryByTestId("is-offline-read-only")).not.toBeInTheDocument();
  });

  it("resposta atrasada após login DIFERENTE: sem overwrite, sem re-bind da identidade antiga", async () => {
    const USER_B = "user-t07c-b";
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValueOnce(new Error("fetch failed"));
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_OTHER, name: "Equipe", kind: "shared", role: "member", status: "active" },
    ]);

    render(
      <AuthGate>
        <SessionControls />
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </AuthGate>,
    );
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");

    // Reprobe pende; expira; loga como principal DIFERENTE (fluxo real de
    // login — o probe pós-login NÃO passa pelo gate: só o primeiro
    // /auth/session é gatado).
    armProbeGate();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(transport.probeGateEntered).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "expire-session" }));
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });

    // O probe pós-login NÃO passa pelo gate (só a chamada stale está
    // gatada): desarma antes do submit; a promise stale segue pendente.
    transport.probeGateArmed = false;
    transport.sessionProbe = "user";
    transport.userId = USER_B;
    await submitLoginAs();
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("Equipe");
    });
    expect(getSessionStatus().status).toBe("authenticated");
    expect(getOfflinePrincipalId()).toBe(USER_B);

    // O reprobe tardio (usuário A) chega depois do login B — descarta tudo.
    await act(async () => {
      releaseProbeGate(userProbeBody(PRINCIPAL));
    });

    expect(getSessionStatus().status).toBe("authenticated");
    expect(getSessionStatus()).toEqual(
      expect.objectContaining({ user: expect.objectContaining({ userId: USER_B }) }),
    );
    expect(getOfflinePrincipalId()).toBe(USER_B);
    expect(screen.getByTestId("active")).toHaveTextContent("Equipe");
  });
});

describe("T07c-F2R2-F2: rejeição explícita no reprobe segue o caminho canônico de expiração", () => {
  it("2xx sem usuário → purge + login (mesma semântica do boot)", async () => {
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <AuthGate>
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </AuthGate>,
    );
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");

    transport.sessionProbe = "empty";
    window.dispatchEvent(new Event("online"));

    // Caminho canônico de expiração: login, autoridade unauthenticated,
    // identidade offline purgada e rota V3 morta (nunca reabre snapshot).
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(getSessionStatus().status).toBe("unauthenticated");
    expect(getOfflinePrincipalId()).toBeNull();
    await waitFor(async () => {
      expect(await resolveUnreachableOfflineRoute(PRINCIPAL, WS_UUID)).toBe("login");
    });
    expect(screen.queryByTestId("is-offline-read-only")).not.toBeInTheDocument();
  });

  it("403 genérico → purge + login (sem evento global, sem exceção)", async () => {
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <AuthGate>
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </AuthGate>,
    );
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");

    transport.sessionProbe = "generic403";
    window.dispatchEvent(new Event("online"));

    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(getSessionStatus().status).toBe("unauthenticated");
    expect(getOfflinePrincipalId()).toBeNull();
    await waitFor(async () => {
      expect(await resolveUnreachableOfflineRoute(PRINCIPAL, WS_UUID)).toBe("login");
    });
    expect(screen.queryByTestId("is-offline-read-only")).not.toBeInTheDocument();
  });

  it("falha de rede / 5xx preserva o offline (sem purge, sem flip)", async () => {
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <AuthGate>
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </AuthGate>,
    );
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");

    // Transport down de novo: nada muda.
    window.dispatchEvent(new Event("online"));
    await waitFor(() => {
      expect(transport.sessionCalls.length).toBeGreaterThanOrEqual(2);
    });
    expect(getSessionStatus().status).toBe("unreachable");
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("true");
    expect(getOfflinePrincipalId()).toBe(PRINCIPAL);

    // 5xx também é indisponibilidade para o probe (não rejeição): preserva.
    transport.sessionProbe = "server500";
    window.dispatchEvent(new Event("online"));
    await waitFor(() => {
      expect(transport.sessionCalls.length).toBeGreaterThanOrEqual(3);
    });
    expect(getSessionStatus().status).toBe("unreachable");
    expect(screen.getByTestId("is-offline-read-only")).toHaveTextContent("true");
    expect(getOfflinePrincipalId()).toBe(PRINCIPAL);
  });
});

describe("T07c-F2R2-F3-F1: resposta do probe durante o purge pendente", () => {
  it("resposta válida com purge V3 pendente: sem restore de authenticated/principal", async () => {
    setOfflinePrincipalId(PRINCIPAL);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3();
    api.fetchWorkspaces.mockRejectedValue(new Error("fetch failed"));

    render(
      <AuthGate>
        <SessionControls />
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </AuthGate>,
    );
    expect(await screen.findByTestId("is-offline-read-only")).toHaveTextContent("true");

    // Reprobe pende; expira; o purge V3 pende; SÓ ENTÃO a resposta chega.
    armProbeGate();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(transport.probeGateEntered).toBe(true));
    armPurgeGate();
    fireEvent.click(screen.getByRole("button", { name: "expire-session" }));
    await waitFor(() => expect(purgeGate.entered).toBe(true));

    // Mid-purge: a resposta tardia (usuário válido!) não restaura nada —
    // autoridade segue unreachable, principal segue purgado.
    await act(async () => {
      releaseProbeGate(userProbeBody(PRINCIPAL));
    });
    expect(getSessionStatus().status).toBe("unreachable");
    expect(getOfflinePrincipalId()).toBeNull();

    // Purge completa: login canônico, sem re-bind da identidade antiga.
    await act(async () => {
      releasePurgeGate();
    });
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(getSessionStatus().status).toBe("unauthenticated");
    expect(getOfflinePrincipalId()).toBeNull();
    await waitFor(async () => {
      expect(await resolveUnreachableOfflineRoute(PRINCIPAL, WS_UUID)).toBe("login");
    });
  });
});

describe("T07c-F2R2-F4-F2: purge direto do login rejeitado com probe pendente", () => {
  it("rejeição pós-login com purge V3 pendente: stale probe não restaura nem religa", async () => {
    // Boot direto para login (sem snapshot): autoridade unreachable, sem shell.
    render(
      <AuthGate>
        <div data-testid="kid">kid</div>
      </AuthGate>,
    );
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(getSessionStatus().status).toBe("unreachable");

    // Reprobe pende (stale); o login rejeitado dispara o purge direto, que
    // também pende no V3; SÓ ENTÃO a resposta stale chega.
    armProbeGate();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(transport.probeGateEntered).toBe(true));
    armPurgeGate();
    // O probe pós-login NÃO passa pelo gate (só a chamada stale está
    // gatada): desarma antes do submit.
    transport.probeGateArmed = false;
    transport.sessionProbe = "empty";
    await submitLoginAs();
    await waitFor(() => expect(purgeGate.entered).toBe(true));

    // Mid-purge: a resposta tardia (usuário válido!) não restaura nada.
    await act(async () => {
      releaseProbeGate(userProbeBody(PRINCIPAL));
    });
    expect(getSessionStatus().status).toBe("unreachable");
    expect(getOfflinePrincipalId()).toBeNull();

    // Purge completa: login com erro canônico, sem re-bind.
    await act(async () => {
      releasePurgeGate();
    });
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(getSessionStatus().status).toBe("unauthenticated");
    expect(getOfflinePrincipalId()).toBeNull();
  });
});
