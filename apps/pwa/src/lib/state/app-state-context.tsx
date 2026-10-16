"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import type {
  Transaction,
  Account,
  Category,
  Payable,
  Budget,
  Goal,
  Debt,
  Subscription,
  CardStatement,
  Profile,
  QuickInsight,
  DashboardSummary,
} from "./types";
import {
  ALL_MOCK_TRANSACTIONS,
  mockAccounts,
  mockCategories,
  mockPayables,
  mockBudgets,
  mockGoals,
  mockDebts,
  mockSubscriptions,
  mockDashboardSummary,
} from "./mock-data";
import { isApiConfigured, getAuthToken, getSessionToken, getActiveWorkspaceId } from "@/lib/api/client";
import { getSessionStatus } from "@/lib/auth/session-authority";
import { type DomainKey } from "./snapshot-store";
import { useSession } from "@/lib/auth/session-context";
import { ApiError } from "@/lib/api/client";
import * as endpoints from "@/lib/api/endpoints";
import { runBootstrap, type SnapshotPreload } from "./sync-engine";
import type { AppStateAction } from "./state-reducer";
import { migrateV1toV2, loadSnapshotDomain } from "./snapshot-store";
import {
  getOfflinePrincipalId,
  getOfflineWorkspaceId,
} from "@/lib/auth/offline-identity";
import { loadV3SnapshotDomain, migrateV2toV3Snapshot } from "./snapshot-store";
import type { V3SnapshotIdentity } from "./sync-engine";
import {
  getOfflineSnapshotLockState,
  getV3OfflineLockState,
  refreshOfflineAuthAge,
} from "./snapshot-db";
import { stampLastOnlineAuthenticatedAt } from "@/lib/session";
import { recordClientEvent } from "@/lib/telemetry/client-events";
import { createCommands, type Commands, type CommandIdOptions } from "./commands";
import { getFailedCommandId, isRetryableMutationError } from "@/lib/api/command-id";
import {
  createMutationReconciler,
  extractMutationReceipt,
  RECONCILIATION_STALE_MESSAGE,
  type ReconcileInput,
  type ReconcileResult,
} from "./mutation-reconciler";
import type {
  MutationKind,
  MutationReceipt,
  RefreshTarget,
} from "@pi-finance/llm-contracts/types";
import { useUnsavedChangesSafe } from "@/lib/unsaved-changes";
import { createProfileAdapter } from "./profile-adapter";
import { createSubscriptionsAdapter } from "./subscriptions-adapter";

export interface AppState {
  // Data
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  payables: Payable[];
  budgets: Budget[];
  goals: Goal[];
  debts: Debt[];
  subscriptions: Subscription[];
  cardStatements: CardStatement[];
  profile: Profile | null;
  quickInsights?: QuickInsight[];
  dashboardSummary: DashboardSummary | null;
  saveProfile: (input: {
    name?: string;
    email?: string;
    phone?: string;
    avatarColor?: string;
    greetingStyle?: Profile["greetingStyle"];
  }) => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshDashboardSummary: () => Promise<void>;
  /**
   * Strict authoritative summary refresh (FIX-PWA-HOME-SNAPSHOT-SUMMARY):
   * throws when the API is unusable or the fetch fails, so snapshot-retry
   * owners (Home) can surface a dedicated retryable error. The lenient
   * `refreshDashboardSummary` above never throws (nulls the summary).
   */
  refreshDashboardSummaryStrict?: () => Promise<void>;
  // Sync / mode
  sync: Record<DomainKey, DomainSync>;
  readOnly: boolean;
  /**
   * Offline session lock (V4 T2.6, SPEC §10 D2-D3): true when the snapshot
   * age exceeds MAX_OFFLINE_AUTH_AGE or the subject partition cannot be
   * verified. Locked UI must not render financial data; revalidation
   * online (revalidateOfflineSession) unlocks.
   */
  offlineLocked: boolean;
  /** Online revalidation: refresh the age stamp and unlock. False on failure. */
  revalidateOfflineSession: () => Promise<boolean>;
  // Fetch state
  loading: boolean;
  error: string | null;
  writeError: string | null;
  clearWriteError: () => void;
  /**
   * Intent id behind the surfaced write error (V4.1 Task 3.9 / Finding 2):
   * the command id the commands layer stamped onto the failed intent. Set
   * iff the error carries one AND its outcome may be unknown
   * (`isRetryableMutationError` — network drop, timeout, 5xx); definitive
   * 4xx/409 rejections never arm a retry. Null otherwise.
   */
  writeErrorCommandId?: string | null;
  /**
   * Manual retry bound to `writeErrorCommandId`: re-invokes the failed
   * mutation with the SAME command id, so the server replays the original
   * receipt instead of executing a second effect (committed-but-lost
   * response). Set only for unknown-outcome failures; null when the last
   * error is definitive (4xx/409), carries no command id, or captured
   * no retry inputs. Resolves when the retry settles (success clears the
   * banner; failure re-stores the fresh error); never rejects.
   */
  retryWriteError?: (() => Promise<unknown>) | null;
  // Write actions
  // Object-input writes accept an optional `idempotencyKey` so a manual
  // retry after an unknown outcome reuses the failed intent's SAME command
  // id (forwarded verbatim to the commands layer); omit it for a new intent.
  // Id-only writes take an optional trailing `CommandIdOptions` instead.
  addTransaction: (tx: Transaction & { idempotencyKey?: string }) => Promise<void>;
  updateTransaction: (
    id: string,
    input: {
      description?: string;
      date?: string;
      amountCents?: number;
      accountId?: string;
      categoryId?: string;
      idempotencyKey?: string;
    },
  ) => Promise<void>;
  deleteTransaction: (id: string, options?: CommandIdOptions) => Promise<void>;
  markPayablePaid: (
    id: string,
    options?: CommandIdOptions & { paidDate?: string },
  ) => Promise<void>;
  cancelPayable: (id: string, options?: CommandIdOptions) => Promise<void>;
  updatePayable: (id: string, input: {
    description?: string;
    amountCents?: number;
    dueDate?: string;
    accountId?: string;
    categoryId?: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  undoPayablePayment: (id: string, options?: CommandIdOptions) => Promise<void>;
  createPayable: (input: {
    accountId: string;
    description: string;
    amountCents: number;
    dueDate: string;
    categoryId?: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  createBudget: (input: {
    categoryId: string;
    name: string;
    amountCents: number;
    period: "monthly" | "quarterly" | "yearly";
    startDate: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  updateBudget: (
    id: string,
    input: { amountCents?: number; alertThreshold?: number; idempotencyKey?: string },
  ) => Promise<void>;
  createGoal: (input: {
    name: string;
    goalType: "savings" | "purchase" | "debt_payoff" | "emergency_fund";
    targetAmountCents: number;
    startDate: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  contributeToGoal: (
    id: string,
    input: { amountCents: number; idempotencyKey?: string },
  ) => Promise<void>;
  cancelGoal: (id: string, options?: CommandIdOptions) => Promise<void>;
  updateGoal: (id: string, input: {
    name?: string;
    targetAmountCents?: number;
    targetDate?: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  addAccount: (input: {
    name: string;
    kind: "bank" | "cash" | "credit_card";
    initialBalanceCents: number;
    idempotencyKey?: string;
  }) => Promise<void>;
  updateAccount: (id: string, input: { name: string; idempotencyKey?: string }) => Promise<void>;
  deactivateAccount: (id: string, options?: CommandIdOptions) => Promise<void>;
  addCategory: (input: {
    name: string;
    kind: "expense" | "income";
    parentId?: string;
    icon?: string | null;
    color?: string | null;
    idempotencyKey?: string;
  }) => Promise<void>;
  updateCategory: (id: string, input: { name?: string; icon?: string | null; color?: string | null; idempotencyKey?: string }) => Promise<void>;
  deactivateCategory: (id: string, options?: CommandIdOptions) => Promise<void>;
  deleteCategory: (
    id: string,
    input: ({ mode: "move"; destinationCategoryId: string } | { mode: "cascade"; confirm: true }) & { idempotencyKey?: string },
  ) => Promise<{ movedTransactions: number; softDeletedTransactions: number }>;
  applyCategoryDefaults: (options?: CommandIdOptions) => Promise<{ created: number; skipped: number }>;
  addCard: (input: {
    name: string;
    creditLimitCents: number;
    closingDay: number;
    dueDay: number;
    idempotencyKey?: string;
  }) => Promise<void>;
  updateCard: (
    id: string,
    input: {
      name?: string;
      creditLimitCents?: number;
      closingDay?: number;
      dueDay?: number;
      idempotencyKey?: string;
    },
  ) => Promise<void>;
  addSubscription: (input: {
    name: string;
    amountCents: number;
    cycle: "monthly" | "yearly" | "weekly";
    day: number;
    paymentMethod: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  cancelSubscription: (id: string, options?: CommandIdOptions) => Promise<void>;
  updateSubscription: (id: string, input: {
    name?: string;
    amountCents?: number;
    cycle?: "monthly" | "yearly" | "weekly";
    day?: number;
    paymentMethod?: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  /** Lazy-load subscriptions on demand — not fetched during bootstrap */
  refreshSubscriptions: () => Promise<void>;
  createTransfer: (input: {
    description: string;
    amountCents: number;
    date: string;
    fromAccountId: string;
    toAccountId: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  payStatement: (
    statementId: string,
    input: { amountCents: number; fromAccountId: string; idempotencyKey?: string },
  ) => Promise<void>;
  createInstallments: (input: {
    accountId: string;
    description: string;
    totalAmountCents: number;
    purchaseDate: string;
    installmentsTotal: number;
    categoryId?: string;
    subcategoryId?: string;
    notes?: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  createCardPurchase: (input: {
    accountId: string;
    description: string;
    amountCents: number;
    date: string;
    categoryId?: string;
    subcategoryId?: string;
    notes?: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  /**
   * Re-fetches the given domains from the API and updates provider state
   * (used to invalidate stale data after out-of-band mutations, e.g.
   * approving a pending operation).
   */
  refreshDomains: (domains: DomainKey[]) => Promise<boolean>;
  /**
   * Single reconciliation entry (SPEC §15.2, T3.3): consumes a
   * MutationReceipt from either origin (TED approval with operationId or
   * normal write without) — or a mutationKind fallback when the response
   * carries no receipt yet — and refreshes only the registry-derived
   * targets. Refresh failures mark domains stale (never roll back).
   */
  reconcileMutation?: (input: ReconcileInput) => Promise<ReconcileResult>;
  /** Stale-reconciliation notice (SPEC §15.5) — null when fully reconciled. */
  reconciliationStale?: { message: string; targets: RefreshTarget[] } | null;
  /** Retries the refresh of the stale targets only. */
  retryReconciliation?: () => Promise<void>;
  dismissReconciliationStale?: () => void;
}

/**
 * Provider write mutators that run through the commands layer and therefore
 * carry an intent command id. The manual-retry registry (`writeApiRef`)
 * holds the latest bound instances so a banner retry re-invokes the failed
 * mutation with the SAME id instead of minting a new intent.
 */
export type RetryableWrites = Pick<
  AppState,
  | "addTransaction" | "updateTransaction" | "deleteTransaction"
  | "markPayablePaid" | "cancelPayable" | "updatePayable" | "undoPayablePayment"
  | "createPayable" | "createBudget" | "updateBudget" | "createGoal"
  | "contributeToGoal" | "cancelGoal" | "updateGoal" | "addAccount"
  | "updateAccount" | "deactivateAccount" | "addCategory" | "updateCategory"
  | "deactivateCategory" | "deleteCategory" | "applyCategoryDefaults"
  | "addCard" | "updateCard" | "addSubscription" | "cancelSubscription"
  | "updateSubscription" | "createTransfer" | "payStatement"
  | "createInstallments" | "createCardPurchase"
>;

/**
 * A failed intent pending manual retry: the surfaced command id plus a thunk
 * that re-invokes the same mutation with that SAME id threaded through.
 */
export interface FailedWriteIntent {
  commandId: string;
  retry: () => Promise<unknown>;
}

/**
 * Builds the retry thunk once the failed intent's command id is known. The
 * factory runs at failure time (the id is read off the surfaced error via
 * `getFailedCommandId`); the thunk itself runs later, on banner click.
 */
export type WriteRetryFactory = (commandId: string) => () => Promise<unknown>;

const AppStateContext = createContext<AppState | null>(null);

// ── Sync / read-only types & constants ────────────────────────────

export type DataSource = "live" | "snapshot" | "unavailable" | "mock";
export interface DomainSync { source: DataSource; syncedAt: string | null }

const ESSENTIAL_DOMAINS: DomainKey[] = [
  "accounts", "categories", "transactions", "payables", "budgets", "goals",
];

const ALL_DOMAINS: DomainKey[] = [
  ...ESSENTIAL_DOMAINS, "subscriptions", "cardStatements",
];

const STALE_SOURCES: DataSource[] = ["snapshot", "unavailable"];

function initialSync(source: DataSource): Record<DomainKey, DomainSync> {
  return Object.fromEntries(
    ALL_DOMAINS.map((d) => [d, { source, syncedAt: null }]),
  ) as Record<DomainKey, DomainSync>;
}

/**
 * True when API base URL is configured AND the session authority allows
 * online use (V4.1 Closure AUTH-01, session-first, SPEC §4/INV-02).
 *
 * Online use requires a server-confirmed `authenticated` session (cookie via
 * `credentials: "include"` in apiFetch) — a legacy bearer in storage NEVER
 * unlocks live I/O by itself (V41C FIX 1). `unauthenticated` stays closed;
 * `unreachable` routes exclusively through the V3 offline path
 * (`resolveUnreachableOfflineRoute`, never live bootstrap); `unknown`
 * (pre-probe boot) waits for probe resolution instead of bootstrapping on
 * bearer presence. Compat ON keeps the normal legacy boot working (bearer
 * present + probe succeeds → `authenticated`); compat OFF is cookie session
 * authority only. Device-scoped flows and the offline snapshot keying still
 * use the device token where present (snapshot partition key untouched).
 */
function apiUsable(): boolean {
  if (!isApiConfigured()) return false;
  return getSessionStatus().status === "authenticated";
}

/**
 * FIX-168-R2 (P2 SECREVIEW-168-167): gate comum de leitura financeira.
 * Todo read/reconciliação exige sessão confirmada (apiUsable) E workspace
 * ativo (header X-Workspace-Id presente). Sem workspace, cada endpoint
 * financeiro falha fechado server-side (403 workspace_required) — bloquear
 * localmente com zero I/O em vez de coletar rejeições.
 */
function hasActiveWorkspace(): boolean {
  return getActiveWorkspaceId() !== undefined;
}

function canReadFinancial(): boolean {
  return apiUsable() && hasActiveWorkspace();
}

const NO_ACTIVE_WORKSPACE_MESSAGE =
  "Nenhum workspace ativo — selecione ou restaure um workspace para continuar.";

/**
 * Effective online credential for bootstrap/snapshot reads: device token
 * wins when present (existing snapshot partitions keep working); otherwise
 * the compat session bearer. Never persisted — snapshot stores only its
 * SHA-256 fingerprint.
 */
function effectiveOnlineToken(): string | undefined {
  return getAuthToken() ?? getSessionToken();
}

/**
 * Merges a server profile projection over the previous state without ever
 * degrading server-computed flags. The PATCH /profile projection may omit
 * `isAdmin` (and legacy `role`); an omitted flag must preserve the known
 * state, while an explicit server value (including false) always wins.
 */
export function mergeProfileFlags(prev: Profile | null, next: Profile): Profile {
  if (!prev) return next;
  const merged: Profile = { ...next };
  if (merged.isAdmin === undefined) merged.isAdmin = prev.isAdmin;
  const prevRole = (prev as unknown as { role?: string }).role;
  if ((merged as unknown as { role?: string }).role === undefined && prevRole !== undefined) {
    (merged as unknown as { role?: string }).role = prevRole;
  }
  return merged;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const configured = isApiConfigured();
  // ── State — empty when API configured, mock only when not ─────────
  const [accounts, setAccounts] = useState<Account[]>(configured ? [] : mockAccounts);
  const [categories, setCategories] = useState<Category[]>(configured ? [] : mockCategories);
  const [transactions, setTransactions] =
    useState<Transaction[]>(configured ? [] : ALL_MOCK_TRANSACTIONS);
  const [payables, setPayables] = useState<Payable[]>(configured ? [] : mockPayables);
  const [budgets, setBudgets] = useState<Budget[]>(configured ? [] : mockBudgets);
  const [goals, setGoals] = useState<Goal[]>(configured ? [] : mockGoals);
  const [debts] = useState<Debt[]>(configured ? [] : mockDebts);
  const [subscriptions, setSubscriptions] =
    useState<Subscription[]>(configured ? [] : mockSubscriptions);
  const [cardStatements, setCardStatements] = useState<CardStatement[]>([]);
  const [quickInsights, setQuickInsights] = useState<QuickInsight[]>([]);
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary | null>(
    configured ? null : mockDashboardSummary,
  );
  // Profile starts as null; defaults are derived via `effectiveProfile`.
  // We don't bake a "Marina" mock into the state because the spec wants
  // the home/avatar to reflect the persisted profile (real data, not
  // baked fixture).
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sync, setSync] = useState<Record<DomainKey, DomainSync>>(() =>
    initialSync(configured ? "live" : "mock"),
  );
  const setSyncFor = useCallback((domain: DomainKey, s: DomainSync) => {
    setSync((prev) => ({ ...prev, [domain]: s }));
  }, []);
  const readOnly = useMemo(
    () => ESSENTIAL_DOMAINS.some((d) => STALE_SOURCES.includes(sync[d].source)),
    [sync],
  );
  const readOnlyRef = useRef(readOnly);
  const { expireSession } = useSession();
  // Central 401 handling: any apiFetch 401 — including calls that never pass
  // through AppState handlers (direct endpoint calls in feature pages) —
  // expires the session in addition to closing sockets.
  const expireSessionRef = useRef(expireSession);
  useEffect(() => {
    expireSessionRef.current = expireSession;
  }, [expireSession]);
  useEffect(() => {
    // Event name mirrors UNAUTHORIZED_EVENT from "@/lib/api/client" (not
    // imported so module-level client mocks in other tests stay valid).
    const handler = () => expireSessionRef.current();
    window.addEventListener("pi-finance:unauthorized", handler);
    return () => window.removeEventListener("pi-finance:unauthorized", handler);
  }, []);
  useEffect(() => {
    // D10 revocation: any apiFetch 403 workspace_forbidden (membership
    // revoked server-side) expires the session — unauthenticated transition
    // (→ login), never offline mode. Mirrors FORBIDDEN_EVENT the same way.
    const handler = () => expireSessionRef.current();
    window.addEventListener("pi-finance:forbidden", handler);
    return () => window.removeEventListener("pi-finance:forbidden", handler);
  }, []);
  const [loading, setLoading] = useState(
    // FIX-168: with no active workspace the bootstrap effect below parks
    // immediately (no financial I/O) — start unblocked instead of flashing
    // a loader that no fetch will ever resolve.
    () => apiUsable() && getActiveWorkspaceId() !== undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [failedWrite, setFailedWrite] = useState<FailedWriteIntent | null>(null);
  const failedWriteRef = useRef<FailedWriteIntent | null>(null);
  const clearWriteError = useCallback(() => {
    setWriteError(null);
    // Sync the pending-intent ref in the same tick the banner is cleared so
    // an immediate retry/read never observes a stale intent (state→ref race).
    failedWriteRef.current = null;
    setFailedWrite(null);
  }, []);

  const handleWriteError = useCallback(
    (e: unknown, makeRetry?: WriteRetryFactory) => {
      if (e instanceof ApiError && e.status === 401) {
        // Session expiration is handled centrally via onUnauthorized (apiFetch);
        // expire defensively here too, because 401 ApiErrors can also arrive
        // from layers that never touched apiFetch.
        expireSessionRef.current();
        failedWriteRef.current = null;
        setFailedWrite(null);
        return;
      }
      if (e instanceof Error) setWriteError(e.message);
      // Finding 2 + FIX-DEFINITIVE-WRITE-RETRY-AFFORDANCE: the intent's
      // command id travels on the surfaced error, but a manual retry is
      // armed ONLY for unknown-outcome failures (network drop, timeout,
      // 5xx — `isRetryableMutationError`). Definitive 4xx rejections
      // (including the 409 idempotency replay/conflict signal) must never
      // offer a same-id retry: blind-replaying them could re-execute
      // instead of replaying the original receipt. Anything ineligible
      // clears a stale pending retry so the banner never replays it.
      // Both state and ref are written synchronously here: the visible
      // retry callback must not depend on a later passive effect to sync
      // the ref (layout-phase clicks run before passive effects).
      const commandId = getFailedCommandId(e);
      if (commandId !== undefined && makeRetry !== undefined && isRetryableMutationError(e)) {
        const intent: FailedWriteIntent = { commandId, retry: makeRetry(commandId) };
        failedWriteRef.current = intent;
        setFailedWrite(intent);
      } else {
        failedWriteRef.current = null;
        setFailedWrite(null);
      }
    },
    [],
  );
  const handleWriteErrorRef = useRef(handleWriteError);

  /**
   * Central write authority guard (W1 item 2, Onda 1): runs BEFORE any
   * optimistic update or side-effect in every provider mutator. Online
   * writes require a server-confirmed `authenticated` session authority —
   * `unknown` (pre-probe boot, device-verified-but-cookie-refused shell,
   * mid-form authority transitions), `unauthenticated` and `unreachable`
   * never produce ghost optimistic state, never touch the network and never
   * leave a fictive failedWrite retry (there is no failed intent to replay).
   * The block surfaces an accessible error (WriteErrorBanner renders
   * writeError with role="alert"). Local/mock mode (API unconfigured) keeps
   * the legacy local optimistic behavior — there is no server authority to
   * consult. The stale-snapshot readOnly gate is preserved unchanged.
   */
  const guardWrite = useCallback((): boolean => {
    if (configured) {
      if (getSessionStatus().status !== "authenticated") {
        setWriteError("Sessão não confirmada — faça login para salvar alterações.");
        failedWriteRef.current = null;
        setFailedWrite(null);
        return true;
      }
      // FIX-168 (P0 #168): without an active workspace every financial write
      // would leave without (or with a stale) X-Workspace-Id and fail closed
      // server-side — block locally with an actionable message instead of
      // producing ghost optimistic state. Workspace management (list/create/
      // restore via useWorkspace) bypasses this provider entirely.
      if (!getActiveWorkspaceId()) {
        setWriteError("Nenhum workspace ativo — selecione ou restaure um workspace para salvar alterações.");
        failedWriteRef.current = null;
        setFailedWrite(null);
        return true;
      }
    }
    if (readOnlyRef.current) {
      setWriteError("Backend indisponível — modo somente leitura.");
      failedWriteRef.current = null;
      setFailedWrite(null);
      return true;
    }
    return false;
  }, [configured]);
  const guardWriteRef = useRef(guardWrite);

  // Stable fire-and-forget hook for mutators (SPEC §15.2, T3.3): receipt
  // wins, mutationKind fallback. Declared before the mutators so they close
  // over a stable callback; the underlying reconcile is resolved via ref at
  // CALL time (wired by the reconciler block below), so the callback never
  // goes stale and mutators keep stable identities.
  const reconcileMutationRef = useRef<
    (input: ReconcileInput) => Promise<ReconcileResult>
  >(async () => ({ targets: [], refreshed: [], failed: [], deduped: true }));
  const reconcileAfterWrite = useCallback(
    (body: unknown, kind: MutationKind) => {
      const receipt: MutationReceipt | undefined =
        extractMutationReceipt(body);
      void reconcileMutationRef.current(
        receipt !== undefined ? { receipt } : { mutationKind: kind },
      );
    },
    [],
  );

  // Refs to keep latest state accessible in callbacks without stale closures
  const payablesRef = useRef(payables);
  const accountsRef = useRef(accounts);
  const subsRef = useRef(subscriptions);
  const txsRef = useRef(transactions);
  const categoriesRef = useRef(categories);
  const budgetsRef = useRef(budgets);
  const goalsRef = useRef(goals);
  const stmtsRef = useRef(cardStatements);

  const loadedRef = useRef(false);

  // Sync refs with latest state (avoids react-hooks/refs lint)
  // NOTE: failedWriteRef is intentionally NOT synced here. It is written
  // synchronously alongside every setFailedWrite call site so the visible
  // retry callback never depends on a passive effect (layout-phase clicks
  // run before passive effects; a passive overwrite could also resurrect a
  // stale intent after an optimistic clear).
  useEffect(() => {
    readOnlyRef.current = readOnly;
    handleWriteErrorRef.current = handleWriteError;
    guardWriteRef.current = guardWrite;
    payablesRef.current = payables;
    accountsRef.current = accounts;
    subsRef.current = subscriptions;
    txsRef.current = transactions;
    categoriesRef.current = categories;
    budgetsRef.current = budgets;
    goalsRef.current = goals;
    stmtsRef.current = cardStatements;
  });

  // ── Bootstrap dispatch: maps reducer actions to provider state ───────
  // This replaces the former applyListDomain + inline fetch.
  const bootstrapDispatch = useCallback((action: AppStateAction) => {
    switch (action.type) {
      case "BOOTSTRAP_START":
        setLoading(true);
        setError(null);
        break;
      case "BOOTSTRAP_COMPLETE":
        setLoading(false);
        break;
      case "BOOTSTRAP_401":
        setLoading(false);
        break;
      case "DOMAIN_LIVE": {
        setSyncFor(action.domain, {
          source: "live",
          syncedAt: action.syncedAt,
        });
        switch (action.domain) {
          case "accounts": setAccounts(action.data as Account[]); break;
          case "categories": setCategories(action.data as Category[]); break;
          case "transactions": setTransactions(action.data as Transaction[]); break;
          case "payables": setPayables(action.data as Payable[]); break;
          case "budgets": setBudgets(action.data as Budget[]); break;
          case "goals": setGoals(action.data as Goal[]); break;
          case "cardStatements": setCardStatements(action.data as CardStatement[]); break;
        }
        break;
      }
      case "DOMAIN_SNAPSHOT":
        setSyncFor(action.domain, {
          source: "snapshot",
          syncedAt: action.syncedAt,
        });
        switch (action.domain) {
          case "accounts": setAccounts(action.data as Account[]); break;
          case "categories": setCategories(action.data as Category[]); break;
          case "transactions": setTransactions(action.data as Transaction[]); break;
          case "payables": setPayables(action.data as Payable[]); break;
          case "budgets": setBudgets(action.data as Budget[]); break;
          case "goals": setGoals(action.data as Goal[]); break;
          case "cardStatements": setCardStatements(action.data as CardStatement[]); break;
        }
        break;
      case "DOMAIN_UNAVAILABLE":
        setSyncFor(action.domain, { source: "unavailable", syncedAt: null });
        switch (action.domain) {
          case "accounts": setAccounts([]); break;
          case "categories": setCategories([]); break;
          case "transactions": setTransactions([]); break;
          case "payables": setPayables([]); break;
          case "budgets": setBudgets([]); break;
          case "goals": setGoals([]); break;
          case "cardStatements": setCardStatements([]); break;
        }
        break;
      case "SET_ERROR":
        setError(action.error);
        break;
    }
  }, [setSyncFor]);

  // Preload v2 snapshot data for all domains before bootstrap.
  const preloadSnapshot = useCallback(async (token: string): Promise<SnapshotPreload> => {
    const domains: DomainKey[] = ["accounts","categories","transactions","payables","budgets","goals","cardStatements"];
    const entries = await Promise.all(
      domains.map((d) => loadSnapshotDomain(token, d).then((v) => [d, v] as const)),
    );
    const preload: SnapshotPreload = {};
    for (const [domain, value] of entries) {
      if (value) preload[domain] = { data: value.data, syncedAt: value.syncedAt };
    }
    return preload;
  }, []);

  // Preload v3 (identity-keyed) snapshot data for the offline boot
  // (AUTH-T03): no token involved — ownership comes from the validated
  // offline identity bound after the last online authentication.
  const preloadV3Snapshot = useCallback(async (identity: V3SnapshotIdentity): Promise<SnapshotPreload> => {
    const domains: DomainKey[] = [...ALL_DOMAINS];
    const entries = await Promise.all(
      domains.map((d) =>
        loadV3SnapshotDomain(identity.principalId, identity.workspaceId, d).then((v) => [d, v] as const),
      ),
    );
    const preload: SnapshotPreload = {};
    for (const [domain, value] of entries) {
      if (value) preload[domain] = { data: value.data, syncedAt: value.syncedAt };
    }
    return preload;
  }, []);

  // ── Offline session lock (V4 T2.6, SPEC §10 D2-D3) ──────────────
  // Locked UI must not render financial data. The envelope age is
  // refreshed automatically by every live snapshot write (writeV2Snapshot);
  // the session stamp below records the login/refresh/authenticated-request
  // moments (session.ts). Unlock requires a proven online authentication.
  const [offlineLocked, setOfflineLocked] = useState(false);

  /**
   * Online revalidation: refresh the session stamp + envelope age and
   * unlock. Call only after an online authentication succeeded (login,
   * refresh, fulfilled strict fetch, manual retry). False on failure.
   */
  const revalidateOfflineSession = useCallback(async (): Promise<boolean> => {
    try {
      stampLastOnlineAuthenticatedAt();
      await refreshOfflineAuthAge().catch(() => false);
      setOfflineLocked(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  /**
   * Evaluate the snapshot lock and reflect it in UI state. Attributable
   * expiries are reported via the offline.locked client event (T0.4.4),
   * queued durably for the next authenticated flush. Never throws.
   */
  const reportOfflineLock = useCallback(async (): Promise<void> => {
    try {
      const lock = await getOfflineSnapshotLockState();
      if (lock.state === "locked") {
        setOfflineLocked(true);
        if (lock.reason === "expired" && lock.offlineSubjectId && lock.ageBand) {
          try {
            recordClientEvent("offline.locked", {
              offlineSubjectId: lock.offlineSubjectId,
              ageBand: lock.ageBand,
            });
          } catch {
            /* telemetry never blocks boot */
          }
        }
      } else if (lock.state === "ok") {
        setOfflineLocked(false);
      }
      // "untrusted"/"empty": leave the flag untouched — no data to gate.
    } catch {
      /* lock evaluation never blocks boot */
    }
  }, []);

  // ── Write boundary: commands factory (offline-safe) ───────────────
  // Every UI write goes through `commands.x(...)`; when `online` is false
  // the command throws `OfflineWriteError` with zero network/optimistic
  // side-effects. Stored in a ref so write callbacks (which keep `[]`
  // deps to stay referentially stable) always read the latest commands
  // at call time.
  const { trackWrite } = useUnsavedChangesSafe();
  const commandsRef = useRef<Commands | null>(null);
  /**
   * Latest bound write mutators (see `RetryableWrites`). Read by stored
   * manual-retry thunks at click time so the retry always re-invokes the
   * current implementation with the failed intent's SAME command id.
   * Assigned in an effect below, after every mutator is defined.
   */
  const writeApiRef = useRef<RetryableWrites | null>(null);
  useEffect(() => {
    commandsRef.current = createCommands({
      online: apiUsable(),
      token: effectiveOnlineToken(),
      dispatch: bootstrapDispatch,
      api: endpoints,
      trackWrite,
    });
  }, [bootstrapDispatch, trackWrite]);

  // ── Fetch from API when configured + session exists (session-first) ──
  useEffect(() => {
    if (!apiUsable() || loadedRef.current) return;
    // FIX-168 (P0 #168): no active workspace → no financial I/O. Every
    // financial endpoint requires X-Workspace-Id, so bootstrapping now would
    // only collect 403 workspace_required rejections. Workspace management
    // stays reachable through useWorkspace (independent provider). The mount
    // is parked (loaded, not loading): any active-workspace change remounts
    // this provider (WorkspaceProvider keys children by activeWorkspaceId),
    // so a fresh instance bootstraps when a workspace becomes available.
    if (!getActiveWorkspaceId()) {
      loadedRef.current = true;
      return;
    }
    loadedRef.current = true;

    let cancelled = false;

    const load = async () => {
      // Session-first: online auth rides the cookie (+ compat bearer) in
      // apiFetch — no storage token required. Phase 3 (AUTH-02): the V3
      // identity comes from the validated session authority (principal) +
      // the persisted workspace binding — never from a token — so
      // cookie-only boots persist identity-keyed offline snapshots.
      const token = effectiveOnlineToken();
      const authority = getSessionStatus();
      const boundWorkspace = getOfflineWorkspaceId();
      const v3Identity: V3SnapshotIdentity | undefined =
        authority.status === "authenticated" && authority.user && boundWorkspace
          ? { principalId: authority.user.userId, workspaceId: boundWorkspace }
          : undefined;

      try {
        // 1. Migrate v1 → v2 (reads v1 localStorage, writes v2 IndexedDB, deletes v1)
        if (token) {
          await migrateV1toV2(token).catch(() => {});
        }

        // 2. Preload existing v2 snapshot for offline fallback
        const snapshotPreload = token ? await preloadSnapshot(token).catch(() => ({})) : {};

        // 2b. T2.6: reflect a locked snapshot in UI state before bootstrapping
        // (offline boot with an expired/unverifiable snapshot shows the lock,
        // never the data; attributable expiries queue offline.locked).
        await reportOfflineLock().catch(() => {});

        // FIX-168-R3 (P2): revalidação pré-bootstrap — o gate inicial do
        // efeito precede os awaits acima (migrate/preload/lock); arquivar
        // durante o preload dispararia runBootstrap sem workspace ativo.
        // Estaciona como o descarte tardio (domínios indisponíveis + boot
        // completo) em vez de emitir requests órfãos.
        if (cancelled) return;
        if (!hasActiveWorkspace()) {
          for (const domain of ALL_DOMAINS) {
            bootstrapDispatch({ type: "DOMAIN_UNAVAILABLE", domain });
          }
          bootstrapDispatch({ type: "BOOTSTRAP_COMPLETE" });
          return;
        }

        // 3. Run bootstrap with preloaded snapshot data. Profile and quick
        // insights are fetched by the bootstrap and returned in `boot` —
        // the provider must NOT re-fetch them (boot dedupe).
        // expireSession is read via ref: its identity can churn when no
        // SessionProvider is present, and a dep change here would cancel the
        // in-flight bootstrap continuation.
        // FIX-168-FIX2 (HIGH — descarte tardio por identidade): vincula o
        // boot à identidade capturada aqui. Troca A→B antes da resolução
        // passa no gate de ausência (há workspace ativo) mas o payload é
        // de A — toda publicação abaixo exige identidade inalterada.
        const bootWorkspaceId = getActiveWorkspaceId();
        const boot = await runBootstrap(
          token,
          bootstrapDispatch,
          () => expireSessionRef.current(),
          snapshotPreload,
          v3Identity,
        );

        if (cancelled) return;

        // FIX-168 (P0 #168): tardy-bootstrap verification — the active
        // workspace vanished OR CHANGED while the bootstrap was in flight
        // (archived, cleared, or A→B selection without a remount racing
        // us). The live payload belongs to no selected workspace (or to a
        // workspace that is no longer current): discard it and park every
        // domain as unavailable (read-only derives from that) instead of
        // rendering data the session can no longer address. A later remount
        // with an active workspace re-bootstraps from a fresh instance.
        if (getActiveWorkspaceId() !== bootWorkspaceId) {
          for (const domain of ALL_DOMAINS) {
            bootstrapDispatch({ type: "DOMAIN_UNAVAILABLE", domain });
          }
          bootstrapDispatch({ type: "BOOTSTRAP_COMPLETE" });
          return;
        }

        // T2.6: a fulfilled profile fetch proves online + authenticated —
        // stamp the session record and unlock (live domain writes already
        // refreshed the envelope age). Otherwise re-evaluate the lock.
        if (boot.profile) {
          try {
            stampLastOnlineAuthenticatedAt();
          } catch {
            /* noop */
          }
          // Phase 3 (AUTH-03): fold the legacy V2 slot into V3 now that the
          // session is proven online with a known owner. Migration backfills
          // only domains V3 lacks and invalidates untrustworthy V2 sources;
          // failures never block the boot (V3 keeps the live-written data).
          if (token !== undefined && v3Identity !== undefined) {
            await migrateV2toV3Snapshot({ token, ...v3Identity }).catch(() => {});
          }
          if (!cancelled) setOfflineLocked(false);
        } else {
          await reportOfflineLock().catch(() => {});
        }
        if (cancelled) return;

        // Profile and insights come from the bootstrap's own fetches. A null
        // bootstrap profile must not wipe a profile saved earlier in this
        // session — apply the server profile only when one was returned.
        const bootProfile = boot.profile;
        // FIX-168-R3 (descarte tardio): despachos internos do boot nunca
        // publicam sem workspace (archive entre o tardy check e aqui).
        // FIX-168-FIX2: identidade, não só ausência — troca A→B publica
        // zero (resposta de A nunca aparece com B ativo).
        const bootIdentityIntact =
          !cancelled && getActiveWorkspaceId() === bootWorkspaceId;
        if (bootIdentityIntact && bootProfile)
          setProfile((prev) => mergeProfileFlags(prev, bootProfile));
        if (bootIdentityIntact) setQuickInsights(boot.quickInsights);
        // FIX-168-R4 (P2 SECREVIEW-168-R3): gate pré-fetch — o workspace
        // pode ter sumido nos awaits acima (migrate/lock); sem workspace o
        // resumo seria um request órfão (403 workspace_required). Zero I/O.
        if (bootIdentityIntact) {
          try {
            const summary = await endpoints.fetchDashboardSummary();
            // FIX-168-R2 (descarte tardio): workspace sumiu ou TROCOU entre
            // o tardy check e o fetch do resumo — nunca publica resumo órfão.
            if (!cancelled && getActiveWorkspaceId() === bootWorkspaceId) setDashboardSummary(summary);
          } catch {
            if (!cancelled && getActiveWorkspaceId() === bootWorkspaceId) setDashboardSummary(null);
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : "Erro ao carregar dados.");
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapDispatch]);

  // ── Offline V3 boot (Phase 3, AUTH-T03/AUTH-04) ─────────────────────
  // Runs ONLY when the online gate stays closed AND the session probe said
  // "unreachable" (never on 401/403 — those purge + login via expireSession,
  // and this effect returns early for any non-unreachable authority). A
  // valid, within-TTL V3 envelope for the bound identity hydrates the
  // domains as snapshot sources (read-only derives from that: INV-06, no
  // write queue exists). Anything else leaves the provider empty — never a
  // false logout, never another owner's data.
  useEffect(() => {
    if (apiUsable() || loadedRef.current) return;
    if (getSessionStatus().status !== "unreachable") return;
    const principalId = getOfflinePrincipalId();
    const workspaceId = getOfflineWorkspaceId();
    if (!principalId || !workspaceId) return;
    loadedRef.current = true;

    let cancelled = false;

    const loadOffline = async () => {
      bootstrapDispatch({ type: "BOOTSTRAP_START" });
      try {
        const preload = await preloadV3Snapshot({ principalId, workspaceId }).catch((): SnapshotPreload => ({}));
        if (cancelled) return;
        const served = ALL_DOMAINS.filter((d) => preload[d] !== undefined);
        if (served.length === 0) {
          // Valid route but no domains (or lock raced): no data to gate —
          // leave the lock flag untouched, stop loading.
          const lock = await getV3OfflineLockState(principalId, workspaceId).catch(() => null);
          if (!cancelled) {
            if (lock?.state === "locked") setOfflineLocked(true);
            setLoading(false);
          }
          return;
        }
        for (const domain of ALL_DOMAINS) {
          const value = preload[domain];
          if (cancelled) return;
          if (value) {
            bootstrapDispatch({ type: "DOMAIN_SNAPSHOT", domain, data: value.data, syncedAt: value.syncedAt });
          } else {
            bootstrapDispatch({ type: "DOMAIN_UNAVAILABLE", domain });
          }
        }
        if (!cancelled) {
          setOfflineLocked(false);
          bootstrapDispatch({ type: "BOOTSTRAP_COMPLETE" });
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    void loadOffline();
    return () => {
      cancelled = true;
    };
  }, [bootstrapDispatch, preloadV3Snapshot]);

  // ── Write actions ─────────────────────────────────────────────────

  const addTransaction = useCallback(async (tx: Transaction & { idempotencyKey?: string }) => {
    if (guardWriteRef.current()) return;
    // The intent id is transport-only: it never enters React state.
    const { idempotencyKey: intentId, ...txState } = tx;
    const idOption = intentId !== undefined ? { idempotencyKey: intentId } : {};
    setTransactions((prev) => [txState, ...prev]);

    if (!apiUsable()) return;

    try {
      if (tx.kind === "expense") {
        const created = await commandsRef.current!.createExpenseTransaction({
          description: tx.description,
          amountCents: tx.amountCents,
          date: tx.date,
          categoryId: tx.categoryId,
          accountId: tx.accountId,
          ...(tx.notes !== undefined ? { notes: tx.notes } : {}),
          ...idOption,
        });
        setTransactions((prev) =>
          prev.map((t) => (t.id === tx.id ? { ...t, id: created.id } : t)),
        );
        reconcileAfterWrite(created, "transaction.create");
      } else if (tx.kind === "transfer") {
        throw new Error(
          "Use createTransfer mutator for transfers, not addTransaction",
        );
      } else {
        const created = await commandsRef.current!.createIncomeTransaction({
          description: tx.description,
          amountCents: tx.amountCents,
          date: tx.date,
          categoryId: tx.categoryId,
          accountId: tx.accountId,
          ...(tx.notes !== undefined ? { notes: tx.notes } : {}),
          ...idOption,
        });
        setTransactions((prev) =>
          prev.map((t) => (t.id === tx.id ? { ...t, id: created.id } : t)),
        );
        reconcileAfterWrite(created, "transaction.create");
      }
    } catch (e) {
      setTransactions((prev) => prev.filter((t) => t.id !== tx.id));
      handleWriteErrorRef.current(e, (commandId) =>
        // Manual retry reuses the SAME intent id (Finding 2): the server
        // replays the original receipt instead of a second effect.
        () => writeApiRef.current!.addTransaction({ ...tx, idempotencyKey: commandId }),
      );
      throw e;
    }
  }, [reconcileAfterWrite]);

  const updateTransaction = useCallback(
    async (
      id: string,
      input: {
        description?: string;
        date?: string;
        amountCents?: number;
        accountId?: string;
        categoryId?: string;
        notes?: string;
        idempotencyKey?: string;
      },
    ) => {
      if (guardWriteRef.current()) return;
      const prev = txsRef.current.find((t) => t.id === id);
      if (!prev) return;

      // Optimistic update — only mutate specified fields
      setTransactions((curr) =>
        curr.map((t) =>
          t.id === id
            ? {
                ...t,
                ...(input.description !== undefined
                  ? { description: input.description }
                  : {}),
                ...(input.date !== undefined ? { date: input.date } : {}),
                ...(input.amountCents !== undefined
                  ? { amountCents: input.amountCents }
                  : {}),
                ...(input.accountId !== undefined
                  ? { accountId: input.accountId }
                  : {}),
                ...(input.categoryId !== undefined
                  ? { categoryId: input.categoryId }
                  : {}),
                ...(input.notes !== undefined ? { notes: input.notes } : {}),
              }
            : t,
        ),
      );

      if (!apiUsable()) return;

      try {
        const updated = await commandsRef.current!.updateTransaction(id, input);
        reconcileAfterWrite(updated, "transaction.update");
      } catch (e) {
        // Rollback to previous state
        setTransactions((curr) =>
          curr.map((t) => (t.id === id ? prev : t)),
        );
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.updateTransaction(id, { ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const deleteTransaction = useCallback(async (id: string, options?: CommandIdOptions) => {
    if (guardWriteRef.current()) return;
    const prev = txsRef.current.find((t) => t.id === id);
    setTransactions((prev) => prev.filter((t) => t.id !== id));

    if (!apiUsable() || !prev) return;

    try {
      const deleted = await commandsRef.current!.deleteTransaction(id, options);
      // FIX-P1-PWA-RECEIPT-CONSUMERS: DELETE /transactions/:id answers 200
      // with the soft-deleted entity + a transaction.delete receipt — the
      // receipt (mutationId dedup) wins via reconcileAfterWrite, the
      // registry kind applies only when the body carries no receipt.
      reconcileAfterWrite(deleted, "transaction.delete");
    } catch (e) {
      if (prev) setTransactions((curr) => [prev, ...curr]);
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.deleteTransaction(id, { idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  const markPayablePaid = useCallback(async (
    id: string,
    options?: CommandIdOptions & { paidDate?: string },
  ) => {
    if (guardWriteRef.current()) return;
    const prev = payablesRef.current.find((p) => p.id === id);
    const today = options?.paidDate ?? new Date().toISOString().slice(0, 10);

    setPayables((curr) =>
      curr.map((p) =>
        p.id === id ? { ...p, status: "paid" as const, paidDate: today } : p,
      ),
    );

    if (!apiUsable() || !prev) return;

    try {
      const paid = await commandsRef.current!.markPayablePaid(
        id,
        today,
        options !== undefined ? { idempotencyKey: options.idempotencyKey } : undefined,
      );
      reconcileAfterWrite(paid, "payable.pay");
    } catch (e) {
      setPayables((curr) =>
        curr.map((p) => (p.id === id ? prev : p)),
      );
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.markPayablePaid(id, { idempotencyKey: commandId, paidDate: today }),
      );
    }
  }, [reconcileAfterWrite]);

  // ── Account update / deactivate ────────────────────────────

  const updateAccount = useCallback(
    async (id: string, input: { name: string; idempotencyKey?: string }) => {
      if (guardWriteRef.current()) return;
      const prev = accountsRef.current.find((a) => a.id === id);
      if (!prev) return;

      // Optimistic update
      setAccounts((curr) =>
        curr.map((a) => (a.id === id ? { ...a, name: input.name } : a)),
      );

      if (!apiUsable()) return;

      try {
        const updatedAccount = await commandsRef.current!.updateAccount(id, input);
        reconcileAfterWrite(updatedAccount, "account.update");
      } catch (e) {
        setAccounts((curr) =>
          curr.map((a) => (a.id === id ? prev : a)),
        );
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.updateAccount(id, { ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const deactivateAccount = useCallback(async (id: string, options?: CommandIdOptions) => {
    if (guardWriteRef.current()) return;
    const prev = accountsRef.current.find((a) => a.id === id);
    if (!prev) return;

    // Optimistic: remove from list
    setAccounts((curr) => curr.filter((a) => a.id !== id));

    if (!apiUsable()) return;

    try {
      await commandsRef.current!.deactivateAccount(id, options);
      // Void-typed endpoint discards the server receipt: registry fallback.
      reconcileAfterWrite(undefined, "account.delete");
    } catch (e) {
      setAccounts((curr) => [prev, ...curr]);
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.deactivateAccount(id, { idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  // ── Category update / deactivate ───────────────────────────

  const updateCategory = useCallback(
    async (id: string, input: { name?: string; icon?: string | null; color?: string | null; idempotencyKey?: string }) => {
      if (guardWriteRef.current()) return;
      const prev = categoriesRef.current.find((c) => c.id === id);
      if (!prev) return;

      // Optimistic: null icon means "no change" (API treats null as keep).
      const effective: Partial<Category> = {};
      if (input.name !== undefined) effective.name = input.name;
      if (input.icon) effective.icon = input.icon;
      if (input.color !== undefined) effective.color = input.color;
      setCategories((curr) =>
        curr.map((c) => (c.id === id ? { ...c, ...effective } : c)),
      );

      if (!apiUsable()) return;

      try {
        const updatedCategory = await commandsRef.current!.updateCategory(id, input);
        reconcileAfterWrite(updatedCategory, "category.update");
      } catch (e) {
        setCategories((curr) =>
          curr.map((c) => (c.id === id ? prev : c)),
        );
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.updateCategory(id, { ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const deactivateCategory = useCallback(async (id: string, options?: CommandIdOptions) => {
    if (guardWriteRef.current()) return;
    const prev = categoriesRef.current.find((c) => c.id === id);
    if (!prev) return;

    setCategories((curr) => curr.filter((c) => c.id !== id));

    if (!apiUsable()) return;

    try {
      await commandsRef.current!.deactivateCategory(id, options);
      // Void-typed endpoint discards the server receipt: registry fallback.
      reconcileAfterWrite(undefined, "category.delete");
    } catch (e) {
      setCategories((curr) => [prev, ...curr]);
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.deactivateCategory(id, { idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  const deleteCategory = useCallback(
    async (
      id: string,
      input: ({ mode: "move"; destinationCategoryId: string } | { mode: "cascade"; confirm: true }) & { idempotencyKey?: string },
    ) => {
      if (guardWriteRef.current()) return { movedTransactions: 0, softDeletedTransactions: 0 };
      const prev = [...categoriesRef.current];
      const doomed = new Set<string>([id]);
      for (const c of prev) {
        if (c.parentId === id) doomed.add(c.id);
      }
      // Optimistic: drop the macro and its subs; rollback restores on failure.
      setCategories((curr) => curr.filter((c) => !doomed.has(c.id)));

      if (!apiUsable()) {
        return { movedTransactions: 0, softDeletedTransactions: 0 };
      }

      try {
        const result = await commandsRef.current!.deleteCategory(id, input);
        // Refresh from the server source of truth after a structural delete.
        const [freshCategories, freshTransactions] = await Promise.all([
          endpoints.fetchCategories(),
          endpoints.fetchTransactions({ limit: 200 }),
        ]);
        setCategories(freshCategories);
        setTransactions(freshTransactions.items);
        reconcileAfterWrite(result, "category.delete");
        return {
          movedTransactions: result.movedTransactions,
          softDeletedTransactions: result.softDeletedTransactions,
        };
      } catch (e) {
        setCategories(prev);
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.deleteCategory(id, { ...input, idempotencyKey: commandId }),
        );
        throw e;
      }
    },
    [reconcileAfterWrite],
  );

  const applyCategoryDefaults = useCallback(async (options?: CommandIdOptions) => {
    if (guardWriteRef.current()) return { created: 0, skipped: 0 };
    if (!apiUsable()) return { created: 0, skipped: 0 };
    try {
      const result = await commandsRef.current!.applyCategoryDefaults(options);
      setCategories(await endpoints.fetchCategories());
      // No receipt for this batch op: refresh the category registry targets.
      reconcileAfterWrite(undefined, "category.create");
      return { created: result.created, skipped: result.skipped };
    } catch (e) {
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.applyCategoryDefaults({ idempotencyKey: commandId }),
      );
      throw e;
    }
  }, [reconcileAfterWrite]);

  const addAccount = useCallback(
    async (input: {
      name: string;
      kind: "bank" | "cash" | "credit_card";
      initialBalanceCents: number;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const optimisticId = `opt-${crypto.randomUUID()}`;
      const optimistic: Account = {
        id: optimisticId,
        name: input.name,
        balanceCents: input.initialBalanceCents,
        kind: input.kind === "credit_card" ? "credit_card" : "checking",
        status: "active",
      };
      setAccounts((prev) => [optimistic, ...prev]);

      if (!apiUsable()) return;

      try {
        const created = await commandsRef.current!.addAccount(input);
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === optimisticId
              ? { ...created, color: a.color }
              : a,
          ),
        );
        reconcileAfterWrite(created, "account.create");
      } catch (e) {
        setAccounts((prev) => prev.filter((a) => a.id !== optimisticId));
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.addAccount({ ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const addCategory = useCallback(
    async (input: {
      name: string;
      kind: "expense" | "income";
      parentId?: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const optimisticId = `opt-${crypto.randomUUID()}`;
      const optimistic: Category = {
        id: optimisticId,
        name: input.name,
        kind: input.kind,
        icon: input.parentId ? "FolderOpen" : "Tag",
        parentId: input.parentId,
      };
      setCategories((prev) => [optimistic, ...prev]);

      if (!apiUsable()) return;

      try {
        const created = await commandsRef.current!.addCategory(input);
        setCategories((prev) =>
          prev.map((c) =>
            c.id === optimisticId ? { ...created, icon: c.icon } : c,
          ),
        );
        reconcileAfterWrite(created, "category.create");
      } catch (e) {
        setCategories((prev) => prev.filter((c) => c.id !== optimisticId));
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.addCategory({ ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const addCard = useCallback(
    async (input: {
      name: string;
      creditLimitCents: number;
      closingDay: number;
      dueDay: number;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const optimisticId = `opt-${crypto.randomUUID()}`;
      const optimistic: Account = {
        id: optimisticId,
        name: input.name,
        balanceCents: 0,
        kind: "credit_card",
        creditLimitCents: input.creditLimitCents,
        closingDay: input.closingDay,
        dueDay: input.dueDay,
        status: "active",
      };
      setAccounts((prev) => [optimistic, ...prev]);

      if (!apiUsable()) return;

      try {
        const created = await commandsRef.current!.createCard(input);
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === optimisticId
              ? { ...created, color: a.color }
              : a,
          ),
        );
        // FIX-P1: POST /cards attaches an account.create receipt, forwarded
        // by reconcileAfterWrite when present (kind fallback otherwise).
        reconcileAfterWrite(created, "account.create");
      } catch (e) {
        setAccounts((prev) => prev.filter((a) => a.id !== optimisticId));
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.addCard({ ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const updateCard = useCallback(
    async (
      id: string,
      input: {
        name?: string;
        creditLimitCents?: number;
        closingDay?: number;
        dueDay?: number;
        idempotencyKey?: string;
      },
    ) => {
      if (guardWriteRef.current()) return;
      const prev = accountsRef.current.find((a) => a.id === id);
      setAccounts((curr) =>
        curr.map((c) =>
          c.id === id
            ? {
                ...c,
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.creditLimitCents !== undefined
                  ? { creditLimitCents: input.creditLimitCents }
                  : {}),
                ...(input.closingDay !== undefined
                  ? { closingDay: input.closingDay }
                  : {}),
                ...(input.dueDay !== undefined
                  ? { dueDay: input.dueDay }
                  : {}),
              }
            : c,
        ),
      );

      if (!apiUsable() || !prev) return;

      try {
        const updated = await commandsRef.current!.updateCard(id, input);
        setAccounts((curr) =>
          curr.map((a) => (a.id === id ? { ...a, ...updated, color: a.color } : a)),
        );
        // FIX-P1: PATCH /cards/:id attaches an account.update receipt,
        // forwarded when present (kind fallback otherwise).
        reconcileAfterWrite(updated, "account.update");
      } catch (e) {
        setAccounts((curr) =>
          curr.map((a) => (a.id === id ? prev : a)),
        );
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.updateCard(id, { ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const addSubscription = useCallback(
    async (input: {
      name: string;
      amountCents: number;
      cycle: "monthly" | "yearly" | "weekly";
      day: number;
      paymentMethod: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const optimisticId = `opt-${crypto.randomUUID()}`;
      const optimistic: Subscription = {
        id: optimisticId,
        name: input.name,
        amountCents: input.amountCents,
        cycle: input.cycle,
        day: input.day,
        paymentMethod: input.paymentMethod,
        status: "active",
        createdAt: new Date().toISOString(),
      };
      setSubscriptions((prev) => [optimistic, ...prev]);

      if (!apiUsable()) return;

      try {
        const created = await commandsRef.current!.addSubscription(input);
        setSubscriptions((prev) =>
          prev.map((s) => (s.id === optimisticId ? created : s)),
        );
        reconcileAfterWrite(created, "subscription.create");
      } catch (e) {
        setSubscriptions((prev) => prev.filter((s) => s.id !== optimisticId));
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.addSubscription({ ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const cancelSubscription = useCallback(async (id: string, options?: CommandIdOptions) => {
    if (guardWriteRef.current()) return;
    const prev = subsRef.current.find((s) => s.id === id);
    setSubscriptions((curr) =>
      curr.map((s) =>
        s.id === id ? { ...s, status: "cancelled" as const } : s,
      ),
    );

    if (!apiUsable() || !prev) return;

    try {
      const cancelledSub = await commandsRef.current!.cancelSubscription(id, options);
      reconcileAfterWrite(cancelledSub, "subscription.delete");
    } catch (e) {
      setSubscriptions((curr) =>
        curr.map((s) => (s.id === id ? prev : s)),
      );
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.cancelSubscription(id, { idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  const updateSubscription = useCallback(async (
    id: string,
    input: {
      name?: string;
      amountCents?: number;
      cycle?: "monthly" | "yearly" | "weekly";
      day?: number;
      paymentMethod?: string;
      idempotencyKey?: string;
    },
  ) => {
    if (guardWriteRef.current()) return;
    const prev = subsRef.current.find((s) => s.id === id);
    if (!prev) return;
    // Optimistic update — the intent id is transport-only, never state.
    const optimisticInput = { ...input };
    delete optimisticInput.idempotencyKey;
    setSubscriptions((curr) =>
      curr.map((s) => s.id === id ? { ...s, ...optimisticInput } : s),
    );

    if (!apiUsable()) return;

    try {
      const updatedSub = await commandsRef.current!.updateSubscription(id, input);
      reconcileAfterWrite(updatedSub, "subscription.update");
    } catch (e) {
      // Rollback
      setSubscriptions((curr) =>
        curr.map((s) => (s.id === id ? prev : s)),
      );
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.updateSubscription(id, { ...input, idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  // ── Lazy load subscriptions (not fetched during bootstrap) ────

  const refreshSubscriptions = useCallback(async () => {
    // Session-first: subscriptions lazy-load whenever the session authority
    // allows online use — no storage token required (cookie-only boots too).
    // Snapshot persistence inside the adapter is best-effort and skipped
    // without a token-derived key until offline V3 (Phase 3).
    // FIX-168-R2: sem workspace ativo, zero I/O (todo endpoint financeiro
    // exige X-Workspace-Id).
    if (!canReadFinancial()) return;
    const token = effectiveOnlineToken();

    const adapter = createSubscriptionsAdapter({ token, online: apiUsable() });
    const result = await adapter.refresh();

    if (result === null) {
      // Offline — keep existing data (mock or empty)
      return;
    }

    // FIX-168-R2 (descarte tardio): o workspace sumiu com o fetch em voo
    // (archive/remount race) — descarta antes de despachar, nunca publica
    // dado de workspace que a sessão não mais endereça.
    if (!hasActiveWorkspace()) return;

    setSubscriptions(result.data);
    setSyncFor("subscriptions", {
      source: result.source,
      syncedAt: result.syncedAt,
    });
  }, [setSyncFor]);

  const createTransfer = useCallback(
    async (input: {
      description: string;
      amountCents: number;
      date: string;
      fromAccountId: string;
      toAccountId: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const optimisticId = `opt-${crypto.randomUUID()}`;
      const optimisticTx: Transaction = {
        id: optimisticId,
        description: input.description,
        amountCents: input.amountCents,
        date: input.date,
        kind: "transfer",
        categoryId: "",
        accountId: input.fromAccountId,
      };
      setTransactions((prev) => [optimisticTx, ...prev]);

      const prevFrom = accountsRef.current.find(
        (a) => a.id === input.fromAccountId,
      );
      const prevTo = accountsRef.current.find(
        (a) => a.id === input.toAccountId,
      );

      setAccounts((curr) =>
        curr.map((a) => {
          if (a.id === input.fromAccountId) {
            return {
              ...a,
              // ADR-018: bank/cash may go negative (exact delta, no zero floor).
              balanceCents: a.balanceCents - input.amountCents,
            };
          }
          if (a.id === input.toAccountId) {
            return { ...a, balanceCents: a.balanceCents + input.amountCents };
          }
          return a;
        }),
      );

      if (!apiUsable()) return;

      try {
        const created = await commandsRef.current!.createTransfer(input);
        reconcileAfterWrite(created, "transfer.create");
      } catch (e) {
        setTransactions((prev) => prev.filter((t) => t.id !== optimisticId));
        if (prevFrom) {
          setAccounts((curr) =>
            curr.map((a) => (a.id === input.fromAccountId ? prevFrom : a)),
          );
        }
        if (prevTo) {
          setAccounts((curr) =>
            curr.map((a) => (a.id === input.toAccountId ? prevTo : a)),
          );
        }
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.createTransfer({ ...input, idempotencyKey: commandId }),
        );
        throw e;
      }
    },
    [reconcileAfterWrite],
  );

  // ── Payable create / cancel ─────────────────────────────────

  const cancelPayable = useCallback(async (id: string, options?: CommandIdOptions) => {
    if (guardWriteRef.current()) return;
    const prev = payablesRef.current.find((p) => p.id === id);

    setPayables((curr) =>
      curr.map((p) =>
        p.id === id ? { ...p, status: "cancelled" as const } : p,
      ),
    );

    if (!apiUsable() || !prev) return;

    try {
      const cancelled = await commandsRef.current!.cancelPayable(id, options);
      reconcileAfterWrite(cancelled, "payable.delete");
    } catch (e) {
      setPayables((curr) =>
        curr.map((p) => (p.id === id ? { ...prev } : p)),
      );
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.cancelPayable(id, { idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  const updatePayable = useCallback(
    async (id: string, input: {
      description?: string;
      amountCents?: number;
      dueDate?: string;
      accountId?: string;
      categoryId?: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const prev = payablesRef.current.find((p) => p.id === id);
      if (!prev) return;

      // Optimistic update — the intent id is transport-only, never state.
      const optimisticInput = { ...input };
      delete optimisticInput.idempotencyKey;
      setPayables((curr) =>
        curr.map((p) =>
          p.id === id ? { ...p, ...optimisticInput } : p,
        ),
      );

      if (!apiUsable()) return;

      try {
        const updatedPayable = await commandsRef.current!.updatePayable(id, input);
        reconcileAfterWrite(updatedPayable, "payable.update");
      } catch (e) {
        setPayables((curr) =>
          curr.map((p) => (p.id === id ? { ...prev } : p)),
        );
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.updatePayable(id, { ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const undoPayablePayment = useCallback(async (id: string, options?: CommandIdOptions) => {
    if (guardWriteRef.current()) return;
    const prev = payablesRef.current.find((p) => p.id === id);
    if (!prev) return;
    // V4.1 REVIEWFIX F2: the server requires the linked paidTransactionId
    // (D4). Fail closed client-side when the list item does not carry it
    // instead of sending a request the server must reject.
    if (!prev.paidTransactionId) {
      handleWriteErrorRef.current(new Error("Pagamento sem transação vinculada."));
      return;
    }
    const paidTransactionId = prev.paidTransactionId;

    // Optimistic update: change status back to pending/overdue
    const newStatus: Payable['status'] =
      new Date().toISOString().slice(0, 10) <= prev.dueDate ? 'pending' : 'overdue';
    setPayables((curr) =>
      curr.map((p) =>
        p.id === id ? { ...p, status: newStatus, paidDate: undefined as unknown as string | undefined } : p,
      ),
    );

    if (!apiUsable()) return;

    try {
      const undone = await commandsRef.current!.undoPayablePayment(id, paidTransactionId, options);
      reconcileAfterWrite(undone, "payable.payment.undo");
    } catch (e) {
      setPayables((curr) =>
        curr.map((p) => (p.id === id ? { ...prev } : p)),
      );
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.undoPayablePayment(id, { idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  const createPayable = useCallback(
    async (input: {
      accountId: string;
      description: string;
      amountCents: number;
      dueDate: string;
      categoryId?: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const optimisticId = `opt-${crypto.randomUUID()}`;
      const optimistic: Payable = {
        id: optimisticId,
        description: input.description,
        amountCents: input.amountCents,
        dueDate: input.dueDate,
        status: "pending",
        categoryId: input.categoryId,
      };
      setPayables((prev) => [optimistic, ...prev]);

      if (!apiUsable()) return;

      try {
        const created = await commandsRef.current!.createPayable(input);
        setPayables((curr) =>
          curr.map((p) => (p.id === optimisticId ? created : p)),
        );
        reconcileAfterWrite(created, "payable.create");
      } catch (e) {
        setPayables((curr) => curr.filter((p) => p.id !== optimisticId));
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.createPayable({ ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  // ── Budget create / update ──────────────────────────────────

  const createBudget = useCallback(
    async (input: {
      categoryId: string;
      name: string;
      amountCents: number;
      period: "monthly" | "quarterly" | "yearly";
      startDate: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const optimistic: Budget = {
        id: `opt-${crypto.randomUUID()}`,
        categoryId: input.categoryId,
        name: input.name,
        amountCents: input.amountCents,
        spentCents: 0,
        period: input.period,
      };
      setBudgets((prev) => [optimistic, ...prev]);

      if (!apiUsable()) return;

      try {
        const created = await commandsRef.current!.createBudget(input);
        setBudgets((curr) =>
          curr.map((b) => (b.id === optimistic.id ? created : b)),
        );
        reconcileAfterWrite(created, "budget.create");
      } catch (e) {
        setBudgets((curr) => curr.filter((b) => b.id !== optimistic.id));
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.createBudget({ ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const updateBudget = useCallback(
    async (
      id: string,
      input: { amountCents?: number; alertThreshold?: number; idempotencyKey?: string },
    ) => {
      if (guardWriteRef.current()) return;
      const prev = budgetsRef.current.find((b) => b.id === id);
      if (!prev) return;

      setBudgets((curr) =>
        curr.map((b) =>
          b.id === id
            ? {
                ...b,
                ...(input.amountCents !== undefined
                  ? { amountCents: input.amountCents }
                  : {}),
              }
            : b,
        ),
      );

      if (!apiUsable()) return;

      try {
        const updatedBudget = await commandsRef.current!.updateBudget(id, input);
        reconcileAfterWrite(updatedBudget, "budget.update");
      } catch (e) {
        setBudgets((curr) =>
          curr.map((b) => (b.id === id ? prev : b)),
        );
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.updateBudget(id, { ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  // ── Goal create / contribute / cancel ───────────────────────

  const createGoal = useCallback(
    async (input: {
      name: string;
      goalType: "savings" | "purchase" | "debt_payoff" | "emergency_fund";
      targetAmountCents: number;
      startDate: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      const optimistic: Goal = {
        id: `opt-${crypto.randomUUID()}`,
        name: input.name,
        goalType: input.goalType,
        targetAmountCents: input.targetAmountCents,
        currentAmountCents: 0,
      };
      setGoals((prev) => [optimistic, ...prev]);

      if (!apiUsable()) return;

      try {
        const created = await commandsRef.current!.createGoal(input);
        setGoals((curr) =>
          curr.map((g) => (g.id === optimistic.id ? created : g)),
        );
        reconcileAfterWrite(created, "goal.create");
      } catch (e) {
        setGoals((curr) => curr.filter((g) => g.id !== optimistic.id));
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.createGoal({ ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const contributeToGoal = useCallback(
    async (id: string, input: { amountCents: number; idempotencyKey?: string }) => {
      if (guardWriteRef.current()) return;
      const prev = goalsRef.current.find((g) => g.id === id);
      if (!prev) return;

      setGoals((curr) =>
        curr.map((g) =>
          g.id === id
            ? {
                ...g,
                currentAmountCents:
                  g.currentAmountCents + input.amountCents,
              }
            : g,
        ),
      );

      if (!apiUsable()) return;

      try {
        const contribution = await commandsRef.current!.contributeToGoal(id, input);
        reconcileAfterWrite(contribution, "goal.update");
      } catch (e) {
        setGoals((curr) =>
          curr.map((g) => (g.id === id ? { ...prev } : g)),
        );
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.contributeToGoal(id, { ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const cancelGoal = useCallback(async (id: string, options?: CommandIdOptions) => {
    if (guardWriteRef.current()) return;
    const prev = goalsRef.current.find((g) => g.id === id);
    if (!prev) return;

    setGoals((curr) => curr.filter((g) => g.id !== id));

    if (!apiUsable()) return;

    try {
      const cancelledGoal = await commandsRef.current!.cancelGoal(id, options);
      reconcileAfterWrite(cancelledGoal, "goal.delete");
    } catch (e) {
      setGoals((curr) => [prev, ...curr]);
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.cancelGoal(id, { idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  const updateGoal = useCallback(async (
    id: string,
    input: {
      name?: string;
      targetAmountCents?: number;
      targetDate?: string;
      idempotencyKey?: string;
    },
  ) => {
    if (guardWriteRef.current()) return;
    const prev = goalsRef.current.find((g) => g.id === id);
    if (!prev) return;

    // Optimistic update — the intent id is transport-only, never state.
    const optimisticInput = { ...input };
    delete optimisticInput.idempotencyKey;
    setGoals((curr) =>
      curr.map((g) => g.id === id ? { ...g, ...optimisticInput } : g),
    );

    if (!apiUsable()) return;

    try {
      const updatedGoal = await commandsRef.current!.updateGoal(id, input);
      reconcileAfterWrite(updatedGoal, "goal.update");
    } catch (e) {
      setGoals((curr) => curr.map((g) => (g.id === id ? prev : g)));
      handleWriteErrorRef.current(e, (commandId) =>
        () => writeApiRef.current!.updateGoal(id, { ...input, idempotencyKey: commandId }),
      );
    }
  }, [reconcileAfterWrite]);

  const payStatement = useCallback(
    async (
      statementId: string,
      input: { amountCents: number; fromAccountId: string; idempotencyKey?: string },
    ) => {
      if (guardWriteRef.current()) return;
      const prevStmt = stmtsRef.current.find((s) => s.id === statementId);
      const prevAccount = accountsRef.current.find(
        (a) => a.id === input.fromAccountId,
      );

      setCardStatements((curr) =>
        curr.map((s) =>
          s.id === statementId
            ? {
                ...s,
                paidCents: s.paidCents + input.amountCents,
                status:
                  s.paidCents + input.amountCents >= s.totalCents
                    ? "paid"
                    : "partial",
              }
            : s,
        ),
      );
      setAccounts((curr) =>
        curr.map((a) =>
          a.id === input.fromAccountId
            ? {
                ...a,
                // ADR-018: bank/cash may go negative (exact delta, no zero floor).
                balanceCents: a.balanceCents - input.amountCents,
              }
            : a,
        ),
      );

      if (!apiUsable()) return;

      try {
        const updated = await commandsRef.current!.payStatement(statementId, input);
        setCardStatements((curr) =>
          curr.map((s) =>
            s.id === statementId
              ? { ...s, ...updated }
              : s,
          ),
        );
        reconcileAfterWrite(updated, "statement.update");
      } catch (e) {
        if (prevStmt) {
          setCardStatements((curr) =>
            curr.map((s) => (s.id === statementId ? prevStmt : s)),
          );
        }
        if (prevAccount) {
          setAccounts((curr) =>
            curr.map((a) =>
              a.id === input.fromAccountId ? prevAccount : a,
            ),
          );
        }
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.payStatement(statementId, { ...input, idempotencyKey: commandId }),
        );
      }
    },
    [reconcileAfterWrite],
  );

  const createInstallments = useCallback(
    async (input: {
      accountId: string;
      description: string;
      totalAmountCents: number;
      purchaseDate: string;
      installmentsTotal: number;
      categoryId?: string;
      subcategoryId?: string;
      notes?: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      if (!apiUsable()) {
        setWriteError("API não configurada para parcelamentos");
        failedWriteRef.current = null;
        setFailedWrite(null);
        return;
      }

      try {
        const createdStmts = await commandsRef.current!.createInstallments(input);
        const stmts = await endpoints.fetchStatements(input.accountId);
        setCardStatements(stmts);
        // FIX-P1: POST /cards/installments attaches a transaction.create
        // receipt, but endpoints.createInstallments resolves res.items (the
        // envelope — and its receipt — is stripped), so the registry
        // fallback applies. The explicit fetchStatements above covers the
        // statement domain; the fallback refreshes statement + accounts.
        reconcileAfterWrite(createdStmts, "statement.create");
      } catch (e) {
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.createInstallments({ ...input, idempotencyKey: commandId }),
        );
        throw e;
      }
    },
    [reconcileAfterWrite],
  );

  const createCardPurchase = useCallback(
    async (input: {
      accountId: string;
      description: string;
      amountCents: number;
      date: string;
      categoryId?: string;
      subcategoryId?: string;
      notes?: string;
      idempotencyKey?: string;
    }) => {
      if (guardWriteRef.current()) return;
      if (!apiUsable()) {
        setWriteError("API não configurada para compras no cartão");
        failedWriteRef.current = null;
        setFailedWrite(null);
        return;
      }

      try {
        const createdPurchases = await commandsRef.current!.createCardPurchase(input);
        const stmts = await endpoints.fetchStatements(input.accountId);
        setCardStatements(stmts);
        // FIX-P1: POST /cards/purchases attaches a transaction.create
        // receipt, but endpoints.createCardPurchase resolves res.items (the
        // envelope — and its receipt — is stripped), so the registry
        // fallback applies. Threading the receipt through endpoints +
        // commands is tracked follow-up (same for installments); refresh +
        // stale behavior is preserved via the fallback + explicit fetch.
        reconcileAfterWrite(createdPurchases, "statement.create");
      } catch (e) {
        handleWriteErrorRef.current(e, (commandId) =>
          () => writeApiRef.current!.createCardPurchase({ ...input, idempotencyKey: commandId }),
        );
        throw e;
      }
    },
    [reconcileAfterWrite],
  );

  // Keeps the manual-retry registry pointed at the latest bound mutators.
  // No dep array: assignment runs after every render (never read during
  // render), so a stored retry thunk always re-invokes current code.
  useEffect(() => {
    writeApiRef.current = {
      addTransaction,
      updateTransaction,
      deleteTransaction,
      markPayablePaid,
      cancelPayable,
      updatePayable,
      undoPayablePayment,
      createPayable,
      createBudget,
      updateBudget,
      createGoal,
      contributeToGoal,
      cancelGoal,
      updateGoal,
      addAccount,
      updateAccount,
      deactivateAccount,
      addCategory,
      updateCategory,
      deactivateCategory,
      deleteCategory,
      applyCategoryDefaults,
      addCard,
      updateCard,
      addSubscription,
      cancelSubscription,
      updateSubscription,
      createTransfer,
      payStatement,
      createInstallments,
      createCardPurchase,
    };
  });

  /**
   * Manual retry for the banner (Finding 2): re-invokes the failed mutation
   * with the SAME command id. The pending intent is consumed synchronously
   * (ref cleared before the attempt) so a stale/rapid second call cannot
   * replay an already-consumed intent; a swallowed failure re-stores its
   * fresh error via the mutator's own catch while a success leaves the
   * banner cleared. Never rejects — failures are already surfaced through
   * `writeError` state by the mutator.
   */
  const retryWriteError = useCallback(async (): Promise<unknown> => {
    const pending = failedWriteRef.current;
    if (!pending) return;
    // Consume before invoking: clears both state and ref in the same tick.
    failedWriteRef.current = null;
    setWriteError(null);
    setFailedWrite(null);
    return pending.retry().catch(() => {
      /* failure already surfaced via writeError state by the mutator */
    });
  }, []);

  // ── Profile adapter ────────────────────────────────────────
  // Injected persistence/API projection adapter. The adapter handles both
  // API mode (endpoints.patchProfile/fetchProfile) and local fallback mode
  // (localStorage). The provider facade (saveProfile, refreshProfile) is
  // unchanged.
  const profileAdapter = useMemo(
    () => createProfileAdapter({ apiUsable: apiUsable() }),
    [],
  );

  // ── Profile save/load ─────────────────────────────────────
  // Delegates to the injected adapter. When API is configured, the adapter
  // calls endpoints.patchProfile and returns the server projection; otherwise
  // it applies a local merge with defaults. In both cases setProfile is
  // called with the result.
  //
  // FIX-PWA-PROFILE-WRITE-AUTHORITY: the write guard runs FIRST, at call
  // time via guardWriteRef (a form mounted under `authenticated` must fail
  // closed when authority later drops to unknown/unreachable — no PATCH, no
  // local state change, accessible guard error). The adapter is also
  // resolved fresh at call time: profileAdapter is memoized at mount and
  // would otherwise keep a mount-captured apiUsable flag (stale in both
  // directions across authority transitions).
  const saveProfile = useCallback(
    async (input: {
      name?: string;
      email?: string;
      phone?: string;
      avatarColor?: string;
      greetingStyle?: Profile["greetingStyle"];
    }) => {
      if (guardWriteRef.current()) return;
      try {
        const adapter = createProfileAdapter({ apiUsable: apiUsable() });
        const result = await adapter.save(input, profile);
        if (!result) return; // keep the previous profile on empty server response
        setProfile((prev) => mergeProfileFlags(prev, result));
      } catch (e) {
        handleWriteErrorRef.current(e);
      }
    },
    [profile],
  );

  const refreshProfile = useCallback(async () => {
    // FIX-168-R3 (P2): sem sessão confirmada + workspace ativo, zero I/O
    // (silent no-op) — o GET /profile resolve por household da sessão e
    // nunca deve disparar sem workspace selecionado.
    if (!canReadFinancial()) return;
    try {
      const fresh = await profileAdapter.refresh();
      // FIX-168-R3 (descarte tardio): resposta diferida durante archive/
      // remount não publica.
      if (!hasActiveWorkspace()) return;
      if (fresh) setProfile((prev) => mergeProfileFlags(prev, fresh));
    } catch {
      // ignore — keep previous profile state
    }
  }, [profileAdapter]);

  const refreshDashboardSummaryStrict = useCallback(async () => {
    if (!apiUsable()) throw new Error("API não configurada.");
    // FIX-168-R2: sem workspace ativo, throw antes de qualquer I/O.
    if (!hasActiveWorkspace()) throw new Error(NO_ACTIVE_WORKSPACE_MESSAGE);
    const summary = await endpoints.fetchDashboardSummary();
    // FIX-168-R2 (descarte tardio): workspace sumiu em voo — nunca publica.
    if (!hasActiveWorkspace()) throw new Error(NO_ACTIVE_WORKSPACE_MESSAGE);
    setDashboardSummary(summary);
  }, []);

  const refreshDashboardSummary = useCallback(async () => {
    // FIX-168-R2: sem workspace ativo, zero I/O (leniente: silent no-op).
    if (!canReadFinancial()) return;
    try {
      const summary = await endpoints.fetchDashboardSummary();
      // FIX-168-R2 (descarte tardio): resposta diferida durante archive/
      // remount não publica.
      if (!hasActiveWorkspace()) return;
      setDashboardSummary(summary);
    } catch {
      if (!hasActiveWorkspace()) return;
      setDashboardSummary(null);
    }
  }, []);

  const refreshQuickInsightsStrict = useCallback(async () => {
    if (!apiUsable()) throw new Error("API não configurada.");
    // FIX-168-R2: sem workspace ativo, throw antes de qualquer I/O.
    if (!hasActiveWorkspace()) throw new Error(NO_ACTIVE_WORKSPACE_MESSAGE);
    const insights = await endpoints.fetchQuickInsights();
    // FIX-168-R2 (descarte tardio): workspace sumiu em voo — nunca publica.
    if (!hasActiveWorkspace()) throw new Error(NO_ACTIVE_WORKSPACE_MESSAGE);
    setQuickInsights(insights);
  }, []);

  /**
   * Strict single-domain refresh: fetches from the authoritative API and
   * dispatches DOMAIN_LIVE. THROWS on failure (unlike refreshDomains) so
   * the MutationReconciler can mark targets stale per SPEC §15.5.
   */
  const refreshDomainStrict = useCallback(
    async (domain: DomainKey) => {
      if (!apiUsable()) throw new Error("API não configurada.");
      // FIX-168-R2: sem workspace ativo, throw antes de qualquer I/O.
      if (!hasActiveWorkspace()) throw new Error(NO_ACTIVE_WORKSPACE_MESSAGE);
      if (domain === "subscriptions") {
        const subs = await endpoints.fetchSubscriptions();
        // FIX-168-R2 (descarte tardio): nunca despacha sem workspace.
        if (!hasActiveWorkspace()) throw new Error(NO_ACTIVE_WORKSPACE_MESSAGE);
        setSubscriptions(subs);
        setSyncFor("subscriptions", {
          source: "live",
          syncedAt: new Date().toISOString(),
        });
        return;
      }
      let data: unknown;
      switch (domain) {
        case "accounts": {
          const [accs, cards] = await Promise.all([
            endpoints.fetchAccounts(),
            endpoints.fetchCards(),
          ]);
          const merged = [...accs];
          for (const c of cards) {
            const idx = merged.findIndex((m) => m.id === c.id);
            if (idx >= 0) merged[idx] = c;
            else merged.push(c);
          }
          data = merged;
          break;
        }
        case "transactions":
          data = (await endpoints.fetchTransactions({ limit: 200 })).items;
          break;
        case "categories":
          data = await endpoints.fetchCategories();
          break;
        case "payables":
          data = await endpoints.fetchPayables();
          break;
        case "budgets":
          data = await endpoints.fetchBudgets();
          break;
        case "goals":
          data = await endpoints.fetchGoals();
          break;
        case "cardStatements":
          data = await endpoints.fetchStatements();
          break;
        default:
          return;
      }
      // FIX-168-R2 (descarte tardio): o workspace sumiu com os fetches em
      // voo — descarta antes de despachar, nunca publica dado órfão.
      if (!hasActiveWorkspace()) throw new Error(NO_ACTIVE_WORKSPACE_MESSAGE);
      bootstrapDispatch({
        type: "DOMAIN_LIVE",
        domain,
        data,
        syncedAt: new Date().toISOString(),
      });
      // T2.6: a fulfilled strict fetch proves online + authenticated — stamp
      // the session record and unlock (envelope age is refreshed by the
      // snapshot write path). Best-effort: never breaks the refresh.
      try {
        stampLastOnlineAuthenticatedAt();
        setOfflineLocked(false);
      } catch {
        /* noop */
      }
    },
    [bootstrapDispatch, setSyncFor],
  );

  /**
   * Re-fetches the given domains and dispatches DOMAIN_LIVE so provider state
   * is invalidated and rebuilt from the authoritative API. Domains outside the
   * supported set are ignored. A failed refresh keeps the current data and
   * returns false so callers that need a hard recovery can react explicitly.
   */
  const refreshDomains = useCallback(
    async (domains: DomainKey[]) => {
      // FIX-168-R2: sem workspace ativo, zero I/O (false = nada atualizado).
      if (!canReadFinancial()) return false;
      const results = await Promise.all(
        domains.map(async (domain) => {
          try {
            await refreshDomainStrict(domain);
            return true;
          } catch {
            // Refresh failure keeps the current domain data.
            return false;
          }
        }),
      );
      return results.every(Boolean);
    },
    [refreshDomainStrict],
  );

  // ── MutationReconciler wiring (SPEC §15.2, T3.3) ────────────────
  // Single reconciliation layer: receipt (either origin) or mutationKind
  // fallback in, registry-derived target refreshes out. Failures mark the
  // affected targets stale — the persisted mutation is NEVER rolled back.
  const [staleTargets, setStaleTargets] = useState<RefreshTarget[]>([]);
  const staleTargetsRef = useRef<RefreshTarget[]>([]);
  useEffect(() => {
    staleTargetsRef.current = staleTargets;
  }, [staleTargets]);

  const refreshOneTarget = useCallback(
    async (target: RefreshTarget) => {
      switch (target) {
        case "transactions":
        case "accounts":
        case "categories":
        case "payables":
        case "budgets":
        case "goals":
          await refreshDomainStrict(target);
          return;
        case "statement":
          await refreshDomainStrict("cardStatements");
          return;
        case "subscription":
          await refreshDomainStrict("subscriptions");
          return;
        case "dashboard-summary":
          await refreshDashboardSummaryStrict();
          return;
        case "quick-insights":
          await refreshQuickInsightsStrict();
          return;
        case "agent-conversation":
          // Owned by TedChat's history reload (§15.4) — no financial fetch.
          return;
      }
    },
    [
      refreshDomainStrict,
      refreshDashboardSummaryStrict,
      refreshQuickInsightsStrict,
    ],
  );
  // Refresh callback is swapped via reconciler.setRefresh below — no ref
  // indirection at creation time (react-hooks/refs).

  // Single reconciliation instance (SPEC §15.2, T3.3): created once via
  // useState so the seen mutationId set survives re-renders. The refresh
  // callback is swapped in a controlled effect (never read during render).
  const [reconciler] = useState(() =>
    createMutationReconciler({
      refresh: (target) => refreshOneTarget(target),
    }),
  );
  useEffect(() => {
    reconciler.setRefresh(refreshOneTarget);
  }, [reconciler, refreshOneTarget]);

  const reconcileMutation = useCallback(
    async (input: ReconcileInput): Promise<ReconcileResult> => {
      // FIX-168-R2: sem workspace ativo, zero I/O e sem publicação de stale
      // (deduped no-op — o reconciler nunca é acionado).
      if (!canReadFinancial()) {
        return { targets: [], refreshed: [], failed: [], deduped: true };
      }
      const outcome = await reconciler.reconcile(input);
      // FIX-168-R2 (descarte tardio): workspace sumiu em voo — descarta a
      // publicação de stale antes de despachar.
      if (!hasActiveWorkspace()) return outcome;
      if (!outcome.deduped) {
        setStaleTargets((prev) => {
          const stillStale = prev.filter(
            (t) => !outcome.refreshed.includes(t),
          );
          const newlyFailed = outcome.failed.filter(
            (t) => !stillStale.includes(t),
          );
          return [...stillStale, ...newlyFailed];
        });
      }
      return outcome;
    },
    [reconciler],
  );
  // Wires the stable mutator hook above to the current reconcileMutation.
  // Effect-only assignment: no ref is read during render.
  useEffect(() => {
    reconcileMutationRef.current = reconcileMutation;
  }, [reconcileMutation]);

  const retryReconciliation = useCallback(async () => {
    const targets = staleTargetsRef.current;
    if (targets.length === 0) return;
    // FIX-168-R2: retry manual sem workspace ativo emite zero I/O e mantém
    // o stale intacto para quando um workspace voltar.
    if (!canReadFinancial()) return;
    const outcome = await reconciler.reconcileTargets(targets);
    // FIX-168-R2 (descarte tardio): workspace sumiu em voo — sem publicação.
    if (!hasActiveWorkspace()) return;
    setStaleTargets(outcome.failed);
  }, [reconciler]);

  const dismissReconciliationStale = useCallback(() => {
    setStaleTargets([]);
  }, []);

  const reconciliationStale = useMemo(
    () =>
      staleTargets.length === 0
        ? null
        : { message: RECONCILIATION_STALE_MESSAGE, targets: staleTargets },
    [staleTargets],
  );

  // ── Local-mode persistence for profile (mock/local-storage) ─
  // When the API is configured, saveProfile already persists server-side;
  // in mock mode we hydrate from localStorage on mount and write back
  // after every saveProfile call.
  useEffect(() => {
    if (apiUsable()) return;
    const local = profileAdapter.hydrate();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (local) setProfile(local);
  }, [profileAdapter]);

  useEffect(() => {
    if (apiUsable()) return;
    if (!profile) return;
    profileAdapter.persist(profile);
  }, [profile, profileAdapter]);


  // Memoized context value: consumers only re-render when the underlying
  // data/callbacks actually change, not on unrelated provider re-renders.
  const value = useMemo(
    () => ({
      accounts,
      categories,
      transactions,
      payables,
      budgets,
      goals,
      debts,
      subscriptions,
      cardStatements,
      profile,
      quickInsights,
      dashboardSummary,
      saveProfile,
      refreshProfile,
      refreshDashboardSummary,
      refreshDashboardSummaryStrict,
      sync,
      readOnly,
      offlineLocked,
      revalidateOfflineSession,
      loading,
      error,
      writeError,
      clearWriteError,
      writeErrorCommandId: failedWrite?.commandId ?? null,
      retryWriteError: failedWrite ? retryWriteError : null,
      addTransaction,
      updateTransaction,
      deleteTransaction,
      markPayablePaid,
      cancelPayable,
      updatePayable,
      undoPayablePayment,
      createPayable,
      createBudget,
      updateBudget,
      createGoal,
      contributeToGoal,
      cancelGoal,
      updateGoal,
      addAccount,
      updateAccount,
      deactivateAccount,
      addCategory,
      updateCategory,
      deactivateCategory,
      deleteCategory,
      applyCategoryDefaults,
      addCard,
      updateCard,
      addSubscription,
      cancelSubscription,
      updateSubscription,
      refreshSubscriptions,
      createTransfer,
      payStatement,
      createInstallments,
      createCardPurchase,
      refreshDomains,
      reconcileMutation,
      reconciliationStale,
      retryReconciliation,
      dismissReconciliationStale,
    }),
    [
      accounts,
      categories,
      transactions,
      payables,
      budgets,
      goals,
      debts,
      subscriptions,
      cardStatements,
      profile,
      quickInsights,
      dashboardSummary,
      saveProfile,
      refreshProfile,
      refreshDashboardSummary,
      refreshDashboardSummaryStrict,
      sync,
      readOnly,
      offlineLocked,
      revalidateOfflineSession,
      loading,
      error,
      writeError,
      clearWriteError,
      failedWrite,
      retryWriteError,
      addTransaction,
      updateTransaction,
      deleteTransaction,
      markPayablePaid,
      cancelPayable,
      updatePayable,
      undoPayablePayment,
      createPayable,
      createBudget,
      updateBudget,
      createGoal,
      contributeToGoal,
      cancelGoal,
      updateGoal,
      addAccount,
      updateAccount,
      deactivateAccount,
      addCategory,
      updateCategory,
      deactivateCategory,
      deleteCategory,
      applyCategoryDefaults,
      addCard,
      updateCard,
      addSubscription,
      cancelSubscription,
      updateSubscription,
      refreshSubscriptions,
      createTransfer,
      payStatement,
      createInstallments,
      createCardPurchase,
      refreshDomains,
      reconcileMutation,
      reconciliationStale,
      retryReconciliation,
      dismissReconciliationStale,
    ],
  );

  return (
    <AppStateContext.Provider value={value}>
      {children}
      {reconciliationStale && (
        <div
          data-testid="reconciliation-stale-banner"
          role="alert"
          className="fixed bottom-20 left-1/2 z-50 flex w-[calc(100%-2.5rem)] max-w-md -translate-x-1/2 items-center justify-between gap-2 rounded-[12px] border border-warning/30 bg-warning-tint px-4 py-2.5 text-[12px] font-semibold text-warning shadow-modal"
        >
          <span className="min-w-0 flex-1">
            <span aria-hidden="true">⚠</span> {reconciliationStale.message}
          </span>
          <div className="flex flex-none items-center gap-1">
            <button
              type="button"
              onClick={() => void retryReconciliation()}
              aria-label="Tentar novamente"
              className="rounded-[8px] border border-warning/40 bg-surface px-2.5 py-1 text-[11px] font-bold text-warning transition-colors hover:bg-warning/10"
            >
              Tentar novamente
            </button>
            <button
              type="button"
              onClick={dismissReconciliationStale}
              aria-label="Dispensar aviso"
              className="flex-none text-[16px] leading-none text-warning/60 hover:text-warning"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx)
    throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}

/**
 * FIX-PWA-LINT-LOW-RISK: optional read that never throws. Returns `null`
 * outside AppStateProvider (launcher tests). `useAppState` above keeps
 * throwing — its contract is unchanged.
 */
export function useOptionalAppState(): AppState | null {
  return useContext(AppStateContext);
}
