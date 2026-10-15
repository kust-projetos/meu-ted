# V1-TED-AUDIT-2026-10-15-SUPLEMENTO — reconciliação FASE 7 (somente-docs)

**Data:** 15/10/2026. **Tipo:** somente-docs, sem código, sem commit/push/PR, sem fechar issues, sem merge, sem deploy.
**Base reconciliada:** `main` em `056da43`.
**Documentos-irmãos:** `V1-TED-TEST-MATRIX.md` (matriz INT-01–INT-24 reconciliada na mesma data) e `../plans/V1-TED-STABILIZATION-PLAN.md` (§9, FASE 7).
**Método:** leitura dos diffs via `git show`/`git diff` entre SHAs, sem trocar para branches de fix. Este worker-docs não teve acesso a shell/`gh`; SHAs, comandos e resultados abaixo são os repassados como evidência real — nada aqui afirma homologação sem evidência.

## 1. Lotes reconciliados (PRs OPEN, não mergeados)

| Lote | PR | SHAs | Evidência real |
|---|---|---|---|
| A | #192 | `0099ae9` (#184) + `895440f`/`94ddeee` (#185) | CI + PWA CI verdes; tester 143/143 combinado + typecheck; reviews APPROVED |
| BC | #193 | `0267c4c` + `80a0832` + `a3654c7` | CI verde (1 rerun flake e2e UI-05/PUSH-02, mesma família histórica); agent suite 2589 + focados + typecheck; reviews APPROVED |
| #188 | #194 | `1536164` + `c42a63f` | 46/46 PG descartável + typecheck; CI verde; review com limitação declarada (guardless sem re-execução independente) |
| #178 | #195 | `ce245b8` + `d4aeaa0` + `b3d8f51` + `67fbe5f` | test-only; validação estática (typecheck + eslint + collect); live NÃO executado (sem credenciais) → INCONCLUSIVE |
| Melhorias | #196 | 9 + 1 commits | tester PASS + typechecks; review APPROVED (conteúdo detalhado não rastreado nesta reconciliação — ver §5) |

O que cada fix cobre (segundo a evidência repassada): #185 — lock ref + chave por intent + guarda de geração (duplo-tap); #184 — 409 tipado por code, `in_progress` retentável; #187 — `intentionId` obrigatório; #186 — timeouts até corpo + fail-closed; #189 — sem fallback em 401/403.

## 2. Vereditos por issue

Definições: `CLOSED` = issue fechada no GitHub; `CORRIGIDA (PR OPEN)` = fix presente em PR OPEN com CI verde, **sem merge** — não equivale a encerramento; `PARCIAL` = cobertura incompleta ou só-estática; `ABERTA` = sem fix rastreado; `DIFERIDA` = backlog pós-V1 deliberado.

| Issue | Veredito FASE 7 | PR associado | Evidência |
|---|---|---|---|
| #174 (negação→confirmação) | CLOSED (única fechada) | fix que a fechou (SHA de merge a confirmar pelo Planner) | issue closed; prova determinística histórica `negation-safety-174.test.ts` 25/25 veio de PR superseded (#179, SHA `407470b`) |
| #184 (409 vs replay) | CORRIGIDA (PR OPEN) | #192 (`0099ae9`) | CI + PWA CI verdes; tester 143/143 combinado + typecheck; review APPROVED; sem merge = sem CLOSED |
| #185 (duplo-tap) | CORRIGIDA (PR OPEN) | #192 (`895440f`/`94ddeee`) | idem acima (lock ref + chave por intent + guarda geração) |
| #186 (timeout fail-open) | CORRIGIDA (PR OPEN) | #193 | CI verde; agent suite 2589 + focados + typecheck; review APPROVED; sem merge = sem CLOSED |
| #187 (anti-replay sem claim) | CORRIGIDA (PR OPEN) | #193 | idem acima (`intentionId` obrigatório) |
| #189 (failover 401/403) | CORRIGIDA (PR OPEN) | #193 | idem acima (sem fallback 401/403) |
| #188 (undo in-memory) | PARCIAL | #194 (`1536164` + `c42a63f`) | 46/46 PG descartável + typecheck; CI verde; **limitação declarada no review**: guardless sem re-execução independente; sem merge = sem CLOSED |
| #178 (modelo-real) | ABERTA (INCONCLUSIVE) | #195 (test-only) | validação estática apenas; live NÃO executado (sem credenciais); jornadas multi-turno seguem sem prova |
| #167, #168 (workspaces/auth) | ABERTA | prova anterior em PR superseded (#180, SHA `27ad601`); sem re-prova rastreada nos lotes FASE 7 | re-prova devida na matriz (INT-09, INT-10, INT-14–INT-16) |
| #169 (histórico), #170 (categoria) | ABERTA | prova anterior em PR superseded (#181, SHA `b8d97f2`); sem re-prova rastreada nos lotes FASE 7 | re-prova devida (INT-03–INT-07, INT-12, INT-13) |
| #171 (cards), #172 (undo-alvo), #175 (undo runtime) | ABERTA | prova anterior em PR superseded (#183, SHA `d41fb21`); #175 toca o tema do #188 mas sem vínculo rastreado ao PR #194 | re-prova devida (INT-11, INT-14–INT-16); Planner confirma se #194 cobre #175 |
| #173 (scroll P2) | ABERTA | prova PWA anterior em PR superseded (#183) | re-prova devida (INT-19) |
| #176, #177 (sessão/drafts) | ABERTA | prova anterior em PR superseded (#182, SHA `9d01a25`); caminho determinístico de erros coberto pelo lote BC (#186) | PARCIAL no determinístico; modelo-real INCONCLUSIVO (INT-17, INT-18) |
| Backlog P2/pós-V1 (F6–F16 Agent; F6–F9 PWA/API, sem issue) | DIFERIDA | — | sem issue; tratamento pós-V1 pelo Planner (inalterado desde o audit 15/10) |

Notas de reconciliação: (a) PRs #179–#183 (citados na matriz anterior como OPEN) são anteriores à base `056da43` e têm evidência superseded — status atual deles (mergeado vs fechado vs superseded) **não confirmado** neste worker (sem `gh`); o Planner confirma antes de reusar qualquer número deles como prova. (b) O conteúdo detalhado do PR #196 (melhorias, 9+1 commits) não foi rastreado issue-a-issue nesta reconciliação; se ele cobre #167–#173/#175–#177, a matriz deve ser atualizada com SHAs por cenário. (c) Nenhuma issue recebe `FULLY_CLOSED` nesta FASE 7: fixes em PRs OPEN, sem merge, não encerram itens; a única CLOSED é #174.

## 3. Gates G1/G2/G5

| Gate | Status FASE 7 | Fundamento |
|---|---|---|
| G1 — RED→GREEN nos casos P0, sem regressão | EVIDÊNCIA PARCIAL (pendente de confirmação) | #174 CLOSED sugere o item P0-negação encerrado; SHA de merge do fix e ausência de regressão no `main` vigente a confirmar pelo Planner |
| G2 — E2E P0 verdes em banco descartável | NÃO ATINGIDO | #167/#168/#169 OPEN sem re-prova rastreada; único E2E em PG descartável da fase é o do #188 (P2, PR #194, 46/46) |
| G5 — jornadas multi-turno críticas PASS (modelo real) | NÃO ATINGIDO (INCONCLUSIVE) | PR #195 test-only; live não executado (sem credenciais); INT-20/INT-21/INT-22-live sem prova |
| Attestation `deploy-smoke-pass` / release | NÃO APLICÁVEL nesta fase | nenhum deploy na FASE 7; release `v1.0.2` foi manual pelo operador em 11:09:07Z (`gh release view`), fora do `release-promote` (único run `38581993569` de 14/10); gates CI/PWA/attest vieram depois |

## 4. Integridade e segurança (o que os lotes alteram)

- Dedupe/anti-replay (#185 + #187): chave de idempotência por intent + `intentionId` obrigatório reduzem a superfície de double-spend por duplo-tap/redelivery; повторно: PRs OPEN, sem prova em produção.
- Fail-closed (#186, #189): timeouts até o corpo + sem fallback em 401/403 eliminam dois caminhos fail-open (execução sem resposta lida; retry sobre falha de auth que mascarava credencial e arriscava gasto duplo).
- 409 tipado (#184): conflito de domínio deixa de ser lido como replay idempotente; `in_progress` retentável preserva retomada legítima.
- Undo (#188): correção cobre corrida in-memory em PG descartável 46/46, **com a limitação declarada** (guardless sem re-execução independente) — não promover a `GREEN` pleno sem esse follow-up.
- Nenhum lote altera segredos, credenciais, flags live, banco de produção ou config-de-deploy (somente-docs + código em PRs OPEN, sem deploy).

## 5. Limitações desta reconciliação

- Sem shell/`gh` neste worker: SHAs, runs de CI e estados open/closed são os repassados como evidência; verificação independente (`gh pr view`, `gh run list`, `git log --oneline main`) é devida pelo Planner.
- Status dos PRs #179–#183 e SHA de merge do fix da #174: não confirmados (ver §2a).
- Cobertura issue-a-issue do PR #196: não rastreada (ver §2b).
- Sem modelo real autorizado e sem E2E live no SHA final: todo veredito de jornada real permanece INCONCLUSIVE.
- D1/D2/D3-sessões (decisão humana), merges (gate humano), Release B, cutover, E2E live no SHA final e tag `v1.0.3` (NÃO criar): pendentes, registrados no plano §9.
