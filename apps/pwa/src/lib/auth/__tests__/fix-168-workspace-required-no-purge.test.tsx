import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { WorkspaceProvider, useWorkspace } from "../workspace-context";
import { setOfflinePrincipalId } from "../offline-identity";
import {
  classifyAuthSignal,
  type AuthState,
} from "../auth-state-machine";
import {
  apiFetch,
  FORBIDDEN_EVENT,
  clearActiveWorkspaceId as clearClientWorkspace,
} from "@/lib/api/client";
import { writeV2Snapshot, readV2Snapshot } from "@/lib/state/snapshot-db";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";

/**
 * FIX-168 RED-2 (PWA): 403 auth.workspace_required NÃO dispara purge,
 * FORBIDDEN_EVENT nem expireSession.
 *
 * Hoje isAuthFailure (workspace-context) trata QUALQUER 403 como falha de
 * auth (limpa header/binding) e classifyAuthSignal mapeia QUALQUER 403 →
 * unauthenticated→login, enquanto o allowlist de revogação contém SÓ
 * auth.workspace_forbidden. Um 403 stale (sem header, pós-archive/clear)
 * vira purge+logout indevidos — o multiplicador dos 403 em massa.
 *
 * Só auth.workspace_forbidden limpa header/expira; workspace_required
 * (sem header) preserva seleção/header e nunca expira.
 * status+body.code capturados em todas as asserções.
 */

// ── Parte 1: state machine pura ──────────────────────────────────────────
describe("FIX-168 RED-2a: classifyAuthSignal estreito ao allowlist de revogação", () => {
  it("403 auth.workspace_required → unreachable (nunca unauthenticated)", () => {
    const state: AuthState = classifyAuthSignal({
      kind: "http",
      status: 403,
      code: "auth.workspace_required",
    });
    expect(state).toBe("unreachable");
  });

  it("403 sem code → unreachable (sem contexto de rota, sem purge)", () => {
    expect(
      classifyAuthSignal({ kind: "http", status: 403 }),
    ).toBe("unreachable");
  });

  it("403 auth.workspace_forbidden → unauthenticated (revogação real)", () => {
    const state: AuthState = classifyAuthSignal({
      kind: "http",
      status: 403,
      code: "auth.workspace_forbidden",
    });
    expect(state).toBe("unauthenticated");
  });

  it("401 segue unauthenticated (contrato de sessão inalterado)", () => {
    expect(classifyAuthSignal({ kind: "http", status: 401 })).toBe(
      "unauthenticated",
    );
  });
});

// ── Parte 2: transporte apiFetch ─────────────────────────────────────────
const SNAP_TOKEN = "fix168-probe-token";
const SNAP_SUBJECT = "44444444-5555-4666-8777-888888888888";

function mockStatus(status: number, body: unknown): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
}

describe("FIX-168 RED-2b: 403 workspace_required não dispara FORBIDDEN_EVENT nem purge", () => {
  beforeEach(async () => {
    localStorage.clear();
    clearClientWorkspace();
    vi.stubEnv(
      "NEXT_PUBLIC_PI_FINANCE_API_BASE_URL",
      "https://api.example.com",
    );
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    setOfflineSubjectId(SNAP_SUBJECT);
    await writeV2Snapshot(SNAP_TOKEN, "accounts", [{ id: "a1" }] as never);
    expect(await readV2Snapshot(SNAP_TOKEN, "accounts")).not.toBeNull();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejeita com status+code preservados, sem evento e sem purge", async () => {
    mockStatus(403, {
      code: "auth.workspace_required",
      message: "Header x-workspace-id é obrigatório.",
    });
    const handler = vi.fn();
    window.addEventListener(FORBIDDEN_EVENT, handler);
    try {
      const err = (await apiFetch("/accounts").catch((e: unknown) => e)) as {
        status?: unknown;
        code?: unknown;
      };
      expect(err?.status).toBe(403);
      expect(err?.code).toBe("auth.workspace_required");
      expect(handler).not.toHaveBeenCalled();
      expect(await readV2Snapshot(SNAP_TOKEN, "accounts")).not.toBeNull();
    } finally {
      window.removeEventListener(FORBIDDEN_EVENT, handler);
    }
  });
});

// ── Parte 3: workspace-context ───────────────────────────────────────────
const api = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceMembers: vi.fn(),
  fetchPendingInvites: vi.fn(),
  fetchOwnershipTransfers: vi.fn(),
  closeAllSockets: vi.fn(),
}));
const clientState = vi.hoisted(() => ({
  active: undefined as string | undefined,
}));
vi.mock("@/lib/api/workspaces", () => api);
vi.mock("../socket-registry", () => ({
  closeAllSockets: api.closeAllSockets,
}));
vi.mock("@/lib/api/client", async (importOriginal) => {
  // Parcial: transporte real (apiFetch/FORBIDDEN_EVENT) para a parte 2;
  // só o header em memória é observado (clientState) e ApiError é
  // construível pelo teste. workspace-context usa instanceof contra ESTA
  // classe, e o teste constrói com ela — mesma identidade.
  const actual =
    await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    isApiConfigured: () => true,
    getAuthToken: () => "user-1",
    setActiveWorkspaceId: vi.fn((id: string) => {
      clientState.active = id;
    }),
    clearActiveWorkspaceId: vi.fn(() => {
      clientState.active = undefined;
    }),
    ApiError: class ApiError extends Error {
      constructor(
        public status: number,
        public code: string,
        message: string,
      ) {
        super(message);
      }
    },
  };
});

function Probe() {
  const { activeWorkspace, workspaces, selectWorkspace, error, isAuthError } =
    useWorkspace();
  return (
    <>
      <div data-testid="active">{activeWorkspace?.name ?? "none"}</div>
      <div data-testid="error">{error ?? "no-error"}</div>
      <div data-testid="is-auth-error">{String(isAuthError ?? false)}</div>
      {workspaces.map((workspace) => (
        <button
          key={workspace.id}
          onClick={() => void selectWorkspace(workspace.id)}
        >
          {workspace.name}
        </button>
      ))}
    </>
  );
}

describe("FIX-168 RED-2c: 403 workspace_required preserva seleção/header (sem purge)", () => {
  beforeEach(() => {
    localStorage.clear();
    clientState.active = undefined;
    setOfflinePrincipalId("user-1");
    vi.clearAllMocks();
    api.fetchWorkspaces.mockResolvedValue([
      { id: "workspace-1", name: "Casa", kind: "personal", role: "owner" },
      { id: "workspace-2", name: "Equipe", kind: "shared", role: "owner" },
    ]);
    api.fetchWorkspaceMembers.mockResolvedValue([]);
    api.fetchPendingInvites.mockResolvedValue([]);
    api.fetchOwnershipTransfers.mockResolvedValue([]);
  });

  it("revalidação com 403 workspace_required restaura Casa, sem flag de auth", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active")).toHaveTextContent("Casa");

    // Revalidação server-side rejeita SEM header (stale clear mid-flight):
    // status+code do contrato real (routes/index.ts → auth.workspace_required).
    const { ApiError } = (await import("@/lib/api/client")) as unknown as {
      ApiError: new (
        status: number,
        code: string,
        message: string,
      ) => Error;
    };
    api.fetchWorkspaces.mockRejectedValueOnce(
      new ApiError(
        403,
        "auth.workspace_required",
        "Header x-workspace-id é obrigatório.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Equipe" }));

    await waitFor(() =>
      expect(screen.getByTestId("error")).not.toHaveTextContent("no-error"),
    );
    // Sem purge: a seleção anterior (membro confirmado na lista conhecida)
    // é re-afirmada em label/header; nada de fail-closed nem flag auth.
    await waitFor(() =>
      expect(screen.getByTestId("active")).toHaveTextContent("Casa"),
    );
    expect(clientState.active).toBe("workspace-1");
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("false");
  });

  it("revalidação com 403 auth.workspace_forbidden segue fail-closed com flag de auth", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active")).toHaveTextContent("Casa");

    const { ApiError } = (await import("@/lib/api/client")) as unknown as {
      ApiError: new (
        status: number,
        code: string,
        message: string,
      ) => Error;
    };
    api.fetchWorkspaces.mockRejectedValueOnce(
      new ApiError(403, "auth.workspace_forbidden", "Acesso ao workspace proibido."),
    );
    await user.click(screen.getByRole("button", { name: "Equipe" }));

    await waitFor(() =>
      expect(screen.getByTestId("active")).toHaveTextContent("none"),
    );
    expect(clientState.active).toBeUndefined();
    expect(screen.getByTestId("is-auth-error")).toHaveTextContent("true");
  });
});
