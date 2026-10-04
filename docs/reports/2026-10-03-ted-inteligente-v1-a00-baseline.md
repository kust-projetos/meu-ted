# TED agente inteligente V1 — A00 baseline (implementação)

**Data:** 2026-10-03 · **Executor:** OpenCode (Planner) + MCP jev (gates) · **Branch:** `feat/ted-agent-inteligente-v1-p0`
**Autorização:** operador autorizou o início da implementação da [SPEC](../MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md) e do [PLAN](../MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md) nesta sessão (a SPEC sozinha não concedia autorização).

## 1. Estado do repositório no início

| Item | Valor |
| --- | --- |
| HEAD | `be6ab11ce648d49e8b2aee886ac7a7b649287082` (docs: add intelligent TED specification and implementation plan) |
| Dirty tree preexistente (preservado, fora do escopo) | `AGENTS.md` (M), `.github/workflows/release-b-reminder.yml` (M), `docs/reports/2026-10-03-vps-migration-contabo.md` (untracked) |
| Produção | Nenhuma alteração; nenhum deploy, migration ou flag (INV-12 respeitado) |

## 2. Inventário executável de budgets (V18–V21 verificados por leitura direta)

| Eixo | Valor real | Âncora |
| --- | --- | --- |
| Truncamento de entrada (prompt) | `input.text.slice(0, 15_000)` e `cognition.system.slice(0, 7_900)` — **slice de entrada**, não budget de prompt | `apps/agent/src/finance-chat-agent.ts:902-903` |
| Policy de uso | `maxInputTokens: 2000`, `maxOutputTokens: 2000`, `maxRequestsPerWindow: 20` / `windowSeconds: 60`, `dailyBudget: 400_000`, `actorDailyBudget: 200_000` (≈7.7k tokens por perna de relay; falha despachada retém a reserva cheia) | `apps/agent/src/safety/usage-policy.ts:25-31` |
| Plano de turno | `correctionCount` inteiro `0..1`; `requestedTools` ≤ 8; operações ≤ 4; skills ≤ 2 | `apps/agent/src/orchestration/turn-plan.ts:34-42` |
| Steps de modelo | `stopWhen: stepCountIs(5)` nos dois caminhos (baseline R10: 5 steps, ≤2 fast-path, 1 retry grounding, ≤2 pernas relay — **eixos distintos**) | `apps/agent/src/finance-chat-agent.ts` (V19 do PLAN) |
| TTLs | Draft 15 min; proposta 30 min; `conversationId` opcional já existe no binding | `apps/agent/src/mutations/mutation-draft.ts`, `mutation-proposal.ts:9` (V22) |

## 3. Evals congeladas reutilizadas (não duplicar harness)

- `apps/agent/evals/ted-v2-regression-matrix.json` (33.008 bytes, matriz versionada determinística ≥50 cenários).
- `apps/agent/evals/ted-v2-behavioral-suite.ts` (40.402 bytes).
- Runners: `apps/agent/evals/run-ted-v2-regression-evals.mjs`; `run-ted-v3-real-model-evals.mjs` é **opt-in** (`TED_REAL_MODEL_EVAL=1` + credenciais aprovadas) — **não executado**.
- `apps/agent/tests/ted-v2-regression-evals.test.ts` consome a matriz.
- Mapeamento AC01–AC30 → tarefas: PLAN §7 (matriz canônica); fixtures por fatia entram nos PRs de cada fatia.

## 4. Execuções registradas nesta sessão (com evidência)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Lint sob demanda dos 3 artefatos | `node -e …lintMarkdownDocument…flatMap` (PLAN §4.1) | **exit 0 — 3 documentos, 0 issues** |
| Suíte Agent (baseline) | `pnpm --filter pi-finance-agent exec vitest run` | **823 passed / 1 skipped (824), 105 arquivos passed / 1 skipped** — verde, confere com o autoreview da baseline `ec088ab9` |
| Gate jev (screening de início) | `jev_gate` | **allow** (risco 0.49; `touches_prod` falso) |
| Decisão jev A03 | `jev_decide` | Interpretação **B — match exato literal apenas** sem `categoryQuery` (confiança 0.99); regressão noul 0.65 → suítes de regressão obrigatórias |

## 5. Pendências declaradas (não estimar resultado)

- **Latência P50/P95 e custo por turno:** dependem de eval com modelo real (opt-in + credenciais + budget autorizado). Registradas como **pendentes**, não estimadas (PLAN A00).
- **Diagnóstico global de vazio (A04 bloco b):** depende do spike A09.
- **G01–G08 (SPEC §11):** permanecem abertos; P0 não depende deles.

## 6. Ordem de execução a partir daqui

A03 (RED→GREEN, interpretação B) → A01 (characterization + guard) → A04-base (eixos tipados) → A02 (reproduce-first) → A05 (PWA Markdown seguro). Cada fatia: RED → GREEN → testes direcionados → gates → review independente → commit aprovado.
