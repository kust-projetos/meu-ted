/**
 * Stale workspace load suppression (reviewer HIGH finding) + switch-failure
 * coherence + purge/binding ordering.
 *
 * Contracts under test:
 * - a `fetchWorkspaces()` started under principal A that resolves AFTER a
 *   logout/login as principal B applies NOTHING — no setState, no API client
 *   header write, no preference write under B;
 * - a `selectWorkspace` whose post-purge revalidation REJECTS restores a
 *   coherent safe state (label/header/binding/preference agree) and surfaces
 *   a modeled error — it never rejects into `void` callers;
 * - B's binding/preference written while A's IndexedDB purge is still
 *   deferred survives the purge (the purge's localStorage teardown always
 *   runs before a later task can bind; the deferred IDB deletes never touch
 *   localStorage keys and this path never touches the preference).
 *
 * Ordering uses deferred-promise barriers (no timer-based races): every
 * "resolve X then assert" step gates on the deferred it resolves, and
 * settling is observed through rendered state / spies, never sleeps.
 *
 * Membership validation, the preference design, and `clearWorkspaceBinding`
 * on switch are preserved — only staleness suppression is asserted here.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import "fake-indexeddb/auto";
import { render, screen, waitFor } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { WorkspaceProvider, useWorkspace } from "../workspace-context";
import {
  clearActiveWorkspacePreference,
  readActiveWorkspacePreference,
  writeActiveWorkspacePreference,
} from "../active-workspace-preference";
import {
  getOfflinePrincipalId,
  getOfflineWorkspaceId,
  setOfflinePrincipalId,
  setOfflineWorkspaceId,
} from "../offline-identity";
import { getOfflineSubjectId } from "../offline-subject";
import {
  getLastOnlineAuthenticatedAt,
  stampLastOnlineAuthenticatedAt,
} from "@/lib/session";

/** Deferred-promise barrier: resolve/reject the gated work deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Captures whether selectWorkspace resolved (modeled error) or rejected. */
const selectCapture = { status: "idle" };

const sessionCtl = vi.hoisted(() => ({
  clearSensitiveSession: vi.fn(),
  passthrough: null as unknown as (options: object) => Promise<void>,
}));
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  sessionCtl.passthrough = actual.clearSensitiveSession as (options: object) => Promise<void>;
  sessionCtl.clearSensitiveSession.mockImplementation((options: object) =>
    sessionCtl.passthrough(options),
  );
  return { ...actual, clearSensitiveSession: sessionCtl.clearSensitiveSession };
});

const api = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceMembers: vi.fn(),
  fetchPendingInvites: vi.fn(),
  fetchOwnershipTransfers: vi.fn(),
  createWorkspace: vi.fn(),
  closeAllSockets: vi.fn(),
}));
const clientState = vi.hoisted(() => ({ active: undefined as string | undefined }));
const snapshotCtl = vi.hoisted(() => ({
  deleteV2Snapshot: vi.fn(),
  deleteV3Snapshot: vi.fn(),
  passthroughV2: null as unknown as () => Promise<void>,
  passthroughV3: null as unknown as () => Promise<void>,
}));
vi.mock("@/lib/state/snapshot-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/snapshot-db")>();
  snapshotCtl.passthroughV2 = actual.deleteV2Snapshot;
  snapshotCtl.passthroughV3 = actual.deleteV3Snapshot;
  return {
    ...actual,
    deleteV2Snapshot: (...args: []) => snapshotCtl.deleteV2Snapshot(...args),
    deleteV3Snapshot: (...args: []) => snapshotCtl.deleteV3Snapshot(...args),
  };
});
vi.mock("@/lib/api/workspaces", () => api);
vi.mock("../socket-registry", () => ({ closeAllSockets: api.closeAllSockets }));
vi.mock("@/lib/api/client", async () => {
  // Faithful to the real choke point (client.ts setActiveWorkspaceId): the
  // header write also partitions the offline subject + workspace binding.
  const { setOfflineWorkspaceId } = await import("../offline-identity");
  const { setOfflineSubjectId } = await import("../offline-subject");
  return {
    isApiConfigured: () => true,
    getAuthToken: () => "token",
    setActiveWorkspaceId: vi.fn((id: string) => {
      clientState.active = id;
      try {
        setOfflineSubjectId(id);
      } catch {
        /* noop */
      }
      try {
        setOfflineWorkspaceId(id);
      } catch {
        /* noop */
      }
    }),
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
  };
});

const WS_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const WS_A2 = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb";

function Probe() {
  const { activeWorkspace, workspaces, refreshWorkspaces, selectWorkspace, createWorkspace, error, isAuthError } = useWorkspace();
  return (
    <>
      <div data-testid="active-id">{activeWorkspace?.id ?? "none"}</div>
      <div data-testid="active-name">{activeWorkspace?.name ?? "none"}</div>
      <div data-testid="provider-error">{error ?? "no-error"}</div>
      <div data-testid="provider-auth">{isAuthError ? "auth" : "ok"}</div>
      <button onClick={() => void refreshWorkspaces().catch(() => {})}>Refresh</button>
      <button onClick={() => void createWorkspace({ name: "Novo Espaço", kind: "shared" })}>Create shared</button>
      {workspaces.map((workspace) => (
        <button key={workspace.id} onClick={() => void selectWorkspace(workspace.id)}>
          {workspace.name}
        </button>
      ))}
    </>
  );
}

/**
 * Select driver that records the promise outcome: "resolved" proves the
 * modeled-error contract (no rejection escapes into `void` callers).
 */
function SelectCaptureProbe({ targetId }: { targetId: string }) {
  const { selectWorkspace } = useWorkspace();
  return (
    <button
      onClick={() => {
        selectCapture.status = "pending";
        void selectWorkspace(targetId).then(
          () => {
            selectCapture.status = "resolved";
          },
          () => {
            selectCapture.status = "rejected";
          },
        );
      }}
    >
      Capture {targetId}
    </button>
  );
}

describe("WorkspaceProvider — stale load suppression on principal switch", () => {
  beforeEach(async () => {
    localStorage.clear();
    clientState.active = undefined;
    api.fetchWorkspaces.mockReset();
    api.createWorkspace.mockReset();
    api.fetchWorkspaceMembers.mockResolvedValue([]);
    api.fetchPendingInvites.mockResolvedValue([]);
    api.fetchOwnershipTransfers.mockResolvedValue([]);
    api.closeAllSockets.mockClear();
    sessionCtl.clearSensitiveSession.mockReset();
    sessionCtl.clearSensitiveSession.mockImplementation((options: object) =>
      sessionCtl.passthrough(options),
    );
    snapshotCtl.deleteV2Snapshot.mockReset();
    snapshotCtl.deleteV3Snapshot.mockReset();
    snapshotCtl.deleteV2Snapshot.mockImplementation(() => snapshotCtl.passthroughV2());
    snapshotCtl.deleteV3Snapshot.mockImplementation(() => snapshotCtl.passthroughV3());
    selectCapture.status = "idle";
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
  });

  it("boot: a fetch started as A resolving after login as B applies nothing", async () => {
    setOfflinePrincipalId("user-A");
    let resolveBootFetch!: (value: unknown) => void;
    api.fetchWorkspaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBootFetch = resolve;
        }),
    );
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(screen.getByText("Carregando workspaces…")).toBeInTheDocument();

    // Logout/login as B lands while A's fetch is still in flight.
    clearActiveWorkspacePreference();
    setOfflinePrincipalId("user-B");

    await act(async () => {
      resolveBootFetch([
        { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      ]);
    });
    // Deterministic settle: the stale boot writes nothing and its finally
    // releases the spinner — the spinner going away IS the settle signal
    // (no timer sleep).
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    expect(screen.queryByText("Casa A")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-id")).toHaveTextContent("none");
    expect(clientState.active).toBeUndefined();
    expect(readActiveWorkspacePreference("user-A")).toBeNull();
    expect(readActiveWorkspacePreference("user-B")).toBeNull();
    expect(sessionCtl.clearSensitiveSession).not.toHaveBeenCalled();
  });

  it("refresh: a fetch started as A resolving after switch to B changes neither header nor B's preference", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);

    let resolveRefresh!: (value: unknown) => void;
    api.fetchWorkspaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));

    // Logout/login as B lands mid-flight; B already bound its own workspace.
    clearActiveWorkspacePreference();
    setOfflinePrincipalId("user-B");
    expect(writeActiveWorkspacePreference("user-B", WS_B)).toBe(true);
    clientState.active = WS_B;

    // The stale A response no longer lists the current workspace, so without
    // the guard it would force an auto-switch plus header/preference writes.
    // Deterministic settle: resolving the gate inside act drains the stale
    // continuation (stale → return, no writes) before assertions run.
    await act(async () => {
      resolveRefresh([
        { id: WS_A2, name: "Stale A", kind: "personal", role: "owner", status: "active" },
      ]);
    });

    expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A");
    expect(clientState.active).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-B")).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-A")).toBeNull();
    expect(sessionCtl.clearSensitiveSession).not.toHaveBeenCalled();
  });

  it("refresh: a switch landing during the awaited revocation purge still suppresses writes", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));

    // The revocation purge is awaited: switch identity from inside it, then
    // run the real purge (workspace-side teardown preserves the new principal).
    sessionCtl.clearSensitiveSession.mockImplementationOnce(async (options: object) => {
      clearActiveWorkspacePreference();
      setOfflinePrincipalId("user-B");
      expect(writeActiveWorkspacePreference("user-B", WS_B)).toBe(true);
      clientState.active = WS_B;
      await sessionCtl.passthrough(options);
    });

    let resolveRefresh!: (value: unknown) => void;
    api.fetchWorkspaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveRefresh([
        { id: WS_A2, name: "Stale A", kind: "personal", role: "owner", status: "active" },
      ]);
    });
    await waitFor(() =>
      expect(sessionCtl.clearSensitiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ clearWorkspaceBinding: true }),
      ),
    );
    // Deterministic settle past the purge continuation: the spinner the
    // refresh path never raised stays absent and the label never flashes.
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A");
    expect(clientState.active).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-B")).toBe(WS_B);
  });

  it("selectWorkspace: a logout/login as B during the purge commits nothing under B", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);

    // Logout/login as B lands DURING the awaited switch purge; B already
    // bound its own workspace before the stale selection resumes.
    sessionCtl.clearSensitiveSession.mockImplementationOnce(async (options: object) => {
      clearActiveWorkspacePreference();
      setOfflinePrincipalId("user-B");
      expect(writeActiveWorkspacePreference("user-B", WS_B)).toBe(true);
      clientState.active = WS_B;
      await sessionCtl.passthrough(options);
    });

    await user.click(screen.getByRole("button", { name: "Equipe A" }));
    await waitFor(() =>
      expect(sessionCtl.clearSensitiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ clearWorkspaceBinding: true }),
      ),
    );
    // Deterministic settle: the stale selection releases the spinner without
    // committing — spinner gone proves the continuation ran.
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    // The stale selection validated under A never becomes B's header or
    // preference; the spinner is released without flashing the destination.
    expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A");
    expect(clientState.active).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-B")).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-A")).toBeNull();
  });

  it("selectWorkspace: a refresh started before the manual switch cannot overwrite the selection", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));

    // A refresh stays in flight while the manual switch starts — the switch
    // generation invalidates it.
    let resolveRefresh!: (value: unknown) => void;
    api.fetchWorkspaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Equipe A" }));
    await waitFor(() => expect(clientState.active).toBe(WS_A2));
    expect(screen.getByTestId("active-name")).toHaveTextContent("Equipe A");

    // The stale refresh resolves with a list that no longer contains the
    // selection — without the generation guard it would force an auto-switch
    // plus header/preference rewrites back to the old workspace.
    // Deterministic settle: resolving the gate inside act drains the stale
    // continuation before the coherence assertions run.
    await act(async () => {
      resolveRefresh([
        { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      ]);
    });

    expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-name")).toHaveTextContent("Equipe A");
    expect(clientState.active).toBe(WS_A2);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A2);
  });

  it("selectWorkspace: a destination removed server-side is not resurrected by the selection", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));

    // Access to the destination is revoked before the switch revalidates:
    // the server list no longer contains it.
    api.fetchWorkspaces.mockResolvedValueOnce([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
    ]);

    await user.click(screen.getByRole("button", { name: "Equipe A" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A"));

    // The revoked destination is never activated, headered, or persisted —
    // the provider adopts the server truth with no stuck spinner.
    expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument();
    expect(clientState.active).toBe(WS_A);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
  });

  it("selectWorkspace: a destination archived server-side is not resurrected by the selection", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));

    // The destination still exists server-side but is archived — ineligible.
    api.fetchWorkspaces.mockResolvedValueOnce([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "archived" },
    ]);

    await user.click(screen.getByRole("button", { name: "Equipe A" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A"));

    expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument();
    expect(clientState.active).toBe(WS_A);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
  });

  it("selectWorkspace: a rejected post-purge revalidation restores the previous workspace and resolves with a modeled error", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
        <SelectCaptureProbe targetId={WS_A2} />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
    expect(getOfflineWorkspaceId()).toBe(WS_A);

    // The post-purge server revalidation hangs behind a deferred barrier.
    const revalGate = deferred<unknown[]>();
    api.fetchWorkspaces.mockImplementationOnce(() => revalGate.promise);

    await user.click(screen.getByRole("button", { name: /Capture/ }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));
    // Mid-flight: the header is cleared (purge ran) while the label still
    // names the previous workspace — the window the restore must close.
    expect(clientState.active).toBeUndefined();
    expect(selectCapture.status).toBe("pending");

    await act(async () => {
      revalGate.reject(new Error("Network down"));
    });
    // The failure resolves (modeled error), it never rejects.
    await waitFor(() => expect(selectCapture.status).toBe("resolved"));
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    // Coherent restore: label, header, offline binding, and preference all
    // agree on Casa A again — no silent label/header divergence…
    expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A");
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_A);
    expect(clientState.active).toBe(WS_A);
    expect(getOfflinePrincipalId()).toBe("user-A");
    expect(getOfflineWorkspaceId()).toBe(WS_A);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
    // …and the failure surfaces as modeled error state, not a rejection.
    expect(screen.getByTestId("provider-error")).toHaveTextContent("Network down");
    expect(screen.getByTestId("provider-auth")).toHaveTextContent("ok");
  });

  it.each([
    { status: 401, message: "Unauthorized" },
    { status: 403, message: "Forbidden" },
  ])(
    "selectWorkspace: an auth rejection ($status) on revalidation fails closed and flags the auth error",
    async ({ status, message }) => {
      const user = userEvent.setup();
      setOfflinePrincipalId("user-A");
      api.fetchWorkspaces.mockResolvedValue([
        { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
        { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
      ]);
      render(
        <WorkspaceProvider>
          <Probe />
          <SelectCaptureProbe targetId={WS_A2} />
        </WorkspaceProvider>,
      );
      expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
      await waitFor(() => expect(clientState.active).toBe(WS_A));

      const revalGate = deferred<unknown[]>();
      api.fetchWorkspaces.mockImplementationOnce(() => revalGate.promise);

      await user.click(screen.getByRole("button", { name: /Capture/ }));
      await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));
      expect(clientState.active).toBeUndefined();

      await act(async () => {
        revalGate.reject(Object.assign(new Error(message), { status }));
      });
      await waitFor(() => expect(selectCapture.status).toBe("resolved"));
      await waitFor(() =>
        expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
      );

      // Fail-closed: the previous binding is no longer server-confirmed, so
      // it is never restored — no label/header/binding/preference names it.
      expect(status === 401 || status === 403).toBe(true);
      expect(screen.getByTestId("active-name")).toHaveTextContent("none");
      expect(screen.getByTestId("active-id")).toHaveTextContent("none");
      expect(clientState.active).toBeUndefined();
      expect(getOfflineWorkspaceId()).toBeNull();
      expect(readActiveWorkspacePreference("user-A")).toBeNull();
      expect(screen.getByTestId("provider-error")).toHaveTextContent(message);
      expect(screen.getByTestId("provider-auth")).toHaveTextContent("auth");
    },
  );

  it.each([
    { status: 401, message: "Unauthorized" },
    { status: 403, message: "Forbidden" },
  ])(
    "selectWorkspace: same-current selection with an auth rejection ($status) clears the offline workspace binding",
    async ({ status, message }) => {
      const user = userEvent.setup();
      setOfflinePrincipalId("user-A");
      api.fetchWorkspaces.mockResolvedValue([
        { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
        { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
      ]);
      render(
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>,
      );
      expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
      await waitFor(() => expect(clientState.active).toBe(WS_A));
      expect(getOfflineWorkspaceId()).toBe(WS_A);
      expect(getOfflineSubjectId()).toBe(WS_A);
      expect(stampLastOnlineAuthenticatedAt()).toBe(true);
      sessionCtl.clearSensitiveSession.mockClear();

      // Same-current click skips the pre-revalidation purge: the 401/403
      // below must still clear the workspace-side offline binding (binding
      // + subject + age stamp) while preserving the principal.
      const revalGate = deferred<unknown[]>();
      api.fetchWorkspaces.mockImplementationOnce(() => revalGate.promise);

      await user.click(screen.getByRole("button", { name: "Casa A" }));
      await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));

      await act(async () => {
        revalGate.reject(Object.assign(new Error(message), { status }));
      });
      await waitFor(() =>
        expect(screen.getByTestId("provider-error")).toHaveTextContent(message),
      );
      await waitFor(() =>
        expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
      );

      // Fail-closed with full workspace-side teardown: no label/header/
      // binding/subject/stamp/preference names the revoked workspace, the
      // principal survives for rebinding, and the auth error is flagged.
      expect(screen.getByTestId("active-name")).toHaveTextContent("none");
      expect(screen.getByTestId("active-id")).toHaveTextContent("none");
      expect(clientState.active).toBeUndefined();
      expect(getOfflineWorkspaceId()).toBeNull();
      expect(getOfflineSubjectId()).toBeNull();
      expect(getLastOnlineAuthenticatedAt()).toBeNull();
      expect(getOfflinePrincipalId()).toBe("user-A");
      expect(readActiveWorkspacePreference("user-A")).toBeNull();
      expect(screen.getByTestId("provider-auth")).toHaveTextContent("auth");
      expect(sessionCtl.clearSensitiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ clearWorkspaceBinding: true }),
      );
    },
  );

  it("createWorkspace: refresh+select via the captured callback selects the newly created workspace", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    const WS_NEW = "cccccccc-4444-4444-8444-cccccccccccc";
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));

    // Server creates the workspace; every later list includes it. The
    // createWorkspace flow (refresh + select with the callback captured
    // BEFORE the refresh) must still validate membership on the fresh list
    // and commit the new workspace — never reject on the stale captured list.
    api.createWorkspace.mockResolvedValue({
      id: WS_NEW,
      name: "Novo Espaço",
      kind: "shared",
      role: "owner",
      status: "active",
    });
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_NEW, name: "Novo Espaço", kind: "shared", role: "owner", status: "active" },
    ]);

    await user.click(screen.getByRole("button", { name: "Create shared" }));
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("active-name")).toHaveTextContent("Novo Espaço"));

    expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_NEW);
    expect(clientState.active).toBe(WS_NEW);
    expect(getOfflineWorkspaceId()).toBe(WS_NEW);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_NEW);
    expect(screen.getByTestId("provider-error")).toHaveTextContent("no-error");
    expect(screen.getByTestId("provider-auth")).toHaveTextContent("ok");
  });

  it("createWorkspace: a manual selection landing while create is pending wins (no overwrite)", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    const WS_NEW = "cccccccc-4444-4444-8444-cccccccccccc";
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));

    // The server-side create hangs behind a deferred barrier.
    const createGate = deferred<{ id: string; name: string; kind: "shared"; role: string; status: string }>();
    api.createWorkspace.mockImplementationOnce(() => createGate.promise);

    await user.click(screen.getByRole("button", { name: "Create shared" }));
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledTimes(1));

    // While the create is pending, the user manually selects the existing
    // Equipe A workspace — its generation must own provider state from here.
    await user.click(screen.getByRole("button", { name: "Equipe A" }));
    await waitFor(() => expect(screen.getByTestId("active-name")).toHaveTextContent("Equipe A"));
    await waitFor(() => expect(clientState.active).toBe(WS_A2));
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A2);
    const fetchCallsAfterSelect = api.fetchWorkspaces.mock.calls.length;

    // The server did create the workspace under A; later lists include it.
    // A stale create must still not refresh/select over the newer selection —
    // the list below is visible on purpose so a buggy flow WOULD select NEW.
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
      { id: WS_NEW, name: "Novo Espaço", kind: "shared", role: "owner", status: "active" },
    ]);

    // Deterministic settle: resolving the gate inside act drains the stale
    // create continuation (stale → return, no refresh/select) before asserts.
    await act(async () => {
      createGate.resolve({
        id: WS_NEW,
        name: "Novo Espaço",
        kind: "shared",
        role: "owner",
        status: "active",
      });
    });
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    // B (the manual selection) remains active everywhere; the created
    // workspace is never auto-selected and triggers no extra fetches.
    expect(api.fetchWorkspaces.mock.calls.length).toBe(fetchCallsAfterSelect);
    expect(screen.getByTestId("active-name")).toHaveTextContent("Equipe A");
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_A2);
    expect(clientState.active).toBe(WS_A2);
    expect(getOfflineWorkspaceId()).toBe(WS_A2);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A2);
    expect(screen.queryByText("Novo Espaço")).not.toBeInTheDocument();
  });

  it("createWorkspace: a logout/login landing while create is pending writes nothing under B", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    const WS_NEW = "cccccccc-4444-4444-8444-cccccccccccc";
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
    const fetchCallsAfterBoot = api.fetchWorkspaces.mock.calls.length;

    const createGate = deferred<{ id: string; name: string; kind: "shared"; role: string; status: string }>();
    api.createWorkspace.mockImplementationOnce(() => createGate.promise);

    await user.click(screen.getByRole("button", { name: "Create shared" }));
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledTimes(1));

    // Logout/login as B lands mid-flight; B already bound its own workspace
    // (header + offline binding + preference) before the stale create resumes.
    clearActiveWorkspacePreference();
    setOfflinePrincipalId("user-B");
    expect(writeActiveWorkspacePreference("user-B", WS_B)).toBe(true);
    expect(setOfflineWorkspaceId(WS_B)).toBe(true);
    clientState.active = WS_B;

    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_NEW, name: "Novo Espaço", kind: "shared", role: "owner", status: "active" },
    ]);

    // The workspace was created server-side under A, but identity already
    // changed — the stale create must stop with no refresh/select and no
    // header/preference/binding write for A into B. No destructive cleanup.
    await act(async () => {
      createGate.resolve({
        id: WS_NEW,
        name: "Novo Espaço",
        kind: "shared",
        role: "owner",
        status: "active",
      });
    });
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    expect(api.fetchWorkspaces.mock.calls.length).toBe(fetchCallsAfterBoot);
    expect(clientState.active).toBe(WS_B);
    expect(getOfflineWorkspaceId()).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-B")).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-A")).toBeNull();
    expect(screen.queryByText("Novo Espaço")).not.toBeInTheDocument();
    expect(sessionCtl.clearSensitiveSession).not.toHaveBeenCalled();
  });

  it("selectWorkspace: a B binding written while the IDB purge is deferred survives the purge", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));
    expect(getOfflineWorkspaceId()).toBe(WS_A);

    // Defer ONLY the truly-async purge work (IndexedDB deletes): the
    // localStorage teardown runs at call time, before B can bind.
    const idbGate = deferred<void>();
    snapshotCtl.deleteV2Snapshot.mockImplementationOnce(() => idbGate.promise);
    snapshotCtl.deleteV3Snapshot.mockImplementationOnce(() => idbGate.promise);

    await user.click(screen.getByRole("button", { name: "Equipe A" }));
    await waitFor(() => expect(snapshotCtl.deleteV2Snapshot).toHaveBeenCalled());
    // The synchronous binding teardown already ran — A's binding is gone
    // while the IDB purge is still deferred behind the barrier.
    expect(getOfflineWorkspaceId()).toBeNull();

    // Login as B lands mid-purge and binds fresh state.
    setOfflinePrincipalId("user-B");
    expect(writeActiveWorkspacePreference("user-B", WS_B)).toBe(true);
    expect(setOfflineWorkspaceId(WS_B)).toBe(true);
    expect(stampLastOnlineAuthenticatedAt()).toBe(true);
    clientState.active = WS_B;

    await act(async () => {
      idbGate.resolve();
    });
    // A's stale continuation releases the spinner without touching B.
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    // B's fresh binding, preference, age stamp, and header all survive A's
    // purge; A's label never becomes B's header or preference.
    expect(getOfflinePrincipalId()).toBe("user-B");
    expect(getOfflineWorkspaceId()).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-B")).toBe(WS_B);
    expect(getLastOnlineAuthenticatedAt()).not.toBeNull();
    expect(clientState.active).toBe(WS_B);
    expect(readActiveWorkspacePreference("user-A")).toBeNull();
    expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A");
  });

  it("selectWorkspace with no active workspace still revalidates the destination on the server", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));

    // Phase 1: a failed switch clears the selection but keeps the stale list.
    // Clear the principal BEFORE the selection starts (stale stored session):
    // startPrincipal is null, so the catch path is not stale yet cannot
    // restore `current` and fails closed on no workspace.
    localStorage.removeItem("pi-finance:offline-principal");
    api.fetchWorkspaces.mockImplementationOnce(() =>
      Promise.reject(new Error("Network down")),
    );
    await user.click(screen.getByRole("button", { name: "Equipe A" }));
    await waitFor(() =>
      expect(screen.getByTestId("active-name")).toHaveTextContent("none"),
    );
    expect(clientState.active).toBeUndefined();
    expect(screen.getByTestId("provider-error")).toHaveTextContent("Network down");
    // The stale list is kept, so the revoked destination button is still rendered.
    expect(screen.getByRole("button", { name: "Equipe A" })).toBeInTheDocument();

    // Phase 2: with no active workspace, the destination must still be
    // revalidated — the server no longer lists it, so it must never activate.
    setOfflinePrincipalId("user-A");
    sessionCtl.clearSensitiveSession.mockClear();
    api.fetchWorkspaces.mockResolvedValueOnce([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
    ]);
    await user.click(screen.getByRole("button", { name: "Equipe A" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    // Coherent fallback: server truth adopted, revoked destination never
    // becomes label/header/preference; no purge runs without a selection.
    expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A");
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_A);
    expect(clientState.active).toBe(WS_A);
    expect(getOfflineWorkspaceId()).toBe(WS_A);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
    expect(sessionCtl.clearSensitiveSession).not.toHaveBeenCalled();
  });

  it("selectWorkspace: selecting the active workspace revalidates against the fresh server list without a switch purge", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);

    // The server renamed the active workspace: a same-active click must
    // refresh the list (new label) instead of early-returning on the cache.
    api.fetchWorkspaces.mockResolvedValueOnce([
      { id: WS_A, name: "Casa A Renomeada", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    sessionCtl.clearSensitiveSession.mockClear();
    api.closeAllSockets.mockClear();

    await user.click(screen.getByRole("button", { name: "Casa A" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    // Still-valid same-active: list updated, header/preference reasserted,
    // error cleared — with no switch purge (no teardown for the same room).
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_A);
    expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A Renomeada");
    expect(clientState.active).toBe(WS_A);
    expect(getOfflineWorkspaceId()).toBe(WS_A);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
    expect(screen.getByTestId("provider-error")).toHaveTextContent("no-error");
    expect(sessionCtl.clearSensitiveSession).not.toHaveBeenCalled();
    expect(api.closeAllSockets).not.toHaveBeenCalled();
  });

  it("selectWorkspace: an active workspace revoked since the cached list falls back instead of staying selected", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));

    // Membership in the active workspace was revoked since the cached list:
    // the fresh server list no longer contains it.
    api.fetchWorkspaces.mockResolvedValueOnce([
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    sessionCtl.clearSensitiveSession.mockClear();
    api.closeAllSockets.mockClear();

    await user.click(screen.getByRole("button", { name: "Casa A" }));
    await waitFor(() => expect(api.fetchWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("active-name")).toHaveTextContent("Equipe A"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    // Fail-over to the server truth: the revoked id never becomes
    // label/header/preference again; the auto-switch teardown ran.
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_A2);
    expect(clientState.active).toBe(WS_A2);
    expect(getOfflineWorkspaceId()).toBe(WS_A2);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A2);
    expect(api.closeAllSockets).toHaveBeenCalledWith("workspace access revoked");
    expect(sessionCtl.clearSensitiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ clearWorkspaceBinding: true }),
    );
  });

  it.each([
    { status: 401, message: "Unauthorized" },
    { status: 403, message: "Forbidden" },
  ])(
    "refreshWorkspaces: an auth rejection ($status) fails closed and clears header/state/preference/binding",
    async ({ status, message }) => {
      const user = userEvent.setup();
      setOfflinePrincipalId("user-A");
      api.fetchWorkspaces.mockResolvedValue([
        { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
        { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
      ]);
      render(
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>,
      );
      expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
      await waitFor(() => expect(clientState.active).toBe(WS_A));
      expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
      expect(getOfflineWorkspaceId()).toBe(WS_A);

      api.fetchWorkspaces.mockRejectedValueOnce(
        Object.assign(new Error(message), { status }),
      );
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() =>
        expect(screen.getByTestId("provider-error")).toHaveTextContent(message),
      );
      await waitFor(() =>
        expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
      );

      // Fail-closed: no label/header/binding/preference names the previously
      // validated workspace; the auth error is flagged.
      expect(screen.getByTestId("active-name")).toHaveTextContent("none");
      expect(screen.getByTestId("active-id")).toHaveTextContent("none");
      expect(clientState.active).toBeUndefined();
      expect(getOfflineWorkspaceId()).toBeNull();
      expect(readActiveWorkspacePreference("user-A")).toBeNull();
      expect(screen.getByTestId("provider-auth")).toHaveTextContent("auth");
    },
  );

  it("refreshWorkspaces: a non-auth network failure preserves the previously validated active workspace", async () => {
    const user = userEvent.setup();
    setOfflinePrincipalId("user-A");
    api.fetchWorkspaces.mockResolvedValue([
      { id: WS_A, name: "Casa A", kind: "personal", role: "owner", status: "active" },
      { id: WS_A2, name: "Equipe A", kind: "shared", role: "owner", status: "active" },
    ]);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId("active-name")).toHaveTextContent("Casa A");
    await waitFor(() => expect(clientState.active).toBe(WS_A));
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);

    api.fetchWorkspaces.mockRejectedValueOnce(new Error("Network down"));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(screen.getByTestId("provider-error")).toHaveTextContent("Network down"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Carregando workspaces…")).not.toBeInTheDocument(),
    );

    // Non-auth failure: the last validated selection stays committed.
    expect(screen.getByTestId("active-name")).toHaveTextContent("Casa A");
    expect(screen.getByTestId("active-id")).toHaveTextContent(WS_A);
    expect(clientState.active).toBe(WS_A);
    expect(getOfflineWorkspaceId()).toBe(WS_A);
    expect(readActiveWorkspacePreference("user-A")).toBe(WS_A);
    expect(screen.getByTestId("provider-auth")).toHaveTextContent("ok");
  });
});
