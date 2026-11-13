// TED finance plugin (spike 02) — NATIVE 2.2.4 registration.
//
// Loaded by the OpenCode 2.2.4 host as a local directory plugin (Host.resolve
// conventional entry: this index.mjs; id from Plugin.define).
//
// Registration interface (verified against installed 2.2.4 .d.ts):
//   - bootstrap/node_modules/@opencode/plugin/dist/promise/plugin.d.ts:
//       Context.tool: ToolDomain; Plugin { id, setup(ctx) } + define()
//   - bootstrap/node_modules/@opencode/plugin/dist/promise/tool.d.ts:
//       ToolDomain { transform, reload, list, hook } — tools are added through
//       transform((editor: ToolEditor) => void); ToolEditor.add(tool: Info)
//       where Info { name, input, description, execute(input, ctx), ... }.
//     Direct ctx.tool.add does NOT exist on the host context (proven:
//     TypeError via oc.plugin path); transform is the native mechanism.
//   - bootstrap/node_modules/@opencode/plugin/dist/promise/registration.d.ts:
//       Transform<Input> = (callback) => Promise<Registration>
//
// Tool execution inside OpenCode runs ONLY via the agent prompt loop
// (session.prompt -> LLM inference), which this spike never invokes (no paid
// inference). The SAME execute functions below are therefore also exposed to
// the deterministic test harness (ted-gateway.mjs) which calls them directly
// with a host-bound context — labeled tool-integration, NOT conversational
// eval (prompt-loop LLM isolation stays an untested limit).

import fs from 'node:fs';
import path from 'node:path';
import { Plugin } from '@opencode/plugin';
import { Error as ToolError } from '@opencode/plugin/promise/tool';
import { TOOL_DEFS, createToolExecutors, deriveIntentionId } from '../../ted-finance-tools.mjs';
import { callFinance } from '../../finance-transport.mjs';
import { resolveHost } from '../../session-bindings.mjs';

const executors = createToolExecutors(callFinance);

function toNativeError(toolName, e) {
  const message = String((e && e.message) || e).slice(0, 500);
  const metadata = {};
  if (e && typeof e.code === 'string') metadata.code = e.code;
  if (e && typeof e.statusCode === 'number') metadata.statusCode = e.statusCode;
  if (e && e.body !== undefined) metadata.hasBody = true;
  return new ToolError({ message: `${toolName}: ${message}`, metadata });
}

// Execute-closure builder (exported for tests; setup() wires the REAL
// executors below). The stable intention is derived HERE in the plugin via
// deriveIntentionId({sessionID, messageID}); the executor only GUARDS that a
// stable opts.intentionId is present. The native CallID (ctx.id) travels ONLY
// as technical correlation (opts.callId). P1: tool-call opts forward ONLY the
// allowlisted passthrough fields — host/route/method are owned by the
// executor and can never be smuggled through opts.
// LIMIT 03B PASS (restored 2026-10-31; P1 hook removed).
//
// Enforcement = config denies (shell/edit/write/subagent + provider
// deny-all with single allow -- see run-03b-turn build03BConfig) + runner
// pre-prompt fail-closed on non-readonly expects + immediate interrupt +
// journey abort on first foreign observation (post-observation) + trace
// evidence. There is NO total pre-execution gate on the codemode execute
// wrapper in this runtime: the hook input is {code:string} and the inner
// finance target resolves only after execution, so validating the target
// in the hook is impossible; allowing execute unchecked would reopen
// access. Redesign at that point would be NEW INFRA, out of scope
// (SPIKE 04 section 7/10). Total wrapper pre-execution enforcement is therefore
// a KNOWN LIMITATION (same as 03B PASS) and a future standalone
// experiment -- NOT attempted here, and deliberately NOT approximated by
// regex over code (brittle, bypassable, false-positive prone).

export function buildExecute(def, run) {
  return async (input, ctx, opts = {}) => {
    try {
      if (!ctx || typeof ctx.sessionID !== 'string' || ctx.sessionID.length === 0) {
        throw new ToolError({
          message: `${def.name}: host-bound session context is required — hostless execution is blocked by design`,
          metadata: { code: 'host_context_required' },
        });
      }
      // Native context fields, kept explicit (agent/messageID are
      // observed, not enforced — identity comes from the binding).
      const { sessionID, agent, messageID, id, signal } = ctx;
      void agent;
      void messageID;
      if (signal && signal.aborted) {
        throw new ToolError({
          message: `${def.name}: tool cancelled before execution`,
          metadata: { code: 'tool.cancelled' },
        });
      }
      const host = resolveHost(sessionID);
      // Stable intention, never the CallID: retries mint a new ctx.id
      // but re-derive the same intention for this session+message.
      // A missing messageID fails closed via deriveIntentionId
      // (tool.invalid_args, code preserved below) — no random
      // fallback, no ctx.id fallback. CallID rides along ONLY as
      // technical correlation for traces/timeouts.
      const intentionId = deriveIntentionId({ sessionID, messageID });
      let callId;
      if (typeof id === 'string' && id.length > 0) {
        callId = id;
      } else {
        callId = undefined;
      }
      const o = opts || {};
      const body = await run(input, host, {
        seed: o.seed,
        fault: o.fault,
        workspaceId: o.workspaceId,
        tokenStore: o.tokenStore,
        access: o.access,
        delayMs: o.delayMs,
        timeoutMs: o.timeoutMs,
        signal: signal ?? o.signal,
        intentionId,
        callId,
      });
      return { output: body, content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (e) {
      if (e && e.metadata && typeof e.metadata.code === 'string') throw e;
      throw toNativeError(def.name, e);
    }
  };
}

export default Plugin.define({
  id: 'ted-finance',
  async setup(ctx) {
    // Host-bound identity (§6 + spike 03A): the native prompt-loop carries the
    // session in Tool.Context ({sessionID, agent, messageID, id:CallID} +
    // signal — 2.2.4 Tool.Context per plugin/dist/promise/tool.d.ts:9-15).
    // execute() extracts ctx.sessionID/messageID/id/signal and resolves the
    // host EXCLUSIVELY via session-bindings (bound at session creation by the
    // host through ted-gateway.mjs). No ctx/sessionID => host_context_required;
    // revoked/expired => typed host_binding_* (metadata.code preserved); an
    // already-aborted signal => tool.cancelled BEFORE any transport call.
    // The live signal is additionally forwarded to the transport (fix-r2) so
    // a mid-flight abort kills the bridge child and rejects tool.cancelled.
    // Model-chosen IDs are turns, never identity: only the host-bound
    // sessionID key resolves, the financial intention is derived STABLY via
    // deriveIntentionId({sessionID, messageID}) so retries (fresh CallIDs)
    // share ONE intention (spike 03A-T3), and the native CallID (ctx.id)
    // travels ONLY as technical correlation (opts.callId) — never as
    // identity, never as intentionId.
    await ctx.tool.transform((editor) => {
      // 05L HIGH-allowlist: TED_FINANCE_TOOLS_CSV restricts native
      // registration to the listed tools ONLY. Unset/empty => all TOOL_DEFS
      // (preserves 03B frozen behavior — 03B never sets it). 05L boot sets
      // CSV=list_accounts,list_categories,propose_expense.
      const csvRaw = process.env.TED_FINANCE_TOOLS_CSV;
      const csvList = typeof csvRaw === 'string' && csvRaw.trim().length > 0
        ? csvRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : null;
      const defs = csvList ? TOOL_DEFS.filter((d) => csvList.includes(d.name)) : TOOL_DEFS;
      for (const def of defs) {
        editor.add({
          name: def.name,
          description: def.description,
          input: def.input,
          // 03B-T1 fix: the native 2.2.4 loop rejects {output} results from
          // tools registered WITHOUT an output schema — forward it.
          output: def.output,
          execute: buildExecute(def, executors[def.name]),
        });
      }
    });
    // LIMIT 03B PASS: NO execute.before hook (P1 removed 2026-10-31).
    // Total wrapper pre-execution enforcement is a known limitation;
    // enforcement here is post-observation (runner interrupt + abort).
    // Registration proof (G2-01): the native post-transform catalog read.
    // Marker is written ONLY after transform + list succeed, and ONLY when
    // the harness requests it via env (normal boots stay side-effect free).
    const marker = process.env.TED_FINANCE_MARKER_FILE;
    if (marker) {
      const tools = await ctx.tool.list();
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(
        marker,
        JSON.stringify({
          plugin: 'ted-finance',
          tools: tools.map((t) => t.id || t.name),
          at: new Date().toISOString(),
        }),
      );
    }
  },
});
