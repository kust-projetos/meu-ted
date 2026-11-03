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
// functions below are exercised deterministically through the facade with a
// host-bound context.
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

export const PRODUCT_TOOL_NAMES = ['list_accounts', 'get_month_summary'];

// P3 prerequisite (read-only category lookup for a FUTURE expense proposal):
// exposed ONLY as a local opt-in — TED_OPENCODE_P3_READS_ENABLED=1 with
// NODE_ENV !== 'production'. Production forces it off (fail closed): a
// production NODE_ENV never exposes the extra read, even with the flag set.
// The default product catalog is exactly PRODUCT_TOOL_NAMES (P2 behavior).
export const P3_READ_TOOL_NAMES = ['list_categories'];

export function isP3ReadsEnabled(env = process.env) {
  try {
    if (!env || typeof env !== 'object') return false;
    if (env.TED_OPENCODE_P3_READS_ENABLED !== '1') return false;
    return env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

export function productToolDefs(env = process.env) {
  const names = isP3ReadsEnabled(env) ? [...PRODUCT_TOOL_NAMES, ...P3_READ_TOOL_NAMES] : [...PRODUCT_TOOL_NAMES];
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

// Pure execute-closure builder (host-resolved, intention-stable). Exported
// for tests; setup() wires the real executors below.
export function buildExecute(def, run) {
  return async (input, ctx, opts = {}) => {
    const { ToolError } = await import('./tool-defs.mjs');
    try {
      if (!ctx || typeof ctx.sessionID !== 'string' || ctx.sessionID.length === 0) {
        throw new ToolError('host_context_required', `${def.name}: host-bound session context is required — hostless execution is blocked by design`);
      }
      const { sessionID, messageID, id, signal } = ctx;
      if (signal && signal.aborted) {
        throw new ToolError('tool.cancelled', `${def.name}: tool cancelled before execution`);
      }
      const host = resolveHost(sessionID);
      // Stable intention per session+message (retries share ONE intention);
      // the native CallID (ctx.id) travels ONLY as technical correlation.
      const intentionId = deriveIntentionId({ sessionID, messageID });
      const o = opts || {};
      const body = await run(input, host, {
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
      throw new TE('tool.transport', `${def.name}: ${(e && e.message) || e}`);
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
export function defineTedFinancePlugin(transportFactory, { onEffectiveTools = null, env = process.env } = {}) {
  if (typeof transportFactory !== 'function') {
    throw new Error('defineTedFinancePlugin: transportFactory (() => transport) is required');
  }
  const executors = createToolExecutors(transportFactory());
  return {
    id: 'ted-finance',
    async setup(ctx) {
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
            execute: buildExecute(def, executors[def.name]),
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
