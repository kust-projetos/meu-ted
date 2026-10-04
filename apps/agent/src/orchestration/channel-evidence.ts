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

import { declareAnalyticsEnvelope, normalizeAnalyticsQuery } from '../agent-config/analytics-envelope.js';
import { classifyReadFailure, createEvidenceEnvelope, resolveEnvelopeRejection, type EvidenceEnvelope, type EvidenceInput, type ReadAbsenceReason } from '../evidence/evidence-envelope.js';
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
  /**
   * A09-int: the analytics reads (A04 follow-up). They go through the SAME
   * boundary the model tool uses (`analytics-envelope.ts`), so the evidence the
   * turn presents carries the proof envelope the API declared.
   */
  analyticsKpis: ChannelReadFn;
  analyticsCategoryBreakdown: ChannelReadFn;
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
  analyticsKpis: bindGenerated('analytics_kpis'),
  analyticsCategoryBreakdown: bindGenerated('analytics_category_breakdown'),
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
  | 'categories'
  | 'analytics-kpis'
  | 'analytics-breakdown';

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
  // A09-int: the analytics tools are their OWN read. They were not mapped here,
  // so a turn planning them had no evidence at all — the proof envelope existed
  // only on the tool payload the model path sees.
  analytics_kpis: 'analytics-kpis',
  analytics_category_breakdown: 'analytics-breakdown',
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
  'analytics-kpis': 'api.analytics.kpis',
  'analytics-breakdown': 'api.analytics.category-breakdown',
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
  'analytics-kpis': 'analytics_kpis',
  'analytics-breakdown': 'analytics_category_breakdown',
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

/**
 * F2 — SHAPE GATE do payload de uma leitura de LISTA, rodado no channel-evidence
 * sobre o payload que o cliente devolveu, ANTES de qualquer mapeamento.
 *
 * Por que aqui e não no cliente gerado: `project()`
 * (`generated/http-tools.ts`) é deliberadamente lossy por contrato — um
 * `response.items` ausente ou inválido vira `[]`, e o `result: 'items'`
 * MANUFATURA a chave projetada (`accounts`/`categories`/`transactions`) como
 * array mesmo quando o corpo não tinha `items`. O gerado não se edita à mão;
 * a verificação morde no último ponto onde o payload cru ainda é inspecionável.
 *
 * Por que SOMENTE a chave `items`: é a chave que TODAS as rotas de lista
 * declaram — `/accounts` (`{items,total}`), `/transactions`
 * (`{items,total,limit,offset}`), `/goals`, `/budgets`, `/payables`,
 * `/categories`, `/cards/statements` (todas `{items,total}`) — e o
 * `project()` a preserva verbatim via `...response`. Aceitar também a chave
 * projetada reabriria o buraco: um corpo `{}` chega como
 * `{success:true, accounts: []}`, que é exatamente o payload que fazia o
 * workspace parecer vazio.
 *
 * Três saídas, e só três:
 * - objeto com `items` ARRAY → lista válida (vazia = ausência real);
 * - objeto sem `items`, ou com `items` não-array → FALHA da leitura;
 * - `null`/`undefined`/primitivo/array no topo → FALHA da leitura.
 *
 * A FALHA usa `permanent_error`, o motivo do eixo FECHADO que já significa
 * "a API respondeu e o payload é inutilizável" (mesmo precedente de
 * `mapAccounts` e `mapMonthSummary`). O vocabulário NÃO é expandido: um
 * `malformed_payload` novo teria de atravessar a dedupe de
 * `serializeEvidenceForPrompt`, o renderizador e cada consumidor para
 * carregar a mesma informação, e NENHUMA reason de ausência pode ser
 * derivada de um payload fora do contrato (R04).
 */
type ListPayload =
  | { readonly ok: true; readonly rows: readonly unknown[] }
  | { readonly ok: false };

const readListPayload = (result: unknown): ListPayload => {
  const record = asRecord(result);
  if (record === null) return { ok: false };
  const items = record['items'];
  return Array.isArray(items) ? { ok: true, rows: items } : { ok: false };
};

/**
 * Uma linha de entidade que não é objeto (`null`, string, número) é fora de
 * contrato. Nas leituras que NÃO projetam a linha (statements/payables/
 * budgets/goals/categories — o payload viaja inteiro dentro de `data` e dali
 * para o prompt), a única tratativa honesta é derrubar a leitura: descartar a
 * linha exigiria moldar o payload, mudando o contrato que o modelo lê, e sem
 * moldar a linha quebrada chegaria intacta ao prompt como se fosse válida.
 *
 * `accounts`/`transactions` NÃO usam este predicado: elas projetam cada linha
 * no shape do renderizador e já tratam o caso honesta (contar e declarar a
 * partialidade, ou `permanent_error` quando nenhuma linha serve).
 */
const rowsAreEntityRecords = (rows: readonly unknown[]): boolean => rows.every((row) => asRecord(row) !== null);

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

/**
 * A09/A04(b) — the `workspace_empty` producer. It is the only claim about the
 * WORKSPACE rather than about the requested scope, so it is emitted ONLY from a
 * consistent MULTI-READ snapshot, and only when every collected item proves the
 * same thing:
 *
 * - two or more DISTINCT read sources (one read states its own scope only —
 *   the A04 block b block on a single unfiltered list);
 * - EVERY item `empty`: a failure proves nothing, and R04 forbids turning "the
 *   read broke" into "there is nothing there";
 * - no scope-narrowing absence (`period_empty` / `category_empty` /
 *   `filter_empty`), because each of them proves that data EXISTS outside the
 *   consulted scope — the exact opposite of a globally empty workspace.
 *
 * The claim is ADDITIVE: a per-read reason is never rewritten into a global
 * one, so the more specific scope copy keeps winning in the deterministic
 * renderer while `workspace_empty` travels in the envelope and in the prompt
 * absences the model sees.
 */
const WORKSPACE_EMPTY_MIN_SOURCES = 2;
const SCOPE_NARROWING_ABSENCE: ReadonlySet<string> = new Set<ReadAbsenceReason>(['period_empty', 'category_empty', 'filter_empty']);

const withWorkspaceEmptyAggregate = (items: readonly EvidenceInput[]): readonly EvidenceInput[] => {
  if (items.length === 0) return items;
  if (!items.every((item) => item.status === 'empty')) return items;
  if (items.some((item) => item.reason !== undefined && SCOPE_NARROWING_ABSENCE.has(item.reason))) return items;
  if (new Set(items.map((item) => item.source)).size < WORKSPACE_EMPTY_MIN_SOURCES) return items;
  return [
    ...items,
    {
      ref: 'workspace',
      source: 'agent.evidence-aggregate',
      retrievedAt: now(),
      status: 'empty',
      reason: 'workspace_empty',
      data: [],
    } satisfies EvidenceInput,
  ];
};

/** Account kinds authored by the API (ADR-018). Anything else stays unknown downstream — never inferred. */
const KNOWN_ACCOUNT_KINDS: ReadonlySet<string> = new Set(['bank', 'cash', 'credit_card']);

const mapAccounts = (result: unknown): EvidenceInput[] => {
  const payload = readListPayload(result);
  if (!payload.ok) {
    // F2: a API respondeu fora do contrato. Isso não prova que o workspace
    // não tem contas — prova que a leitura não produziu conclusão alguma.
    return [errorItem('accounts', 'accounts', 'permanent_error')];
  }
  const rows = payload.rows;
  if (rows.length === 0) {
    // The read SUCCEEDED and this workspace has no accounts: a setup state of
    // THIS scope. `workspace_empty` is NOT claimed here — a single read is not
    // a snapshot; the aggregate claim lives in `withWorkspaceEmptyAggregate`
    // (A09/A04 block b), which needs two independent empty sources.
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
  const payload = readListPayload(result);
  if (!payload.ok) {
    // F2: idem `mapAccounts` — payload fora do contrato nunca vira "sem
    // lançamentos no período".
    return [errorItem('transactions', 'statement', 'permanent_error')];
  }
  const rows = payload.rows;
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
    // global "workspace vazio" diagnosis, via the multi-read aggregate).
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

/**
 * A19 + F3 — the UNFILTERED, workspace-scoped entity list reads (statements,
 * payables, budgets, goals, categories), aligned with the shape the routes
 * ACTUALLY answer.
 *
 * F3 (o defeito): o mapper anterior só produzia `setup_incomplete` para
 * `null`/`undefined` — uma forma ARTIFICIAL que o cliente gerado nunca
 * produz. As rotas respondem `{items: [...], total: n}`, então a lista vazia
 * REAL não recebia reason alguma: o item chegava ao prompt e ao renderizador
 * como um "não-claim" genérico, indistinguível de uma ausência nunca
 * classificada, e a agregação `workspace_empty` (A04 bloco b) nunca era
 * exercitada no caminho real.
 *
 * F3 + F2 (o comportamento único, agora):
 *
 * - payload fora do contrato (`null`, `{}`, `items` não-array) → FALHA
 *   `permanent_error`: nenhuma ausência pode ser derivada dele (R04);
 * - `items` vazio → `empty`/`setup_incomplete`: a leitura FUNCIONOU e este
 *   escopo não tem nada configurado — o mesmo estado de setup que
 *   `mapAccounts` já declara, e que agora sobe à agregação `workspace_empty`;
 * - `items` preenchido → `ok` com o payload preservado (o modelo lê a mesma
 *   forma que a rota devolveu).
 */
const mapEntityList = (kind: ReadKind, ref: string, result: unknown): EvidenceInput[] => {
  const payload = readListPayload(result);
  if (!payload.ok) return [errorItem(kind, ref, 'permanent_error')];
  if (!rowsAreEntityRecords(payload.rows)) return [errorItem(kind, ref, 'permanent_error')];
  if (payload.rows.length === 0) return [emptyItem(kind, ref, 'setup_incomplete')];
  return [{ ref, source: READ_SOURCE[kind], retrievedAt: now(), status: 'ok', data: result }];
};

/**
 * A09-int pós-G03 — a leitura de analytics entra na evidência COM o envelope de
 * prova que a API declarou (`effectivePeriod`/`boundary`/`basis`/`asOf`/
 * `semanticsVersion` e o decimal exato de G-B). As três saídas são as únicas
 * honestas, e nenhuma delas carrega um número que a leitura não provou:
 *
 * 1. **Envelope ausente** (a resposta não traz a janela que produziu os
 *    totais) → `error`/`permanent_error` com `data: null`. Declarar uma janela
 *    seria inventar prova, e ancorar os totais sem a fonte é pior que não ter
 *    resposta.
 * 2. **Janela vazia declarada pela API** (`transactionCount === 0` /
 *    `emptyReason` / breakdown sem slices) → `empty`/`period_empty`: a leitura
 *    FUNCIONOU e o período não tem lançamentos, o que nunca pode ser narrado
 *    como "ok com zeros" (R04).
 * 3. **Envelope utilizável** → `ok` com o payload envelopado, prova incluída.
 */
const mapAnalytics = (kind: ReadKind, ref: string, result: unknown): EvidenceInput[] => {
  const declared = declareAnalyticsEnvelope(result);
  if (!declared.ok) {
    return [errorItem(kind, ref, 'permanent_error')];
  }
  const payload = asRecord(declared.response);
  // A ausência é provada pelo que a API DECLARA: a contagem zero dos KPIs, o
  // `emptyReason`, ou o breakdown que voltou com a lista de categorias vazia.
  // Um payload sem nenhum desses sinais é `ok` — a ausência nunca é inferida
  // de um campo que a leitura não preencheu.
  const entries = toCents(payload?.['transactionCount']);
  const emptyReason = typeof payload?.['emptyReason'] === 'string' && payload['emptyReason'] !== '' ? payload['emptyReason'] : null;
  const slices = Array.isArray(payload?.['slices']) ? (payload['slices'] as readonly unknown[]) : null;
  const provenEmpty = (entries !== null && entries === 0) || emptyReason !== null || (slices !== null && slices.length === 0);
  if (provenEmpty) {
    return [{ ref, source: READ_SOURCE[kind], retrievedAt: now(), status: 'empty', reason: 'period_empty', data: [] }];
  }
  return [{ ref, source: READ_SOURCE[kind], retrievedAt: now(), status: 'ok', data: declared.response }];
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
    /**
     * A09-int: the analytics reads are period-bounded, and `from`/`to` are
     * silently DROPPED by the API without `period=custom` (spike §3.1) — the
     * same normalization the model-tool boundary applies, so the evidence and
     * the tool can never disagree about the window. The current month is the
     * default window, exactly like `getMonthSummary` above.
     *
     * FAIL-CLOSED: an unusable window THROWS instead of degrading to an empty
     * query, because a query without `period` is silently resolved by the API
     * as `last30days` — an undeclared window under grounding evidence.
     */
    const analyticsWindow = (): Record<string, unknown> => {
      const normalized = normalizeAnalyticsQuery({
        yearMonth: new Date().toISOString().slice(0, 7),
      });
      if (!normalized.ok) throw new Error(`agent.analytics_window:${normalized.reason}`);
      return normalized.query;
    };
    const fetchers: Record<ReadKind, () => Promise<EvidenceInput[]>> = {
      accounts: async () => mapAccounts(await tools.listAccounts({ householdId }, auth)),
      transactions: async () => mapTransactions(await tools.listRecentTransactions({ householdId, limit: 20 }, auth)),
      'month-summary': async () => mapMonthSummary(
        await tools.getMonthSummary({ householdId, yearMonth: new Date().toISOString().slice(0, 7) }, auth),
      ),
      statements: async () => mapEntityList('statements', 'statements', await tools.listStatements({ householdId }, auth)),
      payables: async () => mapEntityList('payables', 'payables', await tools.listAccountsPayable({ householdId }, auth)),
      budgets: async () => mapEntityList('budgets', 'budgets', await tools.listBudgets({ householdId }, auth)),
      goals: async () => mapEntityList('goals', 'goals', await tools.listGoals({ householdId }, auth)),
      categories: async () => mapEntityList('categories', 'categories', await tools.listCategories({ householdId }, auth)),
      'analytics-kpis': async () => mapAnalytics(
        'analytics-kpis',
        'analytics-kpis',
        await tools.analyticsKpis({ householdId, ...analyticsWindow() }, auth),
      ),
      'analytics-breakdown': async () => mapAnalytics(
        'analytics-breakdown',
        'analytics-breakdown',
        // `kind` is required by the route; `expense` is the read this evidence
        // answers ("para onde foi o dinheiro"), and the envelope declares it.
        await tools.analyticsCategoryBreakdown({ householdId, kind: 'expense', ...analyticsWindow() }, auth),
      ),
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
      return createEvidenceEnvelope(withWorkspaceEmptyAggregate(settled.flat()), {});
    } catch (error) {
      // A19: the rejection's OWN reason is preserved when it is typed (an
      // item that violated the contract, or a payload past the cap — both are
      // permanent failures of the projection, not transport symptoms).
      // `unavailable` stays the fallback for an untyped rejection only; the
      // previous hard-coded value erased a known fact on every path.
      return createEvidenceEnvelope([{
        ref: 'unavailable',
        source: 'tool',
        retrievedAt: now(),
        status: 'error',
        reason: resolveEnvelopeRejection(error),
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
