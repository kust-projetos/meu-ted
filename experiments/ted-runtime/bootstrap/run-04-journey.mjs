// SPIKE 04 journey runner — MULTI-TURN prompt-loop probe (DRYRUN default, LIVE opt-in).
//
// SCOPE: experiments/ted-runtime only. NEVER touches apps/*, docs/*,
// .github/*, production, Cloudflare, or any .env. NEVER commits/pushes.
//
// What this runner IS: a GENERIC multi-turn loop with NO interpretation of
// user phrases. It NEVER maps text -> tools (no router, no regex over test
// phrases, no keyword dispatch). Per-turn expectations (which tools + which
// oracle values) travel EXPLICITLY in the turn definition supplied by the
// caller (`expectTools`, `expectSummary`, `expectAccounts`); the runner only
// observes what the model actually selected/called/answered and grades
// understanding / execution / response SEPARATELY.
//
// Reuse (spike §2-§3): boot03B (isolated env + 03B allow-config + native
// ted-finance plugin), facadeFor-style host-bound facades sharing the SAME
// oc instance, session.switchAgent/switchModel pinning, session.prompt loop,
// extractToolCalls / summarizeSelection / lastAssistantText observation,
// scrubSecrets + assertNoSecrets sanitization. DRYRUN validates the frozen
// oracles in spike-04-oracles.mjs through the REAL executors (no inference).
//
// Session policy (no phrase logic — pure structural rule in assignSessions):
// the SAME session is reused across turns UNLESS a turn sets freshSession
// (restart) OR the host changes (e.g. J06-B runs as B in its own session).
// A turn whose host differs from its session slot's bound host aborts
// fail-closed (isolation violation, nothing executed further).
//
// LIVE safety: refuses unless TED_04_LIVE=1 (exit 2, no inference, no cost);
// per-turn deadline with interrupt on overrun; read-only allowlist
// {get_month_summary, list_accounts} — ANY other observed tool aborts the
// journey immediately (no retry); traces are scrubbed + assertNoSecrets
// scanned BEFORE write to reports/SPIKE_04_TRACE_<JID>.json.
//
// SECRETS: credential path reuses run-03b-turn.loadLiveCredential
// (D:/projetos/pi-financeiro/.env OPENCODE_GO -> OPENCODE_API_KEY in-process
// only). Values NEVER logged, NEVER written (extraSecrets scan pre-write).

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  boot03B,
  extractToolCalls,
  summarizeSelection,
  lastAssistantText,
  loadLiveCredential,
  FINANCE_TOOLS as TOOLS_03B,
} from './run-03b-turn.mjs';
import { createToolExecutors, validateToolArgs } from './ted-finance-tools.mjs';
import { callFinance, scrubSecrets } from './finance-transport.mjs';
import { bindSession, getBinding, isSameHost } from './session-bindings.mjs';
import { filterSessionsForHost } from './ted-gateway.mjs';
import {
  HOST_A as ORACLE_HOST_A,
  HOST_B as ORACLE_HOST_B,
  HOUSEHOLD_IDS,
  oracleSummary,
  oracleAccounts,
  matchSummary,
  matchAccounts,
} from './spike-04-oracles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const HOST_A = ORACLE_HOST_A;
export const HOST_B = ORACLE_HOST_B;
export const HOSTS = Object.freeze({ A: HOST_A, B: HOST_B });
export const AGENT_04 = 'ted';
export const MODEL_PIN_04 = Object.freeze({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
export const READ_TOOLS = Object.freeze(['get_month_summary', 'list_accounts']);
// LIMIT 03B PASS (restored 2026-10-31; P1 hook removed -- same limit as 03B T4).
// Layers: (1) config denies inherited from boot03B/run-03b-turn (shell/edit/
// write/subagent + provider deny-all with one allow -- NO speculative
// `tool.use:*` default-deny: positive allowlist for custom tools is
// undocumented and could block the finance tools themselves); (2) runner:
// pre-prompt fail-closed on non-readonly expects + immediate interrupt +
// journey abort on first foreign observation (post-observation) + trace
// evidence. There is NO total pre-execution gate on the codemode execute
// wrapper in this runtime: the hook input is {code:string} and the inner
// finance target resolves only after execution, so validating the target in
// the hook is impossible; allowing execute unchecked would reopen access.
// Redesign at that point would be NEW INFRA, out of scope (SPIKE 04 sec 7/10).
// Total wrapper pre-execution enforcement is therefore a KNOWN LIMITATION
// (same as 03B PASS) and a future standalone experiment -- NOT attempted
// here, and deliberately NOT approximated by regex over code.
export const PRE_EXECUTION_ENFORCEMENT = Object.freeze({
  hook: 'none (P1 native hook removed 2026-10-31; known limitation, future experiment)',
  config: 'boot03B denies (shell/edit/write/subagent, provider deny-all+1 allow); no speculative tool.use:* default-deny',
  runner: 'pre-prompt fail-closed on non-readonly expects + immediate interrupt + abort on first foreign observation',
  limitation: 'no total pre-execution gate on the execute wrapper (hook input is {code:string}, target resolves post-execution); catalog stays a superset (transform adds); abort is post-observation; total wrapper enforcement is a known limitation and future experiment, not regex-approximated here',
});
export const TURN_TIMEOUT_MS = 90000;
export const MIN_DEADLINE_MS = 10000;
export const MAX_DEADLINE_MS = 300000;
export const MAX_TURNS = 12;
export const SECRET_PATTERNS = [/dev-token-\d/g, /boom-token/g, /not-a-real-token/g];

// Structural journey policies (session/identity shape ONLY — no phrases,
// no per-journey expectations here; texts+expects arrive per-turn).
export const JOURNEY_POLICIES = Object.freeze({
  J01: 'same-session',
  J06B: 'separate-identity',
  RESTART: 'fresh-session-per-turn',
});

if (JSON.stringify([...TOOLS_03B].sort()) !== JSON.stringify([...READ_TOOLS].sort())) {
  throw new Error('04 read allowlist drifted from 03B finance tools');
}

export function tedHomeRoot() {
  const root = process.env.TED_HOME_ROOT;
  if (!root) throw new Error('TED_HOME_ROOT not set (must point at experiments/ted-runtime)');
  return root;
}

export function sanitizeJourneyId(jid) {
  const s = String(jid || 'J01').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  if (!s) throw new Error('refused: journey id is empty after sanitization');
  return s;
}

export function tracePathFor(journeyId) {
  return path.join(tedHomeRoot(), 'reports', `SPIKE_04_TRACE_${sanitizeJourneyId(journeyId)}.json`);
}

// ---- LIVE gate (own lock; 03B lock untouched) ------------------------------
export function assertLiveGate04(env = process.env) {
  if (env.TED_04_LIVE !== '1') {
    throw Object.assign(
      new Error('refused: LIVE journey requires TED_04_LIVE=1 (accidental-inference lock; dryrun is the default)'),
      { exitCode: 2 },
    );
  }
}

// ---- CLI parsing (pure; host comes ONLY from per-turn specs, never global) --
const GLOBAL_OVERRIDE_FLAGS = ['--host', '--route', '--method', '--token', '--workspace', '--actor', '--device', '--household'];
export function rejectOverrideArgs(argv) {
  for (const a of argv) {
    const name = String(a).split('=')[0];
    if (GLOBAL_OVERRIDE_FLAGS.includes(name)) {
      throw Object.assign(new Error(`refused: override flag '${name}' is not accepted (identity travels per-turn, default A)`), { exitCode: 2 });
    }
  }
}

// Turn spec syntax: "[HOST][!]:text" — HOST in {A,B} (default A), trailing
// "!" marks freshSession (restart). Examples: "A:quanto gastei?", "B:saldo",
// "A!:recomeçar do zero". Pure structural parsing — the text is OPAQUE to
// the runner (never inspected for tool selection).
export function parseTurnSpec(spec, defaultHost = 'A') {
  const raw = String(spec);
  const m = raw.match(/^([AB])(!)?\s*:\s*([\s\S]*)$/);
  let host = defaultHost;
  let freshSession = false;
  let text = raw;
  if (m) {
    host = m[1];
    freshSession = m[2] === '!';
    text = m[3];
  }
  if (host !== 'A' && host !== 'B') throw new Error('refused: turn host must be A or B');
  if (typeof text !== 'string' || text.length === 0 || text.length > 2000) {
    throw Object.assign(new Error('refused: turn text must be a non-empty string (<=2000 chars)'), { exitCode: 2 });
  }
  return { text, host, freshSession };
}

export function parseJourneyArgs(argv) {
  rejectOverrideArgs(argv);
  let mode = null;
  let journeyId = 'J01';
  const turnSpecs = [];
  let deadlineMs = TURN_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--mode' && i + 1 < argv.length) mode = argv[++i];
    else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length);
    else if (a === '--journey' && i + 1 < argv.length) journeyId = argv[++i];
    else if (a.startsWith('--journey=')) journeyId = a.slice('--journey='.length);
    else if (a === '--turn' && i + 1 < argv.length) turnSpecs.push(argv[++i]);
    else if (a.startsWith('--turn=')) turnSpecs.push(a.slice('--turn='.length));
    else if (a === '--message' && i + 1 < argv.length) turnSpecs.push(`A:${argv[++i]}`);
    else if (a.startsWith('--message=')) turnSpecs.push(`A:${a.slice('--message='.length)}`);
    else if (a === '--deadline-ms' && i + 1 < argv.length) deadlineMs = Number(argv[++i]);
    else if (a.startsWith('--deadline-ms=')) deadlineMs = Number(a.slice('--deadline-ms='.length));
    else if (a === '--help' || a === '-h') return { mode: 'help', journeyId, turns: [], deadlineMs };
  }
  if (mode !== 'dryrun' && mode !== 'live') {
    throw Object.assign(new Error(`usage: node run-04-journey.mjs --mode=dryrun|live [--journey=J01] [--turn "A:text"]... (got mode=${JSON.stringify(mode)})`), { exitCode: 2 });
  }
  if (!Number.isFinite(deadlineMs) || deadlineMs < MIN_DEADLINE_MS || deadlineMs > MAX_DEADLINE_MS) {
    throw Object.assign(new Error(`refused: --deadline-ms must be ${MIN_DEADLINE_MS}..${MAX_DEADLINE_MS}`), { exitCode: 2 });
  }
  journeyId = sanitizeJourneyId(journeyId);
  const turns = turnSpecs.map((s) => parseTurnSpec(s, 'A'));
  if (turns.length > MAX_TURNS) throw Object.assign(new Error(`refused: at most ${MAX_TURNS} turns`), { exitCode: 2 });
  return { mode, journeyId, turns, deadlineMs };
}

// ---- Session assignment (pure structural rule) ----------------------------
// Same session slot continues while host is unchanged and no freshSession;
// a host change (J06-B shape) or freshSession (restart shape) opens a new
// slot. No text is ever consulted.
export function assignSessions(turns) {
  const slots = [];
  let slot = -1;
  let slotHost = null;
  for (const t of turns) {
    if (slot < 0 || t.freshSession || t.host !== slotHost) {
      slot += 1;
      slotHost = t.host;
    }
    slots.push(slot);
  }
  return slots;
}

// ---- Read-only allowlist (exact names; no phrase regex anywhere) -----------
export function isReadOnlyTool(name) {
  return READ_TOOLS.includes(name);
}

// ---- Turn verdict semantics (pure; understanding/execution/response split) --
// understanding: model selected exactly the expected tools, nothing foreign.
// execution:    transport/API results match the frozen oracles (or ran clean
//               when the turn carries no oracle expectation).
// response:     final prose answers the turn (non-empty; oracle-grounded when
//               execution was oracle-checked). Each axis grades INDEPENDENTLY:
//               a misunderstood turn can still have executed nothing; a well
//               executed turn can still be answered badly.
// executedOk / respondedOk accept true | false | null | 'incomplete':
// true=>pass, false=>fail, null=>not-exercised (dryrun response by design),
// 'incomplete'=>incomplete (evidence missing, never graded pass).
export function gradeTurn({ observedNames = [], expectedTools = null, foreign = [], executedOk = null, executedReason = '', respondedOk = null, respondedReason = '' }) {
  const expected = expectedTools === null ? null : [...expectedTools];
  let understanding;
  if (foreign.length > 0) {
    understanding = { status: 'fail', reason: `non-readonly tool selected: ${foreign.join(',')}` };
  } else if (observedNames.length !== new Set(observedNames).size) {
    // P1-1(a): expects carry unique names, so ANY repetition is an extra —
    // fail exact-set. (Live branch preserves duplicates in observedNames;
    // the old `[...new Set(...)]` dedup silently passed a repeated call.)
    const dupes = [...new Set(observedNames.filter((t, idx) => observedNames.indexOf(t) !== idx))].sort();
    understanding = { status: 'fail', reason: `duplicate tool call(s): ${dupes.join(',')} (expects carry unique names; any repetition is an extra — fail exact-set)` };
  } else if (expected !== null) {
    const missing = expected.filter((t) => !observedNames.includes(t));
    // Exact-set semantics: ANY observed tool outside the expected set fails
    // understanding — even a read-only extra (e.g. expected [get_month_summary]
    // but observed [get_month_summary, list_accounts] is a fail: the model
    // did not select exactly what the turn required).
    const extra = observedNames.filter((t) => !expected.includes(t));
    understanding =
      missing.length === 0 && extra.length === 0
        ? { status: 'pass', reason: `selected {${observedNames.slice().sort().join(',')}} covers expected {${expected.slice().sort().join(',')}}` }
        : missing.length > 0
          ? { status: 'fail', reason: `missing expected tool(s): ${missing.join(',')} (observed {${observedNames.slice().sort().join(',')}})` }
          : { status: 'fail', reason: `unexpected extra tool(s): ${extra.join(',')} (expected exactly {${expected.slice().sort().join(',')}})` };
  } else {
    understanding =
      observedNames.length > 0
        ? { status: 'pass', reason: `read-only selection {${observedNames.slice().sort().join(',')}}` }
        : { status: 'fail', reason: 'no finance tool selected' };
  }
  const mapAxis = (v, reason, passDefault, failDefault) => {
    if (v === null || v === undefined) return { status: 'not-exercised', reason: reason || 'no evidence' };
    if (v === 'incomplete') return { status: 'incomplete', reason: reason || 'evidence incomplete, not graded pass' };
    return v
      ? { status: 'pass', reason: reason || passDefault }
      : { status: 'fail', reason: reason || failDefault };
  };
  const execution = mapAxis(executedOk, executedReason, 'results match oracles', 'results mismatch');
  const response = mapAxis(respondedOk, respondedReason, 'turn answered', 'turn unanswered or fabricated');
  return { understanding, execution, response };
}

// ---- Sanitization (pure) ----------------------------------------------------
export function scrubTraceText(text, extraSecrets = []) {
  let out = scrubSecrets(String(text), HOST_A);
  out = scrubSecrets(out, HOST_B);
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

// ---- Turn record builder (pure; contracts input/output) --------------------
export function buildTurnRecord({ index, text, host, sessionSlot, model, expectTools = null, expectSummary = null, expectAccounts = null }) {
  if (!Number.isInteger(index) || index < 0) throw new Error('refused: turn index must be a non-negative integer');
  if (typeof text !== 'string' || text.length === 0 || text.length > 2000) throw new Error('refused: turn text must be non-empty (<=2000 chars)');
  if (host !== 'A' && host !== 'B') throw new Error('refused: turn host must be A or B');
  if (!Number.isInteger(sessionSlot) || sessionSlot < 0) throw new Error('refused: sessionSlot must be a non-negative integer');
  if (!model || typeof model.providerID !== 'string' || typeof model.id !== 'string') throw new Error('refused: model {providerID,id} is required');
  if (expectTools !== null) {
    if (!Array.isArray(expectTools)) throw new Error('refused: expectTools must be an array or null');
    for (const t of expectTools) {
      if (!isReadOnlyTool(t)) throw new Error(`refused: expectTools carries non-readonly tool '${t}' (allowlist is read-only)`);
    }
  }
  return {
    index, text, host, sessionSlot,
    model: { providerID: model.providerID, id: model.id },
    expectTools, expectSummary, expectAccounts,
    selectedTools: [], toolArgs: {}, apiResults: null,
    response: '', latencyMs: 0, usage: null,
    failures: [], verdict: null,
  };
}

// ---- Default dryrun turns: oracle coverage with EXPLICIT expects -----------
// Labels are generic ("dryrun: ...") — the runner never derives expects from
// text; expects are attached here structurally.
export function defaultDryrunTurns() {
  const t = (host, label, extra) => ({ text: `dryrun: ${label}`, host, freshSession: false, ...extra });
  return [
    t('A', 'A accounts (oracle)', { expectTools: ['list_accounts'], expectAccounts: { host: 'A' } }),
    t('A', 'A 2026-06 (oracle)', { expectTools: ['get_month_summary'], expectSummary: { host: 'A', yearMonth: '2026-06' } }),
    t('A', 'A 2026-05 (oracle)', { expectTools: ['get_month_summary'], expectSummary: { host: 'A', yearMonth: '2026-05' } }),
    t('A', 'A 2025-06 (oracle)', { expectTools: ['get_month_summary'], expectSummary: { host: 'A', yearMonth: '2025-06' } }),
    t('B', 'B accounts (oracle)', { expectTools: ['list_accounts'], expectAccounts: { host: 'B' } }),
    t('B', 'B 2026-06 (oracle)', { expectTools: ['get_month_summary'], expectSummary: { host: 'B', yearMonth: '2026-06' } }),
    t('B', 'B 2026-05 (oracle)', { expectTools: ['get_month_summary'], expectSummary: { host: 'B', yearMonth: '2026-05' } }),
    t('B', 'B 2025-06 (oracle)', { expectTools: ['get_month_summary'], expectSummary: { host: 'B', yearMonth: '2025-06' } }),
  ];
}

// ---- Structure-only result-body finder (generic, NO phrase regex) ----------
// Collects non-user JSON bodies carrying incomeCents or items (balanced
// braces on a normalized copy — same wire shape as 03B T2). Never looks at
// user text; never matches words — only result SHAPES.
export function findResultBodies(messages) {
  const texts = [];
  const collect = (node, depth, skipUser) => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === 'string') { if (!skipUser && node.length > 20) texts.push(node); return; }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) collect(x, depth + 1, skipUser); return; }
    const kidSkip = skipUser || node.role === 'user';
    for (const v of Object.values(node)) collect(v, depth + 1, kidSkip);
  };
  collect(messages, 0, false);
  // P1-1(c): collect EVERY matching body (no first-body-wins). `summary` /
  // `accounts` stay the first observed (backward-compatible evidence), but
  // divergent repeats are surfaced via *Diverged flags so the live branch can
  // fail execution instead of silently grading the first body.
  const summaryBodies = [];
  const accountBodies = [];
  for (const raw of texts) {
    const norm = String(raw).replace(/\\"/g, '"').replace(/\\n/g, ' ');
    if (norm.includes('incomeCents')) {
      const obj = firstObjectWith(norm, 'incomeCents');
      if (obj) summaryBodies.push(obj);
    }
    if (norm.includes('"items"')) {
      const obj = firstObjectWith(norm, '"items"');
      if (obj) {
        const inner = obj && typeof obj === 'object' && 'value' in obj ? obj.value : obj;
        if (inner) accountBodies.push(inner);
      }
    }
  }
  const summary = summaryBodies[0] || null;
  const accounts = accountBodies[0] || null;
  const summaryDiverged = new Set(summaryBodies.map((b) => JSON.stringify(b))).size > 1;
  const accountsDiverged = new Set(accountBodies.map((b) => JSON.stringify(b))).size > 1;
  return { summary, accounts, summaryDiverged, accountsDiverged, summaryCount: summaryBodies.length, accountsCount: accountBodies.length };
}

function firstObjectWith(text, marker) {
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
              if ('incomeCents' in parsed) return parsed;
              if ('items' in parsed || Array.isArray(parsed)) return parsed;
              for (const v of Object.values(parsed)) {
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

// ---- Best-effort usage/cost (nulls when the SDK exposes nothing) -----------
export function extractUsage(messages, events) {
  const probe = (node, depth, acc) => {
    if (depth > 6 || node === null || node === undefined) return;
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) probe(x, depth + 1, acc); return; }
    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase();
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (lk.includes('input') && lk.includes('token')) acc.inputTokens = v;
        else if (lk.includes('output') && lk.includes('token')) acc.outputTokens = v;
        else if (lk === 'totaltokens' || (lk.includes('total') && lk.includes('token'))) acc.totalTokens = v;
        else if (lk.includes('cost') || lk.includes('price')) acc.cost = v;
      }
      if (v && typeof v === 'object') probe(v, depth + 1, acc);
    }
  };
  const acc = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null };
  try { probe(messages, 0, acc); } catch { /* best-effort */ }
  try { probe(events, 0, acc); } catch { /* best-effort */ }
  return acc;
}

// ---- boot04: boot03B + host-bound facades sharing the SAME oc ------------
export async function boot04() {
  const boot = await boot03B();
  const executors = createToolExecutors(callFinance);
  const newIntention = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const facadeFor = (label) => {
    const bound = Object.freeze({ ...(label === 'B' ? HOST_B : HOST_A) });
    return Object.freeze({
      host: bound,
      createSession: async (title) => {
        const s = await boot.oc.session.create({ title: title || 'ted-04' });
        bindSession(s.id, bound);
        return s;
      },
      listSessions: async () => filterSessionsForHost(await boot.oc.session.list(), bound),
      list_accounts: (args, opts) => executors.list_accounts(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
      get_month_summary: (args, opts) => executors.get_month_summary(args, bound, { timeoutMs: 120000, ...(opts || {}), intentionId: newIntention() }),
    });
  };
  return { ...boot, facadeFor };
}

// ---- DRYRUN journey (deterministic; NEVER session.prompt) -----------------
export async function runDryrunJourney({ journeyId = 'J01', turns = null } = {}) {
  const t0 = Date.now();
  const jid = sanitizeJourneyId(journeyId);
  const list = Array.isArray(turns) && turns.length > 0 ? turns : defaultDryrunTurns();
  if (list.length > MAX_TURNS) throw Object.assign(new Error(`refused: at most ${MAX_TURNS} turns`), { exitCode: 2 });
  const slots = assignSessions(list);
  const executors = createToolExecutors(callFinance);
  const newIntention = () => `dryrun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const hostFor = (h) => (h === 'B' ? HOST_B : HOST_A);
  const turnRecords = [];
  for (let i = 0; i < list.length; i++) {
    const def = list[i];
    const rec = buildTurnRecord({
      index: i, text: def.text, host: def.host || 'A', sessionSlot: slots[i],
      model: { ...MODEL_PIN_04 },
      expectTools: def.expectTools || null,
      expectSummary: def.expectSummary || null,
      expectAccounts: def.expectAccounts || null,
    });
    const r0 = Date.now();
    try {
      // Fail-closed: a turn EXPECTING a non-readonly tool is refused before
      // any transport call (dryrun never executes writes by construction —
      // only the two executors above exist on this path).
      if (rec.expectTools) {
        for (const t of rec.expectTools) {
          if (!isReadOnlyTool(t)) throw new Error(`refused: non-readonly expected tool '${t}'`);
        }
      }
      const bound = hostFor(rec.host);
      const parts = [];
      let executedOk = true;
      const reasons = [];
      if (rec.expectSummary) {
        const body = await executors.get_month_summary(
          { yearMonth: rec.expectSummary.yearMonth }, bound, { timeoutMs: 120000, intentionId: newIntention() },
        );
        const check = matchSummary(body, oracleSummary(rec.expectSummary.host || rec.host, rec.expectSummary.yearMonth));
        parts.push({ kind: 'get_month_summary', check });
        if (!check.ok) { executedOk = false; reasons.push(`summary mismatch ${JSON.stringify(check.details).slice(0, 160)}`); }
        rec.apiResults = { ...(rec.apiResults || {}), get_month_summary: body };
        rec.selectedTools.push('get_month_summary');
        rec.toolArgs.get_month_summary = { yearMonth: rec.expectSummary.yearMonth };
      }
      if (rec.expectAccounts) {
        const body = await executors.list_accounts({}, bound, { timeoutMs: 120000, intentionId: newIntention() });
        const hostLabel = rec.expectAccounts.host || rec.host;
        const check = matchAccounts(body, oracleAccounts(hostLabel), HOUSEHOLD_IDS[hostLabel]);
        parts.push({ kind: 'list_accounts', check });
        if (!check.ok) { executedOk = false; reasons.push(`accounts mismatch ${JSON.stringify(check.details).slice(0, 160)}`); }
        rec.apiResults = { ...(rec.apiResults || {}), list_accounts: { total: body.total, names: body.items.map((x) => x.name) } };
        rec.selectedTools.push('list_accounts');
        rec.toolArgs.list_accounts = {};
      }
      const observed = rec.selectedTools.slice();
      const sel = { names: observed, foreign: observed.filter((n) => !isReadOnlyTool(n)), perTool: {}, bothObserved: observed.length > 0 };
      rec.verdict = gradeTurn({
        observedNames: observed, expectedTools: rec.expectTools, foreign: sel.foreign,
        executedOk, executedReason: executedOk ? `oracle match (${parts.map((p) => p.kind).join('+')})` : reasons.join('; '),
        respondedOk: null, respondedReason: 'no prompt in dryrun (response untested by design)',
      });
    } catch (e) {
      rec.failures.push(String((e && e.message) || e).slice(0, 200));
      rec.verdict = gradeTurn({
        observedNames: rec.selectedTools.slice(), expectedTools: rec.expectTools, foreign: [],
        executedOk: false, executedReason: `transport/executor failure: ${String((e && e.message) || e).slice(0, 160)}`,
        respondedOk: null, respondedReason: 'no prompt in dryrun',
      });
    }
    rec.latencyMs = Date.now() - r0;
    rec.usage = { inputTokens: null, outputTokens: null, totalTokens: null, cost: 0 };
    turnRecords.push(rec);
  }
  const passed = turnRecords.filter((r) => r.verdict && r.verdict.execution.status === 'pass').length;
  const trace = {
    spike: '04', mode: 'dryrun', at: new Date().toISOString(), journeyId: jid,
    sessionPromptCalled: false, agent: AGENT_04, model: { ...MODEL_PIN_04 },
    enforcement: { ...PRE_EXECUTION_ENFORCEMENT },
    policy: JOURNEY_POLICIES[jid] || 'same-session',
    sessionSlots: slots, turns: turnRecords,
    summary: { turns: turnRecords.length, executedPass: passed },
    elapsedMs: Date.now() - t0,
  };
  const serialized = assertNoSecrets(trace);
  fs.mkdirSync(path.dirname(tracePathFor(jid)), { recursive: true });
  fs.writeFileSync(tracePathFor(jid), serialized + '\n', { encoding: 'utf8' });
  return { trace, output: { spike: '04', mode: 'dryrun', journeyId: jid, sessionPromptCalled: false, turns: turnRecords.length, executedPass: passed, elapsedMs: trace.elapsedMs } };
}

// ---- Oracle grounding for live responses (pure; no phrase logic) ---------
// Checks that the final prose carries values from the turn's EXPLICIT
// oracle expects (never derived from text). Only distinctive markers count:
// integer money values with |n| >= 100 (single digits / bare "0" hide inside
// years like "2026", so they prove nothing) and expected account names.
// An echo of the question carries none of these and fails grounding.
// Returns { grounded: true | false | null }: null = nothing distinctive to
// check (no expects, or an all-zero month) — incomplete, never pass.
export function responseGroundsOracle(response, { expectSummary = null, expectAccounts = null } = {}) {
  if (!expectSummary && !expectAccounts) {
    return { grounded: null, reason: 'no oracle attached — response ungrounded by design', missing: [] };
  }
  const text = String(response || '');
  // P1-2: BRL formatting never contains raw cents ("R$ 12.000,00" hides
  // "1200000"). Besides the literal check, strip non-digits from the WHOLE
  // response and look for the cents string (abs value — the minus sign is
  // stripped by the normalization). The join is over the whole response:
  // low false-positive risk for distinctive numbers >= 100, and execution
  // still requires the backend bodies to match the frozen oracles — grounding
  // only checks the prose carries the executed values, never verifies them.
  const digitsOnly = text.replace(/\D/g, '');
  const carries = (n) => text.includes(String(n)) || digitsOnly.includes(String(Math.abs(n)));
  const missing = [];
  if (expectSummary) {
    for (const n of [expectSummary.expenseCents, expectSummary.incomeCents, expectSummary.balanceCents]) {
      if (typeof n === 'number' && Math.abs(n) >= 100 && !carries(n)) missing.push(`summary:${n}`);
    }
  }
  if (expectAccounts) {
    for (const item of expectAccounts.items || []) {
      if (item && typeof item.name === 'string' && item.name.length > 0 && !text.includes(item.name)) {
        missing.push(`account:${item.name}`);
      }
    }
  }
  const distinctive = (expectSummary
    ? [expectSummary.expenseCents, expectSummary.incomeCents, expectSummary.balanceCents]
      .filter((n) => typeof n === 'number' && Math.abs(n) >= 100).length : 0)
    + (expectAccounts ? (expectAccounts.items || []).length : 0);
  if (distinctive === 0) {
    return { grounded: null, reason: 'oracle carries no distinctive value to ground (all-zero month)', missing };
  }
  return missing.length === 0
    ? { grounded: true, reason: 'response carries executed oracle values', missing }
    : { grounded: false, reason: `response lacks executed oracle value(s): ${missing.join(',')}`, missing };
}

// ---- Per-call args validation (pure; P1-1(b)) ----------------------------
// Validates EVERY observed call via validateToolArgs (not just the first per
// tool) plus exact yearMonth on each get_month_summary call. Reasons cite the
// call index. Used by the live branch; unit-tested without inference.
export function checkAllCallsArgs(calls, { expectSummaryYearMonth = null } = {}) {
  const reasons = [];
  let ok = true;
  const list = Array.isArray(calls) ? calls : [];
  for (let k = 0; k < list.length; k++) {
    try {
      // 04L: codemode metadata toolCalls omit input/args for zero-arg
      // invocations (e.g. list_accounts({}) runs; the code string carries
      // the {} but inputs are not echoed in metadata). Absent input is
      // validated as empty args — required-field checks still apply, so
      // get_month_summary without yearMonth still fails. This normalizes
      // the observation encoding, never the security boundary (unknown /
      // forbidden keys are still rejected; no code parsing).
      const args = list[k].args === undefined ? {} : list[k].args;
      validateToolArgs(list[k].name, args);
    } catch (e) {
      ok = false;
      reasons.push(`args mismatch [call ${k} ${list[k].name}]: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }
  if (expectSummaryYearMonth !== null) {
    const summaryCalls = list.map((c, i) => ({ c, i })).filter(({ c }) => c && c.name === 'get_month_summary');
    if (summaryCalls.length === 0) {
      ok = false;
      reasons.push('args mismatch: no get_month_summary args observed');
    } else {
      for (const { c, i } of summaryCalls) {
        if (!c.args || c.args.yearMonth !== expectSummaryYearMonth) {
          ok = false;
          reasons.push(`args mismatch [call ${i}]: yearMonth mismatch: observed ${c.args ? c.args.yearMonth : 'undefined'} vs expected ${expectSummaryYearMonth}`);
        }
      }
    }
  }
  return { ok, reasons };
}

// ---- LIVE journey (multi-turn; same session unless slot changes) -----------
export async function runLiveJourney({ journeyId = 'J01', turns = null, deadlineMs = TURN_TIMEOUT_MS } = {}) {
  assertLiveGate04();
  const { secret } = loadLiveCredential();
  const t0 = Date.now();
  const jid = sanitizeJourneyId(journeyId);
  const list = Array.isArray(turns) && turns.length > 0 ? turns : defaultDryrunTurns().slice(0, 2);
  if (list.length > MAX_TURNS) throw Object.assign(new Error(`refused: at most ${MAX_TURNS} turns`), { exitCode: 2 });
  const slots = assignSessions(list.map((t) => ({ host: t.host || 'A', freshSession: !!t.freshSession })));
  const boot = await boot04();
  const events = [];
  const turnRecords = [];
  let aborted = null;
  try {
    // One session per slot, bound to the slot's host; pinned agent+model.
    const sessions = new Map();
    const pinned = [];
    for (let i = 0; i < list.length; i++) {
      const slot = slots[i];
      const hostLabel = list[i].host || 'A';
      if (!sessions.has(slot)) {
        const facade = boot.facadeFor(hostLabel);
        const s = await facade.createSession(`ted-04-${jid}-s${slot}`);
        sessions.set(slot, { id: s.id, host: hostLabel, facade });
        try {
          if (typeof boot.oc.session.switchAgent === 'function') {
            await boot.oc.session.switchAgent({ sessionID: s.id, agent: AGENT_04 });
            pinned.push(`slot${slot}:agent:${AGENT_04}`);
          }
          if (typeof boot.oc.session.switchModel === 'function') {
            await boot.oc.session.switchModel({ sessionID: s.id, model: { ...MODEL_PIN_04 } });
            pinned.push(`slot${slot}:model:${MODEL_PIN_04.providerID}/${MODEL_PIN_04.id}`);
          }
        } catch (e) {
          aborted = `pin-failed:${String((e && e.message) || e).slice(0, 120)}`;
          break;
        }
      } else {
        const boundHost = sessions.get(slot).host;
        if (boundHost !== hostLabel) {
          aborted = `isolation-violation:slot${slot}-bound-${boundHost}-vs-turn-${hostLabel}`;
          break;
        }
      }
    }
    if (!aborted) {
      for (let i = 0; i < list.length; i++) {
        const def = list[i];
        const slot = slots[i];
        const sess = sessions.get(slot);
        const rec = buildTurnRecord({
          index: i, text: def.text, host: def.host || 'A', sessionSlot: slot,
          model: { ...MODEL_PIN_04 },
          expectTools: def.expectTools || null,
          expectSummary: def.expectSummary || null,
          expectAccounts: def.expectAccounts || null,
        });
        rec.sessionID = sess.id;
        const r0 = Date.now();
        let promptError = null;
        // P1 pre-prompt fail-closed: a turn EXPECTING a non-readonly tool is
        // refused BEFORE session.prompt (no inference spent, nothing executed).
        if (rec.expectTools) {
          for (const t of rec.expectTools) {
            if (!isReadOnlyTool(t)) {
              rec.failures.push(`refused: non-readonly expected tool '${t}' (pre-prompt)`);
              rec.verdict = gradeTurn({
                observedNames: [], expectedTools: rec.expectTools, foreign: [t],
                executedOk: false, executedReason: 'refused pre-prompt: non-readonly expect (nothing executed)',
                respondedOk: false, respondedReason: 'refused pre-prompt',
              });
              rec.latencyMs = Date.now() - r0;
              rec.usage = extractUsage([], events);
              turnRecords.push(rec);
              aborted = 'refused-non-readonly-expect';
              break;
            }
          }
          if (aborted === 'refused-non-readonly-expect') {
            for (let j = i + 1; j < list.length; j++) {
              const skip = buildTurnRecord({
                index: j, text: list[j].text, host: list[j].host || 'A', sessionSlot: slots[j],
                model: { ...MODEL_PIN_04 },
                expectTools: list[j].expectTools || null,
                expectSummary: list[j].expectSummary || null,
                expectAccounts: list[j].expectAccounts || null,
              });
              skip.verdict = gradeTurn({ observedNames: [], expectedTools: skip.expectTools, foreign: [], executedOk: null, executedReason: 'skipped: journey aborted', respondedOk: null, respondedReason: 'skipped: journey aborted' });
              turnRecords.push(skip);
            }
            break;
          }
        }
        try {
          const deadline = r0 + deadlineMs;
          await Promise.race([
            boot.oc.session.prompt({ sessionID: sess.id, text: def.text }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('prompt-timeout-turn')), Math.max(1000, deadline - Date.now()))),
          ]);
        } catch (e) {
          promptError = String((e && e.message) || e).slice(0, 200);
          rec.failures.push(promptError);
        }
        // Collect messages (quiescence ≤6s, hard deadline).
        let messages = [];
        let lastChange = Date.now();
        let lastSig = '';
        for (;;) {
          if (Date.now() > r0 + deadlineMs) { rec.failures.push('turn-deadline'); break; }
          try {
            const res = await boot.oc.message.list({ sessionID: sess.id });
            messages = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);
          } catch (e) {
            events.push({ pollError: String((e && e.message) || e).slice(0, 160) });
          }
          const sig = `${JSON.stringify(messages).length}:${messages.length}`;
          if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
          const early = extractToolCalls(messages);
          const earlySel = summarizeSelection(early.calls);
          if (earlySel.foreign.length > 0) break;
          if (messages.length > 1 && Date.now() - lastChange > 6000) break;
          if (promptError && messages.length <= 1 && Date.now() - r0 > 30000) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        const { calls } = extractToolCalls(messages);
        const sel = summarizeSelection(calls);
        // P1-1(a): preserve duplicates in observedNames — expects carry unique
        // names, so gradeTurn fails any repetition as an extra (exact-set).
        // (The old `[...new Set(...)]` dedup silently passed repeated calls.)
        rec.selectedTools = calls.map((c) => c.name);
        if (rec.selectedTools.length !== new Set(rec.selectedTools).size) {
          rec.failures.push(`duplicate-tool-calls:${[...rec.selectedTools].sort().join(',')}`);
        }
        // Trace keeps the first args per tool; VALIDATION covers every call
        // by index via checkAllCallsArgs below (P1-1(b)).
        for (const c of calls) {
          if (!rec.toolArgs[c.name]) rec.toolArgs[c.name] = c.args;
        }
        // Allowlist: ANY non-readonly observation aborts the journey (no retry).
        // LIMIT 03B PASS: no native pre-execution hook on the execute wrapper
// (P1 removed; known limitation). This runner-side abort is the
// post-observation backstop (interrupt + evidence + no further turns).
        if (sel.foreign.length > 0) {
          try { if (typeof boot.oc.session.interrupt === 'function') await boot.oc.session.interrupt({ sessionID: sess.id }); } catch { /* best-effort */ }
          rec.failures.push(`allowlist-breach:${sel.foreign.join(',')}`);
          rec.verdict = gradeTurn({
            observedNames: rec.selectedTools, expectedTools: rec.expectTools, foreign: sel.foreign,
            executedOk: false, executedReason: 'aborted: non-readonly tool observed (never executed by this runner)',
            respondedOk: false, respondedReason: 'aborted with allowlist breach',
          });
          rec.latencyMs = Date.now() - r0;
          rec.usage = extractUsage(messages, events);
          turnRecords.push(rec);
          aborted = 'foreign-tool';
          for (let j = i + 1; j < list.length; j++) {
            const skip = buildTurnRecord({
              index: j, text: list[j].text, host: list[j].host || 'A', sessionSlot: slots[j],
              model: { ...MODEL_PIN_04 },
              expectTools: list[j].expectTools || null,
              expectSummary: list[j].expectSummary || null,
              expectAccounts: list[j].expectAccounts || null,
            });
            skip.verdict = gradeTurn({ observedNames: [], expectedTools: skip.expectTools, foreign: [], executedOk: null, executedReason: 'skipped: journey aborted', respondedOk: null, respondedReason: 'skipped: journey aborted' });
            turnRecords.push(skip);
          }
          break;
        }
        // Execution: compare observed result bodies to the turn's EXPLICIT
        // expects (never derived from text). Seven axes, separate checks:
        // (1) comprehension/selection via gradeTurn exact-set below;
        // (2) args (EVERY call via validateToolArgs + exact yearMonth per
        // summary call, reasons cite the call index; divergent same-type
        // bodies fail); (3) identity
        // (host/slot binding — slot mismatch aborts pre-prompt above, the
        // binding is recorded here as evidence, not re-decided);
        // (4) backend result (bodies match frozen oracles, yearMonth pinned);
        // (5) response grounding (executed oracle values present in prose);
        // (6) absence of undue tools (foreign aborts above / fails below).
        const bodies = findResultBodies(messages);
        const hasExpects = !!(rec.expectSummary || rec.expectAccounts);
        const identityNote = `identity host=${rec.host} slot=${slot} bound=${sess.host} (slot mismatch aborts pre-prompt)`;
        let executedOk = true;
        let respondedOk = true;
        const execReasons = [];
        const respReasons = [];
        const apiOut = {};
        const expSummary = rec.expectSummary
          ? oracleSummary(rec.expectSummary.host || rec.host, rec.expectSummary.yearMonth)
          : null;
        const expAccounts = rec.expectAccounts
          ? oracleAccounts(rec.expectAccounts.host || rec.host)
          : null;
        const expHousehold = rec.expectAccounts ? HOUSEHOLD_IDS[rec.expectAccounts.host || rec.host] : null;
        if (!hasExpects) {
          // (a) no oracle attached: nothing verifiable was exercised.
          executedOk = 'incomplete';
          respondedOk = 'incomplete';
          execReasons.push(`no oracle attached — evidence incomplete, not pass (${calls.length > 0 ? `tools ran (${rec.selectedTools.join(',')})` : 'no tool calls observed'}; ${identityNote})`);
          respReasons.push(`no oracle attached — response ungrounded, not pass (${identityNote})`);
        } else {
          // (b) expects attached but a body is missing: incomplete, not fail.
          let bodiesPresent = true;
          if (rec.expectSummary && !bodies.summary) {
            bodiesPresent = false;
            execReasons.push(`no summary result body observed — evidence incomplete (${identityNote})`);
          }
          if (rec.expectAccounts && !bodies.accounts) {
            bodiesPresent = false;
            execReasons.push(`no accounts result body observed — evidence incomplete (${identityNote})`);
          }
          if (!bodiesPresent) {
            executedOk = 'incomplete';
            respondedOk = 'incomplete';
            respReasons.push(`no result body to ground response — evidence incomplete (${identityNote})`);
          } else {
            // P1-1(c): two bodies of the same type that DIVERGE fail
            // execution — never silently grade the first body.
            if (bodies.summaryDiverged) {
              executedOk = false;
              execReasons.push('divergent summary result bodies observed — execution fail (not first-body-wins)');
            }
            if (bodies.accountsDiverged) {
              executedOk = false;
              execReasons.push('divergent accounts result bodies observed — execution fail (not first-body-wins)');
            }
            // (4) backend result vs frozen oracles (yearMonth pinned).
            if (rec.expectSummary) {
              const check = matchSummary(bodies.summary, expSummary);
              apiOut.get_month_summary = bodies.summary;
              if (!check.ok) { executedOk = false; execReasons.push(`summary mismatch ${JSON.stringify(check.details).slice(0, 160)}`); }
              else execReasons.push('summary matches oracle');
            }
            if (rec.expectAccounts) {
              const check = matchAccounts(bodies.accounts, expAccounts, expHousehold);
              apiOut.list_accounts = bodies.accounts;
              if (!check.ok) { executedOk = false; execReasons.push(`accounts mismatch ${JSON.stringify(check.details).slice(0, 160)}`); }
              else execReasons.push('accounts match oracle');
            }
            // (2) args axis: EVERY call validated (P1-1(b)) + exact yearMonth
            // per summary call. Reasons cite the call index.
            {
              const argsCheck = checkAllCallsArgs(calls, {
                expectSummaryYearMonth: rec.expectSummary ? rec.expectSummary.yearMonth : null,
              });
              if (!argsCheck.ok) {
                executedOk = false;
                for (const r of argsCheck.reasons) execReasons.push(r);
              } else {
                execReasons.push(
                  rec.expectSummary
                    ? 'args yearMonth exact + valid (all calls)'
                    : 'args valid (all calls)',
                );
              }
              if (rec.expectAccounts) {
                const n = calls.filter((c) => c && c.name === 'list_accounts').length;
                execReasons.push(n > 0 ? 'list_accounts args valid (all calls)' : 'no list_accounts call observed (args unverified)');
              }
            }
            execReasons.push(identityNote);
            // (c)/(d) response axis: execution mismatch fails; when
            // execution passed, grounding is decided on the recorded final
            // text below (echo of the question fails).
            if (executedOk === false) {
              respondedOk = false;
              respReasons.push('request unanswered (no fabrication credit without execution)');
            }
          }
        }
        rec.apiResults = apiOut;
        const finalText = lastAssistantText(messages);
        rec.response = String(finalText || '').slice(0, 2000);
        // Grounding runs on the recorded final text (rec.response assigned
        // above); re-check when execution passed so the verdict reflects it.
        if (hasExpects && executedOk === true) {
          const ground = responseGroundsOracle(rec.response, { expectSummary: expSummary, expectAccounts: expAccounts });
          if (ground.grounded === true) {
            respondedOk = rec.response.length > 0;
            respReasons.length = 0;
            respReasons.push(respondedOk ? 'turn answered with executed values' : 'no response text');
          } else if (ground.grounded === false) {
            respondedOk = false;
            respReasons.length = 0;
            respReasons.push(`${ground.reason} (echo/fabrication, not pass)`);
          } else {
            respondedOk = 'incomplete';
            respReasons.length = 0;
            respReasons.push(`${ground.reason} — evidence incomplete, not pass`);
          }
        }
        rec.verdict = gradeTurn({
          observedNames: rec.selectedTools, expectedTools: rec.expectTools, foreign: [],
          executedOk, executedReason: execReasons.join('; ').slice(0, 300) || 'no execution evidence',
          respondedOk,
          respondedReason: respReasons.join('; ').slice(0, 300) || 'no response evidence',
        });
        rec.latencyMs = Date.now() - r0;
        rec.usage = extractUsage(messages, events);
        if (promptError) rec.failures.push(promptError);
        turnRecords.push(rec);
      }
    }
    const clean = (v) => JSON.parse(scrubTraceText(JSON.stringify(v), secret ? [secret] : []));
    const trace = {
      spike: '04', mode: 'live', at: new Date().toISOString(), journeyId: jid,
      sessionPromptCalled: true, agent: AGENT_04, model: { ...MODEL_PIN_04 },
      enforcement: { ...PRE_EXECUTION_ENFORCEMENT },
      policy: JOURNEY_POLICIES[jid] || 'same-session',
      sessionSlots: slots, aborted, pinned,
      turns: clean(turnRecords.map((r) => ({
        index: r.index, text: r.text, host: r.host, sessionSlot: r.sessionSlot,
        sessionID: r.sessionID || null, model: r.model,
        selectedTools: r.selectedTools, toolArgs: r.toolArgs, apiResults: r.apiResults,
        response: r.response, latencyMs: r.latencyMs, usage: r.usage,
        failures: r.failures, verdict: r.verdict,
      }))),
      events: clean(events).slice(0, 200),
      elapsedMs: Date.now() - t0,
    };
    const serialized = assertNoSecrets(trace, secret ? [secret] : []);
    fs.mkdirSync(path.dirname(tracePathFor(jid)), { recursive: true });
    fs.writeFileSync(tracePathFor(jid), serialized + '\n', { encoding: 'utf8' });
    return { trace, secretLen: secret ? secret.length : 0 };
  } finally {
    await boot.oc.close().catch(() => {});
  }
}

// ---- main -------------------------------------------------------------------
async function main() {
  if (!process.env.TED_HOME_ROOT) process.env.TED_HOME_ROOT = path.join(HERE, '..');
  let args;
  try {
    args = parseJourneyArgs(process.argv.slice(2));
  } catch (e) {
    console.error(scrubTraceText((e && e.message) || String(e)));
    process.exit((e && e.exitCode) || 2);
  }
  if (args.mode === 'help') {
    console.log('usage: node run-04-journey.mjs --mode=dryrun|live [--journey=J01] [--turn "A:text"]... [--deadline-ms=90000]');
    return;
  }
  if (args.mode === 'live') {
    try {
      assertLiveGate04();
    } catch (e) {
      console.error(scrubTraceText((e && e.message) || String(e)));
      process.exit(2);
    }
    const { trace, secretLen } = await runLiveJourney({ journeyId: args.journeyId, turns: args.turns, deadlineMs: args.deadlineMs });
    const verdicts = trace.turns.map((t) => ({ index: t.index, verdict: t.verdict }));
    console.log(JSON.stringify({
      spike: '04', mode: 'live', journeyId: args.journeyId, sessionPromptCalled: true,
      credential: { source: 'OPENCODE_GO', injectedAs: 'OPENCODE_API_KEY', keyLength: secretLen },
      turns: trace.turns.length, aborted: trace.aborted, verdicts,
      elapsedMs: trace.elapsedMs, traceFile: tracePathFor(args.journeyId),
    }, null, 2));
    return;
  }
  const { output } = await runDryrunJourney({ journeyId: args.journeyId, turns: args.turns.length > 0 ? args.turns : null });
  console.log(JSON.stringify(output, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(scrubTraceText((e && e.stack) || (e && e.message) || String(e)).slice(0, 2000));
    process.exit(1);
  });
}
