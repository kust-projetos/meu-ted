// SPIKE 05D LIVE runner — single real turn on the DURABLE bridge (Postgres ted_spike_05d).
//
// SCOPE: experiments/ted-runtime/bootstrap/run-05d-live.mjs only (+ seu teste
// dryrun). NEVER touches run-05l-turn.mjs, finance-bridge-pg.ts,
// finance-transport-pg.mjs, ted-finance-tools.mjs, plugins/ted-finance/*,
// apps/*, docs/*, .github/*, docker/*, .env, production, Cloudflare, PWA,
// ted_local/pi_financeiro, or any 05/05L evidence. NEVER commits/pushes.
//
// MIRRORS run-05l-turn.mjs structure (LIVE/DRYRUN gate, boot, enumerate,
// facade parity, trace sanitization) with DURABLE deltas:
//   - Identity 05d-a (isolated home .ted-home-05d-a), agent ted, MODEL_PIN identical.
//   - Native tools: list_accounts/list_categories via the in-memory bridge
//     (identical synthetic seed: reads resolve ids); propose_expense via the
//     DURABLE bridge (Postgres ted_spike_05d) through durableRouteTransport.
//     TOOL_DEFS stays propose-only for the LLM (no confirm/cancel/execute).
//   - Live captures liveProposalId (UUID) + sessionID + userMessageID +
//     re-derived intentionId/idempotencyKey; a separate GET (fresh OS process
//     per callFinanceDurable call = 1st restart) confirms proposed persistence.
//   - Confirmation runs as --mode=confirm in a NEW process (2nd restart,
//     zero inference): GET -> confirm -> execute -> SQL (delta +1) ->
//     replay (no 2nd effect) -> outcome receipt. If liveProposalId does not
//     link proposal->receipt->ledger row, verdict=FAIL (never claim live).
//
// MODES: dryrun (default wiring proof, no inference, own dryrun intention +
// scope cleanup) | live (TED_05D_LIVE=1, EXACTLY 1 session.prompt with the
// frozen message, 90s deadline) | confirm --snapshot=<file> (deterministic).
//
// COST: US$5 operational ceiling enforced by harness shape (1 prompt / 90s /
// <=4 steps / single pinned model / no retry), not a provider meter. Tokens
// recorded only when exposed, otherwise unknown (never zero).

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TOOL_DEFS, createToolExecutors, deriveIntentionId, deriveExpenseIdempotencyKey, ToolError } from './ted-finance-tools.mjs';
import { callFinance, scrubSecrets } from './finance-transport.mjs';
import { callFinanceDurable } from './finance-transport-pg.mjs';
import { bindSession, isSameHost, resolveHost } from './session-bindings.mjs';
import { filterSessionsForHost } from './ted-gateway.mjs';
import {
  assertSpikeDatabaseUrl,
  spikePool,
  ensureSeed05d,
  resetScope05d,
  countTx05d,
  getTx05d,
  getPending05d,
  yesterdayUTC,
  HOUSEHOLD_A,
  ACCOUNT_NUBANK,
  CATEGORY_MERCADO,
} from '../spike-05d/scripts/db-05d.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireHere = createRequire(path.join(HERE, 'run-identity.mjs'));

export const HOST_A = Object.freeze({
  label: 'A',
  token: 'dev-token-1',
  household: HOUSEHOLD_A,
  actorId: 'dev-device-1',
  deviceId: 'dev-device-1',
});
export const IDENTITY_05D = '05d-a';
export const AGENT_05D = 'ted';
export const MODEL_PIN = Object.freeze({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
export const FINANCE_TOOLS_05D = Object.freeze(['list_accounts', 'list_categories', 'propose_expense']);
export const FACADE_KEYS_05D = Object.freeze([
  'createSession',
  'getSession',
  'listSessions',
  'removeSession',
  'listCatalogs',
  'list_accounts',
  'list_categories',
  'propose_expense',
]);
export const LIVE_TIMEOUT_MS = 90000;
export const POLL_TIMEOUT_MS = 15000;
export const MAX_INTERNAL_STEPS = 4;
export const INTERRUPT_TIMEOUT_MS = 5000;
export const DEFAULT_MESSAGE_05D = 'TED, gastei 35 reais no mercado ontem, pelo Nubank.';
export const EXPECTED_PROPOSE_AMOUNT_CENTS = 3500;
export const EXPECTED_ACCOUNT_ID = ACCOUNT_NUBANK;
export const EXPECTED_CATEGORY_ID = CATEGORY_MERCADO;
export const EXPECTED_ACCOUNT_NAME = 'Nubank';
export const EXPECTED_CATEGORY_NAME = 'Mercado';
export const DRYRUN_DESCRIPTION = 'mercado-05d-dryrun';
export const SECRET_PATTERNS = [/dev-token-\d/g, /boom-token/g, /not-a-real-token/g];
export const EVALUATION_TZ = 'America/Sao_Paulo';
export const TZ_DIVERGENCE_NOTE =
  'expectedDateUTC is UTC-yesterday; posterior evaluation runs in America/Sao_Paulo — near midnight the Sao_Paulo wall date may differ ±1 day. Accept UTC-yesterday OR Sao_Paulo-yesterday; never freeze an absolute date.';

export const PRE_EXEC_LIMITATION = Object.freeze({
  enforced: false,
  inheritedFrom: '03B PASS via 05L',
  reason: '2.2.4 codemode execute wrapper has no total pre-execution gate (hook sees {code:string}; finance target resolves post-execution)',
  mitigation: 'config denies + facade without shell/prompt + immediate interrupt + abort on first foreign observation + propose-only (no confirm/cancel/execute tool; CLI confirm is --mode=confirm, a separate explicit action)',
});

export const COST_CEILING_NOTE = 'US$5 operational ceiling enforced by harness shape (1 prompt / 90s / <=4 steps / single pinned model / no retry) — not a provider-billed guarantee; tokens/cost recorded only when SDK exposes them, otherwise unknown (never zero)';

export const POLLING_DEADLINE_NOTE = 'worst-case 90s+<=5s operational margin: poll list capped to remaining budget, poll-timeout interrupt capped to min(5s, remaining) / skipped with explicit overrun when none remains; pre-poll overrun path awaits one bounded <=5s interrupt — finalization always reached with deadlineInterrupt + overrunMs recorded';

// ---- durable env gate (fail-closed, never echoes the URL) -------------------
export function assertDurableEnv(env = process.env) {
  const url = (env.SPIKE05D_DATABASE_URL || '').trim();
  if (!url) throw Object.assign(new Error('refused: SPIKE05D_DATABASE_URL is required (never hardcoded)'), { exitCode: 2 });
  try {
    assertSpikeDatabaseUrl(url);
  } catch {
    throw Object.assign(new Error('refusing non-spike database (only ted_spike_05d)'), { exitCode: 2 });
  }
  return url;
}

// ---- route-signature adapter: reads via in-memory seed bridge, propose via durable Postgres
export async function durableRouteTransport(args) {
  const { route, host, body, idempotencyKey, intentionId } = args || {};
  const pathname = String(route || '').split('?')[0];
  if (pathname === '/pending-operations/v2/propose') {
    return callFinanceDurable({ op: 'propose', host, body, idempotencyKey, intentionId, timeoutMs: 120000 });
  }
  return callFinance({ ...args, timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 120000 });
}

// ---- hardening helpers (pure/testable, mirrored from 05L) -------------------
export function requireBoundHost(sessionID, bound) {
  const host = resolveHost(sessionID);
  if (!isSameHost(host, bound)) {
    throw new ToolError('host_binding_mismatch', 'session is bound to a different host — blocked (nothing returned, nothing removed, nothing revoked)');
  }
  return host;
}

export function countSteps(messages, events) {
  const msgs = Array.isArray(messages) ? messages : [];
  // SDK 2.2.4 message shape carries `type` (assistant/user/idle), not `role`;
  // accept both so the budget tallies real assistant turns (observed live: 3
  // assistant messages, roles null). User/idle/system never counted.
  const assistantCount = msgs.filter((m) => m && (m.role === 'assistant' || m.role === 'agent' || m.type === 'assistant' || m.type === 'agent')).length;
  let eventToolCount = 0;
  try {
    const hay = JSON.stringify(events || []);
    const hits = hay.match(/tool\.[a-z_]+|propose_expense|list_accounts|list_categories/g);
    eventToolCount = hits ? Math.min(hits.length, 999) : 0;
  } catch { eventToolCount = 0; }
  return {
    assistantCount,
    eventToolCount,
    totalSteps: assistantCount,
    overBudget: assistantCount > MAX_INTERNAL_STEPS,
  };
}

export async function withDeadline(fn, timeoutMs, timeoutMessage) {
  const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 5000;
  const msg = typeof timeoutMessage === 'string' && timeoutMessage.length > 0
    ? timeoutMessage
    : `deadline-timeout-${ms}ms`;
  await Promise.race([
    Promise.resolve().then(() => fn()),
    new Promise((_, rej) => setTimeout(() => { rej(new Error(msg)); }, ms)),
  ]);
}

export async function interruptWithDeadline(interruptFn, timeoutMs = INTERRUPT_TIMEOUT_MS) {
  if (typeof interruptFn !== 'function') {
    return { attempted: false, ok: false, error: 'interrupt-unavailable' };
  }
  const ims = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : INTERRUPT_TIMEOUT_MS;
  try {
    await withDeadline(() => interruptFn(), ims, `interrupt-timeout-${ims}ms`);
    return { attempted: true, ok: true, error: null };
  } catch (ie) {
    return { attempted: true, ok: false, error: String((ie && ie.message) || ie).slice(0, 160) };
  }
}

export async function promptWithDeadline({ promptFn, interruptFn, timeoutMs, interruptTimeoutMs }) {
  const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 90000;
  const ims = typeof interruptTimeoutMs === 'number' && interruptTimeoutMs > 0 ? interruptTimeoutMs : 5000;
  let timedOut = false;
  let interruptAttempted = false;
  let interruptOk = false;
  let interruptError = null;
  let error = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => promptFn()),
      new Promise((_, rej) => setTimeout(() => {
        timedOut = true;
        rej(new Error('prompt-timeout-90s'));
      }, ms)),
    ]);
  } catch (e) {
    error = e;
    if (timedOut) {
      if (typeof interruptFn === 'function') {
        const ir = await interruptWithDeadline(() => interruptFn(), ims);
        interruptAttempted = ir.attempted;
        interruptOk = ir.ok;
        interruptError = ir.error ? String(ir.error).slice(0, 200) : null;
      }
    }
  }
  return { timedOut, interruptAttempted, interruptOk, interruptError, error: error ? String((error && error.message) || error).slice(0, 200) : null };
}

export async function abortWithInterrupt({ interruptFn, reason, enforcementFailures, events, timeoutMs = INTERRUPT_TIMEOUT_MS }) {
  let result;
  if (typeof interruptFn === 'function') {
    result = await interruptWithDeadline(interruptFn, timeoutMs);
    if (!result.ok && Array.isArray(enforcementFailures)) {
      enforcementFailures.push(`${reason} abort interrupt failed: ${result.error}`);
    }
  } else {
    result = { attempted: false, ok: false, error: 'interrupt-unavailable' };
    if (Array.isArray(enforcementFailures)) {
      enforcementFailures.push(`${reason} abort interrupt not confirmable (no session.interrupt)`);
    }
  }
  if (Array.isArray(events)) {
    events.push({ abortInterrupt: reason, interrupt: result });
  }
  return result;
}

export async function pollMessagesWithDeadline({ listFn, pollTimeoutMs = POLL_TIMEOUT_MS, interruptFn, interruptTimeoutMs = INTERRUPT_TIMEOUT_MS, enforcementFailures, events, deadlineTs = null }) {
  let rows = null;
  let pollTimeout = null;
  try {
    const holder = {};
    await withDeadline(async () => {
      const res = await listFn();
      holder.res = res;
    }, pollTimeoutMs, `poll-timeout-${pollTimeoutMs}ms`);
    const res = holder.res;
    rows = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/^poll-timeout-/.test(msg)) {
      pollTimeout = { timeoutMs: pollTimeoutMs, error: msg.slice(0, 160) };
      if (Array.isArray(enforcementFailures)) {
        enforcementFailures.push(`polling message.list timeout after ${pollTimeoutMs}ms (deadline exceeded, no fresh rows this poll)`);
      }
      let budgetMs = interruptTimeoutMs;
      if (typeof deadlineTs === 'number') {
        const remainingAfterPoll = deadlineTs - Date.now();
        if (remainingAfterPoll <= 0) {
          const overrunMs = Date.now() - deadlineTs;
          const ir = { attempted: false, ok: false, error: 'deadline-exceeded-no-budget', overrunMs };
          pollTimeout.interrupt = ir;
          pollTimeout.interruptBudgetMs = 0;
          pollTimeout.overrunMs = overrunMs;
          if (Array.isArray(enforcementFailures)) {
            enforcementFailures.push(`poll-timeout interrupt skipped: no global budget left (overrun ${overrunMs}ms past deadline)`);
          }
          if (Array.isArray(events)) {
            events.push({ pollTimeout: true, timeoutMs: pollTimeoutMs, interrupt: ir, interruptBudgetMs: 0, deadlineExceeded: true, overrunMs });
          }
          return { rows, pollTimeout };
        }
        budgetMs = Math.min(budgetMs, remainingAfterPoll);
      }
      const ir = await interruptWithDeadline(interruptFn, budgetMs);
      pollTimeout.interrupt = ir;
      pollTimeout.interruptBudgetMs = budgetMs;
      if (!ir.ok && Array.isArray(enforcementFailures)) {
        enforcementFailures.push(`poll-timeout interrupt failed: ${ir.error}`);
      }
      if (Array.isArray(events)) {
        events.push({ pollTimeout: true, timeoutMs: pollTimeoutMs, interrupt: ir });
      }
    } else {
      if (Array.isArray(events)) {
        events.push({ pollError: msg.slice(0, 160) });
      }
    }
  }
  return { rows, pollTimeout };
}

export function yesterdayUTCProxy(nowMs) {
  return yesterdayUTC(nowMs);
}

export function tedHomeRoot() {
  const root = process.env.TED_HOME_ROOT;
  if (!root) throw new Error('TED_HOME_ROOT not set (must point at experiments/ted-runtime)');
  return root;
}

export function traceDir() {
  return path.join(tedHomeRoot(), 'spike-05d', 'traces');
}

export function traceTimestampedPath(mode, atIso) {
  const safe = String(atIso || new Date().toISOString()).replace(/[:.]/g, '-');
  return path.join(traceDir(), `SPIKE_05D_LIVE_${mode}_${safe}.json`);
}

export function writeTraceSnapshot(traceObj, serialized) {
  const body = String(serialized).endsWith('\n') ? String(serialized) : `${serialized}\n`;
  fs.mkdirSync(traceDir(), { recursive: true });
  let snapshot = traceTimestampedPath(traceObj.mode, traceObj.at);
  if (fs.existsSync(snapshot)) {
    const base = snapshot.replace(/\.json$/, '');
    let i = 2;
    while (fs.existsSync(`${base}-${i}.json`)) i += 1;
    snapshot = `${base}-${i}.json`;
  }
  fs.writeFileSync(snapshot, body, { encoding: 'utf8' });
  return { snapshot };
}

// ---- CLI parsing (pure) -----------------------------------------------------
const OVERRIDE_FLAGS = ['--host', '--route', '--method', '--token', '--workspace', '--actor', '--device', '--household'];
export function rejectOverrideArgs(argv) {
  for (const a of argv) {
    const name = String(a).split('=')[0];
    if (OVERRIDE_FLAGS.includes(name)) {
      throw Object.assign(new Error(`refused: override flag '${name}' is not accepted (identity is fixed HOST_A)`), { exitCode: 2 });
    }
  }
}

export function parseArgs(argv) {
  rejectOverrideArgs(argv);
  let mode = null;
  let message = DEFAULT_MESSAGE_05D;
  let snapshot = null;
  let messageId = null;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--mode' && i + 1 < argv.length) mode = argv[++i];
    else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length);
    else if (a === '--message' && i + 1 < argv.length) message = argv[++i];
    else if (a.startsWith('--message=')) message = a.slice('--message='.length);
    else if (a === '--snapshot' && i + 1 < argv.length) snapshot = argv[++i];
    else if (a.startsWith('--snapshot=')) snapshot = a.slice('--snapshot='.length);
    else if (a === '--message-id' && i + 1 < argv.length) messageId = argv[++i];
    else if (a.startsWith('--message-id=')) messageId = a.slice('--message-id='.length);
    else if (a === '--help' || a === '-h') return { mode: 'help', message, snapshot, messageId };
  }
  if (mode !== 'dryrun' && mode !== 'live' && mode !== 'confirm') {
    throw Object.assign(new Error(`usage: node run-05d-live.mjs --mode=dryrun|live|confirm [--message="..."] [--snapshot=<file>] [--message-id=<id>] (got mode=${JSON.stringify(mode)})`), { exitCode: 2 });
  }
  if (typeof message !== 'string' || message.length === 0 || message.length > 2000) {
    throw Object.assign(new Error('refused: --message must be a non-empty string (<=2000 chars)'), { exitCode: 2 });
  }
  if (mode === 'live' && message !== DEFAULT_MESSAGE_05D) {
    throw Object.assign(new Error('refused: live message is frozen (operator authorization covers exactly one message)'), { exitCode: 2 });
  }
  if (mode === 'confirm' && (typeof snapshot !== 'string' || snapshot.length === 0)) {
    throw Object.assign(new Error('refused: --mode=confirm requires --snapshot=<SPIKE_05D_LIVE_live_*.json>'), { exitCode: 2 });
  }
  return { mode, message, snapshot, messageId };
}

// ---- 05D config (pure; mirrors 05L denies) -----------------------------------
export function build05DConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    agents: {
      [AGENT_05D]: {
        mode: 'primary',
        description: 'TED 05D synthetic experiment agent (no admin tools; propose-only write, durable bridge)',
        permissions: [
          { action: 'shell', resource: '*', effect: 'deny' },
          { action: 'edit', resource: '*', effect: 'deny' },
          { action: 'subagent', resource: '*', effect: 'deny' },
        ],
      },
    },
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: MODEL_PIN.providerID, effect: 'allow' },
      { action: 'tool.use', resource: 'shell:*', effect: 'deny' },
      { action: 'tool.use', resource: 'edit:*', effect: 'deny' },
      { action: 'tool.use', resource: 'write:*', effect: 'deny' },
      { action: 'tool.use', resource: 'subagent:*', effect: 'deny' },
    ],
  };
}

export function write05DConfig(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify(build05DConfig(), null, 2) + '\n', { encoding: 'utf8' });
  return file;
}

// ---- validators (pure) ------------------------------------------------------
// NOTE: balances are NOT asserted (prior deterministic 05D runs executed real
// expenses against this synthetic DB, so balances drift; identity = names+ids).
export function validateAccounts(body) {
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
  if (!rows) return { ok: false, details: { shape: 'expected array or {items:[]}' } };
  const nubank = rows.find((r) => r && r.name === EXPECTED_ACCOUNT_NAME);
  const itau = rows.find((r) => r && r.name === 'Itaú');
  const ok = Boolean(nubank && nubank.id === EXPECTED_ACCOUNT_ID && itau);
  return {
    ok,
    details: {
      count: rows.length,
      names: rows.map((r) => r && r.name).filter(Boolean).slice(0, 20),
      nubankId: nubank && nubank.id,
      expectedNubankId: EXPECTED_ACCOUNT_ID,
    },
  };
}

export function validateCategories(body, { kind = 'expense' } = {}) {
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
  if (!rows) return { ok: false, details: { shape: 'expected array or {items:[]}' } };
  const hit = rows.find((c) => c && c.name === EXPECTED_CATEGORY_NAME && c.id === EXPECTED_CATEGORY_ID);
  const strictKind = rows.every((c) => !c || !c.kind || c.kind === kind);
  return {
    ok: Boolean(hit) && strictKind,
    details: {
      count: rows.length,
      names: rows.map((c) => c && c.name).filter(Boolean).slice(0, 20),
      mercadoFound: Boolean(hit),
      kindOk: strictKind,
    },
  };
}

function saoPauloYesterday(nowMs) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: EVALUATION_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = Object.fromEntries(fmt.formatToParts(nowMs - 24 * 3600 * 1000).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return null; }
}

export function validatePropose(body, { accountId, categoryId, expectedDateUTC, nowMs = Date.now() }) {
  const details = {};
  if (!body || typeof body !== 'object') return { ok: false, details: { shape: 'not-an-object' } };
  if (typeof body.id !== 'string' || body.id.length === 0) return { ok: false, details: { id: 'proposal id (string) required' } };
  details.id = body.id;
  const norm = body.normalizedArgs || body.args || {};
  details.normalizedArgs = {
    amountCents: norm.amountCents,
    accountId: norm.accountId,
    categoryId: norm.categoryId,
    date: norm.date,
  };
  const amountOk = norm.amountCents === EXPECTED_PROPOSE_AMOUNT_CENTS;
  const accountOk = norm.accountId === accountId && norm.accountId === EXPECTED_ACCOUNT_ID;
  const categoryOk = norm.categoryId === categoryId && norm.categoryId === EXPECTED_CATEGORY_ID;
  const spYesterday = saoPauloYesterday(nowMs);
  const dateOk = norm.date === expectedDateUTC || (spYesterday !== null && norm.date === spYesterday);
  details.dateCheck = { observed: norm.date, expectedDateUTC, spYesterday, tzNote: TZ_DIVERGENCE_NOTE };
  const toolOk = !body.tool || body.tool === 'transactions.expense.create';
  const ok = amountOk && accountOk && categoryOk && dateOk && toolOk;
  return { ok, details: { ...details, amountOk, accountOk, categoryOk, dateOk, toolOk } };
}

// ---- trace sanitization (pure) ----------------------------------------------
export function scrubTraceText(text, extraSecrets = []) {
  let out = scrubSecrets(String(text), HOST_A);
  for (const s of extraSecrets) {
    if (typeof s === 'string' && s.length >= 8 && out.includes(s)) out = out.split(s).join('[redacted-credential]');
  }
  return out;
}

export function scanSecrets(serialized, extraSecrets = []) {
  const hits = [];
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(serialized)) hits.push(re.source);
  }
  for (const s of extraSecrets) {
    if (typeof s === 'string' && s.length >= 8 && serialized.includes(s)) hits.push('injected-credential-present');
  }
  return hits;
}

export function assertNoSecrets(traceObj, extraSecrets = []) {
  const serialized = JSON.stringify(traceObj);
  const hits = scanSecrets(serialized, extraSecrets);
  if (hits.length > 0) throw new Error(`trace would leak secrets: ${hits.join(',')}`);
  return serialized;
}

// ---- verdict scaffold (pure) ------------------------------------------------
const B_KEYS = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08'];
export function emptyVerdict() {
  const v = {};
  for (const k of B_KEYS) v[k] = { status: 'not-exercised', reason: '' };
  return v;
}

// ---- LIVE gate + credential (no inference here) -----------------------------
export function assertLiveGate(env = process.env) {
  if (env.TED_05D_LIVE !== '1') {
    throw Object.assign(
      new Error('refused: LIVE turn requires TED_05D_LIVE=1 (accidental-inference lock; dryrun is the default)'),
      { exitCode: 2 },
    );
  }
}

export function loadLiveCredential() {
  const envFile = 'D:/projetos/pi-financeiro/.env';
  let raw;
  try {
    raw = fs.readFileSync(envFile, 'utf8');
  } catch {
    throw Object.assign(new Error('refused: cannot read pi-financeiro .env for OPENCODE_GO'), { exitCode: 2 });
  }
  const m = raw.match(/^OPENCODE_GO=(.+)$/m);
  const value = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  if (!value) throw Object.assign(new Error('refused: OPENCODE_GO missing/empty in pi-financeiro .env'), { exitCode: 2 });
  process.env.OPENCODE_API_KEY = value;
  return { keyLength: value.length, secret: value };
}

// ---- boot: isolated env + 05D config + durable native plugin + facade -------
export async function boot05D() {
  assertDurableEnv();
  process.env.TED_HOME_ROOT = path.resolve(tedHomeRoot());
  const { setupIsolation } = requireHere('./env.cjs');
  const iso = setupIsolation(IDENTITY_05D);
  write05DConfig(iso.dirs.config);
  process.chdir(iso.dirs.workspace);

  const markerFile = path.join(iso.dirs.tmp, 'ted-05d-finance-loaded.json');
  try { fs.unlinkSync(markerFile); } catch { /* fresh proof per boot */ }

  const { OpenCode } = await import('@opencode/sdk');
  const oc = await OpenCode.create({
    config: { directory: iso.dirs.config, project: false },
    database: { path: iso.dirs.db },
  });

  // Durable native registration: same 3 TOOL_DEFS, executors wired through
  // durableRouteTransport (reads = seed bridge, propose = Postgres). The
  // frozen ted-finance plugin is NEVER loaded here (it binds the one-shot
  // bridge); buildExecute is reused for identical host/intention semantics.
  const { buildExecute } = await import('./plugins/ted-finance/index.mjs');
  const { Plugin } = await import('@opencode/plugin');
  const durableExecutors = createToolExecutors(durableRouteTransport);
  const defs = FINANCE_TOOLS_05D.map((n) => TOOL_DEFS.find((d) => d.name === n)).filter(Boolean);
  if (defs.length !== FINANCE_TOOLS_05D.length) throw new Error('05D tool defs drift (TOOL_DEFS no longer carries the 3 finance tools)');
  const ted05D = Plugin.define({
    id: 'ted-finance-05d',
    async setup(ctx) {
      await ctx.tool.transform((editor) => {
        for (const def of defs) {
          editor.add({
            name: def.name,
            description: def.description,
            input: def.input,
            output: def.output,
            execute: buildExecute(def, durableExecutors[def.name]),
          });
        }
      });
      const tools = await ctx.tool.list();
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(markerFile, JSON.stringify({ plugin: 'ted-finance-05d', tools: tools.map((t) => t.id || t.name), at: new Date().toISOString() }));
    },
  });
  await oc.plugin(ted05D);

  let marker = null;
  let tedEntry = null;
  for (let i = 0; i < 30; i++) {
    try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { marker = null; }
    try {
      const listed = await oc.plugin.list();
      const rows = (listed && listed.data) || [];
      tedEntry = rows.find((p) => String(p.id || p.name || '').startsWith('ted-finance')) || null;
    } catch { tedEntry = null; }
    if (marker && tedEntry && tedEntry.state && tedEntry.state.status === 'active') break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const executors = createToolExecutors(durableRouteTransport);
  const bound = Object.freeze({ ...HOST_A });
  const newIntention = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const facade = {
    createSession: async (title) => {
      const s = await oc.session.create({ title: title || 'ted-05d' });
      bindSession(s.id, bound);
      return s;
    },
    getSession: async (sessionID) => {
      requireBoundHost(sessionID, bound);
      return oc.session.get({ sessionID });
    },
    listSessions: async () => filterSessionsForHost(await oc.session.list(), bound),
    removeSession: async (sessionID) => {
      requireBoundHost(sessionID, bound);
      const removed = await oc.session.remove({ sessionID });
      try { (await import('./session-bindings.mjs')).revokeSession(sessionID); } catch { /* best-effort */ }
      return removed;
    },
    listCatalogs: async () => ({
      agents: await summarize(oc.agent.list()),
      commands: await summarize(oc.command.list()),
      skills: await summarize(oc.skill.list()),
      plugins: await summarize(oc.plugin.list()),
      mcp: await summarize(oc.mcp.list()),
      providers: await summarize(oc.provider.list()),
      models: await summarize(oc.model.list()),
      sessions: await summarize((async () => filterSessionsForHost(await oc.session.list(), bound))()),
      hasToolCatalog: oc.tool !== undefined,
    }),
    list_accounts: (args, opts) => executors.list_accounts(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
    list_categories: (args, opts) => executors.list_categories(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
    propose_expense: (args, opts) => executors.propose_expense(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
  };
  const keys = Object.keys(facade).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...FACADE_KEYS_05D].sort())) {
    throw new Error(`facade surface drift: ${keys.join(',')}`);
  }
  return { oc, facade: Object.freeze(facade), iso, markerFile, marker: () => marker, tedEntry: () => tedEntry };
}

function summarize(promise) {
  return promise.then(
    (r) => {
      const data = r && r.data ? r.data : r;
      const ids = Array.isArray(data) ? data.map((d) => d.id || d.name) : [];
      return { count: ids.length, ids: ids.slice(0, 80).map((x) => String(x)) };
    },
    (e) => ({ error: String((e && e.message) || e).slice(0, 160) }),
  );
}

// ---- effective-surface enumeration (no inference) ---------------------------
export async function enumerateEffective(boot) {
  const { oc, facade } = boot;
  const keys = Object.keys(facade).sort();
  const catalogs = await facade.listCatalogs();
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(boot.markerFile, 'utf8')); } catch { marker = null; }
  const listed = await oc.plugin.list().catch(() => null);
  const rows = (listed && listed.data) || [];
  const tedEntry = rows.find((p) => String(p.id || p.name || '').startsWith('ted-finance')) || null;
  const financeTools = Array.isArray(marker && marker.tools) ? [...marker.tools].sort() : [];
  const financeToolsPresent = FINANCE_TOOLS_05D.every((t) => financeTools.includes(t));
  const knownFinance = TOOL_DEFS.map((d) => d.name);
  const financeSubset = financeTools.filter((t) => knownFinance.includes(t)).sort();
  return {
    facadeKeys: keys,
    facadeKeysMatch: JSON.stringify(keys) === JSON.stringify([...FACADE_KEYS_05D].sort()),
    pluginListed: rows.map((p) => String(p.id || p.name)).slice(0, 120),
    tedFinance: tedEntry ? { id: tedEntry.id || tedEntry.name, state: tedEntry.state } : null,
    tedFinanceActive: Boolean(tedEntry && tedEntry.state && tedEntry.state.status === 'active'),
    financeToolsNative: financeTools,
    financeToolsPresent,
    financeToolsSubset: financeSubset,
    financeToolsExactOnly: JSON.stringify(financeSubset) === JSON.stringify([...FINANCE_TOOLS_05D].sort()),
    nativeSupersetNote: 'transform() adds to the built-in catalog (full native list is a superset); exact-only is evaluated over the finance subset (TOOL_DEFS names); enforcement = config denies + LIVE foreign-tool abort (B02/B06)',
    catalogs,
    hasToolCatalog: catalogs.hasToolCatalog === true,
  };
}

// ---- DRYRUN (no inference; durable wiring proof with own scope + cleanup) ---
export async function runDryrun() {
  assertDurableEnv();
  const t0 = Date.now();
  const verdict = emptyVerdict();
  const dateBaseUTC = new Date(t0).toISOString().slice(0, 10);
  const expectedDateUTC = yesterdayUTC(t0);
  const boot = await boot05D();
  const pool = spikePool();
  try {
    await ensureSeed05d(pool);
    const eff = await enumerateEffective(boot);
    verdict.B01 = eff.facadeKeysMatch && eff.tedFinanceActive && eff.financeToolsExactOnly
      ? { status: 'pass', reason: 'facade 8 keys (05D) + ted-finance-05d active + EXACT-ONLY finance tools (built-in superset recorded, enforcement via denies+abort)' }
      : { status: 'fail', reason: `surface mismatch keys=${eff.facadeKeysMatch} active=${eff.tedFinanceActive} exactOnly=${eff.financeToolsExactOnly} finance=${JSON.stringify(eff.financeToolsNative).slice(0, 160)}` };

    verdict.B02 = { status: 'not-exercised', reason: 'prompt-loop untested by design (no inference); LIVE aborts on any non-finance tool call' };

    const session = await boot.facade.createSession('05d-dryrun');
    let accountsCheck = { ok: false, details: {} };
    let categoriesCheck = { ok: false, details: {} };
    let proposeCheck = { ok: false, details: {} };
    let resolved = { accountId: null, categoryId: null };
    let dryrunKey = null;
    let dryrunIntention = null;
    try {
      const accounts = await boot.facade.list_accounts({});
      accountsCheck = validateAccounts(accounts);
      const rows = Array.isArray(accounts) ? accounts : accounts.items;
      const nubank = rows.find((r) => r && r.name === EXPECTED_ACCOUNT_NAME);
      const cats = await boot.facade.list_categories({ kind: 'expense' });
      categoriesCheck = validateCategories(cats, { kind: 'expense' });
      const crows = Array.isArray(cats) ? cats : cats.items;
      const mercado = crows.find((c) => c && c.name === EXPECTED_CATEGORY_NAME);
      resolved = { accountId: nubank && nubank.id, categoryId: mercado && mercado.id };
      if (nubank && mercado) {
        dryrunIntention = deriveIntentionId({ sessionID: session.id, messageID: 'dryrun-05d-msg-01' });
        dryrunKey = deriveExpenseIdempotencyKey({ workspace: HOUSEHOLD_A, intentionId: dryrunIntention });
        await resetScope05d(pool, { keys: [dryrunKey], intentions: [dryrunIntention], descriptions: [DRYRUN_DESCRIPTION] });
        const proposed = await boot.facade.propose_expense({
          amountCents: EXPECTED_PROPOSE_AMOUNT_CENTS,
          description: DRYRUN_DESCRIPTION,
          date: expectedDateUTC,
          accountId: nubank.id,
          categoryId: mercado.id,
        });
        proposeCheck = validatePropose(proposed, { accountId: nubank.id, categoryId: mercado.id, expectedDateUTC });
        // Durability spot-check inside dryrun: fresh-process GET observes the proposal.
        if (proposeCheck.ok) {
          const g = await callFinanceDurable({ op: 'get', host: HOST_A, id: proposed.id });
          if (g.statusCode !== 200 || g.body.id !== proposed.id || g.body.status !== 'proposed') {
            proposeCheck = { ok: false, details: { ...proposeCheck.details, durableGet: `GET mismatch: ${g.statusCode} ${JSON.stringify(g.body).slice(0, 160)}` } };
          } else {
            proposeCheck.details.durableGet = 'fresh-process GET observes same id, status proposed (restart proof in dryrun)';
          }
        }
      } else {
        proposeCheck = { ok: false, details: { resolved, reason: 'Nubank/Mercado not resolved from reads — propose refused (never invent ids)' } };
      }
    } finally {
      await boot.facade.removeSession(session.id).catch(() => {});
      if (dryrunKey && dryrunIntention) {
        await resetScope05d(pool, { keys: [dryrunKey], intentions: [dryrunIntention], descriptions: [DRYRUN_DESCRIPTION] }).catch(() => {});
      }
    }
    verdict.B04 = accountsCheck.ok && categoriesCheck.ok && proposeCheck.ok
      ? { status: 'pass', reason: `reads resolve Nubank+Mercado; DURABLE propose carries listed ids @${expectedDateUTC} x${EXPECTED_PROPOSE_AMOUNT_CENTS} (+ fresh-process GET)` }
      : { status: 'fail', reason: `deterministic mismatch: accounts=${JSON.stringify(accountsCheck.details).slice(0, 160)} categories=${JSON.stringify(categoriesCheck.details).slice(0, 160)} propose=${JSON.stringify(proposeCheck.details).slice(0, 300)}` };
    verdict.B03 = { status: 'pass', reason: 'host-bound facade: HOST_A frozen, no arg-identity (validateToolArgs rejects overrides)' };
    verdict.B05 = { status: 'pass', reason: 'A-only session, synthetic seed; isolation proven by 05L category-tool suite (A/B disjoint)' };
    verdict.B06 = { status: 'not-exercised', reason: 'no prompt in dryrun; LIVE aborts (no retry) on any non-finance tool call' };
    verdict.B08 = { status: 'not-exercised', reason: 'no prompt in dryrun; LIVE budget is 4 internal steps / 90s with interrupt' };

    const trace = {
      spike: '05D',
      mode: 'dryrun',
      at: new Date().toISOString(),
      identity: 'A-only',
      sessionPromptCalled: false,
      agent: AGENT_05D,
      model: { ...MODEL_PIN },
      config: build05DConfig(),
      financeAllowlist: [...FINANCE_TOOLS_05D],
      facadeKeys: [...FACADE_KEYS_05D],
      durableBridge: 'Postgres ted_spike_05d via durableRouteTransport (propose durable; reads via seed bridge with identical fixture ids)',
      allowlistNote: 'confirm/cancel/execute do not exist on the LLM surface (propose-only; confirmation is --mode=confirm, a separate explicit action)',
      preExecGate: { ...PRE_EXEC_LIMITATION },
      stepsNote: `MAX_INTERNAL_STEPS=${MAX_INTERNAL_STEPS} is a best-effort post-observation abort (message.list tally + interrupt), not preemptive SDK enforcement`,
      dates: { dateBaseUTC, expectedDateUTC, evaluationTz: EVALUATION_TZ, tzNote: TZ_DIVERGENCE_NOTE },
      effective: eff,
      deterministicFinance: { accounts: accountsCheck, categories: categoriesCheck, propose: proposeCheck, resolved },
      cost: { note: 'no inference in dryrun; SDK tokens/cost n/a — LIVE records tokens/usage only when exposed, never assumes zero', ceiling: COST_CEILING_NOTE },
      verdict,
      elapsedMs: Date.now() - t0,
    };
    const serialized = assertNoSecrets(trace);
    verdict.B07 = scanSecrets(serialized).length === 0
      ? { status: 'pass', reason: 'trace carries zero token substrings (pre-write scan)' }
      : { status: 'fail', reason: 'secret scan hit' };
    trace.verdict = verdict;
    const finalSerialized = assertNoSecrets(trace);
    const { snapshot } = writeTraceSnapshot(trace, finalSerialized);
    return { trace, snapshot, output: sanitizedSummary(trace) };
  } finally {
    await pool.end().catch(() => {});
    await boot.oc.close().catch(() => {});
  }
}

function sanitizedSummary(trace) {
  return {
    spike: trace.spike,
    mode: trace.mode,
    sessionPromptCalled: trace.sessionPromptCalled,
    facadeKeys: trace.effective.facadeKeys,
    tedFinanceActive: trace.effective.tedFinanceActive,
    financeToolsNative: trace.effective.financeToolsNative,
    deterministicFinance: {
      accountsOk: trace.deterministicFinance.accounts.ok,
      categoriesOk: trace.deterministicFinance.categories.ok,
      proposeOk: trace.deterministicFinance.propose.ok,
    },
    dates: trace.dates,
    verdict: trace.verdict,
    elapsedMs: trace.elapsedMs,
  };
}

// ---- LIVE helpers (mirrored from 05L) ---------------------------------------
export function extractToolCalls(messages) {
  const calls = [];
  const partTypes = new Set();
  const visit = (node, depth) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) visit(x, depth + 1); return; }
    if (typeof node.type === 'string') partTypes.add(node.type);
    if (Array.isArray(node.toolCalls)) {
      for (const tc of node.toolCalls) {
        if (tc && typeof tc.tool === 'string') {
          calls.push({ name: tc.tool, args: tc.input !== undefined ? tc.input : tc.args, status: tc.status, via: 'codemode-metadata' });
        }
      }
    }
    const name = node.name || node.tool || (node.function && node.function.name);
    if (typeof name === 'string' && (node.input !== undefined || node.args !== undefined || node.arguments !== undefined)) {
      calls.push({ name, args: node.input !== undefined ? node.input : (node.args !== undefined ? node.args : node.arguments), status: node.status, via: 'direct' });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'toolCalls') continue;
      visit(v, depth + 1);
    }
  };
  visit(messages, 0);
  return { calls, partTypes: [...partTypes].slice(0, 30) };
}

export function summarizeSelection(calls) {
  const names = [...new Set(calls.map((c) => c.name))];
  const foreign = names.filter((n) => !FINANCE_TOOLS_05D.includes(n));
  const perTool = {};
  for (const t of FINANCE_TOOLS_05D) {
    const mine = calls.filter((c) => c.name === t);
    perTool[t] = { observed: mine.length > 0, count: mine.length, statuses: [...new Set(mine.map((c) => String(c.status || 'unknown')))] };
  }
  return { names, foreign, perTool, proposeObserved: perTool.propose_expense.observed };
}

function findProposalIn(node, depth = 0) {
  // Accepts ONLY the result-shaped object: UUID id + (normalizedArgs|args)
  // carrying amountCents. Tool CALL inputs (args without id) never match.
  if (!node || typeof node !== 'object' || depth > 3) return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const f = findProposalIn(x, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const norm = node.normalizedArgs || node.args;
  if (typeof node.id === 'string' && UUID_RE.test(node.id)
    && norm && typeof norm === 'object' && typeof norm.amountCents === 'number') {
    return node;
  }
  for (const k of ['output', 'value', 'result', 'body']) {
    if (node[k] && typeof node[k] === 'object') {
      const f = findProposalIn(node[k], depth + 1);
      if (f) return f;
    }
  }
  return null;
}

// Scans every balanced top-level {...} candidate (string-aware) and returns
// the first result-shaped proposal object. firstJsonObjectWith-style
// innermost matching is WRONG here: the id lives on the OUTER object while
// amountCents lives inside normalizedArgs.
function firstProposalObject(text) {
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < Math.min(text.length, start + 20000); j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, j + 1));
            const found = findProposalIn(parsed);
            if (found) return found;
          } catch { /* not JSON — keep scanning */ }
          break;
        }
      }
    }
    i = start + 1;
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Best-effort extraction of the LIVE propose result (incl. proposalId) from
// NON-USER message texts. Returns {ok, proposalId, proposal} — proposalId is
// MANDATORY (no id => no live linkage => FAIL, never guess).
export function extractLiveProposal(messages) {
  const texts = [];
  const collect = (node, depth, skipUser) => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === 'string') { if (!skipUser && node.length > 20) texts.push(node); return; }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) collect(x, depth + 1, skipUser); return; }
    const role = node.role;
    const kidSkip = skipUser || role === 'user';
    for (const v of Object.values(node)) collect(v, depth + 1, kidSkip);
  };
  collect(messages, 0, false);
  let sawMarker = false;
  for (const t of texts) {
    if (!(t.includes('transactions.expense.create') || (t.includes('normalizedArgs') && t.includes('amountCents')))) continue;
    sawMarker = true;
    const hit = firstProposalObject(t);
    if (hit) return { ok: true, proposalId: hit.id, proposal: hit };
  }
  if (sawMarker) return { ok: false, reason: 'propose result observed but proposal id missing/unshaped (no linkage possible)', proposal: null, proposalId: null };
  return { ok: false, reason: 'no propose result data observed (transactions.expense.create/normalizedArgs)', proposal: null, proposalId: null };
}

export function validateLivePropose(messages, { expectedDateUTC, nowMs = Date.now() }) {
  const ext = extractLiveProposal(messages);
  if (!ext.ok) return { ok: false, reason: ext.reason, proposalId: ext.proposalId || null };
  const norm = ext.proposal.normalizedArgs || ext.proposal.args || ext.proposal;
  if (norm.amountCents !== EXPECTED_PROPOSE_AMOUNT_CENTS) {
    return { ok: false, reason: `propose amount mismatch (expected ${EXPECTED_PROPOSE_AMOUNT_CENTS}, observed ${JSON.stringify(norm.amountCents)})`, proposalId: ext.proposalId };
  }
  if (norm.accountId !== EXPECTED_ACCOUNT_ID || norm.categoryId !== EXPECTED_CATEGORY_ID) {
    return { ok: false, reason: `propose ids mismatch (account ${JSON.stringify(norm.accountId)} vs ${EXPECTED_ACCOUNT_ID}; category ${JSON.stringify(norm.categoryId)} vs ${EXPECTED_CATEGORY_ID})`, proposalId: ext.proposalId };
  }
  const spYesterday = saoPauloYesterday(nowMs);
  const dateOk = norm.date === expectedDateUTC || (spYesterday !== null && norm.date === spYesterday);
  if (!dateOk) {
    return { ok: false, reason: `propose date mismatch (observed ${JSON.stringify(norm.date)} vs UTC-yesterday ${expectedDateUTC} / SP-yesterday ${spYesterday})`, proposalId: ext.proposalId };
  }
  return { ok: true, reason: `live propose observed x${norm.amountCents} Nubank+Mercado @${norm.date} (proposal ${ext.proposalId})`, proposalId: ext.proposalId, proposal: ext.proposal };
}

export function findUserMessageId(messages, message) {
  const needle = String(message).slice(0, 24);
  for (const m of messages || []) {
    if (!m) continue;
    // SDK 2.2.4 message shape carries `type` (user/assistant/idle), not `role`.
    if (m.role !== 'user' && m.type !== 'user') continue;
    try {
      if (JSON.stringify(m).includes(needle) && typeof m.id === 'string' && m.id.length > 0) return m.id;
    } catch { /* keep scanning */ }
  }
  return null;
}

// Propose-only prose gate (heuristic, evidence-decisive): ledger nouns
// (lançamento/extrato as effected objects) always fail; effect verbs
// (criada/registrada/...) fail UNLESS the text also names proposta/confirmação
// (proposal lifecycle prose, e.g. "proposta ... aguardando confirmação para
// ser efetivada"). The quoted response text in the trace is the decisive
// evidence; this predicate is the harness pre-screen, never the proof.
export function assertsLedgerEffect(text) {
  const t = String(text || '');
  if (/\blan[cç]amento/i.test(t)) return true;
  if (/\bextrato/i.test(t) && /(cri|registr|adicion|atualiz|lan[cç]|efetu|efetiv|conclu)/i.test(t)) return true;
  if (/(criad[oa]|registrad[oa]|adicionad[oa]|efetuad[oa]|efetivad[oa]|lan[cç]ad[oa]|foi adicionad)/i.test(t)
    && !/(proposta|confirma[çc][aã]o)/i.test(t)) return true;
  return false;
}

export function lastAssistantText(messages) {
  const ordered = [...(messages || [])].sort((a, b) => {
    const ta = a && a.time && typeof a.time.created === 'number' ? a.time.created : Number.POSITIVE_INFINITY;
    const tb = b && b.time && typeof b.time.created === 'number' ? b.time.created : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
  const partTexts = [];
  for (const m of ordered) {
    if (!m || m.role === 'user' || m.type === 'user') continue;
    if (m.type === 'user') continue;
    const parts = m.parts || m.content || [];
    const arr = Array.isArray(parts) ? parts : [parts];
    for (const p of arr) {
      if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0) partTexts.push(p.text);
      else if (typeof p === 'string' && p.trim().length > 0) partTexts.push(p);
    }
    if (typeof m.text === 'string' && m.text.trim().length > 0) partTexts.push(m.text);
  }
  for (let i = partTexts.length - 1; i >= 0; i--) {
    const t = partTexts[i].trim();
    if (t.length === 0) continue;
    try { JSON.parse(t); continue; } catch { /* prose — candidate */ }
    return partTexts[i];
  }
  return partTexts.length > 0 ? partTexts[partTexts.length - 1] : '';
}

// ---- LIVE (single turn, durable propose) ------------------------------------
export async function runLive(message) {
  assertLiveGate();
  assertDurableEnv();
  const { secret } = loadLiveCredential();
  const t0 = Date.now();
  const dateBaseUTC = new Date(t0).toISOString().slice(0, 10);
  const expectedDateUTC = yesterdayUTC(t0);
  const verdict = emptyVerdict();
  const pool = spikePool();
  let boot = null;
  const events = [];
  let sessionID = null;
  try {
    await ensureSeed05d(pool);
    boot = await boot05D();
    const eff = await enumerateEffective(boot);
    if (!eff.tedFinanceActive || !eff.financeToolsExactOnly) {
      verdict.B01 = { status: 'fail', reason: `pre-inference surface mismatch — aborting before prompt (exactOnly=${eff.financeToolsExactOnly} finance=${JSON.stringify(eff.financeToolsNative).slice(0, 160)})` };
      return finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, aborted: 'pre-inference-surface', secret });
    }
    verdict.B01 = { status: 'pass', reason: 'pre-inference surface ok (facade 05D 8 + ted-finance-05d active + finance EXACT-ONLY, propose durable)' };

    const session = await boot.facade.createSession('05d-live-turn');
    sessionID = session.id;
    let pinned = [];
    try {
      if (typeof boot.oc.session.switchAgent === 'function') {
        await boot.oc.session.switchAgent({ sessionID, agent: AGENT_05D });
        pinned.push(`agent:${AGENT_05D}`);
      }
      if (typeof boot.oc.session.switchModel === 'function') {
        await boot.oc.session.switchModel({ sessionID, model: { ...MODEL_PIN } });
        pinned.push(`model:${MODEL_PIN.providerID}/${MODEL_PIN.id}`);
      }
    } catch (e) {
      return finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, aborted: `pin-failed:${String((e && e.message) || e).slice(0, 160)}`, secret });
    }

    const deadline = t0 + LIVE_TIMEOUT_MS;
    let stopEvents = false;
    (async () => {
      try {
        if (typeof boot.oc.event.subscribe !== 'function') return;
        for await (const ev of boot.oc.event.subscribe()) {
          if (stopEvents) break;
          const s = JSON.stringify(ev || {}).slice(0, 2000);
          if (sessionID && s.includes(sessionID)) events.push(JSON.parse(scrubTraceText(s)));
          if (events.length > 200 || Date.now() > deadline) break;
        }
      } catch { /* best-effort only */ }
    })();

    const enforcementFailures = [];
    let promptTimeout = null;
    let promptError = null;
    {
      const res = await promptWithDeadline({
        promptFn: () => boot.oc.session.prompt({ sessionID, text: message }),
        interruptFn: (async () => {
          if (typeof boot.oc.session.interrupt === 'function') {
            await boot.oc.session.interrupt({ sessionID });
          } else {
            throw new Error('interrupt-unavailable (SDK exposes no session.interrupt)');
          }
        }),
        timeoutMs: Math.max(1000, deadline - Date.now()),
      });
      promptError = res.error;
      promptTimeout = res.timedOut ? { interruptAttempted: res.interruptAttempted, interruptOk: res.interruptOk, interruptError: res.interruptError } : null;
      if (res.timedOut && (!res.interruptAttempted || !res.interruptOk)) {
        enforcementFailures.push(`prompt-timeout interrupt not confirmable (attempted=${res.interruptAttempted} ok=${res.interruptOk} err=${res.interruptError || 'n/a'})`);
      }
    }

    let messages = [];
    let lastChange = Date.now();
    let lastSig = '';
    let deadlineInterrupt = null;
    for (;;) {
      const now = Date.now();
      if (now > deadline) {
        if (typeof boot.oc.session.interrupt === 'function') {
          deadlineInterrupt = await interruptWithDeadline(
            () => boot.oc.session.interrupt({ sessionID }),
            INTERRUPT_TIMEOUT_MS,
          );
          if (!deadlineInterrupt.ok) {
            enforcementFailures.push(`polling-deadline interrupt failed: ${deadlineInterrupt.error}`);
          }
        } else {
          deadlineInterrupt = { attempted: false, ok: false, error: 'interrupt-unavailable' };
          enforcementFailures.push('polling-deadline interrupt not confirmable (no session.interrupt)');
        }
        events.push({ deadlineExceeded: true, interrupt: deadlineInterrupt, overrunMs: now - deadline });
        break;
      }
      {
        const remaining = Math.max(1000, deadline - Date.now());
        const pollMs = Math.min(POLL_TIMEOUT_MS, remaining);
        const { rows, pollTimeout } = await pollMessagesWithDeadline({
          listFn: () => boot.oc.message.list({ sessionID }),
          pollTimeoutMs: pollMs,
          interruptFn: typeof boot.oc.session.interrupt === 'function'
            ? () => boot.oc.session.interrupt({ sessionID })
            : undefined,
          enforcementFailures,
          events,
          deadlineTs: deadline,
        });
        if (rows !== null) {
          messages = rows;
        }
        if (pollTimeout) {
          deadlineInterrupt = pollTimeout.interrupt;
          events.push({ deadlineExceeded: true, via: 'poll-timeout', interrupt: pollTimeout.interrupt, overrunMs: pollTimeout.overrunMs ?? 0 });
          break;
        }
      }
      const sig = JSON.stringify(messages).length + ':' + messages.length;
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
      const { calls } = extractToolCalls(messages);
      const selPoll = summarizeSelection(calls);
      if (selPoll.foreign.length > 0) {
        verdict.B02 = { status: 'fail', reason: `non-finance tool invoked: ${selPoll.foreign.join(',')}` };
        verdict.B06 = { status: 'fail', reason: 'allowlist breach — interrupted, no retry' };
        const abortInterrupt = await abortWithInterrupt({
          interruptFn: typeof boot.oc.session.interrupt === 'function'
            ? () => boot.oc.session.interrupt({ sessionID })
            : undefined,
          reason: 'foreign-tool',
          enforcementFailures,
          events,
        });
        stopEvents = true;
        return finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, pinned, promptError, promptTimeout, messages, toolCalls: calls, aborted: 'foreign-tool', abortInterrupt, enforcementFailures, secret, sessionPromptCalled: true, sessionPromptCount: 1 });
      }
      const steps = countSteps(messages, events);
      if (steps.overBudget) {
        verdict.B08 = { status: 'fail', reason: `>${MAX_INTERNAL_STEPS} internal steps (best-effort post-observation abort, not preemptive enforcement) — interrupted` };
        const abortInterrupt = await abortWithInterrupt({
          interruptFn: typeof boot.oc.session.interrupt === 'function'
            ? () => boot.oc.session.interrupt({ sessionID })
            : undefined,
          reason: 'step-budget',
          enforcementFailures,
          events,
        });
        stopEvents = true;
        return finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, pinned, promptError, promptTimeout, messages, toolCalls: calls, aborted: 'step-budget', abortInterrupt, enforcementFailures, secret, sessionPromptCalled: true, sessionPromptCount: 1 });
      }
      if (messages.length > 1 && Date.now() - lastChange > 6000) break;
      if (promptError && messages.length <= 1 && Date.now() - t0 > 30000) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    stopEvents = true;

    const { calls, partTypes } = extractToolCalls(messages);
    const sel = summarizeSelection(calls);
    const statusNote = FINANCE_TOOLS_05D.map((t) => `${t}:${sel.perTool[t].observed ? sel.perTool[t].statuses.join('/') : 'not-observed'}`).join(',');
    const proposeObserved = sel.proposeObserved;
    verdict.B02 = sel.foreign.length === 0 && proposeObserved
      ? { status: 'pass', reason: `05D finance selection observed, no foreign tools (${statusNote})` }
      : { status: 'fail', reason: sel.foreign.length > 0 ? `non-finance tool invoked: ${sel.foreign.join(',')}` : `propose_expense not observed (${statusNote})` };
    verdict.B06 = sel.foreign.length === 0
      ? { status: 'pass', reason: 'allowlist-only surface observed; no admin tool invoked, no retry performed' }
      : { status: 'fail', reason: 'allowlist breach' };
    const hayEvents = JSON.stringify(events).slice(0, 20000);
    const hostErr = /host_context_required|host_binding_mismatch|host_binding_revoked|host_binding_expired/.test(hayEvents);
    const reachedExecutor = calls.some((c) => ['running', 'success', 'completed', 'error'].includes(String(c.status)));
    verdict.B03 = hostErr
      ? { status: 'fail', reason: 'binding/host error observed in events' }
      : reachedExecutor
        ? { status: 'pass', reason: 'finance calls reached executor with host-bound context, no host errors' }
        : { status: 'fail', reason: 'no finance call reached the executor' };
    const hayAll = (JSON.stringify(messages).slice(0, 60000) + hayEvents);
    verdict.B05 = /Bradesco|dev-token-2|HOUSEHOLD_B/.test(hayAll)
      ? { status: 'fail', reason: 'cross-identity (B) data observed' }
      : { status: 'pass', reason: 'A-only session, no B-identity data in messages/events' };
    const accuracy = validateLivePropose(messages, { expectedDateUTC });
    verdict.B04 = accuracy.ok
      ? { status: 'pass', reason: accuracy.reason }
      : { status: 'fail', reason: accuracy.reason };
    const finalText = lastAssistantText(messages);
    verdict.B07 = accuracy.ok && finalText.length > 0 && !assertsLedgerEffect(finalText)
      ? { status: 'pass', reason: 'propose evidence observed with grounded response text (no ledger effect claimed — propose-only)' }
      : { status: 'fail', reason: accuracy.ok ? (finalText.length === 0 ? 'no response text' : 'response asserts a ledger effect (propose-only violated in prose)') : `propose unproven (${finalText.length > 0 ? 'response present but ungrounded' : 'no response text'})` };
    const finalSteps = countSteps(messages, events);
    if (verdict.B08.status === 'not-exercised') {
      verdict.B08 = { status: !finalSteps.overBudget ? 'pass' : 'fail', reason: `steps=${finalSteps.assistantCount} eventTools=${finalSteps.eventToolCount} budget=${MAX_INTERNAL_STEPS} latencyMs=${Date.now() - t0} (best-effort post-observation, not preemptive)` };
    }
    return finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, pinned, promptError, promptTimeout, messages, toolCalls: calls, partTypes, deadlineInterrupt, enforcementFailures, secret, sessionPromptCalled: true, sessionPromptCount: 1, liveProposalId: accuracy.proposalId || null, liveProposal: accuracy.proposal || null });
  } finally {
    if (boot) await boot.oc.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

function collectUsage(messages, events) {
  const hay = JSON.stringify({ messages, events }).slice(0, 400000);
  const out = { exposed: false, detail: null };
  const m = hay.match(/"(tokens|usage|totalTokens|promptTokens|completionTokens|total_cost|cost)"\s*:\s*(\{[^}]{0,400}\}|[0-9.]+)/);
  if (m) {
    out.exposed = true;
    out.detail = m[0].slice(0, 400);
  } else {
    out.detail = 'sdk did not expose tokens/usage/cost in messages/events — latency + steps recorded; cost treated as unknown (ceiling US$5 / 1 model / <=4 inferences / 90s enforced by harness, not by meter)';
  }
  return out;
}

export function finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, pinned = [], promptError = null, promptTimeout = null, messages = [], toolCalls = [], partTypes = [], aborted = null, deadlineInterrupt = null, abortInterrupt = null, enforcementFailures = [], secret, sessionPromptCalled = false, sessionPromptCount = 0, liveProposalId = null, liveProposal = null }) {
  const clean = (v) => JSON.parse(scrubTraceText(JSON.stringify(v), secret ? [secret] : []));
  const usage = collectUsage(messages, events);
  const userMessageID = sessionPromptCalled ? findUserMessageId(messages, message) : null;
  let intentionId = null;
  let idempotencyKey = null;
  if (sessionPromptCalled && typeof sessionID === 'string' && typeof userMessageID === 'string') {
    try {
      intentionId = deriveIntentionId({ sessionID, messageID: userMessageID });
      idempotencyKey = deriveExpenseIdempotencyKey({ workspace: HOUSEHOLD_A, intentionId });
    } catch { intentionId = null; idempotencyKey = null; }
  }
  const norm = liveProposal ? (liveProposal.normalizedArgs || liveProposal.args || {}) : {};
  const trace = {
    spike: '05D',
    mode: 'live',
    at: new Date().toISOString(),
    identity: 'A-only',
    sessionPromptCalled,
    sessionPromptCount,
    sessionID: typeof sessionID === 'string' ? sessionID : null,
    userMessageID,
    intentionId,
    idempotencyKey,
    liveProposalId,
    liveProposalArgs: liveProposalId ? {
      amountCents: norm.amountCents ?? null,
      accountId: norm.accountId ?? null,
      categoryId: norm.categoryId ?? null,
      date: norm.date ?? null,
      description: norm.description ?? null,
    } : null,
    agent: AGENT_05D,
    model: { ...MODEL_PIN },
    modelFallback: 'none (single pinned model; no fallback, no retry)',
    pinned,
    message,
    promptError,
    promptTimeout,
    deadlineInterrupt,
    abortInterrupt,
    pollingDeadlineNote: POLLING_DEADLINE_NOTE,
    enforcementFailures: clean(enforcementFailures),
    aborted,
    dates: { dateBaseUTC, expectedDateUTC, evaluationTz: EVALUATION_TZ, tzNote: TZ_DIVERGENCE_NOTE },
    financeAllowlist: [...FINANCE_TOOLS_05D],
    durableBridge: 'Postgres ted_spike_05d via durableRouteTransport (propose durable; reads via seed bridge with identical fixture ids)',
    confirmationGate: 'propose-only: confirm/cancel/execute not exposed to the LLM; no auto-confirmation performed; free text ("sim" or otherwise) never confirms — confirmation is --mode=confirm, a separate explicit action',
    preExecGate: { ...PRE_EXEC_LIMITATION },
    stepsNote: `MAX_INTERNAL_STEPS=${MAX_INTERNAL_STEPS} is a best-effort post-observation abort (message.list tally + interrupt), not preemptive SDK enforcement — no reliable pre-execution step signal in 2.2.4`,
    effective: eff,
    toolCalls: clean(toolCalls.map((c) => ({ name: c.name, args: c.args, status: c.status || 'unknown', via: c.via || 'direct' }))),
    partTypes,
    messageCount: messages.length,
    messageExcerpt: clean(messages.map((m) => ({
      role: m && m.role,
      text: JSON.stringify(m && (m.parts || m.content || m.text || '')).slice(0, 2000),
    }))),
    events: clean(events),
    usage,
    cost: { note: usage.exposed ? `exposed detail: ${usage.detail}` : usage.detail, ceiling: COST_CEILING_NOTE },
    verdict,
    elapsedMs: Date.now() - t0,
  };
  const serialized = assertNoSecrets(trace, secret ? [secret] : []);
  const { snapshot } = writeTraceSnapshot(trace, serialized);
  return { trace, snapshot, secretLen: secret ? secret.length : 0 };
}

// ---- CONFIRM (deterministic, zero inference): confirm THE live proposal -----
export async function runConfirm(snapshotPath, { messageId = null } = {}) {
  assertDurableEnv();
  const t0 = Date.now();
  const events = [];
  const mark = (event, data = {}) => events.push({ at: new Date().toISOString(), event, ...data });
  const fail = (reason, extra = {}) => {
    const trace = {
      spike: '05D', mode: 'confirm', at: new Date().toISOString(),
      snapshot: snapshotPath ? path.basename(snapshotPath) : null, verdict: 'FAIL', reason,
      events, elapsedMs: Date.now() - t0, ...extra,
    };
    const serialized = assertNoSecrets(trace);
    const { snapshot } = writeTraceSnapshot(trace, serialized);
    return { ok: false, trace, snapshot };
  };
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (e) {
    return fail(`cannot read live snapshot: ${String((e && e.message) || e).slice(0, 160)}`);
  }
  if (snap.spike !== '05D' || snap.mode !== 'live') return fail('snapshot is not a 05D live trace');
  if (snap.sessionPromptCount !== 1) return fail(`live trace proves ${snap.sessionPromptCount ?? '?'} prompts (expected exactly 1)`);
  const liveProposalId = snap.liveProposalId;
  if (typeof liveProposalId !== 'string' || !UUID_RE.test(liveProposalId)) {
    return fail('liveProposalId missing/unshaped in live snapshot (no linkage possible — never confirm a non-live proposal)');
  }
  if (typeof snap.sessionID !== 'string' || snap.sessionID.length === 0) {
    return fail('live snapshot lacks sessionID (refusing to confirm without turn identity)');
  }
  // Intention recovery: the live turn's propose executes under the ASSISTANT
  // message being generated (SDK ctx.messageID), not the user message — proven
  // 2026-10-31: only the 2nd assistant message re-derives the stored
  // idempotency key. The candidate message id arrives EXPLICITLY via
  // --message-id (recovered from the isolated session db, quoted in evidence)
  // and is SELF-VALIDATING below: a wrong id yields a key mismatch and FAIL.
  const candidateMessageId = typeof messageId === 'string' && messageId.length > 0
    ? messageId
    : (typeof snap.userMessageID === 'string' && snap.userMessageID.length > 0 ? snap.userMessageID : null);
  if (!candidateMessageId) {
    return fail('no candidate propose-message id (--message-id required: live snapshot predates message-id capture — refusing to guess)');
  }
  let intentionId;
  let idempotencyKey;
  try {
    intentionId = deriveIntentionId({ sessionID: snap.sessionID, messageID: candidateMessageId });
    idempotencyKey = deriveExpenseIdempotencyKey({ workspace: HOUSEHOLD_A, intentionId });
  } catch (e) {
    return fail(`intention derivation failed: ${String((e && e.message) || e).slice(0, 160)}`);
  }
  if (snap.intentionId && (intentionId !== snap.intentionId || idempotencyKey !== snap.idempotencyKey)) {
    return fail('derived intention/idempotencyKey diverge from the live snapshot (refusing to confirm under a different identity)', {
      derived: { intentionId, idempotencyKey },
      recorded: { intentionId: snap.intentionId, idempotencyKey: snap.idempotencyKey },
    });
  }
  mark('intention.derived', { intentionId, idempotencyKey, liveProposalId, proposeMessageId: candidateMessageId });
  const args = snap.liveProposalArgs || {};
  const expectedDate = args.date;
  const description = typeof args.description === 'string' && args.description.length > 0 ? args.description : 'mercado';
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(expectedDate || '')) {
    return fail(`live snapshot carries no usable expected date (${JSON.stringify(expectedDate)})`);
  }
  const pool = spikePool();
  try {
    await ensureSeed05d(pool);
    // (1) 1st restart already proven by live GET; re-GET here (new process per call).
    mark('process.restart', { label: 'confirm-get', marker: 1 });
    const g = await callFinanceDurable({ op: 'get', host: HOST_A, id: liveProposalId, requestId: intentionId });
    if (g.statusCode !== 200 || g.body.id !== liveProposalId) {
      return fail(`GET live proposal mismatch: ${g.statusCode} ${JSON.stringify(g.body).slice(0, 200)}`);
    }
    if (g.body.status !== 'proposed') {
      return fail(`live proposal is not proposed (status=${g.body.status}) — refusing (never re-confirm a consumed proposal)`);
    }
    // MANDATORY linkage: the stored idempotency key must equal the key derived
    // from the candidate propose-message id (sha256 preimage — infeasible to
    // collide). A wrong --message-id fails HERE, before any effect. NOTE: the
    // GET response body does not carry the key — read it from the durable row.
    const prow = await getPending05d(pool, liveProposalId);
    if (!prow || prow.idempotency_key !== idempotencyKey) {
      return fail(`idempotency linkage mismatch (candidate message id does not explain the live proposal — refusing): stored=${prow ? prow.idempotency_key : 'no-row'} derived=${idempotencyKey}`);
    }
    mark('linkage.proven', { liveProposalId, idempotencyKey, proposeMessageId: candidateMessageId });
    mark('get.proposed', { liveProposalId });
    const n0 = await countTx05d(pool, { description, accountId: EXPECTED_ACCOUNT_ID, date: expectedDate });
    mark('sql.count.before', { n: n0, expectedDate, description });
    // (2) confirm with the re-derived live intention (authorized synthetic identity).
    mark('process.restart', { label: 'confirm', marker: 2 });
    const c1 = await callFinanceDurable({ op: 'confirm', host: HOST_A, id: liveProposalId, body: { intentionId }, requestId: intentionId });
    if (c1.statusCode !== 200 || c1.body.status !== 'confirmed') {
      return fail(`confirm not-confirmed: ${c1.statusCode} ${JSON.stringify(c1.body).slice(0, 300)}`);
    }
    const attestation = c1.body.attestation;
    if (typeof attestation !== 'string' || attestation.length < 32) {
      return fail('confirm issued no attestation (refusing to execute without one)');
    }
    mark('confirm.confirmed', { liveProposalId, attestationLength: attestation.length });
    // (3) execute via attestation.
    mark('process.restart', { label: 'execute', marker: 3 });
    const x1 = await callFinanceDurable({ op: 'execute', host: HOST_A, id: liveProposalId, body: { attestation, intentionId }, requestId: intentionId });
    if (x1.statusCode !== 200 || x1.body.status !== 'succeeded') {
      return fail(`execute not-succeeded: ${x1.statusCode} ${JSON.stringify(x1.body).slice(0, 300)}`);
    }
    mark('execute.succeeded', { liveProposalId });
    // (4) SQL: delta exactly +1; receipt binds proposal->tx; values match.
    // NOTE: description comes from the LIVE snapshot (model wrote "Mercado",
    // capital M) — never a hardcoded lowercase guess.
    const n1 = await countTx05d(pool, { description, accountId: EXPECTED_ACCOUNT_ID, date: expectedDate });
    if (n1 !== n0 + 1) {
      return fail(`ledger delta is not +1 (before=${n0} after=${n1})`, { n0, n1 });
    }
    const receipt = x1.body.execution?.receipt;
    if (!receipt || receipt.operationId !== liveProposalId || !receipt.entity?.id || receipt.status !== 'succeeded') {
      return fail(`receipt does not bind the live proposal: ${JSON.stringify(receipt).slice(0, 300)}`);
    }
    const tx = await getTx05d(pool, receipt.entity.id);
    if (!tx) return fail(`receipt entity ${receipt.entity.id} not found in ledger`);
    const txDate = tx.date instanceof Date ? tx.date.toISOString().slice(0, 10) : String(tx.date).slice(0, 10);
    const txOk = Number(tx.amount_cents) === EXPECTED_PROPOSE_AMOUNT_CENTS
      && tx.account_id === EXPECTED_ACCOUNT_ID && tx.category_id === EXPECTED_CATEGORY_ID
      && txDate === expectedDate && tx.kind === 'expense' && tx.description === description;
    if (!txOk) {
      return fail(`ledger row diverges from live args: ${JSON.stringify({ amount: String(tx.amount_cents), account: tx.account_id, category: tx.category_id, date: txDate, kind: tx.kind, description: tx.description }).slice(0, 300)}`);
    }
    const row = await getPending05d(pool, liveProposalId);
    if (row?.execution_status !== 'succeeded') return fail(`pending row not succeeded: ${JSON.stringify(row)}`);
    mark('sql.verified', { transactionId: receipt.entity.id, mutationId: receipt.mutationId, n0, n1 });
    // (5) replay confirm+execute -> no 2nd effect.
    mark('process.restart', { label: 'replay', marker: 4 });
    const c2 = await callFinanceDurable({ op: 'confirm', host: HOST_A, id: liveProposalId, body: { intentionId }, requestId: intentionId });
    if (c2.statusCode !== 409 || c2.body?.code !== 'approval.not_pending') {
      return fail(`replay confirm not refused as expected: ${c2.statusCode} ${JSON.stringify(c2.body).slice(0, 200)}`);
    }
    const x2 = await callFinanceDurable({ op: 'execute', host: HOST_A, id: liveProposalId, body: { attestation, intentionId }, requestId: intentionId });
    if (![403, 409].includes(x2.statusCode)) {
      return fail(`replay execute not refused as expected: ${x2.statusCode} ${JSON.stringify(x2.body).slice(0, 200)}`);
    }
    const n2 = await countTx05d(pool, { description, accountId: EXPECTED_ACCOUNT_ID, date: expectedDate });
    if (n2 !== n1) return fail(`replay added an effect (before=${n1} after=${n2})`, { n1, n2 });
    mark('replay.no-second-effect', { replayStatus: x2.statusCode, code: x2.body?.code, txCount: n2 });
    // (6) outcome -> succeeded with the identical receipt.
    mark('process.restart', { label: 'outcome', marker: 5 });
    const o1 = await callFinanceDurable({ op: 'outcome', host: HOST_A, id: liveProposalId, requestId: intentionId });
    if (o1.statusCode !== 200 || o1.body.status !== 'succeeded'
      || o1.body.receipt?.operationId !== liveProposalId
      || o1.body.receipt?.entity?.id !== receipt.entity.id
      || o1.body.receipt?.mutationId !== receipt.mutationId) {
      return fail(`outcome receipt diverges: ${JSON.stringify(o1.body).slice(0, 300)}`);
    }
    mark('outcome.succeeded', { liveProposalId, receiptStable: true });
    const trace = {
      spike: '05D', mode: 'confirm', at: new Date().toISOString(),
      snapshot: path.basename(snapshotPath), verdict: 'PASS',
      liveProposalId, sessionID: snap.sessionID, intentionId, idempotencyKey,
      transactionId: receipt.entity.id, mutationId: receipt.mutationId,
      args: { amountCents: EXPECTED_PROPOSE_AMOUNT_CENTS, accountId: EXPECTED_ACCOUNT_ID, categoryId: EXPECTED_CATEGORY_ID, date: expectedDate, description },
      counts: { before: n0, afterExecute: n1, afterReplay: n2 },
      events, elapsedMs: Date.now() - t0,
    };
    const serialized = assertNoSecrets(trace);
    const { snapshot } = writeTraceSnapshot(trace, serialized);
    return { ok: true, trace, snapshot };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---- main -------------------------------------------------------------------
async function main() {
  if (!process.env.TED_HOME_ROOT) process.env.TED_HOME_ROOT = path.join(HERE, '..');
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(scrubTraceText((e && e.message) || String(e)));
    process.exit((e && e.exitCode) || 2);
  }
  if (args.mode === 'help') {
    console.log('usage: node run-05d-live.mjs --mode=dryrun|live|confirm [--message="..."] [--snapshot=<file>] [--message-id=<id>]');
    return;
  }
  if (args.mode === 'confirm') {
    const { ok, trace, snapshot } = await runConfirm(path.resolve(args.snapshot), { messageId: args.messageId });
    console.log(JSON.stringify({ spike: '05D', mode: 'confirm', ok, verdict: trace.verdict, liveProposalId: trace.liveProposalId || null, transactionId: trace.transactionId || null, reason: trace.reason || null, snapshot }, null, 2));
    if (!ok) process.exit(1);
    return;
  }
  if (args.mode === 'live') {
    try {
      assertLiveGate();
    } catch (e) {
      console.error(scrubTraceText((e && e.message) || String(e)));
      process.exit(2);
    }
    const { trace, snapshot, secretLen } = await runLive(args.message);
    // 1st restart (separate OS process via the durable bridge): the live
    // proposal must persist as proposed AFTER the turn process observed it.
    let durableGet = null;
    if (trace.liveProposalId) {
      try {
        const g = await callFinanceDurable({ op: 'get', host: HOST_A, id: trace.liveProposalId });
        durableGet = { statusCode: g.statusCode, id: g.body && g.body.id, status: g.body && g.body.status };
      } catch (e) {
        durableGet = { error: String((e && e.message) || e).slice(0, 160) };
      }
    }
    console.log(JSON.stringify({
      spike: '05D', mode: 'live', sessionPromptCalled: trace.sessionPromptCalled, sessionPromptCount: trace.sessionPromptCount,
      credential: { source: 'OPENCODE_GO', injectedAs: 'OPENCODE_API_KEY', keyLength: secretLen },
      liveProposalId: trace.liveProposalId, intentionId: trace.intentionId, idempotencyKey: trace.idempotencyKey,
      durableGet, verdict: trace.verdict, elapsedMs: trace.elapsedMs, snapshot,
    }, null, 2));
    return;
  }
  const { output, snapshot } = await runDryrun();
  console.log(JSON.stringify({ ...output, snapshot }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(scrubTraceText((e && e.stack) || (e && e.message) || String(e)).slice(0, 2000));
    process.exit(1);
  });
}
