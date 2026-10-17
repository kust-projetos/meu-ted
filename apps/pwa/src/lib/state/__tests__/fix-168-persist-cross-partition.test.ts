import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBootstrap } from "../sync-engine";
import type { AppStateAction } from "../state-reducer";
import * as endpoints from "@/lib/api/endpoints";
import {
  clearActiveWorkspaceId,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "@/lib/api/client";
import { getOfflineSubjectId } from "@/lib/auth/offline-subject";
import {
  DB_NAME,
  STORE_NAME,
  V2_ENVELOPE_KEY,
  openSnapshotDb,
  readV2Snapshot,
  writeV2Snapshot,
} from "../snapshot-db";

/**
 * FIX-168-FIX3 (HIGH REVIEWER-168-R2 — persistência V2 permite atribuição
 * cruzada A→B).
 *
 * Mecanismo: o guard de identidade do engine roda antes de
 * writeV2Snapshot, mas writeV2Snapshot faz `await fingerprint(token)` e SÓ
 * DEPOIS lê getOfflineSubjectId(); freshEnvelope() também relê o subject
 * global. Respostas de A passam no guard → gravações suspendem no
 * fingerprint → seleção muda para B → gravação retoma e salva payload de A
 * com subject B. Cancelamento/remount não cancela essas gravações.
 *
 * Estes testes usam IndexedDB real (fake-indexeddb, como o restante do
 * repo), subjects UUID válidos, troca A→B DURANTE o fingerprint/lock e
 * bootstrap concorrente de B executando de fato — sem mocks na persistência.
 */

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const TOKEN = "shared-token-fix-168-fix3";

const ACCOUNTS_A = [{ id: "acc-A-1", name: "Conta A" }];
const ACCOUNTS_B = [{ id: "acc-B-1", name: "Conta B" }];

async function readRawEnvelope(): Promise<{
  offlineSubjectId?: string;
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

/** Suspende crypto.subtle.digest até `release()` — alarga o gap do fingerprint. */
function gateDigest(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async (...args: Parameters<SubtleCrypto["digest"]>) => {
      await gate;
      return realDigest(...args);
    },
  );
  return {
    release: () => {
      release();
      vi.mocked(crypto.subtle.digest).mockRestore();
    },
  };
}

function mockReadsTaggedByWorkspace(extra?: {
  gateAccounts?: Promise<never[]>;
}): void {
  // Cada fetch responde com o marcador do workspace ATIVO no momento da
  // chamada — o bootstrap de A carrega dado de A, o de B carrega dado de B.
  const tagged = () => (getActiveWorkspaceId() === WS_B ? ACCOUNTS_B : ACCOUNTS_A);
  vi.spyOn(endpoints, "fetchAccounts").mockImplementation(async () => {
    if (extra?.gateAccounts) await extra.gateAccounts;
    return tagged() as never;
  });
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

describe("FIX-168-FIX3: persistência V2 nunca atribui dado de A à partição de B", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    clearActiveWorkspaceId();
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    // Garante DB recriado vazio (o delete acima é assíncrono no fake).
    const db = await openSnapshotDb();
    db.close();
    expect(DB_NAME).toBe("pi-finance-snapshot");
  });

  it("write iniciado em A que retoma com B ativo é descartado (gap do fingerprint)", async () => {
    const { release } = gateDigest();
    setActiveWorkspaceId(WS_A);
    expect(getOfflineSubjectId()).toBe(WS_A);

    // Persistência REAL (sem mock): suspende no fingerprint com subject A.
    const pending = writeV2Snapshot(TOKEN, "accounts", ACCOUNTS_A as never);
    // Troca A→B DURANTE o fingerprint — a gravação ainda não leu o subject.
    setActiveWorkspaceId(WS_B);
    expect(getOfflineSubjectId()).toBe(WS_B);

    release();
    await pending;

    // Sem o fix, o envelope nasce com subject B contendo dado de A (vazamento
    // cruzado: leitura sob B serviria dado de A). Com o fix, zero escrita.
    const raw = await readRawEnvelope();
    expect(raw).toBeNull();
    expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
  });

  it("write com identidade esperada do bootstrap descarta quando a seleção mudou", async () => {
    const { release } = gateDigest();
    setActiveWorkspaceId(WS_A);

    // O engine transporta a identidade capturada na entrada do bootstrap.
    const pending = writeV2Snapshot(TOKEN, "accounts", ACCOUNTS_A as never, {
      expectedSubject: WS_A,
    });
    setActiveWorkspaceId(WS_B);
    release();
    await pending;

    const raw = await readRawEnvelope();
    expect(raw).toBeNull();
    expect(await readV2Snapshot(TOKEN, "accounts")).toBeNull();
  });

  it("bootstrap de A em voo + bootstrap concorrente de B: partição de B só tem dado de B", async () => {
    const { release } = gateDigest();
    mockReadsTaggedByWorkspace();
    setActiveWorkspaceId(WS_A);
    expect(getOfflineSubjectId()).toBe(WS_A);

    // Bootstrap de A com persistência REAL: fetches resolvem já (dado de A),
    // o guard passa com A ativo e as 7 gravações suspendem no fingerprint.
    const dispatchedA: AppStateAction[] = [];
    const bootA = runBootstrap(TOKEN, (a) => dispatchedA.push(a), vi.fn());

    // Aguarda o guard de A passar (DOMAIN_LIVE emitido) com saves suspensos.
    await vi.waitFor(() => {
      expect(dispatchedA.some((a) => a.type === "DOMAIN_LIVE")).toBe(true);
    });

    // Troca A→B e inicia o bootstrap concorrente de B — executando de fato
    // (fetches próprios, dado de B), enquanto as gravações de A seguem
    // suspensas no fingerprint/lock.
    setActiveWorkspaceId(WS_B);
    expect(getOfflineSubjectId()).toBe(WS_B);
    let resolveBAccounts!: (v: never[]) => void;
    const accountsGateB = new Promise<never[]>((resolve) => {
      resolveBAccounts = resolve;
    });
    vi.mocked(endpoints.fetchAccounts).mockImplementation(async () => {
      if (getActiveWorkspaceId() === WS_B) await accountsGateB;
      return (getActiveWorkspaceId() === WS_B ? ACCOUNTS_B : ACCOUNTS_A) as never;
    });
    const dispatchedB: AppStateAction[] = [];
    const bootB = runBootstrap(TOKEN, (a) => dispatchedB.push(a), vi.fn());

    // Libera o fingerprint: as gravações tardias de A retomam COM B ATIVO.
    release();
    await bootA;

    // Janela crítica: B ativo, bootstrap de B ainda em voo. Sem o fix, as
    // gravações de A aterrissaram na partição de B (leitura sob B serve
    // dado de A). Com o fix, nada de A foi persistido sob B.
    const leaked = await readV2Snapshot(TOKEN, "accounts");
    expect(leaked).toBeNull();

    // Completa o bootstrap de B e confirma que só dado de B persistiu.
    resolveBAccounts([]);
    await bootB;
    const stored = await readV2Snapshot(TOKEN, "accounts");
    expect(stored).not.toBeNull();
    expect(stored!.data).toEqual(ACCOUNTS_B);
    const raw = await readRawEnvelope();
    expect(raw?.offlineSubjectId).toBe(WS_B);
    expect(JSON.stringify(raw?.domains)).not.toContain("acc-A-1");
  });
});
