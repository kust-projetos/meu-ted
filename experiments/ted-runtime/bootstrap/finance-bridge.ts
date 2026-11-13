// One-shot finance bridge (spike 02): executes the REAL pi-financeiro
// handlers against synthetic in-memory data. Run ONLY via the repo's own tsx
// (transport resolves it); never hand-executed against production.
//
// ONE-SHOT LIMIT (S05-REV-01 P1-2): each call is a fresh OS process with a
// FRESH in-memory app + stores — NOTHING persists cross-process. Replay and
// conflict proofs that run inside ONE bridge invocation (verifyReplay /
// verifyConflictBody, same app + same v2Store) prove SAME-INSTANCE real
// Pending V2 semantics only; they prove NOTHING about cross-process or
// restart persistence. Production persists in Postgres; a real restart proof
// needs the durable store, not this ephemeral bridge.
//
// Reads one JSON request from stdin:
//   { token, route, method, seed, fault, workspaceId, tokenStore, access, delayMs }
// Prints one JSON line: { ok, statusCode, body, meta }.
//
// REAL code paths used (no financial logic reimplemented here):
//   - buildTestApp(seed, ...optionals) from apps/api/tests/test-app.ts
//     (real registerRoutes incl. real auth middleware + real route handlers)
//   - real fixtures from apps/api/tests/fixtures/seed.ts (standard seed)
// Faults are harness-level doubles at the SEAMS the app itself injects
// (token store, access store, pre-inject delay) — handler math untouched.

import fs from 'node:fs';
import { createRequire } from 'node:module';
// Bare 'fastify' does NOT resolve from the spike tree (no fastify in
// bootstrap/node_modules); anchor resolution at the API package like the
// transport does for tsx (resolveTsxCli). Same real Fastify the app uses.
const apiRequire = createRequire('D:/projetos/pi-financeiro/apps/api/package.json');
const Fastify = apiRequire('fastify').default;
import {
  buildTestApp,
} from '../../../../pi-financeiro/apps/api/tests/test-app.js';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CATEGORY_FOOD_A,
  CATEGORY_FOOD_B,
  CATEGORY_RENT_A,
  CATEGORY_SALARY_A,
  HOUSEHOLD_A,
  HOUSEHOLD_B,
  TRANSACTIONS,
} from '../../../../pi-financeiro/apps/api/tests/fixtures/seed.js';
import { registerRoutes, createPendingOperationV2Executor } from '../../../../pi-financeiro/apps/api/src/routes/index.js';
import { createInMemoryStores } from '../../../../pi-financeiro/apps/api/src/writes/in-memory.js';
import { createInMemoryReadModelStore } from '../../../../pi-financeiro/apps/api/src/read-models/store.js';
import { createInMemoryPendingOperationV2Store } from '../../../../pi-financeiro/apps/api/src/approvals/pending-v2.js';
import { createDelegatedTurnToken } from '../../../../pi-financeiro/apps/api/src/auth/delegated-token.js';

type BridgeRequest = {
  token: string;
  route: string;
  method?: string;
  seed?: 'standard' | 'empty';
  fault?: null | { type: string };
  workspaceId?: string | null;
  tokenStore?: null | 'exploding';
  access?: null | 'deny-all';
  delayMs?: number | null;
  // S05 propose fields (executor-constructed, never tool args): POST body +
  // deterministic Idempotency-Key + delegated capability request. The bridge
  // mints the delegated token HOST-side from the resolved device binding.
  body?: unknown;
  idempotencyKey?: string | null;
  delegated?: null | { capabilities: string[]; requestId: string };
  // Test-only replay probes (S05-07): re-inject against the SAME app/store
  // instance to prove real Pending V2 replay/conflict semantics. The
  // executor never sends these; the validation harness calls callFinance
  // directly with them.
  verifyReplay?: boolean;
  verifyConflictBody?: unknown;
};

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Harness seam double: a DeviceTokenStore whose resolve THROWS a raw Error
// (no statusCode) for the probe token, exercising the REAL 500 path:
// routes handleError rethrows non-Domain errors -> Fastify 500.
function explodingTokenStore() {
  return {
    async resolve(token: unknown) {
      if (token === 'boom-token') throw new Error('synthetic store explosion');
      throw Object.assign(new Error('invalid'), { statusCode: 401, code: 'auth.invalid_token' });
    },
    async register() {
      throw new Error('not implemented in spike bridge');
    },
    async revoke() {},
  };
}

// Harness seam double: a WorkspaceAccessStore that denies everything with a
// REAL 403 shape, exercising the REAL middleware branch
// (routes/index.ts: device-token + x-workspace-id -> resolveAuthorizedDevice
// -> 403 auth.workspace_forbidden). The denial decision is the double; the
// 403 mapping + response contract are the real middleware.
function denyAllAccessStore() {
  return {
    async resolve() {
      throw Object.assign(new Error('synthetic access denied'), {
        statusCode: 403,
        code: 'auth.workspace_forbidden',
      });
    },
  };
}

// Minimal BetterAuth-shaped stub so the REAL middleware reaches the
// device-token branch with NO session (getSession -> null). Only the session
// lookup is stubbed; device-token resolution + household scoping stay real.
function nullSessionAuth() {
  return { api: { getSession: async () => null }, options: {} };
}

// S05 propose composition (synthetic harness, REAL authority).
//
// Synthetic (labeled, never real credentials):
//   - SYNTHETIC_DELEGATION_SECRET: HMAC secret for minting the delegated turn
//     token host-side. The API verifies it through its REAL preHandler
//     (signature + capability + device binding + workspace scoping).
//   - SYNTHETIC_TOKENS: the two device-token rows (same mapping as the
//     test-app token store). Unknown tokens resolve to a REAL 401 shape.
// Real (unmodified pi-financeiro code paths):
//   - registerRoutes with pendingV2Store + pendingV2Executor (API-owned:
//     createPendingOperationV2Executor) + delegationSecret wiring;
//   - createDelegatedTurnToken mint; verifyDelegatedTurnToken inside the API;
//   - registerPendingOperationRoutes propose handler + in-memory V2 store.
const SYNTHETIC_DELEGATION_SECRET = 'ted-spike-synthetic-delegation-secret-v1';

const SYNTHETIC_TOKENS: Record<string, { deviceId: string; householdId: string }> = {
  'dev-token-1': { deviceId: 'dev-device-1', householdId: HOUSEHOLD_A },
  'dev-token-2': { deviceId: 'dev-device-2', householdId: HOUSEHOLD_B },
};

type BridgeRequestPropose = BridgeRequest & {
  body: { tool: string; normalizedArgs: Record<string, unknown> };
  idempotencyKey: string;
  delegated: { capabilities: string[]; requestId: string };
};

async function runPropose(req: BridgeRequest): Promise<void> {
  const propose = req as BridgeRequestPropose;
  if (!propose.body || typeof propose.body !== 'object' || Array.isArray(propose.body)) {
    console.log(JSON.stringify({ fatal: 'propose requires body {tool, normalizedArgs}' }));
    process.exitCode = 2;
    return;
  }
  if (typeof propose.idempotencyKey !== 'string' || propose.idempotencyKey.length === 0) {
    console.log(JSON.stringify({ fatal: 'propose requires idempotencyKey' }));
    process.exitCode = 2;
    return;
  }
  if (!propose.delegated || !Array.isArray(propose.delegated.capabilities) || typeof propose.delegated.requestId !== 'string' || propose.delegated.requestId.length === 0) {
    console.log(JSON.stringify({ fatal: 'propose requires delegated {capabilities, requestId}' }));
    process.exitCode = 2;
    return;
  }
  // Host-bound identity resolves server-side from the device token (same
  // mapping the reads use) — never from transport fields. Unknown token =>
  // REAL 401 shape, no mint, no proposal.
  const binding = SYNTHETIC_TOKENS[req.token];
  if (!binding) {
    console.log(JSON.stringify({ ok: true, statusCode: 401, body: { code: 'auth.invalid_token', message: 'Token de autenticação inválido ou expirado.' }, meta: { handler: 'real:registerRoutes+pendingV2', route: req.route } }));
    return;
  }
  const { state, writes } = createInMemoryStores({
    accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
    categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A, CATEGORY_FOOD_B],
    transactions: TRANSACTIONS,
  });
  const store = createInMemoryReadModelStore({
    accounts: state.accounts,
    categories: state.categories,
    transactions: state.transactions,
    deletedTransactionIds: state.deletedTransactions,
  });
  const tokenStore = {
    async resolve(token: unknown) {
      const hit = typeof token === 'string' ? SYNTHETIC_TOKENS[token] : undefined;
      if (!hit) throw Object.assign(new Error('invalid'), { statusCode: 401, code: 'auth.invalid_token' });
      return { deviceId: hit.deviceId, householdId: hit.householdId, userId: null };
    },
    async register() { throw new Error('not implemented in spike bridge'); },
    async revoke() {},
  };
  const v2Store = createInMemoryPendingOperationV2Store();
  const app = Fastify({ logger: false });
  registerRoutes(app, {
    store,
    writes,
    tokenStore,
    pendingV2Store: v2Store,
    pendingV2Executor: createPendingOperationV2Executor(writes),
    delegationSecret: SYNTHETIC_DELEGATION_SECRET,
  });
  try {
    // Host-side mint (the Agent mediation point in production): the token is
    // minted HERE from the resolved binding and verified by the REAL API
    // preHandler (HMAC + capability + H-12 device binding). Actor mirrors the
    // real device-token resolve (actorId = deviceId).
    const delegatedToken = await createDelegatedTurnToken(
      {
        actorId: binding.deviceId,
        workspaceId: binding.householdId,
        role: 'owner',
        capabilities: propose.delegated.capabilities,
        requestId: propose.delegated.requestId,
        deviceId: binding.deviceId,
      },
      SYNTHETIC_DELEGATION_SECRET,
    );
    const headers: Record<string, string> = {
      authorization: `Bearer ${delegatedToken}`,
      'idempotency-key': propose.idempotencyKey,
    };
    const res = await app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers, payload: propose.body });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = { raw: res.body };
    }
    const out: Record<string, unknown> = {
      ok: true,
      statusCode: res.statusCode,
      body,
      meta: { handler: 'real:registerRoutes+pendingV2', route: req.route, seed: req.seed ?? 'standard' },
    };
    // Test-only replay probes (S05-07): same store, same app — exactly what a
    // client retry does WITHIN one process lifetime. AUTHORITY SCOPE: these
    // prove real Pending V2 same-instance replay (200 existing:true, SAME id)
    // and divergent-payload conflict (409) — NOT cross-process/restart
    // persistence (the next bridge call starts with a fresh store).
    if (req.verifyReplay === true) {
      const replay = await app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers, payload: propose.body });
      let replayBody: unknown;
      try {
        replayBody = replay.json();
      } catch {
        replayBody = { raw: replay.body };
      }
      out.replay = { statusCode: replay.statusCode, body: replayBody };
    }
    if (req.verifyConflictBody !== undefined) {
      const conflict = await app.inject({ method: 'POST', url: '/pending-operations/v2/propose', headers, payload: req.verifyConflictBody });
      let conflictBody: unknown;
      try {
        conflictBody = conflict.json();
      } catch {
        conflictBody = { raw: conflict.body };
      }
      out.conflict = { statusCode: conflict.statusCode, body: conflictBody };
    }
    console.log(JSON.stringify(out));
  } finally {
    await app.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  let req: BridgeRequest;
  try {
    req = JSON.parse(readStdin() || '{}');
  } catch (e) {
    console.log(JSON.stringify({ fatal: `bad request JSON: ${(e as Error).message}` }));
    process.exitCode = 2;
    return;
  }
  if (typeof req.token !== 'string' || typeof req.route !== 'string') {
    console.log(JSON.stringify({ fatal: 'token (string) and route (string) are required' }));
    process.exitCode = 2;
    return;
  }
  // Exact-pathname gate (mirrors isRouteAllowlisted in finance-transport.mjs):
  // prefix matching would forward /accounts/123 or
  // /dashboard/month-summary-extra to Fastify (spike02-fix-r2).
  // Defense-in-depth behind the pre-spawn gate; query strings pass through.
  {
    const pathname = req.route.split('?')[0];
    const method = (req.method || 'GET').toUpperCase();
    const readable = pathname === '/accounts' || pathname === '/categories' || pathname === '/dashboard/month-summary';
    const proposable = pathname === '/pending-operations/v2/propose';
    if (pathname !== '/accounts' && pathname !== '/categories' && pathname !== '/dashboard/month-summary' && pathname !== '/pending-operations/v2/propose') {
      console.log(JSON.stringify({ fatal: `route not allowlisted: ${req.route}` }));
      process.exitCode = 2;
      return;
    }
    // Method gate per path (S05): reads GET-only, propose POST-only.
    if ((readable && method !== 'GET') || (proposable && method !== 'POST')) {
      console.log(JSON.stringify({ fatal: `method not allowlisted: ${req.method} ${pathname}` }));
      process.exitCode = 2;
      return;
    }
  }
  // TEST-ONLY harness delay (exercises tool timeout; financial path untouched).
  if (typeof req.delayMs === 'number' && req.delayMs > 0) await sleep(req.delayMs);

  // S05 propose path: the REAL Pending V2 surface (registerRoutes with a real
  // in-memory V2 store + the API-owned V2 executor + a real delegation
  // secret). Financial logic is NEVER reimplemented here — proposalHash,
  // idempotency replay (201→200 existing:true) and divergent-payload conflict
  // (409) all execute in the REAL handler + REAL store. The ONLY synthetic
  // pieces are the two device-token rows (same mapping as the test-app token
  // store: dev-token-1/2 -> dev-device-1/2 + household) and the synthetic
  // delegation secret (never a real credential); identity still resolves
  // server-side (token resolve -> delegated claims -> authenticatedContext),
  // never from tool args.
  const pathname = req.route.split('?')[0];
  if (pathname === '/pending-operations/v2/propose') {
    await runPropose(req);
    return;
  }

  const seed =
    req.seed === 'empty'
      ? {}
      : {
          accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
          categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A, CATEGORY_FOOD_B],
          transactions: TRANSACTIONS,
        };
  const optionals: unknown[] = [];
  if (req.tokenStore === 'exploding') optionals.push(explodingTokenStore());
  if (req.access === 'deny-all') {
    optionals.push(denyAllAccessStore());
    optionals.push(nullSessionAuth());
  }
  const { app } = buildTestApp(seed, ...optionals);
  try {
    const headers: Record<string, string> = { 'x-device-token': req.token };
    if (req.workspaceId) headers['x-workspace-id'] = req.workspaceId;
    const res = await app.inject({ method: (req.method || 'GET') as 'GET', url: req.route, headers });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = { raw: res.body };
    }
    console.log(
      JSON.stringify({
        ok: true,
        statusCode: res.statusCode,
        body,
        meta: {
          handler: 'real:buildTestApp',
          route: req.route,
          seed: req.seed ?? 'standard',
          fault: req.fault ?? req.tokenStore ?? req.access ?? null,
        },
      }),
    );
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: String((e && (e as Error).stack || e)).slice(0, 800) }));
  process.exitCode = 1;
});
