// One-shot finance transport (spike 02).
//
// Spawns the repo's REAL pi-financeiro handlers through a tsx-run bridge
// (bootstrap/finance-bridge.ts -> real buildTestApp + real fixtures). Each
// call is a fresh OS process + fresh in-memory app: stateless, deterministic,
// no shared tokens (host token travels per-call via stdin, never argv, never
// module-global). This is the thinnest deterministic adapter: financial math
// is NEVER reimplemented here — only process plumbing + timeout + scrubbing.
//
// tsx resolution: the repo already vendors tsx (apps/api devDependency); we
// resolve its cli.mjs through node resolution anchored at apps/api so no
// version is hardcoded here.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ToolError } from './ted-finance-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'finance-bridge.ts');
const API_DIR = 'D:/projetos/pi-financeiro/apps/api';

let cachedCli = null;
export function resolveTsxCli() {
  if (cachedCli) return cachedCli;
  const apiRequire = createRequire(path.join(API_DIR, 'package.json'));
  const pkgPath = apiRequire.resolve('tsx/package.json');
  const pkg = apiRequire(pkgPath);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
  cachedCli = path.join(path.dirname(pkgPath), bin);
  return cachedCli;
}

// Defense-in-depth (mirrors env.cjs SCRUB): error text leaving this module
// never carries token substrings. The bridge never echoes the token; this
// redaction is a second barrier, clearly labeled — not a substitute for it.
export function scrubSecrets(text, host) {
  let out = String(text);
  const candidates = new Set(['dev-token-1', 'dev-token-2', 'boom-token', 'not-a-real-token']);
  if (host && typeof host.token === 'string' && host.token.length > 0) candidates.add(host.token);
  for (const secret of candidates) {
    if (secret && out.includes(secret)) out = out.split(secret).join('[redacted-token]');
  }
  return out;
}

function extractJson(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && ('statusCode' in parsed || 'fatal' in parsed)) return parsed;
    } catch { /* keep scanning */ }
  }
  throw new Error(`bridge returned no JSON payload: ${String(stdout).slice(0, 300)}`);
}

// Exact-pathname route allowlist (§5 contract). Only the path component is
// gated here; the query string (if any) passes through to the REAL handler.
// Exported for unit tests; the bridge mirrors the same predicate (TS) as
// defense-in-depth behind this pre-spawn gate.
const ALLOWED_PATHS = new Set(['/accounts', '/dashboard/month-summary']);

export function isRouteAllowlisted(route) {
  if (typeof route !== 'string') return false;
  return ALLOWED_PATHS.has(route.split('?')[0]);
}

export async function callFinance({ route, method = 'GET', host, seed = 'standard', fault = null, workspaceId = null, tokenStore = null, access = null, delayMs = null, timeoutMs = 15000 }) {
  if (!host || typeof host.token !== 'string' || host.token.length === 0) {
    throw new ToolError('tool.invalid_args', 'host-bound token is required (never a tool arg)');
  }
  // Route allowlist: EXACT pathname only (§5 contract: /accounts and
  // /dashboard/month-summary). Query strings pass through to the REAL handler
  // (it owns domain validation, e.g. kind enum / yearMonth format). Prefix
  // matching is FORBIDDEN: it would forward /accounts/123 or
  // /dashboard/month-summary-extra to Fastify (spike02-fix-r2).
  if (!isRouteAllowlisted(route)) {
    throw new ToolError('tool.invalid_args', `route not allowlisted: ${route}`);
  }
  const cli = resolveTsxCli();
  const request = { token: host.token, route, method, seed, fault, workspaceId, tokenStore, access, delayMs };
  // NOTE: implemented with spawn + explicit stdin write/end (not execFile's
  // `input` option): in this Windows env an execFile `input` pipe to the tsx
  // child hangs indefinitely (bridge never sees EOF), while the identical
  // payload via explicit stdin write+end completes in ~1.5s. Verified
  // 2026-10-30; kept deterministic (no shell, argv carries no secrets).
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err, payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(payload);
    };
    let child;
    try {
      child = spawn(process.execPath, [cli, BRIDGE], {
        cwd: API_DIR, // resolve fastify/zod/etc. from the API package, like its own tests
        windowsHide: true,
      });
    } catch (e) {
      throw new ToolError('tool.transport', `finance transport spawn failed (route ${route}): ${scrubSecrets((e && e.message) || String(e), host).slice(0, 200)}`);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(new ToolError('tool.timeout', `finance call timed out after ${timeoutMs}ms (route ${route})`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (stdout.length > 4 * 1024 * 1024) { try { child.kill(); } catch {} }
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => {
      finish(new ToolError('tool.transport', `finance transport failed (route ${route}): ${scrubSecrets((e && e.message) || String(e), host).slice(0, 300)}`));
    });
    child.on('close', () => {
      try {
        const payload = extractJson(stdout || stderr);
        if (payload.fatal) {
          finish(new ToolError('tool.transport', `finance bridge fatal (route ${route}): ${scrubSecrets(payload.fatal, host).slice(0, 300)}`));
          return;
        }
        if (typeof payload.statusCode !== 'number' || payload.body === undefined) {
          finish(new ToolError('tool.transport', `malformed bridge payload (route ${route})`));
          return;
        }
        finish(null, payload);
      } catch (e) {
        finish(new ToolError('tool.transport', `finance transport failed (route ${route}): ${scrubSecrets((e && e.message) || String(e), host).slice(0, 300)}`));
      }
    });
    try {
      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    } catch (e) {
      finish(new ToolError('tool.transport', `finance transport stdin failed (route ${route}): ${scrubSecrets((e && e.message) || String(e), host).slice(0, 200)}`));
    }
  });
}
