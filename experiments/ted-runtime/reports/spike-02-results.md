# Spike 02 (Steps 2-3) — results: TED finance gateway + native plugin

Date: 2026-10-30. Branch: `experiment/ted-opencode-runtime` (base `2d3e962`
preserved; spike 02 adds new commit(s) only). Scope: Steps 2-3 only.
No push/PR/merge/deploy. No paid LLM, no production DB, no real credentials,
reads-only against the repo's own synthetic test stack.

## Verdict

- `tests/spike-02.test.mjs`: **18/18 PASS** (~35s, deterministic, no LLM).
- `tests/spike-01.test.mjs` regression: **7/7 PASS** (untouched files).
- All 14 integration cases + gates G2-01..G2-04, G3-01..G3-06 GREEN.

## What was built (all under `experiments/ted-runtime/`)

| File | Role |
|---|---|
| `bootstrap/ted-finance-tools.mjs` | Shared tool defs (`list_accounts`, `get_month_summary`) + strict arg validation + executors. Single source imported by BOTH the native plugin and the gateway, so tool-integration tests exercise the SAME execute functions the plugin registers. |
| `bootstrap/finance-transport.mjs` | One-shot tsx bridge spawner (spawn + explicit stdin write/end, per-call host token via stdin, route allowlist, timeout, secret scrub). |
| `bootstrap/finance-bridge.ts` | TS bridge executed via the repo's own tsx: imports the REAL `buildTestApp` + REAL fixtures (`apps/api/tests/…`). No financial logic reimplemented. |
| `bootstrap/plugins/ted-finance/index.mjs` | Single TED plugin, native `Plugin.define({id, setup})` + `ctx.tool.transform(editor => editor.add(tool))`. |
| `bootstrap/ted-gateway.mjs` | Restricted facade (sessions CRUD + read-only catalogs + 2 finance tools). Only module holding the full OpenCode instance. Frozen, no `call`/admin surface. |
| `bootstrap/run-finance-check.mjs` | G2-01 proof runner (own process, identity `c`): native plugin registration → polls effective catalog → marker with native `tool.list()` contents. |
| `tests/spike-02.test.mjs` | 14 integration cases + gates. |

## Native plugin interface (verified against installed 2.2.4 `.d.ts`)

- `bootstrap/node_modules/@opencode/plugin/dist/promise/plugin.d.ts` — `Context.tool: ToolDomain`; `Plugin { id, setup(ctx) }`, `define(plugin)`.
- `bootstrap/node_modules/@opencode/plugin/dist/promise/tool.d.ts` — `ToolDomain { transform, reload, list, hook }`; `ToolEditor.add(tool: Info)` with `Info { name, input, description, execute(input, ctx) => Promise<Result> }`.
- `bootstrap/node_modules/@opencode/plugin/dist/promise/registration.d.ts` — `Transform<Input> = (callback) => Promise<Registration>`.
- `bootstrap/node_modules/@opencode/schema/dist/config.d.ts:92` + `config/plugin.d.ts` — config `plugins: (string|Entry)[]`; strings must be directories (`managed-policy-136xnga9.js:108-111`).
- Discovery: `PluginSourceDirectory.discover` reads `<config>/plugin/` + `<config>/plugins/`; `Host.resolve({directory})` uses conventional root `server`/`index` (`@opencode/plugin/dist/host.js`); node resolves `.mjs` via extension probing (`@opencode/util/dist/runtime/import.node.js`).
- G2-01 proof: `plugin.list` shows `ted-finance` with `state.status: "active"`, `source.type: "sdk"`, `features.server: true`; marker file carries the NATIVE post-transform catalog (`ctx.tool.list()`), containing `list_accounts` + `get_month_summary` alongside the 20 native builtins.

## Key findings (why the code looks like this)

1. **`ctx.tool.add` does not exist on the host context.** The `ToolDomain`
   exposes only `transform/reload/list/hook` (proven by dumping the real ctx
   keys via a diagnostic plugin through the SDK path). Registration MUST go
   through `ctx.tool.transform(editor => editor.add(tool))`. An initial
   version calling `ctx.tool.add(...)` failed with
   `TypeError: ctx.tool.add is not a function` (adapter.js:482 calling setup).
   Failing guess corrected with evidence; no docs were copied unverified.
2. **No direct tool-invoke API exists in the 2.2.4 SDK.** `oc.tool` is
   `undefined`; `@opencode/sdk/dist/*.d.ts` re-exports only Tool *types*.
   Execution runs only via the agent prompt loop (LLM inference — never
   invoked here: no paid inference). Adaptation (as anticipated): tools are
   registered natively AND the deterministic harness calls the same execute
   functions directly with a host-bound context — labeled tool-integration,
   not conversational eval. Prompt-loop LLM isolation stays an untested limit.
3. **Config-file local-plugin discovery is environmentally BLOCKED here.**
   Every file-based local plugin — including a zero-import minimal
   `{id, setup(){}}` probe — stays in `state: "failed"` ("Plugin failed to
   load") BEFORE `setup()` ever runs (no marker, empty ctx dump), while the
   identical module via `oc.plugin()` reaches `active` with both tools in the
   native catalog. Pre-setup file-pipeline failure (reload-hook / file-watch
   backend reports unsupported in this embedded Windows env); registration
   mechanism (define/setup/transform/editor.add) is identical post-load.
   `run-finance-check` therefore uses the SDK's native plugin interface
   (`oc.plugin(pluginObject)` — SDK `Interface`, `sdk/dist/promise.d.ts`),
   which is the same native pipeline minus the broken file-discovery step.
4. **`plugin.list` is eventually consistent.** Immediately after boot it
   returns `[]`; builtins settle after ~1–15s; a runtime registration triggers
   a reload window with empty lists. All catalog reads poll with timeout
   (documented harness behavior, not a product claim).
5. **`execFile` + `input` hangs against the tsx child in this env**
   (bridge never sees EOF; kill only via timeout), while the identical payload
   via `spawn` + explicit stdin write/end completes in ~1.3s. Transport uses
   spawn (no shell, argv carries no secrets). Harness plumbing only.
6. **Value validation belongs to the real handlers.** The tool validates
   shape (required keys, known keys, string types) and rejects identity keys
   (`actorId/workspaceId/token/…`) pre-transport; enum VALUES (`kind`,
   `includeInactive`, `yearMonth` format) pass through so the REAL route
   returns the REAL 400 (`validation.error`, never fabricated zeros).

## Contracts verified (§5, real handlers, synthetic data)

- `list_accounts` → `GET /accounts` (identity-scoped server-side):
  A sees exactly Itaú (100000) + Nubank (50000); B sees exactly Bradesco;
  empty seed → `200 {items:[],total:0}` (distinct from error).
- `get_month_summary` → `GET /dashboard/month-summary?yearMonth=YYYY-MM`:
  A/2026-06 exact `{incomeCents:1200000, expenseCents:288050,
  balanceCents:911950, transactionCount:4}`; B/2026-06 exact
  `{0, 20000, -20000, 1}`; empty month → zeros + `transactionCount: 0`;
  `2026-13` → real `400 validation.error` with no totals keys.
- Failure mapping: 401 (bad token), 403 (denying `WorkspaceAccessStore`
  through the REAL middleware branch `index.ts:388-394`,
  `auth.workspace_forbidden`), 500 (exploding token store through the REAL
  `handleError` rethrow), timeout (tool-level deadline over harness delay),
  all fail-closed with real status/body passthrough — never empty lists or
  zero-filled totals.
- Identity (§6): host-bound frozen context per facade (`label/token/
  household/actorId/deviceId`); token travels per-call via child stdin, never
  in args/results; transport scrubs token substrings defense-in-depth;
  interleaved A/B calls stay scoped (no global mutable token); error-text
  scan over all failure modes finds no `dev-token-1/2`, `boom-token`, or
  provided bad token.
- Facade (§3): exact 7-key allowlist, frozen; no `shell/prompt/edit/call/
  mcp/subagent/tool/config/host/token`; no dynamic dispatch; `hasToolCatalog:
  false` documents the absent 2.2.4 tool-catalog endpoint.

## Custom code vs native (why it exists)

- `ted-gateway.mjs` (facade): 2.2.4 has no restricted-surface primitive —
  policy governs the prompt loop, NOT direct API (spike-01 bypass probe);
  removal-by-omission is the only enforceable boundary. Custom, minimal.
- `finance-transport.mjs` + `finance-bridge.ts`: no direct tool-invoke API
  and handlers are TS while the harness is plain node — thinnest adapter is a
  one-shot tsx process into the repo's REAL test app (minimal runner already
  in the repo). Custom plumbing only; zero financial logic.
- `ted-finance-tools.mjs` arg validation: structural pre-checks so identity
  keys can never reach the wire; domain validation stays with handlers.

## Limits (untested, recorded)

- Prompt-loop LLM invocation of the registered tools (requires paid
  inference; by scope decision).
- Config-file plugin discovery path (environmentally blocked, see §3 above).
- The 403 branch variant requiring Better-Auth session + workspace store
  (synthetic app covers the device-token 403 branch only).
- `skill_routing`/`mcp_routing`/adaptive behavior: untouched (G3-06 asserts
  no new frameworks: deps still the 4 pinned spike packages).

## Reproduce

- `node --test tests/spike-02.test.mjs` (bootstrap cwd, `TED_HOME_ROOT`
  set by the test itself) — 18/18.
- `node --test tests/spike-01.test.mjs` — 7/7 regression.
- `node run-finance-check.mjs c` — G2-01 standalone proof JSON.
