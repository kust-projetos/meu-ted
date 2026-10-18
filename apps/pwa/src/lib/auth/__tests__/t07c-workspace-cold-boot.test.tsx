import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import { WorkspaceProvider, useWorkspace } from "../workspace-context";
import { SessionProvider } from "../session-context";
import {
  resetSessionStatus,
  setSessionStatus,
} from "../session-authority";
import {
  setOfflinePrincipalId,
  setOfflineWorkspaceId,
} from "../offline-identity";
import { writeV3Snapshot } from "@/lib/state/snapshot-db";

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
