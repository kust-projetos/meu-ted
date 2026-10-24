/**
 * TED F1 journey harness (synthetic, local-only).
 *
 * Persistent across successive REST turns of one journey:
 * - single DatabaseSync :memory: with REAL product schemas
 *   (sessions, relay usage + attempts, mutation drafts, undo proposals,
 *   turn-audience bindings, memory/forget) so drafts/pending/intentions
 *   persist exactly as production code paths expect;
 * - single prototype-built FinanceChatAgent with stable messages array;
 * - mutable IN-MEMORY fake financial API behind requestPiApiJson;
 * - strict local fetch interception (only https://api.test.local allowlist).
 *
 * Capture rule: ConversationOrchestrator.prototype.runTurn is wrapped by
 * saving the original first and calling through (never spying routeIntent,
 * never recursing). Isolated routeIntent(text) is recorded separately so a
 * route mismatch never auto-fails user-task completion.
 *
 * No external provider/DB/production. Fake execute mutates only the
 * in-memory ledger; any receipt is labeled synthetic and is NOT proof of a
 * real financial effect.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import { ConversationOrchestrator } from '../../src/orchestration/conversation-orchestrator.js';
import type { TurnInput } from '../../src/orchestration/conversation-orchestrator.js';
import { routeIntent } from '../../src/orchestration/intent-router.js';
import * as apiClient from '../../src/tools/api-client.js';
import { currentSession, initializeSessionSchema } from '../../src/agent-config/memory/sessions.js';
import { initializeMutationDraftSchema } from '../../src/mutations/mutation-draft.js';
import { initializeUndoProposalSchema } from '../../src/mutations/undo-proposal.js';
import { initializeTurnAudienceBindingSchema } from '../../src/privacy/turn-audience-bindings.js';
import { initializeUsageAttemptSchema, initializeUsageSchema } from '../../src/safety/usage-policy.js';
import { initializeAttachmentObservabilitySchema } from '../../src/attachments/observability.js';
import { createRelayUsageStorage } from './relay-usage-storage.js';

export type FakeAccount = {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
  householdId: string;
};
export type FakeCategory = { id: string; name: string; kind: string; householdId: string };
export type FakePending = {
  id: string;
  tool: string;
  normalizedArgs: Record<string, unknown>;
  status: 'proposed' | 'confirmed' | 'cancelled' | 'succeeded';
  attestation: string | null;
  receipt: Record<string, unknown> | null;
  intentionId: string;
};

export type JourneyTurnInput = { text: string; intentionId: string };
export type JourneyTurnObservation = {
  index: number;
  text: string;
  intentionId: string;
  isolatedRoute: { mode: string; operations: string[] };
  actualPlan: { mode: string; operations: string[] } | null;
  actualPlanKinds: string[];
  runTurnCalls: number;
  httpStatus: number;
  status: string | null;
  errorCode: string | null;
  output: string | null;
  clarificationText: string | null;
  pendingStatus: string | null;
  apiReads: string[];
  apiRequests: string[];
  v2ProposalsDelta: number;
  v2DecisionsDelta: number;
  executionsDelta: number;
  /** Raw POST /pending-operations/v2/propose bodies observed in this turn (actual evidence, never null). */
  proposalArgs: Array<Record<string, unknown>>;
  /** HTTP propose attempts in this turn (counts requests even when fake dedupes to existing). */
  proposalHttpDelta: number;
  pendingSnapshot: Array<Pick<FakePending, 'id' | 'tool' | 'normalizedArgs' | 'status' | 'attestation' | 'receipt' | 'intentionId'>>;
  conversationId: string;
  unexpectedOutbound: string[];
  /** Blocked HTTP/fetch attempts rejected by the allowlist (must stay empty). */
  rejectedOutbound: string[];
  mutationStatus: string | null;
  mutationOperationId: string | null;
  mutationReceipt: Record<string, unknown> | null;
  /** Non-empty when the turn response body was not valid JSON (explicit, never silent). */
  responseParseError: string | null;
};

export type JourneyHarness = {
  agent: object;
  runTurns: (turns: JourneyTurnInput[]) => Promise<JourneyTurnObservation[]>;
  setAuditItems: (items: Array<Record<string, unknown>>) => void;
  setProviderFailure: (failure: { status: number; code: string } | null) => void;
  setSyntheticRelayText: (text: string | null) => void;
  fake: {
    accounts: FakeAccount[];
    categories: FakeCategory[];
    pendings: Map<string, FakePending>;
    auditItems: Array<Record<string, unknown>>;
    executions: Array<{ operationId: string; receipt: unknown }>;
  };
  counts: () => { apiReads: string[]; apiRequests: string[]; v2Proposals: number; v2Decisions: number; executions: number };
  close: () => void;
};

const API_ORIGIN = 'https://api.test.local';

const readCapabilityPaths: Record<string, string> = {
  list_accounts: '/accounts',
  list_categories: '/categories',
  list_recent_transactions: '/transactions?limit=20',
  get_balance: '/accounts',
  get_month_summary: '/dashboard/month-summary',
  list_cards: '/cards/accounts',
  list_statements: '/cards/statements',
  list_accounts_payable: '/payables',
  list_budgets: '/budgets',
  check_budgets: '/budgets/check',
  analytics_category_breakdown: '/analytics/category-breakdown',
  analytics_kpis: '/analytics/kpis',
  spending_insights: '/insights/spending',
};

export const isAllowedJourneyApiRequest = (method: string, fullPath: string): boolean => {
  const verb = method.toUpperCase();
  const allowlist = new Set([
    'GET /accounts', 'GET /categories', 'GET /transactions', 'GET /transactions?limit=200&offset=0',
    'GET /dashboard/month-summary', 'GET /cards/accounts', 'GET /cards/statements', 'GET /payables',
    'GET /budgets', 'GET /budgets/check', 'GET /analytics/category-breakdown', 'GET /analytics/kpis',
    'GET /insights/spending', 'GET /pending-operations/v2/active', 'GET /audit-logs?limit=50',
    'POST /pending-operations/v2/propose', 'POST /pending-operations/v2/confirmation-intentions/bind',
  ]);
  if (allowlist.has(`${verb} ${fullPath}`)) return true;
  if (verb === 'GET' && fullPath.startsWith('/pending-operations/v2/') && fullPath.endsWith('/outcome')) return true;
  if (verb === 'POST' && /^\/pending-operations\/v2\/[^/]+\/(authorize|confirm|execute|cancel|retry)$/.test(fullPath)) return true;
  if (verb !== 'GET' || !fullPath.includes('?')) return false;
  const url = new URL(fullPath, 'https://f1.invalid');
  if (url.pathname === '/transactions') {
    const keys = [...url.searchParams.keys()].sort();
    const allowedKeys = new Set(['limit', 'offset', 'accountId', 'startDate', 'endDate', 'categoryId', 'kind']);
    return url.searchParams.size > 0 && keys.every((k) => allowedKeys.has(k));
  }
  if (url.pathname === '/dashboard/month-summary') {
    const keys = [...url.searchParams.keys()];
    return keys.length === 1 && keys[0] === 'yearMonth';
  }
  return false;
};

export function createJourneyHarness(seed: { accounts?: FakeAccount[]; categories?: FakeCategory[] } = {}): JourneyHarness {
  const sessionDb = new DatabaseSync(':memory:');
  const usageStorage = createRelayUsageStorage();
  const sql = {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> {
      const lowered = query.toLowerCase();
      if (lowered.includes('agent_sessions')) {
        const statement = sessionDb.prepare(query);
        if (/^\s*(select|pragma|with)/i.test(query) || /\breturning\b/i.test(query)) return statement.all(...(bindings as SQLInputValue[])) as T[];
        statement.run(...(bindings as SQLInputValue[]));
        return [] as T[];
      }
      if (lowered.includes('usage_ledger') || lowered.includes('usage_attempts') || lowered.includes('mutation_confirmations')) {
        return usageStorage.exec<T>(query, ...(bindings as []));
      }
      const statement = sessionDb.prepare(query);
      if (/^\s*(select|pragma|with)/i.test(query) || /\breturning\b/i.test(query)) return statement.all(...(bindings as SQLInputValue[])) as T[];
      statement.run(...(bindings as SQLInputValue[]));
      return [] as T[];
    },
  };
  const txSql = sql as unknown as Parameters<typeof initializeSessionSchema>[0];
  initializeSessionSchema(txSql);
  initializeUsageSchema(txSql as never);
  initializeUsageAttemptSchema(txSql as never);
  initializeMutationDraftSchema(sql);
  initializeUndoProposalSchema(sql as never);
  initializeTurnAudienceBindingSchema(txSql);
  initializeAttachmentObservabilitySchema(sql);

  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as {
    messages: UIMessage[];
    persistMessages: (messages: UIMessage[]) => Promise<void>;
  };
  agent.messages = persisted;
  agent.persistMessages = vi.fn(async (messages: UIMessage[]) => { persisted.push(...messages); });
  Object.defineProperty(agent, 'ctx', {
    value: {
      storage: {
        sql: { exec: sql.exec.bind(sql) },
        transactionSync: <T>(fn: () => T): T => fn(),
      },
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
  Object.defineProperty(agent, 'env', {
    value: {
      API_ORIGIN,
      AGENT_RUNTIME_ADMIN_TOKEN: 'synthetic-admin-token',
      AGENT_CONFIG_TOKEN: 'synthetic-config-token',
      AGENT_DELEGATION_SECRET: 'synthetic-agent-delegation-secret-at-least-32-chars',
    },
    writable: true,
    configurable: true,
  });

  const fake = {
    accounts: [...(seed.accounts ?? [])],
    categories: [...(seed.categories ?? [])],
    pendings: new Map<string, FakePending>(),
    auditItems: [] as Array<Record<string, unknown>>,
    executions: [] as Array<{ operationId: string; receipt: unknown }>,
  };
  let pendingSeq = 0;
  const proposeByIdempotencyKey = new Map<string, string>();
  let providerFailure: { status: number; code: string } | null = null;
  let syntheticRelayText: string | null = null;
  const apiReads: string[] = [];
  const apiRequests: string[] = [];
  let v2Proposals = 0;
  let v2Decisions = 0;
  let runTurnObservations: Array<{ input: unknown; plan: unknown; result: unknown }> = [];
  const unexpectedOutbound: string[] = [];
  const rejectedOutbound: string[] = [];
  /** Parallel to apiRequests: raw opts.body record (or null for reads) for strict proposal evidence. */
  const requestBodies: Array<Record<string, unknown> | null> = [];
  const conversationId = 'f1-journey-conv-stable';

  // Capture WITHOUT touching routeIntent: wrap the original once per harness.
  const originalRunTurn = ConversationOrchestrator.prototype.runTurn;
  const runTurnSpy = vi.spyOn(ConversationOrchestrator.prototype, 'runTurn').mockImplementation(async function (this: ConversationOrchestrator, input: TurnInput) {
    const before = (this as unknown as { unpublishedPresentationLedger?: unknown[] }).unpublishedPresentationLedger?.length ?? 0;
    void before;
    const result = await originalRunTurn.call(this, input);
    runTurnObservations.push({
      input: { text: (input as { text?: unknown }).text, intentionId: (input as { intentionId?: unknown }).intentionId },
      plan: (result as { plan?: unknown }).plan,
      result: { status: (result as { status?: unknown }).status, mutation: (result as { mutation?: unknown }).mutation },
    });
    return result;
  });

  const requestSpy = vi.spyOn(apiClient, 'requestPiApiJson').mockImplementation(async (method, path, opts) => {
    const requestMethod = String(method).toUpperCase();
    const requestPath = String(path);
    const query = ((opts?.query ?? {}) as Record<string, unknown>);
    const querySuffix = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`).join('&');
    const fullPath = requestPath.includes('?') || !querySuffix ? requestPath : `${requestPath}?${querySuffix}`;
    const requestKey = `${requestMethod} ${fullPath}`;
    if (!isAllowedJourneyApiRequest(requestMethod, fullPath)) { unexpectedOutbound.push(`API ${requestKey}`); rejectedOutbound.push(`API ${requestKey}`); throw new Error(`F1 journey API contract blocked: ${requestKey}`); }
    apiRequests.push(requestKey);
    requestBodies.push(opts?.body !== undefined && typeof opts.body === 'object' ? { ...(opts.body as Record<string, unknown>) } : null);
    const pathOnly = fullPath.split('?')[0]!;
    if (requestMethod === 'GET') apiReads.push(requestKey);
    if (pathOnly === '/pending-operations/v2/propose') {
      const idempotencyKey = String((opts as { idempotencyKey?: unknown } | undefined)?.idempotencyKey ?? '');
      if (idempotencyKey && proposeByIdempotencyKey.has(idempotencyKey)) {
        // SPEC Ãƒâ€šÃ‚Â§7.7.1 redelivery: same (key, payload) returns the existing
        // operation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never a second pending. Not counted as a new proposal.
        return { id: proposeByIdempotencyKey.get(idempotencyKey)!, existing: true } as never;
      }
      v2Proposals += 1;
      pendingSeq += 1;
      const body = (opts?.body ?? {}) as { tool?: unknown; normalizedArgs?: Record<string, unknown> };
      const id = `synthetic-pending-j${pendingSeq}`;
      fake.pendings.set(id, {
        id,
        tool: String(body.tool ?? 'unknown.tool'),
        normalizedArgs: { ...(body.normalizedArgs ?? {}) },
        status: 'proposed',
        attestation: null,
        receipt: null,
        intentionId: String((opts?.headers as Record<string, unknown> | undefined)?.['x-intention-id'] ?? `journey-${pendingSeq}`),
      });
      if (idempotencyKey) proposeByIdempotencyKey.set(idempotencyKey, id);
      return { id } as never;
    }
    if (pathOnly === '/pending-operations/v2/confirmation-intentions/bind') {
      const body = (opts?.body ?? {}) as { intentionId?: unknown };
      const intentionId = String(body.intentionId ?? '');
      for (const pending of fake.pendings.values()) {
        if (pending.intentionId === intentionId) return { firstSeenAt: new Date(0).toISOString(), fresh: false, operationId: pending.id } as never;
      }
      return { firstSeenAt: new Date().toISOString(), fresh: true, operationId: null } as never;
    }
    const activeMatch = /^\/pending-operations\/v2\/([^/]+)\/(authorize|confirm|execute|cancel|retry)$/.exec(pathOnly);
    if (activeMatch) {
      const [, operationId, leg] = activeMatch;
      const pending = fake.pendings.get(operationId);
      if (!pending) throw Object.assign(new Error('approval.not_found'), { code: 'approval.not_found', statusCode: 404 });
      if (leg === 'authorize') {
        v2Decisions += 1;
        throw Object.assign(new Error('approval.autoexecute_disabled'), { code: 'approval.autoexecute_disabled', statusCode: 403 });
      }
      if (leg === 'confirm') {
        v2Decisions += 1;
        pending.status = 'confirmed';
        pending.attestation = `synthetic-attestation-${operationId}-0123456789`;
        return { id: operationId, attestation: pending.attestation } as never;
      }
      if (leg === 'execute') {
        pending.status = 'succeeded';
        const receipt = { operationId, entity: { id: `synthetic-entity-${operationId}` }, synthetic: true };
        pending.receipt = receipt;
        fake.executions.push({ operationId, receipt });
        return { status: 'succeeded', operationId, receipt } as never;
      }
      if (leg === 'cancel') {
        pending.status = 'cancelled';
        return { id: operationId, status: 'cancelled' } as never;
      }
      if (leg === 'retry') {
        pending.status = 'confirmed';
        pending.attestation = `synthetic-attestation-${operationId}-retry-0123456789`;
        return { id: operationId, attestation: pending.attestation } as never;
      }
    }
    if (pathOnly === '/pending-operations/v2/active') {
      const items = [...fake.pendings.values()].filter((p) => p.status === 'proposed' || p.status === 'confirmed')
        .map((p) => ({ id: p.id, status: p.status, tool: p.tool, createdAt: new Date(0).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...p.normalizedArgs }));
      return { items, total: items.length } as never;
    }
    if (pathOnly.endsWith('/outcome')) return { status: fake.pendings.get(pathOnly.split('/')[3]!)?.status ?? 'unknown' } as never;
    if (pathOnly === '/accounts') return { items: fake.accounts, total: fake.accounts.length } as never;
    if (pathOnly === '/categories') return { items: fake.categories, total: fake.categories.length } as never;
    if (pathOnly === '/transactions') return { items: [], total: 0, limit: Number(query.limit ?? 20), offset: Number(query.offset ?? 0) } as never;
    if (pathOnly === '/dashboard/month-summary') return { summary: { totalCents: 0, incomeCents: 0, expenseCents: 0 }, yearMonth: String(query.yearMonth ?? '2026-10'), basis: 'synthetic-empty' } as never;
    if (['/cards/accounts', '/cards/statements', '/payables', '/budgets', '/budgets/check', '/analytics/category-breakdown', '/analytics/kpis', '/insights/spending', '/audit-logs'].includes(pathOnly)) {
      if (pathOnly === '/audit-logs') return { items: fake.auditItems, total: fake.auditItems.length } as never;
      return { items: [], total: 0 } as never;
    }
    throw new Error(`F1 journey fake has no fixture response: ${requestKey}`);
  });

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const fetchMethod = String(init?.method ?? 'GET').toUpperCase();
    if (url.origin !== API_ORIGIN) { rejectedOutbound.push(`FETCH ${fetchMethod} ${url.origin}${url.pathname}`); throw Object.assign(new Error(`F1 journey outbound blocked: ${url.origin}`), { statusCode: 500 }); }
    if (url.pathname === '/internal/agent/llm-config' && fetchMethod === 'GET') {
      return Response.json({
        runtime: { singleton: 'active', version: 3, securityEpoch: 1, activeProviderId: 'opencode-zen', activeModelId: 'opencode-zen:zen-free-model', activeProtocol: 'chat-completions', activeRolloutPercentage: 100, activeRolloutMode: 'all', fallbackProviderId: null, fallbackModelId: null, updatedBy: null },
        activeProvider: null, activeModel: null, fallbackProvider: null, fallbackModel: null, activeDisabled: false, fallbackDisabled: false,
      });
    }
    if (url.pathname === '/internal/agent/llm-relay' && fetchMethod === 'POST') {
      if (providerFailure) return Response.json({ code: providerFailure.code, message: 'synthetic provider failure', providerAttempted: false }, { status: providerFailure.status });
      return Response.json({ text: syntheticRelayText ?? '[F1 bounded synthetic relay output; not a product/model evaluation]', providerAttempted: true });
    }
    if (url.pathname === '/transactions/detect-duplicate' && fetchMethod === 'POST') {
      apiRequests.push(`${fetchMethod} ${url.pathname}`);
      requestBodies.push(null);
      return Response.json({ duplicate_detected: false });
    }
    rejectedOutbound.push(`FETCH ${fetchMethod} ${url.pathname}`);
    throw new Error(`F1 journey fetch allowlist did not dispatch ${fetchMethod} ${url.pathname}`);
  });

  const runTurns = async (turns: JourneyTurnInput[]): Promise<JourneyTurnObservation[]> => {
    const observations: JourneyTurnObservation[] = [];
    // Seed a durable open session once per journey (stable conversationId);
    // explicit best-effort: session seed must never fail the turn.
    try {
      currentSession(sql as never, 'f1-synthetic-workspace', 'f1-synthetic-actor', {
        ownerActorId: 'f1-synthetic-actor',
        conversationId,
      });
    } catch (seedError) {
      unexpectedOutbound.push(`SESSION-SEED ${seedError instanceof Error ? seedError.message : String(seedError)}`);
    }
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]!;
      const isolated = routeIntent(turn.text);
      const beforeProposals = v2Proposals;
      const beforeDecisions = v2Decisions;
      const beforeExecutions = fake.executions.length;
      const beforeReads = apiReads.length;
      const beforeRequests = apiRequests.length;
      const beforeRunTurn = runTurnObservations.length;
      const response: Response = await (agent as unknown as { fetch: (request: Request) => Promise<Response> }).fetch(new Request('https://agent.test.local/rpc/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-actor': 'f1-synthetic-actor',
          'x-agent-workspace': 'f1-synthetic-workspace',
          'x-agent-device': 'f1-synthetic-device',
        },
        body: JSON.stringify({ text: turn.text, intentionId: turn.intentionId }),
      }));
      let body: { status?: unknown; code?: unknown; output?: unknown; clarification?: unknown; pendingOperation?: { status?: unknown } | null } = {};
      let responseParseError: string | null = null;
      try {
        body = await response.json() as typeof body;
      } catch (parseError) {
        // Explicit: non-JSON turn body is recorded, never silently replaced.
        responseParseError = parseError instanceof Error ? parseError.message : String(parseError);
        body = {};
      }
      const captured = runTurnObservations.slice(beforeRunTurn);
      const lastPlan = captured.length ? (captured[captured.length - 1]!.plan as { mode?: unknown; requestedOperations?: Array<{ name?: unknown; kind?: unknown }> } | undefined) : undefined;
      const lastResult = captured.length ? (captured[captured.length - 1]!.result as { status?: unknown; mutation?: { operationId?: unknown; status?: unknown; receipt?: unknown } } | undefined) : undefined;
      const planOps = Array.isArray(lastPlan?.requestedOperations) ? lastPlan.requestedOperations.map((o) => String(o.name)) : [];
      const planKinds = Array.isArray(lastPlan?.requestedOperations) ? lastPlan.requestedOperations.map((o) => String(o.kind)) : [];
      const freshReads = apiReads.slice(beforeReads);
      const freshRequests = apiRequests.slice(beforeRequests);
      const freshBodies = requestBodies.slice(beforeRequests, apiRequests.length);
      const proposalHttpDelta = freshRequests.filter((request) => request === 'POST /pending-operations/v2/propose').length;
      const proposalArgs: Array<Record<string, unknown>> = [];
      freshRequests.forEach((request, offset) => {
        if (request === 'POST /pending-operations/v2/propose') {
          const raw = freshBodies[offset];
          proposalArgs.push(raw !== null && raw !== undefined ? { ...raw } : {});
        }
      });
      const mutationStatus = typeof lastResult?.mutation === 'object' && lastResult.mutation !== null
        ? String((lastResult.mutation as { status?: unknown }).status ?? '') || null : null;
      const mutationOperationId = typeof lastResult?.mutation === 'object' && lastResult.mutation !== null
        ? String((lastResult.mutation as { operationId?: unknown }).operationId ?? '') || null : null;
      const mutationReceipt = typeof lastResult?.mutation === 'object' && lastResult.mutation !== null
        && typeof (lastResult.mutation as { receipt?: unknown }).receipt === 'object'
        && (lastResult.mutation as { receipt?: unknown }).receipt !== null
        ? { ...((lastResult.mutation as { receipt?: unknown }).receipt as Record<string, unknown>) } : null;
      const clarificationText = typeof body.clarification === 'string'
        ? body.clarification
        : typeof body.output === 'string' && /\?|informe|me diga|qual |quais |especifique|escolha/i.test(body.output) ? body.output : null;
      observations.push({
        index,
        text: turn.text,
        intentionId: turn.intentionId,
        isolatedRoute: { mode: isolated.mode, operations: isolated.requestedOperations.map((o) => o.name) },
        actualPlan: lastPlan ? { mode: String(lastPlan.mode), operations: planOps } : null,
        actualPlanKinds: planKinds,
        runTurnCalls: captured.length,
        httpStatus: response.status,
        status: typeof body.status === 'string' ? body.status : null,
        errorCode: typeof body.code === 'string' ? body.code : null,
        output: typeof body.output === 'string' ? body.output.slice(0, 400) : null,
        clarificationText,
        pendingStatus: typeof body.pendingOperation?.status === 'string' ? body.pendingOperation.status : null,
        apiReads: [...freshReads],
        apiRequests: [...freshRequests],
        v2ProposalsDelta: v2Proposals - beforeProposals,
        v2DecisionsDelta: v2Decisions - beforeDecisions,
        executionsDelta: fake.executions.length - beforeExecutions,
        proposalArgs,
        proposalHttpDelta,
        pendingSnapshot: [...fake.pendings.values()].map((pending) => ({ id: pending.id, tool: pending.tool, normalizedArgs: { ...pending.normalizedArgs }, status: pending.status, attestation: pending.attestation, receipt: pending.receipt ? { ...(pending.receipt as Record<string, unknown>) } : null, intentionId: pending.intentionId })),
        conversationId,
        unexpectedOutbound: [...unexpectedOutbound],
        rejectedOutbound: [...rejectedOutbound],
        mutationStatus,
        mutationOperationId,
        mutationReceipt,
        responseParseError,
      });
    }
    return observations;
  };

  return {
    agent,
    runTurns,
    setAuditItems: (items) => { fake.auditItems = [...items]; },
    setProviderFailure: (failure) => { providerFailure = failure; },
    setSyntheticRelayText: (text) => { syntheticRelayText = text; },
    fake,
    counts: () => ({ apiReads: [...apiReads], apiRequests: [...apiRequests], v2Proposals, v2Decisions, executions: fake.executions.length, rejected: [...rejectedOutbound], unexpected: [...unexpectedOutbound] }),
    close: () => {
      requestSpy.mockRestore();
      fetchSpy.mockRestore();
      runTurnSpy.mockRestore();
      sessionDb.close();
    },
  };
}

export { readCapabilityPaths };
