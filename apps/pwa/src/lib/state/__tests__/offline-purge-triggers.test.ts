import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readV2Snapshot,
  writeV2Snapshot,
  migrateV1toV2,
  refreshOfflineAuthAge,
  openSnapshotDb,
  STORE_NAME,
  V2_ENVELOPE_KEY,
  getOfflineSnapshotLockState,
} from "../snapshot-db";
import { setOfflineSubjectId, getOfflineSubjectId } from "@/lib/auth/offline-subject";
import { clearSensitiveSession } from "@/lib/session";

/**
 * V4.1 Phase 5 (Task 5.9 + D10) purge-trigger map:
 * - logout → purge (clearToken + clearV1Snapshot path);
 * - workspace-switch → purge (covered in workspace-context.test.tsx
 *   "selects the first authorized workspace…", asserting the previous
 *   snapshot reads null after the switch);
 * - membership revocation → purge (covered in
 *   api/__tests__/revocation-purge.test.ts + bootstrap-revocation.test.ts);
 * - optional disable via NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT (here).
 */
const TOKEN = "purge-map-token";
const SUBJECT = "44444444-5555-4666-8777-888888888888";
const V1_KEY = "pi-finance:snapshot:v1";

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

/** Suspend crypto.subtle.digest until `release()` — widens the fingerprint gap deterministically. */
function gateDigest(): { release: () => void } {
  let releaseGate!: () => void;
  let restored = false;
  const gate = new Promise<void>((resolve) => {
    releaseGate = () => resolve();
  });
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async (...args: Parameters<SubtleCrypto["digest"]>) => {
      await gate;
      return realDigest(...args);
    },
  );
  return {
    // Idempotent: safe to call from both the test body and `finally`.
    release: () => {
      releaseGate();
      if (!restored) {
        restored = true;
        vi.mocked(crypto.subtle.digest).mockRestore();
      }
    },
  };
}

/** Read the raw V2 envelope straight from IndexedDB (bypasses all gates). */
async function readRawEnvelope(): Promise<{
  lastOnlineAuthenticatedAt?: string;
  domains?: Record<string, unknown>;
} | null> {
  const db = await openSnapshotDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(V2_ENVELOPE_KEY);
      req.onsuccess = () => resolve((req.result as never) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

describe("offline purge-trigger map (D10)", () => {
  beforeEach(async () => {
    localStorage.clear();
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    setOfflineSubjectId(SUBJECT);
    await writeV2Snapshot(TOKEN, "accounts", [{ id: "a1" }] as never);
    expect(await readV2Snapshot(TOKEN, "accounts")).not.toBeNull();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("logout purges the offline snapshot", async () => {
    await clearSensitiveSession({ clearToken: true, clearV1Snapshot: true, clearProfile: true });
    expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
  });

  it("T07a: logout teardown clears the subject partition synchronously (no await needed)", async () => {
    const pending = clearSensitiveSession({ clearToken: true, clearV1Snapshot: true, clearProfile: true });
    // State gate: the subject partition is already gone in the same tick —
    // reads fail closed even if IndexedDB is slow or failing.
    expect(getOfflineSubjectId()).toBeNull();
    await pending;
    expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
  });

  it("T07a: post-teardown V2 reads never touch IndexedDB", async () => {
    await clearSensitiveSession({ clearToken: true, clearV1Snapshot: true, clearProfile: true });
    const openSpy = vi.spyOn(indexedDB, "open");
    try {
      expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("T07a: a V2 write spanning teardown + re-login never revives stale data", async () => {
    const gate = gateDigest();
    try {
      // Stale response starts persisting before the teardown; the fingerprint
      // gap is held open so the teardown deterministically lands mid-write.
      const stale = writeV2Snapshot(TOKEN, "accounts", [{ id: "stale" }] as never, {
        expectedSubject: SUBJECT,
      });
      await clearSensitiveSession({ clearOfflineIdentity: true });
      // Re-login as the same subject before the stale write resumes.
      setOfflineSubjectId(SUBJECT);
      gate.release();
      await stale;
      // The stale payload must not revive: the pre-teardown envelope is
      // untouched (no snapshot delete ran on this path) and still serves
      // the original data.
      const got = await readV2Snapshot(TOKEN, "accounts");
      expect(got).not.toBeNull();
      expect(got!.data).toEqual([{ id: "a1" }]);
    } finally {
      gate.release();
    }
  });

  it("T07a-R2: a V2 write suspended at the envelope read across revocation never puts", async () => {
    const suspend = suspendNthIdbOpen(1);
    try {
      const stale = writeV2Snapshot(TOKEN, "accounts", [{ id: "stale" }] as never);
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(1));
      // Full teardown WITH snapshot delete while the envelope read is held.
      await clearSensitiveSession({ clearToken: true, clearV1Snapshot: true, clearOfflineIdentity: true });
      // Re-login as the same subject before the stale write resumes.
      setOfflineSubjectId(SUBJECT);
      suspend.release();
      await stale;
      // The guarded put was aborted AND the purge delete stands: nothing readable.
      expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
    } finally {
      suspend.release();
    }
  });

  it("T07a-R2: a V2 write suspended at the commit open across revocation never puts", async () => {
    // Gate the SECOND open (writeV2Envelope's commit open): the envelope
    // read already resolved pre-teardown, so only a post-open revalidation
    // inside the commit path can still abort.
    const suspend = suspendNthIdbOpen(2);
    try {
      const stale = writeV2Snapshot(TOKEN, "accounts", [{ id: "stale" }] as never);
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(2));
      await clearSensitiveSession({ clearToken: true, clearV1Snapshot: true, clearOfflineIdentity: true });
      setOfflineSubjectId(SUBJECT);
      suspend.release();
      await stale;
      expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
    } finally {
      suspend.release();
    }
  });

  it("T07a-R2: a V1→V2 migration suspended at the commit open across revocation is not applied", async () => {
    localStorage.setItem(
      V1_KEY,
      JSON.stringify({ version: 1, token: TOKEN, syncedAt: {}, data: { budgets: [{ id: "b-mig" }] } }),
    );
    const suspend = suspendNthIdbOpen(2);
    try {
      const migrating = migrateV1toV2(TOKEN);
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(2));
      // Identity-only teardown: bumps the generation WITHOUT deleting the
      // v1 source or the V2 envelope, isolating exactly the commit guard —
      // a full snapshot purge would delete v1 itself (canonical behavior),
      // hiding whether the migration wrote.
      await clearSensitiveSession({ clearOfflineIdentity: true });
      setOfflineSubjectId(SUBJECT);
      suspend.release();
      await migrating;
      // Aborted commit: the v1 source is preserved and nothing was migrated.
      expect(localStorage.getItem(V1_KEY)).not.toBeNull();
      expect(await readV2Snapshot(TOKEN, "budgets")).toBeNull();
    } finally {
      suspend.release();
    }
  });

  it("T07a-R2 control: identical suspended flows WITHOUT revocation still complete", async () => {    // Suspended V2 write completes and serves.
    const s1 = suspendNthIdbOpen(2);
    try {
      const w = writeV2Snapshot(TOKEN, "accounts", [{ id: "ctrl" }] as never);
      await vi.waitFor(() => expect(s1.openCalls()).toBe(2));
      s1.release();
      await w;
      expect((await readV2Snapshot(TOKEN, "accounts"))?.data).toEqual([{ id: "ctrl" }]);
    } finally {
      s1.release();
    }
    // Suspended V1→V2 migration applies.
    localStorage.setItem(
      V1_KEY,
      JSON.stringify({ version: 1, token: TOKEN, syncedAt: {}, data: { budgets: [{ id: "b-ctrl" }] } }),
    );
    const s2 = suspendNthIdbOpen(2);
    try {
      const m = migrateV1toV2(TOKEN);
      await vi.waitFor(() => expect(s2.openCalls()).toBe(2));
      s2.release();
      await m;
      expect(localStorage.getItem(V1_KEY)).toBeNull();
      expect((await readV2Snapshot(TOKEN, "budgets"))?.data).toEqual([{ id: "b-ctrl" }]);
    } finally {
      s2.release();
    }
  });

  it("T07a-R3: a revalidation suspended at the commit open across revocation never renews the stamp", async () => {
    const suspend = suspendNthIdbOpen(2);
    try {
      // Gate the SECOND open (the commit open inside writeV2Envelope): the
      // envelope read already resolved pre-teardown, so only a post-open
      // revalidation inside the commit path can still abort.
      const refreshing = refreshOfflineAuthAge();
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(2));
      // Full teardown WITH snapshot delete while the commit open is held.
      await clearSensitiveSession({ clearToken: true, clearV1Snapshot: true, clearOfflineIdentity: true });
      setOfflineSubjectId(SUBJECT);
      suspend.release();
      await expect(refreshing).resolves.toBe(false);
      // No repopulation: the purge delete stands and the guarded put aborted.
      expect(await readRawEnvelope()).toBeNull();
      expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
    } finally {
      suspend.release();
    }
  });

  it("T07a-R3 control: suspended revalidation WITHOUT revocation still commits", async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const suspend = suspendNthIdbOpen(2);
    try {
      const refreshing = refreshOfflineAuthAge(at);
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(2));
      suspend.release();
      await expect(refreshing).resolves.toBe(true);
      expect((await readRawEnvelope())?.lastOnlineAuthenticatedAt).toBe(at);
    } finally {
      suspend.release();
    }
  });

  it("disabled snapshot flag blocks writes and reports empty lock state", async () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT", "1");
    const dbs = await indexedDB.databases();
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    await writeV2Snapshot(TOKEN, "accounts", [{ id: "a1" }] as never);
    expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
    expect(await getOfflineSnapshotLockState()).toEqual({ state: "empty" });
  });

  it("enabled snapshot flag keeps the normal write/read path", async () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT", "0");
    await writeV2Snapshot(TOKEN, "budgets", [] as never);
    expect(await readV2Snapshot(TOKEN, "budgets")).not.toBeNull();
  });
});
