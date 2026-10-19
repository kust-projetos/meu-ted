/**
 * Sync engine — orchestrates the bootstrap data fetch, dispatches
 * reducer actions, and persists to v2 (IndexedDB) snapshot.
 *
 * v2 is canonical: all snapshot reads/writes use IndexedDB, not localStorage.
 * Preloaded snapshot data is optionally passed in for offline bootstrap.
 */

import * as endpoints from "@/lib/api/endpoints";
import { ApiError, getActiveWorkspaceId } from "@/lib/api/client";
import { getOfflineSubjectId } from "@/lib/auth/offline-subject";
import { getOfflineWorkspaceId } from "@/lib/auth/offline-identity";
import {
  OFFLINE_COHERENCE_RELOAD_MESSAGE,
  isOfflineCoherent,
} from "@/lib/auth/offline-coherence";
import { isMembershipRevocation } from "@/lib/auth/auth-state-machine";
import { type DomainKey, type AppStateAction, ESSENTIAL_DOMAIN_KEYS } from "./state-reducer";
import { saveSnapshotDomain, saveV3SnapshotDomain } from "./snapshot-store";
import type { WriteV2SnapshotOptions } from "./snapshot-db";
import type { Account, Profile, QuickInsight, Transaction } from "./types";

type Dispatch = (action: AppStateAction) => void;

/**
 * Domains published by runBootstrap (subscriptions lazy-load separately).
 * Used to park every domain the engine owns when there is no workspace to
 * address the payload to (FIX-168 zero-I/O / tardy-discard).
 */
const ENGINE_BOOTSTRAP_DOMAINS: DomainKey[] = [
  "accounts",
  "categories",
  "transactions",
  "payables",
  "budgets",
  "goals",
  "cardStatements",
];

/**
 * FIX-168 (P0 #168): parks the bootstrap without any network I/O and without
 * publishing live data. Mirrors the provider tardy-discard
 * (app-state-context): every engine-owned domain goes unavailable (read-only
 * derives from that) and the boot completes so no loader hangs.
 */
function parkBootstrapWithoutWorkspace(dispatch: Dispatch): void {
  for (const domain of ENGINE_BOOTSTRAP_DOMAINS) {
    dispatch({ type: "DOMAIN_UNAVAILABLE", domain });
  }
  dispatch({ type: "BOOTSTRAP_COMPLETE" });
}

/**
 * #215 (coherence fail-closed): estaciona o bootstrap sem I/O e sem
 * publicar/gravar quando a aba, o subject V2 e o workspace V3 divergem.
 * Conclui o boot (sem spinner) e informa recarregar/revalidar — nunca
 * reescreve subject, purga cache ou desloga.
 */
function parkBootstrapIncoherent(dispatch: Dispatch): void {
  for (const domain of ENGINE_BOOTSTRAP_DOMAINS) {
    dispatch({ type: "DOMAIN_UNAVAILABLE", domain });
  }
  // Erro acionável antes da conclusão (ordem canônica: SET_ERROR precede
  // BOOTSTRAP_COMPLETE, como no caminho de falha essencial abaixo).
  dispatch({ type: "SET_ERROR", error: OFFLINE_COHERENCE_RELOAD_MESSAGE });
  dispatch({ type: "BOOTSTRAP_COMPLETE" });
}

/**
 * #215: coerência viva da aba contra as partições compartilhadas. O V3 em
 * uso é a identidade validada quando presente, senão o binding persistido.
 * `v3WorkspaceId === undefined` restringe ao par aba×subject (gate de fetch);
 * com o V3 informado, exige a tripla (gate de persistência/publicação V3).
 */
function liveCoherence(v3WorkspaceId?: string | null): boolean {
  if (v3WorkspaceId === undefined) {
    return isOfflineCoherent(getActiveWorkspaceId(), getOfflineSubjectId(), null);
  }
  return isOfflineCoherent(
    getActiveWorkspaceId(),
    getOfflineSubjectId(),
    v3WorkspaceId ?? getOfflineWorkspaceId(),
  );
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

/** Preloaded snapshot data, keyed by domain. Passed when booting from offline cache. */
export type SnapshotPreload = Partial<Record<DomainKey, { data: unknown; syncedAt: string }>>;

/**
 * Values already fetched by the bootstrap that the provider needs outside the
 * reducer. Returning them lets callers hydrate profile/insights without a
 * second network fetch.
 */
export interface BootstrapExtras {
  profile: Profile | null;
  quickInsights: QuickInsight[];
}

/**
 * Validated offline identity for V3 snapshot writes (Phase 3, AUTH-02):
 * the server-confirmed user principal + the known current workspace.
 * Identity-keyed writes need no bearer — cookie-only boots persist here.
 */
export interface V3SnapshotIdentity {
  principalId: string;
  workspaceId: string;
}

/**
 * Run the full bootstrap: fetch all domains, classify results, dispatch,
 * and persist live data to v2 snapshot.
 *
 * @param token — snapshot key (token-derived fingerprint). `undefined` on
 *   cookie-only boots: reads still run via the cookie session, but v2
 *   snapshot writes are skipped (never persist a snapshot that cannot be
 *   owner-checked).
 * @param dispatch — dispatches reducer actions
 * @param expireSession — called on 401
 * @param snapshotPreload — optional preloaded v2 snapshot data for offline boot
 * @param v3Identity — validated offline identity: every live domain is also
 *   written to the V3 slot (works cookie-only — no token required)
 * @returns the profile and quick insights fetched during the bootstrap
 */
export async function runBootstrap(
  token: string | undefined,
  dispatch: Dispatch,
  expireSession: () => void,
  snapshotPreload?: SnapshotPreload,
  v3Identity?: V3SnapshotIdentity,
): Promise<BootstrapExtras> {
  dispatch({ type: "BOOTSTRAP_START" });

  // FIX-168 (P0 #168): sem workspace ativo nenhum endpoint financeiro
  // responde 2xx — cada GET falharia fechado server-side (403
  // auth.workspace_required). Estaciona com zero I/O em vez de coletar
  // rejeições que o descarte tardio não poderia cancelar.
  if (getActiveWorkspaceId() === undefined) {
    parkBootstrapWithoutWorkspace(dispatch);
    return { profile: null, quickInsights: [] };
  }

  // #215 (coherence fail-closed, pré-fetch): o par aba × subject V2 precisa
  // concordar ANTES de qualquer I/O. Par estável A/B (sem troca mid-flight,
  // só divergência) estaciona com zero fetch/publicação/gravação. A tripla
  // com o V3 é exigida na persistência/publicação V3 (rejeição cirúrgica —
  // a via V2 coerente segue intacta).
  if (!liveCoherence(undefined)) {
    parkBootstrapIncoherent(dispatch);
    return { profile: null, quickInsights: [] };
  }

  // FIX-168-FIX2 (HIGH — descarte tardio verifica identidade, não só
  // ausência): vincula o bootstrap à identidade capturada na entrada. Se a
  // seleção trocar mid-flight (A→B), o payload em voo pertence a A mas a
  // sessão endereça B — descarta antes de publicar/persistir, em vez de
  // entregar dado órfão à partição corrente.
  // FIX-168-FIX3: transporta também o subject (partição do snapshot V2)
  // capturado aqui — a persistência usa o capturado e descarta gravações
  // tardias cuja identidade mudou nos gaps assíncronos (fingerprint/lock).
  const bootstrapWorkspaceId = getActiveWorkspaceId();
  const bootstrapSubject = getOfflineSubjectId();
  const bootstrapV3Workspace = v3Identity?.workspaceId ?? getOfflineWorkspaceId();

  const results = await Promise.allSettled([
    endpoints.fetchAccounts(),
    endpoints.fetchCategories(),
    endpoints.fetchTransactions({ limit: 200 }),
    endpoints.fetchPayables(),
    endpoints.fetchBudgets(),
    endpoints.fetchGoals(),
    endpoints.fetchStatements(),
    endpoints.fetchCards(),
    endpoints.fetchProfile(),
    endpoints.fetchQuickInsights(),
  ]);

  // Runtime 401 short-circuit, plus D10 revocation: a 403
  // workspace_forbidden means the membership is gone — the session is
  // unauthenticated, never offline-capable. expireSession purges the
  // snapshot; no DOMAIN_SNAPSHOT fallback may serve revoked data.
  const unauthorized = results.some(
    (r) => r.status === "rejected" && r.reason instanceof ApiError && r.reason.status === 401,
  );
  const revoked = results.some(
    (r) =>
      r.status === "rejected" &&
      r.reason instanceof ApiError &&
      isMembershipRevocation(r.reason.status, r.reason.code),
  );
  if (unauthorized || revoked) {
    expireSession();
    dispatch({ type: "BOOTSTRAP_401" });
    return { profile: null, quickInsights: [] };
  }

  // FIX-168-FIX3: identidade = workspace + subject (partição V2). O
  // subject é consultado na gravação (snapshot-db), por isso a checagem é
  // por IDENTIDADE (inalterada desde a entrada), não só por ausência —
  // publicar resposta de A com B ativo atribuiria dado à partição corrente.
  // #215: além da estabilidade, o par precisa seguir coerente na saída —
  // resposta tardia pós-troca não publica nem grava sob outro workspace,
  // mesmo quando cada lado parece "estável" sozinho. A tripla com o V3 é
  // revalidada por escrita (v3WriteOk): V3 divergente é rejeitado sem
  // estacionar a via V2 coerente.
  const v3EntryCoherent =
    v3Identity === undefined ||
    isOfflineCoherent(bootstrapWorkspaceId, bootstrapSubject, bootstrapV3Workspace);
  const v3ExitCoherent = (): boolean =>
    v3Identity === undefined ||
    isOfflineCoherent(
      getActiveWorkspaceId(),
      getOfflineSubjectId(),
      v3Identity.workspaceId,
    );
  if (
    getActiveWorkspaceId() !== bootstrapWorkspaceId ||
    getOfflineSubjectId() !== bootstrapSubject ||
    !isOfflineCoherent(getActiveWorkspaceId(), getOfflineSubjectId(), null)
  ) {
    parkBootstrapIncoherent(dispatch);
    return { profile: null, quickInsights: [] };
  }

  // #215: a via V3 persiste somente com a tripla coerente na entrada e na
  // saída (header=subject=A com V3=B = rejeição cirúrgica da via V3; a via
  // V2 coerente segue intacta). Sem awaits até o allSettled, um cálculo basta.
  const v3Persist =
    v3Identity !== undefined && v3EntryCoherent && v3ExitCoherent();

  // Profile/insights are fetched here and returned to the caller — never
  // re-fetched by the provider (boot dedupe).
  const profileResult = results[8];
  const insightsResult = results[9];
  const extras: BootstrapExtras = {
    profile: profileResult.status === "fulfilled" ? (profileResult.value as Profile | null) : null,
    quickInsights: insightsResult.status === "fulfilled" ? (insightsResult.value as QuickInsight[]) : [],
  };

  // Collect v2 save promises so we await them before BOOTSTRAP_COMPLETE.
  // Skipped cookie-only (token undefined): without an owner-checkable key
  // no snapshot write is safe — Phase 3 (V3) reintroduces it keyed by
  // authenticated identity.
  // FIX-168-FIX3: cada escrita V2 carrega a identidade capturada na entrada;
  // a persistência descarta gravações tardias cuja partição mudou nos gaps
  // assíncronos em vez de re-atribuí-las ao subject vigente.
  const savePromises: Promise<void>[] = [];
  const v2WriteOpts: WriteV2SnapshotOptions = { expectedSubject: bootstrapSubject };

  // ── Accounts + credit cards merge ────────────────────────
  {
    const accountsResult = results[0];
    const cardsResult = results[7];
    const accountsOk = accountsResult.status === "fulfilled";
    const cardsOk = cardsResult.status === "fulfilled";
    const cardsData = cardsOk ? (cardsResult.value as Account[]) : [];

    let merged: Account[] | null = null;

    if (accountsOk) {
      merged = [...(accountsResult.value as Account[])];
      for (const c of cardsData) {
        const idx = merged.findIndex((m) => m.id === c.id);
        if (idx >= 0) merged[idx] = c;
        else merged.push(c);
      }
      dispatch({ type: "DOMAIN_LIVE", domain: "accounts", data: merged, syncedAt: new Date().toISOString() });
      if (token !== undefined) savePromises.push(saveSnapshotDomain(token, "accounts", merged, v2WriteOpts));
      if (v3Identity !== undefined && v3Persist) {
        savePromises.push(
          saveV3SnapshotDomain(v3Identity.principalId, v3Identity.workspaceId, "accounts", merged).catch(() => {}),
        );
      }
    } else if (cardsData.length > 0) {
      merged = cardsData;
      dispatch({ type: "DOMAIN_LIVE", domain: "accounts", data: cardsData, syncedAt: new Date().toISOString() });
      if (token !== undefined) savePromises.push(saveSnapshotDomain(token, "accounts", cardsData, v2WriteOpts));
      if (v3Identity !== undefined && v3Persist) {
        savePromises.push(
          saveV3SnapshotDomain(v3Identity.principalId, v3Identity.workspaceId, "accounts", cardsData).catch(() => {}),
        );
      }
    } else {
      // Snapshot fallback from preload or unavailable
      const preloaded = snapshotPreload?.accounts;
      if (preloaded) {
        dispatch({ type: "DOMAIN_SNAPSHOT", domain: "accounts", data: preloaded.data, syncedAt: preloaded.syncedAt });
      } else {
        dispatch({ type: "DOMAIN_UNAVAILABLE", domain: "accounts" });
      }
    }
  }

  // ── Helper for standard list domains ─────────────────────
  function applyListDomain(domain: DomainKey, resultIndex: number): void {
    const result = results[resultIndex];
    if (result.status === "fulfilled") {
      const value = result.value;
      dispatch({ type: "DOMAIN_LIVE", domain, data: value, syncedAt: new Date().toISOString() });
      if (token !== undefined) savePromises.push(saveSnapshotDomain(token, domain, value as never, v2WriteOpts));
      if (v3Identity !== undefined && v3Persist) {
        savePromises.push(
          saveV3SnapshotDomain(v3Identity.principalId, v3Identity.workspaceId, domain, value as never).catch(() => {}),
        );
      }
    } else {
      const preloaded = snapshotPreload?.[domain];
      if (preloaded) {
        dispatch({ type: "DOMAIN_SNAPSHOT", domain, data: preloaded.data, syncedAt: preloaded.syncedAt });
      } else {
        dispatch({ type: "DOMAIN_UNAVAILABLE", domain });
      }
    }
  }

  applyListDomain("categories", 1);

  // transactions — unwrap { items, total }
  {
    const txResult = results[2];
    if (txResult.status === "fulfilled") {
      const items = (txResult.value as { items: unknown }).items;
      dispatch({ type: "DOMAIN_LIVE", domain: "transactions", data: items, syncedAt: new Date().toISOString() });
      if (token !== undefined) savePromises.push(saveSnapshotDomain(token, "transactions", items as never, v2WriteOpts));
      if (v3Identity !== undefined && v3Persist) {
        savePromises.push(
          saveV3SnapshotDomain(v3Identity.principalId, v3Identity.workspaceId, "transactions", items as never).catch(() => {}),
        );
      }
    } else {
      const preloaded = snapshotPreload?.transactions;
      if (preloaded) {
        dispatch({ type: "DOMAIN_SNAPSHOT", domain: "transactions", data: preloaded.data, syncedAt: preloaded.syncedAt });
      } else {
        dispatch({ type: "DOMAIN_UNAVAILABLE", domain: "transactions" });
      }
    }
  }

  applyListDomain("payables", 3);
  applyListDomain("budgets", 4);
  applyListDomain("goals", 5);
  applyListDomain("cardStatements", 6);

  // Profile and insights — handled outside reducer, not persisted to snapshot
  // (returned to the caller via `extras` instead of being re-fetched)

  // Global error if any essential domain failed
  const anyEssentialFailed = ESSENTIAL_DOMAIN_KEYS.some((_, i) => results[i].status === "rejected");
  if (anyEssentialFailed) {
    dispatch({ type: "SET_ERROR", error: "Alguns dados não puderam ser atualizados." });
  }

  // Await all v2 snapshot writes before signalling completion.
  // This guarantees snapshot is consistent when UI loads.
  await Promise.allSettled(savePromises);

  dispatch({ type: "BOOTSTRAP_COMPLETE" });

  return extras;
}

/**
 * Synchronizes a paginated slice of transactions.
 *
 * @param v3Identity — validated offline identity (same contract as
 *   runBootstrap): the fetched page is also written to the V3 slot when the
 *   live offline identity still matches at commit time. `writeV3Snapshot`
 *   drops stale/divergent owners — never re-attributed by heuristic.
 */
export async function syncTransactionsPage(
  token: string | undefined,
  options: PaginationOptions = { page: 1, limit: 50 },
  dispatch?: Dispatch,
  v3Identity?: V3SnapshotIdentity,
): Promise<{ items: Transaction[]; total: number; page: number; limit: number }> {
  const page = options.page ?? 1;
  const limit = options.limit ?? 50;
  // FIX-168-FIX3: vincula à identidade vigente antes do fetch — sem ela, uma
  // troca A→B em voo publicaria/persistiria a página de A sob B.
  // #215 (coherence fail-closed, pré-fetch): o par aba×subject faz zero
  // fetch quando divergente; o V3 divergente é rejeitado só na persistência.
  const pageWorkspaceId = getActiveWorkspaceId();
  const pageSubject = getOfflineSubjectId();
  if (!isOfflineCoherent(pageWorkspaceId, pageSubject, null)) {
    return { items: [], total: 0, page, limit };
  }
  const res = await endpoints.fetchTransactions({ page, limit });
  if (dispatch) {
    if (
      getActiveWorkspaceId() !== pageWorkspaceId ||
      getOfflineSubjectId() !== pageSubject ||
      !isOfflineCoherent(getActiveWorkspaceId(), getOfflineSubjectId(), null)
    ) {
      return { items: res.items, total: res.total, page, limit };
    }
    dispatch({
      type: "DOMAIN_LIVE",
      domain: "transactions",
      data: res.items,
      syncedAt: new Date().toISOString(),
    });
    if (token !== undefined) void saveSnapshotDomain(token, "transactions", res.items, { expectedSubject: pageSubject });
    // #215: a página só cai no slot V3 com a tripla coerente na entrada e no
    // commit (header=subject=A com V3=B = rejeição da via V3, sem bloquear a
    // publicação live/V2 coerente). O writer interno também descarta donos
    // obsoletos — nunca re-atribui por heurística.
    if (
      v3Identity !== undefined &&
      isOfflineCoherent(pageWorkspaceId, pageSubject, v3Identity.workspaceId) &&
      isOfflineCoherent(getActiveWorkspaceId(), getOfflineSubjectId(), v3Identity.workspaceId)
    ) {
      // Awaited (unlike the legacy V2 fire-and-forget above): callers may
      // read-after-write, mirroring runBootstrap awaiting every save before
      // completion. Stale/divergent owners are dropped inside — never throw.
      await saveV3SnapshotDomain(
        v3Identity.principalId,
        v3Identity.workspaceId,
        "transactions",
        res.items,
      ).catch(() => {});
    }
  }
  return {
    items: res.items,
    total: res.total,
    page,
    limit,
  };
}
