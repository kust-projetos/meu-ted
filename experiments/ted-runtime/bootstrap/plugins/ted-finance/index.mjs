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
import { TOOL_DEFS, createToolExecutors } from '../../ted-finance-tools.mjs';
import { callFinance } from '../../finance-transport.mjs';

const executors = createToolExecutors(callFinance);

function toNativeError(toolName, e) {
  const message = String((e && e.message) || e).slice(0, 500);
  const metadata = {};
  if (e && typeof e.code === 'string') metadata.code = e.code;
  if (e && typeof e.statusCode === 'number') metadata.statusCode = e.statusCode;
  if (e && e.body !== undefined) metadata.hasBody = true;
  return new ToolError({ message: `${toolName}: ${message}`, metadata });
}

export default Plugin.define({
  id: 'ted-finance',
  async setup(ctx) {
    // Host-bound identity (§6): tool execute functions take the host context
    // as a parameter. The native prompt-loop path carries no deterministic
    // synthetic host in this spike, so a prompt-loop invocation arrives here
    // WITHOUT a host and fail-closes in the transport (tool.invalid_args:
    // host-bound token required). The deterministic harness calls the same
    // `run` functions directly WITH a host (ted-gateway.mjs). Prompt-loop
    // LLM isolation therefore stays an untested limit (documented).
    await ctx.tool.transform((editor) => {
      for (const def of TOOL_DEFS) {
        const run = executors[def.name];
        editor.add({
          name: def.name,
          description: def.description,
          input: def.input,
          execute: async (input) => {
            try {
              const body = await run(input, undefined, {});
              return { output: body, content: [{ type: 'text', text: JSON.stringify(body) }] };
            } catch (e) {
              throw toNativeError(def.name, e);
            }
          },
        });
      }
    });
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
