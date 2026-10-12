/**
 * V1-GOLDEN-PG-IMPL — first authoritative PostgreSQL slice for the F4 golden
 * contracts (issue #105).
 *
 * The fast golden suite (`apps/agent/tests/golden/**`) runs the same
 * `ConversationOrchestrator` + `MutationApiClient` production modules against
 * an ISOLATED in-memory backend. This suite keeps that suite untouched and
 * re-proves the golden vertical (GW-023 manual-confirm-execute, GW-024 manual
 * cancel, GW-025 confirm-without-proposal) against the REAL authoritative API
 * surface: the real Fastify `pending-operations/v2` routes, the real Postgres
 * pending-operation store, the real V2 executor and the real WriteStore — all
 * driven through `app.inject`, never the network.
 *
 * Contracts honoured here:
 * - The Agent modules are imported by relative path (test-only). No runtime
 *   package dependency is created between apps/api and apps/agent: no
 *   package.json, workspace or build coupling is added by this file.
 * - FAIL-CLOSED gate: BOTH `DATABASE_URL_TEST` and `DB_TEST_MARKER` must be
 *   explicitly provided, and `requireTestDatabase` must pass, BEFORE any pool,
 *   migration or cleanup happens. Partial env FAILS the suite loudly (never a
 *   silent skip); absence skips cleanly for local runs. `runMigrations` is only
 *   called after the guard passes.
 * - Every case runs under a UNIQUE synthetic tenant (household + actor +
 *   device). Only its own fixtures are ever cleaned.
 * - PASS rests on AUTHORITATIVE SQL postconditions (`pending_operations`,
 *   `transactions`, account balance) — never on the Agent response text. The
 *   deterministic response copy is asserted only as secondary evidence.
 *
 * The isolation slice at the end of this file re-proves cross-actor and
 * cross-workspace containment of pending V2 operations through the SAME real
 * surface: a foreign fully-capable delegated identity (same workspace, and a
 * different workspace) can never list, read, confirm, cancel, execute,
 * retry, reconcile, expire or otherwise affect another identity's pending
 * operation, proven by before/after SQL snapshots of the original row, the
 * transaction ledger and account balances.
 *
 * The identity dimensions are isolated INDEPENDENTLY: beyond the conflation
 * probes (both/all legs changed), the matrix adds attackers that change
 * EXACTLY ONE of workspace/actor/device and preserve the other two from the
 * owner — so no denial can ever depend on all three legs differing. After
 * the owner confirm, the COMPLETE persisted state of BOTH the original
 * proposed row and the legitimate confirmed sibling is snapshotted
 * (attestation hash/consumption/issued time, auth mode/reason/risk,
 * authorized time, attempt count, lease/claim, failure, receipt/mutation id
 * — plus a whole-row JSONB oracle covering every column) and proven
 * byte-identical after every foreign attempt.
 *
 * Reachability notes for this bounded slice (reported, not faked):
 * - undo: NOT reachable here. The conversational undo flow needs the Agent-side
 *   two-step undo-proposal service plus the `/rpc/undo/:requestId/verify-target`
 *   boundary, which is not part of the composed approval surface.
 * - forget: NOT reachable here. `forget_memory` state lives in the Agent DO
 *   SQLite memory store, not in the API's PostgreSQL.
 * - idempotent redelivery of a lost propose: covered at store level by
 *   `pending-v2-e2e.test.ts`; not re-proved through the orchestrator here.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { DelegatedTurnClaims } from '../../src/auth/delegated-token.js';
import { createDelegatedTokenForTest, verifyDelegatedTurnToken } from '../../src/auth/delegated-token.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { createPool } from '../../src/db/pool.js';
import { createPostgresPendingOperationV2Store, type PendingIdentity, type PendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { createInMemoryPendingOperationStore } from '../../src/approvals/pending.js';
import { createUndoService } from '../../src/approvals/undo.js';
import { createPostgresAuditLogStore } from '../../src/audit/store.js';
import { runMigrations } from '../../src/read-models/sql/migrate.js';
import { createPostgresReadModelStore } from '../../src/read-models/postgres-store.js';
import { createPendingOperationV2Executor } from '../../src/routes/index.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';
// Agent modules under test — test-only cross-import by relative path (no
// package dependency, no workspace coupling, no apps/agent edit).
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
  type TurnResult,
} from '../../../agent/src/orchestration/conversation-orchestrator.js';
import { MutationApiClient, type MutationRequest } from '../../../agent/src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../../agent/src/mutations/mutation-draft.js';
import { createEvidenceEnvelope } from '../../../agent/src/evidence/evidence-envelope.js';
import { renderInconclusive, renderMutationResult } from '../../../agent/src/responses/deterministic-responses.js';
import type { ApiRequestOptions } from '../../../agent/src/tools/api-client.js';
// Bloco B (GW-030) — conversational undo through the real surface: the
// Agent-side two-step undo-proposal service plus the undo API. Test-only
// cross-imports by relative path (same contract as the orchestrator imports
// above — no package dependency, no workspace coupling).
import {
  initializeUndoProposalSchema,
  SqlUndoProposalStore,
  UndoProposalService,
  type UndoIdentity,
} from '../../../agent/src/mutations/undo-proposal.js';

// ─── Fail-closed environment gate ───────────────────────────────────────────

export type GoldenRealApiEnv =
  | Readonly<{ state: 'full'; databaseUrl: string; marker: string }>
  | Readonly<{ state: 'partial'; missing: readonly string[] }>
  | Readonly<{ state: 'absent' }>;

/**
 * Pure resolution of the gate state. Exported so the gate semantics are
 * pinned by always-running tests below (they never touch a database).
 *
 * - `full`    → both vars present: the suite RUNS (guard still applies).
 * - `partial` → exactly one present: the suite FAILS CLOSED. A half-configured
 *   environment is a misconfiguration, never a reason to degrade to a skip.
 * - `absent`  → neither present: the suite SKIPS cleanly for local runs.
 */
export const resolveGoldenRealApiEnv = (env: Record<string, string | undefined> = process.env): GoldenRealApiEnv => {
  const databaseUrl = env.DATABASE_URL_TEST?.trim() ?? '';
  const marker = env.DB_TEST_MARKER?.trim() ?? '';
  if (databaseUrl !== '' && marker !== '') return { state: 'full', databaseUrl, marker };
  const missing: string[] = [];
  if (databaseUrl === '') missing.push('DATABASE_URL_TEST');
  if (marker === '') missing.push('DB_TEST_MARKER');
  if (missing.length === 2) return { state: 'absent' };
  return { state: 'partial', missing };
};

const envState = resolveGoldenRealApiEnv();
// Absence skips locally; anything else (full, or the fail-closed partial case)
// registers REAL tests so a misconfigured environment can never pass quietly.
const itIfDatabase = envState.state === 'absent' ? it.skip : it;

if (envState.state === 'absent') {
  console.log(
    '[golden-agent-real-api] SKIP: DATABASE_URL_TEST + DB_TEST_MARKER are both required — ' +
      'this suite re-proves the F4 golden verticals against the authoritative PostgreSQL API, ' +
      'so every database-backed test below is skipped. Set both env vars to run it for real.',
  );
}

// ─── Authoritative API composition (real routes, real stores, real PG) ──────

/**
 * Test-only delegation secret used to mint short-lived `pi-agent` turn tokens
 * for the synthetic tenant of each case. It is NOT a credential: the composed
 * app verifies tokens with the REAL `verifyDelegatedTurnToken`. Exported ONLY
 * so the always-running seam tests below can verify the seam's signature over
 * the pinned fixture identity.
 */
export const DELEGATION_SECRET = 'golden-real-api-test-only-delegation-secret';

const APPROVAL_CAPABILITIES: readonly string[] = [
  'financial.approval.propose',
  'financial.approval.read',
  'financial.approval.confirm',
  'financial.approval.execute',
  'financial.approval.cancel',
];

/**
 * Test-only delegation preHandler, extracted so the V2-only composition below
 * and the Bloco B undo-capable composition share the exact same delegated
 * identity boundary (verified turn token → identity from CLAIMS, never from
 * free headers). Same shape as the production delegation preHandler
 * (routes/index.ts).
 */
const attachDelegatedTestPreHandler = (app: FastifyInstance): void => {
  app.addHook('preHandler', async (request, reply) => {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token === '') {
      return reply.code(401).send({ code: 'auth.session_required', message: 'Token de sessão ou delegação obrigatório.' });
    }
    let claims: DelegatedTurnClaims;
    try {
      claims = await verifyDelegatedTurnToken(token, DELEGATION_SECRET, Date.now());
    } catch (error) {
      return reply.code(401).send({ code: 'auth.invalid_token', message: (error as Error).message });
    }
    request.authenticatedContext = {
      householdId: claims.workspace,
      actorId: claims.sub,
      authUserId: claims.sub,
      actorType: 'user',
      deviceId: claims.deviceId ?? '',
      role: claims.role,
    };
    request.delegatedTurn = claims;
  });
};

const composeAuthoritativeApp = (pool: Pool): FastifyInstance => {
  const app = Fastify({ logger: false });
  attachDelegatedTestPreHandler(app);
  registerPendingOperationRoutes(app, {
    resolveToken: async () => {
      // Unreachable: every request carries a verified delegated turn token, so
      // `resolve()` always short-circuits on authenticatedContext. Fail closed
      // rather than inventing an identity if that ever changes.
      throw Object.assign(new Error('golden.real_api.device_token_path_unreachable'), {
        statusCode: 401,
        code: 'auth.session_required',
      });
    },
    v2Store: createPostgresPendingOperationV2Store(pool),
    v2Executor: createPendingOperationV2Executor(createPostgresWriteStore({ pool })),
    v2Only: true,
    readModel: createPostgresReadModelStore({ pool }),
  });
  return app;
};

/**
 * Bloco B (GW-030) — undo-capable composition. Mirrors the production route
 * shape (routes/index.ts): the V2 approval surface PLUS the V1 undo route
 * (`POST /pending-operations/undo`) served by a real `UndoService` over the
 * same PostgreSQL. The V2-only composition above is untouched; only the undo
 * vertical uses this app.
 */
const UNDO_CAPABILITIES: readonly string[] = ['financial.undo.execute'];

const composeUndoCapableApp = (pool: Pool): FastifyInstance => {
  const app = Fastify({ logger: false });
  attachDelegatedTestPreHandler(app);
  const writes = createPostgresWriteStore({ pool });
  registerPendingOperationRoutes(app, {
    store: createInMemoryPendingOperationStore(),
    resolveToken: async () => {
      throw Object.assign(new Error('golden.real_api.device_token_path_unreachable'), {
        statusCode: 401,
        code: 'auth.session_required',
      });
    },
    undoService: createUndoService({ auditLogs: createPostgresAuditLogStore(pool), writes }),
    v2Store: createPostgresPendingOperationV2Store(pool),
    v2Executor: createPendingOperationV2Executor(createPostgresWriteStore({ pool })),
    readModel: createPostgresReadModelStore({ pool }),
  });
  return app;
};

/**
 * Bloco B (GW-030) — Agent-side undo-proposal durability over disposable
 * SQLite (node:sqlite `:memory:`, same engine family as the DO store in
 * production). Table layout owned by `initializeUndoProposalSchema`; the shim
 * only adapts node:sqlite to the `UndoSql` shape.
 */
const createUndoProposalStore = (): SqlUndoProposalStore => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...(bindings as never[])) as T[];
      }
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  };
  initializeUndoProposalSchema(sql);
  return new SqlUndoProposalStore(sql);
};

/**
 * Bloco B (GW-030) — test double of the DO `previewUndoTarget`: resolves the
 * most recent reversible audit entry through the REAL Postgres audit store
 * (the same reader the API undo service uses), preferring the actor's own
 * entries. Returns the audit-log id the undo proposal binds as its fixed
 * target — never client input.
 */
const REVERSIBLE_OPERATIONS = new Set([
  'transactions.expense.create',
  'transactions.income.create',
  'transactions.transfer.create',
  'accounts.create',
  'categories.create',
]);

const previewLastReversibleAudit = (pool: Pool) => async (identity: UndoIdentity): Promise<{ id: string } | null> => {
  const reader = createPostgresAuditLogStore(pool);
  const { items } = await reader.listAuditLogs(identity.workspaceId, { limit: 50 });
  const candidates = (items ?? [])
    .filter((item) => typeof item.id === 'string' && REVERSIBLE_OPERATIONS.has(String(item.operation)))
    .sort((a, b) => Date.parse(String(b.createdAt ?? 0)) - Date.parse(String(a.createdAt ?? 0)));
  if (candidates.length === 0) return null;
  const own = candidates.filter((item) => item.actorId === identity.actorId);
  const target = (own.length > 0 ? own[0] : candidates[0])!;
  return { id: String(target.id) };
};

/**
 * The `MutationApiClient` transport seam, pointed at the composed app through
 * `inject` and PINNED to the case's own fixture identity
 * (`householdId`/`actorId`/`deviceId` seeded by `seedTenant` +
 * `createCaseHarness`). The Agent always presents those three identity
 * headers; this shim mints a real short-lived delegated turn token ONLY for
 * exactly that pinned identity and fails closed when any leg is missing OR
 * when the caller presents anything else — it never signs an identity that
 * differs from the pinned fixture.
 *
 * Scope of this seam (honest boundary): it verifies the delegated token and
 * the capabilities it carries, plus the downstream persistence through the
 * real authoritative API. It is NOT full production user-membership
 * authentication — there is no session cookie, no membership resolution and
 * no Better-Auth user-table check here; those live in the production auth
 * boundary that this bounded slice deliberately composes around.
 */
export const createRequestSeam = (
  app: FastifyInstance,
  expected: Readonly<{ householdId: string; actorId: string; deviceId: string }>,
  // Bloco B (GW-030): the undo call carries the NARROW undo capability, not
  // the approval set. Defaults preserve every existing caller.
  capabilities: readonly string[] = APPROVAL_CAPABILITIES,
): MutationRequest =>
  async <T = Record<string, unknown>>(method: string, path: string, opts: ApiRequestOptions = {}): Promise<T> => {
    const headerValue = (value: string | number | undefined): string | undefined => {
      if (value === undefined) return undefined;
      const text = String(value).trim();
      return text === '' ? undefined : text;
    };
    const workspaceId = headerValue(opts.headers?.['x-workspace-id']);
    const actorId = headerValue(opts.headers?.['x-actor-id']);
    const deviceId = headerValue(opts.headers?.['x-device-id']);
    if (workspaceId === undefined || actorId === undefined || deviceId === undefined) {
      throw Object.assign(new Error('golden.real_api.missing_identity'), { statusCode: 500, code: 'golden.real_api.missing_identity' });
    }
    if (workspaceId !== expected.householdId || actorId !== expected.actorId || deviceId !== expected.deviceId) {
      // The Agent asked for an identity other than the pinned fixture: reject
      // instead of minting a token for the caller's claim.
      throw Object.assign(new Error('golden.real_api.identity_mismatch'), { statusCode: 500, code: 'golden.real_api.identity_mismatch' });
    }
    const token = await createDelegatedTokenForTest(
      { actorId, workspaceId, role: 'member', capabilities: [...capabilities], requestId: `golden-real-api-${randomUUID()}`, deviceId },
      DELEGATION_SECRET,
    );
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (opts.idempotencyKey !== undefined && opts.idempotencyKey !== '') headers['idempotency-key'] = opts.idempotencyKey;
    let payload: string | undefined;
    const upper = method.toUpperCase();
    if (opts.body !== undefined && upper !== 'GET' && upper !== 'HEAD') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }
    // The mutation client only issues GET (authoritative listing) and POST
    // (propose/confirm/execute/cancel); narrow the literal for the typed
    // light-my-request options object.
    const injectMethod = upper === 'GET' ? 'GET' : 'POST';
    const response = await app.inject({ method: injectMethod, url: path, headers, ...(payload !== undefined ? { payload } : {}) });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (response.body === '' ? {} : JSON.parse(response.body)) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    if (response.statusCode >= 400) {
      const message = typeof parsed['message'] === 'string' ? parsed['message'] : `HTTP ${response.statusCode}`;
      throw Object.assign(new Error(message), {
        statusCode: response.statusCode,
        code: typeof parsed['code'] === 'string' ? parsed['code'] : 'api.request_failed',
      });
    }
    return parsed as T;
  };

// ─── Synthetic tenants (own fixtures only) ──────────────────────────────────

type Tenant = Readonly<{ householdId: string; ownerId: string }>;

const tenants = new Set<string>();

/** Exported ONLY for the always-running cleanup tests below. */
export const trackedTenants: Set<string> = tenants;

/**
 * Seeds ONE synthetic tenant (user + household) and returns its identity.
 *
 * The two inserts run inside a SINGLE transaction on a dedicated client: a
 * failure between them rolls the user back with the household, so a half-seeded
 * fixture (an orphan user with no household) can never survive. The household
 * is registered for cleanup ONLY after a successful COMMIT — `afterEach`/
 * `afterAll` therefore never chase a tenant that was never committed, and a
 * rolled-back seed is reported loudly instead of leaking.
 */
const seedTenant = async (db: Pool): Promise<Tenant> => {
  const householdId = randomUUID();
  const ownerId = randomUUID();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Golden Owner', 'active')`, [
      ownerId,
      `golden-${householdId}@example.test`,
    ]);
    await client.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, $2, 'shared', $3)`, [
      householdId,
      `Golden ${householdId.slice(0, 8)}`,
      ownerId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // Only a committed tenant is tracked for cleanup.
  tenants.add(householdId);
  return { householdId, ownerId };
};

/**
 * Deletes ONLY this suite's own fixture rows for `householdId`, inside ONE
 * transaction, children before parents (FK-preserving order). Errors SURFACE:
 * a failed cleanup rejects (never swallowed), and the tenant stays tracked so
 * `afterEach`/`afterAll` retry instead of silently leaking fixtures. After a
 * successful COMMIT the same transaction proves no own
 * household/membership/audit/pending/transaction fixture remains — any
 * leftover rolls the whole cleanup back and fails loudly. The sole active
 * owner membership is removed by the households DELETE's ON DELETE CASCADE,
 * not by an explicit membership delete that the shared-owner guards would
 * reject (see the ordering note inside the function).
 */
export const cleanupTenant = async (db: Pool, householdId: string): Promise<void> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Resolve the owner inside the transaction: the user delete below is the
    // last statement and must reference the household that still exists now.
    const ownerResult = await client.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM households WHERE id = $1`,
      [householdId],
    );
    const ownerId = ownerResult.rows[0]?.owner_user_id;
    // Children before parents; every statement is fixture-scoped.
    await client.query(`DELETE FROM audit_logs WHERE workspace_id = $1`, [householdId]);
    await client.query(`DELETE FROM operation_records WHERE workspace_id = $1`, [householdId]);
    await client.query(`DELETE FROM pending_operations WHERE workspace_id = $1`, [householdId]);
    await client.query(`DELETE FROM transactions WHERE household_id = $1`, [householdId]);
    await client.query(`DELETE FROM idempotency_keys WHERE household_id = $1`, [householdId]);
    await client.query(`DELETE FROM categories WHERE household_id = $1`, [householdId]);
    await client.query(`DELETE FROM accounts WHERE household_id = $1`, [householdId]);
    // The membership is deliberately NOT deleted by an explicit
    // `DELETE FROM memberships`. A synthetic tenant is seeded `shared`, so the
    // V022 `households_shared_membership_creator` trigger gives it a sole active
    // `owner` membership, and the schema then protects that owner from every
    // direction while the household is still `shared`:
    //   - V022 `memberships_shared_owner_guard` (BEFORE UPDATE/DELETE) raises
    //     "shared workspace must retain at least one owner" when removing or
    //     demoting the last active owner;
    //   - V022 `memberships_shared_owner_check` (DEFERRED AFTER) raises
    //     "shared workspace must have at least one active owner" if one is left;
    //   - V021 `memberships_personal_workspace_guard` (BEFORE DELETE) raises
    //     "personal workspace owner membership is required", and V021
    //     `households_personal_kind_guard` makes `households.kind` IMMUTABLE
    //     ("workspace kind is immutable") — so relaxing the guards by flipping
    //     the kind to `personal` first is itself rejected by the schema.
    // The invariant-preserving route is therefore to delete the household FIRST
    // and let `memberships.household_id REFERENCES households(id) ON DELETE
    // CASCADE` (V020) remove the membership while the household row is already
    // gone. Each guard keys off the household's `kind`; with the household
    // removed they read no household and correctly no-op — the shared workspace
    // genuinely ceases to exist, so the invariant is HONOURED, never bypassed.
    await client.query(`DELETE FROM households WHERE id = $1`, [householdId]);
    if (ownerId !== undefined) {
      await client.query(`DELETE FROM users WHERE id = $1`, [ownerId]);
    }
    // Postconditions INSIDE the same transaction: if anything of ours — the
    // household, its cascade-removed membership, or any fixture row — survived,
    // the entire cleanup is rolled back and reported.
    const leftovers = await client.query<{ table_name: string; n: number }>(
      `SELECT 'households' AS table_name, COUNT(*)::int AS n FROM households WHERE id = $1
       UNION ALL
       SELECT 'memberships', COUNT(*)::int FROM memberships WHERE household_id = $1
       UNION ALL
       SELECT 'audit_logs', COUNT(*)::int FROM audit_logs WHERE workspace_id = $1
       UNION ALL
       SELECT 'pending_operations', COUNT(*)::int FROM pending_operations WHERE workspace_id = $1
       UNION ALL
       SELECT 'transactions', COUNT(*)::int FROM transactions WHERE household_id = $1`,
      [householdId],
    );
    const remaining = leftovers.rows.filter((row) => row.n > 0);
    if (remaining.length > 0) {
      throw new Error(
        `golden.real_api.cleanup_leftover: ${remaining.map((row) => `${row.table_name}=${row.n}`).join(',')}`,
      );
    }
    await client.query('COMMIT');
    // Only a verified-cleared tenant stops being tracked.
    tenants.delete(householdId);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Tenant stays tracked on failure so the next cleanup attempt retries.
    throw error;
  } finally {
    client.release();
  }
};

// ─── Authoritative SQL reads (the oracle — never the Agent response) ─────────

/**
 * The COMPLETE persisted V2 state of a pending operation, as read straight
 * from PostgreSQL — the authoritative oracle. Every column the V2 surface
 * writes is captured, so a byte-identical before/after comparison proves the
 * foreign attempts below changed NOTHING: binding (workspace/actor/device),
 * proposal (tool/args/hash/idempotency key), execution status, attestation
 * hash + consumption + issued time, the authorization audit fields
 * (mode/reason/risk/authorized time) and the execution-recovery surface
 * (attempt count, claim, lease, failure, receipt/mutation id).
 */
type PendingRow = Readonly<{
  id: string;
  workspace_id: string;
  actor_id: string;
  device_id: string;
  tool: string;
  normalized_args: Record<string, unknown>;
  execution_status: string;
  proposal_hash: string;
  idempotency_key: string;
  attestation_hash: string | null;
  attestation_consumed_at: string | null;
  attestation_issued_at: string | null;
  authorization_mode: string | null;
  authorization_reason: string | null;
  risk_tier: string | null;
  authorized_at: string | null;
  execution_attempt_count: number;
  execution_claimed_at: string | null;
  execution_lease_expires_at: string | null;
  failure_code: string | null;
  failed_at: string | null;
  mutation_id: string | null;
  execution_result: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
}>;

const readPendingRow = async (db: Pool, id: string, workspaceId: string): Promise<PendingRow> => {
  const result = await db.query<PendingRow>(
    `SELECT id, workspace_id, actor_id, device_id, tool, normalized_args, execution_status,
            proposal_hash, idempotency_key,
            attestation_hash,
            attestation_consumed_at::text AS attestation_consumed_at,
            attestation_issued_at::text AS attestation_issued_at,
            authorization_mode, authorization_reason, risk_tier,
            authorized_at::text AS authorized_at,
            execution_attempt_count::int AS execution_attempt_count,
            execution_claimed_at::text AS execution_claimed_at,
            execution_lease_expires_at::text AS execution_lease_expires_at,
            failure_code,
            failed_at::text AS failed_at,
            mutation_id, execution_result,
            created_at::text AS created_at, expires_at::text AS expires_at
       FROM pending_operations
      WHERE id = $1 AND workspace_id = $2 AND protocol_version = 2`,
    [id, workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`golden.real_api.pending_row_missing:${id}`);
  return row;
};

/**
 * Whole-row JSONB oracle: the ENTIRE persisted row, every column, as the
 * database itself sees it. A deep-equality before/after comparison therefore
 * catches a change in ANY column — including ones not enumerated in
 * `PendingRow` — so the "unchanged" proof can never miss a field.
 */
const readPendingRowJsonb = async (db: Pool, id: string, workspaceId: string): Promise<Record<string, unknown>> => {
  const result = await db.query<{ snapshot: Record<string, unknown> }>(
    `SELECT to_jsonb(p) AS snapshot
       FROM pending_operations p
      WHERE p.id = $1 AND p.workspace_id = $2 AND p.protocol_version = 2`,
    [id, workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`golden.real_api.pending_row_missing:${id}`);
  return row.snapshot;
};

const countPendingForTenant = async (db: Pool, workspaceId: string): Promise<number> => {
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pending_operations WHERE workspace_id = $1 AND protocol_version = 2`,
    [workspaceId],
  );
  return Number(result.rows[0]?.n ?? -1);
};

type TransactionRow = Readonly<{
  id: string;
  household_id: string;
  kind: string;
  description: string;
  amount_cents: number;
  date: string;
  account_id: string;
  category_id: string;
}>;

const readTransactionRows = async (db: Pool, householdId: string): Promise<readonly TransactionRow[]> => {
  const result = await db.query<TransactionRow>(
    `SELECT id, household_id, kind, description, amount_cents::int AS amount_cents, date::text AS date,
            account_id, category_id
       FROM transactions
      WHERE household_id = $1 AND deleted_at IS NULL`,
    [householdId],
  );
  return result.rows;
};

const countTransactions = async (db: Pool, householdId: string): Promise<number> =>
  (await readTransactionRows(db, householdId)).length;

/** Counts ledger rows bound to NO known tenant of the case (leak oracle). */
const countOrphanLedgerRows = async (db: Pool, householdIds: readonly string[]): Promise<number> => {
  const transactions = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE NOT (household_id = ANY($1::uuid[]))`,
    [householdIds],
  );
  const pending = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pending_operations WHERE NOT (workspace_id = ANY($1::uuid[]))`,
    [householdIds],
  );
  return Number(transactions.rows[0]?.n ?? -1) + Number(pending.rows[0]?.n ?? -1);
};

/**
 * Resolves a seeded default category (the createAccount bootstrap applies the
 * default catalog to a fresh household — production behavior). The golden
 * verticals name `Alimentação`, which is a default macro category, so a fresh
 * synthetic workspace already carries it.
 */
const readCategoryIdByName = async (db: Pool, householdId: string, name: string, kind = 'expense'): Promise<string> => {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM categories
      WHERE household_id = $1 AND parent_id IS NULL AND lower(name) = lower($2)
        AND kind = $3 AND status = 'active' AND deleted_at IS NULL
      LIMIT 1`,
    [householdId, name, kind],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`golden.real_api.category_missing:${name}`);
  return row.id;
};

const readAccountBalanceCents = async (db: Pool, accountId: string): Promise<number> => {
  const result = await db.query<{ balance_cents: number }>(
    `SELECT balance_cents::int AS balance_cents FROM accounts WHERE id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`golden.real_api.account_row_missing:${accountId}`);
  return Number(row.balance_cents);
};

// ─── Gate semantics (always run; pure, no database) ─────────────────────────

describe('golden real-api gate — fail-closed environment semantics', () => {
  it('absence of both vars resolves to absent (local runs skip cleanly)', () => {
    expect(resolveGoldenRealApiEnv({}).state).toBe('absent');
    expect(resolveGoldenRealApiEnv({ DATABASE_URL_TEST: '   ', DB_TEST_MARKER: '' }).state).toBe('absent');
  });

  it('partial env resolves to partial — never a silent skip', () => {
    const onlyUrl = resolveGoldenRealApiEnv({ DATABASE_URL_TEST: 'postgres://golden@localhost/golden_test' });
    expect(onlyUrl.state).toBe('partial');
    expect(onlyUrl.state === 'partial' ? onlyUrl.missing : []).toEqual(['DB_TEST_MARKER']);
    const onlyMarker = resolveGoldenRealApiEnv({ DB_TEST_MARKER: '00000000-0000-4000-8000-000000000001' });
    expect(onlyMarker.state).toBe('partial');
    expect(onlyMarker.state === 'partial' ? onlyMarker.missing : []).toEqual(['DATABASE_URL_TEST']);
  });

  it('both vars resolve to full (the guard still applies before any pool use)', () => {
    expect(resolveGoldenRealApiEnv({ DATABASE_URL_TEST: 'postgres://golden@localhost/golden_test', DB_TEST_MARKER: 'm' })).toEqual({
      state: 'full',
      databaseUrl: 'postgres://golden@localhost/golden_test',
      marker: 'm',
    });
  });
});

// ─── Golden verticals against the authoritative PostgreSQL API ──────────────

describe('F4 golden verticals against the authoritative PostgreSQL API (issue #105)', () => {
  let pool: Pool | undefined;
  let writes: ReturnType<typeof createPostgresWriteStore> | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    // Fail closed on a half-configured environment BEFORE any pool/migration.
    if (envState.state === 'partial') {
      throw new Error(
        `golden.real_api.partial_env: refusing to run — ${envState.missing.join(' and ')} must be provided together with the other variable. ` +
          'A half-configured environment fails closed; it never degrades to a skip.',
      );
    }
    if (envState.state !== 'full') return;
    pool = createPool({ connectionString: envState.databaseUrl, max: 8 });
    // Guard first: never migrate or clean anything before the database is
    // proven to be a marked, disposable test database.
    await requireTestDatabase(pool, 'golden-agent-real-api');
    await runMigrations(pool);
    writes = createPostgresWriteStore({ pool });
    app = composeAuthoritativeApp(pool);
    await app.ready();
  }, 120_000);

  afterEach(async () => {
    delete process.env.TED_RISK_BASED_AUTOEXECUTE;
    if (!pool) return;
    for (const householdId of [...tenants]) await cleanupTenant(pool, householdId);
  });

  afterAll(async () => {
    if (pool && tenants.size > 0) {
      for (const householdId of [...tenants]) await cleanupTenant(pool, householdId);
    }
    await app?.close();
    await pool?.end();
  });

  /**
   * Builds a per-case harness: the REAL orchestrator + REAL mutation client,
   * with the request seam pointed at the composed app. The entity reader is
   * bound to the case's own synthetic household and reads the SAME PostgreSQL
   * rows the API reads.
   */
  const createCaseHarness = (
    householdId: string,
    actor: Readonly<{ actorId: string; deviceId: string }>,
    // Bloco A fase 2 (redelivery/recovery): an optional per-case transport
    // override. When omitted the pinned real seam is used unchanged; recovery
    // cases pass a wrapper that faults EXACTLY ONE execute call (closure over
    // the case — never a global mock, so nothing leaks between tests).
    requestOverride?: MutationRequest,
  ): Readonly<{ runTurn: (input: Readonly<{ text: string; intentionId: string }>) => Promise<TurnResult> }> => {
    const db = pool!;
    const readModel = createPostgresReadModelStore({ pool: db });
    const entityReader = {
      scope: { workspaceId: householdId },
      listAccounts: async () =>
        (await readModel.listAccounts(householdId)).map((account) => ({
          id: account.id,
          name: account.name,
          status: account.status,
        })),
      listCategories: async () =>
        (await readModel.listCategories(householdId)).map((category) => ({
          id: category.id,
          name: category.name,
          status: category.status,
        })),
    };
    const orchestrator = new ConversationOrchestrator({
      // The seam is pinned to this case's fixture identity: the Agent may only
      // ever present the household/actor/device the harness seeded.
      mutationApiClient: new MutationApiClient({
        request: requestOverride ?? createRequestSeam(app!, { householdId, actorId: actor.actorId, deviceId: actor.deviceId }),
        events: () => {},
      }),
      draftStore: new InMemoryMutationDraftStore(),
      entityReader,
      // Read-path evidence is out of scope for this bounded mutation slice:
      // the golden read contracts stay covered by the fast isolated suite.
      evidenceProvider: async () =>
        createEvidenceEnvelope([
          { ref: 'accounts', source: 'golden-real-api', retrievedAt: new Date().toISOString(), status: 'empty', reason: 'period_empty', data: [] },
          { ref: 'transactions', source: 'golden-real-api', retrievedAt: new Date().toISOString(), status: 'empty', reason: 'period_empty', data: [] },
        ]),
      // Mutation turns answer from deterministic production copy; a provider
      // answer on these turns would be a defect, so it claims nothing.
      responseProvider: async () => 'Resposta do harness PostgreSQL, sem alegações financeiras.',
      events: () => {},
    });
    const identity: AuthenticatedIdentity = {
      actorId: actor.actorId,
      workspaceId: householdId,
      role: 'member',
      deviceId: actor.deviceId,
    };
    return {
      runTurn: (input) =>
        orchestrator.runTurn(normalizeRestTurn({ text: input.text, intentionId: input.intentionId }, identity)),
    };
  };

  itIfDatabase(
    'GW-023 golden vertical: propose → confirm → execute books exactly one canonical transaction (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      // `createAccount` bootstraps the default category catalog (production
      // behavior): a fresh workspace already carries the `Alimentação` macro.
      const category = { id: await readCategoryIdByName(db, householdId, 'Alimentação') };
      const harness = createCaseHarness(householdId, actor);

      // ── Turn 1: the proposal. A proposal NEVER moves money. ──────────────
      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw023-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');
      // Secondary evidence only: the deterministic confirm-prompt copy
      // (golden GW-001/GW-023 `mustMatch: ["Confirma\\?"]`).
      expect(proposed.response?.text).toMatch(/Confirma\?/);
      expect(proposed.response?.text).not.toMatch(/registrado/i);

      const afterPropose = await readPendingRow(db, operationId, householdId);
      expect(afterPropose.execution_status).toBe('proposed');
      expect(afterPropose.tool).toBe('transactions.expense.create');
      expect(afterPropose.actor_id).toBe(actor.actorId);
      expect(afterPropose.device_id).toBe(actor.deviceId);
      expect(afterPropose.attestation_hash).toBeNull();
      expect(afterPropose.mutation_id).toBeNull();
      expect(afterPropose.execution_result).toBeNull();
      expect(afterPropose.normalized_args).toMatchObject({
        amountCents: 5000,
        accountId: account.id,
        categoryId: category.id,
      });
      expect(await countTransactions(db, householdId)).toBe(0);
      expect(await countPendingForTenant(db, householdId)).toBe(1);

      // ── Turn 2: explicit human confirmation executes once. ───────────────
      const executed = await harness.runTurn({ text: 'sim', intentionId: `golden-gw023-confirm-${randomUUID()}` });
      expect(executed.mutation?.status).toBe('succeeded');
      const receipt = executed.mutation?.receipt;
      expect(receipt).toBeTruthy();
      // Secondary evidence only: the deterministic success copy.
      expect(executed.response?.text).toBe(renderMutationResult('succeeded'));

      // ── Authoritative postconditions, read from SQL. ────────────────────
      const afterExecute = await readPendingRow(db, operationId, householdId);
      expect(afterExecute.execution_status).toBe('succeeded');
      expect(afterExecute.mutation_id).toBe(receipt?.mutationId);
      const persisted = afterExecute.execution_result;
      expect(persisted).not.toBeNull();
      const persistedReceipt = (persisted as { receipt?: Record<string, unknown> } | null)?.receipt;
      expect(persistedReceipt).toMatchObject({
        operationId,
        mutationId: receipt?.mutationId,
        mutationKind: 'transactions.expense.create',
      });

      const rows = await readTransactionRows(db, householdId);
      expect(rows).toHaveLength(1);
      const transaction = rows[0]!;
      expect(transaction).toMatchObject({
        kind: 'expense',
        amount_cents: 5000,
        account_id: account.id,
        category_id: category.id,
        household_id: householdId,
      });
      // The relayed receipt and the persisted receipt both name the SAME
      // authoritative transaction row — never a synthesized id.
      expect(receipt?.entity).toEqual({ type: 'transaction', id: transaction.id });
      expect((persistedReceipt as { entity?: unknown } | undefined)?.entity).toEqual({
        type: 'transaction',
        id: transaction.id,
      });
      expect(await countPendingForTenant(db, householdId)).toBe(1);
      // ADR-018: exact balance delta, no clamp, no rounding.
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);
    },
    60_000,
  );

  itIfDatabase(
    'GW-024 golden vertical: propose → cancel books zero transactions (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      // `createAccount` bootstraps the default category catalog (production
      // behavior): a fresh workspace already carries the `Alimentação` macro.
      const category = { id: await readCategoryIdByName(db, householdId, 'Alimentação') };
      const harness = createCaseHarness(householdId, actor);

      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw024-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');
      const proposedRow = await readPendingRow(db, operationId, householdId);
      expect(proposedRow.execution_status).toBe('proposed');
      // The cancelled operation must be the one that was proposed, with the
      // exact canonical args — never an unrelated pending row.
      expect(proposedRow.normalized_args).toMatchObject({
        amountCents: 5000,
        accountId: account.id,
        categoryId: category.id,
      });

      const cancelled = await harness.runTurn({ text: 'cancela', intentionId: `golden-gw024-cancel-${randomUUID()}` });
      expect(cancelled.mutation).toBeUndefined();
      // Secondary evidence only: the deterministic cancel copy.
      expect(cancelled.response?.text).toBe(renderMutationResult('cancelled'));

      // ── Authoritative postconditions, read from SQL. ────────────────────
      const afterCancel = await readPendingRow(db, operationId, householdId);
      expect(afterCancel.execution_status).toBe('cancelled');
      expect(afterCancel.mutation_id).toBeNull();
      expect(afterCancel.attestation_hash).toBeNull();
      expect(afterCancel.execution_result).toBeNull();
      expect(await countTransactions(db, householdId)).toBe(0);
      expect(await readAccountBalanceCents(db, account.id)).toBe(50_000);
    },
    60_000,
  );

  itIfDatabase(
    'GW-025 golden vertical: confirmation without a proposal writes nothing (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const harness = createCaseHarness(householdId, actor);

      const answered = await harness.runTurn({ text: 'sim', intentionId: `golden-gw025-${randomUUID()}` });
      expect(answered.mutation).toBeUndefined();
      expect(answered.response?.text).toContain('nenhuma operação pendente');

      // ── Authoritative postconditions, read from SQL. ────────────────────
      expect(await countPendingForTenant(db, householdId)).toBe(0);
      expect(await countTransactions(db, householdId)).toBe(0);
    },
    60_000,
  );

  // ─── Bloco A fase 2 — redelivery & recovery (issue #105) ──────────────────
  //
  // The three cases below extend the SAME suite, harness, seam, guards and SQL
  // oracle above: GW-023 confirm redelivery (same intentionId re-sent),
  // GW-023 lost-execute-response recovery (effect persisted, reply lost), and
  // GW-023 inconclusive-execute (backend reply without a valid receipt).
  // Faults are per-case single-shot wrappers OVER the real seam
  // (pass-through first, so the server really persists) — never a global
  // mock. `faultsInjected`/`executeCalls` are asserted, so a wrapper that
  // never fires (or fires twice) fails instead of silently proving nothing.
  // Each case runs under a UNIQUE synthetic tenant plus an untouched decoy
  // tenant, and cleans only its own fixtures via afterEach.

  /** Matches ONLY the authoritative V2 execute call of the composed app. */
  const isV2ExecuteCall = (method: string, path: string): boolean =>
    method.toUpperCase() === 'POST' && path.includes('/pending-operations/v2/') && path.endsWith('/execute');

  const countOperationRecords = async (db: Pool, workspaceId: string): Promise<number> => {
    const result = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM operation_records WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    return Number(result.rows[0]?.n ?? -1);
  };

  const countAuditLogs = async (db: Pool, workspaceId: string): Promise<number> => {
    const result = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    return Number(result.rows[0]?.n ?? -1);
  };

  itIfDatabase(
    'GW-023 redelivery: re-sent confirmation (same intentionId) books nothing twice — one transaction, stable receipt (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const harness = createCaseHarness(householdId, actor);

      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw023-redelivery-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');

      const confirmIntentionId = `golden-gw023-redelivery-confirm-${randomUUID()}`;
      const first = await harness.runTurn({ text: 'sim', intentionId: confirmIntentionId });
      expect(first.mutation?.status).toBe('succeeded');
      const receipt1 = first.mutation?.receipt;
      // Receipt linkage: the relayed receipt names the pending operation…
      expect(receipt1?.operationId).toBe(operationId);

      const rowsAfterExecute = await readTransactionRows(db, householdId);
      expect(rowsAfterExecute).toHaveLength(1);
      const transactionId = rowsAfterExecute[0]!.id;
      // …and the persisted transaction row — never a synthesized id.
      expect(receipt1?.entity).toEqual({ type: 'transaction', id: transactionId });
      const executedRow = await readPendingRow(db, operationId, householdId);
      expect(executedRow.execution_status).toBe('succeeded');
      expect(executedRow.execution_attempt_count).toBe(1);
      expect(executedRow.execution_claimed_at).not.toBeNull();
      expect(executedRow.execution_lease_expires_at).not.toBeNull();
      const persistedReceipt = (executedRow.execution_result as { receipt?: Record<string, unknown> } | null)?.receipt;
      expect(persistedReceipt).toMatchObject({ operationId, entity: { type: 'transaction', id: transactionId } });
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);
      const snapshotAfterExecute = await readPendingRowJsonb(db, operationId, householdId);

      // ── Redelivery: the SAME confirmation text with the SAME intentionId.
      // PR137-SEC-FIX Fase 1 (A) — DELIBERATE behavior change (standard
      // idempotency: same key → same response): the operation is terminal,
      // so the turn replays the ORIGINAL success (same operationId + same
      // receipt) instead of the old 'nenhuma pendente' copy, and persists
      // nothing. The receipt below is asserted identical to the first one.
      const redelivered = await harness.runTurn({ text: 'sim', intentionId: confirmIntentionId });
      expect(redelivered.mutation?.status).toBe('succeeded');
      expect(redelivered.mutation?.operationId).toBe(operationId);
      expect(redelivered.mutation?.receipt).toEqual(receipt1);
      expect(redelivered.response?.text).toBe(renderMutationResult('succeeded'));

      // ── Authoritative postconditions: nothing moved a second time. ───────
      const rowsAfter = await readTransactionRows(db, householdId);
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0]!.id).toBe(transactionId);
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);
      expect(await readPendingAttemptCount(db, operationId)).toBe(1);
      expect(await readPendingRowJsonb(db, operationId, householdId)).toEqual(snapshotAfterExecute);

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = rowsAfter.length - 1;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      // PR137-SEC-FIX Fase 1 (A): the replay IS the original success — same
      // receipt relayed, never a second effect. FALSE_SUCCESS here means a
      // success that names anything OTHER than the original operation.
      const FALSE_SUCCESS =
        redelivered.mutation?.status !== 'succeeded' ||
        redelivered.mutation?.operationId !== operationId ||
        JSON.stringify(redelivered.mutation?.receipt) !== JSON.stringify(receipt1)
          ? 1
          : 0;
      expect(FALSE_SUCCESS).toBe(0);
      const settledRow = await readPendingRow(db, operationId, householdId);
      const UNAUTHORIZED_MUTATION =
        settledRow.actor_id !== actor.actorId ||
        settledRow.device_id !== actor.deviceId ||
        rowsAfter[0]!.household_id !== householdId
          ? 1
          : 0;
      expect(UNAUTHORIZED_MUTATION).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );

  itIfDatabase(
    'GW-023 recovery: execute persisted but the response was lost — inconclusive, then retry converges with no duplicate (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const baseSeam = createRequestSeam(app!, { householdId, actorId: actor.actorId, deviceId: actor.deviceId });
      // Lost-response fault: the execute REALLY persists server-side, then a
      // transport error is raised instead of the receipt. Fires EXACTLY once.
      let executeCalls = 0;
      let faultsInjected = 0;
      const losingSeam: MutationRequest = async (method, path, opts) => {
        if (isV2ExecuteCall(method, path)) {
          executeCalls += 1;
          if (faultsInjected === 0) {
            faultsInjected += 1;
            await baseSeam(method, path, opts);
            throw Object.assign(new Error('golden.real_api.injected_execute_transport_failure'), {
              statusCode: 502,
              code: 'golden.real_api.injected_execute_transport_failure',
            });
          }
        }
        return baseSeam(method, path, opts);
      };
      const harness = createCaseHarness(householdId, actor, losingSeam);

      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw023-recovery-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');

      const confirmIntentionId = `golden-gw023-recovery-confirm-${randomUUID()}`;
      const answered = await harness.runTurn({ text: 'sim', intentionId: confirmIntentionId });
      expect(faultsInjected).toBe(1);

      // The effect WAS persisted before the failure (authoritative SQL oracle).
      const settledRow = await readPendingRow(db, operationId, householdId);
      expect(settledRow.execution_status).toBe('succeeded');
      expect(settledRow.execution_attempt_count).toBe(1);
      const rows = await readTransactionRows(db, householdId);
      expect(rows).toHaveLength(1);
      const transactionId = rows[0]!.id;
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);

      // …but the agent must communicate INCONCLUSIVE — never success (the
      // receipt never arrived) and never a definitive failure (the money
      // moved). `mutation` stays undefined: no receipt is relayed.
      expect(answered.mutation).toBeUndefined();
      expect(answered.response?.text).toBe(renderInconclusive());
      expect(answered.response?.text).not.toBe(renderMutationResult('succeeded'));
      expect(answered.response?.text).not.toBe(renderMutationResult('failed'));

      // ── Recovery: re-sending the confirmation (same intentionId) converges
      // with the API — the operation is terminal, so no second execution and
      // no duplicate ledger effect.
      const recovered = await harness.runTurn({ text: 'sim', intentionId: confirmIntentionId });
      expect(recovered.mutation).toBeUndefined();
      expect(recovered.response?.text).toContain('nenhuma operação pendente');
      expect(faultsInjected).toBe(1);
      expect(executeCalls).toBe(1);
      const rowsAfter = await readTransactionRows(db, householdId);
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0]!.id).toBe(transactionId);
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);
      expect(await readPendingAttemptCount(db, operationId)).toBe(1);
      // The persisted receipt still names the operation and the landed row.
      const persistedReceipt = (settledRow.execution_result as { receipt?: Record<string, unknown> } | null)?.receipt;
      expect(persistedReceipt).toMatchObject({ operationId, entity: { type: 'transaction', id: transactionId } });

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = rowsAfter.length - 1;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      const FALSE_SUCCESS =
        answered.mutation?.status === 'succeeded' || answered.response?.text === renderMutationResult('succeeded')
          ? 1
          : 0;
      expect(FALSE_SUCCESS).toBe(0);
      const UNAUTHORIZED_MUTATION =
        settledRow.actor_id !== actor.actorId ||
        settledRow.device_id !== actor.deviceId ||
        rowsAfter[0]!.household_id !== householdId
          ? 1
          : 0;
      expect(UNAUTHORIZED_MUTATION).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );

  itIfDatabase(
    'GW-023 inconclusive execute: backend reply without a valid receipt never becomes success — safe state, bounded recovery (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const baseSeam = createRequestSeam(app!, { householdId, actorId: actor.actorId, deviceId: actor.deviceId });
      // Inconclusive-backend fault: the execute REALLY persists server-side,
      // but the reply carries NO valid receipt (id + status only). The
      // executor must fail closed — never a partial success. Fires once.
      let executeCalls = 0;
      const strippingSeam: MutationRequest = async (method, path, opts) => {
        const result = await baseSeam(method, path, opts);
        if (isV2ExecuteCall(method, path)) {
          executeCalls += 1;
          if (executeCalls === 1) {
            const partial = result as unknown as Record<string, unknown>;
            return { id: partial['id'], status: partial['status'] } as unknown as typeof result;
          }
        }
        return result;
      };
      const harness = createCaseHarness(householdId, actor, strippingSeam);

      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw023-inconclusive-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');

      const answered = await harness.runTurn({ text: 'sim', intentionId: `golden-gw023-inconclusive-confirm-${randomUUID()}` });
      expect(executeCalls).toBe(1);

      // Fail-closed: a receipt-less reply is NEVER declared success…
      expect(answered.mutation).toBeUndefined();
      expect(answered.response?.text).not.toBe(renderMutationResult('succeeded'));
      // …and — the effect having landed — NEVER a definitive failure either.
      expect(answered.response?.text).toBe(renderInconclusive());
      expect(answered.response?.text).not.toBe(renderMutationResult('failed'));

      // …the operation holds a safe terminal state: succeeded exactly once,
      // no failure persist, claim/lease intact, receipt naming the landed row.
      const settledRow = await readPendingRow(db, operationId, householdId);
      expect(settledRow.execution_status).toBe('succeeded');
      expect(settledRow.failure_code).toBeNull();
      expect(settledRow.failed_at).toBeNull();
      expect(settledRow.mutation_id).not.toBeNull();
      expect(settledRow.execution_attempt_count).toBe(1);
      expect(settledRow.execution_claimed_at).not.toBeNull();
      expect(settledRow.execution_lease_expires_at).not.toBeNull();
      const rows = await readTransactionRows(db, householdId);
      expect(rows).toHaveLength(1);
      const transactionId = rows[0]!.id;
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);
      const persistedReceipt = (settledRow.execution_result as { receipt?: Record<string, unknown> } | null)?.receipt;
      expect(persistedReceipt).toMatchObject({ operationId, entity: { type: 'transaction', id: transactionId } });
      const recordsBefore = await countOperationRecords(db, householdId);
      const auditsBefore = await countAuditLogs(db, householdId);

      // ── Bounded recovery: a later confirmation converges without a second
      // claim, a second row, or ledger growth — no retry loop is possible.
      const MAX_LEDGER_TRANSACTIONS_PER_OPERATION = 1;
      const recovered = await harness.runTurn({ text: 'sim', intentionId: `golden-gw023-inconclusive-retry-${randomUUID()}` });
      expect(recovered.mutation).toBeUndefined();
      expect(recovered.response?.text).toContain('nenhuma operação pendente');
      expect(executeCalls).toBe(1);
      const rowsAfter = await readTransactionRows(db, householdId);
      expect(rowsAfter.length).toBeLessThanOrEqual(MAX_LEDGER_TRANSACTIONS_PER_OPERATION);
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0]!.id).toBe(transactionId);
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);
      expect(await readPendingAttemptCount(db, operationId)).toBe(1);
      expect(await countOperationRecords(db, householdId)).toBe(recordsBefore);
      expect(await countAuditLogs(db, householdId)).toBe(auditsBefore);

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = rowsAfter.length - MAX_LEDGER_TRANSACTIONS_PER_OPERATION;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      const FALSE_SUCCESS =
        answered.mutation?.status === 'succeeded' || answered.response?.text === renderMutationResult('succeeded')
          ? 1
          : 0;
      expect(FALSE_SUCCESS).toBe(0);
      const UNAUTHORIZED_MUTATION =
        settledRow.actor_id !== actor.actorId ||
        settledRow.device_id !== actor.deviceId ||
        rowsAfter[0]!.household_id !== householdId
          ? 1
          : 0;
      expect(UNAUTHORIZED_MUTATION).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );

  // ─── PR137-SEC-FIX Fase 1 — confirmation redelivery guards ───────────────
  //
  // (A) MATERIAL: a replay of A's confirmation (same intentionId) after A went
  // terminal and B became pending must replay A's original success — never
  // confirm+execute B. (B) SEMANTIC: a resolved target with an unreadable
  // reconciling listing is inconclusive, never a definitive `failed`.
  // Same harness, seam, guards and SQL oracle as the phase-2 cases above.

  itIfDatabase(
    'GW-023 redelivery-guard A (same actor): replay of A after B proposed never confirms B (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const harness = createCaseHarness(householdId, actor);

      // ── A: propose → confirm → execute (terminal success). ───────────────
      const proposedA = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw023-guardA-propose-${randomUUID()}`,
      });
      expect(proposedA.mutation?.status).toBe('proposed');
      const operationA = proposedA.mutation?.operationId ?? '';
      expect(operationA).not.toBe('');

      const confirmA = `golden-gw023-guardA-confirm-${randomUUID()}`;
      const first = await harness.runTurn({ text: 'sim', intentionId: confirmA });
      expect(first.mutation?.status).toBe('succeeded');
      expect(first.mutation?.operationId).toBe(operationA);
      const receiptA = first.mutation?.receipt;
      expect(receiptA).toBeTruthy();
      const rowsAfterA = await readTransactionRows(db, householdId);
      expect(rowsAfterA).toHaveLength(1);
      const transactionA = rowsAfterA[0]!.id;

      // ── B: a LATER proposal, now the single decidable operation. ──────────
      const proposedB = await harness.runTurn({
        text: 'gastei 30 de pao categoria alimentação',
        intentionId: `golden-gw023-guardA-proposeB-${randomUUID()}`,
      });
      expect(proposedB.mutation?.status).toBe('proposed');
      const operationB = proposedB.mutation?.operationId ?? '';
      expect(operationB).not.toBe('');
      expect(operationB).not.toBe(operationA);
      const rowB = await readPendingRow(db, operationB, householdId);
      expect(rowB.execution_status).toBe('proposed');
      expect(rowB.normalized_args).toMatchObject({ amountCents: 3000 });

      // ── Redelivery of A's confirmation: MUST replay A, never touch B. ─────
      const replayed = await harness.runTurn({ text: 'sim', intentionId: confirmA });
      expect(replayed.mutation?.status).toBe('succeeded');
      expect(replayed.mutation?.operationId).toBe(operationA);
      expect(replayed.mutation?.receipt).toEqual(receiptA);
      expect(replayed.response?.text).toBe(renderMutationResult('succeeded'));

      // ── Authoritative postconditions: only A moved money; B untouched. ────
      const rowsAfter = await readTransactionRows(db, householdId);
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0]!.id).toBe(transactionA);
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);
      expect(await readPendingAttemptCount(db, operationA)).toBe(1);
      const rowBAfter = await readPendingRow(db, operationB, householdId);
      expect(rowBAfter.execution_status).toBe('proposed');
      expect(rowBAfter.execution_attempt_count).toBe(0);
      expect(rowBAfter.mutation_id).toBeNull();

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = rowsAfter.length - 1;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      const FALSE_SUCCESS =
        replayed.mutation?.operationId !== operationA ||
        JSON.stringify(replayed.mutation?.receipt) !== JSON.stringify(receiptA)
          ? 1
          : 0;
      expect(FALSE_SUCCESS).toBe(0);
      const settledA = await readPendingRow(db, operationA, householdId);
      const UNAUTHORIZED_MUTATION =
        settledA.actor_id !== actor.actorId ||
        settledA.device_id !== actor.deviceId ||
        rowsAfter[0]!.household_id !== householdId
          ? 1
          : 0;
      expect(UNAUTHORIZED_MUTATION).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );

  itIfDatabase(
    'GW-023 redelivery-guard A (cross actor): replay of A never reaches another identity operation (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const other = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const harness = createCaseHarness(householdId, actor);
      const otherHarness = createCaseHarness(householdId, other);

      const proposedA = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw023-guardAX-propose-${randomUUID()}`,
      });
      expect(proposedA.mutation?.status).toBe('proposed');
      const operationA = proposedA.mutation?.operationId ?? '';
      expect(operationA).not.toBe('');

      const confirmA = `golden-gw023-guardAX-confirm-${randomUUID()}`;
      const first = await harness.runTurn({ text: 'sim', intentionId: confirmA });
      expect(first.mutation?.status).toBe('succeeded');
      const receiptA = first.mutation?.receipt;
      expect(receiptA).toBeTruthy();
      const rowsAfterA = await readTransactionRows(db, householdId);
      expect(rowsAfterA).toHaveLength(1);

      // B belongs to a DIFFERENT actor+device of the same workspace.
      const proposedB = await otherHarness.runTurn({
        text: 'gastei 30 de pao categoria alimentação',
        intentionId: `golden-gw023-guardAX-proposeB-${randomUUID()}`,
      });
      expect(proposedB.mutation?.status).toBe('proposed');
      const operationB = proposedB.mutation?.operationId ?? '';
      expect(operationB).not.toBe('');
      const rowB = await readPendingRow(db, operationB, householdId);
      expect(rowB.execution_status).toBe('proposed');
      expect(rowB.actor_id).toBe(other.actorId);
      expect(rowB.device_id).toBe(other.deviceId);

      // Actor 1 redelivers A's confirmation: replays A, leaves B intact.
      const replayed = await harness.runTurn({ text: 'sim', intentionId: confirmA });
      expect(replayed.mutation?.status).toBe('succeeded');
      expect(replayed.mutation?.operationId).toBe(operationA);
      expect(replayed.mutation?.receipt).toEqual(receiptA);

      const rowsAfter = await readTransactionRows(db, householdId);
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0]!.id).toBe(rowsAfterA[0]!.id);
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);
      expect(await readPendingAttemptCount(db, operationA)).toBe(1);
      const rowBAfter = await readPendingRow(db, operationB, householdId);
      expect(rowBAfter.execution_status).toBe('proposed');
      expect(rowBAfter.actor_id).toBe(other.actorId);
      expect(rowBAfter.device_id).toBe(other.deviceId);
      expect(rowBAfter.execution_attempt_count).toBe(0);

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = rowsAfter.length - 1;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      const FALSE_SUCCESS =
        replayed.mutation?.operationId !== operationA ||
        JSON.stringify(replayed.mutation?.receipt) !== JSON.stringify(receiptA)
          ? 1
          : 0;
      expect(FALSE_SUCCESS).toBe(0);
      const UNAUTHORIZED_MUTATION =
        rowBAfter.actor_id !== other.actorId ||
        rowBAfter.device_id !== other.deviceId ||
        rowsAfter[0]!.household_id !== householdId
          ? 1
          : 0;
      expect(UNAUTHORIZED_MUTATION).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );

  itIfDatabase(
    'GW-023 redelivery-guard B: resolved target + unreadable listing is inconclusive, never failed (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const baseSeam = createRequestSeam(app!, { householdId, actorId: actor.actorId, deviceId: actor.deviceId });
      // Double fault, each firing EXACTLY once-after-pass-through: the execute
      // REALLY persists server-side, then the reply is lost; the reconciling
      // listing (2nd GET /v2/active — the 1st resolves the target) is
      // unreadable. The money moved but nothing proves it at the turn.
      const isV2ListActive = (method: string, path: string): boolean =>
        method.toUpperCase() === 'GET' && path.includes('/pending-operations/v2/active');
      let executeCalls = 0;
      let faultsInjected = 0;
      let listCalls = 0;
      let listFaultsInjected = 0;
      const faultingSeam: MutationRequest = async (method, path, opts) => {
        if (isV2ExecuteCall(method, path)) {
          executeCalls += 1;
          if (faultsInjected === 0) {
            faultsInjected += 1;
            await baseSeam(method, path, opts);
            throw Object.assign(new Error('golden.real_api.injected_execute_transport_failure'), {
              statusCode: 502,
              code: 'golden.real_api.injected_execute_transport_failure',
            });
          }
        }
        if (isV2ListActive(method, path)) {
          listCalls += 1;
          if (listCalls > 1) {
            listFaultsInjected += 1;
            throw Object.assign(new Error('golden.real_api.injected_listing_unavailable'), {
              statusCode: 503,
              code: 'golden.real_api.injected_listing_unavailable',
            });
          }
        }
        return baseSeam(method, path, opts);
      };
      const harness = createCaseHarness(householdId, actor, faultingSeam);

      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw023-guardB-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');

      const answered = await harness.runTurn({ text: 'sim', intentionId: `golden-gw023-guardB-confirm-${randomUUID()}` });
      expect(faultsInjected).toBe(1);
      expect(executeCalls).toBe(1);
      expect(listFaultsInjected).toBe(1);

      // The effect WAS persisted before the failure (authoritative SQL oracle).
      const settledRow = await readPendingRow(db, operationId, householdId);
      expect(settledRow.execution_status).toBe('succeeded');
      expect(settledRow.execution_attempt_count).toBe(1);
      const rows = await readTransactionRows(db, householdId);
      expect(rows).toHaveLength(1);
      // The landed row carries a real id (named handle would be write-only).
      expect(rows[0]!.id).toBeTruthy();
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);

      // …but the turn must communicate INCONCLUSIVE — never a definitive
      // failure (the money moved) and never success (no receipt arrived).
      expect(answered.mutation).toBeUndefined();
      expect(answered.response?.text).toBe(renderInconclusive());
      expect(answered.response?.text).not.toBe(renderMutationResult('succeeded'));
      expect(answered.response?.text).not.toBe(renderMutationResult('failed'));

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = rows.length - 1;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      const FALSE_SUCCESS =
        answered.mutation?.status === 'succeeded' || answered.response?.text === renderMutationResult('succeeded')
          ? 1
          : 0;
      expect(FALSE_SUCCESS).toBe(0);
      const UNAUTHORIZED_MUTATION =
        settledRow.actor_id !== actor.actorId ||
        settledRow.device_id !== actor.deviceId ||
        rows[0]!.household_id !== householdId
          ? 1
          : 0;
      expect(UNAUTHORIZED_MUTATION).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );

  itIfDatabase(
    'GW-031 golden vertical (Bloco B): income propose → confirm → execute books exactly one canonical income transaction (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      // The default catalog bootstrapped by `createAccount` carries the
      // `Renda` income macro (production behavior).
      const category = { id: await readCategoryIdByName(db, householdId, 'Renda', 'income') };
      const harness = createCaseHarness(householdId, actor);

      // ── Turn 1: the income proposal. A proposal NEVER moves money. ──────
      const proposed = await harness.runTurn({
        text: 'recebi 200 de salário categoria renda',
        intentionId: `golden-gw031-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');
      expect(proposed.response?.text).toMatch(/Confirma\?/);
      expect(proposed.response?.text).not.toMatch(/registrado/i);

      const afterPropose = await readPendingRow(db, operationId, householdId);
      expect(afterPropose.execution_status).toBe('proposed');
      expect(afterPropose.tool).toBe('transactions.income.create');
      expect(afterPropose.actor_id).toBe(actor.actorId);
      expect(afterPropose.device_id).toBe(actor.deviceId);
      expect(afterPropose.normalized_args).toMatchObject({
        amountCents: 20000,
        accountId: account.id,
        categoryId: category.id,
      });
      expect(await countTransactions(db, householdId)).toBe(0);

      // ── Turn 2: explicit human confirmation executes once. ──────────────
      const executed = await harness.runTurn({ text: 'sim', intentionId: `golden-gw031-confirm-${randomUUID()}` });
      expect(executed.mutation?.status).toBe('succeeded');
      const receipt = executed.mutation?.receipt;
      expect(receipt).toBeTruthy();
      expect(executed.response?.text).toBe(renderMutationResult('succeeded'));

      // ── Authoritative postconditions, read from SQL. ────────────────────
      const afterExecute = await readPendingRow(db, operationId, householdId);
      expect(afterExecute.execution_status).toBe('succeeded');
      expect(afterExecute.mutation_id).toBe(receipt?.mutationId);
      const rows = await readTransactionRows(db, householdId);
      expect(rows).toHaveLength(1);
      const transaction = rows[0]!;
      expect(transaction).toMatchObject({
        kind: 'income',
        amount_cents: 20000,
        account_id: account.id,
        category_id: category.id,
        household_id: householdId,
      });
      expect(receipt?.entity).toEqual({ type: 'transaction', id: transaction.id });
      // ADR-018: exact balance delta, no clamp, no rounding.
      expect(await readAccountBalanceCents(db, account.id)).toBe(70_000);

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = rows.length - 1;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      const FALSE_SUCCESS =
        executed.mutation?.status === 'succeeded' && rows.length === 0 ? 1 : 0;
      expect(FALSE_SUCCESS).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );

  itIfDatabase(
    'GW-032 concurrency (Bloco B): two confirm+execute pipelines racing one operation book exactly one effect (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const seam = createRequestSeam(app!, { householdId, actorId: actor.actorId, deviceId: actor.deviceId });
      const headers = {
        'x-workspace-id': householdId,
        'x-actor-id': actor.actorId,
        'x-device-id': actor.deviceId,
      };
      // Propose through the conversational vertical (keeps the golden shape).
      const harness = createCaseHarness(householdId, actor);
      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw032-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');

      // Race two confirms: the row lock serializes them — the first confirms,
      // the second re-emits (rotating the attestation, invalidating the
      // first). Which response holds the live attestation depends on lock
      // order, so the test determines it empirically: exactly one of the two
      // executes, the other is refused with zero effect — in either order.
      const confirmCall = () =>
        seam<{ attestation?: string }>('POST', `/pending-operations/v2/${operationId}/confirm`, { headers, body: {} });
      const [c1, c2] = await Promise.all([confirmCall(), confirmCall()]);
      expect(c1.attestation).toBeTruthy();
      expect(c2.attestation).toBeTruthy();
      expect(c2.attestation).not.toBe(c1.attestation);

      const tryExecute = async (attestation: string | undefined): Promise<{ code: string; status: number; succeeded: boolean }> => {
        try {
          await seam('POST', `/pending-operations/v2/${operationId}/execute`, {
            headers,
            body: { attestation },
          });
          return { code: 'ok', status: 200, succeeded: true };
        } catch (error) {
          return {
            code: String((error as { code?: unknown }).code ?? ''),
            status: Number((error as { statusCode?: unknown }).statusCode ?? 0),
            succeeded: false,
          };
        }
      };
      const first = await tryExecute(c1.attestation);
      // The loser is refused with zero effect: a stale attestation replays as
      // 403; an in-flight execution (had the winner already claimed) as 409.
      // Exactly one pipeline succeeds — the SQL oracle below proves the
      // single effect.
      const second = first.succeeded
        ? await tryExecute(c2.attestation)
        : await (async () => {
            expect(first.code).toBe('approval.attestation_replayed');
            expect(first.status).toBe(403);
            const winner = await tryExecute(c2.attestation);
            expect(winner.succeeded).toBe(true);
            return winner;
          })();
      if (first.succeeded) {
        expect(second.succeeded).toBe(false);
        expect(second.code).toBe('approval.attestation_replayed');
        expect(second.status).toBe(403);
      }
      const successes = [first, second].filter((r) => r.succeeded).length;
      expect(successes).toBe(1);

      // ── Authoritative postconditions, read from SQL. ────────────────────
      const settledRow = await readPendingRow(db, operationId, householdId);
      expect(settledRow.execution_status).toBe('succeeded');
      expect(settledRow.execution_attempt_count).toBe(1);
      const rows = await readTransactionRows(db, householdId);
      expect(rows).toHaveLength(1);
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = rows.length - 1;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      const UNAUTHORIZED_MUTATION =
        settledRow.actor_id !== actor.actorId ||
        settledRow.device_id !== actor.deviceId ||
        rows[0]!.household_id !== householdId
          ? 1
          : 0;
      expect(UNAUTHORIZED_MUTATION).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );

  itIfDatabase(
    'GW-040 read-after-execute (Bloco B): authoritative GET names the landed transaction; unknown id is 403 with no existence leak (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const seam = createRequestSeam(app!, { householdId, actorId: actor.actorId, deviceId: actor.deviceId });
      const harness = createCaseHarness(householdId, actor);
      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw040-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const operationId = proposed.mutation?.operationId ?? '';
      expect(operationId).not.toBe('');
      const executed = await harness.runTurn({ text: 'sim', intentionId: `golden-gw040-confirm-${randomUUID()}` });
      expect(executed.mutation?.status).toBe('succeeded');
      const rows = await readTransactionRows(db, householdId);
      expect(rows).toHaveLength(1);
      const transactionId = rows[0]!.id;

      // The authoritative read names the landed transaction row.
      const headers = {
        'x-workspace-id': householdId,
        'x-actor-id': actor.actorId,
        'x-device-id': actor.deviceId,
      };
      const seen = await seam<{
        id?: string;
        status?: string;
        receipt?: { entity?: { type?: string; id?: string } };
      }>('GET', `/pending-operations/v2/${operationId}`, { headers });
      expect(seen.id).toBe(operationId);
      expect(seen.status).toBe('succeeded');
      expect(seen.receipt?.entity).toEqual({ type: 'transaction', id: transactionId });

      // An unknown id answers 403 (never 404): no existence oracle.
      let unknownCode = '';
      let unknownStatus = 0;
      try {
        await seam('GET', `/pending-operations/v2/${randomUUID()}`, { headers });
      } catch (error) {
        unknownCode = String((error as { code?: unknown }).code ?? '');
        unknownStatus = Number((error as { statusCode?: unknown }).statusCode ?? 0);
      }
      expect(unknownCode).toBe('approval.forbidden');
      expect(unknownStatus).toBe(403);

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );
});
//
// GW-030 proves the complete conversational undo vertical through the REAL
// surface: expense booked via the orchestrator, `desfaz` proposing through
// `UndoProposalService` (Agent-side two-step, SQLite-backed like the DO
// store), the authenticated decision (the PWA button path, driven here
// directly on the service) executing the reversal through the REAL undo API,
// and the replay converging without a second effect. SQL postconditions are
// authoritative; response copy is secondary evidence.
//
// Composition note: this describe mounts its own app with the V2 approval
// surface PLUS `POST /pending-operations/undo` (same route shape as
// production in routes/index.ts). The V2-only composition above is untouched.

type UndoApiDeps = Readonly<{
  store: SqlUndoProposalStore;
  preview: (identity: UndoIdentity) => Promise<{ id: string } | null>;
  api: {
    undo: (input: { lastOperationId: string; idempotencyKey: string; identity: UndoIdentity }) => Promise<unknown>;
  };
}>;

describe('F4 golden Bloco B — conversational undo against the authoritative PostgreSQL API (issue #105)', () => {
  let pool: Pool | undefined;
  let writes: ReturnType<typeof createPostgresWriteStore> | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    if (envState.state === 'partial') {
      throw new Error(
        `golden.real_api.partial_env: refusing to run — ${envState.missing.join(' and ')} must be provided together with the other variable. ` +
          'A half-configured environment fails closed; it never degrades to a skip.',
      );
    }
    if (envState.state !== 'full') return;
    pool = createPool({ connectionString: envState.databaseUrl, max: 8 });
    await requireTestDatabase(pool, 'golden-agent-real-api-bloco-b');
    await runMigrations(pool);
    writes = createPostgresWriteStore({ pool });
    app = composeUndoCapableApp(pool);
    await app.ready();
  }, 120_000);

  afterEach(async () => {
    if (!pool) return;
    for (const householdId of [...tenants]) await cleanupTenant(pool, householdId);
  });

  afterAll(async () => {
    if (pool && tenants.size > 0) {
      for (const householdId of [...tenants]) await cleanupTenant(pool, householdId);
    }
    await app?.close();
    await pool?.end();
  });

  const createUndoCaseHarness = (
    householdId: string,
    actor: Readonly<{ actorId: string; deviceId: string }>,
    undoDeps: UndoApiDeps,
  ): Readonly<{
    runTurn: (input: Readonly<{ text: string; intentionId: string }>) => Promise<TurnResult>;
    undoService: UndoProposalService;
  }> => {
    const db = pool!;
    const readModel = createPostgresReadModelStore({ pool: db });
    const entityReader = {
      scope: { workspaceId: householdId },
      listAccounts: async () =>
        (await readModel.listAccounts(householdId)).map((account) => ({
          id: account.id,
          name: account.name,
          status: account.status,
        })),
      listCategories: async () =>
        (await readModel.listCategories(householdId)).map((category) => ({
          id: category.id,
          name: category.name,
          status: category.status,
        })),
    };
    const undoService = new UndoProposalService({ store: undoDeps.store, preview: undoDeps.preview, api: undoDeps.api });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: new MutationApiClient({
        request: createRequestSeam(app!, { householdId, actorId: actor.actorId, deviceId: actor.deviceId }),
        events: () => {},
      }),
      draftStore: new InMemoryMutationDraftStore(),
      undoProposals: { store: undoDeps.store, preview: undoDeps.preview, api: undoDeps.api },
      entityReader,
      evidenceProvider: async () =>
        createEvidenceEnvelope([
          { ref: 'accounts', source: 'golden-real-api', retrievedAt: new Date().toISOString(), status: 'empty', reason: 'period_empty', data: [] },
          { ref: 'transactions', source: 'golden-real-api', retrievedAt: new Date().toISOString(), status: 'empty', reason: 'period_empty', data: [] },
        ]),
      responseProvider: async () => 'Resposta do harness PostgreSQL, sem alegações financeiras.',
      events: () => {},
    });
    const identity: AuthenticatedIdentity = {
      actorId: actor.actorId,
      workspaceId: householdId,
      role: 'member',
      deviceId: actor.deviceId,
    };
    return {
      runTurn: (input) =>
        orchestrator.runTurn(normalizeRestTurn({ text: input.text, intentionId: input.intentionId }, identity)),
      undoService,
    };
  };

  itIfDatabase(
    'GW-030 conversational undo (Bloco B): expense → desfazer proposal → button decision reverses exactly once, replay converges (SQL-verified)',
    async () => {
      const db = pool!;
      const { householdId } = await seedTenant(db);
      const decoy = await seedTenant(db);
      const actor = { actorId: randomUUID(), deviceId: randomUUID() };
      const undoIdentity: UndoIdentity = { workspaceId: householdId, actorId: actor.actorId, deviceId: actor.deviceId };
      const account = await writes!.createAccount(householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const decoyAccount = await writes!.createAccount(decoy.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const undoSeam = createRequestSeam(
        app!,
        { householdId, actorId: actor.actorId, deviceId: actor.deviceId },
        UNDO_CAPABILITIES,
      );
      let undoApiCalls = 0;
      const harness = createUndoCaseHarness(householdId, actor, {
        store: createUndoProposalStore(),
        preview: previewLastReversibleAudit(db),
        api: {
          undo: async ({ lastOperationId, idempotencyKey, identity }) => {
            undoApiCalls += 1;
            return undoSeam('POST', '/pending-operations/undo', {
              headers: {
                'x-workspace-id': identity.workspaceId,
                'x-actor-id': identity.actorId,
                'x-device-id': identity.deviceId,
              },
              body: { lastOperationId },
              idempotencyKey,
            });
          },
        },
      });

      // ── Turns 1–2: book the expense through the conversational vertical.
      const proposed = await harness.runTurn({
        text: 'gastei 50 de carne categoria alimentação',
        intentionId: `golden-gw030-propose-${randomUUID()}`,
      });
      expect(proposed.mutation?.status).toBe('proposed');
      const confirmed = await harness.runTurn({ text: 'sim', intentionId: `golden-gw030-confirm-${randomUUID()}` });
      expect(confirmed.mutation?.status).toBe('succeeded');
      const rows = await readTransactionRows(db, householdId);
      expect(rows).toHaveLength(1);
      const transactionId = rows[0]!.id;
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);

      // ── Turn 3: conversational undo PROPOSES — free text never executes.
      const undoRequestId = `golden-gw030-undo-${randomUUID()}`;
      const asked = await harness.runTurn({ text: 'desfaz o último lançamento', intentionId: undoRequestId });
      const apiCallsAfterTextTurn = undoApiCalls;
      expect(apiCallsAfterTextTurn).toBe(0);
      expect(asked.undoProposal?.status).toBe('proposed');
      expect(asked.response?.text).toContain('botão');
      expect(await countTransactions(db, householdId)).toBe(1);
      expect(await readAccountBalanceCents(db, account.id)).toBe(45_000);

      // ── The authenticated decision (PWA button path): confirm once. ─────
      const decided = await harness.undoService.decide({ requestId: undoRequestId, decision: 'confirm', identity: undoIdentity });
      expect(decided.kind).toBe('confirmed');
      if (decided.kind !== 'confirmed') throw new Error('golden-gw030: expected the undo decision to confirm');
      expect(undoApiCalls).toBe(1);
      expect(decided.result).toMatchObject({
        undone: { operation: 'transactions.expense.create', entityId: transactionId, reversal: 'soft_delete' },
      });

      // ── Authoritative postconditions: reversed exactly once. ─────────────
      expect(await readTransactionRows(db, householdId)).toHaveLength(0);
      expect(await readAccountBalanceCents(db, account.id)).toBe(50_000);

      // ── Replay of the same decision converges without a second effect. ──
      const replayed = await harness.undoService.decide({ requestId: undoRequestId, decision: 'confirm', identity: undoIdentity });
      expect(replayed.kind).toBe('confirmed');
      expect(undoApiCalls).toBe(1);
      expect(await readTransactionRows(db, householdId)).toHaveLength(0);
      expect(await readAccountBalanceCents(db, account.id)).toBe(50_000);

      // ── Mandatory invariants (explicitly named). ─────────────────────────
      const DUPLICATE_FINANCIAL_EFFECT = (await readTransactionRows(db, householdId)).length;
      expect(DUPLICATE_FINANCIAL_EFFECT).toBe(0);
      const FALSE_SUCCESS =
        asked.undoProposal?.status === 'proposed' && apiCallsAfterTextTurn === 0 ? 0 : 1;
      expect(FALSE_SUCCESS).toBe(0);
      const CROSS_WORKSPACE_LEAK =
        (await countTransactions(db, decoy.householdId)) !== 0 ||
        (await readAccountBalanceCents(db, decoyAccount.id)) !== 50_000 ||
        (await countOrphanLedgerRows(db, [householdId, decoy.householdId])) !== 0
          ? 1
          : 0;
      expect(CROSS_WORKSPACE_LEAK).toBe(0);
    },
    60_000,
  );
});

// ─── Request seam semantics (always run; pure, no database) ─────────────────

describe('golden real-api request seam — pinned fixture identity (no database)', () => {
  const fixture = { householdId: 'hhhh-hhhh-0001', actorId: 'aaaa-aaaa-0001', deviceId: 'dddd-dddd-0001' };

  /** Records what the seam injects without ever touching a database. */
  const stubApp = () => {
    const injected: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const app = {
      inject: async (req: { method: string; url: string; headers: Record<string, string> }) => {
        injected.push({ method: req.method, url: req.url, headers: req.headers });
        return { statusCode: 200, body: '{"ok":true}' };
      },
    };
    return { app: app as unknown as FastifyInstance, injected };
  };

  const identityHeaders = (overrides: Partial<typeof fixture> = {}) => ({
    'x-workspace-id': overrides.householdId ?? fixture.householdId,
    'x-actor-id': overrides.actorId ?? fixture.actorId,
    'x-device-id': overrides.deviceId ?? fixture.deviceId,
  });

  it('fails closed when any identity leg is missing', async () => {
    const { app, injected } = stubApp();
    const seam = createRequestSeam(app, fixture);
    await expect(
      seam('POST', '/pending-operations/v2/active', { headers: { 'x-workspace-id': fixture.householdId } }),
    ).rejects.toMatchObject({ code: 'golden.real_api.missing_identity' });
    expect(injected).toHaveLength(0);
  });

  it('rejects a workspace different from the pinned fixture instead of signing it', async () => {
    const { app, injected } = stubApp();
    const seam = createRequestSeam(app, fixture);
    await expect(
      seam('GET', '/pending-operations/v2/active', { headers: identityHeaders({ householdId: 'hhhh-hhhh-9999' }) }),
    ).rejects.toMatchObject({ code: 'golden.real_api.identity_mismatch' });
    expect(injected).toHaveLength(0);
  });

  it('rejects an actor different from the pinned fixture instead of signing it', async () => {
    const { app, injected } = stubApp();
    const seam = createRequestSeam(app, fixture);
    await expect(
      seam('GET', '/pending-operations/v2/active', { headers: identityHeaders({ actorId: 'aaaa-aaaa-9999' }) }),
    ).rejects.toMatchObject({ code: 'golden.real_api.identity_mismatch' });
    expect(injected).toHaveLength(0);
  });

  it('rejects a device different from the pinned fixture instead of signing it', async () => {
    const { app, injected } = stubApp();
    const seam = createRequestSeam(app, fixture);
    await expect(
      seam('GET', '/pending-operations/v2/active', { headers: identityHeaders({ deviceId: 'dddd-dddd-9999' }) }),
    ).rejects.toMatchObject({ code: 'golden.real_api.identity_mismatch' });
    expect(injected).toHaveLength(0);
  });

  it('signs exactly the pinned identity and never forwards caller identity headers', async () => {
    const { app, injected } = stubApp();
    const seam = createRequestSeam(app, fixture);
    const result = await seam('GET', '/pending-operations/v2/active', { headers: identityHeaders() });
    expect(result).toEqual({ ok: true });
    expect(injected).toHaveLength(1);
    const headers = injected[0]!.headers;
    const token = (headers['authorization'] ?? '').replace('Bearer ', '');
    expect(token).not.toBe('');
    // Identity travels in the SIGNED token, never in caller-shaped headers.
    expect(headers['x-workspace-id']).toBeUndefined();
    expect(headers['x-actor-id']).toBeUndefined();
    expect(headers['x-device-id']).toBeUndefined();
    const claims = await verifyDelegatedTurnToken(token, DELEGATION_SECRET, Date.now());
    expect(claims.workspace).toBe(fixture.householdId);
    expect(claims.sub).toBe(fixture.actorId);
    expect(claims.deviceId).toBe(fixture.deviceId);
    expect(claims.role).toBe('member');
    expect(claims.capabilities).toEqual([...APPROVAL_CAPABILITIES]);
  });
});

// ─── Cleanup semantics (always run; pure, no database) ──────────────────────

describe('golden real-api cleanup — transactional, fixture-scoped, loud (no database)', () => {
  const fakeTxPool = (handlers: {
    owner?: Readonly<{ owner_user_id: string }>;
    failOn?: string;
    leftovers?: ReadonlyArray<{ table_name: string; n: number }>;
  }) => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (handlers.failOn !== undefined && sql.includes(handlers.failOn)) {
          throw new Error(`golden.real_api.fake_db_failure:${handlers.failOn}`);
        }
        const trimmed = sql.trim();
        if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') return { rows: [] };
        if (sql.includes('SELECT owner_user_id')) return { rows: handlers.owner !== undefined ? [handlers.owner] : [] };
        if (sql.includes('UNION ALL')) return { rows: [...(handlers.leftovers ?? [])] };
        return { rows: [] };
      },
      release: () => {},
    };
    return { pool: { connect: async () => client } as unknown as Pool, calls };
  };

  it('deletes every fixture table in ONE transaction, children before parents', async () => {
    const { pool, calls } = fakeTxPool({ owner: { owner_user_id: 'owner-1' } });
    const householdId = 'hhhh-cleanup-0001';
    trackedTenants.add(householdId);
    await cleanupTenant(pool, householdId);
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
    const deleteOrder = sqls
      .filter((s) => s.startsWith('DELETE FROM'))
      .map((s) => s.slice('DELETE FROM '.length).split(' ')[0]);
    expect(deleteOrder).toEqual([
      'audit_logs',
      'operation_records',
      'pending_operations',
      'transactions',
      'idempotency_keys',
      'categories',
      'accounts',
      // `memberships` is intentionally absent: the sole active owner is removed
      // by the households DELETE through ON DELETE CASCADE, never by an explicit
      // membership delete (which the shared-owner guards reject while the shared
      // household row still exists — see cleanupTenant).
      'households',
      'users',
    ]);
    // The cascade contract is pinned: no bare membership delete is ever issued,
    // yet the cascade-removed membership is still proven gone by the postcondition.
    expect(sqls).not.toContain('DELETE FROM memberships WHERE household_id = $1');
    expect(calls.find((c) => c.sql.includes('UNION ALL'))?.sql).toContain("SELECT 'memberships'");
    // Canonical-scoped fixture deletes only.
    for (const table of ['audit_logs', 'operation_records', 'pending_operations']) {
      const call = calls.find((c) => c.sql === `DELETE FROM ${table} WHERE workspace_id = $1`);
      expect(call, table).toBeTruthy();
      expect(call?.params).toEqual([householdId]);
    }
    for (const table of ['transactions', 'idempotency_keys', 'categories', 'accounts']) {
      const call = calls.find((c) => c.sql === `DELETE FROM ${table} WHERE household_id = $1`);
      expect(call, table).toBeTruthy();
      expect(call?.params).toEqual([householdId]);
    }
    expect(calls.find((c) => c.sql === 'DELETE FROM households WHERE id = $1')?.params).toEqual([householdId]);
    // The owner user is deleted by the RESOLVED owner id, never by the workspace id.
    expect(calls.find((c) => c.sql === 'DELETE FROM users WHERE id = $1')?.params).toEqual(['owner-1']);
    expect(trackedTenants.has(householdId)).toBe(false);
    trackedTenants.delete(householdId);
  });

  it('surfaces delete failures with ROLLBACK and keeps the tenant tracked', async () => {
    const { pool, calls } = fakeTxPool({ owner: { owner_user_id: 'owner-1' }, failOn: 'DELETE FROM accounts' });
    const householdId = 'hhhh-cleanup-0002';
    trackedTenants.add(householdId);
    await expect(cleanupTenant(pool, householdId)).rejects.toThrow('golden.real_api.fake_db_failure');
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(trackedTenants.has(householdId)).toBe(true);
    trackedTenants.delete(householdId);
  });

  it('ROLLs back and surfaces ANY leftover fixture (household/audit/pending/transaction)', async () => {
    const { pool, calls } = fakeTxPool({
      owner: { owner_user_id: 'owner-1' },
      leftovers: [{ table_name: 'transactions', n: 2 }],
    });
    const householdId = 'hhhh-cleanup-0003';
    trackedTenants.add(householdId);
    await expect(cleanupTenant(pool, householdId)).rejects.toThrow(/golden\.real_api\.cleanup_leftover.*transactions=2/);
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(trackedTenants.has(householdId)).toBe(true);
    trackedTenants.delete(householdId);
  });

  it('does not invent an owner delete when the fixture household is already gone', async () => {
    const { pool, calls } = fakeTxPool({});
    const householdId = 'hhhh-cleanup-0004';
    trackedTenants.add(householdId);
    await cleanupTenant(pool, householdId);
    expect(calls.some((c) => c.sql.includes('DELETE FROM users'))).toBe(false);
    expect(trackedTenants.has(householdId)).toBe(false);
    trackedTenants.delete(householdId);
  });
});

// ─── Seed semantics (always run; pure, no database) ─────────────────────────

describe('golden real-api seed — transactional, tracked only after COMMIT (no database)', () => {
  /**
   * Same fake-transaction seam style as the cleanup block: records the SQL in
   * order and can fail on a chosen statement. Never touches a database.
   */
  const fakeSeedPool = (handlers: { failOn?: string } = {}) => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (handlers.failOn !== undefined && sql.includes(handlers.failOn)) {
          throw new Error(`golden.real_api.fake_db_failure:${handlers.failOn}`);
        }
        return { rows: [] };
      },
      release: () => {},
    };
    return { pool: { connect: async () => client } as unknown as Pool, calls };
  };

  /**
   * Recovers the household id a failed seed attempted, from the derived owner
   * email, so a rejection can be checked against `trackedTenants` precisely
   * (without depending on the shared set being otherwise empty).
   */
  const attemptedHouseholdId = (calls: ReadonlyArray<{ sql: string; params: unknown[] | undefined }>) => {
    const email = calls.find((c) => c.sql.includes('INSERT INTO users'))?.params?.[1];
    if (typeof email !== 'string') return undefined;
    return /^golden-(.+)@example\.test$/.exec(email)?.[1];
  };

  it('seeds user THEN household inside ONE transaction, tracking the tenant only after COMMIT', async () => {
    const { pool, calls } = fakeSeedPool();
    const tenant = await seedTenant(pool);
    const sqls = calls.map((c) => c.sql);

    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');

    const userIndex = sqls.findIndex((s) => s.includes('INSERT INTO users'));
    const householdIndex = sqls.findIndex((s) => s.includes('INSERT INTO households'));
    // Both fixture rows are written INSIDE the transaction, so a failure in
    // between rolls the user back together with the household.
    expect(userIndex).toBeGreaterThan(0);
    expect(householdIndex).toBeGreaterThan(userIndex);
    expect(householdIndex).toBeLessThan(sqls.findIndex((s) => s === 'COMMIT'));

    const userInsert = calls[userIndex]!;
    const householdInsert = calls[householdIndex]!;
    // The household references the seeded owner, and the owner email is derived
    // from the tenant's own household id.
    expect(userInsert.params?.[0]).toBe(tenant.ownerId);
    expect(userInsert.params?.[1]).toBe(`golden-${tenant.householdId}@example.test`);
    expect(householdInsert.params?.[0]).toBe(tenant.householdId);
    expect(householdInsert.params?.[2]).toBe(tenant.ownerId);

    // Registration happens ONLY after a successful COMMIT.
    expect(trackedTenants.has(tenant.householdId)).toBe(true);
    trackedTenants.delete(tenant.householdId);
  });

  it('ROLLs back and does NOT track the tenant when the household insert fails (no orphan user)', async () => {
    const { pool, calls } = fakeSeedPool({ failOn: 'INSERT INTO households' });
    await expect(seedTenant(pool)).rejects.toThrow('golden.real_api.fake_db_failure');

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    // The user row was attempted, but rolled back with the household: the
    // tenant is never registered, so no cleanup chases a half-seeded fixture.
    expect(sqls.some((s) => s.includes('INSERT INTO users'))).toBe(true);
    const householdId = attemptedHouseholdId(calls);
    expect(householdId).toBeTruthy();
    expect(trackedTenants.has(householdId!)).toBe(false);
  });

  it('ROLLs back and writes NO household row when the user insert fails', async () => {
    const { pool, calls } = fakeSeedPool({ failOn: 'INSERT INTO users' });
    await expect(seedTenant(pool)).rejects.toThrow('golden.real_api.fake_db_failure');

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(sqls.some((s) => s.includes('INSERT INTO households'))).toBe(false);

    const householdId = attemptedHouseholdId(calls);
    expect(householdId).toBeTruthy();
    expect(trackedTenants.has(householdId!)).toBe(false);
  });
});

// ─── Cross-actor / cross-workspace isolation of pending V2 operations ────────

/**
 * Every V2 approval capability a probe identity may carry — INCLUDING
 * reconcile/retry/authorize, which the golden verticals above never use. A
 * foreign probe must be rejected by TENANT ISOLATION, never by a narrower
 * capability set, so the probe token deliberately carries the full surface.
 */
const ISOLATION_PROBE_CAPABILITIES: readonly string[] = [
  ...APPROVAL_CAPABILITIES,
  'financial.approval.reconcile',
  'financial.approval.retry',
  'financial.approval.autoexecute',
];

type IsolationIdentity = Readonly<{ householdId: string; actorId: string; deviceId: string }>;

/**
 * Injects a request under a REAL short-lived delegated turn minted for an
 * ARBITRARY identity — the isolation-attacker seam. Unlike
 * `createRequestSeam` (pinned to a case fixture), this intentionally signs the
 * given identity so every probe crosses the REAL token-verification boundary
 * and is decided purely by tenant isolation. The signing secret is the
 * test-only `DELEGATION_SECRET`; no production credential is involved.
 */
const injectAsIdentity = async (
  app: FastifyInstance,
  identity: IsolationIdentity,
  request: Readonly<{ method: 'GET' | 'POST'; url: string; payload?: unknown; idempotencyKey?: string }>,
): Promise<Readonly<{ statusCode: number; body: Record<string, unknown> }>> => {
  const token = await createDelegatedTokenForTest(
    {
      actorId: identity.actorId,
      workspaceId: identity.householdId,
      role: 'member',
      capabilities: [...ISOLATION_PROBE_CAPABILITIES],
      requestId: `golden-isolation-${randomUUID()}`,
      deviceId: identity.deviceId,
    },
    DELEGATION_SECRET,
  );
  const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
  if (request.idempotencyKey !== undefined) headers['idempotency-key'] = request.idempotencyKey;
  let payload: string | undefined;
  if (request.payload !== undefined && request.method === 'POST') {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(request.payload);
  }
  const response = await app.inject({ method: request.method, url: request.url, headers, ...(payload !== undefined ? { payload } : {}) });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (response.body === '' ? {} : JSON.parse(response.body)) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { statusCode: response.statusCode, body: parsed };
};

const readPendingAttemptCount = async (db: Pool, id: string): Promise<number> => {
  const result = await db.query<{ execution_attempt_count: number }>(
    `SELECT execution_attempt_count::int AS execution_attempt_count FROM pending_operations WHERE id = $1`,
    [id],
  );
  return Number(result.rows[0]?.execution_attempt_count ?? -1);
};

const listPendingIdsForTenant = async (db: Pool, workspaceId: string): Promise<readonly string[]> => {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM pending_operations WHERE workspace_id = $1 AND protocol_version = 2 ORDER BY created_at`,
    [workspaceId],
  );
  return result.rows.map((row) => String(row.id));
};

/** Counts pending rows bound to ANY of the given actor/device identities. */
const countPendingRowsForIdentity = async (db: Pool, actors: readonly string[], devices: readonly string[]): Promise<number> => {
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pending_operations WHERE actor_id = ANY($1::text[]) OR device_id = ANY($2::text[])`,
    [actors, devices],
  );
  return Number(result.rows[0]?.n ?? -1);
};

/**
 * Counts pending rows bound to the probing identity's EXACT full triple
 * (workspace + actor + device). The single-dimension attackers deliberately
 * REUSE one or two of the owner's legs, so the OR-shaped probe above would
 * count the owner's own rows for them; the exact triple is the honest "no
 * row was ever created for THIS identity" oracle.
 */
const countPendingRowsForExactIdentity = async (
  db: Pool,
  identity: Readonly<{ householdId: string; actorId: string; deviceId: string }>,
): Promise<number> => {
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pending_operations WHERE workspace_id = $1 AND actor_id = $2 AND device_id = $3`,
    [identity.householdId, identity.actorId, identity.deviceId],
  );
  return Number(result.rows[0]?.n ?? -1);
};

describe('golden real-api isolation — cross-actor and cross-workspace containment of pending V2 operations (issue #105)', () => {
  let pool: Pool | undefined;
  let writes: ReturnType<typeof createPostgresWriteStore> | undefined;
  let app: FastifyInstance | undefined;
  let store: PendingOperationV2Store | undefined;

  beforeAll(async () => {
    // Same fail-closed gate as the golden verticals above.
    if (envState.state === 'partial') {
      throw new Error(
        `golden.real_api.partial_env: refusing to run — ${envState.missing.join(' and ')} must be provided together with the other variable. ` +
          'A half-configured environment fails closed; it never degrades to a skip.',
      );
    }
    if (envState.state !== 'full') return;
    pool = createPool({ connectionString: envState.databaseUrl, max: 8 });
    await requireTestDatabase(pool, 'golden-agent-real-api-isolation');
    await runMigrations(pool);
    writes = createPostgresWriteStore({ pool });
    app = composeAuthoritativeApp(pool);
    // A second store instance on the SAME pool drives the direct
    // store-boundary probes below (the app owns its own instance).
    store = createPostgresPendingOperationV2Store(pool);
    await app.ready();
  }, 120_000);

  afterEach(async () => {
    if (!pool) return;
    for (const householdId of [...tenants]) await cleanupTenant(pool, householdId);
  });

  afterAll(async () => {
    if (pool && tenants.size > 0) {
      for (const householdId of [...tenants]) await cleanupTenant(pool, householdId);
    }
    await app?.close();
    await pool?.end();
  });

  itIfDatabase(
    'a fully-capable foreign identity — same workspace and different workspace — cannot list, read, confirm, cancel, execute or otherwise affect a pending V2 operation (SQL-proven)',
    async () => {
      const db = pool!;
      // Tenant A owns the operations; tenant C is a fully separate workspace.
      const tenantA = await seedTenant(db);
      const tenantC = await seedTenant(db);
      const accountA = await writes!.createAccount(tenantA.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const accountC = await writes!.createAccount(tenantC.householdId, {
        name: 'Conta Corrente',
        kind: 'bank',
        initialBalanceCents: 50_000,
      });
      const categoryA = { id: await readCategoryIdByName(db, tenantA.householdId, 'Alimentação') };

      const owner: IsolationIdentity = { householdId: tenantA.householdId, actorId: randomUUID(), deviceId: randomUUID() };
      // A DIFFERENT authenticated actor inside the SAME workspace.
      const sameWorkspaceOtherActor: IsolationIdentity = {
        householdId: tenantA.householdId,
        actorId: randomUUID(),
        deviceId: randomUUID(),
      };
      // An owner-scoped identity of a DIFFERENT workspace.
      const otherWorkspace: IsolationIdentity = { householdId: tenantC.householdId, actorId: randomUUID(), deviceId: randomUUID() };
      // ── Single-dimension attackers: each changes EXACTLY ONE binding leg of
      // the owner identity and preserves the other two. The dimensions
      // (workspace / actor / device) must be isolated INDEPENDENTLY: an
      // attacker who keeps two legs of the legitimate identity is still
      // refused, so the denial can never depend on all three differing.
      // ONLY the actor changes (owner workspace AND owner device preserved).
      const sameWorkspaceOnlyActor: IsolationIdentity = {
        householdId: owner.householdId,
        actorId: randomUUID(),
        deviceId: owner.deviceId,
      };
      // ONLY the device changes (owner workspace AND owner actor preserved).
      const sameWorkspaceOnlyDevice: IsolationIdentity = {
        householdId: owner.householdId,
        actorId: owner.actorId,
        deviceId: randomUUID(),
      };
      // ONLY the workspace changes (owner actor AND owner device preserved).
      const sameActorOnlyWorkspace: IsolationIdentity = {
        householdId: tenantC.householdId,
        actorId: owner.actorId,
        deviceId: owner.deviceId,
      };

      const propose = async (identity: IsolationIdentity, description: string, key: string): Promise<string> => {
        const response = await injectAsIdentity(app!, identity, {
          method: 'POST',
          url: '/pending-operations/v2/propose',
          idempotencyKey: key,
          payload: {
            tool: 'transactions.expense.create',
            normalizedArgs: {
              description,
              amountCents: 5000,
              date: '2026-10-11',
              accountId: accountA.id,
              categoryId: categoryA.id,
            },
          },
        });
        expect(response.statusCode, `propose ${description}`).toBe(201);
        const id = response.body['id'];
        expect(typeof id, `propose ${description}`).toBe('string');
        return id as string;
      };

      // ── Setup: the owner proposes TWO operations. ─────────────────────────
      const op1 = await propose(owner, 'Golden isolation target', `golden-iso-op1-${randomUUID()}`);
      const op2 = await propose(owner, 'Golden isolation attested sibling', `golden-iso-op2-${randomUUID()}`);

      // Positive control: the OWNER listing sees exactly its two operations.
      const ownerListing = await injectAsIdentity(app!, owner, { method: 'GET', url: '/pending-operations/v2/active' });
      expect(ownerListing.statusCode).toBe(200);
      expect(ownerListing.body['total']).toBe(2);

      // ── BEFORE snapshot (authoritative SQL oracle). ───────────────────────
      const beforeOp1 = await readPendingRow(db, op1, tenantA.householdId);
      const beforeTransactionsA = await countTransactions(db, tenantA.householdId);
      const beforeTransactionsC = await countTransactions(db, tenantC.householdId);
      const beforeBalanceA = await readAccountBalanceCents(db, accountA.id);
      const beforeBalanceC = await readAccountBalanceCents(db, accountC.id);
      const beforeIdsA = await listPendingIdsForTenant(db, tenantA.householdId);

      expect(beforeOp1.execution_status).toBe('proposed');
      expect(beforeOp1.attestation_hash).toBeNull();
      expect(beforeOp1.mutation_id).toBeNull();
      expect(beforeOp1.execution_result).toBeNull();
      expect(await readPendingAttemptCount(db, op1)).toBe(0);
      expect(beforeTransactionsA).toBe(0);
      expect(beforeTransactionsC).toBe(0);
      expect(beforeBalanceA).toBe(50_000);
      expect(beforeBalanceC).toBe(50_000);
      expect([...beforeIdsA].sort()).toEqual([op1, op2].sort());

      // Positive control: the OWNER confirms op2, minting a REAL attestation.
      // Confirmation moves no money; op1 stays proposed for the whole test.
      const ownerConfirm = await injectAsIdentity(app!, owner, { method: 'POST', url: `/pending-operations/v2/${op2}/confirm` });
      expect(ownerConfirm.statusCode).toBe(200);
      const attestation = ownerConfirm.body['attestation'];
      expect(typeof attestation).toBe('string');
      expect((attestation as string).length).toBeGreaterThanOrEqual(32);
      const confirmedOp2 = await readPendingRow(db, op2, tenantA.householdId);
      expect(confirmedOp2.execution_status).toBe('confirmed');
      expect(confirmedOp2.attestation_hash).not.toBeNull();
      expect(confirmedOp2.mutation_id).toBeNull();
      expect(confirmedOp2.execution_result).toBeNull();

      // ── FULL persisted-state snapshots of BOTH rows, AFTER the owner
      // confirm: the original proposed row AND the legitimate confirmed
      // sibling. Every later "unchanged" comparison is taken against these.
      const confirmedSnapshotOp1 = await readPendingRow(db, op1, tenantA.householdId);
      const confirmedSnapshotOp2 = await readPendingRow(db, op2, tenantA.householdId);
      const confirmedSnapshotOp1Jsonb = await readPendingRowJsonb(db, op1, tenantA.householdId);
      const confirmedSnapshotOp2Jsonb = await readPendingRowJsonb(db, op2, tenantA.householdId);
      // The proposed original is untouched by the owner confirming its sibling.
      expect(confirmedSnapshotOp1, 'the owner confirm of op2 left op1 identical').toEqual(beforeOp1);
      // The confirmed sibling's authorization state is fully PERSISTED:
      // attestation hash + issued time + auth mode/reason/risk + authorized
      // time are all set, while consumption/claim/lease/failure/receipt
      // fields remain empty until the owner executes.
      expect(confirmedSnapshotOp2.execution_status).toBe('confirmed');
      expect(confirmedSnapshotOp2.attestation_hash).not.toBeNull();
      expect(confirmedSnapshotOp2.attestation_issued_at).not.toBeNull();
      expect(confirmedSnapshotOp2.authorization_mode).toBe('manual');
      expect(confirmedSnapshotOp2.authorization_reason).toBe('policy_required');
      expect(confirmedSnapshotOp2.risk_tier).toBe('low');
      expect(confirmedSnapshotOp2.authorized_at).not.toBeNull();
      expect(confirmedSnapshotOp2.attestation_consumed_at).toBeNull();
      expect(confirmedSnapshotOp2.execution_claimed_at).toBeNull();
      expect(confirmedSnapshotOp2.execution_lease_expires_at).toBeNull();
      expect(confirmedSnapshotOp2.execution_attempt_count).toBe(0);
      expect(confirmedSnapshotOp2.failure_code).toBeNull();
      expect(confirmedSnapshotOp2.failed_at).toBeNull();
      expect(confirmedSnapshotOp2.mutation_id).toBeNull();
      expect(confirmedSnapshotOp2.execution_result).toBeNull();

      // ── Foreign probes through the REAL API (full capability set). ────────
      // The matrix mixes the two conflation probes (both/all legs changed)
      // with the three single-dimension attackers (exactly one leg changed,
      // the other two preserved from the owner). Every identity carries the
      // FULL capability set, so any denial below is tenant isolation, never
      // a missing capability.
      const foreignIdentities: ReadonlyArray<{ label: string; identity: IsolationIdentity }> = [
        { label: 'same-workspace other actor', identity: sameWorkspaceOtherActor },
        { label: 'other workspace', identity: otherWorkspace },
        { label: 'same-workspace only-actor attacker', identity: sameWorkspaceOnlyActor },
        { label: 'same-workspace only-device attacker', identity: sameWorkspaceOnlyDevice },
        { label: 'only-workspace attacker', identity: sameActorOnlyWorkspace },
      ];

      for (const foreign of foreignIdentities) {
        // Listing never exposes the owner's pending operations.
        const active = await injectAsIdentity(app!, foreign.identity, { method: 'GET', url: '/pending-operations/v2/active' });
        expect(active.statusCode, `${foreign.label} active`).toBe(200);
        expect(active.body['total'], `${foreign.label} active total`).toBe(0);
        expect(active.body['items'], `${foreign.label} active items`).toEqual([]);

        // Read paths: 403 approval.forbidden — never a 404 existence oracle.
        for (const path of [`/pending-operations/v2/${op1}`, `/pending-operations/v2/${op1}/status`]) {
          const response = await injectAsIdentity(app!, foreign.identity, { method: 'GET', url: path });
          expect(response.statusCode, `${foreign.label} GET ${path}`).toBe(403);
          expect(response.body['code'], `${foreign.label} GET ${path}`).toBe('approval.forbidden');
        }

        // Mutation paths on the PROPOSED original — including execute with a
        // guessed attestation. None may move, confirm or cancel anything.
        // execute is special: a claim miss is indistinguishable from a bad
        // token, so it answers attestation_replayed (403) rather than
        // forbidden — never a 404 existence oracle. Every other mutation is
        // refused as approval.forbidden (403).
        const forbiddenMutations: ReadonlyArray<{ action: string; code: string; payload?: unknown }> = [
          { action: 'confirm', code: 'approval.forbidden' },
          { action: 'cancel', code: 'approval.forbidden' },
          { action: 'retry', code: 'approval.forbidden' },
          { action: 'reconcile', code: 'approval.forbidden' },
          { action: 'expire', code: 'approval.forbidden' },
          { action: 'execute', code: 'approval.attestation_replayed', payload: { attestation: 'f'.repeat(32) } },
        ];
        for (const mutation of forbiddenMutations) {
          const response = await injectAsIdentity(app!, foreign.identity, {
            method: 'POST',
            url: `/pending-operations/v2/${op1}/${mutation.action}`,
            ...(mutation.payload !== undefined ? { payload: mutation.payload } : {}),
          });
          expect(response.statusCode, `${foreign.label} ${mutation.action} op1`).toBe(403);
          expect(response.body['code'], `${foreign.label} ${mutation.action} op1`).toBe(mutation.code);
        }

        // The CONFIRMED sibling, including a replay of its REAL attestation.
        for (const action of ['confirm', 'cancel', 'retry', 'reconcile', 'expire']) {
          const response = await injectAsIdentity(app!, foreign.identity, { method: 'POST', url: `/pending-operations/v2/${op2}/${action}` });
          expect(response.statusCode, `${foreign.label} ${action} op2`).toBe(403);
          expect(response.body['code'], `${foreign.label} ${action} op2`).toBe('approval.forbidden');
        }
        const replay = await injectAsIdentity(app!, foreign.identity, {
          method: 'POST',
          url: `/pending-operations/v2/${op2}/execute`,
          payload: { attestation },
        });
        expect(replay.statusCode, `${foreign.label} execute op2 with the owner attestation`).toBe(403);
        expect(replay.body['code'], `${foreign.label} execute op2 with the owner attestation`).toBe('approval.attestation_replayed');
      }

      // ── Foreign probes at the authoritative store boundary. ───────────────
      const probeStore = store!;
      const executorStub = async () => ({ status: 'succeeded', operationId: randomUUID() });
      for (const foreign of foreignIdentities) {
        const identity: PendingIdentity = {
          workspaceId: foreign.identity.householdId,
          actorId: foreign.identity.actorId,
          deviceId: foreign.identity.deviceId,
        };
        // A different workspace cannot see the row at all (not_found); another
        // actor in the SAME workspace is bound out (binding_mismatch).
        const expectedCode = foreign.identity.householdId === tenantA.householdId ? 'approval.binding_mismatch' : 'approval.not_found';
        await expect(probeStore.get(op1, identity), `${foreign.label} store.get`).rejects.toMatchObject({ code: expectedCode });
        await expect(probeStore.confirm(op1, identity), `${foreign.label} store.confirm`).rejects.toMatchObject({ code: expectedCode });
        await expect(
          probeStore.authorize(op1, identity, { mode: 'auto', reason: 'explicit_low_risk', riskTier: 'low' }),
          `${foreign.label} store.authorize`,
        ).rejects.toMatchObject({ code: expectedCode });
        await expect(probeStore.cancel(op1, identity), `${foreign.label} store.cancel`).rejects.toMatchObject({ code: expectedCode });
        await expect(probeStore.expire(op1, identity), `${foreign.label} store.expire`).rejects.toMatchObject({ code: expectedCode });
        await expect(
          probeStore.reconcileExpiredExecuting(op1, identity, executorStub),
          `${foreign.label} store.reconcile`,
        ).rejects.toMatchObject({ code: expectedCode });
        await expect(
          probeStore.execute('z'.repeat(32), identity, executorStub),
          `${foreign.label} store.execute guessed attestation`,
        ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
        expect(await probeStore.listActive(identity), `${foreign.label} store.listActive`).toEqual([]);
        // The confirmed sibling and its real attestation stay out of reach too.
        await expect(probeStore.get(op2, identity), `${foreign.label} store.get op2`).rejects.toMatchObject({ code: expectedCode });
        await expect(
          probeStore.execute(attestation as string, identity, executorStub, op2),
          `${foreign.label} store.execute owner attestation`,
        ).rejects.toMatchObject({ code: 'approval.attestation_replayed' });
      }

      // ── AFTER snapshot (authoritative SQL oracle). ────────────────────────
      const afterOp1 = await readPendingRow(db, op1, tenantA.householdId);
      expect(afterOp1, 'the original operation must be byte-identical').toEqual(beforeOp1);
      expect(await readPendingAttemptCount(db, op1), 'the original was never claimed').toBe(0);
      const afterOp2 = await readPendingRow(db, op2, tenantA.householdId);
      expect(afterOp2.execution_status, 'the confirmed sibling is still confirmed').toBe('confirmed');
      expect(afterOp2.mutation_id).toBeNull();
      expect(afterOp2.execution_result).toBeNull();
      // Both rows are byte-identical to their state right AFTER the owner
      // confirm — attestation hash/consumption/issued time, auth
      // mode/reason/risk/authorized time, attempt count, lease/claim,
      // failure and receipt fields all unchanged.
      expect(afterOp1, 'the original operation must equal its post-confirm snapshot field-for-field').toEqual(confirmedSnapshotOp1);
      expect(afterOp2, 'the confirmed sibling must equal its post-confirm snapshot field-for-field').toEqual(confirmedSnapshotOp2);
      // Whole-row oracle: ANY column change on either row fails here,
      // including columns not enumerated in the typed snapshot above.
      expect(await readPendingRowJsonb(db, op1, tenantA.householdId), 'the original row must be byte-identical in the whole-row oracle').toEqual(confirmedSnapshotOp1Jsonb);
      expect(await readPendingRowJsonb(db, op2, tenantA.householdId), 'the confirmed sibling must be byte-identical in the whole-row oracle').toEqual(confirmedSnapshotOp2Jsonb);
      expect(await countTransactions(db, tenantA.householdId)).toBe(beforeTransactionsA);
      expect(await countTransactions(db, tenantC.householdId)).toBe(beforeTransactionsC);
      expect(await readAccountBalanceCents(db, accountA.id)).toBe(beforeBalanceA);
      expect(await readAccountBalanceCents(db, accountC.id)).toBe(beforeBalanceC);
      const afterIdsA = await listPendingIdsForTenant(db, tenantA.householdId);
      expect([...afterIdsA].sort()).toEqual([op1, op2].sort());
      expect(await listPendingIdsForTenant(db, tenantC.householdId), 'no foreign workspace row was ever written').toEqual([]);
      // The OR-shaped probe applies to the two identities whose actor AND
      // device legs are BOTH fresh — the pre-existing conflation probes. The
      // single-dimension attackers deliberately reuse the owner's workspace,
      // actor or device, so their legs are covered by the exact-triple check
      // right below (the OR shape would otherwise count the owner's own rows).
      expect(
        await countPendingRowsForIdentity(
          db,
          [sameWorkspaceOtherActor.actorId, otherWorkspace.actorId],
          [sameWorkspaceOtherActor.deviceId, otherWorkspace.deviceId],
        ),
        'no row anywhere is bound to a probing actor/device',
      ).toBe(0);
      // No row ANYWHERE matches any probing identity's full triple —
      // conflation probes and single-dimension attackers alike.
      for (const foreign of foreignIdentities) {
        expect(
          await countPendingRowsForExactIdentity(db, foreign.identity),
          `no row anywhere is bound to the ${foreign.label} identity triple`,
        ).toBe(0);
      }
    },
    60_000,
  );
});
