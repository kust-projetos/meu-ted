// Durable finance transport — SPIKE 05D (experimental harness, synthetic only).
//
// One-shot adapter over bootstrap/finance-bridge-pg.ts (REAL Postgres-backed
// Pending V2 in DB ted_spike_05d): each call spawns a fresh OS process + fresh
// pool, but state persists in Postgres — a new process observes prior calls.
// This is the restart/durability proof surface.
//
// LLM SURFACE UNCHANGED: TOOL_DEFS (ted-finance-tools.mjs) stays propose-only
// (list_accounts/get_month_summary/list_categories/propose_expense). There is
// NO confirm/execute tool: confirm/execute/authorize/reconcile/cancel ops here
// are reachable ONLY via this harness module with an explicit host binding —
// i.e. the authenticated-synthethic CLI/harness path, never model output.
// Free text ("sim" or otherwise) never maps to an op: ops are explicit
// {op, id, intentionId} objects, and confirm/execute REQUIRE body.intentionId
// (typed refusal otherwise, zero effect).
//
// tsx resolution mirrors finance-transport.mjs (API-vendored tsx, no version
// hardcoded here).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ToolError } from './ted-finance-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PG = path.join(HERE, 'finance-bridge-pg.ts');
const API_DIR = 'D:/projetos/pi-financeiro/apps/api';

let cachedCli = null;
export function resolveTsxCliPg() {
  if (cachedCli) return cachedCli;
  const apiRequire = createRequire(path.join(API_DIR, 'package.json'));
  const pkgPath = apiRequire.resolve('tsx/package.json');
  const pkg = apiRequire(pkgPath);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
  cachedCli = path.join(path.dirname(pkgPath), bin);
  return cachedCli;
}

export function scrubSecretsPg(text, host) {
  let out = String(text);
  const candidates = new Set(['dev-token-1', 'dev-token-2', 'boom-token', 'not-a-real-token']);
  if (host && typeof host.token === 'string' && host.token.length > 0) candidates.add(host.token);
  for (const secret of candidates) {
    if (secret && out.includes(secret)) out = out.split(secret).join('[redacted-token]');
  }
  return out;
}

function extractJsonPg(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && ('statusCode' in parsed || 'fatal' in parsed)) return parsed;
    } catch { /* keep scanning */ }
  }
  throw new Error(`bridge-pg returned no JSON payload: ${String(stdout).slice(0, 300)}`);
}

// Harness op allowlist (§5 durable contract). propose is the only op the LLM
// tool surface can reach (via propose_expense); every other op is
// harness/CLI-only with an explicit host binding.
const ALLOWED_OPS = new Set([
  'propose', 'active', 'get', 'outcome',
  'confirm', 'authorize', 'execute', 'reconcile', 'cancel',
]);
const ID_OPS = new Set(['get', 'outcome', 'confirm', 'authorize', 'execute', 'reconcile', 'cancel']);

export function isDurableOpAllowlisted(op) {
  return typeof op === 'string' && ALLOWED_OPS.has(op);
}

export async function callFinanceDurable({
  op, host, id = null, body = null, idempotencyKey = null,
  intentionId = null, requestId = null, delayMs = null, postDelayMs = null,
  timeoutMs = 60000, signal = null,
}) {
  if (!host || typeof host.token !== 'string' || host.token.length === 0) {
    throw new ToolError('host_context_required', 'host-bound token is required (never a tool arg)');
  }
  if (!isDurableOpAllowlisted(op)) {
    throw new ToolError('tool.invalid_args', `durable op not allowlisted: ${op}`);
  }
  if (ID_OPS.has(op) && (typeof id !== 'string' || id.length === 0)) {
    throw new ToolError('tool.invalid_args', `durable op ${op} requires id (string, non-empty)`);
  }
  if (op === 'propose') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ToolError('tool.invalid_args', 'propose requires a body object (executor-constructed)');
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new ToolError('tool.invalid_args', 'propose requires a deterministic idempotencyKey (executor-constructed)');
    }
    if ((typeof intentionId !== 'string' || intentionId.length === 0) && (typeof requestId !== 'string' || requestId.length === 0)) {
      throw new ToolError('tool.invalid_args', 'propose requires intentionId (or requestId) for the delegated request');
    }
  }
  // Explicit-action gate: confirm/execute NEVER happen by text or by bare id —
  // the caller presents the stable intentionId inside the body (bound
  // atomically server-side; divergent ⇒ 409 intention_conflict, zero effect).
  if ((op === 'confirm' || op === 'execute') && (!body || typeof body !== 'object' || typeof body.intentionId !== 'string' || body.intentionId.length === 0)) {
    throw new ToolError('tool.invalid_args', `${op} requires explicit body.intentionId (free text never confirms — zero effect)`);
  }
  const cli = resolveTsxCliPg();
  const request = {
    token: host.token, op, id, body, idempotencyKey,
    requestId, intentionId, delayMs, postDelayMs,
  };
  if (signal && signal.aborted) {
    throw new ToolError('tool.cancelled', `durable finance call cancelled before execution (op ${op})`);
  }
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    let timer = null;
    const onAbort = () => {
      try { if (child) child.kill(); } catch { /* already gone */ }
      finish(new ToolError('tool.cancelled', `durable finance call cancelled (op ${op})`));
    };
    const finish = (err, payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort); } catch { /* settle never fails */ }
      if (err) reject(err);
      else resolve(payload);
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      child = spawn(process.execPath, [cli, BRIDGE_PG], {
        cwd: API_DIR,
        windowsHide: true,
        env: { ...process.env },
      });
    } catch (e) {
      try { if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort); } catch { /* settle never fails */ }
      throw new ToolError('tool.transport', `durable finance transport spawn failed (op ${op}): ${scrubSecretsPg((e && e.message) || String(e), host).slice(0, 200)}`);
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(new ToolError('tool.timeout', `durable finance call timed out after ${timeoutMs}ms (op ${op})`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (stdout.length > 4 * 1024 * 1024) { try { child.kill(); } catch {} }
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => {
      finish(new ToolError('tool.transport', `durable finance transport failed (op ${op}): ${scrubSecretsPg((e && e.message) || String(e), host).slice(0, 300)}`));
    });
    child.on('close', () => {
      try {
        const payload = extractJsonPg(stdout || stderr);
        if (payload.fatal) {
          finish(new ToolError('tool.transport', `durable finance bridge fatal (op ${op}): ${scrubSecretsPg(payload.fatal, host).slice(0, 300)}`));
          return;
        }
        if (typeof payload.statusCode !== 'number' || payload.body === undefined) {
          finish(new ToolError('tool.transport', `malformed durable bridge payload (op ${op})`));
          return;
        }
        finish(null, payload);
      } catch (e) {
        finish(new ToolError('tool.transport', `durable finance transport failed (op ${op}): ${scrubSecretsPg((e && e.message) || String(e), host).slice(0, 300)}`));
      }
    });
    try {
      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    } catch (e) {
      finish(new ToolError('tool.transport', `durable finance transport stdin failed (op ${op}): ${scrubSecretsPg((e && e.message) || String(e), host).slice(0, 200)}`));
    }
  });
}
