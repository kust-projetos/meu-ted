import "fake-indexeddb/auto";
import { renderHook, act, waitFor } from "@/lib/test-utils";
import { AppStateProvider, useAppState, mergeProfileFlags } from "../app-state-context";
import * as endpoints from "@/lib/api/endpoints";
import {
  resetSessionStatus,
  setSessionStatus,
} from "@/lib/auth/session-authority";
import { setActiveWorkspaceId } from "@/lib/api/client";
import type { Profile } from "../types";

beforeEach(async () => {
  vi.restoreAllMocks();
  resetSessionStatus();
  localStorage.clear();
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

function apiReady() {
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3001");
  localStorage.setItem("pi-finance:token", "test-token-abc");
  // V41C FIX 1: live bootstrap requires a probe-confirmed session.
  setSessionStatus({ status: "authenticated", user: { userId: "test-user" } });
  // FIX-168: bootstrap and writes additionally require an active workspace.
  setActiveWorkspaceId("test-workspace-1");
}

function mockBootstrapReads(profile: Profile | null) {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchSubscriptions").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(profile as never);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
}

const adminProfile = (overrides: Partial<Profile> = {}): Profile => ({
  householdId: "h1",
  name: "Admin",
  email: "admin@example.com",
  phone: "",
  avatarColor: "#0E8C5A",
  greetingStyle: "auto",
  updatedAt: "2026-09-06T00:00:00.000Z",
  isAdmin: true,
  ...overrides,
});

describe("mergeProfileFlags", () => {
  it("keeps the previous isAdmin when the server omits it", () => {
    const { isAdmin: _omitted, ...server } = adminProfile();
    const merged = mergeProfileFlags(adminProfile(), server as Profile);
    expect(merged.isAdmin).toBe(true);
    expect(merged.name).toBe("Admin");
  });

  it("respects an explicit server isAdmin=false", () => {
    const merged = mergeProfileFlags(adminProfile(), adminProfile({ isAdmin: false }));
    expect(merged.isAdmin).toBe(false);
  });

  it("returns the server profile untouched when there is no previous profile", () => {
    const { isAdmin: _omitted, ...server } = adminProfile();
    expect(mergeProfileFlags(null, server as Profile)).toEqual(server);
  });
});

describe("AppStateProvider — isAdmin preservation", () => {
  beforeEach(() => apiReady());

  it("saveProfile never wipes isAdmin when the PATCH projection omits it", async () => {
    mockBootstrapReads(adminProfile());
    const { isAdmin: _omitted, ...patched } = adminProfile({ name: "Admin Editado" });
    vi.spyOn(endpoints, "patchProfile").mockResolvedValue(patched as never);
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profile?.isAdmin).toBe(true);

    await act(async () => {
      await result.current.saveProfile({ name: "Admin Editado" });
    });

    expect(result.current.profile?.name).toBe("Admin Editado");
    expect(result.current.profile?.isAdmin).toBe(true);
  });

  it("bootstrap with a null profile preserves a locally saved profile", async () => {    let resolveProfile!: (value: Profile | null) => void;
    const profileGate = new Promise<Profile | null>((resolve) => {
      resolveProfile = resolve as (value: Profile | null) => void;
    });
    mockBootstrapReads(null);
    vi.mocked(endpoints.fetchProfile).mockReturnValue(profileGate as never);
    const { isAdmin: _omitted, ...patched } = adminProfile();
    vi.spyOn(endpoints, "patchProfile").mockResolvedValue(patched as never);
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });

    // Save a profile while the bootstrap is still in flight.
    await act(async () => {
      await result.current.saveProfile({ name: "Admin" });
    });
    // Bootstrap resolves with profile null (backend has no row yet).
    await act(async () => {
      resolveProfile(null);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.profile?.name).toBe("Admin");
  });

  it("refreshProfile never wipes isAdmin when the refresh projection omits it", async () => {
    mockBootstrapReads(adminProfile());
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profile?.isAdmin).toBe(true);

    const { isAdmin: _omitted, ...refreshed } = adminProfile({ name: "Admin Renomeado" });
    vi.mocked(endpoints.fetchProfile).mockResolvedValue(refreshed as never);
    await act(async () => {
      await result.current.refreshProfile();
    });

    expect(result.current.profile?.name).toBe("Admin Renomeado");
    expect(result.current.profile?.isAdmin).toBe(true);
  });
});
