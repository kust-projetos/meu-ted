// SPIKE 03B runner — prompt-loop isolation probe (DRYRUN default, LIVE opt-in).
//
// SCOPE: experiments/ted-runtime only. NEVER touches apps/*, docs/*,
// .github/*, production, Cloudflare, or any .env. NEVER commits/pushes.
//
// DRYRUN (default): boots the isolated 03B home, writes the 03B allow-config,
// registers ted-finance NATIVELY via oc.plugin(), creates ONE session through
// the restricted facade (auto-bind HOST_A), enumerates the effective surface
// (facade keys, plugin active, finance tools, catalog names ONLY), validates
// finance values DETERMINISTICALLY via the facade executors (real handlers,
// no inference), writes a sanitized trace, and EXITS WITHOUT session.prompt.
//
// LIVE (single turn): same setup + exactly ONE session.prompt call with a
// 90s deadline (interrupt on overrun), then collects messages + session
// events (tool name+args, sanitized results, tokens/usage/cost if exposed,
// latency, step count), enforces the finance-only tool allowlist (any other
// tool => B02=FAIL + B06=FAIL + interrupt, no retry), writes the sanitized
// trace to reports/SPIKE_03B_TRACE.json, and returns a partial B01..B08
// verdict. LIVE refuses unless TED_03B_LIVE=1 (exit 2, no inference, no cost).
//
// SECRETS: credential is read from D:/projetos/pi-financeiro/.env
// (OPENCODE_GO) in LIVE ONLY and injected SOLELY as OPENCODE_API_KEY in the
// isolated process env. Values are NEVER logged (only key length), NEVER
// written to the trace (assertNoSecrets scans before write).
//
// SDK 2.2.4 facts pinned here (verified against installed .d.ts):
// - session.create({title, agent, model:{providerID, id}}) — agent/model live
//   on CREATE; SessionPromptInput has NO model/agent ({sessionID, text}).
// - session.switchAgent/switchModel exist for post-create pinning.
// - provider.use policy resource is a PROVIDER ID (schema ConfigPolicy doc),
//   so the 03B allow is `opencode-go`; the single MODEL is pinned at
//   session create/switchModel (policy has no model granularity).
// - oc.tool is undefined in 2.2.4 (no tool catalog endpoint); the effective
//   tool proof is the native ctx.tool.list marker + TOOL_DEFS.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { FACADE_KEYS, TOOL_DEFS, filterSessionsForHost } from './ted-gateway.mjs';
import { createToolExecutors, validateToolArgs, ToolError } from './ted-finance-tools.mjs';
import { callFinance, scrubSecrets, isRouteAllowlisted } from './finance-transport.mjs';
import { bindSession, getBinding, isSameHost } from './session-bindings.mjs';

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
export const IDENTITY_03B = '03b-a'; // home: <TED_HOME_ROOT>/.ted-home-03b-a
export const AGENT_03B = 'ted';
export const MODEL_PIN = Object.freeze({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
// P2 DECISION (SPIKE05L-FIX-P2, 2026-10-31): 03B is a FROZEN read-only turn
// (summary+accounts ONLY). FINANCE_TOOLS stays the 2-tool 03B verdict
// allowlist and is deliberately NOT extended: the list_categories facade
// wrapper below exists SOLELY for FACADE_KEYS parity (the drift check in
// boot03B/enumerateEffective must see the exact gateway surface), NOT as
// part of the 03B verdict. Consequence, intentional: summarizeSelection
// flags list_categories as FOREIGN in the 03B context, and a LIVE 03B turn
// that calls it aborts via B02/B06 — 03B must never call it (its live
// prompt asks summary+accounts only). B01 is unaffected: it gates on
// financeToolsPresent (SUBSET — both 03B tools natively registered), while
// financeToolsExactOnly=false is the recorded built-in-superset expectation,
// never a failure. The 05L harness (category tool + propose_expense)
// defines its OWN allowlist (e.g. FINANCE_TOOLS_05L incl. list_accounts +
// list_categories + propose_expense [+ get_month_summary optional]) with an
// explicit confirmation gate — it must NOT reuse or widen this frozen list.
export const FINANCE_TOOLS = Object.freeze(['get_month_summary', 'list_accounts']);
export const LIVE_TIMEOUT_MS = 90000;
export const MAX_INTERNAL_STEPS = 4;
export const DEFAULT_MESSAGE = 'Qual o resumo de junho de 2026 e quais contas eu tenho?';

// Suite-pinned expected values (spike-03a.test.mjs + seed.ts): NEVER presumed
// schema — validators below check field presence/types first, then compare.
export const EXPECTED_SUMMARY_A_JUNE = Object.freeze({
  yearMonth: '2026-06',
  incomeCents: 1200000,
  expenseCents: 288050,
  balanceCents: 911950,
  transactionCount: 4,
});
export const EXPECTED_ACCOUNTS_A = Object.freeze([
  { name: 'Itaú', balanceCents: 100000 },
  { name: 'Nubank', balanceCents: 50000 },
]);
export const SECRET_PATTERNS = [/dev-token-\d/g, /boom-token/g, /not-a-real-token/g];

export function tedHomeRoot() {
  const root = process.env.TED_HOME_ROOT;
  if (!root) throw new Error('TED_HOME_ROOT not set (must point at experiments/ted-runtime)');
  return root;
}

export function tracePath() {
  return path.join(tedHomeRoot(), 'reports', 'SPIKE_03B_TRACE.json');
}

// ---- CLI parsing (pure) ----------------------------------------------------
// Any host/route/method/token override attempt via args is refused HERE,
// before any boot. Identity is fixed to HOST_A; there is nothing to override.
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
  let message = DEFAULT_MESSAGE;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--mode' && i + 1 < argv.length) mode = argv[++i];
    else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length);
    else if (a === '--message' && i + 1 < argv.length) message = argv[++i];
    else if (a.startsWith('--message=')) message = a.slice('--message='.length);
    else if (a === '--help' || a === '-h') return { mode: 'help', message };
  }
  if (mode !== 'dryrun' && mode !== 'live') {
    throw Object.assign(new Error(`usage: node run-03b-turn.mjs --mode=dryrun|live [--message="..."] (got mode=${JSON.stringify(mode)})`), { exitCode: 2 });
  }
  if (typeof message !== 'string' || message.length === 0 || message.length > 2000) {
    throw Object.assign(new Error('refused: --message must be a non-empty string (<=2000 chars)'), { exitCode: 2 });
  }
  return { mode, message };
}

// ---- 03B config (pure) -----------------------------------------------------
// 03B delta vs bootstrap/ted-config.cjs (harness file, NOT modified): the
// legacy config denies provider.use `*` with NO allow (prompt-loop blocked);
// 03B keeps every deny and adds the SINGLE provider allow below so the one
// pinned model can run. No finance-tool deny exists in either config.
// P1 INVESTIGATION (2026-10-31, runtime 2.2.4): `tool.use` denies use the
// `prefix:*` resource shape (shell:*/edit:*/write:*/subagent:*); there is NO
// documented positive allowlist for custom tools (finance resource naming
// unverified — a speculative `tool.use:* deny` could block the finance tools
// themselves, so it is deliberately NOT added). Proven pre-execution point
// is the native `execute.before` hook in plugins/ted-finance (adapter.js:
// "Only execute.before may reject a call") — deny-by-default there, with
// config denies + runner abort as defense in depth. See plugin P1 block.
export function build03BConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    agents: {
      [AGENT_03B]: {
        mode: 'primary',
        description: 'TED 03B synthetic experiment agent (no admin tools)',
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

export function write03BConfig(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify(build03BConfig(), null, 2) + '\n', { encoding: 'utf8' });
  return file;
}

// ---- validators (pure) -----------------------------------------------------
export function validateSummary(body) {
  const details = {};
  if (!body || typeof body !== 'object') return { ok: false, details: { shape: 'not-an-object' } };
  for (const f of ['incomeCents', 'expenseCents', 'balanceCents', 'transactionCount']) {
    if (typeof body[f] !== 'number') return { ok: false, details: { [`${f}`]: `expected number, got ${typeof body[f]}` } };
    details[f] = body[f];
  }
  const exp = EXPECTED_SUMMARY_A_JUNE;
  const match = body.incomeCents === exp.incomeCents && body.expenseCents === exp.expenseCents
    && body.balanceCents === exp.balanceCents && body.transactionCount === exp.transactionCount;
  return { ok: match, details, expected: { ...exp } };
}

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
  if (env.TED_03B_LIVE !== '1') {
    throw Object.assign(
      new Error('refused: LIVE turn requires TED_03B_LIVE=1 (accidental-inference lock; dryrun is the default)'),
      { exitCode: 2 },
    );
  }
}

export function loadLiveCredential() {
  // Reads ONLY the key line; the value travels solely into process.env and
  // the trace-extraSecrets list (never into logs, outputs, or files).
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

// ---- boot: isolated env + 03B config + native plugin + facade --------------
// Composes the SAME exported primitives as ted-gateway.createTedEnvironment
// (which hardwires the legacy deny-all config writer — unsuitable for the
// single-model LIVE turn), then enforces surface parity against FACADE_KEYS.
export async function boot03B() {
  // Normalize BEFORE any chdir: a relative TED_HOME_ROOT (e.g. '..') would
  // otherwise resolve the sqlite db path against the workspace dir post-chdir.
  process.env.TED_HOME_ROOT = path.resolve(tedHomeRoot());
  const { setupIsolation } = requireHere('./env.cjs');
  const iso = setupIsolation(IDENTITY_03B);
  write03BConfig(iso.dirs.config);
  process.chdir(iso.dirs.workspace);

  const markerFile = path.join(iso.dirs.tmp, 'ted-03b-finance-loaded.json');
  try { fs.unlinkSync(markerFile); } catch { /* fresh proof per boot */ }
  process.env.TED_FINANCE_MARKER_FILE = markerFile;

  const { OpenCode } = await import('@opencode/sdk');
  const oc = await OpenCode.create({
    config: { directory: iso.dirs.config, project: false },
    database: { path: iso.dirs.db },
  });

  const ted = (await import('./plugins/ted-finance/index.mjs')).default;
  await oc.plugin(ted);

  // Native registration is async: poll the EFFECTIVE catalog until settled.
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
      const s = await oc.session.create({ title: title || 'ted-03b' });
      bindSession(s.id, bound);
      return s;
    },
    getSession: async (sessionID) => {
      const existing = getBinding(sessionID);
      if (existing && !isSameHost(existing.host, bound)) {
        throw new ToolError('host_binding_mismatch', 'session is bound to a different host — get blocked (nothing returned)');
      }
      return oc.session.get({ sessionID });
    },
    listSessions: async () => filterSessionsForHost(await oc.session.list(), bound),
    removeSession: async (sessionID) => {
      const existing = getBinding(sessionID);
      if (existing && !isSameHost(existing.host, bound)) {
        throw new ToolError('host_binding_mismatch', 'session is bound to a different host — remove blocked (nothing removed, nothing revoked)');
      }
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
    list_categories: (args, opts) => executors.list_categories(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }), // parity-only: see FINANCE_TOOLS P2 decision — NOT in the 03B verdict allowlist
    get_month_summary: (args, opts) => executors.get_month_summary(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
  };
  const keys = Object.keys(facade).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...FACADE_KEYS].sort())) {
    throw new Error(`facade surface drift: ${keys.join(',')}`);
  }
  return { oc, facade: Object.freeze(facade), iso, markerFile, marker: () => marker, tedEntry: () => tedEntry };
}

function summarize(promise) {
  return promise.then(
    (r) => {
      const data = r && r.data ? r.data : r;
      const ids = Array.isArray(data) ? data.map((d) => d.id || d.name) : [];
      // Catalogs carry NAMES ONLY — never credential values.
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
  // it does not replace it. The effective model-visible surface is therefore
  // a SUPERSET (built-ins shell/edit/write/subagent/… + our finance tools);
  // config denies + the LIVE foreign-tool abort are the enforcement points,
  // not catalog hiding. The check below is SUBSET (both finance tools
  // present), and the full native list is recorded (names only).
  const financeToolsPresent = FINANCE_TOOLS.every((t) => financeTools.includes(t));
  return {
    facadeKeys: keys,
    facadeKeysMatch: JSON.stringify(keys) === JSON.stringify([...FACADE_KEYS].sort()),
    pluginListed: rows.map((p) => String(p.id || p.name)).slice(0, 120),
    tedFinance: tedEntry ? { id: tedEntry.id || tedEntry.name, state: tedEntry.state } : null,
    tedFinanceActive: Boolean(tedEntry && tedEntry.state && tedEntry.state.status === 'active'),
    financeToolsNative: financeTools,
    financeToolsPresent,
    financeToolsExactOnly: JSON.stringify(financeTools) === JSON.stringify([...FINANCE_TOOLS].sort()),
    nativeSupersetNote: 'transform() adds to the built-in catalog; enforcement = config denies + LIVE foreign-tool abort (B02/B06)',
    catalogs,
    hasToolCatalog: catalogs.hasToolCatalog === true,
  };
}

// ---- DRYRUN -----------------------------------------------------------------
export async function runDryrun() {
  const t0 = Date.now();
  const verdict = emptyVerdict();
  const boot = await boot03B();
  try {
    const eff = await enumerateEffective(boot);
    verdict.B01 = eff.facadeKeysMatch && eff.tedFinanceActive && eff.financeToolsPresent
      ? { status: 'pass', reason: 'facade 8 keys + ted-finance active + finance tools natively registered (built-in superset recorded, enforcement via denies+abort)' }
      : { status: 'fail', reason: `surface mismatch keys=${eff.facadeKeysMatch} active=${eff.tedFinanceActive} financePresent=${eff.financeToolsPresent}` };

    // Tool-call surface BEFORE any inference: the native catalog is a
    // SUPERSET (built-ins + finance tools — recorded in trace.effective).
    // Shell/prompt/edit/subagent/mcp are NEVER invoked by this runner; the
    // model is constrained by config denies + the LIVE abort below.
    const exposedBeyondSdk = [];
    verdict.B02 = { status: 'not-exercised', reason: 'prompt-loop untested by design (no inference); LIVE aborts on any non-finance tool call' };

    // Deterministic finance validation via the REAL handlers (tool path, no LLM).
    const session = await boot.facade.createSession('03b-dryrun');
    let summaryCheck = { ok: false, details: {} };
    let accountsCheck = { ok: false, details: {} };
    try {
      const summary = await boot.facade.get_month_summary({ yearMonth: '2026-06' });
      summaryCheck = validateSummary(summary);
      const accounts = await boot.facade.list_accounts({});
      accountsCheck = validateAccounts(accounts);
    } finally {
      await boot.facade.removeSession(session.id).catch(() => {});
    }
    verdict.B04 = summaryCheck.ok
      ? { status: 'pass', reason: `A/2026-06 exact {1200000,288050,911950,4}` }
      : { status: 'fail', reason: `summary mismatch: ${JSON.stringify(summaryCheck.details).slice(0, 200)}` };
    verdict.B05 = accountsCheck.ok
      ? { status: 'pass', reason: 'Itaú 100000 + Nubank 50000 present' }
      : { status: 'fail', reason: `accounts mismatch: ${JSON.stringify(accountsCheck.details).slice(0, 200)}` };
    verdict.B03 = { status: 'pass', reason: 'host-bound facade: HOST_A frozen, no arg-identity (validateToolArgs rejects overrides)' };
    verdict.B06 = { status: 'not-exercised', reason: 'no prompt in dryrun; LIVE aborts (no retry) on any non-finance tool call' };
    verdict.B08 = { status: 'not-exercised', reason: 'no prompt in dryrun; LIVE budget is 4 internal steps / 90s with interrupt' };

    const trace = {
      spike: '03B',
      mode: 'dryrun',
      at: new Date().toISOString(),
      identity: 'A-only',
      sessionPromptCalled: false,
      agent: AGENT_03B,
      model: { ...MODEL_PIN },
      config: build03BConfig(),
      effective: eff,
      deterministicFinance: { summary: summaryCheck, accounts: accountsCheck },
      exposedBeyondSdk,
      verdict,
      elapsedMs: Date.now() - t0,
    };
    const serialized = assertNoSecrets(trace);
    verdict.B07 = scanSecrets(serialized).length === 0
      ? { status: 'pass', reason: 'trace carries zero token substrings (pre-write scan)' }
      : { status: 'fail', reason: 'secret scan hit' };
    trace.verdict = verdict;
    const finalSerialized = assertNoSecrets(trace);
    fs.mkdirSync(path.dirname(tracePath()), { recursive: true });
    fs.writeFileSync(tracePath(), finalSerialized + '\n', { encoding: 'utf8' });
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
      summaryOk: trace.deterministicFinance.summary.ok,
      accountsOk: trace.deterministicFinance.accounts.ok,
    },
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
    // 03B-T1: the model invokes finance tools THROUGH the codemode `execute`
    // wrapper (input.code calls tools.*); the native metadata.toolCalls array
    // records the inner finance invocations — surface them as first-class
    // calls so B02 reflects what was actually selected. The toolCalls subtree
    // is NOT recursed into (review P2: avoids double-counting the same
    // invocation via its .tool/.input fields).
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
      if (k === 'toolCalls') continue; // already surfaced above — no double count
      visit(v, depth + 1);
    }
  };
  visit(messages, 0);
  return { calls, partTypes: [...partTypes].slice(0, 30) };
}

// B02/B06 semantics (review P2): SELECTION/ALLOWLIST only — observed names
// must be exactly the finance allowlist. Execution SUCCESS is tracked
// separately (per-call status here, accuracy in B04). A finance call observed
// with status=error still counts as selected (B02 pass) while B04 fails.
export function summarizeSelection(calls) {
  const names = [...new Set(calls.map((c) => c.name))];
  const foreign = names.filter((n) => !FINANCE_TOOLS.includes(n));
  const perTool = {};
  for (const t of FINANCE_TOOLS) {
    const mine = calls.filter((c) => c.name === t);
    perTool[t] = { observed: mine.length > 0, count: mine.length, statuses: [...new Set(mine.map((c) => String(c.status || 'unknown')))] };
  }
  const bothObserved = FINANCE_TOOLS.every((t) => perTool[t].observed);
  return { names, foreign, perTool, bothObserved };
}

// Best-effort extraction of finance RESULT data from NON-USER message texts
// (review: user-role texts are never result evidence). The codemode wrapper
// returns {accounts, summary} JSON embedded as an ESCAPED string inside the
// message envelope, so scanning runs on a normalized copy (\" -> ") while
// parsing still validates strict JSON. Validates against the REAL expected
// values; never presumes schema.
export function validateLiveFinance(messages) {
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
  let summaryCheck = null;
  let accountsCheck = null;
  for (const t of texts) {
    if (!summaryCheck && t.includes('incomeCents')) {
      const obj = firstJsonObjectWith(t, 'incomeCents');
      if (obj) summaryCheck = validateSummary(obj);
    }
    if (!accountsCheck && t.includes('"items"')) {
      const obj = firstJsonObjectWith(t, '"items"');
      if (obj) {
        // Accept {items,total} envelope, bare array, or codemode
        // {status,value} wrapper around either.
        const inner = obj && typeof obj === 'object' && 'value' in obj ? obj.value : obj;
        accountsCheck = validateAccounts(inner);
      }
    }
    if (summaryCheck && accountsCheck) break;
  }
  if (summaryCheck && accountsCheck) {
    const ok = summaryCheck.ok && accountsCheck.ok;
    return { ok, reason: ok ? 'live results match exact expected values (summary + accounts)' : `mismatch summary=${JSON.stringify(summaryCheck.details).slice(0, 160)} accounts=${JSON.stringify(accountsCheck.details).slice(0, 160)}` };
  }
  const missing = [!summaryCheck && 'summary(incomeCents)', !accountsCheck && 'accounts(items)'].filter(Boolean).join(',');
  return { ok: false, reason: `no successful finance result data observed (${missing})` };
}

function firstJsonObjectWith(text, marker) {
  // T2: the result payload travels ESCAPED inside the message envelope
  // ({\"accounts\": ...}). Normalize a copy so the balanced scan + strict
  // JSON.parse below operate on real quotes/braces.
  const norm = String(text).replace(/\\"/g, '"').replace(/\\n/g, ' ');
  text = norm;
  // Scan balanced {} windows around each marker occurrence (bounded).
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
            // Unwrap codemode settled wrappers: {status,value} / {status,reason}.
            if (parsed && typeof parsed === 'object') {
              if ('incomeCents' in parsed) return parsed;
              if ('items' in parsed || Array.isArray(parsed)) return parsed;
              const vals = Object.values(parsed);
              for (const v of vals) {
                if (v && typeof v === 'object' && ('incomeCents' in v || 'items' in v || Array.isArray(v))) return v;
                if (v && typeof v === 'object' && 'value' in v && v.value && typeof v.value === 'object'
                  && ('incomeCents' in v.value || 'items' in v.value || Array.isArray(v.value))) return v.value;
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
  // 04L: message.list rows carry no top-level .role in the observed shape AND
  // arrive newest-first. The previous revision collected in wire order and
  // returned the last item, i.e. the OLDEST prose — usually the user question
  // (R vacuum in every live trace). Sort chronologically by time.created and
  // skip wire user-prompt rows ({text, type:'user'}), which carry no role.
  // Rows without timestamps keep relative order (stable sort) and sort AFTER
  // timestamped rows (review P2: a recent answer without timestamp must not
  // lose to an older timestamped row; wire rows always carry time.created).
  // No phrase logic: ordering + row shape only.
  const ordered = [...(messages || [])].sort((a, b) => {
    const ta = a && a.time && typeof a.time.created === 'number' ? a.time.created : Number.POSITIVE_INFINITY;
    const tb = b && b.time && typeof b.time.created === 'number' ? b.time.created : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
  // T3: message.list rows carry no top-level .role in the observed shape —
  // the final natural-language answer is the last non-user 'text' part that
  // is NOT tool JSON. Tool/reasoning parts are skipped by type; the user
  // prompt is skipped by role (or wire type 'user'); JSON blobs are skipped
  // by parseability.
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
  const { secret } = loadLiveCredential(); // value in-process only; len logged by main
  const t0 = Date.now();
  const verdict = emptyVerdict();
  const boot = await boot03B();
  const events = [];
  let sessionID = null;
  try {
    const eff = await enumerateEffective(boot);
    if (!eff.tedFinanceActive || !eff.financeToolsPresent) {
      verdict.B01 = { status: 'fail', reason: 'pre-inference surface mismatch — aborting before prompt' };
      return finishLive(boot, { eff, verdict, events, sessionID, message, t0, aborted: 'pre-inference-surface', secret });
    }
    verdict.B01 = { status: 'pass', reason: 'pre-inference surface ok (facade 8 + ted-finance active + finance-only)' };

    const session = await boot.facade.createSession('03b-live-turn');
    sessionID = session.id;
    // Pin agent + single model (prompt input carries neither in 2.2.4).
    let pinned = [];
    try {
      if (typeof boot.oc.session.switchAgent === 'function') {
        await boot.oc.session.switchAgent({ sessionID, agent: AGENT_03B });
        pinned.push(`agent:${AGENT_03B}`);
      }
      if (typeof boot.oc.session.switchModel === 'function') {
        await boot.oc.session.switchModel({ sessionID, model: { ...MODEL_PIN } });
        pinned.push(`model:${MODEL_PIN.providerID}/${MODEL_PIN.id}`);
      }
    } catch (e) {
      return finishLive(boot, { eff, verdict, events, sessionID, message, t0, aborted: `pin-failed:${String((e && e.message) || e).slice(0, 160)}`, secret });
    }

    const deadline = t0 + LIVE_TIMEOUT_MS;
    // Background event tap (best-effort; polling below is the driver).
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

    let promptError = null;
    try {
      await Promise.race([
        boot.oc.session.prompt({ sessionID, text: message }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('prompt-timeout-90s')), Math.max(1000, deadline - Date.now()))),
      ]);
    } catch (e) {
      promptError = String((e && e.message) || e).slice(0, 200);
    }

    // Poll messages until quiescence or deadline.
    let messages = [];
    let lastChange = Date.now();
    let lastSig = '';
    for (;;) {
      const now = Date.now();
      if (now > deadline) break;
      try {
        const res = await boot.oc.message.list({ sessionID });
        const rows = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);
        messages = rows;
      } catch (e) {
        events.push({ pollError: String((e && e.message) || e).slice(0, 160) });
      }
      const sig = JSON.stringify(messages).length + ':' + messages.length;
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
      const { calls } = extractToolCalls(messages);
      const selPoll = summarizeSelection(calls);
      if (selPoll.foreign.length > 0) {
        verdict.B02 = { status: 'fail', reason: `non-finance tool invoked: ${selPoll.foreign.join(',')}` };
        verdict.B06 = { status: 'fail', reason: 'allowlist breach — interrupted, no retry' };
        try { if (typeof boot.oc.session.interrupt === 'function') await boot.oc.session.interrupt({ sessionID }); } catch { /* best-effort */ }
        stopEvents = true;
        return finishLive(boot, { eff, verdict, events, sessionID, message, t0, pinned, promptError, messages, toolCalls: calls, aborted: 'foreign-tool', secret });
      }
      const assistantCount = messages.filter((m) => m && (m.role === 'assistant' || m.role === 'agent')).length;
      if (assistantCount > MAX_INTERNAL_STEPS) {
        verdict.B08 = { status: 'fail', reason: `>${MAX_INTERNAL_STEPS} internal steps — interrupted` };
        try { if (typeof boot.oc.session.interrupt === 'function') await boot.oc.session.interrupt({ sessionID }); } catch { /* best-effort */ }
        stopEvents = true;
        return finishLive(boot, { eff, verdict, events, sessionID, message, t0, pinned, promptError, messages, toolCalls: calls, aborted: 'step-budget', secret });
      }
      if (messages.length > 1 && Date.now() - lastChange > 6000) break; // quiescent
      if (promptError && messages.length <= 1 && Date.now() - t0 > 30000) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    stopEvents = true;

    const { calls, partTypes } = extractToolCalls(messages);
    const sel = summarizeSelection(calls);
    const statusNote = FINANCE_TOOLS.map((t) => `${t}:${sel.perTool[t].observed ? sel.perTool[t].statuses.join('/') : 'not-observed'}`).join(',');
    verdict.B02 = sel.foreign.length === 0 && sel.bothObserved
      ? { status: 'pass', reason: `both finance tools selected, no foreign tools (${statusNote})` }
      : { status: 'fail', reason: sel.foreign.length > 0 ? `non-finance tool invoked: ${sel.foreign.join(',')}` : `missing finance selection (${statusNote})` };
    verdict.B06 = sel.foreign.length === 0
      ? { status: 'pass', reason: 'allowlist-only surface observed (selection semantics); no admin tool invoked, no retry needed' }
      : { status: 'fail', reason: 'allowlist breach' };
    // B03: host context — fail on any binding/host error; pass when finance
    // calls reached the executor (running/success observed, never host-gated).
    const hayEvents = JSON.stringify(events).slice(0, 20000);
    const hostErr = /host_context_required|host_binding_mismatch|host_binding_revoked|host_binding_expired/.test(hayEvents);
    const reachedExecutor = calls.some((c) => ['running', 'success', 'completed', 'error'].includes(String(c.status)));
    verdict.B03 = hostErr
      ? { status: 'fail', reason: 'binding/host error observed in events' }
      : reachedExecutor
        ? { status: 'pass', reason: 'finance calls reached executor with host-bound context, no host errors' }
        : { status: 'fail', reason: 'no finance call reached the executor' };
    // B05: isolation — A-only session; fail if any B-identity data leaks in.
    const hayAll = (JSON.stringify(messages).slice(0, 60000) + hayEvents);
    verdict.B05 = /Bradesco|dev-token-2|HOUSEHOLD_B/.test(hayAll)
      ? { status: 'fail', reason: 'cross-identity (B) data observed' }
      : { status: 'pass', reason: 'A-only session, no B-identity data in messages/events' };
    // B04: financial accuracy — extract candidate result JSON from message
    // texts and validate against the REAL expected values (never presumed).
    // Review LOW: also require the observed get_month_summary call to carry
    // the expected period (payloads may omit yearMonth; the call must not).
    const accuracy = validateLiveFinance(messages);
    const periodOk = calls.some((c) => c.name === 'get_month_summary' && c.args && c.args.yearMonth === EXPECTED_SUMMARY_A_JUNE.yearMonth);
    verdict.B04 = accuracy.ok && periodOk
      ? { status: 'pass', reason: `${accuracy.reason}; period ${EXPECTED_SUMMARY_A_JUNE.yearMonth} pinned on the observed call` }
      : { status: 'fail', reason: !accuracy.ok ? accuracy.reason : `values match but period arg missing (expected ${EXPECTED_SUMMARY_A_JUNE.yearMonth})` };
    // B07: output — answers the request in natural language with exact values.
    const finalText = lastAssistantText(messages);
    verdict.B07 = accuracy.ok && finalText.length > 0
      ? { status: 'pass', reason: 'response carries exact validated values, no fabrication' }
      : { status: 'fail', reason: accuracy.ok ? 'no response text' : `request unanswered (honest-failure=${/não consegui|falharam|inventar/i.test(finalText)}); no values presented` };
    const assistantCount = messages.filter((m) => m && (m.role === 'assistant' || m.role === 'agent')).length;
    if (verdict.B08.status === 'not-exercised') {
      verdict.B08 = { status: assistantCount <= MAX_INTERNAL_STEPS ? 'pass' : 'fail', reason: `steps=${assistantCount} budget=${MAX_INTERNAL_STEPS} latencyMs=${Date.now() - t0}` };
    }
    return finishLive(boot, { eff, verdict, events, sessionID, message, t0, pinned, promptError, messages, toolCalls: calls, partTypes, secret });
  } finally {
    await boot.oc.close().catch(() => {});
  }
}

function finishLive(boot, { eff, verdict, events, sessionID, message, t0, pinned = [], promptError = null, messages = [], toolCalls = [], partTypes = [], aborted = null, secret }) {
  // Sanitize EVERYTHING model- or transport-shaped before the trace object.
  const clean = (v) => JSON.parse(scrubTraceText(JSON.stringify(v), secret ? [secret] : []));
  const trace = {
    spike: '03B',
    mode: 'live',
    at: new Date().toISOString(),
    identity: 'A-only',
    sessionPromptCalled: true,
    sessionID: typeof sessionID === 'string' ? sessionID : null,
    agent: AGENT_03B,
    model: { ...MODEL_PIN },
    pinned,
    message,
    promptError,
    aborted,
    effective: eff,
    toolCalls: clean(toolCalls.map((c) => ({ name: c.name, args: c.args, status: c.status || 'unknown', via: c.via || 'direct' }))),
    partTypes,
    messageCount: messages.length,
    messageExcerpt: clean(messages.map((m) => ({
      role: m && m.role,
      text: JSON.stringify(m && (m.parts || m.content || m.text || '')).slice(0, 2000),
    }))),
    events: clean(events),
    verdict,
    elapsedMs: Date.now() - t0,
  };
  const serialized = assertNoSecrets(trace, secret ? [secret] : []);
  fs.mkdirSync(path.dirname(tracePath()), { recursive: true });
  fs.writeFileSync(tracePath(), serialized + '\n', { encoding: 'utf8' });
  return { trace, secretLen: secret ? secret.length : 0 };
}

// ---- main -------------------------------------------------------------------
async function main() {
  // CLI default: TED_HOME_ROOT = the experiments/ted-runtime dir owning this
  // bootstrap (explicit env wins; tests set it to the same value).
  if (!process.env.TED_HOME_ROOT) process.env.TED_HOME_ROOT = path.join(HERE, '..');
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(scrubTraceText((e && e.message) || String(e)));
    process.exit((e && e.exitCode) || 2);
  }
  if (args.mode === 'help') {
    console.log('usage: node run-03b-turn.mjs --mode=dryrun|live [--message="..."]');
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
      spike: '03B', mode: 'live', sessionPromptCalled: true,
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
