/**
 * RED (V4.1 Closure Phase 3, AUTH-T04..AUTH-T07 / INV-05):
 * offline cleanup — logout/revocation/workspace-switch purge the V3
 * snapshot, the offline identity and the age stamp per case.
 *
 * Contract under test (clearSensitiveSession in session.ts):
 * - logout/401/403 (clearToken + clearV1Snapshot + clearOfflineIdentity):
 *   V3 gone, principal + workspace + subject + stamp gone (AUTH-T04/05/06);
 * - workspace switch (clearV1Snapshot + clearWorkspaceBinding, no token
 *   clear): V3 gone, workspace + subject + stamp gone, user principal KEPT
 *   (AUTH-T07 — closes the workspace-context.tsx:298-313 gap);
 * - snapshot purge always includes V3 (backstop via clearV1Snapshot).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { clearSensitiveSession, getLastOnlineAuthenticatedAt } from "@/lib/session";
import { writeV3Snapshot, readV3Snapshot } from "../snapshot-db";
import {
  bindOfflineIdentity,
  clearOfflineIdentity,
  getOfflinePrincipalId,
  getOfflineWorkspaceId,
} from "@/lib/auth/offline-identity";
import {
  getOfflineSubjectId,
  setOfflineSubjectId,
} from "@/lib/auth/offline-subject";
import { stampLastOnlineAuthenticatedAt } from "@/lib/session";

const USER_A = "user-a-001";
const WS_X = "11111111-2222-4333-8444-555555555555";
const ACCOUNTS = [{ id: "a1", name: "Conta A" }];

/**
 * Suspend the Nth IndexedDB.open call in this test (1-based), letting all
 * others pass through to fake-indexeddb. The suspended open is a Proxy that
 * queues handler assignments and replays them onto the real request on
 * release — exposing the exact await windows (envelope read vs commit open)
 * between the entry gate and the final put. Deterministic: the test waits
 * for the Nth call to land (vi.waitFor, event-driven) before driving the
 * teardown, then releases.
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

async function wipeDb(): Promise<void> {
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
}

async function seedOnlineSession(): Promise<void> {
  bindOfflineIdentity(USER_A, WS_X);
  setOfflineSubjectId(WS_X);
  stampLastOnlineAuthenticatedAt();
  await writeV3Snapshot(USER_A, WS_X, "accounts", ACCOUNTS as never);
  expect(await readV3Snapshot(USER_A, WS_X, "accounts")).not.toBeNull();
  expect(getLastOnlineAuthenticatedAt()).not.toBeNull();
}

beforeEach(async () => {
  await wipeDb();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("offline cleanup (Phase 3)", () => {
  it("AUTH-T04/05/06: logout purge removes V3 + principal + workspace + subject + stamp", async () => {
    await seedOnlineSession();
    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
      clearOfflineIdentity: true,
    });
    expect(await readV3Snapshot(USER_A, WS_X, "accounts")).toBeNull();
    expect(getOfflinePrincipalId()).toBeNull();
    expect(getOfflineWorkspaceId()).toBeNull();
    expect(getOfflineSubjectId()).toBeNull();
    expect(getLastOnlineAuthenticatedAt()).toBeNull();
  });

  it("AUTH-T07: workspace switch clears binding + V3 + stamp but keeps the user principal", async () => {
    await seedOnlineSession();
    await clearSensitiveSession({
      clearV1Snapshot: true,
      clearProfile: true,
      clearWorkspaceBinding: true,
    });
    expect(await readV3Snapshot(USER_A, WS_X, "accounts")).toBeNull();
    expect(getOfflineWorkspaceId()).toBeNull();
    expect(getOfflineSubjectId()).toBeNull();
    expect(getLastOnlineAuthenticatedAt()).toBeNull();
    // The user did not log out: the principal survives for rebinding.
    expect(getOfflinePrincipalId()).toBe(USER_A);
  });

  it("snapshot purge always includes V3 (backstop)", async () => {
    await seedOnlineSession();
    await clearSensitiveSession({ clearV1Snapshot: true });
    expect(await readV3Snapshot(USER_A, WS_X, "accounts")).toBeNull();
  });

  it("T07a: workspace-switch teardown takes effect synchronously, keeping the principal", async () => {
    await seedOnlineSession();
    const pending = clearSensitiveSession({
      clearV1Snapshot: true,
      clearProfile: true,
      clearWorkspaceBinding: true,
    });
    // State gate: binding + subject already gone in the same tick — reads
    // fail closed even if IndexedDB is slow or failing — while the user
    // principal survives for rebinding.
    expect(getOfflineWorkspaceId()).toBeNull();
    expect(getOfflineSubjectId()).toBeNull();
    expect(getOfflinePrincipalId()).toBe(USER_A);
    await pending;
    expect(await readV3Snapshot(USER_A, WS_X, "accounts")).toBeNull();
  });

  it("T07a: post-revocation V3 reads never touch IndexedDB", async () => {
    await seedOnlineSession();
    // Authoritative revocation: the identity is torn down synchronously.
    clearOfflineIdentity();
    const openSpy = vi.spyOn(indexedDB, "open");
    try {
      expect(await readV3Snapshot(USER_A, WS_X, "accounts")).toBeNull();
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("T07a: a V3 write spanning revocation never revives after re-bind", async () => {
    await seedOnlineSession();
    const stale = writeV3Snapshot(USER_A, WS_X, "accounts", [{ id: "stale" }] as never);
    // Authoritative revocation lands mid-flight: the identity is cleared
    // synchronously while the write is still queued.
    clearOfflineIdentity();
    await stale;
    // Re-login as the same owner must not resurrect the stale payload —
    // the pre-revocation envelope survives untouched.
    bindOfflineIdentity(USER_A, WS_X);
    stampLastOnlineAuthenticatedAt();
    const got = await readV3Snapshot(USER_A, WS_X, "accounts");
    expect(got).not.toBeNull();
    expect(got!.data).toEqual(ACCOUNTS);
  });

  it("T07a: a stale V3 write starting after revocation is dropped", async () => {
    await seedOnlineSession();
    // Revocation clears the identity; the envelope is still on disk.
    clearOfflineIdentity();
    await writeV3Snapshot(USER_A, WS_X, "accounts", [{ id: "stale" }] as never);
    bindOfflineIdentity(USER_A, WS_X);
    stampLastOnlineAuthenticatedAt();
    const got = await readV3Snapshot(USER_A, WS_X, "accounts");
    expect(got).not.toBeNull();
    expect(got!.data).toEqual(ACCOUNTS);
  });

  it("T07a-R2: a V3 read in-flight at revocation never delivers", async () => {
    await seedOnlineSession();
    const suspend = suspendNthIdbOpen(1);
    try {
      const pending = readV3Snapshot(USER_A, WS_X, "accounts");
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(1));
      // Authoritative revocation lands while the envelope read is held.
      clearOfflineIdentity();
      suspend.release();
      await expect(pending).resolves.toBeNull();
    } finally {
      suspend.release();
    }
  });

  it("T07a-R2: a V3 read in-flight across revocation + same-owner re-login never delivers", async () => {
    await seedOnlineSession();
    const suspend = suspendNthIdbOpen(1);
    try {
      const pending = readV3Snapshot(USER_A, WS_X, "accounts");
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(1));
      clearOfflineIdentity();
      // Re-login as the SAME owner: the args still match, but the binding
      // started a new generation — the pre-teardown read must still not deliver.
      bindOfflineIdentity(USER_A, WS_X);
      stampLastOnlineAuthenticatedAt();
      suspend.release();
      await expect(pending).resolves.toBeNull();
    } finally {
      suspend.release();
    }
  });

  it("T07a-R2 control: suspended V3 write/read WITHOUT revocation still complete", async () => {
    await seedOnlineSession();
    // Suspended V3 write completes and serves.
    const s = suspendNthIdbOpen(2);
    try {
      const w = writeV3Snapshot(USER_A, WS_X, "accounts", [{ id: "ctrl" }] as never);
      await vi.waitFor(() => expect(s.openCalls()).toBe(2));
      s.release();
      await w;
      expect((await readV3Snapshot(USER_A, WS_X, "accounts"))?.data).toEqual([{ id: "ctrl" }]);
    } finally {
      s.release();
    }
    // Suspended V3 read serves.
    const s2 = suspendNthIdbOpen(1);
    try {
      const r = readV3Snapshot(USER_A, WS_X, "accounts");
      await vi.waitFor(() => expect(s2.openCalls()).toBe(1));
      s2.release();
      await expect(r).resolves.not.toBeNull();
    } finally {
      s2.release();
    }
  });
});
