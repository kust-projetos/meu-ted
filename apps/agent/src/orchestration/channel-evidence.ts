/**
 * Production grounding wiring (AGENT-005).
 *
 * Builds the `evidenceProvider` / `correctionProvider` pair injected into
 * `ConversationOrchestrator` by `orchestratorForChannel` for every channel
 * (pwa-rest, sdk, broker).
 *
 * - The evidence provider maps `plan.domain` / `plan.requestedOperations`
 *   onto the canonical generated READ tools (never writes), scoped with the
 *   turn's workspace (`householdId = input.workspaceId`). Each read is
 *   fail-contained: transport or shape failures become a single `error`
 *   `EvidenceItem` for that source — fail-closed for the item, never
 *   invented data, never a thrown turn failure.
 * - The correction provider performs the single structured correction
 *   attempt required by `createGroundedResponseWithRetry`, reusing the same
 *   unified response mechanism as the initial provider call (ONE retry max
 *   is enforced by the orchestrator/grounded-response, not here).
 */

import { classifyReadFailure, createEvidenceEnvelope, type EvidenceEnvelope, type EvidenceInput, type ReadAbsenceReason } from '../evidence/evidence-envelope.js';
import { generatedHttpTools, type ToolRequestAuth } from '../generated/http-tools.js';
import { isUsageQuotaPassthroughError } from '../llm/relay-failover.js';
import { emitSanitizedEvent } from '../observability/events.js';
import type { TurnInput, TurnPlan } from './conversation-orchestrator.js';

/**
 * Callable canonical read: params in, projected API payload out. The
 * optional second argument carries the turn's request credential
 * (`delegatedToken` + `apiOrigin`), threaded explicitly per invocation —
 * never through module-global state, so concurrent turns from different
 * workspaces cannot observe each other's token.
 */
export type ChannelReadFn = (params: Record<string, unknown>, auth?: ToolRequestAuth) => Promise<unknown>;

/** Injectable read-tool seam (defaults bind the generated HTTP tools). */
export type ChannelReadTools = {
  listAccounts: ChannelReadFn;
  listRecentTransactions: ChannelReadFn;
  getMonthSummary: ChannelReadFn;
  listStatements: ChannelReadFn;
  listAccountsPayable: ChannelReadFn;
  listBudgets: ChannelReadFn;
  listGoals: ChannelReadFn;
  listCategories: ChannelReadFn;
};

const bindGenerated = (name: string): ChannelReadFn => {
  const tool = generatedHttpTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`agent.evidence_tool_missing:${name}`);
  // The credential travels as the tool `ctx` (5th execute argument), which
  // the generated client forwards explicitly per request — the legacy
  // module-global fallback is never consulted for these calls.
  return (params, auth) => tool.execute('evidence-read', params, undefined, undefined, auth ?? undefined);
};

export const defaultChannelReadTools = (): ChannelReadTools => ({
  listAccounts: bindGenerated('list_accounts'),
  listRecentTransactions: bindGenerated('list_recent_transactions'),
  getMonthSummary: bindGenerated('get_month_summary'),
  listStatements: bindGenerated('list_statements'),
  listAccountsPayable: bindGenerated('list_accounts_payable'),
  listBudgets: bindGenerated('list_budgets'),
  listGoals: bindGenerated('list_goals'),
  listCategories: bindGenerated('list_categories'),
});

export type ChannelGroundingDeps = {
  /** Unified response mechanism (the same call used for the initial answer). */
  respond: (input: TurnInput, plan: TurnPlan) => Promise<string>;
  readTools?: ChannelReadTools;
  apiOrigin?: string;
  /**
   * Per-turn read credential. Generated read tools intentionally omit
   * `context` params (e.g. `householdId`) from the wire: the API scopes
   * reads from the delegated token claims (`financial.read` capability,
   * `workspace` claim). Absent = unauthenticated reads, which fail closed
   * into `error` items downstream.
   */
  readToken?: (input: TurnInput) => Promise<string | undefined>;
  /** Per-read budget; a slow read degrades to an `error` item, never a hang. */
  readTimeoutMs?: number;
  /**
   * Sanitized lifecycle event sink for evidence reads (defaults to
   * `emitSanitizedEvent`). Receives `tool.started` / `tool.completed` with
   * allowlisted fields only (tool name, status, latency) — never params,
   * tokens, or payloads.
   */
  events?: (eventType: string, fields: Record<string, unknown>) => void;
};

export type ChannelGrounding = {
  evidenceProvider: (input: TurnInput, plan: TurnPlan) => Promise<EvidenceEnvelope | null>;
  correctionProvider: (input: TurnInput, plan: TurnPlan, unsupportedClaims: readonly string[]) => Promise<string | null>;
};

const DEFAULT_READ_TIMEOUT_MS = 3000;
const MAX_EVIDENCE_READS = 2;
const MAX_STATEMENT_ENTRIES = 20;

type ReadKind =
  | 'accounts'
  | 'transactions'
  | 'month-summary'
  | 'statements'
  | 'payables'
  | 'budgets'
  | 'goals'
  | 'categories';

/** Planned operation name → canonical read (intent-router aliases included). */
const OPERATION_TO_READ: Record<string, ReadKind> = {
  get_balance: 'accounts',
  list_accounts: 'accounts',
  list_transactions: 'transactions',
  list_recent_transactions: 'transactions',
  get_month_summary: 'month-summary',
  spending_insights: 'month-summary',
  list_statements: 'statements',
  get_statement_details: 'statements',
  list_cards: 'statements',
  list_payables: 'payables',
  list_accounts_payable: 'payables',
  check_payable_reminders: 'payables',
  list_budgets: 'budgets',
  check_budgets: 'budgets',
  budget_trends: 'budgets',
  list_goals: 'goals',
  list_categories: 'categories',
};

/** Domain fallback when no planned operation maps to a read. Null = no evidence (legacy pass-through). */
const DOMAIN_DEFAULT_READ: Record<string, ReadKind | null> = {
  accounts: 'accounts',
  transactions: 'transactions',
  cards: 'statements',
  payables: 'payables',
  budgets: 'budgets',
  goals: 'goals',
  categories: 'categories',
  memory: null,
  web: null,
  general: null,
};

const READ_SOURCE: Record<ReadKind, string> = {
  accounts: 'api.accounts',
  transactions: 'api.transactions',
  'month-summary': 'api.month-summary',
  statements: 'api.statements',
  payables: 'api.payables',
  budgets: 'api.budgets',
  goals: 'api.goals',
  categories: 'api.categories',
};

/** Generated tool name behind each read kind (used for lifecycle events). */
const READ_TOOL_NAME: Record<ReadKind, string> = {
  accounts: 'list_accounts',
  transactions: 'list_recent_transactions',
  'month-summary': 'get_month_summary',
  statements: 'list_statements',
  payables: 'list_accounts_payable',
  budgets: 'list_budgets',
  goals: 'list_goals',
  categories: 'list_categories',
};

const selectReads = (plan: TurnPlan): readonly ReadKind[] => {
  const selected: ReadKind[] = [];
  for (const operation of plan.requestedOperations) {
    if (operation.kind !== 'read') continue;
    const kind = OPERATION_TO_READ[operation.name];
    if (kind && !selected.includes(kind)) selected.push(kind);
    if (selected.length >= MAX_EVIDENCE_READS) return selected;
  }
  const fallback = DOMAIN_DEFAULT_READ[plan.domain] ?? null;
  if (fallback && !selected.includes(fallback) && selected.length < MAX_EVIDENCE_READS) selected.push(fallback);
  return selected;
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`agent.evidence_timeout:${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const toCents = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  !!value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Projected tool payloads carry the rows under a named key (or `items`). */
const pickRows = (result: unknown, keys: readonly string[]): readonly unknown[] => {
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
};

const now = (): string => new Date().toISOString();

/**
 * A04/R04: a failed read carries a typed FAILURE reason (never an absence
 * reason, so it can never be narrated as "nothing there"). `error` overrides
 * the reason of a transport/shape failure that produced one.
 */
const errorItem = (kind: ReadKind, ref: string, reason: ReturnType<typeof classifyReadFailure>): EvidenceInput => ({
  ref,
  source: READ_SOURCE[kind],
  retrievedAt: now(),
  status: 'error',
  reason,
  data: null,
});

/** A read that SUCCEEDED with no rows in the requested scope (A04/R04). */
const emptyItem = (kind: ReadKind, ref: string, reason?: ReadAbsenceReason): EvidenceInput => ({
  ref,
  source: READ_SOURCE[kind],
  retrievedAt: now(),
  status: 'empty',
  ...(reason === undefined ? {} : { reason }),
  data: [],
});

/** Account kinds authored by the API (ADR-018). Anything else stays unknown downstream — never inferred. */
const KNOWN_ACCOUNT_KINDS: ReadonlySet<string> = new Set(['bank', 'cash', 'credit_card']);

const mapAccounts = (result: unknown): EvidenceInput[] => {
  const rows = pickRows(result, ['accounts', 'items']);
  if (rows.length === 0) {
    // The read SUCCEEDED and this workspace has no accounts: a setup state of
    // THIS scope. `workspace_empty` is NOT claimed here — it needs the A09
    // consistent snapshot (A04 block b).
    return [emptyItem('accounts', 'accounts', 'setup_incomplete')];
  }
  const items: EvidenceInput[] = [];
  let omittedCount = 0;
  for (const row of rows) {
    const record = asRecord(row);
    const accountName = record && typeof record.accountName === 'string'
      ? record.accountName
      : record && typeof record.name === 'string'
        ? record.name
        : null;
    const balanceCents = record
      ? (toCents(record.balanceCents) ?? toCents(record.balance_cents) ?? toCents(record.balance))
      : null;
    // W1-TED-ACCOUNT-GROUNDING: `kind` travels from its origin (the
    // `list_accounts` projection) into evidence. Unknown/absent kinds are
    // preserved as-is for the renderer to treat neutrally — the type is
    // never inferred from the account name.
    const kind = record && typeof record.kind === 'string' && KNOWN_ACCOUNT_KINDS.has(record.kind)
      ? record.kind
      : undefined;
    if (accountName === null || balanceCents === null) {
      // Invalid rows are counted, never presented: the renderer states
      // partiality explicitly instead of a supposedly-complete total.
      omittedCount += 1;
      continue;
    }
    // Shape matches the orchestrator's deterministic balance renderer exactly.
    items.push({
      ref: `account:${typeof record?.id === 'string' ? record.id : accountName}`,
      source: READ_SOURCE.accounts,
      retrievedAt: now(),
      status: 'ok',
      data: { accountName, balanceCents, ...(kind !== undefined ? { kind } : {}) },
    });
  }
  // Rows that all failed validation are a FAILURE of the read projection, never
  // an absence: the API answered and the payload is unusable.
  if (items.length === 0) return [errorItem('accounts', 'accounts', 'permanent_error')];
  if (omittedCount > 0) {
    items.push({
      ref: 'accounts:incomplete',
      source: READ_SOURCE.accounts,
      retrievedAt: now(),
      status: 'ok',
      data: { incomplete: true, omittedCount },
    });
  }
  return items;
};

const mapTransactions = (result: unknown): EvidenceInput[] => {
  const rows = pickRows(result, ['transactions', 'items']);
  const entries: Array<{ description: string; date: string; amountCents: number }> = [];
  for (const row of rows.slice(0, MAX_STATEMENT_ENTRIES)) {
    const record = asRecord(row);
    if (!record || typeof record.description !== 'string' || typeof record.date !== 'string') continue;
    const amountCents = toCents(record.amountCents) ?? toCents(record.amount_cents) ?? toCents(record.amount);
    if (amountCents === null) continue;
    // Shape matches the orchestrator's deterministic statement renderer exactly.
    entries.push({ description: record.description, date: record.date, amountCents });
  }
  if (entries.length === 0) {
    // Rows that existed but could not be projected are a failure; no rows at
    // all is a real absence of THIS read — left unclassified, because an
    // unfiltered list proves neither period, category nor filter (A09 owns the
    // global "workspace vazio" diagnosis).
    if (rows.length > 0) return [errorItem('transactions', 'statement', 'permanent_error')];
    return [emptyItem('transactions', 'statement')];
  }
  return [{ ref: 'statement', source: READ_SOURCE.transactions, retrievedAt: now(), status: 'ok', data: entries }];
};

/**
 * A04/R04: the analytics read (`get_month_summary` / `spending_insights`) is
 * period-bounded by construction and returns
 * `{incomeCents, expenseCents, balanceCents, transactionCount}`.
 *
 * - `transactionCount === 0` on a WELL-FORMED payload is a REAL `period_empty`:
 *   the query succeeded and the requested period has no entries.
 * - An invalid shape is `error`/`permanent_error`: absence is never inferred
 *   from a payload that does not match the contract.
 * - Zero totals WITH entries stay `ok` and the row count travels with the
 *   evidence: `totalCents = 0` never means "no entries".
 */
const mapMonthSummary = (result: unknown): EvidenceInput[] => {
  const record = asRecord(result);
  // An invalid shape (undefined/null/string/array) proves NOTHING about the
  // period: it is a read failure, never `period_empty`. Only a well-formed
  // payload with an explicit zero count proves absence.
  if (record === null) return [errorItem('month-summary', 'month-summary', 'permanent_error')];
  const entries = toCents(record.transactionCount) ?? toCents(record.entryCount) ?? toCents(record.count);
  if (entries === 0) return [emptyItem('month-summary', 'month-summary', 'period_empty')];
  return [{ ref: 'month-summary', source: READ_SOURCE['month-summary'], retrievedAt: now(), status: 'ok', data: result }];
};

/** Single-object reads (month summary, statements, payables, budgets, goals, categories). */
const mapSingleton = (kind: ReadKind, ref: string, result: unknown): EvidenceInput[] => {
  if (result === null || result === undefined) {
    return [{ ref, source: READ_SOURCE[kind], retrievedAt: now(), status: 'empty', data: [] }];
  }
  return [{ ref, source: READ_SOURCE[kind], retrievedAt: now(), status: 'ok', data: result }];
};

export const createChannelGrounding = (deps: ChannelGroundingDeps): ChannelGrounding => {
  const tools = deps.readTools ?? defaultChannelReadTools();
  const timeoutMs = deps.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const emit = deps.events ?? emitSanitizedEvent;

  const evidenceProvider = async (input: TurnInput, plan: TurnPlan): Promise<EvidenceEnvelope | null> => {
    const kinds = selectReads(plan);
    if (kinds.length === 0) return null;
    // Per-turn credential, threaded explicitly into every read below — the
    // same scoping the model-tool path uses. This provider NEVER touches the
    // legacy module-global token slot: concurrent turns from different
    // workspaces each carry only their own token. A missing/failed token
    // stays unauthenticated (explicit `delegatedToken: undefined` suppresses
    // the global fallback) and fails closed into `error` items below.
    let readToken: string | undefined;
    try {
      readToken = await deps.readToken?.(input);
    } catch {
      readToken = undefined;
    }
    // Own `delegatedToken` key (even when undefined) is authoritative in
    // `requestPiApiJson`: it suppresses the global fallback, so a mint
    // failure can never resurrect a previous turn's stale token.
    const auth: ToolRequestAuth = {
      delegatedToken: typeof readToken === 'string' && readToken ? readToken : undefined,
      ...(deps.apiOrigin !== undefined ? { apiOrigin: deps.apiOrigin } : {}),
    };
    const householdId = input.workspaceId;
    const fetchers: Record<ReadKind, () => Promise<EvidenceInput[]>> = {
      accounts: async () => mapAccounts(await tools.listAccounts({ householdId }, auth)),
      transactions: async () => mapTransactions(await tools.listRecentTransactions({ householdId, limit: 20 }, auth)),
      'month-summary': async () => mapMonthSummary(
        await tools.getMonthSummary({ householdId, yearMonth: new Date().toISOString().slice(0, 7) }, auth),
      ),
      statements: async () => mapSingleton('statements', 'statements', await tools.listStatements({ householdId }, auth)),
      payables: async () => mapSingleton('payables', 'payables', await tools.listAccountsPayable({ householdId }, auth)),
      budgets: async () => mapSingleton('budgets', 'budgets', await tools.listBudgets({ householdId }, auth)),
      goals: async () => mapSingleton('goals', 'goals', await tools.listGoals({ householdId }, auth)),
      categories: async () => mapSingleton('categories', 'categories', await tools.listCategories({ householdId }, auth)),
    };
    const settled = await Promise.all(kinds.map(async (kind) => {
      const toolName = READ_TOOL_NAME[kind];
      const startedAt = Date.now();
      // Sanitized lifecycle: name/status/latency only — never params,
      // tokens, or financial payloads. Observability never breaks the turn.
      try {
        emit('tool.started', { tool: toolName, status: 'started' });
      } catch {
        // Best effort.
      }
      try {
        const items = await withTimeout(fetchers[kind](), timeoutMs, kind);
        try {
          emit('tool.completed', { tool: toolName, status: 'completed', latencyMs: Date.now() - startedAt });
        } catch {
          // Best effort.
        }
        return items;
      } catch (error) {
        // Fail-closed for the item: the orchestrator grounds against the
        // remaining evidence and falls back safe when nothing is usable.
        const status = error instanceof Error && error.message.includes('agent.evidence_timeout:') ? 'timeout' : 'error';
        try {
          emit('tool.completed', { tool: toolName, status, latencyMs: Date.now() - startedAt, error });
        } catch {
          // Best effort.
        }
        return [errorItem(kind, kind, classifyReadFailure(error))];
      }
    }));
    try {
      return createEvidenceEnvelope(settled.flat(), {});
    } catch {
      return createEvidenceEnvelope([{
        ref: 'unavailable',
        source: 'tool',
        retrievedAt: now(),
        status: 'error',
        reason: 'unavailable',
        data: null,
      }], {});
    }
  };

  /**
   * ONE structured correction attempt reusing the unified response
   * mechanism. Returns null when there is nothing to correct or the retry
   * itself fails, letting the grounded path fall back safe.
   *
   * Usage-quota gate: a denied/unavailable correction reservation
   * (`agent.quota_exceeded` / `agent.usage_unavailable` /
   * `agent.persistence_unavailable`) is rethrown verbatim — it must remain
   * an HTTP quota error, never collapse into a 200 deterministic fallback.
   * Ordinary retry failures still return null (safe fallback).
   *
   * FIX-AGENT-RELAY-FAILOVER-HARDENING (A): the retry input carries the
   * internal-only `internalCorrection: true` flag — the ONLY signal the
   * response provider trusts to skip user-turn persistence. The marker stays
   * in the prompt text (the model needs the instruction), but marker text
   * alone never confers internal status.
   */
  const correctionProvider = async (
    input: TurnInput,
    plan: TurnPlan,
    unsupportedClaims: readonly string[],
  ): Promise<string | null> => {
    if (unsupportedClaims.length === 0) return null;
    const correctionInput: TurnInput = {
      ...input,
      internalCorrection: true,
      text: `${input.text}\n\n[Correção de grounding: os trechos a seguir não têm suporte nos dados apurados e devem ser removidos ou substituídos apenas por dados apurados: ${unsupportedClaims.join('; ')}. Responda usando APENAS os dados apurados.]`,
    };
    try {
      const revised = await deps.respond(correctionInput, plan);
      return typeof revised === 'string' && revised.trim().length > 0 ? revised : null;
    } catch (error) {
      if (isUsageQuotaPassthroughError(error)) throw error;
      return null;
    }
  };

  return { evidenceProvider, correctionProvider };
};
