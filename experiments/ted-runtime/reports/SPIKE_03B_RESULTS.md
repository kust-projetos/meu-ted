# SPIKE 03B — results: first real OpenCode prompt-loop turn with TED finance tools

Date: 2026-10-31. Worktree: `D:/projetos/pi-ted-runtime-spike`, branch
`experiment/ted-opencode-runtime` (base checkpoint `1567dae` = 03A closure;
03B work uncommitted, no push/PR/merge/deploy). No production, no Cloudflare
changes, no real credentials in repo, synthetic data only.

## Verdict: SPIKE_03B_PASS

Real native prompt-loop (`session.prompt` → LLM inference → tool calls →
verified finance data → natural-language answer), single model, single user
message, both finance tools selected and executed with host-bound context,
exact values, no fabrication, full sanitized trace.

Primary evidence: `reports/SPIKE_03B_TRACE.json` (live turn T4, mode `live`,
`sessionPromptCalled: true`). Backups `SPIKE_03B_TRACE_T3.json` (prior live
turn, same functional outcome) kept alongside. T1/T2 traces were superseded by
runner iterations; their key facts are recorded in §Turn history below.

## Live turn T4 (the passing turn)

- OpenCode: isolated SDK **2.2.4** (`bootstrap/node_modules/@opencode/sdk`
  2.2.4, manifest-pinned; global CLI v2.2.3 never used for inference).
- Model/provider: **`opencode-go/deepseek-v4.1-flash`** (single model;
  `capabilities.tools: true` in the 2.2.4 catalog; training-prohibited family
  per runtime canonical; within the approved $2 budget — reported cost **0**).
- Credential: `OPENCODE_GO` from `D:/projetos/pi-financeiro/.env`, injected
  SOLELY as `OPENCODE_API_KEY` in the isolated process (value never logged,
  never in trace — `assertNoSecrets` pre-write scan + `dev-token-*` scan zero).
- Session: `ses_e6f94ffd8ffeDLFSeenZf05MSs`, agent `ted`, pinned
  `agent:ted` + `model:opencode-go/deepseek-v4.1-flash` via
  switchAgent/switchModel (prompt input carries neither in 2.2.4).
- Identity: synthetic actor A only
  (`dev-token-1`/`HOUSEHOLD_A`, seed `standard`); session auto-bound via
  `facadeFor(HOST_A).createSession` (bindings `resolveHost`, never args).
- Message (exact task text):
  "TED, quais contas eu tenho e quanto gastei em junho de 2026?"
- Tool calls observed (native `metadata.toolCalls`, via codemode `execute`
  wrapper — no direct-call API exists for the model; the wrapper is the
  model's own choice, both targets invoked):
  `list_accounts({})` → completed;
  `get_month_summary({yearMonth:"2026-06"})` → completed.
  No foreign/admin tool (no shell/edit/subagent/write/mcp/prompt).
- Results (real handlers, exact): accounts
  `{items:[Itaú bank 100000, Nubank bank 50000], total:2}`; summary
  `{yearMonth:"2026-06", incomeCents:1200000, expenseCents:288050,
  balanceCents:911950, transactionCount:4}`.
- Inference: 1 `session.prompt`, 2 internal steps (tool-calls → stop),
  tokens in 8200 / out 256 / reasoning 135 (step 1: 3888/83/48),
  cost 0, latency **16.3s** (budget: ≤4 steps, 90s timeout).
- Final answer (PT-BR, exact, no fabrication — quotes the validated data and
  honestly scopes the summary as workspace-wide, declining per-account
  attribution it cannot compute):
  "Contas (2 ativas): Itaú banco R$ 1.000,00; Nubank banco R$ 500,00.
  Junho de 2026 — Gastos: R$ 2.880,50; Receitas: R$ 12.000,00;
  Saldo do mês: R$ 9.119,50; 4 transações. Observação: o resumo de junho é
  do workspace inteiro…"
- Machine verdict in trace: **B01–B08 all pass** (see §Criteria).

This turn exercised the NATIVE path `session.prompt → LLM → Tool.execute`,
not the deterministic harness (which calls the same `execute` functions
directly and is labeled tool-integration, never conversational).

## Criteria B01–B08 (T4)

| ID | Verdict | Evidence |
|---|---|---|
| B01 PROMPT_LOOP_REAL | PASS | `sessionPromptCalled:true`, 2 native steps (`tool-calls`→`stop`), tokens/cost/latency from `session.usage.updated` events, prompt-loop tool errors/successes in native format |
| B02 TOOL_SELECTION | PASS | both finance tools observed, no foreign tools (`get_month_summary:completed,list_accounts:completed`; selection semantics — success judged in B04) |
| B03 HOST_CONTEXT | PASS | calls reached executor with host-bound context; zero `host_context_required`/`host_binding_*` in events |
| B04 FINANCIAL_ACCURACY | PASS | live result JSON validates against exact expected values (summary + accounts) AND period `2026-06` pinned on the observed call args |
| B05 ISOLATION | PASS | A-only session; no `Bradesco`/`dev-token-2`/`HOUSEHOLD_B` in messages/events |
| B06 TOOL_BOUNDARY | PASS | allowlist-only surface (selection semantics); no shell/edit/subagent/write/mcp invoked; pre-inference enumeration recorded 22-tool native superset with config denies + live foreign-tool abort as enforcement |
| B07 OUTPUT | PASS | response carries the exact validated values in natural language, no fabrication |
| B08 OBSERVABILITY | PASS | reproducible sanitized trace (version, model, provider, session, message, tools, args, results, 2 steps, tokens 8200/256/135, cost 0, 16.3s latency) |

## Turn history (no hidden retries — each rerun after a recorded code fix)

- **T1** (`ses_e6f9f5544ffecmnW9Jk5m5QhwQ`, 26.5s, cost 0): model selected both
  tools (3 attempts, `yearMonth: 2026-06`) but every execution failed
  `Tool result declared output without an output schema`. Honest failure
  response, no numbers invented. Root cause (local, evident): tools registered
  without `output` schema while `execute()` returns `{output}` — the 2.2.4
  runtime rejects it. Deterministic suites never catch this (no schema check
  on direct calls) — exactly the integration gap 03B was designed to find.
- **Fix 1**: `output: {type:'object'}` on both TOOL_DEFS + forwarded in
  `editor.add` (13-line harness diff, no surface/policy/identity change).
- **T2** (`ses_e6f99a80bffezPRfq5NojSZgsp`): both tools `completed` with exact
  data; model answered correctly in PT-BR. Machine B04 failed only on a
  verdict-parser artifact (escaped-JSON payload not recognized).
- **Fix 2** (review-driven): extractor dedupes `metadata.toolCalls`
  (no double count), B02/B06 = selection/allowlist semantics with per-tool
  statuses, `validateLiveFinance` restricted to non-user texts + escaped-JSON
  normalization, B04 additionally pins `yearMonth` on the observed call,
  `lastAssistantText` handles the observed role-less message shape.
- **T3** (`ses_e6f9730aaffeBidl4iziGbhnAK`, 16.3s, cost 0): all data correct,
  B04 pass; B07 failed on the role-less-shape artifact.
- **Fix 3**: `lastAssistantText` rewritten (last non-user non-JSON text part).
- **T4** (`ses_e6f94ffd8ffeDLFSeenZf05MSs`, 16.3s, cost 0): B01–B08 PASS.

Spend: 4 single-turn live runs (1 user message each, ≤2 internal steps each),
each well under the 90s timeout; reported cost 0 every turn (budget $2
approved, untouched). No write tools in any turn. No semantic retry of the
same code — every rerun followed a recorded fix.

## Security boundary (observed, not just configured)

- Effective surface enumerated BEFORE inference in every turn: facade exactly
  7 keys frozen; `ted-finance` plugin `active`; both finance tools in the
  native catalog (alongside 20 builtins — `transform()` adds, never replaces;
  enforcement = config denies + live foreign-tool abort, recorded in trace).
- Model-visible admin surface: none invoked in 4 turns. The model used the
  codemode `execute` wrapper (not an allowlisted finance name) to reach the
  finance tools — counted via `metadata.toolCalls`, never as a foreign-tool
  breach; shell/edit/subagent/write/mcp/prompt never observed.
- Identity: host-bound only (`resolveHost` on the session binding); `parseArgs`
  refuses `--host/--route/--method/--token/--workspace/--actor` overrides;
  `FORBIDDEN_KEYS` rejects identity args; executor assigns host/route/method
  last (P1). No token in prompt, results, trace, or stdout (scans zero).
- Sessions belong to identity A; no B session/tool accessed; expired/revoked
  paths untouched in live (covered deterministically in 03A).

## Regressions, new tests, independent review

- Green with final code (cwd `experiments/ted-runtime/bootstrap`,
  sequential, `TED_HOME_ROOT=experiments/ted-runtime`):
  spike-01 **7/7**, spike-02 **20/20**, spike-03a **17/17**,
  spike-03a-intention **8/8**, spike-03a-ownership **9/9**,
  spike-03a-restart-real **1/1**, spike-03b-dryrun **5/5** (new: config,
  dryrun enumeration, live-gate lock, extractor/validator semantics incl.
  escaped-payload + user-role exclusion, trace secret scan). Total **67**.
- Independent review ×2 (read-only): round 1 CHANGES_REQUIRED (output-schema
  sufficiency, extractor semantics) → addressed; round 2 CHANGES_REQUIRED
  (MEDIUM: B04 must bind data to successful tool results, not any text;
  LOW: pin the period) → addressed in final code (non-user-text restriction,
  `yearMonth` call-arg pin, both covered by test case (e)) and proven live in
  T4. A third formal round was not run — final hardening is evidenced by the
  5/5 suite + the all-pass T4 trace instead (limitation recorded).
- Early cold-start flake noted: one spike-02 run failed 16/20 on bridge
  timeouts before warm-up; immediate warm re-run 20/20 (harness contention,
  not a product finding).

## Files (all under `experiments/ted-runtime/`, uncommitted, no push)

| File | Change |
|---|---|
| `bootstrap/ted-finance-tools.mjs` | +`output` schema on both TOOL_DEFS (03B-T1 fix, +9) |
| `bootstrap/plugins/ted-finance/index.mjs` | forward `output` in `editor.add` (+3) |
| `bootstrap/run-03b-turn.mjs` | NEW: 03B runner (dryrun enumeration + single live turn, 90s deadline, live-gate `TED_03B_LIVE=1`, sanitized trace, B01–B08 verdict) |
| `tests/spike-03b-dryrun.test.mjs` | NEW: 5 deterministic cases, no inference |
| `reports/SPIKE_03B_TRACE.json` | live T4 trace (sanitized; secret scans zero) |
| `reports/SPIKE_03B_TRACE_T3.json` | live T3 trace (same functional outcome, prior verdict code) |
| `reports/SPIKE_03B_RESULTS.md` | this file |
| `.gitignore` | +`.ted-home-03b-a/` (isolated 03B homes never commit) |

Not implemented (per §8 — none touched): intent router, finance parser, MCP,
subagents, memory, model fallback, loop reimplementation, production
integration, new finance tools, PWA migration. `muse-spark-1.3-contributor`
was NOT used (stayed on the approved training-prohibited flash model).

## Limits & follow-ups

- Model reaches finance tools through the codemode `execute` wrapper rather
  than direct native calls (no direct-invoke API exists for the model in
  2.2.4; the wrapper is the model's own composition). B02 records selection;
  direct-call shape remains unobserved — acceptable for the spike, revisit if
  a future SDK exposes direct invocation.
- The 20 builtin tools remain visible in the native catalog; enforcement rests
  on config denies + the live abort. Consider denying codemode `execute` for
  `ted` if direct calls become available (would force the model's hand —
  needs its own experiment, not this one).
- Cost reported 0 on all turns (gateway quota); budget tracking for future
  turns must re-verify pricing rather than assume free.
- Third review round pending (see above); recommended before any production
  use of the output-schema/tool wiring.

## Recommendation

**SPIKE_03B_PASS.** Next (only after explicit approval, not executed here):
1. multi-turn experiment — informal language + contextual corrections over
   several turns in one session (binding/intention stability across turns);
2. then the first expense proposal via the existing Pending V2 protocol
   (proposal → authenticated confirmation → receipt; no new authority model).
