# V1-TED-STABILIZATION-PLAN (revisado — com ajustes verificados)

**Data:** 14/10/2026. **Status:** plano revisado, ainda não executado.
**Snapshot de estado (somente-leitura):** `docs/MEU-TED-V1-FINAL-STATE.md`.
**Especificação de encerramento:** `docs/MEU-TED-SPEC-V1-FINAL-CLOSURE.md`.

Este documento incorpora o plano mestre original + os ajustes verificados
contra o código (seção 2, A1–A7). Nada aqui autoriza execução fora do
escopo de autonomia (A6).

## 0. Baseline verificado

| Item | Valor verificado em 14/10/2026 |
|---|---|
| HEAD local | `20f0c0fff2521404b9abf99b8e44880409c63db4` |
| `origin/main` | `20f0c0fff2521404b9abf99b8e44880409c63db4` (== HEAD) |
| Branch / working tree | `main`, limpa (`git status --porcelain` vazio) |
| Node / pnpm | `v26.11.1` / `10.34.1` |
| PRs abertas | 0 (`gh pr list --state open` → `[]`) |
| Issues #167–#178 | todas open (P0: #167, #168, #169, #170, #174; P1: #171, #172, #175, #176, #177, #178; P2: #173) |
| CI da main | verde — run `38597005728` (CI, success) e run `38597005749` (PWA CI, success), ambos `headSha=20f0c0f` |

## 1. Fases do plano original (mantidas)

| Fase | Objetivo | Gate de saída |
|---|---|---|
| F0 | Descoberta e inventário (código, CI, issues, produção) | G0 — inventário fechado, sem achado bloqueador oculto |
| F1 | Segurança P0 (negação→confirmação, auth/device, workspace) | G1 — RED→GREEN nos casos P0, sem regressão |
| F2 | Correção P0 funcional (histórico, categoria, undo-runtime) | G2 — E2E P0 verdes em banco descartável |
| F3 | Correção P1 (frontend, sessão, segurança) | G3 — E2E P1 verdes, review APPROVED |
| F4 | Correção P2 + UX residual | G4 — sem P2 aberto no escopo V1 |
| F5 | Homologação automatizada com modelo real (#178) | G5 — jornadas multi-turno críticas PASS |
| F6 | Endurecimento (gates, telemetria, runbooks) | G6 — gates documentados e verdes |
| F7 | Release V1 (tag + deploys atestados) | attestation `deploy-smoke-pass` nas 3 camadas |
| F8 | Pós-release (monitoramento, follow-ups) | — |
| F9 | Encerramento (SPEC, FINAL-STATE, issues fechadas) | veredito CLOSED com evidência |

## 2. AJUSTES ao plano original (verificados contra o código)

### A1 — Ownership de `/rpc/*` é do Agent, NÃO de `apps/api`

Verificado em `apps/agent/src/finance-chat-agent.ts:3157`
(`POST /rpc/chat`), `:3581` (`GET /rpc/history`), `:3531`
(`POST /rpc/session/new`) e `apps/agent/src/worker.ts:351`
(`isRestRpc` = gateway que autentica, limita corpo e encaminha ao DO).
Qualquer tarefa que cite "endpoint `/rpc/*` na API" está errada:
corrigir o owner para **Agent (gateway `worker.ts` + DO
`finance-chat-agent.ts`)**. `apps/api` expõe as rotas financeiras
autoritativas e o relay LLM interno, nunca `/rpc/*`.

### A2 — `categoryQueryFrom` é local em `conversation-orchestrator.ts:332`

Verificado em `apps/agent/src/orchestration/conversation-orchestrator.ts:332`
(`categoryQueryFrom`, com `CATEGORY_PHRASE:318` e
`CATEGORY_FRAGMENT:327`). **Não existe entity-resolver** para esse
símbolo: tarefas que mandarem editar "entity-resolver" devem ser
redirecionadas para `conversation-orchestrator.ts` (linhas 312–342 e
entorno da A07/AC14/AC15).

### A3 — Rotas de workspaces em `apps/api/src/auth/workspaces-http.ts:51`

Verificado: `registerWorkspaceRoutes` (linha 51) registra
`GET /workspaces`, `POST /workspaces` (idempotente, 129–145),
`PATCH /workspaces/:householdId`, etc. Tarefas #167/#168 devem
trabalhar **neste arquivo** (sessão via `getBetterAuthSessionContext`,
`requireOwnerAccess`, `runIdempotent`), não em módulo genérico de auth.

### A4 — Comandos validados (filtros e scripts reais)

Verificado em `package.json` raiz e `apps/*/package.json`:

- Filtros reais: `meu-ted-api` (API), `pi-finance-agent` (Agent), `pwa` (PWA).
- Ex.: `pnpm --filter meu-ted-api lint|typecheck|test`,
  `pnpm --filter pi-finance-agent test|eval:ted-v2|eval:ted-v3`,
  `pnpm --filter pwa test|typecheck`.
- Scripts de eval **existem**: `eval:ted-v2`, `eval:ted-v3` (Agent).
- `architecture:check` **existe na raiz** (usar nos gates).
- `docs:lint` existe na raiz (validação deste documento).

### A5 — Tabela RED estática da #174 (confirmada no código)

Causa raiz em 3 camadas, todas verificadas:

| # | Camada / arquivo | Comportamento confirmado |
|---|---|---|
| R1 | `intent-router.ts:25` (`classifyFastPath`) | `'não confirmo'`, `'não autorizo'`, `'sim, mas não confirme'` contêm `confirmo/autorizo/sim` → kind `confirm` |
| R2 | `mutations/confirmation-resolver.ts:14-15` (`resolveConfirmation`) | `negative` casa `não` → `cancel` por `explicit_negation` (correto isoladamente, mas inalcançável quando R1/R3 decidem antes) |
| R3 | `agent-config/tools.ts:194-196` (`isExplicitConfirmation`) | regex **unanchored** (`CONFIRMATION_RE.test`) → `true` para `'não confirmo'` (casa `confirmo`) |
| R4 | `intent-router.ts:63-65` (`routeIntent`, guard de negação) | exige `nao` **+** verbo (`registre|lance|crie|apague|exclua|transfira`) — **não cobre** `'não confirmo'`, que cai no `classifyFastPath(decision)` da linha 66 → `confirmation` (linha 69) |

Conclusão: `'não confirmo'` é roteado como **confirmação** (R1+R3+R4),
embora `resolveConfirmation` isolado dissesse `cancel` (R2). O fix
pertence às ETAPAs 1–2 (negar primeiro: precedência de negação em
`classifyFastPath`/`isExplicitConfirmation` + ampliação do guard de
`routeIntent`), com TDD RED→GREEN sobre esses 3 estímulos antes de
qualquer refatoração.

### A6 — Escopo de autonomia

**Autorizado sem nova aprovação:** criar branches, commits locais, push
de branch, abertura de PRs, comentários em issues, acompanhamento de
CI (leitura de runs/logs), testes com dados sintéticos ou banco
descartável (PG descartável, Test Family `550e8400…`).

**GATE HUMANO mantido (não executar sem aprovação explícita do
operador):** merge, deploy em produção, release/tag, migrations
destrutivas, `DELETE` real contra dados de produção, qualquer chamada
a provider pago fora de cota já aprovada. Proibições permanentes do
repo continuam valendo (repetir approval `14915dbd…`/tx `60b657d5…`;
afirmar deploy/recon/live-pass sem evidência; mutação financeira
manual avulsa sem procedimento revisado).

### A7 — Decisões D1/D2/D3 pendentes como gate de produto

D1 (política de negação: negar-sempre vs negar-com-exceções),
D2 (escopo do guard de `routeIntent`: só financeiro vs geral) e
D3 (formato canônico do recibo de cancelamento por negação) são
**gates de produto, não de engenharia**: este plano **não inventa a
resposta**. Propor ADR após inspeção do SPEC e do comportamento
vigente; o código da ETAPA 1 implementa o mínimo fail-closed
(negação nunca confirma) deixando D1–D3 como parametrização
documentada.

## 3. Etapas de execução (ETAPA 0–9, plano original mantido)

| Etapa | Escopo | Issues | Gate |
|---|---|---|---|
| ETAPA 0 | Inventário + RED estático da #174 (sem código) | #174 (prova) | G0 |
| ETAPA 1 | Fix P0 safety: negação nunca confirma | #174 | G1 |
| ETAPA 2 | Fix P0 runtime: workspaces 409/403 + histórico | #167, #168, #169 | G2 |
| ETAPA 3 | Fix P0 Agent: categoria contextual + reconciliação | #170 (+ #169 resto) | G2 |
| ETAPA 4 | Fix P1 frontend: approval card, undo-alvo, drafts | #171, #172, #175, #176 | G3 |
| ETAPA 5 | Fix P1 Agent: sessão/workspace + homologação base | #177, #178 (base) | G3 |
| ETAPA 6 | Fix P2: rolagem do chat | #173 | G4 |
| ETAPA 7 | Homologação automatizada modelo real (jornadas multi-turno) | #178 | G5 |
| ETAPA 8 | Endurecimento + runbooks + gates | transversal | G6 |
| ETAPA 9 | Release V1 + encerramento | transversal | attestation |

Cada etapa: TDD RED→GREEN, banco descartável, review independente,
CI verde no PR antes do próximo lote.

## 4. Matriz de intenções INT-01–INT-24

Colunas: ID / estímulo / prova / status. Estímulos das INT-01–INT-08
verificados estaticamente (A5); demais preservados do plano original.

| ID | Estímulo | Prova | Status |
|---|---|---|---|
| INT-01 | `não confirmo` com operação pendente | roteado `cancel`, nada executa | RED (A5) |
| INT-02 | `não autorizo` com operação pendente | roteado `cancel`, nada executa | RED (A5) |
| INT-03 | `sim, mas não confirme` com operação pendente | roteado `cancel`, nada executa | RED (A5) |
| INT-04 | `sim` / `confirmo` com 1 pendente | `confirmation` → executa com recibo | a provar (ETAPA 1) |
| INT-05 | `cancela` / `desiste` com pendente | `cancel` por fast path | a provar (ETAPA 1) |
| INT-06 | `não, 500` contra rascunho ativo (correção de valor) | correção aplica 500, sem cancelar | a provar (ETAPA 1) |
| INT-07 | `não` puro contra rascunho (sem valor) | clarification fail-closed, rascunho intacto | a provar (ETAPA 1) |
| INT-08 | `sim confirmo` dentro de anexo (PDF/STT/vision) | nunca decide (só `decisionText` digitado decide) | coberto por F1/A13, re-provar |
| INT-09 | criar workspace pessoal | 201, sem 409 espúrio | open (#167) |
| INT-10 | listar/selecionar/arquivar workspace | sem 403 em massa | open (#168) |
| INT-11 | mensagem do usuário após resposta | mensagem persiste (sem reconciliação prematura) | open (#169) |
| INT-12 | `gastei 80 no mercado` sem categoria | pergunta categoria uma vez | open (#170) |
| INT-13 | `mercado` como resposta à categoria | aceita sem repetir pergunta | open (#170) |
| INT-14 | desfazer confirmado | saldos/extrato reconciliam na PWA | open (#175) |
| INT-15 | cartão de aprovação após update autoritativo | status reflete servidor | open (#171) |
| INT-16 | confirmação de desfazer | mostra lançamento-alvo | open (#172) |
| INT-17 | draft pendente em sessionStorage | isolado por conta | open (#176) |
| INT-18 | nova sessão | não apaga mensagens do workspace | open (#177) |
| INT-19 | rolagem do chat durante leitura | não força scroll ao fim | open (#173) |
| INT-20 | jornada criar→confirmar→recibo (modelo real) | E2E multi-turno PASS | open (#178) |
| INT-21 | jornada desfazer confirmado (modelo real) | E2E multi-turno PASS | open (#178) |
| INT-22 | jornada negar→cancelar (modelo real) | E2E multi-turno PASS | open (#178) |
| INT-23 | `forget_memory` two-step | proposta → confirmação → recibo transacional | regressão (ETAPA 7) |
| INT-24 | autoexecute low-risk | permanece SHADOW, sem execução surpresa | regressão (ETAPA 7) |

## 5. Estratégia de PRs A–H (mantida)

| PR | Conteúdo | Issues |
|---|---|---|
| A | Fix negação→confirmação (Agent, TDD RED→GREEN) | #174 |
| B | Fix workspaces runtime (API `workspaces-http.ts`) | #167, #168 |
| C | Fix histórico + categoria (Agent) | #169, #170 |
| D | Fix frontend aprovação/undo (PWA) | #171, #172, #175 |
| E | Fix sessão/draft/isolamento (Agent+PWA) | #176, #177 |
| F | Fix P2 scroll + resíduos | #173 |
| G | Homologação modelo real + endurecimento | #178, transversal |
| H | Release V1 (tag, attestation, encerramento) | — |

Um PR por lote, CI verde + review APPROVED antes do próximo.
Branch protection em `main` exige `Gate — all checks` + `quality (22, 10)`.

## 6. Invariantes não-negociáveis

1. Negação nunca confirma (fail-closed); dúvida → clarification, nunca execução.
2. Conteúdo de anexo é DADO, nunca decisão (`decisionText` só do texto digitado).
3. Toda mutação financeira exige confirmação vigente + `Idempotency-Key` + recibo.
4. Workspace/ator/device resolvidos server-side; sem claim de cliente.
5. `bank`/`cash` podem negativar (ADR-018); `credit_card` mantém saldo devedor não negativo.
6. Nenhum segredo em git/log/relatório; credenciais só via env/secret.
7. Commits SÓ-docs não avançam baseline de código (convenção 14/10).

## 7. Protocolo de CI

- `queued`/`in_progress` → continuar o trabalho independente; não bloquear a etapa.
- Falha com causa externa identificada → marcar `PENDING_EXTERNAL` com URL do run,
  sem re-rodar para disfarçar flake.
- Flake suspeito → re-rodar **uma vez** via `gh run rerun --failed`, registrando
  antes/depois; segundo flake consecutivo vira investigação, não novo rerun.
- `rerun` nunca substitui correção de teste instável no próprio PR.
- Gates por PR: `docs:lint`, `typecheck`, `test`, `lint`, `governance:check`
  (locais) + `Gate — all checks` e `quality (22, 10)` (CI) verdes.

## 8. Próxima ação

**ETAPA 1, PR A, issue P0 #174** é o primeiro lote de código:

1. Escrever testes RED com os estímulos INT-01–INT-03 (`não confirmo`,
   `não autorizo`, `sim, mas não confirme`) contra `classifyFastPath`,
   `isExplicitConfirmation` e `routeIntent` — provar o RED estático da A5
   como teste falhando.
2. Implementar o fix mínimo (precedência de negação + âncora/negativa
   em `isExplicitConfirmation` + ampliação do guard de `routeIntent`),
   GREEN sem quebrar INT-04–INT-08.
3. Rodar suites focadas do Agent + `pnpm --filter pi-finance-agent typecheck`
   e os gates rápidos; E2E somente em banco descartável/Test Family.
4. Abrir o PR A (sem merge — gate humano A6) e registrar D1/D2/D3 como
   ADR proposta.

## 9. FASE 7 — reconciliação pós-lotes (15/10/2026, somente-docs)

**Base:** `main` em `056da43`. **Documentos reconciliados:**
`../audits/V1-TED-TEST-MATRIX.md` (INT-01–INT-24 com SHAs/comandos reais) e
`../audits/V1-TED-AUDIT-2026-10-15-SUPLEMENTO.md` (vereditos por issue, gates,
integridade/segurança, limitações). Sem fechar issues, sem merge, sem código
de produção, sem tags/releases.

### 9.1 Status das fases/lotes

| Lote | PR (OPEN, sem merge) | Issues | Evidência real | Status |
|---|---|---|---|---|
| A | #192 (`0099ae9` #184 + `895440f`/`94ddeee` #185) | #184, #185 | CI + PWA CI verdes; tester 143/143 combinado + typecheck; reviews APPROVED | CORRIGIDA (PR OPEN); merge = gate humano |
| BC | #193 (`0267c4c` + `80a0832` + `a3654c7`) | #187, #186, #189 | CI verde (1 rerun flake e2e UI-05/PUSH-02, mesma família histórica); agent suite 2589 + focados + typecheck; reviews APPROVED | CORRIGIDA (PR OPEN); merge = gate humano |
| #188 | #194 (`1536164` + `c42a63f`) | #188 | 46/46 PG descartável + typecheck; CI verde; review com limitação declarada (guardless sem re-execução independente) | PARCIAL; merge = gate humano |
| #178 | #195 (`ce245b8` + `d4aeaa0` + `b3d8f51` + `67fbe5f`, test-only) | #178 | validação estática (typecheck + eslint + collect); live NÃO executado (sem credenciais) | INCONCLUSIVE |
| Melhorias | #196 (9 + 1 commits) | a rastrear issue-a-issue | tester PASS + typechecks; review APPROVED | cobertura por issue a confirmar |
| #174 | (fix que a fechou; SHA de merge a confirmar) | #174 | issue CLOSED — única fechada | CLOSED |

Fases do §1: F0–F4 com fixes em PRs OPEN (não mergeados); F5/G5 não atingido
(modelo-real INCONCLUSIVE); F6/G6 e F7 com releases fora do fluxo
autorizado (ver §9.3); F9 sem veredito CLOSED (nenhum item FULLY_CLOSED).

### 9.2 Decisões pendentes D1/D2/D3-sessões (gate humano, sem resposta inventada)

D1 (política de negação), D2 (escopo do guard de `routeIntent`) e D3 (formato
canônico do recibo de cancelamento por negação) seguem **gates de produto**
(A7): este plano não inventa a resposta. D3-sessões (decisões de sessão
pendentes — isolamento de drafts, expiração de sessão, anúncio de 401
definitivo e temas correlatos de #176/#177) juntam-se à lista como decisão
humana explícita antes de qualquer fix de comportamento.

### 9.3 Gates humanos (não executar sem aprovação explícita do operador)

- **Merges** dos PRs #192–#196 (gate humano A6; sem merge = sem CLOSED).
- **Live / modelo-real:** sem credenciais/provider autorizado — E2E live no
  SHA final pendente; INT-20/INT-21/INT-22-live INCONCLUSIVOS.
- **Release B:** flip bearer legado segue gate temporal do operador.
- **Cutover** F3–F5: gate humano (ADR-024/ADR-025).
- **Release `v1.0.2`:** manual pelo operador em 11:09:07Z (`gh release view`),
  fora do `release-promote` (único run `38581993569` de 14/10); gates
  CI/PWA/attest vieram depois — registrar como exceção de processo, não como
  precedente.
- **Tag `v1.0.3`:** NÃO criar nesta fase.
- **E2E live no SHA final** (pós-merge dos lotes): devido antes de qualquer
  veredito CLOSED; matriz INT sem FULLY_CLOSED até lá.
