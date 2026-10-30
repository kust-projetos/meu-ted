// One-shot finance bridge (spike 02): executes the REAL pi-financeiro
// handlers against synthetic in-memory data. Run ONLY via the repo's own tsx
// (transport resolves it); never hand-executed against production.
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
  TRANSACTIONS,
} from '../../../../pi-financeiro/apps/api/tests/fixtures/seed.js';

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
    if (pathname !== '/accounts' && pathname !== '/dashboard/month-summary') {
      console.log(JSON.stringify({ fatal: `route not allowlisted: ${req.route}` }));
      process.exitCode = 2;
      return;
    }
  }
  // TEST-ONLY harness delay (exercises tool timeout; financial path untouched).
  if (typeof req.delayMs === 'number' && req.delayMs > 0) await sleep(req.delayMs);

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
