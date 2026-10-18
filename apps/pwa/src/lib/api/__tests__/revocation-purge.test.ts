import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, FORBIDDEN_EVENT } from "../client";
import {
  writeV2Snapshot,
  readV2Snapshot,
  writeV3Snapshot,
  readV3Snapshot,
} from "@/lib/state/snapshot-db";
import {
  getOfflineSubjectId,
  setOfflineSubjectId,
} from "@/lib/auth/offline-subject";
import {
  bindOfflineIdentity,
  getOfflinePrincipalId,
  getOfflineWorkspaceId,
} from "@/lib/auth/offline-identity";

/**
 * V4.1 Phase 5 (Task 5.9 + D10): membership revocation purges the offline
 * snapshot. The API revokes on removeMember/leave (Phase 1); when a request
 * answers 403 auth.workspace_forbidden (no active membership) the PWA must
 * purge its snapshot and take the unauthenticated transition (→ login,
 * never offline mode). Owner-only workspace.forbidden and other permission
 * denials must NOT purge: the caller is still a member.
 */
const TOKEN = "revocation-probe-token";
const USER = "revocation-user-1";
// SUBJECT doubles as the V3 workspace binding (valid UUID) so the same
// teardown covers the V2 partition and the V3 owner key.
const SUBJECT = "33333333-4444-4555-8666-777777777777";

/**
 * Suspend the Nth IndexedDB.open call in this test (1-based), letting all
 * others pass through to fake-indexeddb. The suspended open is a Proxy that
 * queues handler assignments and replays them onto the real request on
 * release — exposing the exact await windows between the entry gate and the
 * final put. Deterministic: the test waits for the Nth call to land
 * (vi.waitFor, event-driven) before driving the revocation, then releases.
 */
function suspendNthIdbOpen(n: number): { release: () => void; openCalls: () => number } {
  const realOpen = indexedDB.open.bind(indexedDB);
  let calls = 0;
  let released = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = () => resolve();
  });
  const spy = vi.spyOn(indexedDB, "open").mockImplementation((...args: unknown[]) => {
    calls += 1;
    if (calls !== n) {
      return (realOpen as (...a: unknown[]) => IDBOpenDBRequest)(...args);
    }
    const pending: Array<[string, unknown]> = [];
    let real: IDBOpenDBRequest | null = null;
    void gate.then(() => {
      real = (realOpen as (...a: unknown[]) => IDBOpenDBRequest)(...args);
      for (const [k, v] of pending) {
        (real as unknown as Record<string, unknown>)[k] = v;
      }
    });
    return new Proxy({} as IDBOpenDBRequest, {
      set(_t, p: string, v: unknown): boolean {
        if (real) (real as unknown as Record<string, unknown>)[p] = v;
        else pending.push([p, v]);
        return true;
      },
      get(_t, p: string): unknown {
        if (p === "then") return undefined;
        if (real) {
          const v = (real as unknown as Record<string, unknown>)[p];
          return typeof v === "function"
            ? (v as (...a: unknown[]) => unknown).bind(real)
            : v;
        }
        return undefined;
      },
    });
  });
  return {
    openCalls: () => calls,
    // Idempotent: safe from both the test body and `finally`.
    release: () => {
      if (!released) {
        released = true;
        releaseGate();
        spy.mockRestore();
      }
    },
  };
}

function mockStatus(status: number, body: unknown): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
}

describe("revocation purge on 403 auth.workspace_forbidden (D10)", () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    setOfflineSubjectId(SUBJECT);
    await writeV2Snapshot(TOKEN, "accounts", [{ id: "a1" }] as never);
    expect(await readV2Snapshot(TOKEN, "accounts")).not.toBeNull();
    bindOfflineIdentity(USER, SUBJECT);
    await writeV3Snapshot(USER, SUBJECT, "accounts", [{ id: "v3-a1" }] as never);
    expect(await readV3Snapshot(USER, SUBJECT, "accounts")).not.toBeNull();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("dispatches the forbidden event on 403 auth.workspace_forbidden", async () => {
    mockStatus(403, { code: "auth.workspace_forbidden", message: "Acesso restrito" });
    const handler = vi.fn();
    window.addEventListener(FORBIDDEN_EVENT, handler);
    try {
      await expect(apiFetch("/workspaces")).rejects.toMatchObject({ status: 403 });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(FORBIDDEN_EVENT, handler);
    }
  });

  it("purges the offline snapshot on 403 auth.workspace_forbidden", async () => {
    mockStatus(403, { code: "auth.workspace_forbidden", message: "Sem acesso" });
    await expect(apiFetch("/accounts")).rejects.toMatchObject({ status: 403 });
    // Purge is best-effort async — allow the queued IndexedDB delete to land.
    await vi.waitFor(async () => {
      expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
    });
  });

  it("T07a: clears the offline identity synchronously on authoritative revocation", async () => {
    mockStatus(403, { code: "auth.workspace_forbidden", message: "Sem acesso" });
    await expect(apiFetch("/accounts")).rejects.toMatchObject({ status: 403 });
    // State gate, not storage-dependent: no await between the rejection and
    // these reads — principal, workspace binding and subject are already
    // gone in the same tick, so no offline read can unlock afterwards.
    expect(getOfflinePrincipalId()).toBeNull();
    expect(getOfflineWorkspaceId()).toBeNull();
    expect(getOfflineSubjectId()).toBeNull();
  });

  it("T07a: blocks V2/V3 reads immediately on revocation (stale owner args serve nothing)", async () => {
    mockStatus(403, { code: "auth.workspace_forbidden", message: "Sem acesso" });
    await expect(apiFetch("/accounts")).rejects.toMatchObject({ status: 403 });
    expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
    expect(await readV3Snapshot(USER, SUBJECT, "accounts")).toBeNull();
  });

  it("T07a: post-revocation reads never touch IndexedDB", async () => {
    mockStatus(403, { code: "auth.workspace_forbidden", message: "Sem acesso" });
    await expect(apiFetch("/accounts")).rejects.toMatchObject({ status: 403 });
    // Let the best-effort async snapshot purge land first, so any later
    // IndexedDB access can only come from the reads under test.
    await vi.waitFor(async () => {
      expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
    });
    const openSpy = vi.spyOn(indexedDB, "open");
    try {
      expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
      expect(await readV3Snapshot(USER, SUBJECT, "accounts")).toBeNull();
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("T07a-R2: authoritative 403 racing a suspended V3 write drops it end-to-end", async () => {
    const suspend = suspendNthIdbOpen(1);
    try {
      const stale = writeV3Snapshot(USER, SUBJECT, "accounts", [{ id: "stale" }] as never);
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(1));
      // The true authoritative signal lands while the write is suspended.
      mockStatus(403, { code: "auth.workspace_forbidden", message: "Sem acesso" });
      await expect(apiFetch("/accounts")).rejects.toMatchObject({ status: 403 });
      suspend.release();
      await stale;
      // Re-bind and prove no revival: the purge delete stands and the stale
      // put was aborted before hitting disk.
      bindOfflineIdentity(USER, SUBJECT);
      expect(await readV3Snapshot(USER, SUBJECT, "accounts")).toBeNull();
    } finally {
      suspend.release();
    }
  });

  it.each([
    "auth.admin_forbidden",
    "auth.invite_forbidden",
    "auth.invalid_origin",
    "workspace.forbidden",
    "agent.workspace_forbidden",
  ])("does NOT dispatch or purge on permission-denial 403 %s", async (code) => {
    mockStatus(403, { code, message: "Sem permissão" });
    const handler = vi.fn();
    window.addEventListener(FORBIDDEN_EVENT, handler);
    try {
      await expect(apiFetch("/accounts")).rejects.toMatchObject({ status: 403 });
      expect(handler).not.toHaveBeenCalled();
      expect(await readV2Snapshot(TOKEN, "accounts")).not.toBeNull();
      // T07a: a common role/scope denial clears neither the V3 slot nor the
      // offline identity — only authoritative revocation does.
      expect(await readV3Snapshot(USER, SUBJECT, "accounts")).not.toBeNull();
      expect(getOfflinePrincipalId()).toBe(USER);
      expect(getOfflineWorkspaceId()).toBe(SUBJECT);
    } finally {
      window.removeEventListener(FORBIDDEN_EVENT, handler);
    }
  });

  it("does NOT dispatch or purge on a bare 403 without a code", async () => {
    mockStatus(403, { message: "Forbidden" });
    const handler = vi.fn();
    window.addEventListener(FORBIDDEN_EVENT, handler);
    try {
      await expect(apiFetch("/accounts")).rejects.toMatchObject({ status: 403 });
      expect(handler).not.toHaveBeenCalled();
      expect(await readV2Snapshot(TOKEN, "accounts")).not.toBeNull();
      expect(await readV3Snapshot(USER, SUBJECT, "accounts")).not.toBeNull();
      expect(getOfflinePrincipalId()).toBe(USER);
      expect(getOfflineWorkspaceId()).toBe(SUBJECT);
    } finally {
      window.removeEventListener(FORBIDDEN_EVENT, handler);
    }
  });

  it("does not purge or fire the event on non-revocation errors", async () => {
    mockStatus(500, { code: "server.error", message: "boom" });
    const handler = vi.fn();
    window.addEventListener(FORBIDDEN_EVENT, handler);
    try {
      await expect(apiFetch("/accounts")).rejects.toMatchObject({ status: 500 });
      expect(handler).not.toHaveBeenCalled();
      expect(await readV2Snapshot(TOKEN, "accounts")).not.toBeNull();
      expect(await readV3Snapshot(USER, SUBJECT, "accounts")).not.toBeNull();
      expect(getOfflinePrincipalId()).toBe(USER);
      expect(getOfflineWorkspaceId()).toBe(SUBJECT);
    } finally {
      window.removeEventListener(FORBIDDEN_EVENT, handler);
    }
  });
});
