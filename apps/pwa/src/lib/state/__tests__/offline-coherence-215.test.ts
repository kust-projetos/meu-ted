/**
 * #215 (opção a — coherence check fail-closed) — RED.
 *
 * Exige coerência entre workspace da aba (getActiveWorkspaceId), subject V2
 * (offline-subject) e workspace V3 utilizado, além das estabilidades.
 * Sem identidade coerente → zero fetch, zero publicação/gravação, boot
 * concluído (sem spinner), sem purga global, sem logout.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBootstrap, syncTransactionsPage } from "../sync-engine";
import type { AppStateAction } from "../state-reducer";
import * as endpoints from "@/lib/api/endpoints";
import {
  clearActiveWorkspaceId,
  setActiveWorkspaceId,
  getActiveWorkspaceId,
} from "@/lib/api/client";
import { getOfflineSubjectId, setOfflineSubjectId } from "@/lib/auth/offline-subject";
import { bindOfflineIdentity } from "@/lib/auth/offline-identity";
import { openSnapshotDb, readV3Snapshot, writeV3Snapshot } from "../snapshot-db";
import * as snapshotStore from "../snapshot-store";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "user-a-001";
const TOKEN = "token-215-coherence";
const ACCOUNTS_A = [{ id: "acc-A-1", name: "Conta A" }];
const ACCOUNTS_B = [{ id: "acc-B-1", name: "Conta B" }];

/**
 * Suspende a N-ésima chamada a IndexedDB.open (1-based), expondo a janela
 * exata entre a leitura do envelope (#1) e o commit (#2) do writeV3Snapshot.
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

async function readRawV3Envelope(): Promise<{
  offlineWorkspaceId?: string;
  domains?: Record<string, unknown>;
} | null> {
  const db = await openSnapshotDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", "readonly");
      const req = tx.objectStore("snapshots").get("v3");
      req.onsuccess = () => resolve((req.result as never) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function wipeDb(): Promise<void> {
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
  const db = await openSnapshotDb();
  db.close();
}

function mockAllLive() {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue(ACCOUNTS_A as never);
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({ items: [], total: 0 } as never);
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null as never);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
}

describe("#215 coherence fail-closed", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    clearActiveWorkspaceId();
    await wipeDb();
  });

  it("par estável A/B = zero fetch + zero publicação/gravação V2/V3", async () => {
    // Aba = A, subject compartilhado = B (outra aba gravou B por último).
    setActiveWorkspaceId(WS_A);
    expect(getActiveWorkspaceId()).toBe(WS_A);
    // Força a divergência compartilhada sem passar pelo choke point.
    localStorage.setItem("pi-finance:offline-subject", WS_B);
    localStorage.setItem("pi-finance:offline-workspace", WS_B);
    expect(getOfflineSubjectId()).toBe(WS_B);

    mockAllLive();
    const fetchSpy = vi.mocked(endpoints.fetchAccounts);
    const saveV2 = vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    const saveV3 = vi.spyOn(snapshotStore, "saveV3SnapshotDomain").mockResolvedValue(undefined);

    const dispatched: AppStateAction[] = [];
    await runBootstrap(TOKEN, (a) => dispatched.push(a), vi.fn(), undefined, {
      principalId: USER_A,
      workspaceId: WS_B,
    });

    // Zero fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Zero publicação live.
    expect(dispatched.some((a) => a.type === "DOMAIN_LIVE")).toBe(false);
    // Zero gravação.
    expect(saveV2).not.toHaveBeenCalled();
    expect(saveV3).not.toHaveBeenCalled();
    // Sem spinner preso: boot conclui como indisponível.
    expect(dispatched.some((a) => a.type === "BOOTSTRAP_COMPLETE")).toBe(true);
    expect(dispatched.some((a) => a.type === "DOMAIN_UNAVAILABLE")).toBe(true);
  });

  it("header=subject=A com V3=B rejeita a via V3", async () => {
    setActiveWorkspaceId(WS_A);
    expect(getOfflineSubjectId()).toBe(WS_A);
    bindOfflineIdentity(USER_A, WS_A);
    mockAllLive();
    const saveV3 = vi.spyOn(snapshotStore, "saveV3SnapshotDomain").mockResolvedValue(undefined);
    vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);

    const dispatched: AppStateAction[] = [];
    await runBootstrap(TOKEN, (a) => dispatched.push(a), vi.fn(), undefined, {
      principalId: USER_A,
      workspaceId: WS_B,
    });

    // V3 divergente nunca persiste.
    expect(saveV3).not.toHaveBeenCalled();
    // E nada sob B pode ser lido como A.
    bindOfflineIdentity(USER_A, WS_B);
    expect(await readV3Snapshot(USER_A, WS_B, "accounts")).toBeNull();
  });

  it("paginacao com par A/B não faz fetch", async () => {
    setActiveWorkspaceId(WS_A);
    localStorage.setItem("pi-finance:offline-subject", WS_B);
    const spy = vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
    } as never);
    const dispatched: AppStateAction[] = [];
    await syncTransactionsPage(TOKEN, { page: 1, limit: 50 }, (a) => dispatched.push(a));
    expect(spy).not.toHaveBeenCalled();
    expect(dispatched.some((a) => a.type === "DOMAIN_LIVE")).toBe(false);
  });

  it("leitura V3 valida contra a seleção da aba (cache B nunca em aba A)", async () => {
    // Semeia o cache de B com identidade B viva.
    setActiveWorkspaceId(WS_B);
    bindOfflineIdentity(USER_A, WS_B);
    await writeV3Snapshot(USER_A, WS_B, "accounts", ACCOUNTS_A as never);
    expect(await readV3Snapshot(USER_A, WS_B, "accounts")).not.toBeNull();

    // Aba A (seleção A) com identidade compartilhada ainda B (outra aba):
    // mesmo com o compartilhado casando B, a seleção da aba diverge.
    setActiveWorkspaceId(WS_A);
    localStorage.setItem("pi-finance:offline-workspace", WS_B);
    localStorage.setItem("pi-finance:offline-subject", WS_B);
    expect(await readV3Snapshot(USER_A, WS_B, "accounts")).toBeNull();
    // Dono legítimo segue intacto ao voltar (seleção B + compartilhado B).
    setActiveWorkspaceId(WS_B);
    localStorage.setItem("pi-finance:offline-workspace", WS_B);
    localStorage.setItem("pi-finance:offline-subject", WS_B);
    expect(await readV3Snapshot(USER_A, WS_B, "accounts")).not.toBeNull();
  });

  it("commit V3 com subject A→B na segunda abertura aborta sem persistir (fail-closed); envelope alheio intacto", async () => {
    // Semeia o envelope alheio de B com identidade B viva.
    setActiveWorkspaceId(WS_B);
    bindOfflineIdentity(USER_A, WS_B);
    await writeV3Snapshot(USER_A, WS_B, "accounts", ACCOUNTS_B as never);
    expect(await readV3Snapshot(USER_A, WS_B, "accounts")).not.toBeNull();

    // Volta ao caminho coerente A/A e suspende a abertura do commit (#2:
    // #1 = leitura do envelope, #2 = abertura dentro de writeV3Envelope).
    setActiveWorkspaceId(WS_A);
    bindOfflineIdentity(USER_A, WS_A);
    const suspend = suspendNthIdbOpen(2);
    try {
      const writing = writeV3Snapshot(USER_A, WS_A, "accounts", ACCOUNTS_A as never);
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(2));
      // Troca A→B no intervalo (espelho da aba segue A — incoerência).
      setOfflineSubjectId(WS_B);
      suspend.release();
      await writing;

      // Slot cru: nada foi persistido nem deletado — segue sendo de B.
      const raw = await readRawV3Envelope();
      expect(raw?.offlineWorkspaceId).toBe(WS_B);
      expect(raw?.domains?.["accounts"]).toEqual(ACCOUNTS_B);

      // Sob coerência A/A restaurada, nada de A foi persistido…
      setOfflineSubjectId(WS_A);
      expect(await readV3Snapshot(USER_A, WS_A, "accounts")).toBeNull();
      // …e o envelope alheio de B segue intacto.
      setActiveWorkspaceId(WS_B);
      bindOfflineIdentity(USER_A, WS_B);
      const reloaded = await readV3Snapshot(USER_A, WS_B, "accounts");
      expect(reloaded?.data).toEqual(ACCOUNTS_B);
    } finally {
      suspend.release();
    }
  });

  it("controle: commit V3 A/A com abertura suspensa persiste", async () => {
    setActiveWorkspaceId(WS_A);
    bindOfflineIdentity(USER_A, WS_A);
    const suspend = suspendNthIdbOpen(2);
    try {
      const writing = writeV3Snapshot(USER_A, WS_A, "accounts", ACCOUNTS_A as never);
      await vi.waitFor(() => expect(suspend.openCalls()).toBe(2));
      suspend.release();
      await writing;
      const reloaded = await readV3Snapshot(USER_A, WS_A, "accounts");
      expect(reloaded?.data).toEqual(ACCOUNTS_A);
    } finally {
      suspend.release();
    }
  });

  it("caminho coerente A/A publica e persiste", async () => {
    setActiveWorkspaceId(WS_A);
    bindOfflineIdentity(USER_A, WS_A);
    mockAllLive();
    vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    vi.spyOn(snapshotStore, "saveV3SnapshotDomain").mockResolvedValue(undefined);
    const dispatched: AppStateAction[] = [];
    await runBootstrap(TOKEN, (a) => dispatched.push(a), vi.fn(), undefined, {
      principalId: USER_A,
      workspaceId: WS_A,
    });
    expect(dispatched.some((a) => a.type === "DOMAIN_LIVE" && a.domain === "accounts")).toBe(true);
    expect(dispatched[dispatched.length - 1].type).toBe("BOOTSTRAP_COMPLETE");
  });
});
