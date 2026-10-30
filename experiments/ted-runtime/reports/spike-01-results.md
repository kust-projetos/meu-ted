# Spike 01 results — TED OpenCode runtime, Steps 0-1

- Base: `3489352`, branch `experiment/ted-opencode-runtime`, worktree
  `D:\projetos\pi-ted-runtime-spike`
- Date: 2026-10-30. Toolchain observed: node `v26.11.1`, pnpm `10.34.1`,
  npm `12.2.0`, win32.
- Scope respected: writes ONLY under `experiments/ted-runtime/`
  (`manifest.json`, `tool-inventory.md`, `bootstrap/`, `tests/`,
  `reports/`). No touch to `apps/`, `packages/`, `docs/`, `scripts/`,
  `.github/`. No push, no deploy, no production calls, no paid inference,
  synthetic data only.
- READ_SCOPE note: `docs/ted-runtime-investigation/`,
  `docs/adr/ADR-030-*`, `docker/local/docker-compose.yml`,
  `scripts/lint-docs.mjs` do NOT exist at base `3489352`; the applicable
  pins/design-hints from the task brief were used verbatim instead.
  No investigation doc was invented to fill the gap.

## Gate verdicts

| Gate | Verdict | Evidence |
|---|---|---|
| G0-01 pinned versions | PASS | manifest `versions`: 5 tarballs + integrity + shasum match researcher pins verbatim (`npm view` cross-checked); node 26.11.1 + pnpm 10.34.1 observed; no `latest` string |
| G0-02 manifest reproducible | PASS | all required fields present; `database.path` + `config.directory` + env isolation documented as init method |
| G0-03 tool-inventory from REAL execution | PASS | `tool-inventory.md` + `reports/inventory-a.json` from live `OpenCode.create()` boot (agents 8, commands 3, skills 3, plugins 92, mcp 0, providers 0, models 0) |
| G0-04 permissions on 2.2.4, provider.use+tool.use only | PASS with finding | deny policy LOADED (proven via `config.get`); prompt-loop denial NOT exercisable without LLM (never invoked); direct-API `session.shell` probe → **ALLOWED** (bypass documented, see finding F1) |
| G1-01 isolated bootstrap | PASS | `.ted-home-{a,b}` exclusive; own config/data/cache/state/tmp/workspace/db; no repos/SSH/docker/GH tokens/DB creds |
| G1-02 no personal config | PASS | `config.get` shows ONLY identity doc; default `OpenCode.create({})` loads `C:\Users\walis\.config\opencode` (recorded as the trap isolation avoids); `GITHUB_TOKEN`+`OPENROUTER_API_KEY` scrubbed live |
| G1-03 sessions per identity | PASS | A/B distinct `ses_*`; B→A `get` = `Session not found` |
| G1-04 persistence after restart | PASS | stop (process exit) → new process → `get` OK; `remove` stays removed |
| G1-05 cross-identity isolation | PASS | separate sqlite files; A id unknown to B (covered in G1-03 test) |
| G1-06 admin tools inaccessible | PASS (by removal) | facade exposes no shell/prompt/edit/subagent/mcp-connect; catalog re-enumerated (92 plugins builtin present natively, 0 MCP, 0 providers) |
| G1-07 reproducible restart + timing | PASS | `restart-probe`: bootMs ~82–94, rssMB ~260, diskKB ~11337 per identity home; commands documented in manifest |
| G1-08 negative tests | PASS 6/6 | unknown get/remove → NOTFOUND; mcp 0; no creds; no personal paths; synthetic roundtrip create/read/remove |
| TDD | PASS | `tests/spike-01.test.mjs` (node:test): RED 0/7 pre-impl → GREEN 7/7 post-impl, exit 0, deterministic, no LLM |
| Simplicity §11 | PASS | no session manager/compaction/plugin/intent-router/parser/MCP-API/Cloudflare code; ~250 lines harness + tests |

## Finding F1 (material): `session.shell` bypasses policy in 2.2.4

With the deny policy LOADED (`tool.use shell:* deny` + V2 `shell deny`),
`session.shell` executed and produced a side-effect file (created, verified,
deleted; session removed). So 2.2.4 policies govern the **prompt agent-loop**,
not the **direct API**. The prompt-loop denial path needs LLM inference, which
this experiment never invokes (no paid inference by design). TED consequence:
deny-by-policy is insufficient for direct-API callers → the spike removes
shell/prompt/edit/subagent/mcp-connect from the TED surface entirely (facade
never invokes them; only `session create/get/list/remove` + read-only catalogs
are exposed). Any future TED server MUST keep this allowlist façade; native
`OpenCode.create()` alone is not least-privilege. Custom code needed: the
façade (`run-identity.mjs` command switch) — justified because native is
insufficient (proven above).

## Other observations (for Step 2+)

1. First `npm install` timed out mid-way leaving a partial tree (sdk without
   `dist/index.js`, pi-coding-agent without `package.json`, unhoisted
   `@effect/platform-node`); repaired by targeted reinstall + `npm dedupe`.
   Reproducible via `--save-exact` pins; lockfile v3 omits resolved/integrity
   for cached entries — registry metadata is authoritative (matches pins).
2. `config.content` inline was NOT honored as override in the observed path;
   `config.directory` + BOM-free `opencode.json` is authoritative. BOM files
   are silently rejected by `Config.parseInfo` (warn-only).
3. Default embedded DB is per-process (no cross-restart visibility); explicit
   `database.path` per identity gives file persistence + process-boundary
   isolation for free.
4. `provider.list`/`model.list` empty with zero credentials — prompt path is
   environmentally fail-closed here, independent of the `provider.use` deny.
5. `event.subscribe` exists but was not exercised (no deterministic async
   source); `session.compact` not invoked (needs LLM). Both recorded as limits,
   not passes.
6. One personal-config side effect occurred during probing (a session created
   under default global state before isolation was proven); it was removed
   (`list` = 0 after) — lesson captured in G1-02 procedure: always boot with
   `config.directory` + isolated env from the first call.

## Files created

- `manifest.json` (pins, effective config, storage, limits, commands)
- `tool-inventory.md` (Disponível × instalado × permitido ao TED)
- `bootstrap/package.json` + `package-lock.json` + `node_modules/` (pinned install; git-ignored)
- `bootstrap/env.cjs`, `ted-config.cjs`, `run-identity.mjs`
- `tests/spike-01.test.mjs` (7/7 GREEN, `node --test`, exit 0)
- `reports/inventory-a.json` (raw live inventory), `reports/spike-01-results.md` (this file)
- Runtime state (not for commit): `.ted-home-a/`, `.ted-home-b/` (isolated homes + sqlite)
