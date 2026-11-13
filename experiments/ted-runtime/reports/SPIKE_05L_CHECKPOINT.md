# SPIKE 05L — CHECKPOINT LOCAL (sem push/merge/commit de código)

**Data:** 2026-10-31
**Branch:** `experiment/ted-opencode-runtime`
**Base revision (HEAD):** `1567daed7c1744ad0b15d97c6e69a7d667eba685` (`1567dae experiment 03A checkpoint…`)
**Veredito:** `SPIKE_05_PARTIAL` ( = PARTIAL )
**Natureza deste arquivo:** checkpoint local untracked, somente leitura/auditoria. Sem commit, sem tag, sem push, sem merge. Planner decide commit.

> Sem deploy, sem produção, sem banco real. Nenhum Postgres real, PWA real, Cloudflare ou harness de produção tocado.

## 1 — Arquivos 05L (escopo do spike)

**Harness:**
- `experiments/ted-runtime/bootstrap/run-05l-turn.mjs` (untracked; escreve `SPIKE_05L_TRACE.json` latest + snapshots timestamped imutáveis `traceTimestampedPath/writeTraceFiles`)

**Testes:**
- `experiments/ted-runtime/bootstrap/run-05l-turn.test.mjs` — **34/34 PASS** (8 dryrun-harness + 14 hardening units + 10 polling/trace + 2 snapshot-imutável HIGH, sem inferência)
- `experiments/ted-runtime/bootstrap/spike-05l-category-tool.test.mjs` — **6/6 PASS** (autoridade real `list_categories`)
- Total 05L sessão: **40/40** (34 + 6)
- Herdado `SPIKE_05_RESULTS.md §6` (sem reexecução total nesta sessão): `spike-05-negatives` **19/19**, `spike-02` 20/20, `spike-04l-extract` 7/7

**Traces (imutáveis + latest):**
- `experiments/ted-runtime/reports/SPIKE_05L_TRACE_live_2026-10-31T15-48-43-100Z.json` — **snapshot imutável do SEGUNDO turno live** (`mode:"live"`, `sessionPromptCalled:true`, `sessionPromptCount:1`, `at 2026-10-31T15:48:43.100Z`, sessão `ses_e6d5a2719ffe2HhlNpi30qJKTw`, `messageCount:7`, 44 eventos, `session.execution.succeeded`, `elapsedMs 23242`)
- `experiments/ted-runtime/reports/SPIKE_05L_TRACE.json` — latest; **neste checkpoint tem conteúdo idêntico ao snapshot live acima** (mesmo `at 15:48:43.100Z`, `mode:"live"` — ver SHAs)
- `experiments/ted-runtime/reports/SPIKE_05L_TRACE_dryrun_2026-10-31T15-40-57-979Z.json` — snapshot dryrun
- `experiments/ted-runtime/reports/SPIKE_05L_TRACE_dryrun_2026-10-31T15-44-59-176Z.json` — snapshot dryrun
- `experiments/ted-runtime/spike-05/traces/SPIKE_05L_CONFIRM_TRACE.json` (`at 2026-10-31T15:30:17.610Z`) — confirmação sintética + R1/R2/R3 (double não-autoritativo)
- `experiments/ted-runtime/spike-05/` — fixtures (`synthetic-case-35-mercado.json`), scripts (`confirm-cli.mjs`), tests, traces (+ `traces/originals/` com 14 traces 04 preservados byte a byte, SHA256 ALL MATCH)

**Relatório:**
- `experiments/ted-runtime/reports/SPIKE_05L_RESULTS.md` — resultado canônico 05L (§§1–10)
- `experiments/ted-runtime/reports/SPIKE_05_RESULTS.md` — base determinística reutilizada (§§2–4, sem reexecução de campanha paga)

## 2 — Validações

- **40/40:** `run-05l-turn.test.mjs` 34/34 + `spike-05l-category-tool.test.mjs` 6/6 (desta sessão, sem inferência).
- **Live 02 snapshot:** segundo turno live verificado no snapshot imutável — B01–B08 `pass` (`verdict` top-level), args observados `propose_expense {3500, "Mercado", 2026-10-30, Nubank …1112, Mercado …2221}`, resposta grounded "ainda **não executada** … precisa da sua confirmação", latência `elapsedMs 23242`, sessão `ses_e6d5a2719…`. Primeiro turno (`66635d44`, `24867ms`, `ses_e6d6e30f…`) = evidência indireta do executor (sem trace imutável — HIGH parcialmente superada).
- **Confirm 19/19:** `spike-05-negatives` 19/19 (16 UX double-only + 3 autoridade real R1/R2/R3 mesma-instância; R3-limite: 2 processos → 2×201 ids distintos; `NOT_PROVEN_CROSS_PROCESS`).
- **Reviews:** `CHANGES_REQUIRED` endereçados (double marcado não-autoritativo, R1/R2 mesma-instância + R3-limite, cancel HTTP rejeitado, `--origin` loopback-only) + `APPROVED`s parciais subsequentes. Residuais MEDIUM (pré-execução total não-enforçável 2.2.4; polling/step-budget best-effort; `cost 0` exposto ≠ faturado) — não bloqueiam o parcial, bloqueiam o full.

## 3 — Teto operacional

- **Teto US$5: 2 turnos live consumidos, custo exposto `0`/`0`.** Tokens segundo turno (snapshot): cumulativo `in 5307 / out 304 / reasoning 108`, `cost 0` em todos os steps. `0` = valor exposto pelo SDK, não prova de faturamento. Controle real por contagem (1 cenário × 1 modelo, `sessionPromptCount=1`, sem retry/fallback/admin). Sem nova inferência após o segundo turno live.

## 4 — Git status resumido (neste checkpoint, sem commit)

- Branch: `## experiment/ted-opencode-runtime`; HEAD: `1567daed7c1744ad0b15d97c6e69a7d667eba685`.
- Modified (8): `experiments/ted-runtime/.gitignore`, `bootstrap/finance-bridge.ts`, `bootstrap/finance-transport.mjs`, `bootstrap/plugins/ted-finance/index.mjs`, `bootstrap/ted-finance-tools.mjs`, `bootstrap/ted-gateway.mjs`, `tests/spike-02.test.mjs`, `tests/spike-03a.test.mjs`.
- Untracked 05L (este checkpoint + escopo): `bootstrap/run-05l-turn.mjs`, `bootstrap/run-05l-turn.test.mjs`, `bootstrap/spike-05l-category-tool.test.mjs`, `reports/SPIKE_05L_RESULTS.md`, `reports/SPIKE_05L_TRACE.json`, `reports/SPIKE_05L_TRACE_dryrun_*.json` (2), `reports/SPIKE_05L_TRACE_live_*.json` (1), `reports/SPIKE_05_RESULTS.md`, `spike-05/`, + demais untracked 03B/04/04R da worktree (fora do escopo 05L, intocados por esta tarefa).
- Este arquivo (`reports/SPIKE_05L_CHECKPOINT.md`) criado como untracked. **Nada commitado, tagueado, empurrado ou mergeado.**

## 5 — SHAs dos traces principais (`git hash-object`, sem push)

- `reports/SPIKE_05L_TRACE_live_2026-10-31T15-48-43-100Z.json`: `e03f85a2c641d07c998bc387b9a9f4267a4f3d82`
- `reports/SPIKE_05L_TRACE.json`: `e03f85a2c641d07c998bc387b9a9f4267a4f3d82` (idêntico ao live snapshot neste checkpoint)
- `reports/SPIKE_05L_TRACE_dryrun_2026-10-31T15-40-57-979Z.json`: `fede4886b995568f88cf8abfa5404a8072846ef3`
- `reports/SPIKE_05L_TRACE_dryrun_2026-10-31T15-44-59-176Z.json`: `3bcf4d86bdd3d5cc8428f781cf390987aaee58ce`
- `spike-05/traces/SPIKE_05L_CONFIRM_TRACE.json`: `21ec9c8301a63346819bede25d18d7fd341035aa`
- `reports/SPIKE_05L_RESULTS.md`: `2ea5752b3b3f40c04db8e87d6ae66cfd272ab7d3`

## 6 — Próximos passos

1. **Ted-local durável** (`ted-local`/Postgres): Pending V2 durável + re-propose/confirm live com recibo canônico + R1/R2 cross-process. Declarar PASS futuro só após recibo live durável.
2. **NÃO iniciar SPIKE 06** antes do follow-up acima. Se PASS futuro: síntese A0/A1/B (arquitetura efetiva, contratos Pending V2, bridge/host-bound) como base de handoff.
3. Commit deste checkpoint (e do escopo 05L) é decisão do Planner — fora do escopo desta tarefa.
