# SPIKE 04R — resultados: remediação final da avaliação conversacional

Data: 2026-10-31. Worktree: `D:/projetos/pi-ted-runtime-spike`, branch
`experiment/ted-opencode-runtime`, base `1567dae` (03B+04 seguem uncommitted,
sem push/PR/merge/deploy). Sem produção, sem Cloudflare, sem credenciais
reais no repo, dados sintéticos apenas. Nenhuma inferência live executada
nesta tarefa (0 turns, custo 0) — ver §8.

Veredito: **SPIKE_04_PARTIAL** — camada determinística fechada (avaliador
com dentes, isolamento com conteúdo, J07-A/B com oráculo independente,
restart real em 2 processos, superfície com provas negativas, regressões
verdes, review APPROVED); provas comportamentais com modelo real ficam
**PENDING** em campanha live separada (orçamento próprio, sem reutilizar os
US$5 do SPIKE 04). Detalhe no §9.

Skills: `systematic-debugging` (evidência antes de causa),
`writing-plans` (plano `reports/SPIKE_04R_PLAN.md`),
`verification-before-completion` (fecho por evidência).
Orquestração: **MULTI_WORKER** (6 frentes, 8 subagentes: 3 mapeamento/RED +
3 implementação + 2 reviews). Falhas de harness (sqlite lock em runs
combinados) registradas no §7, sem mascaramento.

## 1. Falhas originais preservadas (não reescritas)

- `reports/SPIKE_04_RESULTS.md` intacto: veredito PARTIAL, S04-03 FAIL
  (J07 off-by-one 2026-04 vs 2026-05), S04-08 FAIL parcial (fresh-session em
  vez de recuperação persistida), R vácuo (eco), J06 conteúdo untested,
  `apiResults: {}` nos 13 turns live.
- `reports/SPIKE_03B_TRACE_DIAG_HOOKBLOCK.json` intacto (123110 bytes):
  hook P1 bloqueando o wrapper `execute` (47 ocorrências de `forbidden`).
- `reports/SPIKE_03B_TRACE_T3.json` intacto (25783 bytes, backup do turno).
- `reports/SPIKE_04_TRACE_J02..J07.json` intactos em modo live
  (`apiResults:{}`, response em eco, vereditos pass do avaliador antigo —
  justamente os falsos-positivos agora detectáveis).
- **Incidentes de preservação causados por esta tarefa (registrados, sem
  ocultação):**
  - (i) `SPIKE_04_TRACE_J01.json` foi sobrescrito para modo dryrun pelo
    teste (b) do `spike-04-dryrun` (efeito colateral conhecido: o teste
    escreve no mesmo path do live). Conteúdo live de J01 preservado
    textualmente em `SPIKE_04_RESULTS.md` §4 (2 turns `list_accounts`,
    `ses_e6e9f4c0…`, 26,1s). Recomendação: dryrun futuro usar journeyId sem
    colisão (ex. `J01-DRYRUN`).
  - (ii) `SPIKE_03B_TRACE.json` foi sobrescrito para dryrun (7999 bytes)
    pelo `spike-03b-dryrun` durante as regressões 04R — **restaurado** do
    gêmeo byte-idêntico `SPIKE_03B_TRACE_T4.json` (29854 bytes, sha256
    `27dc8176…be1c4595`): sizes 29854/29854, `identical: True` pós-restore.
    Estado documentado em `SPIKE_04_RESULTS.md` §1 recomposto com evidência.

## 2. Correções realizadas (avaliador com dentes)

`bootstrap/spike-04-oracles.mjs` (201→213 linhas):
- `matchSummary` exige igualdade de `yearMonth` quando o esperado o define
  (ausente/divergente → `{ok:false}`). Antes, corpo do mês errado com
  números iguais passava (falso-positivo raiz do J07-t1).

`bootstrap/run-04-journey.mjs` (819→1007 linhas):
- `gradeTurn` aceita `'incomplete'` nos eixos execution/response
  (`pass/fail/not-exercised` legados intactos — dryrun a–j verde).
- Ramo live reescrito sem derivar expects de texto: sem expects →
  `incomplete` (`no oracle attached — evidence incomplete, not pass`);
  expects sem corpo/`apiResults` vazio → `incomplete`; mismatch →
  `fail`; resposta sem valores do oráculo → `fail`.
- Novo `responseGroundsOracle` (exportado): exige números distintivos do
  oráculo (|n|≥100) ou nomes de contas na resposta; aceita centavos crus e
  formato BRL (`R$ 12.000,00`→`1200000`, `R$ 2.880,50`→`288050` via
  normalização sem não-dígitos); eco da pergunta = fail. Meses all-zero sem
  marcador → `incomplete` honesto (nunca pass).
- Eixo args: `validateToolArgs` em TODAS as chamadas (helper
  `checkAllCallsArgs`, reason com índice); `yearMonth` exato.
- Duplicatas: `selectedTools` preserva repetições; duplicata não prevista =
  understanding fail (exact-set).
- `findResultBodies` coleta TODOS os corpos; divergência entre corpos do
  mesmo tipo → execution fail (antes: first-body-wins silencioso).
- Eixo identidade: host/slot registrado no reason (abort pré-prompt em
  host-mismatch já existente, não reinventado).
- Sete eixos do §2 cobertos por checks separados: compreensão, seleção,
  args, identidade, resultado backend, resposta, ausência de indevidas.

Sem router, sem regex de frases, sem MCP, sem memória, sem novas tools, sem
subagentes no produto, sem framework genérico, sem máquina de estados.

## 3. Testes negativos do avaliador (TDD RED→GREEN)

`tests/spike-04r-evaluator-neg.test.mjs` (NEW, 377 linhas, 16/16 PASS):
- Fase RED (código antigo): 4 fail / 2 pass — provou que o runner marcava
  pass sem oráculo, com `apiResults {}`, com mês errado e com eco.
- Contrato GREEN: (1) sem oráculo → `incomplete`; (2) 2026-04 vs 2026-05 →
  fail nos dois paths; (3) `apiResults {}` → `incomplete`; (4) eco →
  grounding fail; (5–6) controles positivos (valor mutado, cross-household,
  extra read-only); (7–11) mutações i–v (yearMonth trocado, 288050→288051,
  household trocado, extra read-only, resposta fluente sem valores);
  (12) sete eixos independentes; (13) duplicata `[×2]` → understanding
  fail; (14) args divergentes/forbidden com índice; (15) corpos divergentes;
  (16) BRL `R$ 12.000,00`/`R$ 2.880,50`/`R$ 9.119,50` groundam, eco falha.

## 4. J06 — isolamento com conteúdo (determinístico CLOSED; live PENDING)

`tests/spike-04r-journeys.test.mjs` — caso J06-CONTENT (5/5 no arquivo):
- `runDryrunJourney` com expects explícitos A/B: ambos execution pass.
- Corpos reais via `callFinance`: A = Itaú 100000 + Nubank 50000 (sem
  Bradesco/99999); B = Bradesco 99999 (sem Itaú/Nubank).
- Match cruzado fail nos dois sentidos (A-body vs oracle B e vice-versa).
- Slots `[0,1]` (host change abre slot — regra estrutural, sem texto).
- Registrado em-test: o live original (`apiResults {}`, sem expects) hoje
  gradeia `incomplete`, nunca PASS.
- **PENDING live:** provar com modelo real que B vê Bradesco no conteúdo
  da resposta (requer campanha com `TED_04_LIVE=1`, orçamento próprio).

## 5. J07 — contexto temporal separado (determinístico CLOSED; live PENDING)

- **J07-A (com contexto):** turns 2026-06 → 2026-05 na mesma sessão, ambos
  pass com `yearMonth` exatos; corpo 2026-04 contra oráculo 2026-05 → fail
  (yearMonth pinado). `2026-04` como resposta a "maio" é FAIL explícito.
- **J07-B (sessão realmente nova):** oráculo independente definido no
  header do teste — sem contexto anterior e sem default de produto
  estabelecido neste repo, o comportamento correto é **PEDIR
  ESCLARECIMENTO** (nenhuma tool financeira verifica "maio" avulso).
  Provas: `freshSession` abre slot novo; 2026-04 como "maio" = fail; eco =
  fail; mês all-zero sem marcador = `incomplete`.
- Sem regex temporal, sem roteador de intenções, sem abril-como-maio.
- **PENDING live:** comportamento do modelo em J07-B (esclarecimento vs
  default) e J07-A com modelo real (requer campanha autorizada).

## 6. Superfície de ferramentas (determinístico CLOSED)

`tests/spike-04r-tool-surface.test.mjs` (NEW, 189 linhas, 4/4 PASS):
- (a) `list_accounts` + `get_month_summary` executam via executores reais
  com host-bound context e batem oráculos exatos (A/B + isolamento).
- (b) `build03BConfig()`: allows=1 (`provider.use:opencode-go`);
  denies `tool.use:shell/edit/write/subagent:*` + `provider.use:*`; agent
  `ted` nega shell/edit/subagent; flat JSON sem finance tools.
- (c) `validateToolArgs` rejeita smuggling de identidade
  (actorId/token/deviceId/intentionId/workspaceId/householdId…);
  `buildExecute` sem sessionID → `host_context_required` (executor nunca
  alcançado) — prova por mecanismo.
- (d) `shell` observado → understanding fail ruidoso (abort path); shell
  nunca executado (só classificação).
- Distinção registrada: financeiras permitidas vs wrapper `execute`
  (codemode, input `{code:string}`, alvo resolve pós-execução — por isso o
  hook não valida alvo, e regex foi deliberadamente recusada) vs
  administrativas. Enforcement restante = denies + facade 7 chaves + abort
  pós-observação (limitação conhecida, experimento futuro dedicado).

## 7. Restart real (determinístico CLOSED; continuação com modelo PENDING)

`tests/spike-04r-restart-real.test.mjs` (NEW, 181 linhas, 1/1 PASS):
- Dois processos OS reais (padrão spike-03a T2): proc1 cria sessão via
  facade HOST_A + `get_month_summary` A 2026-06 observável, imprime sid,
  encerra; proc2 reabre o mesmo DB (`getSession` OK — sqlite persiste),
  execute sem re-bind falha `host_context_required` (binding é memória),
  `bindSession(sid, HOST_A)` restaura, re-execução valida oráculos exatos,
  cross-bind bloqueado, cleanup via `removeSession`.
- `clearAll()` no mesmo processo ou sessão nova documentados como NÃO-prova.
- Se compactação/recuperação perdesse contexto, a falha seria registrada
  (não observada neste path determinístico).
- **PENDING:** continuação conversacional com modelo real pós-restart
  (requer live autorizado).

Regressões (arquivos isolados; runs combinados travam sqlite — limitação
de harness, não do produto; ver nota abaixo):
spike-01 7/7 · spike-02 20/20 · spike-03a 17/17 · intention 8/8 ·
ownership 9/9 · 03a-restart 1/1 · 03b-dryrun 5/5 · 04-dryrun 10/10 ·
04R-neg 16/16 · 04R-journeys 5/5 · 04R-tools 4/4 · 04R-restart 1/1.
**Total: 103/103 PASS, 0 fail.** Nota: `node --test` com vários arquivos
no mesmo comando causa `database is locked` (sqlite compartilhado,
errcode 261) — evidência no log da sessão; cada arquivo isolado passa.

## 8. Revisões, inferência e linhas próprias

- Review 1 (independente, só leitura): **CHANGES_REQUIRED** — P1-1
  (duplicatas ocultam args/resultados) + P1-2 (grounding só centavos crus).
- Correções aplicadas (ver §2) + 4 casos novos (13–16).
- Review 2 (re-revisão focada): **APPROVED**. Risco residual do revisor:
  inspeção sem execução.
- Inferência 04R: **zero** — nenhum `session.prompt`, nenhum live
  (`TED_04_LIVE` nunca setado), custo 0, tokens não expostos pelo SDK
  (limitação conhecida). Provas live (J06 conteúdo, J07-A/B
  comportamental, restart com modelo) = **PENDING**, com comandos prontos
  e orçamento a autorizar em campanha separada.
- Linhas próprias acrescentadas: runner +188, oráculos +12, testes novos
  377+269+189+181 = 1016, plano 54 → **~1270 linhas** (+ este relatório).

## 9. Veredito e próximo marco

**SPIKE_04_PARTIAL** (mantido, com camada determinística fechada):
- Fechado: avaliador reprova valor/período/identidade/resultado ausente,
  eco e duplicatas; J06 conteúdo A/B; J07-A 2026-05 e J07-B clarificação;
  restart 2-processos com re-bind; superfície com negativas por mecanismo;
  103/103 testes; review APPROVED; sem nova infra de interpretação; sem
  produção/deploy.
- Pendente (só com autorização + orçamento novos): live J06 (conteúdo por
  identidade na resposta do modelo), live J07-A (mesma sessão) e J07-B
  (fresh esclarece), live restart (continuação com modelo), latências e
  custo real com tokens.
- Riscos/limites: grounding BRL por join de dígitos (baixo risco,
  execution exige backend); meses all-zero sem marcador → `incomplete`;
  wrapper `execute` sem gate pré-execução total (experimento futuro);
  `usage` sem contadores (SDK 2.2.4); J01-live JSON perdido (§1.i).

**SPIKE 05 NÃO iniciado.** Candidato (só com aprovação explícita):
proposta de gasto via Pending V2 sobre esta base, precedido da campanha
live 04R-pendente. Sem push, PR, merge ou deploy nesta tarefa.
