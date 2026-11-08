// TED finance plugin — P1 product registration.
//
// Loaded by the OpenCode 2.2.4 host as a local directory plugin
// (conventional entry: this index file; id from Plugin.define).
//
// Native mechanism (verified against installed 2.2.4 .d.ts in the spike):
// tools are added through ctx.tool.transform((editor) => editor.add(...)).
// Direct ctx.tool.add does NOT exist on the host context. Tool execution
// runs ONLY via the agent prompt loop (session.prompt → LLM inference),
// which P1/P2 NEVER invoke (no paid provider execution): the SAME execute
// functions below are exercised deterministically through the test-only
// helper (tests/helpers/facade.mjs) with a host-bound context.
//
// SCOPE (reviewer note on TOOL_DEFS): the spike's TOOL_DEFS array also
// contains propose_expense. This product registers EXACTLY list_accounts +
// get_month_summary by default, with complete input AND output schemas (the
// native loop rejects {output} results from tools registered without an output
// schema). list_categories (also in TOOL_DEFS) is the bounded P3 prerequisite
// and is registered ONLY under the local opt-in below — never by default, never
// in production. No propose/write registration exists in this slice; adding one
// is a deliberate product decision, not a config change.

import { TOOL_DEFS, createToolExecutors, deriveIntentionId } from './tool-defs.mjs';
import { resolveHost } from './session-bindings.mjs';
import { proposalIntentRegistry } from './proposal-intents.mjs';

export const PRODUCT_TOOL_NAMES = ['list_accounts', 'get_month_summary'];

// Native permission gate (PR290 deny-by-default correction): the TED agent's
// base default would otherwise be `{action:'*',resource:'*',effect:'allow'}`
// (Agent.Info `default()` in @opencode/schema 2.2.4 agent.js), so a new native
// action could match that base wildcard allow. The agent allowlist in
// bootstrap.mjs therefore denies `*` first and allows ONLY this namespaced
// custom action with EXACT finance resources below (V2 supports
// plugin-defined permission action names; a policy `allow` never grants —
// plugin tools only enforce checks they explicitly assert via
// `ctx.permission.assert`, Plugin 2.2.4 `permission.d.ts`).
export const TED_FINANCE_PERMISSION_ACTION = 'ted.finance.read';
export const TED_FINANCE_PERMISSION_RESOURCES = Object.freeze([
  'list_accounts',
  'list_credit_cards',
  'get_month_summary',
  'list_categories',
  'propose_expense',
  'propose_income',
  'propose_card_purchase',
  'propose_transfer',
  'list_card_statements',
  'propose_statement_payment',
]);

// P3 prerequisite reads (opt-in only — TED_OPENCODE_P3_READS_ENABLED=1 with
// NODE_ENV !== 'production'). Production forces it off (fail closed): a
// production NODE_ENV never exposes the extra reads, even with the flag set.
// The default product catalog is exactly PRODUCT_TOOL_NAMES (P2 behavior).
export const P3_READ_TOOL_NAMES = ['list_categories', 'list_card_statements', 'list_credit_cards'];

// P3 write slice: `propose_expense`, `propose_income`, `propose_card_purchase`
// and `propose_transfer` record a proposal intent only (P3.1–P3.4 share the
// same intent-only contract). Exposed ONLY as a local opt-in —
// TED_OPENCODE_P3_WRITES_ENABLED=1 with NODE_ENV !== 'production'. It also
// enables the category read needed to resolve a transaction category.
// Production forces all of them off (fail closed).
export const P3_WRITE_TOOL_NAMES = ['propose_expense', 'propose_income', 'propose_card_purchase', 'propose_transfer', 'propose_statement_payment'];

export function isP3ReadsEnabled(env = process.env) {
  try {
    if (!env || typeof env !== 'object') return false;
    if (env.NODE_ENV === 'production') return false;
    return env.TED_OPENCODE_P3_READS_ENABLED === '1' || env.TED_OPENCODE_P3_WRITES_ENABLED === '1';
  } catch {
    return false;
  }
}

export function isP3WritesEnabled(env = process.env) {
  try {
    if (!env || typeof env !== 'object') return false;
    if (env.NODE_ENV === 'production') return false;
    return env.TED_OPENCODE_P3_WRITES_ENABLED === '1';
  } catch {
    return false;
  }
}

export function productToolDefs(env = process.env) {
  const names = [
    ...PRODUCT_TOOL_NAMES,
    ...(isP3ReadsEnabled(env) ? P3_READ_TOOL_NAMES : []),
    ...(isP3WritesEnabled(env) ? P3_WRITE_TOOL_NAMES : []),
  ];
  const defs = TOOL_DEFS.filter((d) => names.includes(d.name));
  if (defs.length !== names.length) {
    throw new Error(`product tool catalogue drift: expected ${names.join(',')}`);
  }
  for (const def of defs) {
    if (!def.input || typeof def.input !== 'object' || !def.output || typeof def.output !== 'object') {
      throw new Error(`${def.name}: complete input AND output schemas are required (native 2.2.4)`);
    }
  }
  return defs;
}

// Pure execute-closure builder (host-resolved, intention-stable, native
// permission-gated). Exported for tests; setup() wires the real executors
// below. The native `ctx.permission.assert` is captured ONCE during plugin
// setup (Plugin 2.2.4: `permission` belongs to the setup Context; the tool
// execution ToolContext carries sessionID/messageID/id/agent/signal but NO
// permission property — see promise/plugin.d.ts vs promise/tool.d.ts) and
// passed here as `assertPermission`. The execute closure NEVER reads
// ctx.permission: it calls the setup-captured assert FIRST — with the real
// tool invocation context (sessionID, messageID, id, agent as available),
// action `ted.finance.read` and resource `[def.name]` — BEFORE host resolve
// / finance executor / HTTP. Missing setup-captured assert fails closed; a
// deny fails closed with a generic message (no raw denial detail leaks)
// without reaching the executor. This is the native permission mechanism
// (Plugin 2.2.4 `permission.d.ts` AssertInput), not a new auth system.
export function buildExecute(def, run, assertPermission) {
  return async (input, ctx, opts = {}) => {
    const { ToolError } = await import('./tool-defs.mjs');
    try {
      if (!ctx || typeof ctx.sessionID !== 'string' || ctx.sessionID.length === 0) {
        throw new ToolError('host_context_required', `${def.name}: host-bound session context is required — hostless execution is blocked by design`);
      }
      const { sessionID, messageID, id, agent, signal } = ctx;
      if (signal && signal.aborted) {
        throw new ToolError('tool.cancelled', `${def.name}: tool cancelled before execution`);
      }
      // Native permission gate (setup-captured; must precede host resolve /
      // executor / HTTP). The execution context is never consulted for it.
      if (typeof assertPermission !== 'function') {
        throw new ToolError('tool.forbidden', `${def.name}: native permission assertion unavailable — failing closed (no silent allow)`);
      }
      const assertInput = { sessionID, action: TED_FINANCE_PERMISSION_ACTION, resources: [def.name] };
      if (typeof agent === 'string' && agent.length > 0) assertInput.agent = agent;
      if (typeof messageID === 'string' && messageID.length > 0 && typeof id === 'string' && id.length > 0) {
        assertInput.source = { type: 'tool', messageID, id };
      }
      try {
        await assertPermission(assertInput);
      } catch (e) {
        if (e && (e instanceof ToolError || e.code === 'tool.cancelled')) throw e;
        throw new ToolError('tool.forbidden', `${def.name}: native permission denied — failing closed (no silent allow)`);
      }
      const host = resolveHost(sessionID);
      // Stable intention per session+message (retries share ONE intention);
      // the native CallID (ctx.id) travels ONLY as technical correlation.
      const intentionId = deriveIntentionId({ sessionID, messageID });
      const o = opts || {};
      const body = await run(input, host, {
        sessionID,
        seed: o.seed,
        fault: o.fault,
        workspaceId: o.workspaceId,
        delayMs: o.delayMs,
        timeoutMs: o.timeoutMs,
        signal: signal ?? o.signal,
        intentionId,
        callId: typeof id === 'string' && id.length > 0 ? id : undefined,
      });
      return { output: body, content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (e) {
      if (e && e.code === 'tool.cancelled') throw e;
      const { ToolError: TE } = await import('./tool-defs.mjs');
      if (e instanceof TE) throw e;
      // Generic fallback: fixed safe message — arbitrary executor/dependency
      // exception text never propagates to the tool/model context.
      throw new TE('tool.transport', `${def.name}: tool execution failed`);
    }
  };
}

// Effective catalog (2.2.4 fact): the runnable tool list is visible ONLY
// inside plugin context via ctx.tool.list(). The HTTP SDK surface has no
// tool group, so the gateway process cannot enumerate tools — any caller
// outside plugin setup gets a fail-closed error, never an assumed list.
export async function getEffectiveToolNames(pluginCtx) {
  if (!pluginCtx || !pluginCtx.tool || typeof pluginCtx.tool.list !== 'function') {
    throw new Error('getEffectiveToolNames: available only inside plugin context (ctx.tool.list) — no tool group on the HTTP surface');
  }
  const list = await pluginCtx.tool.list();
  const rows = Array.isArray(list) ? list : list?.data;
  if (!Array.isArray(rows)) {
    throw new Error('getEffectiveToolNames: unrecognized tool list shape — failing closed');
  }
  return rows.map((t) => t.name).sort();
}

// transportFactory: () => transport object for createToolExecutors.
// opts.onEffectiveTools(names|null, error?): optional callback/test seam —
// invoked INSIDE setup AFTER transform with the FINAL effective catalog
// observed via the real ctx.tool.list() (built-ins + our product finance
// tools: the two P2 reads by default, three with the P3 opt-in). In production
// the setup runs on the prompt loop (needs a provider), so live capture is
// exercised by the admission-only real-SDK catalog probe (no inference); unit
// tests drive this seam with a faithful ctx double to prove exactly the
// product finance tools.
// opts.env: optional env object for the P3 opt-in gate (defaults to
// process.env) — lets tests prove default-off/opt-in/production-off without
// mutating process state.
// Returns the plugin definition object for Plugin.define(id, setup).
export function defineTedFinancePlugin(transportFactory, { onEffectiveTools = null, env = process.env, proposalIntents = proposalIntentRegistry } = {}) {
  if (typeof transportFactory !== 'function') {
    throw new Error('defineTedFinancePlugin: transportFactory (() => transport) is required');
  }
  const executors = createToolExecutors(transportFactory(), { proposalIntents });
  return {
    id: 'ted-finance',
    async setup(ctx) {
      // No-automatic-retry veto (user explicit rule, PR290-RETRY-HOOK):
      // supported boundary ONLY — native 2.2.4 `session.hook('retry')`
      // (SessionRetry.decision: {retry:false}|{retry:true,delay:number}).
      // Runs after classification before scheduling and can veto; there is
      // no config field and no fixture/header workaround. TED sessions get
      // `decision = { retry:false }`; non-ted sessions are untouched.
      // Missing hook or registration failure fails setup closed BEFORE any
      // tool registers (never a silent retry-allowed boot).
      const sessionDomain = ctx && ctx.session ? ctx.session : null;
      if (!sessionDomain || typeof sessionDomain.hook !== 'function') {
        throw new Error('defineTedFinancePlugin.setup: ctx.session.hook (native 2.2.4 session retry hook) is required — failing closed, no tools registered');
      }
      await sessionDomain.hook('retry', (event) => {
        if (event && event.agent === 'ted') {
          event.decision = { retry: false };
        }
      });
      // Native permission capture (Plugin 2.2.4: `permission.assert` lives
      // on the SETUP context, not on the tool execution context). Bound
      // once here and closed over by every registered execute below; a
      // missing setup permission API fails closed with NO tools registered.
      const setupPermission = ctx && ctx.permission ? ctx.permission : null;
      const capturedAssert = setupPermission && typeof setupPermission.assert === 'function'
        ? setupPermission.assert.bind(setupPermission)
        : null;
      if (!capturedAssert) {
        throw new Error('defineTedFinancePlugin.setup: ctx.permission.assert is required (Plugin 2.2.4 setup Context) — failing closed, no tools registered');
      }
      // Effective catalog = native built-ins + our product finance tools. The
      // capture runs AFTER transform (pinned V2 semantics: ctx.tool.list()
      // reads current registrations after every transform), so the observed
      // list is the final prompt-loop catalog the test gates.
      await ctx.tool.transform((editor) => {
        for (const def of productToolDefs(env)) {
          editor.add({
            name: def.name,
            description: def.description,
            input: def.input,
            output: def.output,
            // Availability is decided by the native catalog from
            // `options.permission ?? name` (@opencode/core 2.2.4 Tool.snapshot).
            // Without this, the availability action is the tool NAME, which
            // matches only the agent's `{*,*,deny}` and hides every finance
            // tool from the loop. The finance action makes the exact-resource
            // allow visible to the catalog; execute still asserts per tool.
            options: { permission: TED_FINANCE_PERMISSION_ACTION },
            execute: buildExecute(def, executors[def.name], capturedAssert),
          });
        }
      });
      if (typeof onEffectiveTools === 'function') {
        try {
          onEffectiveTools(await getEffectiveToolNames(ctx), null);
        } catch (e) {
          onEffectiveTools(null, e);
        }
      }
    },
  };
}
