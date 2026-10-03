// Tests for clearSensitiveSession and useSession.
// Restores the original behavioral coverage (committed at 1e233a2) and retains
// the granular flag-level / failure-isolation tests added later — no behavioral
// test lost.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import "fake-indexeddb/auto";
import { getToken, setToken } from "@/lib/auth/token-store";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";
import { clearSensitiveSession } from "./session";
import { useSession } from "@/lib/auth/session-context";
import { writeV2Snapshot, readV2Snapshot } from "@/lib/state/snapshot-db";

const SNAPSHOT_KEY = "pi-finance:snapshot:v1";
const PROFILE_KEY = "pi-finance:profile";

function seedSnapshot(token: string) {
  localStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({
      version: 1,
      token,
      syncedAt: { accounts: "2026-07-13T00:00:00.000Z" },
      data: { accounts: [] },
    }),
  );
}

function seedProfile() {
  localStorage.setItem(
    PROFILE_KEY,
    JSON.stringify({
      householdId: "hh-test",
      name: "Test User",
      email: "",
      phone: "",
      avatarColor: "#0E8C5A",
      greetingStyle: "auto",
      updatedAt: "2026-07-13T00:00:00.000Z",
    }),
  );
}

describe("clearSensitiveSession", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    // T2.6 contract: v2 reads verify the subject partition.
    setOfflineSubjectId("44444444-5555-4666-8777-888888888888");
  });

  it("removes token, v1 snapshot, and profile; does NOT delete Cache Storage", async () => {
    setToken("test-token-sec");
    seedSnapshot("test-token-sec");
    seedProfile();

    expect(getToken()).toBe("test-token-sec");
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
    expect(localStorage.getItem(PROFILE_KEY)).not.toBeNull();

    const cacheSpy =
      typeof CacheStorage !== "undefined"
        ? vi.spyOn(CacheStorage.prototype, "delete")
        : undefined;

    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
      clearMemory: vi.fn(),
    });

    expect(getToken()).toBeNull();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(PROFILE_KEY)).toBeNull();

    if (cacheSpy !== undefined) {
      expect(cacheSpy).not.toHaveBeenCalled();
    }
  });

  it("clears activeWorkspaceId when clearToken is true to prevent leaking to new session", async () => {
    const { setActiveWorkspaceId, apiFetch } = await import("@/lib/api/client");
    setActiveWorkspaceId("ws-leak-test");

    await clearSensitiveSession({
      clearToken: true,
    });

    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await apiFetch("/accounts");
    const h = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(h["X-Workspace-Id"]).toBeUndefined();
  });

  it("respects selective flags (only clears what is requested)", async () => {
    setToken("test-token-select");
    seedProfile();

    const memoryFn = vi.fn();

    await clearSensitiveSession({
      clearToken: false,
      clearV1Snapshot: false,
      clearProfile: true,
      clearMemory: memoryFn,
    });

    expect(getToken()).toBe("test-token-select");
    expect(localStorage.getItem(PROFILE_KEY)).toBeNull();
    expect(memoryFn).toHaveBeenCalledOnce();
  });

  it("is idempotent (calling twice does not throw)", async () => {
    setToken("test-token-idem");
    seedProfile();

    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
    });

    // Second call — should not throw
    await expect(
      clearSensitiveSession({
        clearToken: true,
        clearV1Snapshot: true,
        clearProfile: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("deletes v2 IndexedDB snapshot when clearV1Snapshot is true", async () => {
    setToken("v2-test-token");

    // Write a v2 snapshot
    await writeV2Snapshot("v2-test-token", "accounts", []);

    // Verify v2 data exists
    const before = await readV2Snapshot("v2-test-token", "accounts");
    expect(before).not.toBeNull();

    // Clear session — await ensures v2 delete completes
    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: false,
    });

    // v2 data should be gone immediately (awaited)
    const after = await readV2Snapshot("v2-test-token", "accounts");
    expect(after).toBeNull();
  });

  it("completes cleanup BEFORE caller resumes (async ordering proof)", async () => {
    // Prove that after await clearSensitiveSession returns, all data is gone
    // INCLUDING v2 IndexedDB.
    setToken("order-token");
    seedSnapshot("order-token");
    seedProfile();
    await writeV2Snapshot("order-token", "accounts", []);

    let cleanupVerified = false;

    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
    });

    // This line executes AFTER cleanup completes (await resolved)
    cleanupVerified = true;

    expect(cleanupVerified).toBe(true);
    expect(getToken()).toBeNull();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(PROFILE_KEY)).toBeNull();

    // v2 also deleted (awaited)
    const v2After = await readV2Snapshot("order-token", "accounts");
    expect(v2After).toBeNull();
  });

  it("attempts every store independently — a v2 failure does not abort the others", async () => {
    setToken("indep-token");
    seedProfile();
    seedSnapshot("indep-token");

    const db = await import("@/lib/state/snapshot-db");
    const v2Fail = vi
      .spyOn(db, "deleteV2Snapshot")
      .mockRejectedValue(new Error("idb down"));

    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
      clearMemory: vi.fn(),
    });

    // token / profile / v1 still cleared even though v2 delete rejected.
    expect(getToken()).toBeNull();
    expect(localStorage.getItem(PROFILE_KEY)).toBeNull();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(v2Fail).toHaveBeenCalled();
  });

  it("resolves (no unhandled rejection) even when a store throws", async () => {
    setToken("throw-token");
    seedSnapshot("throw-token");
    const db = await import("@/lib/state/snapshot-db");
    vi.spyOn(db, "deleteV2Snapshot").mockRejectedValue(new Error("idb down"));

    // Must resolve (no thrown rejection) even with a failing store.
    await expect(
      clearSensitiveSession({ clearToken: true, clearV1Snapshot: true }),
    ).resolves.toBeUndefined();
    expect(getToken()).toBeNull();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  it("does nothing when no flags are set", async () => {
    await clearSensitiveSession({});
    expect(getToken()).toBeNull();
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(PROFILE_KEY)).toBeNull();
  });

  it("clears the token when clearToken is set", async () => {
    const ts = await import("@/lib/auth/token-store");
    const spy = vi.spyOn(ts, "clearToken");
    await clearSensitiveSession({ clearToken: true });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("clears the v1 snapshot (and v2) when clearV1Snapshot is set", async () => {
    localStorage.setItem(SNAPSHOT_KEY, "v1-data");
    await clearSensitiveSession({ clearV1Snapshot: true });
    // v1 localStorage removed; v2 IndexedDB delete is awaited (caught on failure)
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  it("clears the profile when clearProfile is set", async () => {
    localStorage.setItem(PROFILE_KEY, "profile-data");
    await clearSensitiveSession({ clearProfile: true });
    expect(localStorage.getItem(PROFILE_KEY)).toBeNull();
  });

  it("invokes the clearMemory callback when provided", async () => {
    const cb = vi.fn();
    await clearSensitiveSession({ clearMemory: cb });
    expect(cb).toHaveBeenCalledOnce();
  });

  it("isolates store failures: a token error does not abort profile clear", async () => {
    const ts = await import("@/lib/auth/token-store");
    vi.spyOn(ts, "clearToken").mockImplementation(() => {
      throw new Error("token store boom");
    });
    localStorage.setItem(PROFILE_KEY, "profile-data");
    await expect(
      clearSensitiveSession({ clearToken: true, clearProfile: true }),
    ).resolves.toBeUndefined();
    // profile clear still happened despite the token failure
    expect(localStorage.getItem(PROFILE_KEY)).toBeNull();
  });

  it("is idempotent across repeated calls", async () => {
    localStorage.setItem(SNAPSHOT_KEY, "v1-data");
    localStorage.setItem(PROFILE_KEY, "profile-data");
    const ts = await import("@/lib/auth/token-store");
    const spy = vi.spyOn(ts, "clearToken");
    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
    });
    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(PROFILE_KEY)).toBeNull();
  });

  it("useSession fallback returns no-op expireSession when outside provider", () => {
    const { result } = renderHook(() => useSession());
    expect(() => result.current.expireSession("test")).not.toThrow();
  });

  it("H-05: invalidates the cached agent connection bearer on logout and workspace switch", async () => {
    const client = await import("@/lib/api/client");
    const agentAuth = await import("@/lib/api/agent-auth");
    const apiSpy = vi
      .spyOn(client, "apiFetch")
      .mockResolvedValue({ token: "agent-token-h05", expiresIn: 120 });
    // FIX-AGENT-MINT-SELF-HEAL: a mint with no stored device token first
    // registers the device (its own apiFetch call), so the assertions below
    // count the mint path only — the cache contract under test is unchanged.
    const mintCalls = (): number =>
      apiSpy.mock.calls.filter(([path]) => path === "/auth/agent-token").length;
    const ws = "ws-h05-session";
    agentAuth.clearAgentConnectionTokenCache();

    await agentAuth.fetchAgentConnectionToken(ws);
    await agentAuth.fetchAgentConnectionToken(ws);
    expect(mintCalls()).toBe(1);

    // Logout / 401 path.
    await clearSensitiveSession({ clearToken: true });
    await agentAuth.fetchAgentConnectionToken(ws);
    expect(mintCalls()).toBe(2);

    // Workspace-switch path.
    await clearSensitiveSession({ clearV1Snapshot: true, clearProfile: true });
    await agentAuth.fetchAgentConnectionToken(ws);
    expect(mintCalls()).toBe(3);

    // No-op call still clears the agent session (H-13 central contract:
    // every session cleanup may imply a context change).
    await agentAuth.fetchAgentConnectionToken(ws);
    await clearSensitiveSession({});
    await agentAuth.fetchAgentConnectionToken(ws);
    expect(mintCalls()).toBe(4);
  });
});
