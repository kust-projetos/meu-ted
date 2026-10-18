import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { AuthGate } from "@/features/auth/AuthGate";
import { useSession } from "@/lib/auth/session-context";
import {
  resetSessionStatus,
  getSessionStatus,
} from "@/lib/auth/session-authority";
import {
  setOfflinePrincipalId,
  setOfflineWorkspaceId,
  getOfflinePrincipalId,
} from "@/lib/auth/offline-identity";
import {
  writeV3Snapshot,
  getV3OfflineLockState,
} from "@/lib/state/snapshot-db";
import { UNAUTHORIZED_EVENT, FORBIDDEN_EVENT } from "@/lib/api/client";

/**
 * T07c-F2R2-F3-F2: generation-tagged rejection side effects, REAL client
 * stack (no apiFetch mock — global fetch is the only seam, so the real
 * apiFetch rejection handlers, the real fetchSession classification and the
 * real AuthGate wiring all execute).
 *
 * - A stale probe's 401 must not expire B's session (no UNAUTHORIZED_EVENT
 *   consequence); the response itself is discarded by the reprobe epoch.
 * - A stale probe's 403 auth.workspace_forbidden must not purge B's
 *   identity/snapshots (no FORBIDDEN_EVENT consequence for B).
 * - A CURRENT 401/403 still triggers the canonical handling (covered by the
 *   existing client revocation suites; asserted here via the no-leak
 *   inverses).
 */

const PRINCIPAL_A = "user-t07c-f3-a";
const PRINCIPAL_B = "user-t07c-f3-b";
const WS_UUID = "cccccccc-dddd-4eee-8fff-111111111111";

const net = vi.hoisted(() => ({
  sessionCalls: 0,
  mode: "down" as "down" | "user" | "empty" | "generic401" | "revocation403" | "server500",
  userId: "",
  gateArmed: false,
  gateEntered: false,
  gatePromise: null as null | Promise<unknown>,
  gateResolve: null as null | ((v: unknown) => void),
  unauthorizedEvents: 0,
  forbiddenEvents: 0,
}));

function armSessionGate() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  net.gatePromise = promise;
  net.gateResolve = resolve;
  net.gateArmed = true;
  net.gateEntered = false;
}
function releaseSessionGate(value: unknown) {
  net.gateArmed = false;
  net.gateResolve?.(value);
  net.gatePromise = null;
  net.gateResolve = null;
}

function installFetchMock() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/auth/session")) {
      net.sessionCalls += 1;
      if (net.gateArmed && net.gatePromise) {
        net.gateEntered = true;
        return net.gatePromise as unknown as Response;
      }
      if (net.mode === "down") throw new TypeError("fetch failed");
      if (net.mode === "user") {
        return new Response(
          JSON.stringify({ user: { id: net.userId, email: "u@x.test", name: "U" }, session: {} }),
          { status: 200 },
        );
      }
      if (net.mode === "empty") return new Response(JSON.stringify({ user: null }), { status: 200 });
      if (net.mode === "generic401") {
        return new Response(JSON.stringify({ code: "auth.session_expired", message: "expired" }), { status: 401 });
      }
      if (net.mode === "revocation403") {
        return new Response(JSON.stringify({ code: "auth.workspace_forbidden", message: "revoked" }), { status: 403 });
      }
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    if (url.includes("/auth/sign-in/email")) {
      return new Response(JSON.stringify({ user: { email: "b@x.test" } }), { status: 200 });
    }
    if (url.includes("/auth/devices/register")) {
      return new Response(JSON.stringify({ token: "dev-b", deviceId: "d1", householdId: "h1" }), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
}

function SessionControls() {
  const { expireSession } = useSession();
  return <button onClick={() => void expireSession()}>expire-session</button>;
}

function AuthorityProbe() {
  const { session } = useSession();
  return <div data-testid="authority">{session.status}</div>;
}

async function seedValidV3(principal: string, ws: string = WS_UUID) {
  setOfflinePrincipalId(principal);
  setOfflineWorkspaceId(ws);
  await writeV3Snapshot(principal, ws, "accounts", [
    {
      id: "a1",
      name: "Conta",
      kind: "checking",
      initialBalanceCents: 0,
      status: "active",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      balanceCents: 100_00,
    },
  ] as never);
}

async function submitLoginAs(email = "b@x.test", password = "password123!") {
  const emailInput = await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
  fireEvent.change(emailInput, { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText(/••••/), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /Entrar/i }));
}

function onUnauthorized() {
  net.unauthorizedEvents += 1;
}
function onForbidden() {
  net.forbiddenEvents += 1;
}

beforeEach(async () => {
  localStorage.clear();
  resetSessionStatus();
  net.sessionCalls = 0;
  net.mode = "down";
  net.userId = PRINCIPAL_A;
  net.gateArmed = false;
  net.gateEntered = false;
  net.gatePromise = null;
  net.gateResolve = null;
  net.unauthorizedEvents = 0;
  net.forbiddenEvents = 0;
  window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  window.addEventListener(FORBIDDEN_EVENT, onForbidden);
  installFetchMock();
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3333");
  const dbs = await indexedDB.databases();
  for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
});

afterEach(() => {
  window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  window.removeEventListener(FORBIDDEN_EVENT, onForbidden);
  localStorage.clear();
  resetSessionStatus();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("T07c-F2R2-F3-F2: resposta stale não vaza side effects globais (client real)", () => {
  it("401 tardio do probe de A após login de B: sem expiração de B, resposta descartada", async () => {
    setOfflinePrincipalId(PRINCIPAL_A);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3(PRINCIPAL_A);
    render(
      <AuthGate>
        <SessionControls />
        <AuthorityProbe />
      </AuthGate>,
    );
    // Boot offline real (probe fora do ar → V3 válido → unlocked).
    expect(await screen.findByTestId("authority")).toHaveTextContent("unreachable");

    // Probe stale de A pende; expira; loga B pelo fluxo real.
    armSessionGate();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(net.gateEntered).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "expire-session" }));
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });

    net.gateArmed = false;
    net.mode = "user";
    net.userId = PRINCIPAL_B;
    await submitLoginAs();
    await waitFor(() => {
      expect(screen.getByTestId("authority")).toHaveTextContent("authenticated");
    });
    expect(getOfflinePrincipalId()).toBe(PRINCIPAL_B);

    // O 401 tardio resolve DEPOIS do login de B: sem evento global, B intacto.
    await act(async () => {
      releaseSessionGate(
        new Response(JSON.stringify({ code: "auth.session_expired", message: "expired" }), { status: 401 }),
      );
    });
    expect(net.unauthorizedEvents).toBe(0);
    expect(getSessionStatus().status).toBe("authenticated");
    expect(getOfflinePrincipalId()).toBe(PRINCIPAL_B);
    expect(screen.getByTestId("authority")).toHaveTextContent("authenticated");
  });

  it("403 workspace_forbidden tardio do probe de A após login de B: sem purge de B, sem evento", async () => {
    setOfflinePrincipalId(PRINCIPAL_A);
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3(PRINCIPAL_A);
    render(
      <AuthGate>
        <SessionControls />
        <AuthorityProbe />
      </AuthGate>,
    );
    expect(await screen.findByTestId("authority")).toHaveTextContent("unreachable");

    armSessionGate();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(net.gateEntered).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "expire-session" }));
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });

    net.gateArmed = false;
    net.mode = "user";
    net.userId = PRINCIPAL_B;
    await submitLoginAs();
    await waitFor(() => {
      expect(screen.getByTestId("authority")).toHaveTextContent("authenticated");
    });

    // Snapshot de B escrito pós-login (binding recriado como em seleção real).
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3(PRINCIPAL_B);
    await waitFor(async () => {
      expect((await getV3OfflineLockState(PRINCIPAL_B, WS_UUID)).state).toBe("ok");
    });

    // O 403-revogação tardio resolve DEPOIS do login de B.
    await act(async () => {
      releaseSessionGate(
        new Response(JSON.stringify({ code: "auth.workspace_forbidden", message: "revoked" }), { status: 403 }),
      );
    });
    expect(net.forbiddenEvents).toBe(0);
    expect(getOfflinePrincipalId()).toBe(PRINCIPAL_B);
    expect((await getV3OfflineLockState(PRINCIPAL_B, WS_UUID)).state).toBe("ok");
    expect(getSessionStatus().status).toBe("authenticated");
    expect(screen.getByTestId("authority")).toHaveTextContent("authenticated");
  });
});

describe("T07c-F2R2-F4-F1: login sem expiração intermediária invalida a geração (client real)", () => {
  it("401 tardio do probe de A após login de B sem expire: sem evento global, B intacto", async () => {
    // Boot direto para login (sem snapshot): autoridade unreachable, sem
    // shell — e sobretudo SEM nenhum expireSession no fluxo.
    render(
      <AuthGate>
        <AuthorityProbe />
      </AuthGate>,
    );
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(getSessionStatus().status).toBe("unreachable");

    // Probe stale pende; login de B acontece SEM expiração intermediária.
    armSessionGate();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(net.gateEntered).toBe(true));
    net.gateArmed = false;
    net.mode = "user";
    net.userId = PRINCIPAL_B;
    await submitLoginAs();
    await waitFor(() => {
      expect(screen.getByTestId("authority")).toHaveTextContent("authenticated");
    });
    expect(getOfflinePrincipalId()).toBe(PRINCIPAL_B);

    // O 401 tardio resolve DEPOIS do login de B: geração divergiu no bind —
    // sem UNAUTHORIZED_EVENT, sem tocar na sessão de B.
    await act(async () => {
      releaseSessionGate(
        new Response(JSON.stringify({ code: "auth.session_expired", message: "expired" }), { status: 401 }),
      );
    });
    expect(net.unauthorizedEvents).toBe(0);
    expect(getSessionStatus().status).toBe("authenticated");
    expect(getOfflinePrincipalId()).toBe(PRINCIPAL_B);
    expect(screen.getByTestId("authority")).toHaveTextContent("authenticated");
  });

  it("403 workspace_forbidden tardio do probe de A após login de B sem expire: sem purge de B", async () => {
    // Boot direto para login (sem snapshot, sem shell, sem expire).
    render(
      <AuthGate>
        <AuthorityProbe />
      </AuthGate>,
    );
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(getSessionStatus().status).toBe("unreachable");

    armSessionGate();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(net.gateEntered).toBe(true));
    net.gateArmed = false;
    net.mode = "user";
    net.userId = PRINCIPAL_B;
    await submitLoginAs();
    await waitFor(() => {
      expect(screen.getByTestId("authority")).toHaveTextContent("authenticated");
    });

    // Snapshot de B escrito pós-login (binding recriado como em seleção real).
    setOfflineWorkspaceId(WS_UUID);
    await seedValidV3(PRINCIPAL_B);
    await waitFor(async () => {
      expect((await getV3OfflineLockState(PRINCIPAL_B, WS_UUID)).state).toBe("ok");
    });

    // O 403-revogação tardio resolve DEPOIS do login de B.
    await act(async () => {
      releaseSessionGate(
        new Response(JSON.stringify({ code: "auth.workspace_forbidden", message: "revoked" }), { status: 403 }),
      );
    });
    expect(net.forbiddenEvents).toBe(0);
    expect(getOfflinePrincipalId()).toBe(PRINCIPAL_B);
    expect((await getV3OfflineLockState(PRINCIPAL_B, WS_UUID)).state).toBe("ok");
    expect(getSessionStatus().status).toBe("authenticated");
    expect(screen.getByTestId("authority")).toHaveTextContent("authenticated");
  });
});
