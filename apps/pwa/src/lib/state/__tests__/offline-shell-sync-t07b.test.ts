/**
 * T07b — shell e helpers (offline V3): syncTransactionsPage com identidade V3
 * + contrato estático do offline-shell.js.
 *
 * Contrato sob teste:
 * - syncTransactionsPage aceita uma identidade V3 opcional (4º parâmetro) e
 *   persiste a página em V3 SEM quebrar a assinatura existente (token,
 *   options, dispatch) e SEM exigir bearer/token;
 * - sem v3Identity, nada é escrito em V3 (não- regressão);
 * - v3Identity obsoleta/divergente da identidade viva nunca persiste sob
 *   outro workspace (nunca re-atribui por heurística);
 * - offline-shell.js: lê o slot "v3" single-slot com ownerKey
 *   (principal + workspace vinculados online), cobre /compromissos e /hub/*,
 *   bloqueia owner divergente/idade inválida/corrompido, NUNCA renova a idade
 *   offline (zero escritas) e NUNCA usa device token como chave/dono.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as endpoints from "@/lib/api/endpoints";
import { clearActiveWorkspaceId, setActiveWorkspaceId } from "@/lib/api/client";
import { bindOfflineIdentity } from "@/lib/auth/offline-identity";
import { readV3Snapshot } from "../snapshot-db";
import { syncTransactionsPage } from "../sync-engine";
import type { AppStateAction } from "../state-reducer";

const USER_A = "user-a-001";
const WS_X = "11111111-2222-4333-8444-555555555555";
const WS_Y = "22222222-3333-4444-8555-666666666666";

const TXS = [
  {
    id: "tx-page-1",
    description: "Mercado",
    amountCents: 5000,
    date: "2026-08-19",
    kind: "expense" as const,
    categoryId: "c1",
    accountId: "a1",
  },
];

async function wipeDb(): Promise<void> {
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipeDb();
  localStorage.clear();
  clearActiveWorkspaceId();
  setActiveWorkspaceId("ws-test-1");
  bindOfflineIdentity(USER_A, WS_X);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
    items: TXS,
    total: 100,
    page: 1,
    limit: 50,
  });
});

describe("T07b syncTransactionsPage com identidade V3", () => {
  it("persiste a página em V3 quando a identidade validada é fornecida (sem token)", async () => {
    const dispatched: AppStateAction[] = [];
    const result = await syncTransactionsPage(
      undefined,
      { page: 1, limit: 50 },
      (a) => {
        dispatched.push(a);
      },
      { principalId: USER_A, workspaceId: WS_X },
    );

    expect(result.items).toEqual(TXS);
    expect(
      dispatched.some((a) => a.type === "DOMAIN_LIVE" && a.domain === "transactions"),
    ).toBe(true);
    const v3 = await readV3Snapshot(USER_A, WS_X, "transactions");
    expect(v3).not.toBeNull();
    expect(v3!.data).toEqual(TXS);
  });

  it("não escreve em V3 quando nenhuma identidade é fornecida", async () => {
    const dispatched: AppStateAction[] = [];
    await syncTransactionsPage(undefined, { page: 1, limit: 50 }, (a) => {
      dispatched.push(a);
    });

    expect(
      dispatched.some((a) => a.type === "DOMAIN_LIVE" && a.domain === "transactions"),
    ).toBe(true);
    expect(await readV3Snapshot(USER_A, WS_X, "transactions")).toBeNull();
  });

  it("identidade obsoleta nunca persiste sob outro workspace", async () => {
    const dispatched: AppStateAction[] = [];
    await syncTransactionsPage(
      undefined,
      { page: 1, limit: 50 },
      (a) => {
        dispatched.push(a);
      },
      // A identidade viva é (USER_A, WS_X): este owner divergente deve ser descartado.
      { principalId: USER_A, workspaceId: WS_Y },
    );

    // Re-liga como (USER_A, WS_Y): nada pode ter sido persistido sob Y.
    bindOfflineIdentity(USER_A, WS_Y);
    expect(await readV3Snapshot(USER_A, WS_Y, "transactions")).toBeNull();
  });
});

describe("T07b contrato estático do offline-shell.js", () => {
  const shell = readFileSync(
    path.resolve(process.cwd(), "public/offline-shell.js"),
    "utf8",
  );

  it("lê o slot V3 single-slot com a identidade offline (principal + workspace)", () => {
    expect(shell).toContain('"v3"');
    expect(shell).toContain("pi-finance:offline-principal");
    expect(shell).toContain("pi-finance:offline-workspace");
    // ownerKey = versão + principal + workspace (nunca credencial).
    expect(shell).toContain("v3:");
  });

  it("cobre /compromissos e /hub/*", () => {
    expect(shell).toContain("/compromissos");
    expect(shell).toContain("/hub/patrimonio");
    expect(shell).toContain("/hub/planejamento");
    expect(shell).toContain("/hub/relatorios");
    expect(shell).toContain("/hub/alertas");
    expect(shell).toContain("/hub/categorias");
    expect(shell).toContain("/hub/configuracoes");
  });

  it("nunca usa device token como chave ou dono", () => {
    expect(shell.toLowerCase()).not.toContain("device");
    expect(shell).not.toContain("x-agent-device");
  });

  it("nunca renova a idade offline: zero escritas em IDB/localStorage", () => {
    expect(shell).not.toContain("readwrite");
    expect(shell).not.toContain(".put(");
    expect(shell).not.toContain("setItem");
    expect(shell).not.toMatch(/lastOnlineAuthenticatedAt\s*=[^=]/);
  });

  it("espelha a regra de skew do app (max(5min, 5% da idade máxima))", () => {
    expect(shell).toContain("5*60*1000");
  });
});

describe("T07b-R1 execução real do offline-shell.js (findings do review)", () => {
  const shellSource = () =>
    readFileSync(path.resolve(process.cwd(), "public/offline-shell.js"), "utf8");

  const LOCK_TEXT = "offline session locked";
  const SUBJECT_S = "33333333-4444-4555-8666-777777777777";
  const SUBJECT_OTHER = "44444444-5555-4666-8777-888888888888";

  async function seedStore(entries: Record<string, unknown>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("pi-finance-snapshot", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("snapshots");
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("snapshots", "readwrite");
        const store = tx.objectStore("snapshots");
        for (const [k, v] of Object.entries(entries)) store.put(v as never, k);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
      open.onerror = () => reject(open.error);
    });
  }

  function setShellIdentity(
    principal: string | null,
    workspace: string | null,
    subject: string | null,
  ): void {
    localStorage.clear();
    if (principal) localStorage.setItem("pi-finance:offline-principal", principal);
    if (workspace) localStorage.setItem("pi-finance:offline-workspace", workspace);
    if (subject) localStorage.setItem("pi-finance:offline-subject", subject);
  }

  async function runShell(pathname: string): Promise<unknown[]> {
    document.body.innerHTML =
      '<h1 id="page-title"></h1><p id="page-route"></p><p id="synced-at"></p><div id="content"></div>';
    window.history.pushState({}, "", pathname);
    const errors: unknown[] = [];
    const onUnhandled = (e: Event) => {
      errors.push((e as PromiseRejectionEvent).reason ?? e);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      // Executa a lógica real do shell (IIFE lê pathname + IDB + localStorage).
      (0, eval)(shellSource());
      if (document.readyState === "loading") {
        document.dispatchEvent(new Event("DOMContentLoaded"));
      }
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
    return errors;
  }

  const contentText = () => document.getElementById("content")?.textContent ?? "";

  function v2Envelope(overrides: Record<string, unknown> = {}) {
    return {
      domains: {
        accounts: [{ id: "a-v2", name: "Conta V2 Legada", amountCents: 12345 }],
      },
      syncedAt: {},
      offlineSubjectId: SUBJECT_S,
      lastOnlineAuthenticatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function v3Envelope(overrides: Record<string, unknown> = {}) {
    return {
      schema: 3,
      domains: {
        accounts: [{ id: "a-v3", description: "Mercado V3", amountCents: 5000 }],
      },
      syncedAt: { accounts: new Date().toISOString() },
      offlinePrincipalId: USER_A,
      offlineWorkspaceId: WS_X,
      ownerKey: `v3:${USER_A}:${WS_X}`,
      lastOnlineAuthenticatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("a) V3 ausente + V2 válido → renderiza o legado sem InvalidStateError", async () => {
    await seedStore({ v2: v2Envelope() });
    setShellIdentity(USER_A, WS_X, SUBJECT_S);
    const errors = await runShell("/");
    expect(errors).toEqual([]);
    expect(contentText()).toContain("Conta V2 Legada");
    expect(contentText()).not.toContain(LOCK_TEXT);
  });

  it("b1) V3 ausente + V2 com subject divergente → lock", async () => {
    await seedStore({ v2: v2Envelope({ offlineSubjectId: SUBJECT_OTHER }) });
    setShellIdentity(USER_A, WS_X, SUBJECT_S);
    await runShell("/");
    expect(contentText()).toContain(LOCK_TEXT);
  });

  it("b2) V3 ausente + V2 expirado → lock", async () => {
    await seedStore({
      v2: v2Envelope({ lastOnlineAuthenticatedAt: "2020-01-01T00:00:00.000Z" }),
    });
    setShellIdentity(USER_A, WS_X, SUBJECT_S);
    await runShell("/");
    expect(contentText()).toContain(LOCK_TEXT);
  });

  it("c) V3 com lastOnlineAuthenticatedAt como array → lock (sem coerção)", async () => {
    await seedStore({
      v3: v3Envelope({ lastOnlineAuthenticatedAt: [new Date().toISOString()] }),
    });
    setShellIdentity(USER_A, WS_X, SUBJECT_S);
    await runShell("/");
    expect(contentText()).toContain(LOCK_TEXT);
    expect(contentText()).not.toContain("Mercado V3");
  });

  it("d) V3 com lastOnlineAuthenticatedAt numérico → lock", async () => {
    await seedStore({
      v3: v3Envelope({ lastOnlineAuthenticatedAt: Date.now() }),
    });
    setShellIdentity(USER_A, WS_X, SUBJECT_S);
    await runShell("/");
    expect(contentText()).toContain(LOCK_TEXT);
    expect(contentText()).not.toContain("Mercado V3");
  });

  it("e) V3 válido → ainda renderiza (sem regressão)", async () => {
    await seedStore({ v3: v3Envelope(), v2: v2Envelope() });
    setShellIdentity(USER_A, WS_X, SUBJECT_S);
    const errors = await runShell("/");
    expect(errors).toEqual([]);
    expect(contentText()).toContain("Mercado V3");
    expect(contentText()).not.toContain(LOCK_TEXT);
  });
});
