/**
 * TED V2 behavioral regression engine (SPEC AGENT-011).
 *
 * Executes matrix scenarios against the REAL agent modules with deterministic
 * fakes — never literal response-text equality. Every assertion targets a
 * behavior PROPERTY: route taken, tool selected, args normalized, confirmation
 * required, mutation executed count, claim rejected/absent, error code.
 *
 * Seams (public interfaces only, no src/** edits here):
 * - intent router + turn-plan validation: routeIntent, validateTurnPlan
 * - provider-output gate: validateProviderOutput (provider-adapter)
 * - channel normalization: normalizeRestTurn/SdkTurn/BrokerTurn
 * - mutation parsing: parseFinancialMutation
 * - confirmation text: resolveConfirmation
 * - entity disambiguation: resolveEntity
 * - proposal/confirmation flow: ConversationOrchestrator + MutationApiClient
 *   with a fake pending-operations API (in-memory, binding-checked)
 * - replay/incomplete attestation: MutationExecutor with fake transport
 * - evidence/grounding: createEvidenceEnvelope, collectEvidence,
 *   isCurrentEvidence, validateGroundedClaims, createGroundedResponseWithRetry
 *
 * NOTE on two honest seams:
 * - The production planner is an LLM. Scenarios that need a
 *   `mutation-proposal` / `memory` / `advice` plan pass it via `planOverride`
 *   (the same TurnPlan shape the planner must produce); the proposal,
 *   confirmation, grounding and rendering behavior under test is 100% real.
 * - `routeIntent` never emits `memory`/`advice` modes and the SDK/broker
 *   auth-context wiring lives in the channel call sites (parallel task);
 *   normalize scenarios therefore assert header-wins identity, the stable
 *   contract of the normalizers.
 */

import { routeIntent } from '../src/orchestration/intent-router.js';
import { validateTurnPlan } from '../src/orchestration/turn-plan.js';
import { validateProviderOutput } from '../src/orchestration/provider-adapter.js';
import {
  ConversationOrchestrator,
  normalizeBrokerTurn,
  normalizeRestTurn,
  normalizeSdkTurn,
  type AuthenticatedIdentity,
  type TurnPlan,
} from '../src/orchestration/conversation-orchestrator.js';
import { SKILL_INVENTORY } from '../src/orchestration/skill-inventory.js';
import { parseFinancialMutation } from '../src/mutations/financial-parser.js';
import { resolveConfirmation } from '../src/mutations/confirmation-resolver.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { MutationExecutor } from '../src/mutations/mutation-executor.js';
import { MUTATION_EFFECTS_REGISTRY } from '@pi-finance/llm-contracts';
import { resolveEntity, EntityResolutionError } from '../src/tools/entity-resolution.js';
import type { EntityReader } from '../src/mutations/entity-resolver.js';
import { createEvidenceEnvelope, isCurrentEvidence } from '../src/evidence/evidence-envelope.js';
import { collectEvidence } from '../src/evidence/evidence-collector.js';
import { validateGroundedClaims } from '../src/evidence/grounding-validator.js';
import { createGroundedResponseWithRetry } from '../src/responses/grounded-response.js';

export const SPEC_CATEGORIES = [
  'consultas',
  'mutações',
  'segurança/aprovação',
  'ambiguidades',
  'indisponibilidades',
  'conversação/memória',
] as const;
export type SpecCategory = (typeof SPEC_CATEGORIES)[number];

export const SPEC_MINIMUMS: Record<SpecCategory, number> = {
  consultas: 10,
  mutações: 12,
  'segurança/aprovação': 10,
  ambiguidades: 8,
  indisponibilidades: 5,
  'conversação/memória': 5,
};

export const EXEC_KINDS = [
  'router', 'plan', 'provider-output', 'normalize', 'parse', 'confirm', 'resolve',
  'orch-propose', 'orch-confirm', 'orch-idempotency', 'orch-read', 'orch-chat',
  'ground', 'evidence', 'executor',
] as const;
export type ExecKind = (typeof EXEC_KINDS)[number];

export interface BehavioralScenario {
  id: string;
  specCategory: string;
  exec: Record<string, unknown>;
  expect: Record<string, unknown>;
}

export interface ScenarioOutcome {
  id: string;
  specCategory: string;
  passed: boolean;
  detail: string;
}

export interface MatrixReport {
  total: number;
  passed: number;
  failed: number;
  byCategory: Record<string, { total: number; passed: number }>;
  failures: ScenarioOutcome[];
  results: ScenarioOutcome[];
}

const INVENTORY_TOOLS = new Set(SKILL_INVENTORY.flatMap((skill) => [...skill.tools]));

const DEFAULT_IDENTITY: AuthenticatedIdentity = {
  actorId: 'actor-eval',
  workspaceId: 'workspace-eval',
  role: 'member',
  deviceId: 'device-eval',
};

const freshTs = (): string => new Date().toISOString();

class EvalAssertion extends Error {}

const eq = (actual: unknown, expected: unknown, label: string, id: string): void => {
  if (actual !== expected) {
    throw new EvalAssertion(`${id}: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const ok = (condition: boolean, label: string, id: string, extra?: unknown): void => {
  if (!condition) {
    throw new EvalAssertion(`${id}: ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
};

const expectCode = (error: unknown, code: string, id: string): void => {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = (error as { code?: unknown } | null)?.code;
  ok(message.includes(code) || errorCode === code, `expected error containing "${code}"`, id, message);
};

/* ------------------------------------------------------------------ */
/* Fake pending-operations API (deterministic, binding-checked).       */
/* ------------------------------------------------------------------ */

type SeedOperation = {
  id: string;
  workspaceId: string;
  actorId: string;
  deviceId: string;
  status?: string;
  expiresAt?: string;
  tool?: string;
};

type FakeApiOptions = {
  seed?: SeedOperation[];
  mode?: 'ok' | 'hash-mismatch' | 'execute-incomplete' | 'confirm-missing-attestation';
};

type FakeApi = {
  request: (method: string, path: string, opts?: Record<string, unknown>) => Promise<unknown>;
  calls: { propose: number; confirm: number; execute: number };
  lastProposeBody: Record<string, unknown> | null;
  attestationFor: (id: string) => string | null;
};

const attestationFor = (id: string): string => `att-${id}-${'x'.repeat(56)}`.slice(0, 64);

const createFakePendingApi = (options: FakeApiOptions = {}): FakeApi => {
  const mode = options.mode ?? 'ok';
  const store = new Map<string, { bindings: { workspaceId: string; actorId: string; deviceId: string }; expiresAt: string; status: string; tool: string; normalizedArgs: unknown; idempotencyKey: string }>();
  const byIdempotency = new Map<string, string>();
  for (const seed of options.seed ?? []) {
    store.set(seed.id, {
      bindings: { workspaceId: seed.workspaceId, actorId: seed.actorId, deviceId: seed.deviceId },
      expiresAt: seed.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
      status: seed.status ?? 'pending',
      tool: seed.tool ?? 'transactions.income.create',
      normalizedArgs: {},
      idempotencyKey: `seed-${seed.id}`,
    });
  }
  let counter = 0;
  const calls = { propose: 0, confirm: 0, execute: 0 };
  let lastProposeBody: Record<string, unknown> | null = null;

  const headersOf = (opts?: Record<string, unknown>): { workspaceId: string; actorId: string; deviceId: string } => {
    const headers = (opts?.headers ?? {}) as Record<string, unknown>;
    return {
      workspaceId: String(headers['x-workspace-id'] ?? ''),
      actorId: String(headers['x-actor-id'] ?? ''),
      deviceId: String(headers['x-device-id'] ?? ''),
    };
  };

  const request = async (method: string, path: string, opts: Record<string, unknown> = {}): Promise<unknown> => {
    // T1.5 (SPEC §8.3): authoritative listing. The fake mirrors the real
    // API vocabulary loosely ('pending' → proposed, 'approved' → confirmed)
    // and enforces the same identity scope + terminal-state exclusion.
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      const headers = headersOf(opts);
      const items = [...store.entries()]
        .filter(([, operation]) =>
          operation.bindings.workspaceId === headers.workspaceId &&
          operation.bindings.actorId === headers.actorId &&
          operation.bindings.deviceId === headers.deviceId)
        .filter(([, operation]) => ['pending', 'approved', 'failed'].includes(operation.status))
        .map(([id, operation]) => {
          const args = (operation.normalizedArgs ?? {}) as Record<string, unknown>;
          return {
            id,
            status: operation.status === 'approved' ? 'confirmed' : operation.status === 'failed' ? 'failed' : 'proposed',
            tool: operation.tool,
            createdAt: freshTs(),
            expiresAt: operation.expiresAt,
            ...(typeof args.amountCents === 'number' ? { amountCents: args.amountCents } : {}),
            ...(typeof args.description === 'string' ? { description: args.description } : {}),
          };
        });
      return { items, total: items.length };
    }
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      calls.propose += 1;
      const body = (opts.body ?? {}) as Record<string, unknown>;
      lastProposeBody = body;
      const key = String(opts.idempotencyKey ?? '');
      const existing = byIdempotency.get(key);
      if (existing) return { id: existing };
      counter += 1;
      const id = `pending-eval-${counter}`;
      const headers = headersOf(opts);
      store.set(id, {
        bindings: headers,
        expiresAt: String(body.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString()),
        status: 'pending',
        tool: String(body.tool ?? 'transactions.income.create'),
        normalizedArgs: body.normalizedArgs ?? {},
        idempotencyKey: key,
      });
      byIdempotency.set(key, id);
      return { id };
    }
    const confirmMatch = /^\/pending-operations\/v2\/([^/]+)\/confirm$/.exec(path);
    if (method === 'POST' && confirmMatch) {
      calls.confirm += 1;
      const id = decodeURIComponent(confirmMatch[1]!);
      const operation = store.get(id);
      if (!operation) throw new Error('approval.not_found');
      if (operation.status === 'cancelled') throw new Error('approval.cancelled');
      if (Date.parse(operation.expiresAt) <= Date.now()) throw new Error('approval.expired');
      const headers = headersOf(opts);
      if (headers.workspaceId !== operation.bindings.workspaceId) throw new Error('approval.binding_mismatch');
      if (headers.actorId !== operation.bindings.actorId) throw new Error('approval.binding_mismatch');
      if (headers.deviceId !== operation.bindings.deviceId) throw new Error('approval.binding_mismatch');
      if (mode === 'hash-mismatch') throw new Error('approval.hash_mismatch');
      if (mode === 'confirm-missing-attestation') return { id };
      return { id, attestation: attestationFor(id) };
    }
    const executeMatch = /^\/pending-operations\/v2\/([^/]+)\/execute$/.exec(path);
    if (method === 'POST' && executeMatch) {
      calls.execute += 1;
      const id = decodeURIComponent(executeMatch[1]!);
      const operation = store.get(id);
      if (!operation) throw new Error('approval.not_found');
      const body = (opts.body ?? {}) as Record<string, unknown>;
      if (body.attestation !== attestationFor(id)) throw new Error('approval.invalid_attestation');
      if (mode === 'execute-incomplete') return { id, status: 'failed' };
      operation.status = 'succeeded';
      // Faithful store-record shape: top-level `id` is the pending-operation
      // id; `execution.operationId` names the persisted transaction and the
      // receipt links both (receipt.operationId = pending id,
      // receipt.entity = { type: 'transaction', id: transaction id }) with
      // registry-derived kind/targets — the shape MutationExecutor validates.
      const transactionId = `mut-${id}`;
      const registryEntry = (MUTATION_EFFECTS_REGISTRY as Record<string, { affectedTargets: readonly string[] } | undefined>)[operation.tool];
      const receiptKind = registryEntry !== undefined ? operation.tool : 'transactions.income.create';
      const receiptTargets =
        registryEntry !== undefined
          ? [...registryEntry.affectedTargets]
          : [...MUTATION_EFFECTS_REGISTRY['transactions.income.create'].affectedTargets];
      return {
        id,
        status: 'succeeded',
        execution: {
          status: 'succeeded',
          operationId: transactionId,
          receipt: {
            mutationId: transactionId,
            mutationKind: receiptKind,
            status: 'succeeded',
            affectedTargets: receiptTargets,
            operationId: id,
            entity: { type: 'transaction', id: transactionId },
          },
        },
      };
    }
    throw new Error(`fake-api.unexpected:${method}:${path}`);
  };

  return { request: request as FakeApi['request'], calls, get lastProposeBody() { return lastProposeBody; }, attestationFor: (id) => (store.has(id) ? attestationFor(id) : null) };
};

const silent = (): void => undefined;

/* ------------------------------------------------------------------ */
/* Per-kind executors. Each returns a one-line detail for the report.  */
/* ------------------------------------------------------------------ */

const runRouter = (scenario: BehavioralScenario): string => {
  const { id, exec, expect } = scenario;
  const plan = routeIntent(String(exec.utterance ?? ''));
  const validated = validateTurnPlan(plan);
  ok(validated.success, 'router must always emit a valid turn plan', id);
  if (expect.mode !== undefined) eq(plan.mode, expect.mode, 'plan.mode', id);
  if (expect.domain !== undefined) eq(plan.domain, expect.domain, 'plan.domain', id);
  if (expect.operationNames !== undefined) {
    eq(JSON.stringify(plan.requestedOperations.map((operation) => operation.name)), JSON.stringify(expect.operationNames), 'requestedOperations', id);
  }
  if (expect.opsMax !== undefined) ok(plan.requestedOperations.length <= Number(expect.opsMax), 'operations bound', id, plan.requestedOperations.length);
  if (expect.skillsMax !== undefined) ok(plan.skillNames.length <= Number(expect.skillsMax), 'skills bound', id, plan.skillNames.length);
  const tools = (plan as { requestedTools?: readonly string[] }).requestedTools ?? [];
  if (expect.toolsMax !== undefined) ok(tools.length <= Number(expect.toolsMax), 'tools bound', id, tools.length);
  for (const tool of tools) ok(INVENTORY_TOOLS.has(tool), 'emitted tool inside canonical inventory', id, tool);
  if (expect.allReads === true) ok(plan.requestedOperations.every((operation) => operation.kind === 'read'), 'no mutation op on read path', id);
  return `mode=${plan.mode} domain=${plan.domain} ops=${plan.requestedOperations.length} skills=${plan.skillNames.length} tools=${tools.length}`;
};

const runPlan = (scenario: BehavioralScenario): string => {
  const { id, exec, expect } = scenario;
  const result = validateTurnPlan(exec.candidate);
  eq(result.success, expect.valid === true, 'plan validity', id);
  if (!result.success) ok(result.clarification.trim().length > 0, 'invalid plan carries clarification', id);
  return result.success ? 'valid' : `invalid (${result.clarification.slice(0, 48)}…)`;
};

const runProviderOutput = (scenario: BehavioralScenario): string => {
  const { id, exec, expect } = scenario;
  try {
    const validated = validateProviderOutput(exec.payload as Parameters<typeof validateProviderOutput>[0]);
    if (expect.errorCode !== undefined) throw new EvalAssertion(`${id}: expected rejection "${expect.errorCode}", provider output was accepted`);
    if (expect.mode !== undefined) eq(validated.plan.mode, expect.mode, 'plan.mode', id);
    return `accepted mode=${validated.plan.mode} source=${validated.source}`;
  } catch (error) {
    if (error instanceof EvalAssertion) throw error;
    if (expect.errorCode === undefined) throw new EvalAssertion(`${id}: unexpected provider rejection — ${(error as Error).message}`);
    expectCode(error, String(expect.errorCode), id);
    return `rejected (${(error as Error).message})`;
  }
};

const runNormalize = (scenario: BehavioralScenario): string => {
  const { id, exec, expect } = scenario;
  const identity = (exec.identity ?? DEFAULT_IDENTITY) as AuthenticatedIdentity;
  const body = (exec.body ?? {}) as Record<string, unknown>;
  const channel = String(exec.channel ?? 'pwa-rest');
  // SPEC §7.7: production turns always carry the PWA messageId. Fixture
  // bodies that predate it get a deterministic scenario-scoped id so the
  // harness exercises identity precedence, not the missing-id rejection
  // (covered separately by turn-idempotency.test.ts).
  const withId = body.intentionId ?? body.messageId ?? body.traceId ? body : { ...body, intentionId: `${id}-intent` };
  const input = channel === 'sdk' ? normalizeSdkTurn(withId, identity) : channel === 'broker' ? normalizeBrokerTurn(withId, identity) : normalizeRestTurn(withId, identity);
  if (expect.actorId !== undefined) eq(input.actorId, expect.actorId, 'actorId from verified identity', id);
  if (expect.workspaceId !== undefined) eq(input.workspaceId, expect.workspaceId, 'workspaceId from verified identity', id);
  if (expect.channel !== undefined) eq(input.channel, expect.channel, 'channel', id);
  if (expect.frozen === true) ok(Object.isFrozen(input), 'turn input immutable', id);
  return `actor=${input.actorId} workspace=${input.workspaceId} channel=${input.channel}`;
};

const runParse = (scenario: BehavioralScenario): string => {
  const { id, exec, expect } = scenario;
  const parsed = parseFinancialMutation(
    String(exec.utterance ?? ''),
    exec.now !== undefined ? { now: new Date(String(exec.now)), timeZone: String(exec.timeZone ?? 'America/Sao_Paulo') } : {},
  );
  if (expect.kind !== undefined) eq(parsed.kind, expect.kind, 'parsed kind', id);
  if (expect.amountCents !== undefined) eq((parsed as { amountCents?: unknown }).amountCents, expect.amountCents, 'amountCents', id);
  if (expect.reason !== undefined) eq((parsed as { reason?: unknown }).reason, expect.reason, 'block reason', id);
  if (expect.date !== undefined) eq((parsed as { date?: unknown }).date, expect.date, 'resolved date', id);
  return JSON.stringify(parsed);
};

const runConfirm = (scenario: BehavioralScenario): string => {
  const { id, exec, expect } = scenario;
  const decision = resolveConfirmation(String(exec.text ?? ''), (exec.pendingIds ?? []) as string[]);
  if (expect.decisionKind !== undefined) eq(decision.kind, expect.decisionKind, 'confirmation decision', id);
  if (expect.operationId !== undefined) eq(decision.operationId, expect.operationId, 'confirmed operation', id);
  return `decision=${decision.kind}${decision.operationId ? ` op=${decision.operationId}` : ''}`;
};

const runResolve = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const items = (exec.items ?? []) as { id: string; name: string }[];
  const fakeList = async (): Promise<unknown> => ({ items });
  try {
    const candidate = await resolveEntity({
      type: exec.type === 'category' ? 'category' : 'account',
      query: String(exec.query ?? ''),
      request: fakeList as Parameters<typeof resolveEntity>[0]['request'],
    });
    if (expect.errorCode !== undefined) throw new EvalAssertion(`${id}: expected "${expect.errorCode}", entity resolved to ${candidate.id}`);
    if (expect.resolvedId !== undefined) eq(candidate.id, expect.resolvedId, 'resolved entity', id);
    return `resolved ${candidate.id}`;
  } catch (error) {
    if (error instanceof EvalAssertion) throw error;
    if (expect.errorCode === undefined) throw new EvalAssertion(`${id}: unexpected resolution failure — ${(error as Error).message}`);
    expectCode(error, String(expect.errorCode), id);
    if (expect.candidateCount !== undefined) {
      eq(error instanceof EntityResolutionError ? error.candidates.length : -1, expect.candidateCount, 'candidate count', id);
    }
    return `blocked (${(error as Error).message})`;
  }
};

const mutationPlan = (mode: 'mutation-proposal' | 'confirmation'): TurnPlan => ({
  version: '2',
  mode,
  domain: 'transactions',
  skillNames: ['financial-mutations'],
  requestedOperations: [{ name: 'create_transaction', kind: 'mutation' }],
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

const runOrchPropose = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const identity = (exec.identity ?? DEFAULT_IDENTITY) as AuthenticatedIdentity;
  const utterances = (exec.utterances ?? (exec.utterance !== undefined ? [exec.utterance] : [])) as string[];
  const api = createFakePendingApi();
  const client = new MutationApiClient({ request: api.request as never, events: silent });
  // SPEC §7.2/§7.3: authoritative entity lists come from exec.entities, so
  // resolution is exercised against deterministic fakes, never guesses.
  const entities = (exec.entities ?? {}) as { accounts?: { id: string; name: string }[]; categories?: { id: string; name: string }[] };
  const entityReader: EntityReader = {
    listAccounts: async () => entities.accounts ?? [{ id: '00000000-0000-4000-8000-0000000000a1', name: 'Conta eval' }],
    listCategories: async () => entities.categories ?? [],
  };
  const orchestrator = new ConversationOrchestrator({ plan: () => mutationPlan('mutation-proposal'), mutationApiClient: client, entityReader, events: silent });
  // SPEC §7 (H-01): incomplete canonical args clarify with zero proposals.
  if (expect.clarified === true) {
    const result = await orchestrator.runTurn(normalizeRestTurn({ text: utterances[0] ?? '', intentionId: `${id}-intent-0` }, identity));
    ok(result.mutation === undefined, 'no proposal while canonical args are incomplete', id);
    ok(result.clarification !== undefined && result.response !== undefined, 'explicit clarification outcome', id);
    eq(api.calls.propose, 0, 'zero propose calls', id);
    if (expect.missingFields !== undefined) {
      eq(JSON.stringify(result.plan.missingFields), JSON.stringify(expect.missingFields), 'real missingFields', id);
    }
    return `clarified missing=${JSON.stringify(result.plan.missingFields)}`;
  }
  try {
    const operationIds: string[] = [];
    for (let index = 0; index < utterances.length; index += 1) {
      const result = await orchestrator.runTurn(normalizeRestTurn({ text: utterances[index], intentionId: `${id}-intent-${index}` }, identity));
      if (result.mutation?.status !== 'proposed' || !result.mutation.operationId) {
        throw new EvalAssertion(`${id}: turn ${index} did not yield a proposal`);
      }
      operationIds.push(result.mutation.operationId);
    }
    if (expect.proposed !== undefined) eq(true, expect.proposed === true, 'proposal presented', id);
    if (expect.proposals !== undefined) eq(operationIds.length, expect.proposals, 'proposal count', id);
    if (expect.confirmationRequired === true) {
      eq(api.calls.propose, operationIds.length, 'propose calls', id);
      eq(api.calls.execute, 0, 'no execution before confirmation', id);
    }
    if (expect.tool !== undefined) eq((api.lastProposeBody?.tool ?? null), expect.tool, 'proposed tool', id);
    if (expect.amountCents !== undefined) {
      eq((api.lastProposeBody?.normalizedArgs as { amountCents?: unknown } | undefined)?.amountCents, expect.amountCents, 'normalized amountCents', id);
    }
    return `proposed=${operationIds.join(',')} tool=${String(api.lastProposeBody?.tool ?? 'n/a')} executeCalls=${api.calls.execute}`;
  } catch (error) {
    if (error instanceof EvalAssertion) throw error;
    if (expect.throws === undefined) throw new EvalAssertion(`${id}: unexpected proposal failure — ${(error as Error).message}`);
    expectCode(error, String(expect.throws), id);
    return `blocked (${(error as Error).message})`;
  }
};

const runOrchConfirm = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const identity = (exec.identity ?? DEFAULT_IDENTITY) as AuthenticatedIdentity;
  const api = createFakePendingApi({ seed: (exec.seed ?? []) as SeedOperation[], mode: (exec.apiMode ?? 'ok') as FakeApiOptions['mode'] });
  const client = new MutationApiClient({ request: api.request as never, events: silent });
  const orchestrator = new ConversationOrchestrator({ plan: () => mutationPlan('confirmation'), mutationApiClient: client, events: silent });
  const result = await orchestrator.runTurn(
    normalizeRestTurn({ text: String(exec.text ?? 'sim'), intentionId: `${id}-confirm`, pendingOperationIds: (exec.pendingIds ?? []) as string[] }, identity),
  );
  if (expect.executed !== undefined) eq(result.mutation?.status === 'succeeded', expect.executed === true, 'execution outcome', id);
  if (expect.executeCalls !== undefined) eq(api.calls.execute, expect.executeCalls, 'execute calls', id);
  if (expect.confirmCalls !== undefined) eq(api.calls.confirm, expect.confirmCalls, 'confirm calls', id);
  if (expect.failureSafe === true) {
    // Fail-closed: no mutation is ever recorded and the turn still responds
    // safely. The authoritative transport MAY have been attempted (e.g. an
    // execution the API rejected) — what matters is nothing succeeded.
    ok(result.mutation === undefined, 'no mutation recorded on failure', id);
    ok(result.response !== undefined, 'safe failure still responds', id);
  }
  return `executed=${result.mutation?.status ?? 'none'} confirmCalls=${api.calls.confirm} executeCalls=${api.calls.execute}`;
};

const runOrchIdempotency = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const identity = (exec.identity ?? DEFAULT_IDENTITY) as AuthenticatedIdentity;
  const api = createFakePendingApi();
  const client = new MutationApiClient({ request: api.request as never, events: silent });
  const entities = (exec.entities ?? {}) as { accounts?: { id: string; name: string }[]; categories?: { id: string; name: string }[] };
  const entityReader: EntityReader = {
    listAccounts: async () => entities.accounts ?? [{ id: '00000000-0000-4000-8000-0000000000a1', name: 'Conta eval' }],
    listCategories: async () => entities.categories ?? [],
  };
  const proposePlan = () => mutationPlan('mutation-proposal');
  const proposeTurn = new ConversationOrchestrator({ plan: proposePlan, mutationApiClient: client, entityReader, events: silent });
  const first = await proposeTurn.runTurn(normalizeRestTurn({ text: String(exec.utterance ?? ''), intentionId: `${id}-idem` }, identity));
  const second = await proposeTurn.runTurn(normalizeRestTurn({ text: String(exec.utterance ?? ''), intentionId: `${id}-idem` }, identity));
  if (expect.sameOperation === true) eq(first.mutation?.operationId, second.mutation?.operationId, 'stable idempotency key', id);
  const confirmTurn = new ConversationOrchestrator({ plan: () => mutationPlan('confirmation'), mutationApiClient: client, events: silent });
  const confirmed = await confirmTurn.runTurn(
    normalizeRestTurn({ text: 'sim', intentionId: `${id}-idem-confirm`, pendingOperationIds: first.mutation?.operationId ? [first.mutation.operationId] : [] }, identity),
  );
  if (expect.executed !== undefined) eq(confirmed.mutation?.status === 'succeeded', expect.executed === true, 'single execution', id);
  if (expect.executeCalls !== undefined) eq(api.calls.execute, expect.executeCalls, 'execute calls', id);
  return `op=${first.mutation?.operationId} executed=${confirmed.mutation?.status ?? 'none'}`;
};

const toEnvelopeItems = (items: unknown): Parameters<typeof createEvidenceEnvelope>[0] => {
  const list = (items ?? []) as { ref: string; source: string; retrievedAt?: string; fresh?: boolean; status: string; data: unknown }[];
  return list.map((item) => ({
    ref: item.ref,
    source: item.source,
    retrievedAt: item.fresh === true ? freshTs() : String(item.retrievedAt ?? freshTs()),
    status: item.status as 'ok' | 'empty' | 'error',
    data: item.data,
  }));
};

const runOrchRead = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const identity = (exec.identity ?? DEFAULT_IDENTITY) as AuthenticatedIdentity;
  const evidence = (exec.evidence ?? { mode: 'items', items: [] }) as { mode: string; items?: unknown };
  const evidenceProvider = async (): Promise<never> => {
    if (evidence.mode === 'throw-unavailable') {
      const error = new Error('Required evidence is unavailable');
      Object.assign(error, { code: 'evidence.unavailable' });
      throw error;
    }
    return createEvidenceEnvelope(toEnvelopeItems(evidence.items)) as never;
  };
  const responseProvider = exec.providerClaim !== undefined ? async (): Promise<string> => String(exec.providerClaim) : undefined;
  const override = exec.planOverride as TurnPlan | undefined;
  const orchestrator = new ConversationOrchestrator({
    ...(override ? { plan: () => override } : {}),
    evidenceProvider: evidenceProvider as never,
    ...(responseProvider ? { responseProvider } : {}),
    events: silent,
  });
  try {
    const result = await orchestrator.runTurn(
      normalizeRestTurn({ text: String(exec.utterance ?? 'qual é o meu saldo?'), intentionId: `${id}-read` }, identity),
    );
    const text = result.response?.text ?? '';
    if (expect.mode !== undefined) eq(result.plan.mode, expect.mode, 'plan.mode', id);
    if (expect.responsePresent === true) ok(text.length > 0, 'read turn responds', id);
    if (expect.claimAbsent !== undefined) ok(!text.includes(String(expect.claimAbsent)), 'invented claim absent', id, text.slice(0, 160));
    if (expect.claimPresent !== undefined) ok(text.includes(String(expect.claimPresent)), 'evidence-derived content present', id, text.slice(0, 160));
    ok(result.mutation === undefined, 'reads never mutate', id);
    return `mode=${result.plan.mode} response=${text.slice(0, 80)}…`;
  } catch (error) {
    if (expect.throws === undefined) throw new EvalAssertion(`${id}: unexpected read failure — ${(error as Error).message}`);
    expectCode(error, String(expect.throws), id);
    return `threw (${(error as Error).message})`;
  }
};

const runOrchChat = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const identity = (exec.identity ?? DEFAULT_IDENTITY) as AuthenticatedIdentity;
  const override = exec.planOverride as TurnPlan | undefined;
  const orchestrator = new ConversationOrchestrator({ ...(override ? { plan: () => override } : {}), events: silent });
  const result = await orchestrator.runTurn(normalizeRestTurn({ text: String(exec.utterance ?? 'obrigado!'), intentionId: `${id}-chat` }, identity));
  const text = result.response?.text ?? '';
  if (expect.mode !== undefined) eq(result.plan.mode, expect.mode, 'plan.mode', id);
  if (expect.responsePresent === true) ok(text.length > 0, 'chat turn responds', id);
  if (expect.noResponse === true) ok(result.response === undefined, 'no fabricated text without a provider', id);
  if (expect.cancelled === true) {
    ok(result.mutation === undefined, 'cancel records no mutation', id);
    ok(text.length > 0, 'cancel acknowledges', id);
  }
  ok(result.mutation === undefined, 'chat never mutates', id);
  return `mode=${result.plan.mode} response=${text.slice(0, 80)}…`;
};

const runGround = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const envelope = createEvidenceEnvelope(toEnvelopeItems(exec.items));
  const validation = validateGroundedClaims(String(exec.claim ?? ''), envelope);
  const grounded = await createGroundedResponseWithRetry(String(exec.claim ?? ''), envelope, { fallbackSubject: 'test-subject', sink: silent });
  if (expect.grounded !== undefined) eq(grounded.grounded, expect.grounded === true, 'grounded flag', id);
  if (expect.rejected !== undefined) eq(grounded.rejected, expect.rejected === true, 'rejected flag', id);
  if (expect.unsupportedMin !== undefined) ok(validation.unsupportedClaims.length >= Number(expect.unsupportedMin), 'unsupported claims detected', id, validation.unsupportedClaims);
  return `grounded=${grounded.grounded} rejected=${grounded.rejected} unsupported=${validation.unsupportedClaims.length}`;
};

const runEvidence = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const item = (exec.item ?? {}) as { retrievedAt?: string; fresh?: boolean; status?: string; data?: unknown };
  const base = {
    ref: 'eval',
    source: 'tool',
    retrievedAt: item.fresh === true ? freshTs() : String(item.retrievedAt ?? freshTs()),
    status: (item.status ?? 'ok') as 'ok' | 'empty' | 'error',
    data: item.data,
  };
  switch (String(exec.case ?? '')) {
    case 'oversized': {
      try {
        createEvidenceEnvelope([{ ...base, data: 'x'.repeat(20_000) }]);
      } catch (error) {
        expectCode(error, 'evidence.payload_too_large', id);
        return 'oversized rejected';
      }
      throw new EvalAssertion(`${id}: oversized payload was accepted`);
    }
    case 'stale': {
      const envelope = createEvidenceEnvelope([base]);
      eq(isCurrentEvidence(envelope.items[0]!, Date.now()), false, 'stale evidence freshness', id);
      if (expect.stale === true) return 'stale detected';
      throw new EvalAssertion(`${id}: stale expectation not configured`);
    }
    case 'strip': {
      const envelope = createEvidenceEnvelope([base]);
      const serialized = JSON.stringify(envelope);
      if (expect.technicalAbsent !== undefined) ok(!serialized.includes(String(expect.technicalAbsent)), 'technical field stripped', id);
      if (expect.claimPresent !== undefined) ok(serialized.includes(String(expect.claimPresent)), 'evidence content retained', id);
      return 'projected';
    }
    case 'empty': {
      const envelope = await collectEvidence({ required: false, fetch: async () => [] });
      eq(envelope.items[0]?.status, 'empty', 'empty status', id);
      if (expect.emptyStatus !== undefined) eq(envelope.items[0]?.status, expect.emptyStatus, 'empty status', id);
      return 'empty envelope';
    }
    default:
      throw new EvalAssertion(`${id}: unknown evidence case "${String(exec.case ?? '')}"`);
  }
};

const runExecutorSeeded = async (scenario: BehavioralScenario): Promise<string> => {
  const { id, exec, expect } = scenario;
  const identity = { workspaceId: 'workspace-eval', actorId: 'actor-eval', deviceId: 'device-eval' };
  const seed: SeedOperation = {
    id: String(exec.operationId ?? 'pending-exec-1'),
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    deviceId: identity.deviceId,
    status: 'pending',
  };
  const apiMode = String(exec.apiMode ?? 'ok') as FakeApiOptions['mode'];
  const api = createFakePendingApi({ seed: [seed], mode: apiMode });
  const executor = new MutationExecutor({ request: api.request as never, events: silent });
  if (String(exec.case ?? '') === 'replay') {
    const confirmation = await executor.confirm(seed.id, { ...identity });
    const first = await executor.execute({ operationId: confirmation.operationId, attestation: confirmation.attestation, identity: { ...identity } });
    eq(first.status, 'succeeded', 'first execution', id);
    try {
      await executor.execute({ operationId: confirmation.operationId, attestation: confirmation.attestation, identity: { ...identity } });
    } catch (error) {
      expectCode(error, 'approval.attestation_replayed', id);
      if (expect.executeCalls !== undefined) eq(api.calls.execute, expect.executeCalls, 'single transport execution', id);
      return 'replay blocked after one execution';
    }
    throw new EvalAssertion(`${id}: replayed attestation executed twice`);
  }
  if (String(exec.case ?? '') === 'incomplete') {
    const confirmation = await executor.confirm(seed.id, { ...identity });
    try {
      await executor.execute({ operationId: confirmation.operationId, attestation: confirmation.attestation, identity: { ...identity } });
    } catch (error) {
      expectCode(error, String(expect.errorCode ?? 'approval.incomplete_result'), id);
      return `incomplete blocked (${(error as Error).message})`;
    }
    throw new EvalAssertion(`${id}: incomplete API result was accepted as success`);
  }
  throw new EvalAssertion(`${id}: unknown executor case "${String(exec.case ?? '')}"`);
};

/* ------------------------------------------------------------------ */
/* Public entry points.                                                */
/* ------------------------------------------------------------------ */

export const assertSpecMinimums = (scenarios: BehavioralScenario[]): { counts: Record<string, number> } => {
  const counts: Record<string, number> = {};
  for (const category of SPEC_CATEGORIES) counts[category] = 0;
  for (const scenario of scenarios) {
    if (typeof scenario.specCategory !== 'string' || !(SPEC_CATEGORIES as readonly string[]).includes(scenario.specCategory)) {
      throw new Error(`TED V2 eval matrix: invalid specCategory for ${scenario.id}`);
    }
    counts[scenario.specCategory]! += 1;
  }
  const deficits = (Object.keys(SPEC_MINIMUMS) as SpecCategory[])
    .filter((category) => (counts[category] ?? 0) < SPEC_MINIMUMS[category])
    .map((category) => `${category}: ${counts[category] ?? 0}/${SPEC_MINIMUMS[category]}`);
  if (deficits.length > 0) throw new Error(`TED V2 eval matrix: spec minimums unmet — ${deficits.join('; ')}`);
  return { counts };
};

export const runBehavioralMatrix = async (scenarios: BehavioralScenario[]): Promise<MatrixReport> => {
  const results: ScenarioOutcome[] = [];
  for (const scenario of scenarios) {
    if (!EXEC_KINDS.includes(scenario.exec?.kind as ExecKind)) {
      results.push({ id: scenario.id, specCategory: scenario.specCategory, passed: false, detail: `unknown exec kind "${String(scenario.exec?.kind)}"` });
      continue;
    }
    try {
      const kind = scenario.exec.kind as ExecKind;
      const detail =
        kind === 'router' ? runRouter(scenario)
        : kind === 'plan' ? runPlan(scenario)
        : kind === 'provider-output' ? runProviderOutput(scenario)
        : kind === 'normalize' ? runNormalize(scenario)
        : kind === 'parse' ? runParse(scenario)
        : kind === 'confirm' ? runConfirm(scenario)
        : kind === 'resolve' ? await runResolve(scenario)
        : kind === 'orch-propose' ? await runOrchPropose(scenario)
        : kind === 'orch-confirm' ? await runOrchConfirm(scenario)
        : kind === 'orch-idempotency' ? await runOrchIdempotency(scenario)
        : kind === 'orch-read' ? await runOrchRead(scenario)
        : kind === 'orch-chat' ? await runOrchChat(scenario)
        : kind === 'ground' ? await runGround(scenario)
        : kind === 'evidence' ? await runEvidence(scenario)
        : await runExecutorSeeded(scenario);
      results.push({ id: scenario.id, specCategory: scenario.specCategory, passed: true, detail });
    } catch (error) {
      results.push({ id: scenario.id, specCategory: scenario.specCategory, passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const byCategory: Record<string, { total: number; passed: number }> = {};
  for (const category of SPEC_CATEGORIES) byCategory[category] = { total: 0, passed: 0 };
  for (const result of results) {
    byCategory[result.specCategory] ??= { total: 0, passed: 0 };
    byCategory[result.specCategory]!.total += 1;
    if (result.passed) byCategory[result.specCategory]!.passed += 1;
  }
  const failures = results.filter((result) => !result.passed);
  return { total: results.length, passed: results.length - failures.length, failed: failures.length, byCategory, failures, results };
};

export const formatCategoryTable = (report: MatrixReport): string => {
  const rows = Object.entries(report.byCategory).map(([category, counts]) => {
    const minimum = (SPEC_MINIMUMS as Record<string, number>)[category] ?? 0;
    return `${category}: ${counts.passed}/${counts.total} passed (minimum ${minimum})`;
  });
  return [...rows, `TOTAL: ${report.passed}/${report.total} passed`].join('\n');
};
