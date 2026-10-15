import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthGate } from "../AuthGate";
import { AppStateProvider, useAppState } from "@/lib/state/app-state-context";
import { setActiveWorkspaceId } from "@/lib/api/client";
import * as endpoints from "@/lib/api/endpoints";

/**
 * V4.1 Closure (SPEC AUTH-T01 / AUTH-T02, Plano Phase 1 — RED).
 *
 * Reproduz o gap real F1: `AuthGate` destrava com sessão cookie-only, mas o
 * `AppStateProvider` não executa o bootstrap porque `apiUsable()` exige
 * bearer em storage (`app-state-context.tsx:376-380`). Com compat OFF os
 * getters da token-store retornam null sempre, então o gate nunca abre.
 *
 * Estes testes compõem AuthGate + AppStateProvider (o caminho real de boot)
 * e devem FALHAR pelo gate de bearer antes da correção (Phase 2), não por
 * erro de import/mock.
 */

// ─── localStorage mock (mesmo padrão de AuthGate.test.tsx) ─────────────────
const store: Record<string, string> = {};

function sessionOkFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/auth/session")) {
      return new Response(
        JSON.stringify({ user: { id: "u1", email: "walis@example.com", name: "W" } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
}

function mockApiReads() {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([
    {
      id: "a1",
      name: "API Nubank",
      kind: "checking",
      initialBalanceCents: 0,
      status: "active",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      balanceCents: 500_00,
    },
  ]);
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchDashboardSummary").mockResolvedValue(null as never);
}

function BootstrapProbe() {
  const { accounts, loading } = useAppState();
  return (
    <div data-testid="cookie-bootstrap-probe">
      {loading ? "loading" : `accounts:${accounts.length}`}
    </div>
  );
}

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  vi.spyOn(window.localStorage, "getItem").mockImplementation(
    (k) => store[String(k)] ?? null,
  );
  vi.spyOn(window.localStorage, "setItem").mockImplementation((k, v) => {
    store[String(k)] = String(v);
  });
  vi.spyOn(window.localStorage, "removeItem").mockImplementation((k) => {
    delete store[String(k)];
  });
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3333");
  sessionOkFetch();
  mockApiReads();
  // FIX-168: AuthGate publishes the session, but the financial bootstrap
  // additionally requires the active-workspace header WorkspaceProvider sets
  // in production (absent here — this composition mounts AppState directly).
  setActiveWorkspaceId("test-workspace-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Cookie-only bootstrap (AUTH-T01 / AUTH-T02 — RED)", () => {
  it("AUTH-T01: compat OFF + cookie válido + zero bearers → AuthGate destrava E bootstrap executa", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_BEARER_COMPAT", "off");
    expect(store["pi-finance:token"]).toBeUndefined();
    expect(store["pi-finance:session-token"]).toBeUndefined();

    render(
      <AuthGate>
        <AppStateProvider>
          <BootstrapProbe />
        </AppStateProvider>
      </AuthGate>,
    );

    // AuthGate destravou (metade cookie-first já funciona)…
    const probe = await screen.findByTestId("cookie-bootstrap-probe", {}, { timeout: 3000 });
    expect(probe).toBeInTheDocument();

    // …mas o bootstrap financeiro precisa executar sem nenhum bearer em storage.
    // (waitFor: o probe monta em "loading" antes do load() assíncrono chamar
    // os endpoints.)
    await waitFor(() => expect(endpoints.fetchAccounts).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() =>
      expect(screen.getByTestId("cookie-bootstrap-probe")).toHaveTextContent("accounts:1"),
    );
  });

  it("AUTH-T02: cookie válido + device token ausente → bootstrap executa", async () => {
    // Compat ON (default), mas nenhum token persistido: nem device, nem sessão.
    expect(store["pi-finance:token"] ?? null).toBeNull();
    expect(store["pi-finance:session-token"] ?? null).toBeNull();

    render(
      <AuthGate>
        <AppStateProvider>
          <BootstrapProbe />
        </AppStateProvider>
      </AuthGate>,
    );

    const probe = await screen.findByTestId("cookie-bootstrap-probe", {}, { timeout: 3000 });
    expect(probe).toBeInTheDocument();

    // Bootstrap não pode exigir device token: só a sessão cookie + autoridade.
    expect(localStorage.getItem("pi-finance:token")).toBeNull();
    await waitFor(() => expect(endpoints.fetchAccounts).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() =>
      expect(screen.getByTestId("cookie-bootstrap-probe")).toHaveTextContent("accounts:1"),
    );
  });
});
