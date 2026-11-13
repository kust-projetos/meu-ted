// One-shot DURABLE finance bridge — SPIKE 05D (experimental, synthetic only).
//
// Mirrors experiments/ted-runtime/bootstrap/finance-bridge.ts (runPropose)
// but wires the REAL Postgres-backed Pending V2 authority:
//   - createPostgresReadModelStore({pool}) + createPostgresWriteStore({pool})
//   - createPostgresPendingOperationV2Store(pool) (durable pending_operations)
//   - createPendingOperationV2Executor(writes) (real keyed financial writes)
// Each invocation opens a pool to SPIKE05D_DATABASE_URL, injects exactly ONE
// request via Fastify, then closes pool+app. Persistence lives in Postgres
// (DB ted_spike_05d, synthetic-only), so a NEW process observes prior state:
// this is the restart/durability proof the in-memory bridge cannot give.
//
// SCOPE: experiment only. No PWA, no production, no real credentials. The DB
// URL comes ONLY from env SPIKE05D_DATABASE_URL (never hardcoded/committed).
// Synthetic identity only: dev-token-1/2 -> dev-device-1/2 + household A/B,
// synthetic delegation secret (labeled, never a real credential).
//
// Protocol (STDIO JSON in, one JSON line out):
//   { token, op, id?, body?, idempotencyKey?, requestId?, intentionId?, delayMs? }
//   op ∈ propose|active|get|outcome|confirm|authorize|execute|reconcile|cancel
// Prints: { ok, statusCode, body, meta } or { fatal } (exit 2).
//
// The bridge mints the delegated turn token HOST-side from the resolved
// device binding (same as finance-bridge.ts); identity resolves server-side,
// never from tool args. The bridge never echoes tokens.

import fs from 'node:fs';
import { createRequire } from 'node:module';

// Anchor resolution at the API package (same pattern as finance-bridge.ts).
const apiRequire = createRequire('D:/projetos/pi-financeiro/apps/api/package.json');
const Fastify = apiRequire('fastify').default;
const { Pool } = apiRequire('pg');
import {
  registerRoutes,
  createPendingOperationV2Executor,
} from '../../../../pi-financeiro/apps/api/src/routes/index.js';
import { createPostgresReadModelStore } from '../../../../pi-financeiro/apps/api/src/read-models/postgres-store.js';
import { createPostgresWriteStore } from '../../../../pi-financeiro/apps/api/src/writes/postgres.js';
import { createPostgresPendingOperationV2Store } from '../../../../pi-financeiro/apps/api/src/approvals/pending-v2.js';
import { createDelegatedTurnToken } from '../../../../pi-financeiro/apps/api/src/auth/delegated-token.js';

const SYNTHETIC_DELEGATION_SECRET = 'ted-spike-05d-synthetic-delegation-secret-v1';

const SYNTHETIC_TOKENS: Record<string, { deviceId: string; householdId: string }> = {
  'dev-token-1': { deviceId: 'dev-device-1', householdId: '00000000-0000-4000-8000-00000000000a' },
  'dev-token-2': { deviceId: 'dev-device-2', householdId: '00000000-0000-4000-8000-00000000000b' },
};

const V2 = '/pending-operations/v2';
const OPS: Record<string, { method: string; path: (id?: string) => string; capability: string; needsId: boolean }> = {
  propose: { method: 'POST', path: () => `${V2}/propose`, capability: 'financial.approval.propose', needsId: false },
  active: { method: 'GET', path: () => `${V2}/active`, capability: 'financial.approval.read', needsId: false },
  get: { method: 'GET', path: (id) => `${V2}/${id}`, capability: 'financial.approval.read', needsId: true },
  outcome: { method: 'GET', path: (id) => `${V2}/${id}/outcome`, capability: 'financial.approval.read', needsId: true },
  confirm: { method: 'POST', path: (id) => `${V2}/${id}/confirm`, capability: 'financial.approval.confirm', needsId: true },
  authorize: { method: 'POST', path: (id) => `${V2}/${id}/authorize`, capability: 'financial.approval.autoexecute', needsId: true },
  execute: { method: 'POST', path: (id) => `${V2}/${id}/execute`, capability: 'financial.approval.execute', needsId: true },
  reconcile: { method: 'POST', path: (id) => `${V2}/${id}/reconcile`, capability: 'financial.approval.reconcile', needsId: true },
  cancel: { method: 'POST', path: (id) => `${V2}/${id}/cancel`, capability: 'financial.approval.cancel', needsId: true },
};

type BridgeRequest = {
  token: string;
  op: string;
  id?: string;
  body?: unknown;
  idempotencyKey?: string | null;
  requestId?: string;
  intentionId?: string;
  delayMs?: number | null;
  postDelayMs?: number | null;
};

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

function assertSpikeDatabaseUrl(url: string): void {
  const refuse = (): never => {
    // Never echo the URL: it may carry the synthetic local password.
    throw new Error('refusing non-spike database (only ted_spike_05d)');
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse();
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') refuse();
  if (parsed.hostname !== '127.0.0.1') refuse();
  if (parsed.port !== '5433') refuse();
  if (parsed.pathname !== '/ted_spike_05d') refuse();
  if (parsed.search !== '' || parsed.hash !== '') refuse();
  if (parsed.username !== 'postgres') refuse();
  if (parsed.password !== '' && parsed.password !== 'postgres') refuse();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  let req: BridgeRequest;
  try {
    req = JSON.parse(readStdin() || '{}');
  } catch (e) {
    console.log(JSON.stringify({ fatal: `bad request JSON: ${(e as Error).message}` }));
    process.exitCode = 2;
    return;
  }
  if (typeof req.token !== 'string' || typeof req.op !== 'string') {
    console.log(JSON.stringify({ fatal: 'token (string) and op (string) are required' }));
    process.exitCode = 2;
    return;
  }
  const spec = OPS[req.op];
  if (!spec) {
    console.log(JSON.stringify({ fatal: `op not allowlisted: ${req.op}` }));
    process.exitCode = 2;
    return;
  }
  if (spec.needsId && (typeof req.id !== 'string' || req.id.length === 0)) {
    console.log(JSON.stringify({ fatal: `op ${req.op} requires id (string, non-empty)` }));
    process.exitCode = 2;
    return;
  }
  if (req.op === 'propose') {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      console.log(JSON.stringify({ fatal: 'propose requires body {tool, normalizedArgs}' }));
      process.exitCode = 2;
      return;
    }
    if (typeof req.idempotencyKey !== 'string' || req.idempotencyKey.length === 0) {
      console.log(JSON.stringify({ fatal: 'propose requires idempotencyKey' }));
      process.exitCode = 2;
      return;
    }
  }
  const databaseUrl = (process.env.SPIKE05D_DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.log(JSON.stringify({ fatal: 'SPIKE05D_DATABASE_URL is required (never hardcoded)' }));
    process.exitCode = 2;
    return;
  }
  try {
    assertSpikeDatabaseUrl(databaseUrl);
  } catch {
    console.log(JSON.stringify({ fatal: 'refusing non-spike database (only ted_spike_05d)' }));
    process.exitCode = 2;
    return;
  }
  const binding = SYNTHETIC_TOKENS[req.token];
  if (!binding) {
    console.log(JSON.stringify({ ok: true, statusCode: 401, body: { code: 'auth.invalid_token', message: 'Token de autenticação inválido ou expirado.' }, meta: { handler: 'real:registerRoutes+pendingV2-postgres', op: req.op, durable: true } }));
    return;
  }
  if (typeof req.delayMs === 'number' && req.delayMs > 0) await sleep(req.delayMs);

  const requestId =
    typeof req.intentionId === 'string' && req.intentionId.length > 0 ? req.intentionId
    : typeof req.requestId === 'string' && req.requestId.length > 0 ? req.requestId
    : `durable-${req.op}-${Date.now()}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const store = createPostgresReadModelStore({ pool });
  const writes = createPostgresWriteStore({ pool });
  const tokenStore = {
    async resolve(token: unknown) {
      const hit = typeof token === 'string' ? SYNTHETIC_TOKENS[token] : undefined;
      if (!hit) throw Object.assign(new Error('invalid'), { statusCode: 401, code: 'auth.invalid_token' });
      return { deviceId: hit.deviceId, householdId: hit.householdId, userId: null };
    },
    async register() { throw new Error('not implemented in spike bridge-pg'); },
    async revoke() {},
  };
  const v2Store = createPostgresPendingOperationV2Store(pool);
  const app = Fastify({ logger: false });
  registerRoutes(app, {
    store,
    writes,
    tokenStore,
    pendingV2Store: v2Store,
    pendingV2Executor: createPendingOperationV2Executor(writes),
    pendingV2ReadModel: store,
    delegationSecret: SYNTHETIC_DELEGATION_SECRET,
  });
  try {
    const delegatedToken = await createDelegatedTurnToken(
      {
        actorId: binding.deviceId,
        workspaceId: binding.householdId,
        role: 'owner',
        capabilities: [spec.capability],
        requestId,
        deviceId: binding.deviceId,
      },
      SYNTHETIC_DELEGATION_SECRET,
    );
    const headers: Record<string, string> = { authorization: `Bearer ${delegatedToken}` };
    if (typeof req.idempotencyKey === 'string' && req.idempotencyKey.length > 0) {
      headers['idempotency-key'] = req.idempotencyKey;
    }
    const res = await app.inject({ method: spec.method as 'GET' | 'POST', url: spec.path(req.id), headers, payload: req.body as never });
    // Test-only post-inject delay: persistence already committed, the response
    // is withheld so the harness can prove timeout-after-persistence recovery
    // (GET reconciles, no new intention). Financial path untouched.
    if (typeof req.postDelayMs === 'number' && req.postDelayMs > 0) await sleep(req.postDelayMs);
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = { raw: res.body };
    }
    console.log(JSON.stringify({ ok: true, statusCode: res.statusCode, body, meta: { handler: 'real:registerRoutes+pendingV2-postgres', op: req.op, durable: true } }));
  } finally {
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: String((e && (e as Error).stack || e)).slice(0, 800) }));
  process.exitCode = 1;
});
