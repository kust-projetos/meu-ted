# Spike 03A — results: host-bound session bindings on the native tool path

Date: 2026-10-30. Branch: `experiment/ted-opencode-runtime` (base `44bfdee`
preserved; spike 03A adds working-tree changes only — NOT committed, pending
Planner review). Scope: session-bound identity for the natively registered
finance tools. No push/PR/merge/deploy. No paid LLM, no production DB, no
real credentials, reads-only against the repo's own synthetic test stack.

## Verdict (preliminary: PASS for the deterministic scope)

- `tests/spike-03a.test.mjs`: **17/17 PASS** (~35s, deterministic, no LLM).
- `tests/spike-02.test.mjs` regression: **20/20 PASS** (untouched behavior).
- `tests/spike-01.test.mjs` regression: **7/7 PASS** (untouched files).
- TDD was RED-first: the new suite was run BEFORE the fix (missing
  `session-bindings.mjs` → `before` hook failed on `env exposes session
  bindings for tests`; the spike-02 plugin ignores `ctx`, so every bound
  call fail-closed hostless) — RED proven, then GREEN after the fix.

## What was built (all under `experiments/ted-runtime/`)

| File | Change |
|---|---|
| `bootstrap/session-bindings.mjs` (new, 108 lines) | In-memory `Map<sessionID, Binding>` registry. `Binding = {sessionID, host (frozen), boundAt, expiresAt\|null, revoked}`. `bindSession` (freeze+validate 5 host fields, idempotent same-host, `host_binding_mismatch` on different-host without overwrite, fresh bind over revoked/expired allowed), `resolveHost` (`host_context_required` / `host_binding_revoked` / `host_binding_expired`), `revokeSession` (tolerant), `clearAll`, `getBinding` (tests), `bindWithTTL`. Error text never carries tokens; never reads `process.env`. |
| `bootstrap/plugins/ted-finance/index.mjs` (+37/−13, then fix-r2) | `execute(input, ctx, opts)` now extracts native `ctx.sessionID/agent/messageID/id/signal`, resolves the host EXCLUSIVELY via `session-bindings` (typed `metadata.code` preserved: `host_context_required`, `host_binding_*`), fail-closes `tool.cancelled` on aborted signal BEFORE transport, forwards the live `signal` to the transport for mid-flight abort (fix-r2), defaults `intentionId` to the native callID (`ctx.id`), passes test-only transport opts (seed/delayMs/timeoutMs/…) through. Already-native errors pass through unwrapped. Legacy hostless call shape still fail-closes (spike-02 test 16 GREEN unchanged). |
| `bootstrap/finance-transport.mjs` (fix-r2) | `callFinance` accepts `{signal}`: pre-spawn abort throws `tool.cancelled` without spawning; mid-flight abort kills the bridge child and rejects `tool.cancelled` (listener removed on every settle; cancel messages carry the route only, never tokens). Existing timeout path untouched. |
| `bootstrap/ted-finance-tools.mjs` (fix-r2) | Executor rethrows `tool.cancelled` unwrapped (same as `tool.timeout`) so cancellation survives to the plugin's `toNativeError` as `metadata.code: tool.cancelled`. |
| `bootstrap/ted-gateway.mjs` (+20/−2, then fix-r1) | `facadeFor(host).createSession` auto-binds the new session to the facade's frozen host; `removeSession` revokes the binding ONLY after a successful remove (fix-r1: no `finally` — a failed remove leaves the binding intact). Env (NOT the facade) additionally exposes `bindings` for tests. Facade keeps its exact 7-key frozen surface. |
| `tests/spike-03a.test.mjs` (new, 355 lines → +r3/r4) | 17 cases (r0–l driving the REAL captured `execute` fns with synthetic `Tool.Context` objects through the REAL bridge handlers, plus r1–r4 remediation cases below). |
| `reports/spike-03a-results.md` | This file (draft). |

## Native fields used (and how each was verified, not assumed)

- `Tool.Context = {sessionID, agent, messageID, id:CallID, progress}` + `signal`/`progress` on the promise-API ToolContext — read in `bootstrap/node_modules/@opencode/schema/dist/tool.d.ts:10-16` and `bootstrap/node_modules/@opencode/plugin/dist/promise/tool.d.ts:9-15`; `adapter.js` `executePromiseTool` spreads context+signal into `execute`.
- Tool hooks `execute.before/after` carry `{tool, sessionID, agent, messageID, id, input}` — `promise/tool.d.ts:29-51`, core chunk `managed-policy-*.js` `beforeExecute`/`executeTool`.
- Executor is invoked via `Tool.execute` in the prompt loop (`session.prompt` → LLM) and via codemode check; retries mint a new CallID per index; cancellation arrives via `AbortSignal`/Effect interrupt; concurrency is allowed; restart persists session rows in sqlite but NOT in-memory state.
- There is NO `oc.tool` catalog in 2.2.4; registration stays `ctx.tool.transform(editor.add)`; config-file discovery stays environmentally blocked, so `oc.plugin()` is used as in `run-finance-check.mjs`.

## Tests (all deterministic, handlers real, values exact as spike-02)

- (r0) `oc.plugin()` registration still ACTIVE with both tools in the native catalog (subprocess proof).
- (a) A-bound session → Itaú 100000 + Nubank 50000, June `{1200000, 288050, 911950, 4}` exact.
- (b) B-bound session → Bradesco only, June `{0, 20000, −20000, 1}` exact.
- (c) Unknown/empty/missing ctx → `host_context_required` (incl. legacy no-ctx shape).
- (d) Revoked → `host_binding_revoked`; TTL-past → `host_binding_expired` (no sleeps).
- (e) B-session re-bind to A → `host_binding_mismatch`, binding unchanged, execute still B; same-host re-bind idempotent OK.
- (f) `Promise.all` A+B → 2 and 1, no crossover.
- (g) Two turns (distinct messageID/callID) on one session → both OK, one household.
- (h) Device change without revoke → mismatch; revoke + rebind new device → executes as new identity.
- (i) Restart: sqlite row reopens, binding gone (`clearAll` simulates process memory loss) → `host_context_required` until re-bind → identical totals; `removeSession` revokes.
- (j) `delayMs>timeoutMs` → `tool.timeout`, immediate retry OK; two callIDs share the binding; a callID used AS sessionID resolves nothing; aborted signal → `tool.cancelled` pre-transport.
- (k) Facade still exactly 7 keys, frozen, no shell/edit/call/mcp/subagent/tool/config/host/token/bindings.
- (r1) Failed `removeSession('ses_nonexistent_xxx')` on a bound-but-rowless ID fails and leaves `getBinding(...).revoked === false`.
- (r2) Abort mid-flight (`delayMs: 2000`, abort at ~100ms) rejects with `tool.cancelled`; immediate retry without signal/delay returns exact A June totals.
- (r3) Cross-identity `facadeA.removeSession(sB)` fails with `host_binding_mismatch` (`.code`, not metadata — the facade throws `ToolError` directly); the sqlite row stays gettable via `facadeB.getSession`, the binding stays valid (native `list_accounts` on `sB` still returns Bradesco-only), then owner `facadeB.removeSession(sB)` succeeds and revokes.
- (r4) Abort-listener hygiene: pre-aborted stub signal rejects `tool.cancelled` with zero `addEventListener` calls; a live stub signal over a REAL `/accounts` bridge call resolves 200 with zero listeners left; structural assertion that the sync-spawn `catch` contains `removeEventListener` (spawn sync-throw is not behaviorally reachable — it only throws on invalid args — so that path is covered structurally, documented here).

## Remediation r1/r2 (independent review, 2026-10-30 — TDD RED→GREEN)

- **r1 — `removeSession` revoked on failure (MEDIUM, cross-identity DoS):** the `finally` revoked the binding even when `oc.session.remove` threw (NOTFOUND/error), so facade A could revoke another identity's binding. Fix (`ted-gateway.mjs`): revoke ONLY after a successful remove (`const removed = await …; revokeSession(…); return removed;` — no `finally`). RED: new test failed with `revoked === true` after the failed remove. GREEN after the fix; test (i)'s success-path revoke assertion still passes.
- **r2 — cancel pre-transport only, no mid-flight propagation (MEDIUM):** the plugin checked `signal.aborted` once and never forwarded the signal, so an abort during `await run` ran to completion. Fix (minimal, no OpenCode changes needed): plugin forwards the live signal (`run(input, host, {…opts, intentionId, signal})`); `finance-transport.mjs` `callFinance({… signal})` throws `tool.cancelled` pre-spawn without spawning, and mid-flight kills the bridge child + rejects `tool.cancelled` (listener removed on settle; cancel messages carry the route only, never tokens; timeout path untouched); `ted-finance-tools.mjs` rethrows `tool.cancelled` unwrapped so the plugin surfaces `metadata.code: tool.cancelled`. RED: aborted mid-flight call succeeded (`ok === true`). GREEN after the fix, incl. exact-totals retry. Pre-aborted case from test (j) still passes unchanged.
- Validation: `tests/spike-03a.test.mjs` **15/15**, `tests/spike-02.test.mjs` **20/20**, `tests/spike-01.test.mjs` **7/7** (cwd `experiments/ted-runtime/bootstrap`). `git status`: only files under `experiments/ted-runtime/` (4 modified + 3 new). No commit/push/deploy.

## Remediation r3/r4 (re-review, 2026-10-30 — TDD RED→GREEN)

- **r3 — `removeSession` allowed cross-identity delete on success (MEDIUM, DoS):** fix-r1 only guarded the failure path; on success `facadeFor(A).removeSession(sB)` deleted B's sqlite row AND revoked B's binding (shared DB + shared registry in env 'c'). Fix (minimal, no auth framework): new exported `isSameHost(a, b)` in `session-bindings.mjs` (5-field equality, null-safe, no value leakage); `ted-gateway.mjs removeSession` reads `getBinding(sessionID)` first and throws `ToolError('host_binding_mismatch', …)` BEFORE any remove when a binding exists for a different host (nothing removed, nothing revoked — generic message, no tokens). Unbound IDs, or IDs bound to the same host (even revoked/expired), keep the r1 success→revoke path. Deliberately NOT extended to `getSession`/`listSessions` (metadata without finance data — out of scope). RED: new test failed with the remove succeeding (`ok === true`). GREEN after the fix; r1 + (i) success-revoke assertions still pass; facade surface still exactly 7 keys ((k) GREEN).
- **r4 — abort listener leaked on synchronous spawn throw (LOW):** the listener was registered before `spawn()`; the spawn `catch` rethrew without removing it or passing through `finish`. Fix: the `catch` now calls `signal.removeEventListener('abort', onAbort)` (best-effort) before throwing the same `tool.transport` error (throw inside the Promise executor still rejects; no timer exists yet on that path, so no other cleanup applies). Test: behavioral where reachable (stub-signal counting `addEventListener`/`removeEventListener`: pre-abort registers zero, live-signal success leaves zero after a REAL bridge call) + structural source assertion for the unreachable sync-throw path (explicitly documented as structural in the test comment). RED: structural assertion failed pre-fix (`spawn catch` had no `removeEventListener`); the two behavioral halves passed pre-fix as leak-guards. GREEN after the fix.
- Validation: `tests/spike-03a.test.mjs` **17/17**, `tests/spike-02.test.mjs` **20/20**, `tests/spike-01.test.mjs` **7/7** (cwd `experiments/ted-runtime/bootstrap`). `git status`: only files under `experiments/ted-runtime/`. No commit/push/deploy.
- (l) Token scan over all bound-execute outputs + binding errors: zero leaks.

## Limitations

- Prompt-loop LLM invocation still untested (no paid inference by scope); the binding path is proven for direct `execute(input, syntheticCtx)` calls carrying the real native context shape, not for a live LLM turn.
- In-process restart simulation: same-process recreate + explicit `clearAll()` stands in for process memory loss (documented in test (i)); a true two-process restart probe was not run.
- TTL expiry uses wall-clock `Date.now()`; the suite pins expiry with negative-TTL binds (no flaky sleeps).
- `execute`'s third `opts` param (seed/delayMs/timeoutMs passthrough) is a test-harness convenience, not part of the native `execute(input, ctx)` signature — the native caller passes two args and is unaffected.

## Risks

- The bindings map is process memory: any real multi-process/host deployment needs a shared store or sticky routing, else bindings vanish exactly as test (i) proves. No fork required for THIS spike, but 03B must decide the store before any production-shaped claim.
- ~~`removeSession` revokes best-effort in `finally` — a crash between remove and revoke leaves a revoked-less orphan until process end; acceptable for a spike, must be revisited if bindings ever gate writes.~~ Fixed by r1 (2026-10-30): revoke happens ONLY after a successful remove, so a failed remove leaves the binding intact; a crash between remove and revoke still leaves a revoked-less orphan until process end — acceptable for a spike, must be revisited if bindings ever gate writes.
- No rate limiting or binding introspection beyond `getBinding` (tests only); the registry is deliberately minimal — not an auth framework.

## Prompt-loop status

Unchanged from spike-02: native registration proves CATALOG PRESENCE ONLY. Any hostless prompt-loop invocation still fail-closes (`host_context_required`); a prompt-loop invocation WITH a real native context would now resolve via the binding its session received at creation — but that path requires LLM inference and remains untested by scope decision.

## Recommendation for 03B

Preliminary **PASS** for the deterministic scope (17/17 after r1–r4 remediation); proceed to 03B to (1) prove a REAL prompt-loop turn resolves the binding end-to-end (needs an inference budget or a stubbed model path — scope decision for the Planner), (2) decide the binding store for multi-process/restart durability (sqlite-backed bindings vs. re-bind-on-boot contract), and (3) pin the `opts` passthrough contract (keep test-only vs. promote per-turn overrides). No commit in this task — working tree left ready for Planner review (`git status`: only files under `experiments/ted-runtime/`).
