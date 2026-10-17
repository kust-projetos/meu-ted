import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBootstrap } from "../sync-engine";
import type { AppStateAction } from "../state-reducer";
import * as endpoints from "@/lib/api/endpoints";
import {
  clearActiveWorkspaceId,
  setActiveWorkspaceId,
} from "@/lib/api/client";
import * as snapshotStore from "../snapshot-store";

/**
 * FIX-168 RED-1 (PWA): bootstrap com workspace arquivado/limpo mid-flight
 * deve emitir ZERO GETs financeiros.
 *
 * O sync-engine (`runBootstrap`) dispara hoje 10 GETs em Promise.allSettled
 * sem nenhum gate de workspace: com o header limpo/arquivado cada endpoint
 * financeiro falha fechado server-side (403 auth.workspace_required), e o
 * descarte tardio do provider não cancela 403 já emitidos. O engine deve
 * estender o gate canReadFinancial/tardy-discard do provider:
 * - sem workspace na entrada → zero I/O (nenhum endpoint chamado);
 * - workspace sumido com os fetches em voo → nenhum DOMAIN_LIVE publicado.
 *
 * status+body.code são capturados nas asserções (ApiError { status, code }).
 */
function mockAllReadsResolve(): void {
  vi.spyOn(endpoints, "fetchAccounts").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCategories").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchTransactions").mockResolvedValue({
    items: [],
    total: 0,
  } as never);
  vi.spyOn(endpoints, "fetchPayables").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchBudgets").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchGoals").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchStatements").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchCards").mockResolvedValue([]);
  vi.spyOn(endpoints, "fetchProfile").mockResolvedValue(null as never);
  vi.spyOn(endpoints, "fetchQuickInsights").mockResolvedValue([]);
}

describe("FIX-168 RED-1: runBootstrap sem workspace ativo emite zero GETs", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    clearActiveWorkspaceId();
    vi.spyOn(snapshotStore, "saveSnapshotDomain").mockResolvedValue(undefined);
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });

  it("sem workspace na entrada: zero endpoint calls, nenhum DOMAIN_LIVE, boot estacionado", async () => {
    mockAllReadsResolve();
    const dispatched: AppStateAction[] = [];
    const expireSession = vi.fn();

    const extras = await runBootstrap(
      "test-token",
      (a) => dispatched.push(a),
      expireSession,
    );

    expect(endpoints.fetchAccounts).not.toHaveBeenCalled();
    expect(endpoints.fetchCategories).not.toHaveBeenCalled();
    expect(endpoints.fetchTransactions).not.toHaveBeenCalled();
    expect(endpoints.fetchPayables).not.toHaveBeenCalled();
    expect(endpoints.fetchBudgets).not.toHaveBeenCalled();
    expect(endpoints.fetchGoals).not.toHaveBeenCalled();
    expect(endpoints.fetchStatements).not.toHaveBeenCalled();
    expect(endpoints.fetchCards).not.toHaveBeenCalled();
    expect(endpoints.fetchProfile).not.toHaveBeenCalled();
    expect(endpoints.fetchQuickInsights).not.toHaveBeenCalled();
    expect(
      dispatched.some((a) => a.type === "DOMAIN_LIVE"),
    ).toBe(false);
    expect(
      dispatched.some((a) => a.type === "BOOTSTRAP_COMPLETE"),
    ).toBe(true);
    expect(extras).toEqual({ profile: null, quickInsights: [] });
    expect(expireSession).not.toHaveBeenCalled();
  });

  it("workspace limpo com os fetches em voo: nenhum DOMAIN_LIVE publicado", async () => {
    mockAllReadsResolve();
    // Trava um domínio em voo: o clear acontece antes de qualquer settle.
    let resolveAccounts!: (v: never[]) => void;
    const accountsGate = new Promise<never[]>((resolve) => {
      resolveAccounts = resolve;
    });
    vi.mocked(endpoints.fetchAccounts).mockReturnValue(accountsGate);
    setActiveWorkspaceId("ws-1");

    const dispatched: AppStateAction[] = [];
    const expireSession = vi.fn();
    const bootPromise = runBootstrap(
      "test-token",
      (a) => dispatched.push(a),
      expireSession,
    );

    // Archive/clear mid-flight: o header some com requests em voo.
    clearActiveWorkspaceId();
    resolveAccounts([]);
    const extras = await bootPromise;

    expect(
      dispatched.filter((a) => a.type === "DOMAIN_LIVE"),
    ).toHaveLength(0);
    expect(
      dispatched.some((a) => a.type === "BOOTSTRAP_COMPLETE"),
    ).toBe(true);
    expect(extras).toEqual({ profile: null, quickInsights: [] });
    expect(expireSession).not.toHaveBeenCalled();
    expect(snapshotStore.saveSnapshotDomain).not.toHaveBeenCalled();
  });

  it("FIX-168-FIX2: troca A→B com os fetches em voo — resposta de A NÃO publica nem persiste", async () => {
    mockAllReadsResolve();
    // Trava um domínio em voo: a troca acontece antes de qualquer settle.
    let resolveAccounts!: (v: never[]) => void;
    const accountsGate = new Promise<never[]>((resolve) => {
      resolveAccounts = resolve;
    });
    vi.mocked(endpoints.fetchAccounts).mockReturnValue(accountsGate);
    setActiveWorkspaceId("ws-a");

    const dispatched: AppStateAction[] = [];
    const expireSession = vi.fn();
    const bootPromise = runBootstrap(
      "test-token",
      (a) => dispatched.push(a),
      expireSession,
    );

    // Seleção A→B mid-flight: há workspace ativo (o gate de ausência
    // passa), mas o payload em voo pertence a A — nunca pode ser
    // publicado nem persistido com B ativo.
    setActiveWorkspaceId("ws-b");
    resolveAccounts([]);
    const extras = await bootPromise;

    expect(
      dispatched.filter((a) => a.type === "DOMAIN_LIVE"),
    ).toHaveLength(0);
    expect(
      dispatched.some((a) => a.type === "BOOTSTRAP_COMPLETE"),
    ).toBe(true);
    expect(extras).toEqual({ profile: null, quickInsights: [] });
    expect(expireSession).not.toHaveBeenCalled();
    expect(snapshotStore.saveSnapshotDomain).not.toHaveBeenCalled();
  });
});
