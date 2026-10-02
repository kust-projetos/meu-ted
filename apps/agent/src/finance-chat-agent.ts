import { AIChatAgent, type UIMessage } from "agents/ai-chat-agent";
import { streamText, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { protocolSchema } from "@pi-finance/llm-contracts/schemas";
import { mutationReceiptSchema, pendingOperationPresentationSchema } from "@pi-finance/llm-contracts";
import { fetchRuntimeConfig, type RuntimeSnapshot } from "./llm/runtime-config-client.js";
import { createLanguageModel } from "./llm/model-factory.js";
import type { Protocol } from "./llm/provider-registry.js";
import { logFailoverEvent } from "./llm/failover.js";
import { executeBrokerCompletion } from "./llm/private-broker-client.js";
import {
  assembleCognition,
  buildExposedTools,
  INSTRUCTIONS_VERSION as TED_INSTRUCTIONS_VERSION,
  TED_SYSTEM_PROMPT_LEGACY,
  initializeMemorySchema,
  initializeSessionSchema,
  isMemoryEnabled,
  recallMemories,
  renderMemoryBlock,
  compactContext,
  extractiveSummary,
  toContextTurns,
  learnFromTurn,
  buildMemoryTools,
  bumpTurnCount,
  rememberFact,
  isProhibitedFinancialMemory,
  setMemoryEnabled,
  currentSession,
  endSession,
  type MemorySql,
} from "./agent-config/index.js";
import {
  checkUsageLimit,
  DEFAULT_POLICY,
  estimateTokens,
  finalizeUsageAttempt,
  initializeUsageAttemptSchema,
  initializeUsageSchema,
  recordUsage,
  releaseUsageAttempt,
  reserveUsageAttempt,
} from "./safety/usage-policy.js";
import { redactTranscript } from "./transcript-safety.js";
import { scrubAttachments, scrubForPersistence } from "./privacy/dlp.js";
import {
  migrateLegacyHistory,
  type LegacyFullExport,
  type MigrationResult,
  type SdkUIMessage,
} from "./migration/legacy-history.js";
import { requestPiApiJson } from "./tools/api-client.js";
import { createDelegatedTurnToken } from "./delegated-token.js";
import { detectDuplicateSuspectedStrict } from './tools/duplicate-detector.js';
import { verifyAgentConnectionToken } from "./auth/connection-token.js";
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  normalizeSdkTurn,
  type AuthenticatedIdentity,
  type TurnInput,
  type TurnPlan,
} from "./orchestration/conversation-orchestrator.js";
import { classifyError, emitSanitizedEvent } from "./observability/events.js";
import { routeIntent } from "./orchestration/intent-router.js";
import { createChannelGrounding } from "./orchestration/channel-evidence.js";
import type { EvidenceEnvelope } from "./evidence/evidence-envelope.js";
import { parseFinancialMutation, isClearlyMutating } from "./mutations/financial-parser.js";
import { toActiveOperationRecords } from "./mutations/active-operation-projection.js";
import { createRequestEntityReader, type EntityReader } from "./mutations/entity-resolver.js";
import { MutationApiClient } from "./mutations/mutation-api-client.js";
import { PendingOperationCoordinator, isRetryText } from "./orchestration/pending-operation-coordinator.js";
import { initializeMutationDraftSchema, SqlMutationDraftStore, hasRecoverableDraft } from "./mutations/mutation-draft.js";
import {
  initializeUndoProposalSchema,
  SqlUndoProposalStore,
  UndoProposalService,
  UNDO_DELEGATED_CAPABILITY,
  UNDO_UUID_RE,
  UNDO_VERIFY_READ_CAPABILITY,
  type UndoIdentity,
} from "./mutations/undo-proposal.js";

export type Env = {
  AGENT_DELEGATION_SECRET?: string;
  AGENT_CONNECTION_TOKEN_SECRET?: string;
  AGENT_CONFIG_TOKEN?: string;
  AGENT_RUNTIME_ADMIN_TOKEN?: string;
  AGENT_RELAY_TIMEOUT_MS?: string | number;
  OPENCODE_ZEN_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
  OPENAI_API_KEY?: string;
  API_ORIGIN?: string;
  CODEX_BROKER_ORIGIN?: string;
  CODEX_BROKER_ACCESS_CLIENT_ID?: string;
  CODEX_BROKER_ACCESS_CLIENT_SECRET?: string;
  CODEX_BROKER_REQUEST_SIGNING_KEY?: string;
  TAVILY_API_KEY?: string;
  BRAVE_API_KEY?: string;
};

/**
 * FIX-FINAL-2 FINDING 2 (defense in depth): semantic ceilings for the
 * /rpc/chat ingress. The gateway (worker.ts) already rejects bodies above
 * MAX_RPC_BODY_BYTES with 413 before forwarding; these caps keep a single
 * turn cheap even for callers that reach the DO directly. Chat turns carry
 * short text plus metadata-only attachments — never bulk content.
 */
export const MAX_CHAT_TEXT_CHARS = 32_000;
export const MAX_CHAT_ATTACHMENTS = 10;

export type IntentionSnapshotRow = {
  intention_id: string;
  version: number;
  provider_id: string;
  model_id: string;
  protocol: string;
  rollout_percentage: number;
  security_epoch: number;
  fallback_provider_id?: string | null;
  fallback_model_id?: string | null;
  /**
   * Bare upstream model name (no `provider_id:` prefix) for direct execution.
   * `model_id` is the store row id (configuration reference); the upstream
   * provider API expects the bare name from the validated slot. Legacy rows
   * predate this column and read back as null (derived at use time).
   */
  model_name?: string | null;
  fallback_model_name?: string | null;
  created_at: string;
};

export const INTENTION_SNAPSHOT_FALLBACK_COLUMNS = ['fallback_provider_id', 'fallback_model_id'] as const;

/** Fase 3 item 5: bare upstream names persisted alongside the row ids. */
export const INTENTION_SNAPSHOT_MODEL_COLUMNS = ['model_name', 'fallback_model_name'] as const;

import { executeLlmAttempts, isCodexProviderId, resolveBareModelName } from "./llm/attempts.js";
import {
  RELAY_ATTEMPT_TIMEOUT_MS,
  executeRelayAttempts,
  isRelayableProvider,
  logRelayDoubleFailure,
  resolveRelayTargets,
  sanitizeRelayCode,
  relayPublicMessage,
} from "./llm/relay-failover.js";
import { authorizeTurnExecution } from "./llm/rollout.js";
// Re-exported so existing import sites (tests, compat) keep working —
// the canonical definitions live in llm/attempts.ts (H-02 executor).
export { isCodexProviderId, resolveBareModelName } from "./llm/attempts.js";

/**
 * Fase 3-FIX R2: local persisted rows are validated with the same
 * contract/invariants as the remote snapshot before execution. Corrupted
 * rows are discarded (miss → remote refetch), never executed.
 */
export const intentionSnapshotRowSchema = z.object({
  intention_id: z.string().min(1),
  version: z.number(),
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  protocol: protocolSchema,
  rollout_percentage: z.number(),
  security_epoch: z.number(),
  fallback_provider_id: z.string().nullable().optional(),
  fallback_model_id: z.string().nullable().optional(),
  model_name: z.string().min(1).nullable().optional(),
  fallback_model_name: z.string().min(1).nullable().optional(),
  created_at: z.string(),
});

/**
 * Backfills the fallback columns on pre-existing Durable Object tables.
 * CREATE TABLE IF NOT EXISTS never upgrades legacy tables, so missing
 * columns are added explicitly (PRAGMA first, so concurrent initializers
 * and mock storage without PRAGMA support stay safe).
 */
export const ensureIntentionSnapshotColumns = (sql: {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
}): void => {
  let existing: Set<string> | null = null;
  try {
    const rows = [...sql.exec<{ name: string }>(`PRAGMA table_info(intention_snapshots)`)];
    existing = new Set(rows.map((row) => row.name));
  } catch {
    // PRAGMA unsupported here (e.g. mock storage): skip structural ADDs,
    // but still attempt the idempotent value backfill below.
  }
  if (existing) {
    for (const column of [...INTENTION_SNAPSHOT_FALLBACK_COLUMNS, ...INTENTION_SNAPSHOT_MODEL_COLUMNS]) {
      if (!existing.has(column)) {
        try {
          sql.exec(`ALTER TABLE intention_snapshots ADD COLUMN ${column} TEXT`);
        } catch {
          // A concurrent initializer won the race; the column now exists.
        }
      }
    }
  }
  // Fase 3-FIX R2: structural backfill — fill names derivable from
  // conventional `provider_id:model_id` row ids. Opaque ids are left NULL
  // on purpose (fail-closed at use, never guessed). Idempotent and scoped
  // to NULL cells only, so concurrent writers cannot clobber real names.
  for (const [nameColumn, idColumn, providerColumn] of [
    ['model_name', 'model_id', 'provider_id'],
    ['fallback_model_name', 'fallback_model_id', 'fallback_provider_id'],
  ] as const) {
    try {
      sql.exec(
        `UPDATE intention_snapshots SET ${nameColumn} = SUBSTR(${idColumn}, LENGTH(${providerColumn}) + 2) WHERE ${nameColumn} IS NULL AND ${idColumn} LIKE ${providerColumn} || ':%'`,
      );
    } catch {
      // Best effort: ancient tables without the id column, or a concurrent
      // migration, must never break initialization.
    }
  }
};

export type CodexBrokerEnv = {
  CODEX_BROKER_ORIGIN?: string;
  CODEX_BROKER_ACCESS_CLIENT_ID?: string;
  CODEX_BROKER_ACCESS_CLIENT_SECRET?: string;
  CODEX_BROKER_REQUEST_SIGNING_KEY?: string;
};

export const runCodexBrokerText = async (
  env: CodexBrokerEnv,
  input: {
    model: string;
    prompt: string;
    system: string;
    requestId: string;
    intentionId: string;
    workspaceId: string;
    actorId: string;
  },
): Promise<string> => {
  const brokerOrigin = env.CODEX_BROKER_ORIGIN ?? '';
  const signingKey = env.CODEX_BROKER_REQUEST_SIGNING_KEY ?? '';
  if (!brokerOrigin || !signingKey) {
    throw Object.assign(new Error('Codex broker not configured'), { code: 'agent.provider_not_configured', status: 503 });
  }
  const result = await executeBrokerCompletion(
    {
      brokerOrigin,
      ...(env.CODEX_BROKER_ACCESS_CLIENT_ID ? { cfAccessClientId: env.CODEX_BROKER_ACCESS_CLIENT_ID } : {}),
      ...(env.CODEX_BROKER_ACCESS_CLIENT_SECRET ? { cfAccessClientSecret: env.CODEX_BROKER_ACCESS_CLIENT_SECRET } : {}),
      signingKey,
    },
    {
      model: input.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      requestId: input.requestId,
      intentionId: input.intentionId,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
    },
  );
  const text = result.choices[0]?.message?.content ?? '';
  if (!text) throw Object.assign(new Error('No output generated by provider.'), { code: 'agent.inference_error', status: 502 });
  return text;
};

export const TED_SYSTEM_PROMPT = TED_SYSTEM_PROMPT_LEGACY;
export { TED_INSTRUCTIONS_VERSION };

/**
 * Item 6 (Onda 2): relay fetch with ONE absolute deadline over headers AND
 * body parsing. Uses the existing per-leg budget (RELAY_ATTEMPT_TIMEOUT_MS,
 * 60 s — no increase, no timer reset between headers/body). The abort signal
 * is sent at the deadline, and the outer Promise.race forces finite
 * termination even when the fetch implementation or `response.json()`
 * ignores abort. Late headers/body after the deadline can never become
 * success (the race already settled with the timeout). Timers are cleared in
 * `finally` so ordinary fast success preserves content with no leak.
 *
 * The timeout surfaces as a bare `TimeoutError` (no status/code) so the
 * existing relay classifier maps it to the coherent `agent.provider_timeout`
 * + 504 via `toSafeRelayError`, keeping failover eligibility intact.
 *
  * FIX-W2-AGENT-LATE-RESPONSE-AND-BROKER-ERROR: a delayed event loop can let
  * headers/body resolve after the absolute deadline but before the timer
  * callback fires — the race alone would then accept a late success. The
  * monotonic `now()` check after each stage fails closed with the same bare
  * `TimeoutError` even when the timer has not fired yet. Production default
  * is `performance.now()` (monotonic, bounded); tests may inject a fake
  * clock via `opts.now`.
  *
  * FIX-AGENT-RELAY-DISCARDED-BODY-CANCEL: every timeout/discard branch also
  * best-effort cancels `response.body` without awaiting (sync throws and
  * rejected cancels swallowed, so a locked stream never delays the 504), and
  * a late fetch fulfillment after the race observes the timedOut/expired
  * clock and cancels its own body. Fast success never cancels.
 */
const defaultRelayMonotonicNow = (): number => {
  try {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    if (perf && typeof perf.now === 'function') return perf.now();
  } catch {
    // Fall through to the wall clock below.
  }
  return Date.now();
};

const relayTimeoutError = (timeoutMs: number): Error =>
  Object.assign(new Error(`relay attempt timed out after ${timeoutMs}ms`), { name: 'TimeoutError' });

/**
 * FIX-AGENT-RELAY-DISCARDED-BODY-CANCEL (item 6 resource cleanup): best-effort
 * discard of a relay Response body. Never awaited, never blocks the timeout
 * path: a locked body (cancel throws synchronously) or a rejected cancel
 * promise is swallowed. Called only on timeout/discard branches — the fast
 * success path never cancels. Mirrors `cancelBrokerResponseBody`.
 */
const cancelRelayResponseBody = (res: Response | undefined): void => {
  try {
    const body = (res as { body?: { cancel?: () => unknown } } | undefined)?.body;
    if (!body || typeof body.cancel !== 'function') return;
    const result = body.cancel() as unknown;
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {});
    }
  } catch {
    // Best effort: a locked body must not block the timeout.
  }
};

/**
 * Test seam for the per-leg relay budget. Production default is
 * RELAY_ATTEMPT_TIMEOUT_MS (60 s). `AGENT_RELAY_TIMEOUT_MS` (string or
 * number) may only SHORTEN the budget — values at/above the default clamp
 * to the default, so the platform budget can never be increased here.
 */
export const resolveRelayLegTimeoutMs = (env: Env | undefined): number => {
  const raw = (env as Record<string, unknown> | undefined)?.['AGENT_RELAY_TIMEOUT_MS'];
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (Number.isFinite(n) && (n as number) > 0) {
    return Math.min(Math.trunc(n as number), RELAY_ATTEMPT_TIMEOUT_MS);
  }
  return RELAY_ATTEMPT_TIMEOUT_MS;
};

export const fetchRelayJsonWithDeadline = async (
  fetchImpl: typeof fetch,
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number = RELAY_ATTEMPT_TIMEOUT_MS,
  opts?: { now?: () => number },
): Promise<{
  ok: boolean;
  status: number;
  body: { text?: unknown; code?: unknown; message?: unknown; providerAttempted?: unknown; usage?: unknown };
}> => {
  const now = opts?.now ?? defaultRelayMonotonicNow;
  const start = now();
  const deadlineAt = start + timeoutMs;
  const isExpired = (): boolean => now() >= deadlineAt;
  const controller = new AbortController();
  // FIX-AGENT-RELAY-DISCARDED-BODY-CANCEL: timedOut flag + currently seen
  // response, so the deadline path can best-effort cancel the body without
  // awaiting, and a late fetch fulfillment after the race can observe the
  // timeout/expired monotonic clock and discard its own body.
  let timedOut = false;
  let seenResponse: Response | undefined;
  // The timer callback and the race-settlement branches can both observe the
  // same timeout (timer fires while .json() is pending): discard the known
  // body exactly once — cancel itself is idempotent, but one attempt keeps
  // the timeout path deterministic. The late-fulfillment handler below marks
  // the same flag after its direct cancel, so the post-race expired branch
  // for the SAME late response skips its second cancel (mirrors the broker
  // handler; a timer discard with no body yet still lets the late arrival
  // cancel exactly once here).
  let bodyDiscardAttempted = false;
  const discardBodyOnce = (res: Response | undefined): void => {
    if (bodyDiscardAttempted) return;
    bodyDiscardAttempted = true;
    cancelRelayResponseBody(res);
  };
  const abortAndDiscard = (res: Response | undefined): void => {
    try {
      controller.abort();
    } catch {
      // Best effort: the race below still enforces the deadline.
    }
    discardBodyOnce(res);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abortAndDiscard(seenResponse);
      reject(relayTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    const fetchPromise = fetchImpl(url, { ...init, signal: controller.signal });
    // Late headers arriving after the race already settled with the timeout:
    // observe the timeout/expired clock and cancel the late body. Late data
    // is never accepted (the race already rejected).
    void Promise.resolve(fetchPromise).then(
      (late) => {
        const lateRes = late as unknown as Response | undefined;
        if (lateRes && typeof lateRes === 'object') seenResponse ??= lateRes;
        // Mark the discard so the post-race expired branch for the SAME
        // late response does not cancel a second time (spy counts); a late
        // body arriving after the race already timed out is still canceled
        // exactly once here. Mirrors the broker late-headers handler.
        if (timedOut || isExpired()) {
          cancelRelayResponseBody(lateRes);
          bodyDiscardAttempted = true;
        }
      },
      () => {},
    );
    const response = (await Promise.race([
      fetchPromise,
      deadline,
    ])) as unknown as Response;
    seenResponse = response;
    if (timedOut || isExpired()) {
      abortAndDiscard(response);
      throw relayTimeoutError(timeoutMs);
    }
    let body: { text?: unknown; code?: unknown; message?: unknown; providerAttempted?: unknown; usage?: unknown };
    try {
      body = (await Promise.race([
        Promise.resolve(response.json()).catch(() => ({})),
        deadline,
      ])) as { text?: unknown; code?: unknown; message?: unknown };
    } catch (err) {
      // The json branch never rejects (errors collapse to {}), so a rejection
      // here is the deadline: discard the pending body without awaiting (a
      // locked-stream cancel rejection is swallowed) and fail closed.
      discardBodyOnce(response);
      if (timedOut || isExpired() || (err as { name?: unknown } | null)?.name === 'TimeoutError') {
        throw relayTimeoutError(timeoutMs);
      }
      throw err;
    }
    if (timedOut || isExpired()) {
      abortAndDiscard(response);
      throw relayTimeoutError(timeoutMs);
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Usage-attempt ledger wiring for the REST relay leg.
 *
 * Production quotas are mandatory on REST: every provider transport dispatch
 * counts. The typed errors below carry `__usageQuotaPassthrough` so the relay
 * executor (`isUsageQuotaPassthroughError`) propagates them verbatim — no
 * fallback/retry, no collapse into the generic 502.
 */
export const USAGE_QUOTA_EXCEEDED_CODE = 'agent.quota_exceeded';
export const USAGE_UNAVAILABLE_CODE = 'agent.persistence_unavailable';

const markUsageQuotaPassthrough = (err: Error): Error =>
  Object.assign(err, { __usageQuotaPassthrough: true });

const quotaRelayError = (reason: string): Error =>
  markUsageQuotaPassthrough(Object.assign(new Error(reason), { code: USAGE_QUOTA_EXCEEDED_CODE, status: 429 }));

const usageUnavailableRelayError = (reason: string): Error =>
  markUsageQuotaPassthrough(
    Object.assign(new Error(reason), { code: USAGE_UNAVAILABLE_CODE, status: 503 }),
  );

type RelayAttemptReceipt = {
  /** Explicit API attestation; null = missing/contradictory (never a release). */
  providerAttempted: boolean | null;
  /** Present only when both counts are trustworthy safe non-negative integers. */
  usage?: { inputTokens: number; outputTokens: number };
};

/**
 * Parses the private API attempt receipt. `providerAttempted` is trusted only
 * as an explicit boolean; `usage` is trusted only when BOTH counts arrive as
 * safe non-negative integers (chat-completions AND responses conventions
 * accepted). Anything else is "no trustworthy usage" — the caller retains
 * the full reservation, never synthesizes counts.
 */
export const parseRelayAttemptReceipt = (body: unknown): RelayAttemptReceipt => {
  const record = (body ?? {}) as Record<string, unknown>;
  const attemptedRaw = record.providerAttempted;
  const providerAttempted = attemptedRaw === true ? true : attemptedRaw === false ? false : null;
  const usageRecord = record.usage as Record<string, unknown> | null | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  if (usageRecord && typeof usageRecord === 'object') {
    const rawIn = usageRecord.inputTokens ?? usageRecord.input_tokens ?? usageRecord.prompt_tokens;
    const rawOut = usageRecord.outputTokens ?? usageRecord.output_tokens ?? usageRecord.completion_tokens;
    if (
      typeof rawIn === 'number' && Number.isSafeInteger(rawIn) && rawIn >= 0 &&
      typeof rawOut === 'number' && Number.isSafeInteger(rawOut) && rawOut >= 0
    ) {
      usage = { inputTokens: rawIn, outputTokens: rawOut };
    }
  }
  return { providerAttempted, ...(usage ? { usage } : {}) };
};

/**
 * Regra de ouro da camada cognitiva (ver agent-config/instructions.ts):
 * sempre utilize a ferramenta adequada em vez de responder "sem autorização"
 * ou "não tenho acesso" — a partir de dados reais do workspace via tools.
 */

export class FinanceChatAgent extends AIChatAgent<Env> {
  static override readonly messageConcurrency = "queue" as const;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    if (state?.storage?.sql) {
      try {
        initializeUsageSchema(state.storage.sql);
        // Per-provider-attempt ledger (additive table; never touches
        // usage_ledger). Initialized on the ctor-local handle — the same
        // surface every request-path accessor must resolve.
        initializeUsageAttemptSchema(state.storage.sql);
        state.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS intention_snapshots (
            intention_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            provider_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            protocol TEXT NOT NULL,
            rollout_percentage INTEGER NOT NULL DEFAULT 100,
            security_epoch INTEGER NOT NULL DEFAULT 1,
            fallback_provider_id TEXT,
            fallback_model_id TEXT,
            model_name TEXT,
            fallback_model_name TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
        `);
        ensureIntentionSnapshotColumns(state.storage.sql);
      } catch {
        // Ignored if table already exists or mock storage
      }
      // Part B: memory, sessions, prefs and turn counters (idempotent).
      try {
        initializeMemorySchema(state.storage.sql as unknown as MemorySql);
        initializeSessionSchema(state.storage.sql as unknown as MemorySql);
      } catch {
        // Memory is best-effort: turns work without it.
      }
      // SPEC §7.8 (ADR-014): MutationDraft table for multi-turn intention
      // persistence (idempotent; best-effort like the memory schema above).
      try {
        initializeMutationDraftSchema(state.storage.sql as unknown as { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> });
      } catch {
        // Drafts degrade to single-turn clarification without storage.
      }
    }
  }

  /** DO SQLite handle or null (tests, degraded storage). */
  private durableSql(): { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> } | null {
    // Agents SDK: durable SQLite lives on the DO context (ctx.storage.sql).
    // Agent `state` is app data and never carries storage — request-path
    // reads of `this.state.storage.sql` masked a production 503 (ctx
    // present, state.storage absent) and silently skipped usage limits.
    // `ctx` is used internally by the SDK but absent from its public types,
    // hence the narrow cast (fail-closed when unavailable).
    const sql = (this as unknown as { ctx?: DurableObjectState }).ctx?.storage?.sql as unknown as {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
    } | undefined;
    return sql && typeof sql.exec === 'function' ? sql : null;
  }

  /**
   * Atomic storage surface for the usage-attempt ledger: `exec` over the DO
   * SQLite handle plus `transactionSync` for the atomic check-and-reserve.
   * Null when either is missing — the relay leg fails closed (safe 503)
   * before any provider dispatch instead of consuming the provider unmetered.
   */
  private usageAttemptStorage(): {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
    transactionSync<T>(fn: () => T): T;
  } | null {
    const storage = (this as unknown as { ctx?: DurableObjectState }).ctx?.storage as unknown as {
      sql?: { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };
      transactionSync?: <T>(fn: () => T) => T;
    } | undefined;
    const sql = storage?.sql;
    const tx = storage?.transactionSync;
    if (!sql || typeof sql.exec !== 'function' || typeof tx !== 'function') return null;
    return {
      exec: <T>(query: string, ...bindings: unknown[]): Iterable<T> => sql.exec<T>(query, ...bindings),
      transactionSync: <T>(fn: () => T): T => (tx as <T>(fn: () => T) => T).call(storage, fn) as T,
    };
  }

  /** DO SQLite handle typed for the memory layer (null when unavailable). */
  private memorySql(): MemorySql | null {
    return this.durableSql() as unknown as MemorySql | null;
  }

  /** Loads the injected MEMÓRIA DO USUÁRIO block (null when disabled/empty). */
  private loadMemoryContext(workspaceId: string, actorId: string, query: string): string | null {
    const sql = this.memorySql();
    if (!sql || !isMemoryEnabled(sql, workspaceId)) return null;
    try {
      const items = recallMemories(sql, { workspaceId, actor: actorId, query });
      return renderMemoryBlock(items);
    } catch {
      return null;
    }
  }

  /** SDK history as plain turns for compaction/context building. */
  private sdkTurns(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return toContextTurns(
      (Array.isArray(this.messages) ? this.messages : []).map((message) => {
        const parts = Array.isArray(message.parts) ? message.parts : [];
        return {
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join(''),
        };
      }),
    );
  }

  /**
   * H-03: per-turn authority re-verification (epoch + rollout/canary),
   * applied on BOTH legs right after the snapshot resolves and before any
   * attempt executes. A bumped epoch invalidates the cached row and aborts
   * the turn; `disabled` blocks; canary non-cohort promotes the fallback.
   */
  private async authorizeTurn(
    snapshot: IntentionSnapshotRow,
    input: { workspaceId: string; actorId: string; intentionId: string },
  ): Promise<IntentionSnapshotRow> {
    const apiOrigin = this.env?.API_ORIGIN ?? "https://api.synkroo.com.br";
    const configToken = this.env?.AGENT_CONFIG_TOKEN ?? "";
    return authorizeTurnExecution({
      snapshot,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      intentionId: input.intentionId,
      fetchConfig: () => fetchRuntimeConfig(apiOrigin, configToken),
      deleteCachedSnapshot: () => {
        try {
          this.durableSql()?.exec(`DELETE FROM intention_snapshots WHERE intention_id = ?`, snapshot.intention_id);
        } catch {
          // Best effort: the abort below enforces the revocation.
        }
      },
      onAuthorityUnreachable: (err) => {
        // FIX-AGENT-LOG-CORRELATION-AND-ABORT-STATUS (W2): nunca imprime
        // input.intentionId, err.message, RuntimeSnapshotError.excerpt ou
        // corpo de resposta — todos podem carregar texto do chamador,
        // runtime-config ou injeção. Só evento constante + status numérico
        // seguro + classe de erro allowlistada (sem message/body).
        const e = err as { status?: unknown; statusCode?: unknown } | null;
        const rawStatus =
          typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 0;
        const status = Number.isFinite(rawStatus) && rawStatus >= 0 && rawStatus < 600 ? Math.trunc(rawStatus) : 0;
        let errorClass = 'unknown';
        try {
          errorClass = classifyError(err);
        } catch {
          errorClass = 'unknown';
        }
        console.warn(`llm.rollout authority unreachable status=${status} class=${errorClass}`);
      },
    });
  }

  private async resolveIntentionSnapshot(intentionId: string): Promise<IntentionSnapshotRow | null> {
    const intentSql = this.durableSql();
    if (intentSql) {
      try {
        const rows = [...intentSql.exec<IntentionSnapshotRow>(
          `SELECT * FROM intention_snapshots WHERE intention_id = ?`,
          intentionId,
        )];
        if (rows.length > 0 && rows[0]) {
          // Legacy rows predate the fallback/model-name columns: normalize to nulls.
          const candidate = {
            fallback_provider_id: null,
            fallback_model_id: null,
            model_name: null,
            fallback_model_name: null,
            ...rows[0],
          };
          // Fase 3-FIX R2: the persisted row is validated with the same
          // contract/invariants as the remote snapshot. Corrupted rows and
          // opaque row ids without a persisted name are discarded (miss →
          // remote refetch below), never executed.
          const parsed = intentionSnapshotRowSchema.safeParse(candidate);
          if (parsed.success) {
            const valid = parsed.data;
            if (
              resolveBareModelName(valid.provider_id, valid.model_id, valid.model_name) !== null
            ) {
              return valid;
            }
          }
        }
      } catch {
        // Continue if sql exec fails
      }
    }

    const apiOrigin = this.env?.API_ORIGIN ?? "https://api.synkroo.com.br";
    const configToken = this.env?.AGENT_CONFIG_TOKEN ?? "";
    if (!configToken) {
      return null;
    }

    let config: RuntimeSnapshot;
    try {
      config = await fetchRuntimeConfig(apiOrigin, configToken);
    } catch {
      return null;
    }

    if (!config.activeProviderId || !config.activeModelId) {
      return null;
    }

    const snapshot: IntentionSnapshotRow = {
      intention_id: intentionId,
      version: config.version,
      provider_id: config.activeProviderId,
      model_id: config.activeModelId,
      protocol: config.activeProtocol ?? "chat-completions",
      rollout_percentage: config.activeRolloutPercentage,
      security_epoch: config.securityEpoch,
      fallback_provider_id: config.fallbackProviderId ?? null,
      fallback_model_id: config.fallbackModelId ?? null,
      // Fase 3 item 5 + Fase 3-FIX R2: bare upstream name from the validated
      // slot; legacy derivation only when the slot is absent (conventional
      // prefix only — opaque ids stay null and fail closed at use).
      model_name:
        config.activeModelName ??
        resolveBareModelName(config.activeProviderId, config.activeModelId, null),
      fallback_model_name: config.fallbackModelName ?? null,
      created_at: new Date().toISOString(),
    };

    if (intentSql) {
      try {
        intentSql.exec(
          `INSERT INTO intention_snapshots (intention_id, version, provider_id, model_id, protocol, rollout_percentage, security_epoch, fallback_provider_id, fallback_model_id, model_name, fallback_model_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          snapshot.intention_id,
          snapshot.version,
          snapshot.provider_id,
          snapshot.model_id,
          snapshot.protocol,
          snapshot.rollout_percentage,
          snapshot.security_epoch,
          snapshot.fallback_provider_id ?? null,
          snapshot.fallback_model_id ?? null,
          snapshot.model_name ?? null,
          snapshot.fallback_model_name ?? null,
          snapshot.created_at,
        );
      } catch {
        // Ignore duplicate insert race
      }
    }

    return snapshot;
  }

  /**
   * Canonical response provider used by every conversational adapter.  The
   * provider receives only the normalized, DLP-scrubbed turn and its plan;
   * identity is used for scoping reads, never for granting write authority.
   *
   * AGENT-005: relay (`pwa-rest`) and `streamText` (SDK) model text is raw
   * provider output — it becomes user-visible ONLY through the
   * ConversationOrchestrator read path, which routes evidence-backed turns
   * through `createGroundedResponseWithRetry` (deterministic renderers or
   * validated text, safe fallback otherwise). Never publish this return
   * value for a read turn without that grounding step.
   */
  private async provideUnifiedResponse(input: TurnInput, _plan: TurnPlan): Promise<string> {
    const snapshot = await this.resolveIntentionSnapshot(input.intentionId);
    if (!snapshot) throw Object.assign(new Error('agent.provider_not_configured'), { code: 'agent.provider_not_configured', status: 503 });
    const activeSnapshot = await this.authorizeTurn(snapshot, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      intentionId: input.intentionId,
    });
    const cognition = assembleCognition(input.text, {
      webEnv: (this.env ?? {}) as Record<string, string | undefined>,
    });

    // REST keeps the buffered relay as a provider transport. It is invoked
    // only from runTurn, after the canonical plan/authority checks above.
    if (input.channel === 'pwa-rest') {
      if (typeof this.persistMessages !== 'function') {
        throw Object.assign(new Error('agent.persistence_unavailable'), { code: 'agent.persistence_unavailable', status: 503 });
      }
      // Internal grounding retries reuse this provider with the internal-only
      // flag set by the correction callback: they must not pollute durable
      // history with scaffolding turns. The flag is the ONLY trusted signal —
      // user text that literally contains the marker can never confer
      // internal status (normalize builds it as false), so it persists once
      // as a normal user turn.
      const isCorrectionRetry = input.internalCorrection === true;
      if (!isCorrectionRetry) {
        const userMessage: UIMessage = {
          id: `msg-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          parts: [{ type: 'text', text: input.text }],
          metadata: {
            actorId: input.actorId,
            workspaceId: input.workspaceId,
            createdAt: new Date().toISOString(),
          },
        } as unknown as UIMessage;
        await this.persistMessages([userMessage]);
      }
      const relayOrigin = this.env?.API_ORIGIN ?? 'https://api.synkroo.com.br';
      // Item 5 (Onda 2): failover restrito do relay — no máximo 1 primária +
      // 1 fallback distinto (RELAY_MAX_ATTEMPTS), cada perna com budget
      // explícito RELAY_ATTEMPT_TIMEOUT_MS (espelha o requestTimeoutMs da API).
      // A mensagem do usuário persiste exatamente 1x aqui; o texto do relay
      // nunca é persistido (só a resposta final grounded no /rpc/chat).
      const { primary: relayPrimary, fallback: relayFallback } = resolveRelayTargets(activeSnapshot);
      if (!relayPrimary) {
        throw Object.assign(new Error('agent.provider_not_configured'), { code: 'agent.provider_not_configured', status: 503 });
      }
      const runRelayLeg = async (target: { providerId: string; modelName: string }): Promise<string> => {
        // Verificação por perna sem segredo: provider relayável + nome
        // resolvido. Allowlist/key são autoridade da API (403/503 dela nunca
        // disparam fallback pelo classificador explícito de relay).
        if (!isRelayableProvider(target.providerId) || !target.modelName) {
          throw Object.assign(new Error('agent.provider_not_configured'), { code: 'agent.provider_not_configured', status: 503 });
        }
        // Usage-attempt ledger: every provider transport dispatch counts.
        // Reserve estimated FULL transmitted input (system+prompt as sent) +
        // max output BEFORE the relay fetch, over the verified TurnInput
        // identity only (actor/workspace/intention from the gateway-verified
        // headers — payload IDs never enter here). Each runRelayLeg
        // invocation reserves a fresh server-generated attemptId, so primary,
        // fallback, and grounding-correction redispatches each hold their
        // own attempt. A denied/unavailable reservation throws BEFORE any
        // fetch with a passthrough typed error (no fallback, no 502
        // collapse — see isUsageQuotaPassthroughError).
        const attemptStorage = this.usageAttemptStorage();
        if (!attemptStorage) {
          throw usageUnavailableRelayError(
            'agent.persistence_unavailable: durable usage storage is not available',
          );
        }
        const promptText = input.text.slice(0, 15_000);
        const systemText = cognition.system.slice(0, 7_900);
        const estimatedInputTokens = estimateTokens(`${systemText}${promptText}`);
        const maxOutputTokens = DEFAULT_POLICY.maxOutputTokens;
        // Storage operational failures (SELECT/INSERT/transactionSync throws
        // inside reserveUsageAttempt) fail closed as a sanitized 503: the
        // fixed message below never carries database error text. Denied
        // budgets stay an ordinary `allowed:false` result (429 below). Only
        // this synchronous reserve call is wrapped — finalize/release stay
        // best-effort and the provider classifier is untouched.
        let reservation: { allowed: boolean; attemptId?: string; reason?: string };
        try {
          reservation = reserveUsageAttempt(
            attemptStorage,
            {
              actorId: input.actorId,
              intentionId: input.intentionId,
              estimatedInputTokens,
              maxOutputTokens,
            },
            DEFAULT_POLICY,
          );
        } catch {
          throw usageUnavailableRelayError(
            'agent.persistence_unavailable: durable usage storage is not available',
          );
        }
        if (!reservation.allowed || !reservation.attemptId) {
          throw quotaRelayError(reservation.reason ?? 'agent.quota_exceeded: usage reservation denied');
        }
        const attemptId = reservation.attemptId;
        // Dispatched failure / unknown outcome: retain the FULL reservation.
        const settleRetain = (): void => {
          try {
            finalizeUsageAttempt(attemptStorage, attemptId, null, { reliable: false });
          } catch {
            // Accounting is best-effort: never mask the provider outcome.
          }
        };
        // Success: reconcile to reliable valid usage; missing/invalid usage
        // retains the full reservation (never synthesized counts).
        const settleSuccess = (usage: { inputTokens: number; outputTokens: number } | undefined): void => {
          try {
            if (usage) finalizeUsageAttempt(attemptStorage, attemptId, usage, { reliable: true });
            else finalizeUsageAttempt(attemptStorage, attemptId, null, { reliable: false });
          } catch {
            // Accounting is best-effort: never mask the provider outcome.
          }
        };
        // Proven pre-dispatch rejection: the ONLY release path on this leg.
        const releasePreDispatch = (): void => {
          try {
            releaseUsageAttempt(attemptStorage, attemptId, {
              kind: 'relay_confirmed_not_dispatched',
              reliable: true,
            });
          } catch {
            // Accounting is best-effort: never mask the provider outcome.
          }
        };
        const relayUrl = `${relayOrigin.replace(/\/$/, '')}/internal/agent/llm-relay`;
        // Item 6 (Onda 2): the per-leg budget (RELAY_ATTEMPT_TIMEOUT_MS) is an
        // ABSOLUTE deadline over fetch headers AND body parsing — the helper
        // sends abort at the deadline and forces finite termination even when
        // fetch or response.json() ignores abort. AGENT_RELAY_TIMEOUT_MS may
        // only shorten the budget (tests); it can never increase it.
        const relayTimeoutMs = resolveRelayLegTimeoutMs(this.env);
        let relayResult: {
          ok: boolean;
          status: number;
          body: { text?: unknown; code?: unknown; message?: unknown; providerAttempted?: unknown; usage?: unknown };
        };
        try {
          relayResult = await fetchRelayJsonWithDeadline(fetch, relayUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-agent-runtime-admin-token': this.env?.AGENT_RUNTIME_ADMIN_TOKEN ?? '',
          },
          body: JSON.stringify({
            provider: target.providerId,
            model: target.modelName,
            prompt: promptText,
            system: systemText,
            // FIX-AGENT-RELAY-SESSION-ID: stable per-conversation id (one DO
            // per workspace) forwarded by the API relay as the Go upstream's
            // `x-opencode-session` — required for routing/prompt-cache
            // affinity, charset-safe by construction (uuid format).
            sessionId: `ted-${input.workspaceId}`,
            // Usage-attempt receipt: caller-requested output cap (bounded
            // server-side 1..2000). The reservation above holds this same
            // maximum, so success can only reconcile downward or retain.
            maxOutputTokens,
          }),
          // FIX-AGENT-RELAY-EDGE-REDIRECT: Workers fetch throws TypeError on
          // redirect: 'error' ("won't be implemented at the edge"). 'manual'
          // keeps the no-follow SSRF guarantee — a 3xx/opaqueredirect arrives
          // as a non-ok response and fails closed in the mapping below.
          redirect: 'manual',
        }, relayTimeoutMs).catch((relayFetchErr: unknown) => {
          // Observability for instant edge failures that would otherwise
          // surface as opaque http_502. The bounded message comes from the
          // fetch runtime itself (never prompt/secret material).
          const e = relayFetchErr as { name?: unknown; status?: unknown; message?: unknown } | null;
          console.info(JSON.stringify({
            eventType: 'relay.leg.throw',
            name: typeof e?.name === 'string' ? e.name : 'unknown',
            status: typeof e?.status === 'number' ? e.status : null,
            msg: typeof e?.message === 'string' ? e.message.slice(0, 240) : '',
          }));
          throw relayFetchErr;
        });
        } catch (fetchErr) {
          // No receipt (timeout/transport throw): the dispatch may already
          // have happened upstream — retain the full reservation, NEVER
          // release on a timeout/unknown.
          settleRetain();
          throw fetchErr;
        }
        const { ok, status, body } = relayResult;
        const receipt = parseRelayAttemptReceipt(body);
        if (!ok) {
          if (receipt.providerAttempted === false) {
            releasePreDispatch();
          } else {
            // Dispatched failure (true) or missing/contradictory receipt:
            // retain the full reservation, never release.
            settleRetain();
          }
          // FIX-AGENT-RELAY-FAILOVER-HARDENING (B): preserva o {code,status}
          // estruturado do relay em vez de colapsar tudo em 502 — o /rpc/chat
          // propaga esse status/code — mas com a mensagem pública fixa. O
          // `body.message` bruto do upstream NUNCA é ecoado (pode conter
          // system prompt, segredos ou injeção); `body.code` passa pela
          // allowlist de charset.
          const code = sanitizeRelayCode(typeof body.code === 'string' ? body.code : '', status);
          throw Object.assign(
            new Error(relayPublicMessage(code, status)),
            { code, status },
          );
        }
        if (typeof body.text !== 'string' || !body.text) {
          settleRetain();
          throw Object.assign(new Error('agent.invalid_provider_output'), { code: 'agent.inference_error', status: 502 });
        }
        if (receipt.providerAttempted !== true) {
          // Missing or contradictory success receipt (absent flag or
          // explicit false on a 2xx): the full reservation is retained
          // (never reconciled, never released) and the unattested output is
          // rejected as invalid — untrusted provider text without an
          // explicit dispatch attestation is never published.
          settleRetain();
          throw Object.assign(new Error('agent.invalid_provider_output'), { code: 'agent.inference_error', status: 502 });
        }
        settleSuccess(receipt.usage);
        return redactTranscript(body.text);
      };
      const relayOutcome = await executeRelayAttempts({
        primary: relayPrimary,
        fallback: relayFallback,
        runLeg: runRelayLeg,
        // Reautorização imediata entre a primária falha e o fallback: epoch
        // mudado nega a segunda perna antes de qualquer chamada ao provider.
        authorizeBetween: () => this.authorizeTurn(activeSnapshot, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          intentionId: input.intentionId,
        }),
      }).catch((relayError: unknown) => {
        // FIX-AGENT-RELAY-FAILOVER-HARDENING (C): falha dupla — a primária
        // era elegível, o fallback foi realmente invocado e ambas as pernas
        // falharam (erro composto carrega o par de reasons). Emite UM evento
        // sanitizado com os dois reason codes e correlação opaca, e
        // re-lança. 1-shot, sem fallback, sucesso da primária e negação de
        // autoridade entre pernas não emitem este evento.
        const primaryReason = (relayError as { primaryReason?: unknown })?.primaryReason;
        const fallbackReason = (relayError as { fallbackReason?: unknown })?.fallbackReason;
        if (typeof primaryReason === 'string' && primaryReason && typeof fallbackReason === 'string' && fallbackReason) {
          logRelayDoubleFailure({
            intentionId: input.intentionId,
            primaryProviderId: relayPrimary.providerId,
            primaryModelId: relayPrimary.modelName,
            fallbackProviderId: relayFallback?.providerId ?? activeSnapshot.fallback_provider_id,
            fallbackModelId: relayFallback?.modelName ?? activeSnapshot.fallback_model_id,
            primaryReason,
            fallbackReason,
          });
        }
        throw relayError;
      });
      logFailoverEvent(
        {
          intentionId: input.intentionId,
          primaryProviderId: relayOutcome.primary.providerId,
          primaryModelId: relayOutcome.primary.modelName,
          fallbackProviderId: relayOutcome.fallback?.providerId ?? activeSnapshot.fallback_provider_id,
          fallbackModelId: relayOutcome.fallback?.modelName ?? activeSnapshot.fallback_model_id,
        },
        relayOutcome,
      );
      const output = relayOutcome.result;
      // The relay response is not publishable until the same authority that
      // admitted the turn is still valid. This makes an epoch/rollout change
      // during inference fail closed before an assistant message is durable.
      await this.authorizeTurn(activeSnapshot, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        intentionId: input.intentionId,
      });
      // NOTE: the raw relay text is deliberately NOT persisted here. It is
      // ungrounded provider output; the /rpc/chat handler persists the FINAL
      // grounded/deterministic response after `runTurn` completes, so
      // /rpc/history can only ever serve validated text (never raw text that
      // grounding later rejects or replaces).
      return output;
    }

    const target = {
      providerId: activeSnapshot.provider_id,
      modelName: resolveBareModelName(activeSnapshot.provider_id, activeSnapshot.model_id, activeSnapshot.model_name),
    };
    if (!target.modelName) throw Object.assign(new Error('agent.provider_not_configured'), { code: 'agent.provider_not_configured', status: 503 });

    if (isCodexProviderId(target.providerId)) {
      return runCodexBrokerText((this.env ?? {}) as CodexBrokerEnv, {
        model: target.modelName,
        prompt: input.text,
        system: cognition.system,
        requestId: input.traceId,
        intentionId: input.intentionId,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
      });
    }

    const modelInstance = createLanguageModel(
      target.providerId,
      target.modelName,
      activeSnapshot.protocol as Protocol,
      (this.env ?? {}) as Record<string, string | undefined>,
    );
    const memoryTools = this.memorySql()
      ? buildMemoryTools({ sql: this.memorySql()!, workspaceId: input.workspaceId, actorId: input.actorId })
      : {};
    const tools = buildExposedTools(
      cognition.toolNames,
      {
        apiOrigin: this.env?.API_ORIGIN,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        intentionId: input.intentionId,
        lastUserMessage: input.text,
        webEnv: (this.env ?? {}) as Record<string, string | undefined>,
      },
      memoryTools,
    );
    // The upstream contract is streaming. We consume it before returning from
    // the canonical boundary, while marking SDK metadata promises observed so
    // an empty/error stream cannot surface as an unrelated unhandled reject.
    let text: string;
    try {
      const generated = streamText({
        model: modelInstance.model,
        system: cognition.system,
        messages: [{ role: 'user' as const, content: input.text }],
        tools,
        stopWhen: stepCountIs(5),
      }) as unknown as {
        finishReason: Promise<unknown>;
        totalUsage: Promise<unknown>;
        text: Promise<string>;
      };
      void generated.finishReason.catch(() => undefined);
      void generated.totalUsage.catch(() => undefined);
      text = await generated.text;
    } catch {
      throw Object.assign(new Error('No output generated by provider.'), {
        code: 'agent.inference_error',
        status: 502,
      });
    }
    if (!text) throw Object.assign(new Error('agent.invalid_provider_output'), { code: 'agent.invalid_provider_output', status: 502 });
    return redactTranscript(text);
  }

  private orchestratorForChannel(dependencies: {
    mutationApiClient?: MutationApiClient;
    autoExecutionClient?: () => MutationApiClient | undefined;
    entityReader?: EntityReader;
    plan?: (input: TurnInput) => TurnPlan;
    evidenceProvider?: (input: TurnInput, plan: TurnPlan) => Promise<EvidenceEnvelope | null>;
    correctionProvider?: (input: TurnInput, plan: TurnPlan, unsupportedClaims: readonly string[]) => Promise<string | null>;
    /** Sanitized lifecycle event sink, shared by the turn and its evidence reads. */
    events?: (eventType: string, fields: Record<string, unknown>) => void;
    /** SPEC §7.8 draft store (DO storage). Absent = legacy single-turn flow. */
    draftStore?: SqlMutationDraftStore;
    /** debt-undo-confirmation-protocol override (tests). Absent = DO store + authoritative preview. */
    undoProposals?: ConstructorParameters<typeof ConversationOrchestrator>[0] extends { undoProposals?: infer U } ? U : never;
  } = {}): ConversationOrchestrator {
    // AGENT-005 production grounding: every channel (pwa-rest, sdk, broker)
    // reads through the same evidence provider over the canonical read
    // tools, scoped by the turn's authenticated workspace via a per-turn
    // `financial.read` delegation (device-bound when the channel carries a
    // verified device, read-only otherwise). Callers may override the pair
    // (tests); the response provider always stays unified.
    const grounding = createChannelGrounding({
      respond: (input, plan) => this.provideUnifiedResponse(input, plan),
      apiOrigin: this.env?.API_ORIGIN,
      readToken: (input) => this.mintReadToken(input),
      // Evidence-read lifecycle events (tool.started/tool.completed,
      // sanitized) flow into the turn's event sink when the caller supplies
      // one (tests, observability); otherwise the sanitized global emitter.
      events: dependencies.events ?? emitSanitizedEvent,
    });
    return new ConversationOrchestrator({
      ...dependencies,
      responseProvider: (input, plan) => this.provideUnifiedResponse(input, plan),
      evidenceProvider: dependencies.evidenceProvider ?? grounding.evidenceProvider,
      correctionProvider: dependencies.correctionProvider ?? grounding.correctionProvider,
      // debt-undo-confirmation-protocol: every channel proposes through the
      // same persistent DO store + authoritative preview. Tests may override
      // the pair; production always resolves it here (absent store = the
      // orchestrator degrades to a deterministic no-proposal reply).
      ...(() => {
        if (dependencies.undoProposals !== undefined) return { undoProposals: dependencies.undoProposals };
        const store = this.undoStoreForRequest();
        if (!store) return {};
        return { undoProposals: { store, preview: (identity) => this.previewUndoTarget(identity) } };
      })(),
    });
  }

  /**
   * Authoritative entity lists for SPEC §7.2/§7.3 resolution: the same
   * `GET /accounts` + `GET /categories` reads the evidence layer uses,
   * scoped by the turn's `financial.read` delegation. Unreadable lists fail
   * closed downstream (clarification, never a proposal).
   */
  private async entityReaderForTurn(input: TurnInput): Promise<EntityReader> {
    const delegatedToken = await this.mintReadToken(input);
    const apiOrigin = this.env?.API_ORIGIN;
    const request = <T>(method: string, path: string, options: Parameters<typeof requestPiApiJson>[2] = {}) =>
      requestPiApiJson<T>(method, path, { ...options, delegatedToken, ...(apiOrigin !== undefined ? { apiOrigin } : {}) });
    return createRequestEntityReader(request);
  }

  override async onChatMessage(messagePayload: unknown, ..._rest: unknown[]): Promise<unknown> {
    // C-06 trust boundary: the SDK direct leg carries NO transport identity.
    // `payload.actorId` is a gateway-stamped hint, NEVER a source of
    // identity — the Worker gateway compares any client-supplied actorId
    // against the authenticated actor (403 on mismatch) before this code is
    // reachable, and the REST legs derive identity from verified headers.
    const payload = (messagePayload ?? {}) as { text?: string; intentionId?: string; messageId?: string; actorId?: string; workspaceId?: string };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    // SPEC §7.7: no Date.now()/random fallback — the caller owns the turn
    // identity; without it the turn cannot dedup safely.
    const intentionId = typeof payload.intentionId === "string" && payload.intentionId.trim()
      ? payload.intentionId.trim()
      : typeof payload.messageId === "string" && payload.messageId.trim() ? payload.messageId.trim() : "";
    if (!intentionId) throw Object.assign(new Error("agent.invalid_message"), { code: "agent.invalid_message", status: 400 });
    const actorId = payload.actorId ?? "anonymous";
    const sdkWorkspace = payload.workspaceId ?? "workspace";

    if (!text) {
      return { text: "Mensagem vazia." };
    }

    // Fail-closed quota gate: without durable SQLite the usage limit and
    // ledger cannot be enforced, so the turn must not consume the provider
    // unmetered. Returns before any orchestrator/provider invocation.
    if (!this.durableSql()) {
      return { text: "TED unavailable: durable storage is not available" };
    }

    // T2.1: the SDK adapter normalizes into the canonical pipeline. Body
    // identity is only a compatibility hint here; authenticated gateway
    // identity remains authoritative at the REST boundary.
    const sdkInput = normalizeSdkTurn(payload, {
      actorId,
      workspaceId: sdkWorkspace,
      role: "member",
      deviceId: null,
    });
    let turnResult;
    try {
      turnResult = await this.orchestratorForChannel().runTurn(sdkInput);
    } catch (error) {
      // The SDK protocol is text based, so the one expected configuration
      // failure remains a safe message. All other typed failures propagate:
      // they must never become a fabricated successful response.
      if ((error as { code?: unknown }).code === 'agent.provider_not_configured') {
        return { text: "TED ready: provider not configured" };
      }
      throw error;
    }
    if (turnResult.response) return { text: turnResult.response.text };

    const estimatedTokens = estimateTokens(text);
    const usageSql = this.durableSql();
    if (usageSql) {
      const budgetCheck = checkUsageLimit(usageSql, actorId, estimatedTokens);
      if (!budgetCheck.allowed) {
        return { text: `Limite de uso atingido: ${budgetCheck.reason}` };
      }
    }

    const snapshot = await this.resolveIntentionSnapshot(intentionId);
    if (!snapshot) {
      return { text: "TED ready: provider not configured" };
    }

    // H-03: epoch + rollout/canary re-verified per turn before any attempt.
    let activeSnapshot: IntentionSnapshotRow;
    try {
      activeSnapshot = await this.authorizeTurn(snapshot, { workspaceId: sdkWorkspace, actorId, intentionId });
    } catch (turnErr) {
      if ((turnErr as { code?: string })?.code === 'agent.security_epoch_changed') {
        return { text: "Configuração de IA atualizada durante o turno. Tente de novo." };
      }
      return { text: "TED ready: provider not configured" };
    }

    try {
      // H-02: the direct leg runs inside the unified attempts executor —
      // concrete upstream pairs, one primary + one distinct fallback,
      // retryable-only failover. Unresolvable snapshots fail closed.
      const runDirect = async (target: { providerId: string; modelName: string }) => {
        const providerId = target.providerId;
        const modelId = target.modelName;
        // Cognitive layer (Parts A+B, item 15): versioned persona + skills +
        // playbook + workspace memory assembled per turn, with the model's
        // tools actually wired.
        const sql = this.memorySql();
        const memoryWorkspace = sdkWorkspace;
        const memoryContext = sql ? this.loadMemoryContext(memoryWorkspace, actorId, text) : null;
        const cognition = assembleCognition(text, {
          webEnv: (this.env ?? {}) as Record<string, string | undefined>,
          ...(memoryContext ? { hooks: { memoryContext } } : {}),
        });
        if (isCodexProviderId(providerId)) {
          const brokerText = await runCodexBrokerText((this.env ?? {}) as CodexBrokerEnv, {
            model: modelId,
            prompt: text,
            system: cognition.system,
            requestId: `direct-${intentionId}`,
            intentionId,
            workspaceId: sdkWorkspace,
            actorId,
          });
          return { text: brokerText };
        }
        const modelInstance = createLanguageModel(
          providerId,
          modelId,
          activeSnapshot.protocol as Protocol,
          (this.env ?? {}) as Record<string, string | undefined>,
        );
        const memoryTools = sql ? buildMemoryTools({ sql, workspaceId: memoryWorkspace, actorId }) : {};
        const exposedTools = buildExposedTools(
          cognition.toolNames,
          {
            apiOrigin: this.env?.API_ORIGIN,
            workspaceId: sdkWorkspace,
            actorId,
            intentionId,
            lastUserMessage: text,
            webEnv: (this.env ?? {}) as Record<string, string | undefined>,
          },
          memoryTools,
        );
        // Compacted context: summaries replace old turns sent to the model
        // (stored history is preserved untouched).
        const historyTurns = this.sdkTurns();
        const compaction = await compactContext(historyTurns, {
          summarize: async (turns) => {
            const transcript = turns.map((turn) => `${turn.role === 'user' ? 'Usuário' : 'TED'}: ${turn.content}`).join('\n');
            const summary = await generateText({
              model: modelInstance.model,
              system: 'Resuma a conversa abaixo em até 500 caracteres, em pt-BR, preservando preferências e decisões duráveis. NUNCA inclua saldos, valores atuais, faturas, limites ou extratos como fatos: valores financeiros atuais nunca são duráveis.',
              prompt: transcript,
              maxOutputTokens: 400,
            });
            return summary.text;
          },
        });
        if (compaction.compacted && sql && compaction.summary && !isProhibitedFinancialMemory(compaction.summary)) {
          try {
            rememberFact(sql, {
              workspaceId: memoryWorkspace,
              actor: '',
              kind: 'summary',
              content: compaction.summary,
              salience: 0.7,
            });
          } catch {
            // Summary persistence is best-effort.
          }
        }
        return streamText({
          model: modelInstance.model,
          system: cognition.system,
          messages: [...compaction.context, { role: 'user' as const, content: text }],
          tools: exposedTools,
          stopWhen: stepCountIs(5),
        });
      };
      const outcome = await executeLlmAttempts({
        snapshot: activeSnapshot,
        intentionId,
        runLeg: (target) => runDirect(target),
      });
      logFailoverEvent(
        {
          intentionId,
          primaryProviderId: outcome.primary.providerId,
          primaryModelId: outcome.primary.modelName,
          fallbackProviderId: outcome.fallback?.providerId ?? activeSnapshot.fallback_provider_id,
          fallbackModelId: outcome.fallback?.modelName ?? activeSnapshot.fallback_model_id,
        },
        outcome,
      );

      // H-14: same post-inference re-verification as the relay leg — a
      // revocation during inference blocks publication of the result.
      try {
        await this.authorizeTurn(activeSnapshot, { workspaceId: sdkWorkspace, actorId, intentionId });
      } catch (postErr) {
        if ((postErr as { code?: string })?.code === 'agent.security_epoch_changed') {
          return { text: "Configuração de IA atualizada durante o turno. Tente de novo." };
        }
        return { text: "TED ready: provider not configured" };
      }

      const result = outcome.result;

      const recordSql = this.durableSql();
      if (recordSql) {
        recordUsage(recordSql, actorId, intentionId, estimatedTokens, estimatedTokens);
      }

      // Part B: post-turn learning (heuristic every turn, cheap LLM
      // extraction every 5th). Never breaks the turn; assistant text is
      // unavailable before streaming, so the heuristic reads the user turn.
      const learnSql = this.memorySql();
      if (learnSql) {
        try {
          const turnCount = bumpTurnCount(learnSql, sdkWorkspace);
          await learnFromTurn(learnSql, {
            workspaceId: sdkWorkspace,
            actorId,
            userText: text,
            assistantText: '',
            turnCount,
            llmExtract: async (transcript) => {
              try {
                const learnModel = createLanguageModel(
                  outcome.primary.providerId,
                  outcome.primary.modelName,
                  activeSnapshot.protocol as Protocol,
                  (this.env ?? {}) as Record<string, string | undefined>,
                );
                const extracted = await generateText({
                  model: learnModel.model,
                  system: 'Extraia até 2 aprendizados duráveis sobre a pessoa (preferências, contas, categorias, metas). Responda só com os itens, um por linha, em pt-BR. Se não houver nada durável, responda vazio.',
                  prompt: transcript,
                  maxOutputTokens: 300,
                });
                return extracted.text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 2);
              } catch {
                return [];
              }
            },
          });
        } catch {
          // Learning is best-effort.
        }
      }

      return result;
    } catch (err) {
      if ((err as { code?: string })?.code === 'agent.provider_not_configured') {
        return { text: "TED ready: provider not configured" };
      }
      const message = (err as Error)?.message ?? "Erro desconhecido ao processar inferência.";
      return { text: `TED error: ${redactTranscript(message)}` };
    }
  }

  override async onMessage(connection: unknown, message: string): Promise<void> {
    if (typeof message === "string" && (message.includes("clearHistory") || message.includes("setMessages"))) {
      const conn = connection as { send?: (s: string) => void };
      conn.send?.(JSON.stringify({ error: "agent.clear_forbidden" }));
      return;
    }
    await super.onMessage(connection, message);
  }

  private chatQueue?: Promise<unknown>;

  /**
   * H-07: binds the Worker-stamped identity headers to the verified
   * connection token. Spoofed or cross-workspace headers fail even if a
   * misconfigured gateway ever forwarded them. Returns null when the check
   * passes (or does not apply: cookie-authenticated callers carry no token).
   */
  private async assertConnectionBinding(request: Request): Promise<Response | null> {
    const connToken = request.headers.get("x-agent-connection-token")?.trim();
    const secret = this.env?.AGENT_CONNECTION_TOKEN_SECRET;
    if (!connToken || !secret) return null;
    let claims: { sub: string; workspace: string; deviceId?: unknown };
    try {
      claims = await verifyAgentConnectionToken(connToken, secret);
    } catch {
      return Response.json({ code: "agent.workspace_forbidden", message: "Invalid connection token" }, { status: 403 });
    }
    const actorId = request.headers.get("x-agent-actor") ?? "";
    const workspaceId = request.headers.get("x-agent-workspace") ?? "";
    if (!actorId || !workspaceId || claims.sub !== actorId || claims.workspace !== workspaceId) {
      return Response.json(
        { code: "agent.identity_mismatch", message: "Authenticated identity does not match request context" },
        { status: 403 },
      );
    }
    // H-12: the stamped device must equal the token-bound device. The Worker
    // overwrites any client-sent x-agent-device, so a mismatch here means a
    // forged direct-DO call (token of device A presented as device B).
    const stampedDevice = request.headers.get("x-agent-device")?.trim() || undefined;
    const boundDevice = typeof claims.deviceId === "string" && claims.deviceId ? claims.deviceId : undefined;
    if (boundDevice !== undefined || stampedDevice !== undefined) {
      if (boundDevice === undefined || stampedDevice === undefined || boundDevice !== stampedDevice) {
        return Response.json(
          { code: "agent.identity_mismatch", message: "Device binding does not match request context" },
          { status: 403 },
        );
      }
    }
    return null;
  }

  private async handleApprovalDecision(request: Request, operationId: string): Promise<Response> {
    const token = request.headers.get("x-agent-connection-token")?.trim();
    const secret = this.env?.AGENT_DELEGATION_SECRET?.trim();
    const actorId = request.headers.get("x-agent-actor")?.trim();
    const workspaceId = request.headers.get("x-agent-workspace")?.trim();
    const deviceId = request.headers.get("x-agent-device")?.trim();
    if (!token || !secret || !actorId || !workspaceId || !deviceId) {
      return Response.json({ code: "agent.approval_context_required" }, { status: 401 });
    }
    let body: { decision?: unknown; requestId?: unknown };
    try {
      body = await request.json() as { decision?: unknown; requestId?: unknown };
    } catch {
      return Response.json({ code: "agent.invalid_payload" }, { status: 400 });
    }
    const keys = Object.keys(body);
    if (keys.some((key) => key !== "decision" && key !== "requestId") ||
      (body.decision !== "confirm" && body.decision !== "cancel" && body.decision !== "retry") ||
      typeof body.requestId !== "string" || body.requestId.trim() === "" || body.requestId.length > 128) {
      return Response.json({ code: "agent.invalid_payload" }, { status: 400 });
    }
    const role = request.headers.get("x-agent-role") === "owner" ? "owner" : "member";
    try {
      const capabilities = body.decision === "cancel"
        ? ["financial.approval.cancel"]
        : body.decision === "retry"
          ? ["financial.approval.retry", "financial.approval.execute"]
          : ["financial.approval.confirm", "financial.approval.execute"];
      const delegatedToken = await createDelegatedTurnToken({
        actorId,
        workspaceId,
        role,
        capabilities,
        requestId: body.requestId.trim(),
        deviceId,
      }, secret);
      const requestWithApprovalToken = async <T>(method: string, path: string, opts: Parameters<typeof requestPiApiJson>[2] = {}) =>
        requestPiApiJson<T>(method, path, { ...opts, delegatedToken, apiOrigin: this.env?.API_ORIGIN });
      // T1.5 (SPEC §8.1/§8.2): the approval button converges into the same
      // PendingOperationCoordinator as natural language — one decision
      // machine, no parallel path. The card names its operation, so decide()
      // addresses it by id (no listing, no disambiguation).
      const result = await new PendingOperationCoordinator({
        client: new MutationApiClient({ request: requestWithApprovalToken }),
      }).decide({
        operationId,
        decision: body.decision as 'confirm' | 'cancel' | 'retry',
        identity: { workspaceId, actorId, deviceId },
      });
      // AGENT-010: sanitized approval lifecycle events (status only — never
      // operation payloads, tokens, or financial values).
      try {
        if (result.status === 'succeeded') {
          emitSanitizedEvent('approval.confirmed', { status: 'confirmed' });
          emitSanitizedEvent('mutation.executed', { status: 'succeeded' });
        } else if (result.status === 'cancelled') {
          emitSanitizedEvent('approval.rejected', { status: 'rejected' });
        } else if (result.status === 'expired') {
          emitSanitizedEvent('approval.expired', { status: 'expired' });
        } else if (result.status === 'failed') {
          emitSanitizedEvent('mutation.blocked', { status: 'blocked' });
        } else {
          emitSanitizedEvent('approval.confirmed', { status: result.status });
        }
      } catch {
        // Observability must never break the approval response.
      }
      return Response.json(result);
    } catch {
      return Response.json({ code: "agent.approval_failed", message: "Não foi possível concluir a decisão." }, { status: 502 });
    }
  }

  /**
   * T5.3 (H-14, SPEC §22): authoritative listing of the workspace's active
   * pending operations, relayed lean to trusted PWA surfaces (Home badge,
   * Aprovações page). The browser NEVER decides here — this is a read-only
   * reflection. The delegated credential carries the READ capability only
   * and the response is the strict lean projection (never attestation,
   * never raw normalizedArgs), scoped to the gateway-verified
   * workspace/actor/device identity.
   */
  private async handleActivePendingOperations(request: Request): Promise<Response> {
    const secret = this.env?.AGENT_DELEGATION_SECRET?.trim();
    const actorId = request.headers.get("x-agent-actor")?.trim();
    const workspaceId = request.headers.get("x-agent-workspace")?.trim();
    const deviceId = request.headers.get("x-agent-device")?.trim();
    if (!secret || !actorId || !workspaceId || !deviceId) {
      return Response.json({ code: "agent.approval_context_required" }, { status: 401 });
    }
    const role = request.headers.get("x-agent-role") === "owner" ? "owner" : "member";
    try {
      const delegatedToken = await createDelegatedTurnToken({
        actorId,
        workspaceId,
        role,
        capabilities: ["financial.approval.read"],
        requestId: crypto.randomUUID(),
        deviceId,
      }, secret);
      const requestWithReadToken = async <T>(method: string, path: string, opts: Parameters<typeof requestPiApiJson>[2] = {}) =>
        requestPiApiJson<T>(method, path, { ...opts, delegatedToken, apiOrigin: this.env?.API_ORIGIN });
      const client = new MutationApiClient({ request: requestWithReadToken });
      const result = await client.listActive({ workspaceId, actorId, deviceId });
      const items = toActiveOperationRecords(result?.items);
      // total reflects what is actually relayed (invalid items are dropped).
      return Response.json({ items, total: items.length });
    } catch {
      return Response.json(
        { code: "agent.pending_list_unavailable", message: "Não foi possível carregar as aprovações agora." },
        { status: 502 },
      );
    }
  }

  /** Builds the sole V2 mutation plan used by every channel adapter. */
  private mutationProposalPlan(input: TurnInput): TurnPlan | null {
    const parsed = parseFinancialMutation(input.text);
    if (parsed.kind === "none" || !isClearlyMutating(input.text)) return null;

    const routed = routeIntent(input.text);
    return {
      version: "2",
      mode: "mutation-proposal",
      domain: "transactions",
      skillNames: routed.skillNames.slice(0, 2),
      requestedOperations: [{ name: parsed.kind === "income" ? "transactions.income.create" : "transactions.expense.create", kind: "mutation" }],
      // SPEC §7.6: canonical IDs are never resolved at plan time — the
      // orchestrator resolves them against authoritative reads (§7.2/§7.3).
      missingFields: ["accountId", "categoryId"],
      ambiguity: null,
      confidence: routed.confidence,
    };
  }

  /**
   * Constructs the per-turn, approval-scoped transport injected into the
   * canonical orchestrator. No browser-owned data crosses this boundary.
   *
   * T1.5 (SPEC §8.1): ONE client carries every decision capability
   * (propose/read/confirm/execute/retry/cancel) so proposal, confirmation,
   * cancellation and retry turns share the same transport + coordinator —
   * the previous propose-only asymmetry starved decision turns.
   */
  private async mutationApiClientForTurn(input: TurnInput, needsMutationClient: boolean): Promise<MutationApiClient | undefined> {
    if (!needsMutationClient) return undefined;
    const secret = this.env?.AGENT_DELEGATION_SECRET?.trim();
    if (!secret || !input.deviceId) {
      return undefined;
    }

    const delegatedToken = await createDelegatedTurnToken({
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      role: input.role,
      capabilities: [
        'financial.read',
        'financial.approval.propose',
        'financial.approval.read',
        'financial.approval.confirm',
        'financial.approval.execute',
        'financial.approval.retry',
        'financial.approval.cancel',
      ],
      requestId: input.intentionId,
      deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
    }, secret);
    const request = async <T>(method: string, path: string, options: Parameters<typeof requestPiApiJson>[2] = {}) =>
      requestPiApiJson<T>(method, path, { ...options, delegatedToken, apiOrigin: this.env?.API_ORIGIN });
    return new MutationApiClient({
      request,
      strictDuplicateCheck: (check) => detectDuplicateSuspectedStrict(check, {
        apiOrigin: this.env?.API_ORIGIN ?? 'https://api.synkroo.com.br',
        workspaceId: input.workspaceId,
        delegatedToken,
      }),
    });
  }

  private elevatedMutationApiClientForTurn(input: TurnInput): MutationApiClient | undefined {
    const secret = this.env?.AGENT_DELEGATION_SECRET?.trim();
    if (!secret || !input.deviceId) return undefined;
    let tokenPromise: Promise<string> | undefined;
    const getToken = () => tokenPromise ??= createDelegatedTurnToken({
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      role: input.role,
      capabilities: [
        'financial.read', 'financial.approval.propose', 'financial.approval.read',
        'financial.approval.confirm', 'financial.approval.execute',
        'financial.approval.retry', 'financial.approval.cancel',
        'financial.approval.autoexecute',
      ],
      requestId: input.intentionId,
      deviceId: input.deviceId ?? (() => { throw new Error('mutation.device_required'); })(),
    }, secret);
    const request = async <T>(method: string, path: string, options: Parameters<typeof requestPiApiJson>[2] = {}) =>
      requestPiApiJson<T>(method, path, { ...options, delegatedToken: await getToken(), apiOrigin: this.env?.API_ORIGIN });
    return new MutationApiClient({ request });
  }

  /**
   * Per-turn read delegation for the production evidence provider. Mirrors
   * `mutationApiClientForTurn` but with the narrow `financial.read`
   * capability the API requires on GETs; the workspace/actor scoping the
   * API enforces comes from these claims (generated tools never send
   * `context` params on the wire). Device-bound when the channel carries a
   * verified device, read-only otherwise. Absent without a secret — reads
   * then fail closed into `error` evidence, exactly like today's
   * unauthenticated model-tool reads.
   */
  private async mintReadToken(input: TurnInput): Promise<string | undefined> {
    const secret = this.env?.AGENT_DELEGATION_SECRET?.trim();
    if (!secret) return undefined;
    try {
      return await createDelegatedTurnToken({
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        role: input.role,
        capabilities: ['financial.read'],
        requestId: input.intentionId,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      }, secret);
    } catch {
      return undefined;
    }
  }

  /**
   * SPEC §7.8 draft store over DO SQLite storage. Undefined when storage is
   * unavailable — the orchestrator then keeps the legacy single-turn flow.
   */
  private draftStoreForRequest(): SqlMutationDraftStore | undefined {
    const sql = this.durableSql();
    if (!sql) return undefined;
    try {
      initializeMutationDraftSchema(sql);
      return new SqlMutationDraftStore(sql);
    } catch {
      return undefined;
    }
  }

  /**
   * debt-undo-confirmation-protocol: persistent undo proposal store over DO
   * SQLite storage. Undefined when storage is unavailable — chat turns then
   * degrade to a deterministic no-proposal reply (never execution).
   */
  private undoStoreForRequest(): SqlUndoProposalStore | undefined {
    const sql = this.durableSql();
    if (!sql) return undefined;
    try {
      initializeUndoProposalSchema(sql);
      return new SqlUndoProposalStore(sql);
    } catch {
      return undefined;
    }
  }

  /**
   * Authoritative undo preview: the FIXED target for a proposal, resolved
   * server-side from GET /audit-logs (most recent reversible operation,
   * preferring the actor's own). Null = genuinely nothing to undo; throw =
   * transport failure (the turn degrades to try-again, never "no action").
   */
  private async previewUndoTarget(identity: UndoIdentity): Promise<{ id: string } | null> {
    const secret = this.env?.AGENT_DELEGATION_SECRET?.trim();
    if (!secret) throw new Error('agent.persistence_unavailable');
    const readToken = await createDelegatedTurnToken({
      actorId: identity.actorId,
      workspaceId: identity.workspaceId,
      role: 'member',
      capabilities: ['financial.read'],
      requestId: crypto.randomUUID(),
      deviceId: identity.deviceId,
    }, secret);
    const result = await requestPiApiJson<{ items?: Array<{ id?: unknown; operation?: unknown; actorId?: unknown; createdAt?: unknown }> }>(
      'GET',
      '/audit-logs?limit=50',
      { delegatedToken: readToken, apiOrigin: this.env?.API_ORIGIN },
    );
    const reversible = new Set([
      'transactions.expense.create',
      'transactions.income.create',
      'transactions.transfer.create',
      'accounts.create',
      'categories.create',
    ]);
    const items = Array.isArray(result.items) ? result.items : [];
    const candidates = items
      .filter((item) => typeof item.id === 'string' && reversible.has(String(item.operation ?? '')))
      .sort((a, b) => Date.parse(String(b.createdAt ?? 0)) - Date.parse(String(a.createdAt ?? 0)));
    if (candidates.length === 0) return null;
    const own = candidates.filter((item) => item.actorId === identity.actorId);
    const target = (own.length > 0 ? own[0] : candidates[0])!;
    return { id: String(target.id) };
  }

  /**
   * debt-undo-confirmation-protocol decision RPC: strict {decision,requestId}
   * body, identity SOLELY from the gateway-verified headers. Confirm calls
   * the existing undo API with the FIXED target, the STABLE
   * proposal-derived idempotency key, and the NARROW undo capability.
   */
  private async handleUndoDecision(request: Request): Promise<Response> {
    const actorId = request.headers.get("x-agent-actor")?.trim();
    const workspaceId = request.headers.get("x-agent-workspace")?.trim();
    const deviceId = request.headers.get("x-agent-device")?.trim();
    const secret = this.env?.AGENT_DELEGATION_SECRET?.trim();
    if (!actorId || !workspaceId || !deviceId || !secret) {
      return Response.json({ code: "agent.approval_context_required" }, { status: 401 });
    }
    const role = request.headers.get("x-agent-role") === "owner" ? "owner" : "member";
    let body: { decision?: unknown; requestId?: unknown };
    try {
      body = await request.json() as { decision?: unknown; requestId?: unknown };
    } catch {
      return Response.json({ code: "agent.invalid_payload" }, { status: 400 });
    }
    const keys = Object.keys(body);
    if (keys.some((key) => key !== "decision" && key !== "requestId") ||
      (body.decision !== "confirm" && body.decision !== "cancel") ||
      typeof body.requestId !== "string" || body.requestId.trim() === "" || body.requestId.length > 128) {
      return Response.json({ code: "agent.invalid_payload" }, { status: 400 });
    }
    const proposalId = body.requestId.trim();
    const store = this.undoStoreForRequest();
    if (!store) {
      return Response.json({ code: "agent.persistence_unavailable", message: "Undo storage is not available" }, { status: 503 });
    }
    const identity: UndoIdentity = { workspaceId, actorId, deviceId };
    const service = new UndoProposalService({
      store,
      preview: (id) => this.previewUndoTarget(id),
      api: {
        undo: async ({ lastOperationId, idempotencyKey }) => {
          const delegatedToken = await createDelegatedTurnToken({
            actorId,
            workspaceId,
            role,
            capabilities: [UNDO_DELEGATED_CAPABILITY],
            requestId: proposalId,
            deviceId,
          }, secret);
          return requestPiApiJson<unknown>('POST', '/pending-operations/undo', {
            body: { lastOperationId },
            idempotencyKey,
            delegatedToken,
            apiOrigin: this.env?.API_ORIGIN,
          });
        },
      },
    });
    try {
      const outcome = await service.decide({ requestId: proposalId, decision: body.decision, identity });
      if (outcome.kind === 'cancelled') {
        try { emitSanitizedEvent('approval.rejected', { status: 'rejected' }); } catch { /* best effort */ }
        return Response.json({ requestId: proposalId, status: 'cancelled' });
      }
      try {
        emitSanitizedEvent('approval.confirmed', { status: 'confirmed' });
        emitSanitizedEvent('mutation.executed', { status: 'succeeded' });
      } catch { /* best effort */ }
      return Response.json({ requestId: proposalId, status: 'confirmed', result: outcome.result ?? null });
    } catch (error) {
      const code = (error as { code?: string })?.code ?? 'agent.approval_failed';
      if (code === 'undo.not_found') return Response.json({ code, message: 'Undo proposal not found.' }, { status: 404 });
      if (code === 'undo.binding_mismatch') return Response.json({ code, message: 'Undo proposal belongs to another actor/device/workspace.' }, { status: 403 });
      if (code === 'undo.expired') return Response.json({ code, message: 'Undo proposal expired.' }, { status: 410 });
      if (code === 'undo.executing') return Response.json({ code, message: 'Undo already in progress.' }, { status: 409 });
      if (code === 'undo.terminal') return Response.json({ code, message: 'Undo proposal already decided.' }, { status: 409 });
      return Response.json({ code: "agent.approval_failed", message: "Não foi possível concluir a decisão." }, { status: 502 });
    }
  }

  /**
   * closure-undo-verify: read-only target check
   * (`POST /rpc/undo/:requestId/verify-target`). Strict
   * `{ expectedEntity: { type: 'transaction', id: UUID } }` body, identity
   * SOLELY from the gateway-verified headers, narrow `financial.read`
   * delegation for the audit read. Answers `{ requestId, matches }` and
   * persists nothing — never tools, never the model, never preview/decide.
   */
   private async handleUndoVerifyTarget(request: Request, proposalId: string): Promise<Response> {
     const actorId = request.headers.get("x-agent-actor")?.trim();
     const workspaceId = request.headers.get("x-agent-workspace")?.trim();
     const deviceId = request.headers.get("x-agent-device")?.trim();
     const secret = this.env?.AGENT_DELEGATION_SECRET?.trim();
     if (!actorId || !workspaceId || !deviceId || !secret) {
       return Response.json({ code: "agent.approval_context_required" }, { status: 401 });
     }
     if (!proposalId || proposalId.length > 128) {
       return Response.json({ code: "agent.invalid_payload" }, { status: 400 });
     }
     let body: unknown;
     try {
       body = (await request.json()) as unknown;
     } catch {
       return Response.json({ code: "agent.invalid_payload" }, { status: 400 });
     }
     const record = (body ?? {}) as Record<string, unknown>;
     const expected = record.expectedEntity as Record<string, unknown> | undefined;
     const expectedKeys = expected && typeof expected === 'object' && !Array.isArray(expected) ? Object.keys(expected) : [];
      if (
        !expected || typeof expected !== 'object' || Array.isArray(expected) ||
        Object.keys(record).length !== 1 || !('expectedEntity' in record) ||
        expectedKeys.length !== 2 || !expectedKeys.includes('type') || !expectedKeys.includes('id') ||
        expected.type !== 'transaction' ||
        typeof expected.id !== 'string' || !UNDO_UUID_RE.test(expected.id)
      ) {
       return Response.json({ code: "agent.invalid_payload" }, { status: 400 });
     }
     const store = this.undoStoreForRequest();
     if (!store) {
       return Response.json({ code: "agent.persistence_unavailable", message: "Undo storage is not available" }, { status: 503 });
     }
     const role = request.headers.get("x-agent-role") === "owner" ? "owner" : "member";
     const identity: UndoIdentity = { workspaceId, actorId, deviceId };
     const service = new UndoProposalService({
       store,
       preview: () => {
         throw Object.assign(new Error('agent.verify_read_only'), { code: 'agent.verify_read_only' });
       },
       api: {
         undo: async () => {
           throw Object.assign(new Error('agent.verify_read_only'), { code: 'agent.verify_read_only' });
         },
       },
       audit: async (id) => {
         const delegatedToken = await createDelegatedTurnToken({
           actorId,
           workspaceId,
           role,
           capabilities: [UNDO_VERIFY_READ_CAPABILITY],
           requestId: crypto.randomUUID(),
           deviceId,
         }, secret);
         const result = await requestPiApiJson<{ items?: Array<{ id?: unknown; workspaceId?: unknown; operation?: unknown; effectRef?: unknown; metadata?: unknown }> }>(
           'GET',
           '/audit-logs?limit=50',
           { delegatedToken, apiOrigin: this.env?.API_ORIGIN },
         );
         void id;
         return (Array.isArray(result.items) ? result.items : []).map((item) => ({
           id: typeof item.id === 'string' ? item.id : '',
           ...(typeof item.workspaceId === 'string' ? { workspaceId: item.workspaceId } : {}),
           ...(typeof item.operation === 'string' ? { operation: item.operation } : {}),
           ...(typeof item.effectRef === 'string' ? { effectRef: item.effectRef } : {}),
           ...(item.metadata && typeof item.metadata === 'object' ? { metadata: item.metadata as Record<string, unknown> } : {}),
         }));
       },
     });
     try {
       const outcome = await service.verify({
         requestId: proposalId,
         expectedEntity: { type: 'transaction', id: expected.id as string },
         identity,
       });
       return Response.json({ requestId: proposalId, matches: outcome.matches });
     } catch (error) {
       const code = (error as { code?: string })?.code ?? 'agent.verify_failed';
       if (code === 'undo.not_found') return Response.json({ code, message: 'Undo proposal not found.' }, { status: 404 });
       if (code === 'undo.binding_mismatch') return Response.json({ code, message: 'Undo proposal belongs to another actor/device/workspace.' }, { status: 403 });
       if (code === 'undo.context_required' || code === 'agent.approval_context_required') return Response.json({ code: 'agent.approval_context_required' }, { status: 401 });
       if (code === 'agent.invalid_payload' || code === 'undo.invalid_target') return Response.json({ code: 'agent.invalid_payload' }, { status: 400 });
       if (
         code === 'undo.expired' || code === 'undo.terminal' || code === 'undo.executing' ||
         code === 'undo.target_changed' || code === 'undo.target_missing' || code === 'undo.target_ambiguous' ||
         code === 'undo.unsupported_operation' || code === 'undo.invalid_entity'
       ) return Response.json({ code, message: 'Undo target could not be verified.' }, { status: 409 });
       if (code === 'agent.audit_unavailable' || code === 'agent.persistence_unavailable') return Response.json({ code: 'agent.persistence_unavailable', message: 'Undo verification is not available.' }, { status: 503 });
       return Response.json({ code: "agent.verify_failed", message: "Não foi possível verificar o alvo agora." }, { status: 502 });
     }
   }

  /**
   * debt-undo-proposal-rehydration: read-only active-listing for chat
   * startup/workspace change (`GET /rpc/undo/active`). Identity SOLELY from
   * the gateway-verified headers; returns ONLY bound live summaries
   * (`proposed` + truthful `executing`, safe projection — never targets,
   * keys or raw operation data). Never previews, never calls the undo API,
   * never decides: the `api` dependency throws if ever touched.
   */
  private async handleUndoActive(request: Request): Promise<Response> {
    const actorId = request.headers.get("x-agent-actor")?.trim();
    const workspaceId = request.headers.get("x-agent-workspace")?.trim();
    const deviceId = request.headers.get("x-agent-device")?.trim();
    if (!actorId || !workspaceId || !deviceId) {
      return Response.json({ code: "agent.approval_context_required" }, { status: 401 });
    }
    const store = this.undoStoreForRequest();
    if (!store) {
      return Response.json({ code: "agent.persistence_unavailable", message: "Undo storage is not available" }, { status: 503 });
    }
    const service = new UndoProposalService({
      store,
      preview: () => {
        throw Object.assign(new Error('agent.rehydration_read_only'), { code: 'agent.rehydration_read_only' });
      },
      api: {
        undo: async () => {
          throw Object.assign(new Error('agent.rehydration_read_only'), { code: 'agent.rehydration_read_only' });
        },
      },
    });
    try {
      const items = service.listActive({ workspaceId, actorId, deviceId });
      return Response.json({ items, total: items.length });
    } catch {
      return Response.json({ code: "agent.approval_failed", message: "Não foi possível carregar as propostas agora." }, { status: 502 });
    }
  }

  private async enqueueChat<T>(task: () => Promise<T>): Promise<T> {
    const prev = this.chatQueue ?? Promise.resolve();
    const next = prev.then(() => task(), () => task());
    this.chatQueue = next;
    return next;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // H-07 defense in depth: the gateway authenticates and stamps
    // x-agent-actor/workspace, but the DO never trusts those headers alone
    // when the connection token is present — the token signature is
    // re-verified here and its claims must match the stamped identity.
    // (Signature-only: single-use consumption already happened at the
    // gateway, so this performs no network call.)
    if (url.pathname.startsWith("/rpc/")) {
      const bindingError = await this.assertConnectionBinding(request);
      if (bindingError) return bindingError;
    }
    const activeMatch = url.pathname === "/rpc/pending-operations/active" && request.method === "GET";
    if (activeMatch) {
      return this.handleActivePendingOperations(request);
    }
    const decisionMatch = url.pathname.match(/^\/rpc\/pending-operations\/([^/]+)\/decision$/);
    if (decisionMatch && request.method === "POST") {
      return this.handleApprovalDecision(request, decodeURIComponent(decisionMatch[1]!));
    }
    // debt-undo-proposal-rehydration: read-only active listing for chat
    // startup/workspace change (identity from verified headers only).
    if (url.pathname === "/rpc/undo/active" && request.method === "GET") {
      return this.handleUndoActive(request);
    }
    // debt-undo-confirmation-protocol: separate undo decision RPC (strict
    // {decision,requestId} body, identity from verified headers only).
    if (url.pathname === "/rpc/undo/decision" && request.method === "POST") {
      return this.handleUndoDecision(request);
    }
    // closure-undo-verify: read-only target check for a proposed undo
    // (strict {expectedEntity} body, identity from verified headers only).
    const undoVerifyMatch = url.pathname.match(/^\/rpc\/undo\/([^/]+)\/verify-target$/);
    if (undoVerifyMatch && request.method === "POST") {
      return this.handleUndoVerifyTarget(request, decodeURIComponent(undoVerifyMatch[1]!));
    }
    if (url.pathname === "/rpc/chat" && request.method === "POST") {
      const actorId = request.headers.get("x-agent-actor");
      const workspaceId = request.headers.get("x-agent-workspace");
      if (!actorId || !workspaceId || !actorId.trim() || !workspaceId.trim()) {
        return Response.json({ code: "agent.unauthorized", message: "Missing authenticated actor or workspace" }, { status: 401 });
      }
      // C-06: effective identity — built ONCE from the gateway-verified
      // headers (assertConnectionBinding already ran above) and frozen.
      // Any `actorId`/`actor_id` field in the client JSON body is IGNORED
      // for identity (spoof-tested): memory, tools, audit, export and
      // compaction only ever receive this struct's fields.
      const identity = Object.freeze({
        actorId,
        workspaceId,
        role: (request.headers.get("x-agent-role") === "owner" ? "owner" : "member") as "owner" | "member",
      });
      // H-12: device binding — gateway-stamped (x-agent-device) and
      // cross-checked against the connection token claims in
      // assertConnectionBinding above; never a free client header.
      const deviceHeader = request.headers.get("x-agent-device")?.trim();
      const deviceId = deviceHeader ? deviceHeader : undefined;

      let body: { text?: unknown; content?: unknown; intentionId?: unknown; messageId?: unknown; attachments?: unknown };
      try {
        body = (await request.json()) as { text?: unknown; content?: unknown; intentionId?: unknown; attachments?: unknown };
      } catch {
        return Response.json({ code: "agent.invalid_message" }, { status: 400 });
      }
      // FIX-FINAL-2 FINDING 2: semantic payload caps — fail fast with 413
      // (same code as the gateway ceiling) before scrubbing, persistence,
      // or any model call.
      const candidateText = typeof body.text === "string" ? body.text : (typeof body.content === "string" ? body.content : "");
      if (candidateText.length > MAX_CHAT_TEXT_CHARS) {
        return Response.json({ code: "agent.payload_too_large", message: `Chat text exceeds ${MAX_CHAT_TEXT_CHARS} characters` }, { status: 413 });
      }
      if (Array.isArray(body.attachments) && body.attachments.length > MAX_CHAT_ATTACHMENTS) {
        return Response.json({ code: "agent.payload_too_large", message: `Attachments exceed ${MAX_CHAT_ATTACHMENTS} items` }, { status: 413 });
      }
      const rawText = typeof body.text === "string" ? body.text : (typeof body.content === "string" ? body.content : "");
      const unredactedText = rawText.trim();
      // H-09: attachments persist as METADATA ONLY — inline content and
      // data: URLs are dropped before anything becomes durable.
      const { attachments: incomingAttachments } = scrubAttachments(body.attachments);
      if (!unredactedText && incomingAttachments.length === 0) return Response.json({ code: "agent.invalid_message" }, { status: 400 });
      // H-09: central DLP scrub before the text becomes durable (transcript,
      // memory, summary, learning, export all read this value downstream).
      const text = unredactedText ? scrubForPersistence(unredactedText) : incomingAttachments.length > 0 ? `[anexo ${incomingAttachments.map((a) => a.name).join(", ")}]` : "";
      // SPEC §7.7/§7.7.1: the intentionId derives deterministically from the
      // PWA messageId (intentionId field, or messageId alias). No
      // Date.now()/random fallback: a redelivery after a lost response
      // carries the same id and dedups to the same proposal downstream.
      const intentionId = typeof body.intentionId === "string" && body.intentionId.trim()
        ? body.intentionId.trim()
        : typeof body.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : "";
      if (!intentionId || intentionId.length > 128) {
        return Response.json({ code: "agent.invalid_message" }, { status: 400 });
      }

      const restInput = normalizeRestTurn(
        { ...body, text, intentionId, attachments: incomingAttachments },
        {
          actorId: identity.actorId,
          workspaceId: identity.workspaceId,
          role: identity.role,
          deviceId,
        } satisfies AuthenticatedIdentity,
      );
      if (typeof this.persistMessages !== 'function') {
        return Response.json({ code: 'agent.persistence_unavailable', message: 'SDK persistence is not available' }, { status: 503 });
      }
      try {
        const mutationPlan = this.mutationProposalPlan(restInput);
        // SPEC §7.8: a bare continuation answer ("Nubank") carries no
        // mutation plan, but with a recoverable draft it still needs the
        // mutation client + reader so the turn can complete the handoff.
        const draftStore = this.draftStoreForRequest();
        const hasPendingDraft = draftStore
          ? hasRecoverableDraft(
            draftStore,
            { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: deviceId ?? null },
            Date.now(),
          )
          : false;
        // T1.5 (SPEC §8): decision turns (confirmation/cancel/retry) build
        // the same MutationApiClient as proposals — the orchestrator's
        // coordinator needs the transport even when no draft exists.
        const routed = routeIntent(text);
        const needsMutation = mutationPlan !== null || hasPendingDraft
          || routed.mode === 'confirmation' || routed.mode === 'cancel'
          || isRetryText(text);
        const mutationApiClient = await this.mutationApiClientForTurn(restInput, needsMutation);
        const entityReader = needsMutation ? await this.entityReaderForTurn(restInput) : undefined;
        const turnResult = await this.orchestratorForChannel({
          ...(mutationPlan ? { plan: () => mutationPlan } : {}),
          ...(mutationApiClient ? { mutationApiClient } : {}),
          autoExecutionClient: () => this.elevatedMutationApiClientForTurn(restInput),
          ...(entityReader ? { entityReader } : {}),
          ...(draftStore ? { draftStore } : {}),
        }).runTurn(restInput);
        if (turnResult.response) {
          // Persist the FINAL grounded/deterministic response (never the raw
          // relay text: grounding may have rejected or replaced the provider
          // output, and /rpc/history serves exactly what is persisted here).
          // Mutation modes never reach the response provider (no user message
          // was persisted for them either), so their historical
          // non-persistence is preserved unchanged.
          if (turnResult.plan.mode !== 'mutation-proposal' && turnResult.plan.mode !== 'confirmation' && turnResult.plan.mode !== 'cancel') {
            // T3.1 (SPEC §14): a fail-closed read never reaches the response
            // provider, which is where the user message is otherwise
            // persisted — persist it here so history keeps the Q&A pair
            // (fail-closed only ever happens on the read path, so mutation
            // non-persistence above is unaffected).
            if (turnResult.failClosed) {
              const failClosedUserMessage: UIMessage = {
                id: `msg-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'user',
                parts: [{ type: 'text', text: restInput.text }],
                metadata: { actorId: identity.actorId, workspaceId: identity.workspaceId, createdAt: new Date().toISOString() },
              } as unknown as UIMessage;
              await this.persistMessages([failClosedUserMessage]);
            }
            const assistantMessage: UIMessage = {
              id: `msg-asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: 'assistant',
              parts: [{ type: 'text', text: turnResult.response.text }],
              metadata: { actorId: 'ted', workspaceId: identity.workspaceId, createdAt: new Date().toISOString() },
            } as unknown as UIMessage;
            await this.persistMessages([assistantMessage]);
          }
          const pendingOperation = turnResult.mutation
            ? {
                id: turnResult.mutation.operationId,
                status: turnResult.mutation.status,
                operation: turnResult.plan.requestedOperations[0]?.name,
                summary: turnResult.response.text,
                // T3.4 (SPEC §16): the safe card projection derived from the
                // canonical args. Re-validated here so only schema-conformant
                // display fields cross to the browser (attestation can never
                // ride along — the strict schema rejects it).
                ...(() => {
                  const presentation = (turnResult.mutation as { presentation?: unknown }).presentation;
                  if (!presentation) return {};
                  const parsed = pendingOperationPresentationSchema.safeParse(presentation);
                  return parsed.success ? { presentation: parsed.data } : {};
                })(),
                // T3.3 (SPEC §15.1): the REAL execution receipt relayed from
                // the API on succeeded turns. Re-validated with the strict
                // contract schema — a receipt carrying attestation or any
                // unknown key is dropped, never partially forwarded.
                ...(() => {
                  const receipt = (turnResult.mutation as { receipt?: unknown }).receipt;
                  if (!receipt) return {};
                  const parsed = mutationReceiptSchema.safeParse(receipt);
                  return parsed.success ? { receipt: parsed.data } : {};
                })(),
              }
            : undefined;
          return Response.json({ status: "completed", output: turnResult.response.text, ...(pendingOperation ? { pendingOperation } : {}),
            // debt-undo-confirmation-protocol: separate undo proposal relay
            // (requestId for the decision RPC; the fixed target never leaves
            // the DO). Re-validated shape — unknown keys are dropped.
            ...(() => {
              const proposal = (turnResult as { undoProposal?: unknown }).undoProposal as { requestId?: unknown; status?: unknown; expiresAt?: unknown } | undefined;
              if (!proposal || typeof proposal.requestId !== 'string' || proposal.status !== 'proposed' || typeof proposal.expiresAt !== 'string') return {};
              return { undoProposal: { requestId: proposal.requestId, status: 'proposed' as const, expiresAt: proposal.expiresAt } };
            })(),
          });
        }
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const code = (error as { code?: unknown }).code;
        if (typeof status === 'number' && status >= 400 && status < 600) {
          return Response.json({ code: typeof code === 'string' ? code : 'agent.inference_error', message: redactTranscript((error as Error).message) }, { status });
        }
        return Response.json({ code: 'agent.inference_error', message: 'Falha ao processar a solicitação.' }, { status: 502 });
      }

      return Response.json({ code: 'agent.no_response', message: 'Não foi possível produzir uma resposta segura.' }, { status: 502 });

    }

    // Part B: memory privacy toggle (workspace-scoped, ON by default).
    if (url.pathname === "/rpc/memory/prefs" && request.method === "POST") {
      const actorId = request.headers.get("x-agent-actor");
      const workspaceId = request.headers.get("x-agent-workspace");
      if (!actorId || !workspaceId || !actorId.trim() || !workspaceId.trim()) {
        return Response.json({ code: "agent.unauthorized", message: "Missing authenticated actor or workspace" }, { status: 401 });
      }
      // C-06: frozen effective identity (headers verified by the gateway).
      const identity = Object.freeze({ actorId, workspaceId });
      const sql = this.memorySql();
      if (!sql) {
        return Response.json({ code: "agent.persistence_unavailable", message: "Memory storage is not available" }, { status: 503 });
      }
      let enabled = true;
      try {
        const body = (await request.json()) as { enabled?: unknown };
        if (typeof body.enabled !== 'boolean') {
          return Response.json({ code: "agent.invalid_message" }, { status: 400 });
        }
        enabled = body.enabled;
      } catch {
        return Response.json({ code: "agent.invalid_message" }, { status: 400 });
      }
      setMemoryEnabled(sql, identity.workspaceId, enabled);
      return Response.json({ ok: true, enabled });
    }

    // Part B: "Nova sessão" — archives the current session (count + best-
    // effort summary) into the registry, clears the model context (SDK
    // messages), and starts a fresh session. Stored history rows are
    // preserved in the registry summary; durable memories are untouched.
    if (url.pathname === "/rpc/session/new" && request.method === "POST") {
      const actorId = request.headers.get("x-agent-actor");
      const workspaceId = request.headers.get("x-agent-workspace");
      if (!actorId || !workspaceId || !actorId.trim() || !workspaceId.trim()) {
        return Response.json({ code: "agent.unauthorized", message: "Missing authenticated actor or workspace" }, { status: 401 });
      }
      // C-06: frozen effective identity (headers verified by the gateway).
      const identity = Object.freeze({ actorId, workspaceId });
      const sql = this.memorySql();
      if (!sql) {
        return Response.json({ code: "agent.persistence_unavailable", message: "Session storage is not available" }, { status: 503 });
      }
      const turns = this.sdkTurns();
      const messageCount = turns.length;
      let summary: string | null = null;
      if (messageCount > 0) {
        try {
          summary = extractiveSummary(turns);
        } catch {
          summary = null;
        }
      }
      // Ensure a registry row exists even for the very first session, so the
      // archived history is never lost when no session was opened before.
      // Empty renewals only reset the context without archiving noise.
      let previous: { id: string } | null = null;
      if (messageCount > 0) {
        currentSession(sql, identity.workspaceId, identity.actorId);
        previous = endSession(sql, identity.workspaceId, identity.actorId, {
          ...(summary ? { summary } : {}),
          messageCount,
        });
      }
      try {
        // SDK coupling (documented): the messages table is SDK-internal.
        sql.exec(`DELETE FROM cf_ai_chat_agent_messages`);
      } catch {
        // Best effort: a fresh session id is still returned.
      }
      if (Array.isArray(this.messages)) this.messages.length = 0;
      const next = currentSession(sql, identity.workspaceId, identity.actorId);
      return Response.json({
        ok: true,
        sessionId: next.id,
        previousSessionId: previous?.id ?? null,
        messageCount,
        summarized: summary !== null,
      });
    }

    if (url.pathname === "/rpc/history" && request.method === "GET") {
      const actorId = request.headers.get("x-agent-actor");
      const workspaceId = request.headers.get("x-agent-workspace");
      if (!actorId || !workspaceId || !actorId.trim() || !workspaceId.trim()) {
        return Response.json({ code: "agent.unauthorized", message: "Missing authenticated actor or workspace" }, { status: 401 });
      }
      // C-06: frozen effective identity (headers verified by the gateway).
      const identity = Object.freeze({ actorId, workspaceId });

      const allMessages = Array.isArray(this.messages) ? this.messages : [];
      // Isolamento por workspace: filtrar mensagens cujo workspaceId difere (defesa em profundidade, DO já é por workspace)
      const rawMessages = allMessages.filter((msg) => {
        const ws = (msg.metadata as { workspaceId?: string } | undefined)?.workspaceId;
        return !ws || ws === identity.workspaceId;
      });

      const items = rawMessages.map((msg) => {
        const msgActorId = (msg.metadata as { actorId?: string } | undefined)?.actorId ?? (msg.role === "assistant" ? "ted" : "unknown");
        let contentText = "";
        if (Array.isArray(msg.parts)) {
          contentText = msg.parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
        }
        const isOwn = msg.role === "user" && msgActorId === identity.actorId;
        const createdAt = (msg.metadata as { createdAt?: string } | undefined)?.createdAt ?? undefined;
        const attachments = (msg.metadata as { attachments?: Array<{ type: string; url: string; name: string }> } | undefined)?.attachments;
        return {
          id: String(msg.id ?? `msg-${Date.now()}`),
          actorId: msgActorId,
          role: String(msg.role ?? "user"),
          content: contentText,
          text: contentText,
          createdAt: typeof createdAt === "string" ? createdAt : undefined,
          isOwn,
          ...(attachments ? { attachments } : {}),
        };
      });

      items.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeA - timeB;
      });

      return Response.json({ items, total: items.length });
    }

    return new Response("Not found", { status: 404 });
  }

  async importLegacyHistory(exportData: LegacyFullExport): Promise<MigrationResult> {
    return this.enqueueChat(async () => {
      if (typeof this.persistMessages !== "function") {
        return {
          success: false,
          importedCount: 0,
          skipped: false,
          reason: "missing_persist_callback: SDK persistMessages is required for durable history migration",
        };
      }

      const persistCallback = async (msgs: SdkUIMessage[]): Promise<void> => {
        await this.persistMessages(msgs);
      };

      const migrationSql = this.durableSql();
      if (migrationSql) {
        return migrateLegacyHistory(exportData, migrationSql, persistCallback);
      }

      if (exportData.hasInFlightTurns) {
        return {
          success: false,
          importedCount: 0,
          skipped: false,
          reason: "migration_blocked_turns_in_flight: workspace has active turns in queued/running state",
        };
      }

      // Fail-closed without durable SQLite: the idempotency marker
      // (_history_migration_marker) cannot be stored, so persisting history
      // would duplicate on retry. Never persist nor claim success here.
      return {
        success: false,
        importedCount: 0,
        skipped: false,
        reason: "missing_durable_marker_store: durable SQLite marker storage is unavailable, history not persisted",
      };
    });
  }
}
