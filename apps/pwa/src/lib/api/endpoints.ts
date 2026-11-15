/**
 * Typed API endpoints for pi-finance-api.
 * Each function calls apiFetch and maps the response to client types.
 * Throws when API is not configured (caller falls back to mock).
 */

import type {
  Account,
  Category,
  Transaction,
  Payable,
  Budget,
  Goal,
  Subscription,
  CardStatement,
  StatementDetail,
  Profile,
  QuickInsight,
  DashboardSummary,
} from "@/lib/state/types";
import { apiFetch } from "./client";
import type { MutationReceipt } from "@pi-finance/llm-contracts/types";

// ─── Mutation receipts (SPEC §15.1, FIX-P1) ────────────────────────────────

/**
 * List payload carrying the server MutationReceipt additively. The value
 * stays an array (no public API change); the receipt rides as an own
 * property so `extractMutationReceipt` finds it and the existing
 * `reconcileAfterWrite` path consumes the real receipt instead of the
 * registry-kind fallback.
 */
export type ReceiptCarryingItems<T> = T[] & { receipt?: MutationReceipt };

// ─── Mutation options (idempotency) ──────────────────────────────────────────

/** Generates a fresh idempotency key (UUID v4 when crypto is available). */
export function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `pwa-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * apiFetch options for a financial mutation. Every mutation carries an
 * `idempotency-key` header at the authoritative HTTP boundary. Precedence:
 * explicit `commandId` (intent-boundary id threaded by the commands layer,
 * V4.1 Task 3.8) > caller-provided `idempotencyKey` in the body > fresh UUID.
 * The key is never serialized into the request body.
 */
export function mutationOptions(
  method: "POST" | "PATCH" | "DELETE",
  body?: object,
  commandId?: string,
): { method: string; body?: string; idempotencyKey: string } {
  if (body === undefined) {
    return { method, idempotencyKey: commandId ?? newIdempotencyKey() };
  }
  const { idempotencyKey, ...rest } = body as { idempotencyKey?: string } & Record<string, unknown>;
  return {
    method,
    body: JSON.stringify(rest),
    idempotencyKey: commandId ?? idempotencyKey ?? newIdempotencyKey(),
  };
}

// ─── Response shapes (from Fastify routes) ───────────────────────────────────

interface ListResponse<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function fetchAccounts(): Promise<Account[]> {
  const res = await apiFetch<ListResponse<Account>>("/accounts");
  return res.items;
}

export async function fetchCategories(): Promise<Category[]> {
  const res = await apiFetch<ListResponse<Category>>("/categories");
  return res.items;
}

export async function fetchTransactions(
  params?: { limit?: number; offset?: number; page?: number; kind?: string }
): Promise<{ items: Transaction[]; total: number; limit?: number; offset?: number; page?: number }> {
  const q = new URLSearchParams();
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.offset !== undefined) {
    q.set("offset", String(params.offset));
  } else if (params?.page !== undefined) {
    const limit = params.limit ?? 50;
    q.set("offset", String((params.page - 1) * limit));
    q.set("page", String(params.page));
  }
  if (params?.kind) q.set("kind", params.kind);
  const qs = q.toString();
  return apiFetch(`/transactions${qs ? `?${qs}` : ""}`);
}

export async function fetchPayables(params?: {
  status?: string;
}): Promise<Payable[]> {
  const q = params?.status ? `?status=${params.status}` : "";
  const res = await apiFetch<ListResponse<Payable>>(`/payables${q}`);
  return res.items;
}

export async function fetchBudgets(): Promise<Budget[]> {
  const res = await apiFetch<ListResponse<Budget>>("/budgets");
  return res.items;
}

export async function fetchGoals(): Promise<Goal[]> {
  const res = await apiFetch<ListResponse<Goal>>("/goals");
  return res.items;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function createExpenseTransaction(input: {
  description: string;
  amountCents: number;
  date: string;
  categoryId: string;
  accountId: string;
  notes?: string;
  method?: string;
  sourceMessageId?: string;
}): Promise<Transaction> {
  return apiFetch<Transaction>("/transactions/expense", mutationOptions("POST", input));
}

export async function createCard(input: {
  name: string;
  creditLimitCents: number;
  closingDay: number;
  dueDay: number;
  institutionId?: string | null;
  cardProductId?: string | null;
}): Promise<Account> {
  return apiFetch<Account>("/cards", mutationOptions("POST", input));
}

export async function updateCard(
  id: string,
  input: {
    name?: string;
    creditLimitCents?: number;
    closingDay?: number;
    dueDay?: number;
    institutionId?: string | null;
    cardProductId?: string | null;
  },
): Promise<Account> {
  return apiFetch<Account>(`/cards/${id}`, mutationOptions("PATCH", input));
}

export async function fetchCards(): Promise<Account[]> {
  const res = await apiFetch<ListResponse<Account>>("/cards/accounts");
  return res.items;
}

export async function fetchStatements(accountId?: string): Promise<CardStatement[]> {
  const q = accountId ? `?accountId=${accountId}` : "";
  const res = await apiFetch<ListResponse<CardStatement>>(`/cards/statements${q}`);
  return res.items;
}

export async function fetchStatementDetail(id: string): Promise<StatementDetail> {
  return apiFetch<StatementDetail>(`/cards/statements/${id}`);
}

export async function updateCardPurchase(
  purchaseId: string,
  input: {
    description?: string;
    amountCents?: number;
    date?: string;
    categoryId?: string;
  },
): Promise<StatementDetail> {
  return apiFetch<StatementDetail>(`/cards/purchases/${purchaseId}`, mutationOptions("PATCH", input));
}

export async function payStatement(
  statementId: string,
  input: { amountCents: number; fromAccountId: string },
): Promise<CardStatement> {
  return apiFetch<CardStatement>(`/cards/statements/${statementId}/pay`, mutationOptions("POST", input));
}

export async function createInstallments(input: {
  accountId: string;
  description: string;
  totalAmountCents: number;
  purchaseDate: string;
  installmentsTotal: number;
  categoryId?: string;
  subcategoryId?: string;
  notes?: string;
}): Promise<ReceiptCarryingItems<Transaction>> {
  const res = await apiFetch<{ items: Transaction[]; receipt?: MutationReceipt }>("/cards/installments", mutationOptions("POST", input));
  const items = res.items as ReceiptCarryingItems<Transaction>;
  if (res.receipt !== undefined) items.receipt = res.receipt;
  return items;
}

/** H-01: single (1x) card purchase through the CardStore invoice path. */
export async function createCardPurchase(input: {
  accountId: string;
  description: string;
  amountCents: number;
  date: string;
  categoryId?: string;
  subcategoryId?: string;
  notes?: string;
}): Promise<ReceiptCarryingItems<Transaction>> {
  const res = await apiFetch<{ items: Transaction[]; receipt?: MutationReceipt }>("/cards/purchases", mutationOptions("POST", input));
  const items = res.items as ReceiptCarryingItems<Transaction>;
  if (res.receipt !== undefined) items.receipt = res.receipt;
  return items;
}

export async function createTransfer(input: {
  description: string;
  amountCents: number;
  date: string;
  fromAccountId: string;
  toAccountId: string;
  method?: string;
}): Promise<Transaction> {
  return apiFetch<Transaction>("/transfers", mutationOptions("POST", input));
}

export async function addAccount(input: {
  name: string;
  kind: "bank" | "cash" | "credit_card";
  initialBalanceCents: number;
  institutionId?: string | null;
  cardProductId?: string | null;
}): Promise<Account> {
  return apiFetch<Account>("/accounts", mutationOptions("POST", input));
}

export async function addCategory(input: {
  name: string;
  kind: "expense" | "income";
  parentId?: string;
  icon?: string | null;
  color?: string | null;
}): Promise<Category> {
  return apiFetch<Category>("/categories", mutationOptions("POST", input));
}

export type CategoryTreeSub = {
  id: string;
  name: string;
  icon: string | null;
  kind: "sub";
  parentId: string;
};

export type CategoryTreeMacro = {
  id: string;
  name: string;
  icon: string | null;
  kind: "macro";
  type: "expense" | "income";
  isDefault: boolean;
  subcategories: CategoryTreeSub[];
};

export async function fetchCategoryTree(params?: { kind?: "expense" | "income" }): Promise<CategoryTreeMacro[]> {
  const q = params?.kind ? `?kind=${params.kind}` : "";
  const res = await apiFetch<ListResponse<CategoryTreeMacro>>(`/categories/tree${q}`);
  return res.items;
}

export async function applyCategoryDefaults(commandId?: string): Promise<{ ok: boolean; created: number; skipped: number }> {
  return apiFetch<{ ok: boolean; created: number; skipped: number }>(
    "/categories/apply-defaults",
    mutationOptions("POST", {}, commandId),
  );
}

export async function deleteCategory(
  id: string,
  input:
    | { mode: "move"; destinationCategoryId: string }
    | { mode: "cascade"; confirm: true },
): Promise<{ ok: boolean; deletedCategoryIds: string[]; movedTransactions: number; softDeletedTransactions: number }> {
  return apiFetch(`/categories/${id}/delete`, mutationOptions("POST", input));
}

export async function fetchSubscriptions(): Promise<Subscription[]> {
  const res = await apiFetch<ListResponse<Subscription>>("/subscriptions");
  return res.items;
}

export async function addSubscription(input: {
  name: string;
  amountCents: number;
  cycle: "monthly" | "yearly" | "weekly";
  day: number;
  paymentMethod: string;
}): Promise<Subscription> {
  return apiFetch<Subscription>("/subscriptions", mutationOptions("POST", input));
}

export async function cancelSubscription(id: string, commandId?: string): Promise<Subscription> {
  return apiFetch<Subscription>(`/subscriptions/${id}/cancel`, mutationOptions("POST", undefined, commandId));
}

export async function updateSubscription(
  id: string,
  input: {
    name?: string;
    amountCents?: number;
    cycle?: "monthly" | "yearly" | "weekly";
    day?: number;
    paymentMethod?: string;
  },
): Promise<Subscription> {
  return apiFetch<Subscription>(`/subscriptions/${id}`, mutationOptions("PATCH", input));
}

export async function createIncomeTransaction(input: {
  description: string;
  amountCents: number;
  date: string;
  categoryId: string;
  accountId: string;
  notes?: string;
  method?: string;
  sourceMessageId?: string;
}): Promise<Transaction> {
  return apiFetch<Transaction>("/transactions/income", mutationOptions("POST", input));
}

export async function updateTransaction(
  id: string,
  input: {
    description?: string;
    date?: string;
    amountCents?: number;
    accountId?: string;
    categoryId?: string;
    notes?: string;
  },
): Promise<Transaction> {
  return apiFetch<Transaction>(`/transactions/${id}`, mutationOptions("PATCH", input));
}

/**
 * FIX-P1-PWA-RECEIPT-CONSUMERS: DELETE /transactions/:id answers 200 with
 * the soft-deleted entity + a transaction.delete receipt (204 cannot carry
 * a body). The receipt rides on the returned value so `extractMutationReceipt`
 * + `reconcileAfterWrite` consume the real mutationId instead of the
 * registry-kind fallback.
 */
export type DeletedTransaction = Transaction & { receipt?: MutationReceipt };

export async function deleteTransaction(id: string, commandId?: string): Promise<DeletedTransaction> {
  return apiFetch<DeletedTransaction>(`/transactions/${id}`, mutationOptions("DELETE", undefined, commandId));
}

export async function updateAccount(
  id: string,
  input: { name?: string; institutionId?: string | null; cardProductId?: string | null },
): Promise<Account> {
  return apiFetch<Account>(`/accounts/${id}`, mutationOptions("PATCH", input));
}

export async function deactivateAccount(id: string, commandId?: string): Promise<void> {
  await apiFetch(`/accounts/${id}/deactivate`, mutationOptions("POST", undefined, commandId));
}

export async function updateCategory(
  id: string,
  input: { name?: string; icon?: string | null; color?: string | null },
): Promise<Category> {
  return apiFetch<Category>(`/categories/${id}`, mutationOptions("PATCH", input));
}

export async function deactivateCategory(id: string, commandId?: string): Promise<void> {
  await apiFetch(`/categories/${id}/deactivate`, mutationOptions("POST", undefined, commandId));
}

export async function createPayable(input: {
  accountId: string;
  description: string;
  amountCents: number;
  dueDate: string;
  categoryId?: string;
  type?: "one_time" | "recurring";
  frequency?: "monthly" | "quarterly" | "yearly";
  reminderDaysBefore?: number;
  notes?: string;
}): Promise<Payable> {
  return apiFetch<Payable>("/payables", mutationOptions("POST", input));
}

export async function cancelPayable(
  id: string,
  reason?: string,
  commandId?: string,
): Promise<Payable> {
  return apiFetch<Payable>(`/payables/${id}/cancel`, mutationOptions("POST", reason ? { reason } : undefined, commandId));
}

export async function updatePayable(
  id: string,
  input: {
    description?: string;
    amountCents?: number;
    dueDate?: string;
    accountId?: string;
    categoryId?: string;
  },
): Promise<Payable> {
  return apiFetch<Payable>(`/payables/${id}`, mutationOptions("PATCH", input));
}

export async function undoPayablePayment(id: string, paidTransactionId: string, commandId?: string): Promise<Payable> {
  return apiFetch<Payable>(`/payables/${id}/unpay`, mutationOptions("POST", { paidTransactionId }, commandId));
}

export async function markPayablePaid(
  id: string,
  paidDate?: string,
  commandId?: string,
): Promise<Payable> {
  return apiFetch<Payable>(`/payables/${id}/pay`, mutationOptions("POST", paidDate ? { paidDate } : {}, commandId));
}

export async function createBudget(input: {
  categoryId: string;
  name: string;
  amountCents: number;
  period: "monthly" | "quarterly" | "yearly";
  startDate: string;
  alertThreshold?: number;
}): Promise<Budget> {
  return apiFetch<Budget>("/budgets", mutationOptions("POST", input));
}

export async function updateBudget(
  id: string,
  input: {
    amountCents?: number;
    alertThreshold?: number;
  },
): Promise<Budget> {
  return apiFetch<Budget>(`/budgets/${id}`, mutationOptions("PATCH", input));
}

export async function createGoal(input: {
  name: string;
  goalType: "savings" | "purchase" | "debt_payoff" | "emergency_fund";
  targetAmountCents: number;
  startDate: string;
  targetDate?: string;
  description?: string;
  categoryId?: string;
  accountId?: string;
}): Promise<Goal> {
  return apiFetch<Goal>("/goals", mutationOptions("POST", input));
}

export async function contributeToGoal(
  id: string,
  input: {
    amountCents: number;
    contributionDate?: string;
    source?: string;
    notes?: string;
  },
): Promise<Goal> {
  return apiFetch<Goal>(`/goals/${id}/contribute`, mutationOptions("POST", input));
}

export async function cancelGoal(id: string, commandId?: string): Promise<Goal> {
  return apiFetch<Goal>(`/goals/${id}/cancel`, mutationOptions("POST", undefined, commandId));
}

export async function updateGoal(
  id: string,
  input: {
    name?: string;
    targetAmountCents?: number;
    targetDate?: string;
  },
): Promise<Goal> {
  return apiFetch<Goal>(`/goals/${id}`, mutationOptions("PATCH", input));
}

// ─── Profile (Slice B / Resumo) ──────────────────────────

export async function fetchProfile(): Promise<Profile | null> {
  const res = await apiFetch<{ profile: Profile | null }>("/profile");
  return res.profile;
}

export async function patchProfile(input: {
  name?: string;
  email?: string;
  phone?: string;
  avatarColor?: string;
  greetingStyle?: Profile["greetingStyle"];
}): Promise<Profile> {
  const res = await apiFetch<{ profile: Profile }>("/profile", mutationOptions("PATCH", input));
  return res.profile;
}

export async function fetchQuickInsights(): Promise<QuickInsight[]> {
  const res = await apiFetch<{ items: QuickInsight[] }>("/insights/quick");
  return res.items;
}

export async function undoLastAction(input?: { lastOperationId?: string }): Promise<{
  undone: { operation: string; entityId: string; reversal: string };
  /** FIX-P1: server undo receipt (SPEC §15.1) — propagated verbatim via apiFetch. */
  receipt?: MutationReceipt;
}> {
  return apiFetch<{ undone: { operation: string; entityId: string; reversal: string }; receipt?: MutationReceipt }>('/audit/undo', mutationOptions("POST", input ?? {}));
}

// ─── Duplicate detector ─────────────────────────────────────

export type DuplicateCheckInput = {
  kind: "expense" | "income" | "transfer";
  description: string;
  amountCents: number;
  date: string;
  accountId?: string;
  fromAccountId?: string;
  toAccountId?: string;
  idempotencyKey?: string;
};

export type DuplicateMatch = {
  id: string;
  description: string;
  amount_cents: string;
  date: string;
  match_type: "idempotency_key" | "semantic";
  similarity: number;
};

export type DuplicateCheckResult = {
  duplicate_detected: boolean;
  match?: DuplicateMatch;
};

export function formatDuplicateWarning(match: DuplicateMatch, newDesc: string): string {
  const dateStr = new Date(match.date).toISOString().slice(0, 10);
  const amount = (parseInt(match.amount_cents, 10) / 100).toFixed(2);
  const simPct = Math.round(match.similarity * 100);
  if (match.match_type === "idempotency_key") {
    return `Já existe um lançamento com essa chave de idempotência: ${match.description} — R$ ${amount} em ${dateStr} ID: ${match.id} Quer registrar mesmo assim?`;
  }
  return `Achei um lançamento parecido: "${match.description}" — R$ ${amount} em ${dateStr} (${simPct}% similar) Seu novo: "${newDesc}" É o mesmo gasto?`;
}

export async function checkDuplicate(input: DuplicateCheckInput): Promise<DuplicateCheckResult> {
  return apiFetch<DuplicateCheckResult>("/transactions/detect-duplicate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ─── Audit logs ───────────────────────────────────────────

export type AuditLog = {
  id: string;
  workspaceId: string;
  actorType: "device" | "user";
  actorId: string;
  operation: string;
  eventType: string;
  payloadHash: string;
  effectRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AuditLogFilters = {
  limit?: number;
  operation?: string;
  eventType?: string;
  actorType?: "device" | "user";
  entityType?: string;
  entityId?: string;
  /** Explicit workspace scope header (X-Workspace-Id) for cross-workspace readers. */
  workspaceId?: string;
};

export async function fetchAuditLogs(filters: AuditLogFilters = {}): Promise<{ items: AuditLog[]; total: number }> {
  const q = new URLSearchParams();
  if (filters.limit !== undefined) q.set("limit", String(filters.limit));
  if (filters.operation) q.set("operation", filters.operation);
  if (filters.eventType) q.set("eventType", filters.eventType);
  if (filters.actorType) q.set("actorType", filters.actorType);
  if (filters.entityType) q.set("entityType", filters.entityType);
  if (filters.entityId) q.set("entityId", filters.entityId);
  const qs = q.toString();
  return apiFetch(`/audit-logs${qs ? `?${qs}` : ""}`, {
    headers: filters.workspaceId ? { "X-Workspace-Id": filters.workspaceId } : {},
  });
}

// ─── Analytics (charts-data feature) ───────────────────────────────────────
/**
 * Generic analytics JSON GET (abortable). Keeps `apiFetch` confined
 * to the approved endpoint layer while analytics query builders stay in the
 * feature module (lib/api boundary invariant).
 */
export async function fetchAnalyticsJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(path, signal ? { signal } : {});
}

// ─── Dashboard Summary ───────────────────────────────────

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  return apiFetch<DashboardSummary>("/dashboard/summary");
}

// ─── Price Alerts ────────────────────────────────────────────

export type PriceAlert = {
  id: string;
  householdId: string;
  productName: string;
  targetPriceCents: number;
  condition: "below" | "above";
  createdAt: string;
};

export async function fetchPriceAlerts(): Promise<PriceAlert[]> {
  const res = await apiFetch<{ items: PriceAlert[]; total: number }>("/alerts/price");
  return res.items;
}

export async function createPriceAlert(input: {
  productName: string;
  targetPriceCents: number;
  condition: "below" | "above";
}): Promise<PriceAlert> {
  return apiFetch<PriceAlert>("/alerts/price", mutationOptions("POST", input));
}

export async function checkPriceAlertsApi(input?: {
  productName?: string;
  currentPriceCents?: number;
}): Promise<{ notifications: { alertId: string; productName: string; triggered: boolean; message: string }[]; total: number }> {
  return apiFetch("/alerts/price/check", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}
