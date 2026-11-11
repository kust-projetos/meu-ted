# PLAN-TED-V1-AGENT-RECOVERY

**Projeto:** Meu Ted
**Repositório:** `kust-projetos/meu-ted` (checkout: `D:\projetos\pi-financeiro`)
**Data:** 2026-10-19
**Versão:** 2.1-revisada (base v2.0 + auditoria 2026-10-19)
**Prioridade:** P0
**Documento-base:** `SPEC-TED-V1-AGENT-RECOVERY.md` (v2.1)

## Reconciliação documental — 29/10/2026

O restante do plano registra a baseline e os gates de 19/10; expressões como “pendente” ou “sem teste” abaixo não foram atualizadas individualmente e não são status corrente. Checkout inspecionado: `7ce96d03a6492a724cd8c6cb90bc1931a6a6a1ca`, branch `test/ted-f2b0-no-retry-controlled`.

| Item | Evidência posterior | Estado nesta reconciliação |
| --- | --- | --- |
| #255 | [Closure](../reports/2026-10-20-issue-255-partial-draft-closure.md), PR #260 / `dd4b164a` | Implementada no escopo relatado; teste dedicado presente, não reexecutado aqui. |
| #256 / #257 | [Relatório](../reports/2026-10-20-ted-256-257-month-summary-cards.md), PR #263 / `fc3006c` | Implementadas no escopo relatado; testes dedicados presentes, não reexecutados aqui. |
| POC V1 e recuperação | [Fechamento V1](../reports/2026-10-20-ted-v1-full-recovery.md), PRs #266/#267 | POC reads-only A×B e decisão `deterministic_fix` relatadas; alternativa C não executada. Não é a POC F2 posterior. |
| Gates G0–G9 | Corpo histórico deste plano e relatórios posteriores | **Não reconciliados individualmente** nesta revisão; não inferir que todos estejam abertos ou fechados. |

As pendências mais recentes do núcleo conversacional e suas fases constam do [plano de recuperação do núcleo](../plans/TED-AGENT-CORE-RECOVERY-PLAN.md). Nenhuma evidência histórica de CI, live ou deploy foi reexecutada nesta revisão; permanece o freeze de produção descrito no `AGENTS.md`.

## Revisão 2.1

- Baseline real: branch `fix/issue-255-partial-draft`, HEAD `1bd706d`
  (era `ac7fd5e` no doc 00; `origin/main=9af8781`). Working tree: só
  `docs/agent-recovery/` untracked — sem interferência em código.
- `jev_gate`: allow (risco 0.66, touches_prod=false) para docs + fix local.
- `jev_decide` arch: 0.48 deterministic_fix vs 0.50 sdk_loop (conf 0.25,
  inconclusivo) → mantém deterministic_fix condicional à POC.
- Ownership: `intent-router.ts` + `channel-evidence.ts` com 2 coders em
  potencial → **serializar escrita**; testes em arquivos distintos; Planner
  integra.

## 1. Missão

Recuperar e estabilizar o agente financeiro TED para o piloto V1, corrigindo
causas-raiz e simplificando redundâncias, com continuidade conversacional e
política financeira preservadas. Não autoriza reescrita geral.

## 2. Estratégia de execução

Etapas incrementais com evidência objetiva: diagnóstico → baseline → POC
→ decisão → consolidação → estado/mutações → consultas → frontend →
regressão → cutover.

## 3. Restrições globais

Preservar dados; sem 2º backend; modelo nunca escreve direto no banco; sem
reduzir idempotência/isolamento; sem mexer em auth sem necessidade; sem trocar
modelo sem benchmark; sem abstrações sem consumidor; sem parar por problema
menor não-V1; sem merge/deploy sem autorização; sem declarar sucesso só com
unit.

## 4. Fase 0 — Preparação (DONE parcial)

- Branch/commit: `fix/issue-255-partial-draft` @ `1bd706d`; `origin/main`
  `9af8781`; status limpo exceto `docs/agent-recovery/`.
- PRs/worktrees concorrentes: verificar via `git worktree list` + GH antes de
  codar (pendente shell).
- Pipelines: `pnpm test` (contracts+api+agent+broker+pwa), `typecheck`, `lint`
  por filtro, `test:e2e/test:unit/test:integration`; agent `vitest run`,
  `test:golden`, `eval:ted-v2/v3`; PWA e2e `playwright/live/live-mobile/
  live-conv/guard-fixture/no-api` + `run-ci.sh`.
- Issues: #255 parcial (teste existe), #256/#257 sem teste dedicado, #236-#242
  backlog em `docs/reports/2026-10-19-agent-audit-triage.md`.
- Ambientes: teste com Test Family `550e8400-…` (nunca `junio d36cb649-…`,
  household real com dados reais). Flags: wrangler tudo `0`/vazio; decision
  default-off; `TED_RISK_BASED_AUTOEXECUTE=shadow` só prod Contabo.
- Entregáveis: `docs/agent-recovery/00-orchestration.md` (atualizar HEAD),
  SPEC/PLAN/ADR v2.1, matriz de riscos.

### Gate G0

Prosseguir só sabendo arquivos/fluxos a mexer, sem sobrescrever sessão alheia.
Status: PASS para docs; codar após `git worktree list` + confirmação de branch.

## 5. Fase 1 — Auditoria funcional e arquitetural (EM CURSO)

### 1.1. Fluxo PWA — DONE (MAP-FLOW)

Cadeia confirmada em §2 da SPEC v2.1. Registrar caminho real sem assumir que
toda etapa roda todo turno.

### 1.2. Canais — DONE parcial

REST (relay sem tools), SDK (`streamText` + tools, `stepCountIs(5)`), broker
single-inference, fallbacks, erros. Falta: medir capacidades por canal na POC.

### 1.3. Inventário — DONE (COMPONENT-MATRIX)

KEEP: orchestrator, financial-parser, turn-plan/budget, PendingOperationCoordinator,
mutation-draft, intention-ledger/duplicate-detector, tools guards, responses/evidence,
mutation-executor/api-client/proposal, relay, worker/gateway, multimodal isolado.
SIMPLIFY: intent-router (1 gate), semantic-interpretation (pré-passo),
select-skill/tools (1 catálogo), confirmation renders (1 canônico),
llm/* (1 failover), PWA ted (1 fonte pending-op).
REPLACE: skill-inventory (pelo catálogo único).
ISOLATE: undo-proposal lifecycle, decision/*, multimodal, memory/privacy,
observability/shadow/legado.
REMOVE (após provar ausência de dependência): entity-resolver duplicado (1),
generated V1 do surface do modelo (manter OpenAPI).

### 1.4. Conflitos — DONE

Intents reclassificadas; skills vs tools; parser bloqueando LLM; leitura com
mutação pendente; render alterando sentido; tools não executáveis anunciadas;
estado só em memória; drafts vs FSMs; políticas discordantes.

### 1.5. Bugs — RED Status

- #255: reproduzido parcial (`issue-255-partial-draft.test.ts`); falta
  follow-up valor puro / monetary-alternative / small-talk guard.
- #256: sem teste dedicado → criar `issue-256-month-summary.test.ts` RED.
- #257: sem teste dedicado → criar `issue-257-cards-statements.test.ts` RED.

Testes de caracterização documentam comportamento atual + esperado + tool/read
+ estado antes/depois + backend + PWA.

Entregáveis: `01-audit.md`, `02-component-matrix.md`, `03-baseline-results.md`
(a materializar dos retornos MAP-FLOW/MATRIX/BASELINE) + testes reproduzíveis.

### Gate G1

Causas-raiz rastreáveis + baseline mensurável. Sem reescrita por hipótese.
Status: PASS parcial (falta materializar 01-03 a partir dos retornos).

## 6. Fase 2 — POC do agente mínimo (PRÓXIMA)

Experimental isolado: provider/modelo configurado, histórico, system mínimo,
registry pequeno de reads reais, resultados estruturados, resposta
fundamentada, telemetria. **Só leitura**: listar contas/cartões, transações,
resumo mensal, categorias. Sem writes.

Cenários: "Quais contas eu tenho?", "Liste meus cartões.", "Mostre minhas
faturas.", "Quanto gastei esse mês/passado?", "gastos de supermercado?",
"O que é cartão de crédito?", período sem dados (ausência real).

Comparação A (atual PWA) × B (experimental modelo atual) × C (referência).
Tabela: intenção/tool/args corretos, fundamentada, concluída, latência,
tokens/custo, alucinação.

Decisão: B>C + satisfatório → simplificada; atual falha + ref ok → capacidade
do modelo; ambos falham → contratos/contexto/prompt; legado melhor em domínio
→ reaproveitar.

Entregáveis: protótipo isolado + testes + `04-poc-comparison.md`.

### Gate G2

Sem migração sem tools/reads corretas, respostas fundamentadas e ausência de
execução indevida.

## 7. Fase 3 — Escolha e consolidação do runtime

Avaliar: reutilizar SDK, adaptar relay REST, adaptador comum, broker. Critério:
menor duplicação, compatibilidade, custo, testes, risco, auth/cotas/failover.
Registrar no ADR; implementar adaptador; conectar registry; preservar
cancel/deadline/accounting; testar com/sem tool calling; tratar falhas;
limitar passos.

### Gate G3

Novo caminho ponta a ponta em consultas antes de mutações.

## 8. Fase 4 — Consolidar interpretação e tools

Revisar `intent-router.ts`, `turn-plan.ts`, `semantic-interpretation.ts`,
`financial-parser.ts`, skills, registry, `channel-evidence.ts`.

Regras: LLM no novo caminho decide interpretação financeira normal; valores
determinísticos; entidades autoritativas; confirmação/cancel protegidos; parser
não nega intenção compreendida salvo entrada inválida/regra legítima; sem
duplicar decisão sem benefício.

Contratos: tool anunciada existe e é chamável; schemas válidos; vazio≠falha;
erros chegam ao runtime; sem cross-workspace.

Issues: #236, #237, #239, #240, #242.

Entregáveis: registry consolidado, instruções simplificadas, matriz atualizada,
testes de contrato.

### Gate G4

Nenhum 2º roteador semântico substituindo tool/read correta em silêncio.

## 9. Fase 5 — Estado conversacional e mutações

### 5.1. Rascunhos parciais

"Comprei uma bicicleta em 10x." → parcial recuperável (tipo, descrição,
parcelas, conhecidos, faltantes, intentionId, identidade/workspace, TTL). Sem
transação real.

### 5.2. Continuidade

"2500, sendo 10x de 250, no Nubank." → recuperar intenção autorizada,
associar turno, validar total/parcelas, resolver cartão, atualizar rascunho,
aplicar confirmação, executar só autorizado, recibo + estado final.

### 5.3. Adversariais

Duplo envio (turno e confirmação), cancel antes de confirmar, negação,
expiração, troca de workspace, resposta de outro usuário, cartão removido,
valor ambíguo, provider falhando pós-preparo, timeout pós-backend, reload entre
esclarecimento e confirmação.

### 5.4. Política financeira

Backend: validação, autorização, idempotência, integridade, recibos,
conflitos. Sem reimplementar no prompt.

Issues: #238, #255.

### Gate G5

Nenhuma operação incompleta perdida em silêncio; nenhuma reentrega com 2ª
mutação.

## 10. Fase 6 — Correção das consultas essenciais

### 6.1. Total mensal — #256

`get_month_summary`/analytics, base oficial, período preservado, sem extrato
para total, filtros conta/cartão/categoria, dados reais + período explícito.

### 6.2. Cartões — #257

`GET /cards/accounts`, cartões≠statements/faturas, mapeamento permitido,
ausência sem substituto, isolamento/PII.

### 6.3. Categorias

Inferência semântica + resolução válida, descrição preservada, sem perguntas
inúteis.

### 6.4. Sem dados

Ausência só a demonstrada; nunca global por parcial; nunca valor fictício.

### Gate G6

Todas básicas com tool/read correta e filtros preservados.

## 11. Fase 7 — Frontend e persistência

Envio, IDs estáveis, persistência par/pergunta-resposta, reconciliação pós-
streaming, reload, rede, duplicidade, temporário vs confirmado, pendências,
input preservado em erro recuperável.

Cenários: envio→resposta, reload pós/pŕe-resposta, offline, reenvio,
confirmação, reload→histórico, workspace + isolamento.

### Gate G7

Interface fiel ao persistido: sem perder/duplicar/modificar em silêncio.

## 12. Fase 8 — Benchmark e regressão

Suítes A (entendimento) B (ferramentas) C (conversação) D (integridade)
E (frontend) F (provider).

Mínimos P0: 100% determinísticos obrigatórios; zero mutação não autorizada;
zero duplicada por reentrega; zero cross-workspace; zero conclusão sem recibo;
zero P0 reproduzível; zero mensagem perdida em E2E principal. Linguagem
natural: taxa + precisão + baseline + melhora material + resíduos; sem aprovar
por 1 execução.

### Gate G8

Críticos verdes + comparativo com melhora real.

## 13. Fase 9 — Cutover e piloto

Preparação: flag, versão/commit, smokes, modelos, logs, rollback, backup/
integridade. Ativação: teste→dados controlados→autorização merge/deploy→
usuário teste→casos reais baixo risco→piloto→monitor→rollback se regressão
grave. Rollback por configuração, sem depender de apagar dados/desfazer
migração/recriar sessões.

### Gate G9

V1 apta só com runtime implantado validado, não só commit.

## 14. Ordem de dependências

```text
G0 — Preparação
 |
 v
G1 — Auditoria
 |
 v
G2 — Prova de conceito
 |
 v
G3 — Escolha do runtime
 |
 +-------------------+
 |                   |
 v                   v
G4 — Tools       G5 — Estado
 |                   |
 +---------+---------+
           |
           v
     G6 — Consultas
           |
           v
     G7 — Frontend
           |
           v
     G8 — Regressão
           |
           v
     G9 — Piloto
```

Paralelo só sem conflito de código/contratos/banco.

## 15. Política de testes

Bug: reproduzir → teste que falha pela razão certa → menor fix → direcionado
→ regressão → evidência → docs. Refator: caracterizar → preservar contratos →
migrar consumidores → remover antigo só sem dependência → validar na PWA.

## 16. Critérios para remover componentes

Responsabilidade absorvida, consumidores migrados, testes verdes, sem
dependência oculta, rollback independente, menos complexidade sem degradar.
Senão, isolar.

## 17. Gestão das issues

#255 continuidade parcelada; #256 resumo; #257 cartões×faturas; #236
agregação×registros; #237 catálogo; #238 mutação; #239 fonte leitura×mutação;
#240 gates; #242 keywords. Checar duplicadas; reclassificar para V1 só com
dependência concreta; nunca encerrar por substituição sem evidência.

## 18. Relatório de cada fase

FASE/STATUS/BASELINE (branch/commit/ambiente)/IMPLEMENTAÇÃO (alterados/
reutilizados/isolados/removidos)/EVIDÊNCIAS (testes/E2E/logs/regressões)/
RISCOS (conhecidos/impacto/mitigação)/DECISÃO (gate? falta? próxima).

## 19. Definição de pronto

Runtime consolidado; tools adequadas; consultas/mutações essenciais;
contexto persistido; críticos resolvidos; frontend confiável; modelo validado;
regressão aprovada; rollout/rollback testados; evidências no ambiente do
piloto. Evolutivos não bloqueiam V1.

## 20. Instrução final

Reduzir complexidade, corrigir causas-raiz, qualidade operacional. Nova camada
só com requisito real + teste de valor. Sem framework novo como solução para
tarefa básica quebrada.
