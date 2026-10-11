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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { DelegatedTurnClaims } from '../../src/auth/delegated-token.js';
import { createDelegatedTokenForTest, verifyDelegatedTurnToken } from '../../src/auth/delegated-token.js';
import { requireTestDatabase } from '../../src/db/db-guard.js';
import { createPool } from '../../src/db/pool.js';
import { createPostgresPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
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
import { renderMutationResult } from '../../../agent/src/responses/deterministic-responses.js';
import type { ApiRequestOptions } from '../../../agent/src/tools/api-client.js';

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

const composeAuthoritativeApp = (pool: Pool): FastifyInstance => {
  const app = Fastify({ logger: false });
  // Same shape as the production delegation preHandler (routes/index.ts):
  // verify the signed turn token, then derive identity from the CLAIMS —
  // never from a free header. This is the delegated-token boundary: it proves
  // token/capability verification and downstream persistence, NOT full
  // production user-membership authentication (no session/membership layer).
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
      { actorId, workspaceId, role: 'member', capabilities: [...APPROVAL_CAPABILITIES], requestId: `golden-real-api-${randomUUID()}`, deviceId },
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

type PendingRow = Readonly<{
  id: string;
  workspace_id: string;
  actor_id: string;
  device_id: string;
  tool: string;
  normalized_args: Record<string, unknown>;
  execution_status: string;
  attestation_hash: string | null;
  mutation_id: string | null;
  execution_result: Record<string, unknown> | null;
}>;

const readPendingRow = async (db: Pool, id: string, workspaceId: string): Promise<PendingRow> => {
  const result = await db.query<PendingRow>(
    `SELECT id, workspace_id, actor_id, device_id, tool, normalized_args, execution_status,
            attestation_hash, mutation_id, execution_result
       FROM pending_operations
      WHERE id = $1 AND workspace_id = $2 AND protocol_version = 2`,
    [id, workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`golden.real_api.pending_row_missing:${id}`);
  return row;
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

/**
 * Resolves a seeded default category (the createAccount bootstrap applies the
 * default catalog to a fresh household — production behavior). The golden
 * verticals name `Alimentação`, which is a default macro category, so a fresh
 * synthetic workspace already carries it.
 */
const readCategoryIdByName = async (db: Pool, householdId: string, name: string): Promise<string> => {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM categories
      WHERE household_id = $1 AND parent_id IS NULL AND lower(name) = lower($2)
        AND kind = 'expense' AND status = 'active' AND deleted_at IS NULL
      LIMIT 1`,
    [householdId, name],
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
        request: createRequestSeam(app!, { householdId, actorId: actor.actorId, deviceId: actor.deviceId }),
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
