// SPIKE 05L runner — write-turn harness (propose_expense via prompt-loop nativo, DRYRUN default, LIVE opt-in).
//
// SCOPE: experiments/ted-runtime/bootstrap/run-05l-turn.mjs only (+ seu teste
// dryrun). NEVER touches apps/*, docs/*, .github/*, production, Cloudflare,
// Postgres real, PWA, or any .env. NEVER commits/pushes.
//
// DRYRUN (default): boots the isolated 05L home, writes the 05L allow-config,
// registers ted-finance NATIVELY via oc.plugin(), creates ONE session through
// the restricted 05L facade (auto-bind HOST_A), enumerates the effective
// surface (facade keys, plugin active, finance tools, catalog names ONLY),
// validates reads + propose DETERMINISTICALLY via the facade executors (real
// handlers, no inference), writes a sanitized trace, and EXITS WITHOUT
// session.prompt.
//
// LIVE (single turn): same setup + exactly ONE session.prompt call with the
// frozen 05L message (90s deadline, interrupt on overrun), then collects
// messages + events (tool name+args, sanitized results, tokens/usage/cost IF
// exposed, latency, step count), enforces the finance-only allowlist (any
// other tool => FAIL + interrupt, no retry), writes the sanitized trace to
// reports/SPIKE_05L_TRACE.json. LIVE refuses unless TED_05L_LIVE=1 (exit 2,
// no inference, no cost).
//
// RELATION TO 03B (frozen): this runner MIRRORS run-03b-turn.mjs structure
// (LIVE/DRYRUN gate, boot05L, enumerateEffective, facade parity, trace
// sanitization) but does NOT reuse nor widen FINANCE_TOOLS (03B verdict
// allowlist stays frozen at ['get_month_summary','list_accounts']). 05L owns
// FINANCE_TOOLS_05L = ['list_accounts','list_categories','propose_expense']
// with its own FACADE_KEYS_05L parity. get_month_summary is DELIBERATELY
// EXCLUDED from 05L: this turn needs accounts (resolve Nubank) + categories
// (resolve Mercado) + propose only; widening the write-turn surface with an
// unneeded read would expand blast radius for zero behavioral gain. If a
// future turn needs a summary read, it justifies a new allowlist revision —
// never a silent addition here.
//
// CONFIRMATION GATE: propose ONLY. No confirm/cancel/execute tool exists
// (TOOL_DEFS has none; transport allowlist has no confirm/outcome route;
// facade exposes none) and this runner never auto-confirms. Confirmation is
// a separate explicit CLI action (spike-05/scripts/confirm-cli.mjs).
//
// SECRETS: credential is read from D:/projetos/pi-financeiro/.env
// (OPENCODE_GO) in LIVE ONLY and injected SOLELY as OPENCODE_API_KEY in the
// isolated process env. Values are NEVER logged (only key length), NEVER
// written to the trace (assertNoSecrets scans before write).
//
// DATE RULE (frozen fixture synthetic-case-35-mercado.json):
// YESTERDAY_DYNAMIC_UTC — resolved at runtime via yesterdayUTC(); the harness
// records dateBaseUTC + expectedDateUTC and documents the America/Sao_Paulo
// divergence (UTC yesterday may differ ±1 day from Sao_Paulo wall date near
// midnight). Evaluation is posterior in America/Sao_Paulo; the harness NEVER
// freezes an absolute YYYY-MM-DD.
//
// COST (honest limitation): the OpenCode SDK may not return per-turn
// tokens/cost. The harness records latencyMs, step counts, and tokens/usage
// ONLY when exposed — otherwise it records the limitation explicitly (never
// assumes zero).
//
// SDK 2.2.4 facts pinned here (same as 03B, verified against installed .d.ts):
// - session.create({title, agent, model:{providerID, id}}); SessionPromptInput
//   has NO model/agent ({sessionID, text}).
// - provider.use policy resource is a PROVIDER ID; the single MODEL is pinned
//   at session create/switchModel (policy has no model granularity).
// - oc.tool is undefined in 2.2.4 (no tool catalog endpoint); the effective
//   tool proof is the native marker + TOOL_DEFS.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TOOL_DEFS, createToolExecutors, ToolError } from './ted-finance-tools.mjs';
import { callFinance, scrubSecrets, isRouteAllowlisted } from './finance-transport.mjs';
import { bindSession, isSameHost, resolveHost } from './session-bindings.mjs';
import { filterSessionsForHost } from './ted-gateway.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireHere = createRequire(path.join(HERE, 'run-identity.mjs'));

// Synthetic identity: actor A ONLY (seed standard). No B, no overrides.
export const HOST_A = Object.freeze({
  label: 'A',
  token: 'dev-token-1',
  household: 'HOUSEHOLD_A',
  actorId: 'dev-device-1',
  deviceId: 'dev-device-1',
});
export const IDENTITY_05L = '05l-a'; // home: <TED_HOME_ROOT>/.ted-home-05l-a
export const AGENT_05L = 'ted';
export const MODEL_PIN = Object.freeze({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
export const FINANCE_TOOLS_05L = Object.freeze(['list_accounts', 'list_categories', 'propose_expense']);
export const FACADE_KEYS_05L = Object.freeze([
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
export const DEFAULT_MESSAGE_05L = 'TED, gastei 35 reais no mercado ontem, pelo Nubank.';

// Suite-pinned expected values (seed.ts + 05L fixture): NEVER presumed
// schema — validators check field presence/types first, then compare.
export const EXPECTED_ACCOUNTS_A = Object.freeze([
  { name: 'Itaú', balanceCents: 100000 },
  { name: 'Nubank', balanceCents: 50000 },
]);
export const EXPECTED_CATEGORY_MERCADO = Object.freeze({
  id: '22222222-2222-4222-8222-222222222221',
  name: 'Mercado',
  kind: 'expense',
});
export const EXPECTED_PROPOSE_AMOUNT_CENTS = 3500;
export const SECRET_PATTERNS = [/dev-token-\d/g, /boom-token/g, /not-a-real-token/g];

// ---- hardening helpers (pure/testable, no inference) -----------------------
// P2-binding (fail-closed): getSession/removeSession REQUIRE an existing
// binding for the SAME host. Unknown IDs (no binding) => host_context_required
// (never fall through to the SDK row). Divergent host => host_binding_mismatch.
// Revoked/expired => typed resolveHost error (never the row).
export function requireBoundHost(sessionID, bound) {
  const host = resolveHost(sessionID);
  if (!isSameHost(host, bound)) {
    throw new ToolError('host_binding_mismatch', 'session is bound to a different host — blocked (nothing returned, nothing removed, nothing revoked)');
  }
  return host;
}

// P1-steps (honest counting, best-effort enforcement): the SDK exposes no
// reliable pre-execution step signal in 2.2.4, so MAX_INTERNAL_STEPS is a
// POST-OBSERVATION abort (poll loop + final tally), NOT a claimed preemptive
// enforcement. Steps = assistant/agent messages observed via message.list;
// events corroborate tool activity but do not define the budget.
export function countSteps(messages, events) {
  const msgs = Array.isArray(messages) ? messages : [];
  const assistantCount = msgs.filter((m) => m && (m.role === 'assistant' || m.role === 'agent')).length;
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

// P1-timeout (testable deadline+interrupt): races promptFn against timeoutMs,
// calls interruptFn EXACTLY ONCE on timeout, and reports whether the
// enforcement was confirmable. When interruptFn is absent/throws, the caller
// MUST record an enforcement failure (never assume the turn stopped).
// MEDIUM-fix: interrupt itself gets its own short deadline (default 5s) via
// withDeadline/interruptWithDeadline so a hung session.interrupt() can never
// wedge the runner without a trace (prompt path + polling-deadline path).
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

export const INTERRUPT_TIMEOUT_MS = 5000;

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
  // MEDIUM-fix: interrupt itself gets its own short deadline (default 5s) so a
  // hung session.interrupt() can never wedge the runner without a trace.
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

// LIVE abort paths (foreign-tool + step-budget) share this helper so both get
// the SAME enforcement semantics as the prompt/polling paths: the interrupt
// itself runs under its own short deadline (default INTERRUPT_TIMEOUT_MS=5s)
// via interruptWithDeadline, failures land in enforcementFailures (never
// silently swallowed), and the helper ALWAYS resolves so finishLive is reached
// even when session.interrupt() hangs or is unavailable.
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

// MEDIUM-polling (testable deadline wrapper): message.list() NEVER runs
// unbounded — each poll races against its own short deadline (default
// POLL_TIMEOUT_MS=15s, capped by the remaining 90s global budget). On
// timeout the caller MUST record an enforcement failure, attempt
// interruptWithDeadline CAPPED to the remaining global budget
// (min(interruptTimeoutMs, deadlineTs-now); skipped with an explicit
// no-budget overrun record when nothing remains), and proceed to
// finalization (never spin forever).
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
      // MEDIUM-fix: the poll-timeout interrupt is capped to the remaining
      // global budget so finalization cannot slide a full 5s past the 90s
      // deadline. With no budget left the interrupt is skipped (never awaited)
      // and the overrun is recorded explicitly.
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

// HIGH-pre-exec residual (inherited 03B PASS limitation): SDK 2.2.4 has NO
// total pre-execution gate on the codemode execute wrapper (hook input is
// {code:string}; the finance target resolves only after execution, so target
// validation in-hook is impossible). 05L mitigation: config denies
// (shell/edit/write/subagent + provider deny-all) + facade without
// shell/prompt + immediate interrupt + journey abort on first foreign
// observation + propose-only (no confirm/cancel/execute route or tool; CLI
// confirm is a separate explicit action). Total prevention is NOT claimed.
export const PRE_EXEC_LIMITATION = Object.freeze({
  enforced: false,
  inheritedFrom: '03B PASS',
  reason: '2.2.4 codemode execute wrapper has no total pre-execution gate (hook sees {code:string}; finance target resolves post-execution)',
  mitigation: 'config denies + facade without shell/prompt + immediate interrupt + abort on first foreign observation + propose-only (no confirm/cancel/execute; CLI confirm separate)',
});

// MEDIUM-cost ceiling (operational, not a provider guarantee): US$5 is
// enforced BY THE HARNESS (exactly 1 session.prompt + 90s deadline + ≤4
// internal steps + no retry/fallback), NOT by a meter. SDK tokens/cost are
// recorded ONLY when exposed — otherwise declared unknown (never zero).
export const COST_CEILING_NOTE = 'US$5 operational ceiling enforced by harness shape (1 prompt / 90s / ≤4 steps / single pinned model / no retry) — not a provider-billed guarantee; tokens/cost recorded only when SDK exposes them, otherwise unknown (never zero)';

// MEDIUM-polling operational margin (worst case): the per-poll list is capped
// to the remaining 90s budget and the poll-timeout interrupt is capped to
// min(5s, remaining-after-poll) — skipped outright when nothing remains. The
// pre-poll overrun path (deadline lapses between polls) still awaits one
// bounded ≤5s interrupt, so finalization may land up to ~5s past the 90s
// deadline there; that margin is operational (bounded interrupt + recorded
// overrunMs), never an unbounded hang.
export const POLLING_DEADLINE_NOTE = 'worst-case 90s+≤5s operational margin: poll list capped to remaining budget, poll-timeout interrupt capped to min(5s, remaining) / skipped with explicit overrun when none remains; pre-poll overrun path awaits one bounded ≤5s interrupt — finalization always reached with deadlineInterrupt + overrunMs recorded';

// ---- date helpers (pure) ----------------------------------------------------
// YESTERDAY_DYNAMIC_UTC per frozen fixture. evaluationTz documents the
// posterior evaluation zone; the harness never freezes YYYY-MM-DD.
export function yesterdayUTC(nowMs = Date.now()) {
  return new Date(nowMs - 24 * 3600 * 1000).toISOString().slice(0, 10);
}
export const EVALUATION_TZ = 'America/Sao_Paulo';
export const TZ_DIVERGENCE_NOTE =
  'expectedDateUTC is UTC-yesterday; posterior evaluation runs in America/Sao_Paulo — near midnight the Sao_Paulo wall date may differ ±1 day. Accept UTC-yesterday OR Sao_Paulo-yesterday; never freeze an absolute date.';

export function tedHomeRoot() {
  const root = process.env.TED_HOME_ROOT;
  if (!root) throw new Error('TED_HOME_ROOT not set (must point at experiments/ted-runtime)');
  return root;
}

export function tracePath() {
  return path.join(tedHomeRoot(), 'reports', 'SPIKE_05L_TRACE.json');
}

// Immutable per-run snapshots: every write also lands in a timestamped file
// (SPIKE_05L_TRACE_<mode>_<at>.json) that is NEVER overwritten — the `latest`
// file above stays for harness/test compat, but live evidence can no longer
// be clobbered by a later dryrun writing to the same path (05L-HIGH finding:
// the live trace was lost exactly this way). On timestamp collision the
// second write gets a -2/-3 suffix instead of overwriting.
export function traceTimestampedPath(mode, atIso) {
  const safe = String(atIso || new Date().toISOString()).replace(/[:.]/g, '-');
  return path.join(tedHomeRoot(), 'reports', `SPIKE_05L_TRACE_${mode}_${safe}.json`);
}

export function writeTraceFiles(traceObj, serialized) {
  const body = String(serialized).endsWith('\n') ? String(serialized) : `${serialized}\n`;
  fs.mkdirSync(path.dirname(tracePath()), { recursive: true });
  fs.writeFileSync(tracePath(), body, { encoding: 'utf8' });
  let snapshot = traceTimestampedPath(traceObj.mode, traceObj.at);
  if (fs.existsSync(snapshot)) {
    const base = snapshot.replace(/\.json$/, '');
    let i = 2;
    while (fs.existsSync(`${base}-${i}.json`)) i += 1;
    snapshot = `${base}-${i}.json`;
  }
  fs.writeFileSync(snapshot, body, { encoding: 'utf8' });
  return { latest: tracePath(), snapshot };
}

// ---- CLI parsing (pure) ----------------------------------------------------
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
  let message = DEFAULT_MESSAGE_05L;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--mode' && i + 1 < argv.length) mode = argv[++i];
    else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length);
    else if (a === '--message' && i + 1 < argv.length) message = argv[++i];
    else if (a.startsWith('--message=')) message = a.slice('--message='.length);
    else if (a === '--help' || a === '-h') return { mode: 'help', message };
  }
  if (mode !== 'dryrun' && mode !== 'live') {
    throw Object.assign(new Error(`usage: node run-05l-turn.mjs --mode=dryrun|live [--message="..."] (got mode=${JSON.stringify(mode)})`), { exitCode: 2 });
  }
  if (typeof message !== 'string' || message.length === 0 || message.length > 2000) {
    throw Object.assign(new Error('refused: --message must be a non-empty string (<=2000 chars)'), { exitCode: 2 });
  }
  return { mode, message };
}

// ---- 05L config (pure) -----------------------------------------------------
// Mirrors 03B: every deny kept, single provider allow for the one pinned
// model. Admin tools (shell/edit/write/subagent) denied; finance tools have
// no tool.use deny (resource naming unverified — speculative deny could block
// the finance tools themselves; enforcement is host-binding + runner abort).
export function build05LConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    agents: {
      [AGENT_05L]: {
        mode: 'primary',
        description: 'TED 05L synthetic experiment agent (no admin tools; propose-only write)',
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

export function write05LConfig(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify(build05LConfig(), null, 2) + '\n', { encoding: 'utf8' });
  return file;
}

// ---- validators (pure) -----------------------------------------------------
export function validateAccounts(body) {
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
  if (!rows) return { ok: false, details: { shape: 'expected array or {items:[]}' } };
  const missing = [];
  for (const exp of EXPECTED_ACCOUNTS_A) {
    const hit = rows.find((r) => r && r.name === exp.name && r.balanceCents === exp.balanceCents);
    if (!hit) missing.push(`${exp.name}:${exp.balanceCents}`);
  }
  return {
    ok: missing.length === 0,
    details: { count: rows.length, names: rows.map((r) => r && r.name).filter(Boolean).slice(0, 20), missing },
  };
}

export function validateCategories(body, { kind = 'expense' } = {}) {
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
  if (!rows) return { ok: false, details: { shape: 'expected array or {items:[]}' } };
  const hit = rows.find((c) => c && c.name === EXPECTED_CATEGORY_MERCADO.name && c.id === EXPECTED_CATEGORY_MERCADO.id);
  const kindOk = kind ? rows.every((c) => !c.kind || c.kind === kind || kind === 'any') : true;
  const strictKind = kind === 'any' ? true : rows.every((c) => c.kind === kind);
  return {
    ok: Boolean(hit) && strictKind,
    details: {
      count: rows.length,
      names: rows.map((c) => c && c.name).filter(Boolean).slice(0, 20),
      mercadoFound: Boolean(hit),
      kindOk: strictKind,
      _kindOkDetail: kindOk,
    },
  };
}

// Deterministic propose validator: the proposal must carry the ids resolved
// VIA the reads above (never invented), the 35-reais amount, and a dynamic
// yesterday date (UTC or Sao_Paulo — see TZ note).
export function validatePropose(body, { accountId, categoryId, expectedDateUTC }) {
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
  const accountOk = norm.accountId === accountId;
  const categoryOk = norm.categoryId === categoryId;
  // Date: accept UTC-yesterday or Sao_Paulo-yesterday (posterior evaluation
  // zone). Compute Sao_Paulo yesterday via Intl parts (no frozen absolute).
  let spYesterday = null;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: EVALUATION_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = Object.fromEntries(fmt.formatToParts(Date.now() - 24 * 3600 * 1000).map((p) => [p.type, p.value]));
    spYesterday = `${parts.year}-${parts.month}-${parts.day}`;
  } catch { spYesterday = null; }
  const dateOk = norm.date === expectedDateUTC || (spYesterday !== null && norm.date === spYesterday);
  details.dateCheck = { observed: norm.date, expectedDateUTC, spYesterday, tzNote: TZ_DIVERGENCE_NOTE };
  const toolOk = !body.tool || body.tool === 'transactions.expense.create';
  const ok = amountOk && accountOk && categoryOk && dateOk && toolOk;
  return { ok, details: { ...details, amountOk, accountOk, categoryOk, dateOk, toolOk } };
}

// ---- trace sanitization (pure) --------------------------------------------
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

// ---- verdict scaffold (pure) ----------------------------------------------
const B_KEYS = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08'];
export function emptyVerdict() {
  const v = {};
  for (const k of B_KEYS) v[k] = { status: 'not-exercised', reason: '' };
  return v;
}

// ---- LIVE gate + credential (no inference here) ----------------------------
export function assertLiveGate(env = process.env) {
  if (env.TED_05L_LIVE !== '1') {
    throw Object.assign(
      new Error('refused: LIVE turn requires TED_05L_LIVE=1 (accidental-inference lock; dryrun is the default)'),
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

// ---- boot: isolated env + 05L config + native plugin + facade --------------
export async function boot05L() {
  process.env.TED_HOME_ROOT = path.resolve(tedHomeRoot());
  const { setupIsolation } = requireHere('./env.cjs');
  const iso = setupIsolation(IDENTITY_05L);
  write05LConfig(iso.dirs.config);
  process.chdir(iso.dirs.workspace);

  const markerFile = path.join(iso.dirs.tmp, 'ted-05l-finance-loaded.json');
  try { fs.unlinkSync(markerFile); } catch { /* fresh proof per boot */ }
  process.env.TED_FINANCE_MARKER_FILE = markerFile;
  // HIGH-allowlist: restrict NATIVE registration to the exact 05L tools.
  // Unset => all TOOL_DEFS (03B frozen path — 03B never sets this var).
  process.env.TED_FINANCE_TOOLS_CSV = [...FINANCE_TOOLS_05L].join(',');

  const { OpenCode } = await import('@opencode/sdk');
  const oc = await OpenCode.create({
    config: { directory: iso.dirs.config, project: false },
    database: { path: iso.dirs.db },
  });

  const ted = (await import('./plugins/ted-finance/index.mjs')).default;
  await oc.plugin(ted);

  let marker = null;
  let tedEntry = null;
  for (let i = 0; i < 30; i++) {
    try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { marker = null; }
    try {
      const listed = await oc.plugin.list();
      const rows = (listed && listed.data) || [];
      tedEntry = rows.find((p) => (p.id || p.name) === 'ted-finance') || null;
    } catch { tedEntry = null; }
    if (marker && tedEntry && tedEntry.state && tedEntry.state.status === 'active') break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const executors = createToolExecutors(callFinance);
  const bound = Object.freeze({ ...HOST_A });
  const newIntention = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const facade = {
    createSession: async (title) => {
      const s = await oc.session.create({ title: title || 'ted-05l' });
      bindSession(s.id, bound);
      return s;
    },
    getSession: async (sessionID) => {
      // P2 fail-closed: unknown IDs (no binding) throw host_context_required
      // via requireBoundHost — never fall through to the SDK row.
      requireBoundHost(sessionID, bound);
      return oc.session.get({ sessionID });
    },
    listSessions: async () => filterSessionsForHost(await oc.session.list(), bound),
    removeSession: async (sessionID) => {
      // P2 fail-closed: unknown IDs (no binding) throw host_context_required
      // via requireBoundHost — never remove-or-revoke blindly.
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
    // 05L finance surface: reads resolve ids, propose consumes them. NO
    // get_month_summary (excluded by allowlist decision above), NO
    // confirm/cancel/execute (no such tool exists anywhere in this spike).
    list_accounts: (args, opts) => executors.list_accounts(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
    list_categories: (args, opts) => executors.list_categories(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
    propose_expense: (args, opts) => executors.propose_expense(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
  };
  const keys = Object.keys(facade).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...FACADE_KEYS_05L].sort())) {
    throw new Error(`facade surface drift: ${keys.join(',')}`);
  }
  return { oc, facade: Object.freeze(facade), iso, markerFile, marker: () => marker, tedEntry: () => tedEntry };
}

// Local helper (03B also defines filterSessionsForHost inline via gateway;

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
  const tedEntry = rows.find((p) => (p.id || p.name) === 'ted-finance') || null;
  const financeTools = Array.isArray(marker && marker.tools) ? [...marker.tools].sort() : [];
  // 2.2.4 native reality: ctx.tool.transform ADDS to the built-in catalog —
  // the effective model-visible surface is a SUPERSET (built-ins + finance).
  // Config denies + the LIVE foreign-tool abort are the enforcement points.
  const financeToolsPresent = FINANCE_TOOLS_05L.every((t) => financeTools.includes(t));
  // HIGH-allowlist exact-only is evaluated over the FINANCE SUBSET of the
  // native catalog (known TOOL_DEFS names), NOT the full catalog: 2.2.4
  // transform() ADDS to the built-in catalog, so the full list is always a
  // superset. Exact-only = of the finance tools natively registered, exactly
  // the 3 allowlisted (CSV gate) — get_month_summary or any other finance
  // tool present => gate fails (silent widening refused).
  const knownFinance = TOOL_DEFS.map((d) => d.name);
  const financeSubset = financeTools.filter((t) => knownFinance.includes(t)).sort();
  return {
    facadeKeys: keys,
    facadeKeysMatch: JSON.stringify(keys) === JSON.stringify([...FACADE_KEYS_05L].sort()),
    pluginListed: rows.map((p) => String(p.id || p.name)).slice(0, 120),
    tedFinance: tedEntry ? { id: tedEntry.id || tedEntry.name, state: tedEntry.state } : null,
    tedFinanceActive: Boolean(tedEntry && tedEntry.state && tedEntry.state.status === 'active'),
    financeToolsNative: financeTools,
    financeToolsPresent,
    financeToolsSubset: financeSubset,
    financeToolsExactOnly: JSON.stringify(financeSubset) === JSON.stringify([...FINANCE_TOOLS_05L].sort()),
    nativeSupersetNote: 'transform() adds to the built-in catalog (full native list is a superset); exact-only is evaluated over the finance subset (TOOL_DEFS names); enforcement = config denies + LIVE foreign-tool abort (B02/B06)',
    catalogs,
    hasToolCatalog: catalogs.hasToolCatalog === true,
  };
}

// ---- DRYRUN -----------------------------------------------------------------
export async function runDryrun() {
  const t0 = Date.now();
  const verdict = emptyVerdict();
  const dateBaseUTC = new Date(t0).toISOString().slice(0, 10);
  const expectedDateUTC = yesterdayUTC(t0);
  const boot = await boot05L();
  try {
    const eff = await enumerateEffective(boot);
    verdict.B01 = eff.facadeKeysMatch && eff.tedFinanceActive && eff.financeToolsExactOnly
      ? { status: 'pass', reason: 'facade 8 keys (05L) + ted-finance active + EXACT-ONLY finance tools (CSV gate: no more, no fewer; built-in superset recorded, enforcement via denies+abort)' }
      : { status: 'fail', reason: `surface mismatch keys=${eff.facadeKeysMatch} active=${eff.tedFinanceActive} exactOnly=${eff.financeToolsExactOnly} finance=${JSON.stringify(eff.financeToolsNative).slice(0, 160)}` };

    const exposedBeyondSdk = [];
    verdict.B02 = { status: 'not-exercised', reason: 'prompt-loop untested by design (no inference); LIVE aborts on any non-finance tool call' };

    // Deterministic finance validation via the REAL handlers (tool path, no LLM):
    // reads resolve ids -> propose consumes the LISTED ids (never invented).
    const session = await boot.facade.createSession('05l-dryrun');
    let accountsCheck = { ok: false, details: {} };
    let categoriesCheck = { ok: false, details: {} };
    let proposeCheck = { ok: false, details: {} };
    let resolved = { accountId: null, categoryId: null };
    try {
      const accounts = await boot.facade.list_accounts({});
      accountsCheck = validateAccounts(accounts);
      const rows = Array.isArray(accounts) ? accounts : accounts.items;
      const nubank = rows.find((r) => r && r.name === 'Nubank');
      const cats = await boot.facade.list_categories({ kind: 'expense' });
      categoriesCheck = validateCategories(cats, { kind: 'expense' });
      const crows = Array.isArray(cats) ? cats : cats.items;
      const mercado = crows.find((c) => c && c.name === EXPECTED_CATEGORY_MERCADO.name);
      resolved = { accountId: nubank && nubank.id, categoryId: mercado && mercado.id };
      if (nubank && mercado) {
        const proposed = await boot.facade.propose_expense({
          amountCents: EXPECTED_PROPOSE_AMOUNT_CENTS,
          description: 'mercado',
          date: expectedDateUTC,
          accountId: nubank.id,
          categoryId: mercado.id,
        });
        proposeCheck = validatePropose(proposed, { accountId: nubank.id, categoryId: mercado.id, expectedDateUTC });
      } else {
        proposeCheck = { ok: false, details: { resolved, reason: 'Nubank/Mercado not resolved from reads — propose refused (never invent ids)' } };
      }
    } finally {
      await boot.facade.removeSession(session.id).catch(() => {});
    }
    verdict.B04 = accountsCheck.ok && categoriesCheck.ok && proposeCheck.ok
      ? { status: 'pass', reason: `reads resolve Nubank+Mercado; propose carries listed ids @${expectedDateUTC} x${EXPECTED_PROPOSE_AMOUNT_CENTS}` }
      : { status: 'fail', reason: `deterministic mismatch: accounts=${JSON.stringify(accountsCheck.details).slice(0, 160)} categories=${JSON.stringify(categoriesCheck.details).slice(0, 160)} propose=${JSON.stringify(proposeCheck.details).slice(0, 200)}` };
    verdict.B03 = { status: 'pass', reason: 'host-bound facade: HOST_A frozen, no arg-identity (validateToolArgs rejects overrides)' };
    verdict.B05 = { status: 'pass', reason: 'A-only session, synthetic seed; isolation proven by 05L category-tool suite (A/B disjoint)' };
    verdict.B06 = { status: 'not-exercised', reason: 'no prompt in dryrun; LIVE aborts (no retry) on any non-finance tool call' };
    verdict.B08 = { status: 'not-exercised', reason: 'no prompt in dryrun; LIVE budget is 4 internal steps / 90s with interrupt' };

    const trace = {
      spike: '05L',
      mode: 'dryrun',
      at: new Date().toISOString(),
      identity: 'A-only',
      sessionPromptCalled: false,
      agent: AGENT_05L,
      model: { ...MODEL_PIN },
      config: build05LConfig(),
      financeAllowlist: [...FINANCE_TOOLS_05L],
      facadeKeys: [...FACADE_KEYS_05L],
      allowlistNote: 'get_month_summary deliberately excluded (unneeded read on a write turn); confirm/cancel/execute do not exist (propose-only; confirmation is a separate CLI action)',
      preExecGate: { ...PRE_EXEC_LIMITATION },
      stepsNote: `MAX_INTERNAL_STEPS=${MAX_INTERNAL_STEPS} is a best-effort post-observation abort (message.list tally + interrupt), not preemptive SDK enforcement`,
      dates: { dateBaseUTC, expectedDateUTC, evaluationTz: EVALUATION_TZ, tzNote: TZ_DIVERGENCE_NOTE },
      effective: eff,
      deterministicFinance: { accounts: accountsCheck, categories: categoriesCheck, propose: proposeCheck, resolved },
      exposedBeyondSdk,
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
    writeTraceFiles(trace, finalSerialized);
    return { trace, output: sanitizedSummary(trace) };
  } finally {
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
    catalogCounts: Object.fromEntries(
      Object.entries(trace.effective.catalogs || {}).map(([k, v]) => [k, v && typeof v.count === 'number' ? v.count : v]),
    ),
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

// ---- LIVE (single turn) -------------------------------------------------------
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

// Selection semantics: observed names must be exactly the 05L finance
// allowlist. Execution SUCCESS is tracked separately (per-call status;
// accuracy in B04). A finance call observed with status=error still counts
// as selected (B02 pass) while B04 fails.
export function summarizeSelection(calls) {
  const names = [...new Set(calls.map((c) => c.name))];
  const foreign = names.filter((n) => !FINANCE_TOOLS_05L.includes(n));
  const perTool = {};
  for (const t of FINANCE_TOOLS_05L) {
    const mine = calls.filter((c) => c.name === t);
    perTool[t] = { observed: mine.length > 0, count: mine.length, statuses: [...new Set(mine.map((c) => String(c.status || 'unknown')))] };
  }
  const readsObserved = perTool.list_accounts.observed && perTool.list_categories.observed;
  return { names, foreign, perTool, readsObserved, proposeObserved: perTool.propose_expense.observed };
}

// Best-effort extraction of propose RESULT data from NON-USER message texts.
export function validateLivePropose(messages, { expectedDateUTC }) {
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
  let proposed = null;
  for (const t of texts) {
    if (t.includes('transactions.expense.create') || (t.includes('normalizedArgs') && t.includes('amountCents'))) {
      const obj = firstJsonObjectWith(t, 'amountCents');
      if (obj) {
        const inner = obj && typeof obj === 'object' && 'value' in obj && obj.value && typeof obj.value === 'object' ? obj.value : obj;
        proposed = inner;
        break;
      }
    }
  }
  if (!proposed) return { ok: false, reason: 'no propose result data observed (transactions.expense.create/normalizedArgs)' };
  const norm = proposed.normalizedArgs || proposed.args || proposed;
  if (norm.amountCents !== EXPECTED_PROPOSE_AMOUNT_CENTS) {
    return { ok: false, reason: `propose amount mismatch (expected ${EXPECTED_PROPOSE_AMOUNT_CENTS}, observed ${JSON.stringify(norm.amountCents)})` };
  }
  if (typeof norm.accountId !== 'string' || typeof norm.categoryId !== 'string') {
    return { ok: false, reason: 'propose missing accountId/categoryId strings (ids must be resolved via reads, never invented)' };
  }
  return { ok: true, reason: `propose observed x${norm.amountCents} account+category resolved (date ${norm.date || 'n/a'} vs UTC-yesterday ${expectedDateUTC}; Sao_Paulo divergence documented)` };
}

function firstJsonObjectWith(text, marker) {
  const norm = String(text).replace(/\\"/g, '"').replace(/\\n/g, ' ');
  text = norm;
  let idx = 0;
  let attempts = 0;
  while (attempts < 24) {
    const at = text.indexOf(marker, idx);
    if (at < 0) return null;
    attempts += 1;
    const start = text.lastIndexOf('{', at);
    if (start < 0) { idx = at + marker.length; continue; }
    let depth = 0;
    for (let i = start; i < Math.min(text.length, start + 20000); i++) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed && typeof parsed === 'object') {
              if ('amountCents' in parsed || 'normalizedArgs' in parsed) return parsed;
              const vals = Object.values(parsed);
              for (const v of vals) {
                if (v && typeof v === 'object' && ('amountCents' in v || 'normalizedArgs' in v)) return v;
                if (v && typeof v === 'object' && 'value' in v && v.value && typeof v.value === 'object'
                  && ('amountCents' in v.value || 'normalizedArgs' in v.value)) return v.value;
              }
            }
          } catch { /* keep scanning */ }
          break;
        }
      }
    }
    idx = at + marker.length;
  }
  return null;
}

export function lastAssistantText(messages) {
  const ordered = [...(messages || [])].sort((a, b) => {
    const ta = a && a.time && typeof a.time.created === 'number' ? a.time.created : Number.POSITIVE_INFINITY;
    const tb = b && b.time && typeof b.time.created === 'number' ? b.time.created : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
  const partTexts = [];
  for (const m of ordered) {
    if (!m || m.role === 'user') continue;
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

export async function runLive(message) {
  assertLiveGate();
  const { secret } = loadLiveCredential();
  const t0 = Date.now();
  const dateBaseUTC = new Date(t0).toISOString().slice(0, 10);
  const expectedDateUTC = yesterdayUTC(t0);
  const verdict = emptyVerdict();
  const boot = await boot05L();
  const events = [];
  let sessionID = null;
  try {
    const eff = await enumerateEffective(boot);
    if (!eff.tedFinanceActive || !eff.financeToolsExactOnly) {
      verdict.B01 = { status: 'fail', reason: `pre-inference surface mismatch — aborting before prompt (exactOnly=${eff.financeToolsExactOnly} finance=${JSON.stringify(eff.financeToolsNative).slice(0, 160)})` };
      return finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, aborted: 'pre-inference-surface', secret });
    }
    verdict.B01 = { status: 'pass', reason: 'pre-inference surface ok (facade 05L 8 + ted-finance active + finance EXACT-ONLY)' };

    const session = await boot.facade.createSession('05l-live-turn');
    sessionID = session.id;
    let pinned = [];
    try {
      if (typeof boot.oc.session.switchAgent === 'function') {
        await boot.oc.session.switchAgent({ sessionID, agent: AGENT_05L });
        pinned.push(`agent:${AGENT_05L}`);
      }
      if (typeof boot.oc.session.switchModel === 'function') {
        await boot.oc.session.switchModel({ sessionID, model: { ...MODEL_PIN } });
        pinned.push(`model:${MODEL_PIN.providerID}/${MODEL_PIN.id}`);
      }
    } catch (e) {
      return finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, aborted: `pin-failed:${String((e && e.message) || e).slice(0, 160)}`, secret });
    }
    // No model fallback, no semantic retry: single pinned model, single prompt.

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

    // P1-timeout: EXACTLY ONE session.prompt with deadline + explicit
    // interrupt on overrun. Enforcement failures (no interrupt fn / throw)
    // are recorded, never assumed. Polling below reuses the same deadline.
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
      // MEDIUM-cost: the 90s deadline is EXPLICIT — on overrun the harness
      // attempts interrupt (recorded) instead of silently detaching.
      if (now > deadline) {
        // Same race-deadline as promptWithDeadline: the polling interrupt
        // gets its own 5s deadline so a hung session.interrupt() cannot wedge
        // finalization; failures are recorded in enforcementFailures.
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
      // MEDIUM-polling: message.list() runs under its own per-poll deadline
      // (POLL_TIMEOUT_MS capped by the remaining global budget) so a hung
      // poll can never wedge the runner. On timeout: enforcement failure is
      // recorded, interrupt is attempted CAPPED to the remaining budget
      // (skipped with explicit overrun when none remains), deadlineInterrupt
      // is propagated so the trace records it, and the loop breaks to
      // finalization.
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
      const assistantCount = steps.assistantCount;
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
    const statusNote = FINANCE_TOOLS_05L.map((t) => `${t}:${sel.perTool[t].observed ? sel.perTool[t].statuses.join('/') : 'not-observed'}`).join(',');
    const proposeObserved = sel.proposeObserved;
    verdict.B02 = sel.foreign.length === 0 && proposeObserved
      ? { status: 'pass', reason: `05L finance selection observed, no foreign tools (${statusNote})` }
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
    verdict.B07 = accuracy.ok && finalText.length > 0
      ? { status: 'pass', reason: 'propose evidence observed with grounded response text' }
      : { status: 'fail', reason: accuracy.ok ? 'no response text' : `propose unproven (${finalText.length > 0 ? 'response present but ungrounded' : 'no response text'})` };
    const finalSteps = countSteps(messages, events);
    const assistantCount = finalSteps.assistantCount;
    if (verdict.B08.status === 'not-exercised') {
      verdict.B08 = { status: !finalSteps.overBudget ? 'pass' : 'fail', reason: `steps=${assistantCount} eventTools=${finalSteps.eventToolCount} budget=${MAX_INTERNAL_STEPS} latencyMs=${Date.now() - t0} (best-effort post-observation, not preemptive)` };
    }
    return finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, pinned, promptError, promptTimeout, messages, toolCalls: calls, partTypes, deadlineInterrupt, enforcementFailures, secret, sessionPromptCalled: true, sessionPromptCount: 1 });
  } finally {
    await boot.oc.close().catch(() => {});
  }
}

function collectUsage(messages, events) {
  // Honest limitation: record tokens/usage/cost ONLY when the SDK exposes
  // them; otherwise declare the gap (never assume zero).
  const hay = JSON.stringify({ messages, events }).slice(0, 400000);
  const out = { exposed: false, detail: null };
  const m = hay.match(/"(tokens|usage|totalTokens|promptTokens|completionTokens|total_cost|cost)"\s*:\s*(\{[^}]{0,400}\}|[0-9.]+)/);
  if (m) {
    out.exposed = true;
    out.detail = m[0].slice(0, 400);
  } else {
    out.detail = 'sdk did not expose tokens/usage/cost in messages/events — latency + steps recorded; cost treated as unknown (ceiling US$5 / 1 model / ≤4 inferences / 90s enforced by harness, not by meter)';
  }
  return out;
}

export function finishLive(boot, { eff, verdict, events, sessionID, message, t0, dateBaseUTC, expectedDateUTC, pinned = [], promptError = null, promptTimeout = null, messages = [], toolCalls = [], partTypes = [], aborted = null, deadlineInterrupt = null, abortInterrupt = null, enforcementFailures = [], secret, sessionPromptCalled = false, sessionPromptCount = 0 }) {
  const clean = (v) => JSON.parse(scrubTraceText(JSON.stringify(v), secret ? [secret] : []));
  const usage = collectUsage(messages, events);
  const trace = {
    spike: '05L',
    mode: 'live',
    at: new Date().toISOString(),
    identity: 'A-only',
    sessionPromptCalled,
    sessionPromptCount,
    sessionID: typeof sessionID === 'string' ? sessionID : null,
    agent: AGENT_05L,
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
    financeAllowlist: [...FINANCE_TOOLS_05L],
    confirmationGate: 'propose-only: confirm/cancel/execute not exposed; no auto-confirmation performed',
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
  writeTraceFiles(trace, serialized);
  return { trace, secretLen: secret ? secret.length : 0 };
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
    console.log('usage: node run-05l-turn.mjs --mode=dryrun|live [--message="..."]');
    return;
  }
  if (args.mode === 'live') {
    try {
      assertLiveGate();
    } catch (e) {
      console.error(scrubTraceText((e && e.message) || String(e)));
      process.exit(2);
    }
    const { trace, secretLen } = await runLive(args.message);
    console.log(JSON.stringify({
      spike: '05L', mode: 'live', sessionPromptCalled: trace.sessionPromptCalled, sessionPromptCount: trace.sessionPromptCount,
      credential: { source: 'OPENCODE_GO', injectedAs: 'OPENCODE_API_KEY', keyLength: secretLen },
      verdict: trace.verdict, elapsedMs: trace.elapsedMs, traceFile: tracePath(),
    }, null, 2));
    return;
  }
  const { output } = await runDryrun();
  console.log(JSON.stringify(output, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(scrubTraceText((e && e.stack) || (e && e.message) || String(e)).slice(0, 2000));
    process.exit(1);
  });
}
