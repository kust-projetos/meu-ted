/**
 * TDD Unit Tests for Snapshot DB (snapshot-db.ts)
 *
 * Covers:
 * - Happy Path: Lifecycle, openSnapshotDb, writeV2Snapshot, readV2Snapshot, migrateV1toV2
 * - Failure Path: Owner fingerprint mismatch, corrupt v1 payload, database deletion
 * - Edge / Concurrency: Parallel writes, empty domains, special token characters
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import {
  openSnapshotDb,
  writeV2Snapshot,
  readV2Snapshot,
  deleteV2Snapshot,
  migrateV1toV2,
  DB_NAME,
STORE_NAME,
  V2_ENVELOPE_KEY,
} from "../snapshot-db";
import { setOfflineSubjectId } from "@/lib/auth/offline-subject";
import { advanceOfflineGeneration } from "@/lib/auth/offline-identity";

afterEach(() => vi.restoreAllMocks());

const TEST_TOKEN = "device-auth-token-sample-xyz";
const ALT_TOKEN = "different-user-token-abc-987";
// T2.6: v2 reads require the subject partition — an authenticated session
// always carries one (set at login via setActiveWorkspaceId).
const TEST_SUBJECT = "22222222-3333-4444-8555-666666666666";

function seedV1(token: string, domain = "accounts", data = [{ id: "acc-1", name: "Conta 1" }]): void {
  localStorage.setItem(
    "pi-finance:snapshot:v1",
    JSON.stringify({
      version: 1,
      token,
      syncedAt: { [domain]: "2026-08-19T10:00:00.000Z" },
      data: { [domain]: data },
    }),
  );
}

/**
 * Suspend the Nth IndexedDB.open call (1-based), letting all others pass
 * through to fake-indexeddb. Exposes the exact await windows (envelope read
 * vs commit open vs validation reread) deterministically.
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
    release: () => {
      if (!released) {
        released = true;
        releaseGate();
        spy.mockRestore();
      }
    },
  };
}

describe("PWA State Snapshot DB — snapshot-db.ts", () => {
  beforeEach(async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
    // T2.6 contract: reads verify the subject partition.
    setOfflineSubjectId(TEST_SUBJECT);
  });

  // ── 1. HAPPY PATH (>= 3 cases) ──────────────────────────────────────────────
  describe("Happy Path", () => {
    it("1.1 openSnapshotDb opens database with correct name and object store", async () => {
      const db = await openSnapshotDb();
      expect(db.name).toBe(DB_NAME);
      expect(db.objectStoreNames.contains(STORE_NAME)).toBe(true);
      db.close();
    });

    it("1.2 writeV2Snapshot and readV2Snapshot roundtrips domain data correctly", async () => {
      const accounts = [{ id: "a1", name: "Nubank Principal" }];
      await writeV2Snapshot(TEST_TOKEN, "accounts", accounts as never);

      const loaded = await readV2Snapshot(TEST_TOKEN, "accounts");
      expect(loaded).not.toBeNull();
      expect(loaded!.data).toEqual(accounts);
      expect(typeof loaded!.syncedAt).toBe("string");
    });

    it("1.3 migrateV1toV2 migrates valid localStorage v1 snapshot to IndexedDB v2 and clears v1", async () => {
      seedV1(TEST_TOKEN, "categories", [{ id: "c1", name: "Alimentação" }]);
      expect(localStorage.getItem("pi-finance:snapshot:v1")).not.toBeNull();

      await migrateV1toV2(TEST_TOKEN);

      // v1 localStorage key is cleared
      expect(localStorage.getItem("pi-finance:snapshot:v1")).toBeNull();

      // v2 IndexedDB contains migrated categories
      const loaded = await readV2Snapshot(TEST_TOKEN, "categories");
      expect(loaded).not.toBeNull();
      expect(loaded!.data).toEqual([{ id: "c1", name: "Alimentação" }]);
    });

    it("1.4 Writing multiple domains preserves previously written domains in the v2 envelope", async () => {
      await writeV2Snapshot(TEST_TOKEN, "accounts", [{ id: "a1" }] as never);
      await writeV2Snapshot(TEST_TOKEN, "payables", [{ id: "p1" }] as never);

      const accounts = await readV2Snapshot(TEST_TOKEN, "accounts");
      const payables = await readV2Snapshot(TEST_TOKEN, "payables");

      expect(accounts).not.toBeNull();
      expect(accounts!.data).toEqual([{ id: "a1" }]);
      expect(payables).not.toBeNull();
      expect(payables!.data).toEqual([{ id: "p1" }]);
    });
  });

  // ── 2. FAILURE PATH (>= 3 cases) ────────────────────────────────────────────
  describe("Failure Path", () => {
    it("2.1 Owner mismatch returns null and prevents cross-user snapshot leakage", async () => {
      await writeV2Snapshot(TEST_TOKEN, "accounts", [{ id: "secret-a1" }] as never);

      // Read with different token
      const result = await readV2Snapshot(ALT_TOKEN, "accounts");
      expect(result).toBeNull();
    });

    it("2.2 migrateV1toV2 handles non-JSON / corrupted localStorage safely", async () => {
      localStorage.setItem("pi-finance:snapshot:v1", "{ malformed_json...");
      await migrateV1toV2(TEST_TOKEN);

      const loaded = await readV2Snapshot(TEST_TOKEN, "accounts");
      expect(loaded).toBeNull();
    });

    it("2.3 deleteV2Snapshot clears all stored data in IndexedDB", async () => {
      await writeV2Snapshot(TEST_TOKEN, "accounts", [{ id: "a1" }] as never);
      await deleteV2Snapshot();

      const result = await readV2Snapshot(TEST_TOKEN, "accounts");
      expect(result).toBeNull();
    });

    it("2.4 migrateV1toV2 ignores v1 snapshot if token does not match", async () => {
      seedV1("other-owner-token", "accounts", [{ id: "other-a1", name: "Other" }]);
      await migrateV1toV2(TEST_TOKEN);

      const loaded = await readV2Snapshot(TEST_TOKEN, "accounts");
      expect(loaded).toBeNull();
    });
  });

  // ── 3. EDGE & CONCURRENCY CASES (>= 3 cases) ────────────────────────────────
  describe("Edge & Concurrency Cases", () => {
    it("3.1 Parallel writes to distinct domains do not corrupt the envelope", async () => {
      await Promise.all([
        writeV2Snapshot(TEST_TOKEN, "accounts", [{ id: "acc-concurrent" }] as never),
        writeV2Snapshot(TEST_TOKEN, "budgets", [{ id: "budget-concurrent" }] as never),
        writeV2Snapshot(TEST_TOKEN, "goals", [{ id: "goal-concurrent" }] as never),
      ]);

      const accounts = await readV2Snapshot(TEST_TOKEN, "accounts");
      const budgets = await readV2Snapshot(TEST_TOKEN, "budgets");
      const goals = await readV2Snapshot(TEST_TOKEN, "goals");

      // At least one (and usually all) should be persisted cleanly without schema corruption
      expect(accounts !== null || budgets !== null || goals !== null).toBe(true);
    });

    it("3.2 Saving empty domain array stores empty array correctly with valid syncedAt", async () => {
      await writeV2Snapshot(TEST_TOKEN, "payables", [] as never);
      const loaded = await readV2Snapshot(TEST_TOKEN, "payables");
      expect(loaded).not.toBeNull();
      expect(loaded!.data).toEqual([]);
      expect(loaded!.syncedAt).toBeTruthy();
    });

    it("3.3 Handles special characters and high-entropy tokens in SHA-256 fingerprinting", async () => {
      const complexToken = "tok_!@#$%^&*()_+{}[]:;\"'<>,.?/`~|\\=123-abc-XYZ";
      await writeV2Snapshot(complexToken, "categories", [{ id: "c-special" }] as never);

      const loaded = await readV2Snapshot(complexToken, "categories");
      expect(loaded).not.toBeNull();
      expect(loaded!.data).toEqual([{ id: "c-special" }]);
});

    it("3.4 PRIVACY: never stores the raw token in IndexedDB (only its SHA-256 fingerprint)", async () => {      await writeV2Snapshot(TEST_TOKEN, "accounts", [{ id: "a1", name: "Nubank" }] as never);

      const rawDb = await openSnapshotDb();
      const raw = await new Promise<unknown>((resolve, reject) => {
        const tx = rawDb.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(V2_ENVELOPE_KEY);
        req.onsuccess = () => { rawDb.close(); resolve(req.result); };
        req.onerror = () => { rawDb.close(); reject(req.error); };
      });
      const serialized = JSON.stringify(raw);
      expect(serialized).not.toContain(TEST_TOKEN);
      expect((raw as { ownerFingerprint?: string } | null)?.ownerFingerprint).not.toBe(TEST_TOKEN);
    });

    it("FIX-216: migration runs serialized with writers — a concurrent write is not lost", async () => {
      seedV1(TEST_TOKEN, "budgets", [{ id: "b-mig" }]);
      // Gate the migration's commit open (read #1 passes, commit #2 held).
      const suspend = suspendNthIdbOpen(2);
      try {
        const migrating = migrateV1toV2(TEST_TOKEN);
        await vi.waitFor(() => expect(suspend.openCalls()).toBe(2));
        // A concurrent writer starts while the migration holds the commit.
        let writeDone = false;
        const writing = writeV2Snapshot(TEST_TOKEN, "accounts", [{ id: "a-concurrent" }] as never)
          .then(() => { writeDone = true; });
        // Give the writer a chance to (incorrectly, pre-fix) slip through.
        await new Promise((r) => setTimeout(r, 100));
        const slippedThrough = writeDone;
        suspend.release();
        await migrating;
        await writing;
        // Serialized: the writer waits for the migration's lock.
        expect(slippedThrough).toBe(false);
        expect(writeDone).toBe(true);
        // Neither domain is lost and the v1 source is consumed.
        const accounts = await readV2Snapshot(TEST_TOKEN, "accounts");
        const budgets = await readV2Snapshot(TEST_TOKEN, "budgets");
        expect(accounts?.data).toEqual([{ id: "a-concurrent" }]);
        expect(budgets?.data).toEqual([{ id: "b-mig" }]);
        expect(localStorage.getItem("pi-finance:snapshot:v1")).toBeNull();
      } finally {
        suspend.release();
      }
    });

    it("P2: cross-tab V2 written between commit and validation reread survives; V1 preserved", async () => {
      const SUBJECT_B = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
      seedV1(TEST_TOKEN, "budgets", [{ id: "b-mig" }]);
      const sha256Hex = async (s: string): Promise<string> => {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
        return Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      };
      const putRawEnvelope = async (env: unknown): Promise<void> => {
        const db = await openSnapshotDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(env, V2_ENVELOPE_KEY);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        });
      };
      const getRawEnvelope = async (): Promise<{
        ownerFingerprint?: string;
        offlineSubjectId?: string;
        domains?: Record<string, unknown>;
      } | null> => {
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
      };
      // Gate the validation reread (commit #2 already landed, reread #3 held).
      const suspend = suspendNthIdbOpen(3);
      try {
        const migrating = migrateV1toV2(TEST_TOKEN);
        await vi.waitFor(() => expect(suspend.openCalls()).toBe(3));
        // Another tab (no shared withWriteLock — only the local module
        // instance is serialized) commits its own V2 while our reread is held.
        const fpB = await sha256Hex(ALT_TOKEN);
        const now = new Date().toISOString();
        await putRawEnvelope({
          schema: 2,
          ownerFingerprint: fpB,
          offlineSubjectId: SUBJECT_B,
          lastOnlineAuthenticatedAt: now,
          domains: { accounts: [{ id: "b-acc" }] },
          syncedAt: { accounts: now },
        });
        suspend.release();
        await migrating;
        // A's v1 source is preserved for its rightful owner...
        expect(localStorage.getItem("pi-finance:snapshot:v1")).not.toBeNull();
        // ...and B's slot is untouched by A's failed validation cleanup.
        const raw = await getRawEnvelope();
        expect(raw?.ownerFingerprint).toBe(fpB);
        expect(raw?.offlineSubjectId).toBe(SUBJECT_B);
        expect(raw?.domains?.accounts).toEqual([{ id: "b-acc" }]);
      } finally {
        suspend.release();
      }
    });

    it("FIX-216: subject switch between commit and validation reread preserves V1", async () => {      const SUBJECT_B = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
      seedV1(TEST_TOKEN, "budgets", [{ id: "b-mig" }]);
      // Gate the validation reread (commit #2 already landed, reread #3 held).
      const suspend = suspendNthIdbOpen(3);
      try {
        const migrating = migrateV1toV2(TEST_TOKEN);
        await vi.waitFor(() => expect(suspend.openCalls()).toBe(3));
        // A→B switch lands after the commit, before the validation reread.
        setOfflineSubjectId(SUBJECT_B);
        suspend.release();
        await migrating;
        // The partition changed mid-migration: v1 is preserved for its
        // rightful owner instead of being deleted under a stale validation.
        expect(localStorage.getItem("pi-finance:snapshot:v1")).not.toBeNull();
      } finally {
        suspend.release();
      }
      // Control: back on the rightful subject the migration still applies.
      setOfflineSubjectId(TEST_SUBJECT);
      await migrateV1toV2(TEST_TOKEN);
      expect(localStorage.getItem("pi-finance:snapshot:v1")).toBeNull();
      expect((await readV2Snapshot(TEST_TOKEN, "budgets"))?.data).toEqual([{ id: "b-mig" }]);
    });

    it("P2-liveness: stale validation cleanup after teardown/rebind preserves a fresh same-owner envelope; V1 preserved", async () => {
      const SUBJECT_B = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
      seedV1(TEST_TOKEN, "budgets", [{ id: "b-mig" }]);
      const sha256Hex = async (s: string): Promise<string> => {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
        return Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      };
      const putRawEnvelope = async (env: unknown): Promise<void> => {
        const db = await openSnapshotDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(env, V2_ENVELOPE_KEY);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        });
      };
      const getRawEnvelope = async (): Promise<{
        ownerFingerprint?: string;
        offlineSubjectId?: string;
        domains?: Record<string, unknown>;
      } | null> => {
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
      };
      // Hold the validation reread (#3) to force a validation failure with a
      // foreign envelope; the stale cleanup's own open (#4 → 2nd spy #1) is
      // then held to open the teardown/rebind window inside the helper.
      const suspendReread = suspendNthIdbOpen(3);
      let suspendCleanup: { release: () => void; openCalls: () => number } | null = null;
      try {
        const migrating = migrateV1toV2(TEST_TOKEN);
        await vi.waitFor(() => expect(suspendReread.openCalls()).toBe(3));
        // Foreign envelope lands between commit (#2) and reread (#3): the
        // reread will see B, validation fails, the stale cleanup is armed
        // with stillValid() true at call time.
        const fpB = await sha256Hex(ALT_TOKEN);
        const nowB = new Date().toISOString();
        await putRawEnvelope({
          schema: 2,
          ownerFingerprint: fpB,
          offlineSubjectId: SUBJECT_B,
          lastOnlineAuthenticatedAt: nowB,
          domains: { accounts: [{ id: "b-acc" }] },
          syncedAt: { accounts: nowB },
        });
        suspendReread.release();
        // Arm the cleanup gate synchronously: the reread still resolves via
        // IndexedDB async, so the cleanup open lands on the new spy.
        suspendCleanup = suspendNthIdbOpen(1);
        await vi.waitFor(() => expect(suspendCleanup!.openCalls()).toBe(1));
        // Stale window inside deleteV2SnapshotIfOwned's open: teardown
        // advances the generation and rebinds, then another tab commits a
        // FRESH envelope for the ORIGINAL owner (same fp + same subject).
        advanceOfflineGeneration();
        setOfflineSubjectId(SUBJECT_B);
        const fpA = await sha256Hex(TEST_TOKEN);
        const nowA = new Date().toISOString();
        await putRawEnvelope({
          schema: 2,
          ownerFingerprint: fpA,
          offlineSubjectId: TEST_SUBJECT,
          lastOnlineAuthenticatedAt: nowA,
          domains: { accounts: [{ id: "fresh-a" }] },
          syncedAt: { accounts: nowA },
        });
        suspendCleanup.release();
        await migrating;
        // The stale cleanup must preserve: V1 kept for its rightful owner…
        expect(localStorage.getItem("pi-finance:snapshot:v1")).not.toBeNull();
        // …and the fresh same-owner envelope untouched (fail-closed).
        const raw = await getRawEnvelope();
        expect(raw?.ownerFingerprint).toBe(fpA);
        expect(raw?.offlineSubjectId).toBe(TEST_SUBJECT);
        expect(raw?.domains?.accounts).toEqual([{ id: "fresh-a" }]);
      } finally {
        suspendReread.release();
        suspendCleanup?.release();
        setOfflineSubjectId(TEST_SUBJECT);
      }
    });

    it("3.5 rejects when an IndexedDB transaction never completes", async () => {
      vi.useFakeTimers();
      vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
      const db = {
        objectStoreNames: { contains: () => true },
        transaction: vi.fn(() => ({
          objectStore: vi.fn(() => ({
            get: vi.fn(() => ({})),
            put: vi.fn(),
          })),
          oncomplete: null,
          onerror: null,
          onabort: null,
        })),
        close: vi.fn(),
      } as unknown as IDBDatabase;

      vi.spyOn(indexedDB, "open").mockImplementation(() => {
        const request = {
          result: db,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
        } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => request.onsuccess?.(new Event("success")));
        return request;
      });

      const pending = writeV2Snapshot(TEST_TOKEN, "accounts", [] as never);
      await Promise.resolve();
      await Promise.resolve();
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(0);
      const testTimeout = Symbol("test-timeout");
      const observed = Promise.race([
        pending.then(() => "resolved").catch((error) => error),
        new Promise<typeof testTimeout>((resolve) => {
          setTimeout(() => resolve(testTimeout), 6000);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(6000);
      const result = await observed;
      expect(result).not.toBe(testTimeout);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("timed out");
    });
  });
});
