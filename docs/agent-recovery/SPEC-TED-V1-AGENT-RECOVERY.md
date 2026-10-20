# SPEC-TED-V1-AGENT-RECOVERY

**Projeto:** Meu Ted
**Repositório:** `kust-projetos/meu-ted` (checkout ativo: `D:\projetos\pi-financeiro`)
**Data:** 2026-10-19
**Versão:** 2.1-revisada (base v2.0 do operador + auditoria 2026-10-19)
**Prioridade:** P0
**Status:** Proposta para implementação

## Revisão 2.1 — o que mudou vs v2.0

Auditoria read-only (explorer ×3, 2026-10-19) confirmou a tese central e
precisou 4 pontos:

1. **Cadeia real mapeada** (`MAP-FLOW`): PWA → proxy same-origin
   (`apps/pwa/src/app/api/agent/[...path]/route`) → Worker
   (`authorizeWorkspaceMembership`, identidade server-side, `x-agent-*`
   sobrescritos) → DO `/rpc/chat` (`finance-chat-agent.ts:3895`) →
   `normalizeRestTurn` → `routeIntent` → `selectReads` → relay
   (`POST internal/agent/llm-relay`, sem tools) ou SDK (`streamText` com
   tools). Divergência REST-vs-SDK confirmada: mesmo `routeIntent`/plano,
   superfície executável distinta.
2. **Redundância quantificada** (`COMPONENT-MATRIX`): 3 camadas reclassificam
   intent (fastPath → decisionText → `hasMutationIntentSignal`/
   `interpretMutationUtterance` + gramáticas de continuação); skills vs tools
   com 2 seleções (keyword→skill→tools vs curadoria); 3 FSMs
   (draft + pending + undo); 2 resolvers de entidade; renderizadores de
   confirmação divergentes. Classificação KEEP/SIMPLIFY/REPLACE/ISOLATE/REMOVE
   em `02-component-matrix.md` (a escrever a partir do retorno).
3. **Bugs P0 localizados**: #256 (`intent-router.ts:116-119` — regex
   `gast*|despesas?` roteia para `list_transactions`, sem ramo
   `month-summary`; `channel-evidence.ts` tem o map mas nunca é planejado);
   #257 (`intent-router.ts:119` + `channel-evidence.ts:132,152` —
   `list_cards` mapeado para `statements`, sem `list_statements` dedicado);
   #255 com teste parcial existente
   (`apps/agent/tests/issue-255-partial-draft.test.ts`), follow-ups de valor
   puro ainda em hardening.
4. **Decisão arquitetural (jev, 2026-10-19)**: `jev_decide`
   `deterministic_fix` 0.48 vs `sdk_loop` 0.50, confiança 0.25 — **inconclusivo**.
   Critérios do projeto (menor risco, reversibilidade, piloto ≤5 usuários)
   mantêm `deterministic_fix` como preferencial condicional à POC;
   `sdk_loop` vira experimento isolado. `jev_gate` para docs+fix local:
   `allow`, risco 0.66, `touches_prod=false`.

Nada aqui autoriza deploy/merge, exclusão de dados reais, migração
destrutiva ou rotação de credenciais.

## 1. Contexto

O Meu Ted é um sistema financeiro pessoal com interface conversacional baseada
em LLM, integração com ferramentas e backend financeiro autoritativo.

O objetivo imediato é disponibilizar uma V1 funcional para uso pessoal,
inicialmente com até cinco usuários.

Os testes recentes identificaram problemas críticos:

- Interpretação incorreta de intenções financeiras.
- Seleção de ferramentas incompatíveis com o pedido.
- Falha na continuidade de operações com múltiplas mensagens.
- Dependência excessiva de classificação determinística.
- Sobreposição de componentes de roteamento, interpretação e execução.
- Respostas que não refletem corretamente as operações disponíveis.
- Possibilidade de regressões ao corrigir funcionalidades isoladas.

O projeto já possui infraestrutura significativa. A recuperação deve priorizar
a simplificação e reutilização, não uma reconstrução completa.

## 2. Problema arquitetural (revisado com evidência)

Fluxo real confirmado (sem suposição):

```text
PWA (agent-client.ts: sendAgentMessage, messageId 1x como intentionId)
 -> proxy same-origin (apps/pwa/src/app/api/agent/[...path]/route)
 -> Worker (authorizeWorkspaceMembership; identidade server-side)
 -> DO /rpc/chat (finance-chat-agent.ts:3895)
 -> normalizeRestTurn (typedText server-side; decisionText nunca do body)
 -> routeIntent (intent-router.ts:69) + mutationProposalPlan + re-interpretação no orchestrator
 -> selectReads (channel-evidence.ts:189, max 2 reads) + evidenceProvider (delegatedToken, householdId=workspaceId)
 -> provideUnifiedResponse (REST: relay SEM tools) | streamText (SDK: COM tools, stepCountIs(5))
 -> render determinístico ou LLM grounded -> persistMessages -> PWA (approval card / retry / reload)
```

A coexistência de componentes (`finance-chat-agent.ts`,
`conversation-orchestrator.ts`, `intent-router.ts`, `turn-plan.ts`,
`channel-evidence.ts`, `semantic-interpretation.ts`, `financial-parser.ts`,
`agent-config/tools.ts`, `agent-config/instructions.ts`, `decision/provider.ts`,
`internal-agent-llm-relay.ts`) não é o problema. O problema é **mais de uma
camada decidir a mesma intenção sem autoridade clara**:

- `routeIntent` × `mutationProposalPlan` (adapter) × `interpretMutationUtterance`
  (re-chamado no orchestrator) × gramáticas de continuação — 3-4 parses do
  mesmo texto.
- `decisionText` dual (typed vs composed) + `hasAttachmentData` server-side:
  regressão que ler do body reabre F1 (anexo "sim confirmo" decidindo).
- Relay truncado (`prompt.slice(15000)`, `system.slice(7900)`) + ledger de uso:
  correção grounding pode bater `usage_input_cap`.

Diferença de transportes confirmada: REST/PWA usa relay textual sem ferramentas
executáveis; SDK usa `streamText` com tools. A V1 deve resolver ou justificar
antes da liberação — decisão: **manter relay na V1 (deterministic_fix) e tratar
SDK-loop como experimento isolado** (ver §7).

## 3. Objetivo principal

Disponibilizar um agente financeiro que consiga, de forma consistente:

1. Compreender mensagens em português natural.
2. Identificar corretamente a intenção do usuário.
3. Escolher ferramentas financeiras adequadas.
4. Executar consultas no escopo correto.
5. Preparar e concluir operações financeiras permitidas.
6. Preservar contexto entre mensagens e recarregamentos.
7. Solicitar somente informações obrigatórias ausentes.
8. Inferir categorias e outros atributos não críticos quando houver evidência suficiente.
9. Corrigir interpretações quando o usuário esclarecer ou alterar dados.
10. Responder perguntas gerais sem executar ferramentas desnecessárias.
11. Reconhecer limitações e falhas sem inventar resultados.
12. Manter integridade financeira e isolamento entre usuários e workspaces.

## 4. Não objetivos

Esta iniciativa não pretende:

- Criar um sistema multiagente.
- Acrescentar advisors ou mecanismos autônomos avançados.
- Treinar ou ajustar modelos.
- Migrar o banco financeiro.
- Redesenhar todo o frontend.
- Reescrever módulos funcionais apenas para padronização.
- Expandir processamento de áudio, imagens ou PDFs.
- Implantar aprendizado automático de skills.
- Criar um mecanismo universal de workflows.
- Executar migrações irreversíveis sem necessidade.
- Introduzir controles novos sem um risco técnico demonstrado.

Esses temas ficam para pós-V1, salvo dependência comprovada de um requisito
essencial.

## 5. Princípios de projeto

### P1 — LLM responsável pela interpretação

A LLM deve participar efetivamente da compreensão semântica e da seleção das
ferramentas. Classificadores determinísticos não devem se sobrepor
silenciosamente à decisão semântica por corresponderem a palavras-chave
genéricas. **Ajuste 2.1:** na V1 o relay não oferece tools; a "seleção" é o par
(routeIntent determinístico → reads de evidência) + LLM grounded. A LLM
interpreta o pedido dentro das reads planejadas; não simular tool calling em
texto livre como autorização.

### P2 — Backend como fonte da verdade

A LLM não calcula saldos oficiais nem decide se uma transação foi persistida.
Valores, consultas, execução financeira, autorização e recibos pertencem ao
backend.

### P3 — Ferramentas executáveis

Uma ferramenta anunciada ao modelo precisa corresponder a uma capacidade real.
O system prompt não deve apresentar catálogo como executável quando o
transporte oferece somente geração textual. **Ajuste 2.1:** podar do surface do
modelo as 54 geradas não-expostas (`generated/http-tools.ts`, V1
get/confirm/cancel_pending + undo_last_action sob composição v2Only) e unificar
`toolSkillLines()` como única fonte skill→tool.

### P4 — Uma responsabilidade, uma autoridade

Diferentes componentes podem validar o mesmo dado em limites distintos, mas
não deve haver motores concorrentes decidindo a mesma intenção. **Ajuste 2.1:**
colapsar intent para 1 gate; confirmação/cancel para 1 renderer canônico;
entidades para 1 resolver; skills para 1 catálogo.

### P5 — Estado recuperável

Operações incompletas precisam sobreviver à próxima mensagem e, quando
apropriado, ao recarregamento. Reutilizar `SqlMutationDraftStore` (único
rascunho multi-turno sem autoridade financeira); isolar lifecycle de
`undo-proposal.ts` para não cruzar com draft.

### P6 — Simplicidade

Preferir poucos componentes bem definidos a arquitetura de várias camadas que
repetem a mesma função. Colapsar `llm/` (8 módulos de provider/failover) para 1
failover + allowlist.

### P7 — Segurança financeira proporcional

Preservar isolamento, autenticação, integridade, autorização, confirmação quando
necessária e idempotência (`deriveIdempotencyKey`, intention-ledger,
duplicate-detector, `approvalPresentation`). Não acrescentar impedimentos
genéricos que bloqueiem consultas, interpretação ou interação normal. Anexos:
gate por PRESENÇA (qualquer presença veta autoexecute; cliente elevado nem é
construído), `decisionText` só do `typedText` server-side.

### P8 — Evidência antes de substituição

Componentes e frameworks só serão substituídos quando testes demonstrarem
benefício real. POC reads-only (§7 PLAN) é gate G2.

## 6. Arquitetura-alvo

Fluxo principal (inalterado na forma; autoridades explicitadas):

```text
Usuário
   |
   v
Frontend do TED
   |
   v
Conversation Runtime
   |-- Autenticação e identidade da sessão (Worker; headers sobrescritos)
   |-- Histórico e contexto (persistMessages; SDK persiste pós-retorno)
   |-- Estado de operações pendentes (SqlMutationDraftStore + PendingOperationCoordinator)
   |-- Controle de turnos e tentativas (turn-plan.ts + turn-budget.ts)
   |
   v
LLM Runtime
   |-- Modelo configurado (allowlist do relay; fallback validado)
   |-- Interpretação semântica (dentro das reads planejadas na V1)
   |-- Seleção de tools (SDK) / seleção de reads (REST V1)
   |-- Interpretação dos resultados
   |
   v
Tool Gateway
   |-- Registry único de tools executáveis (curadoria tools.ts + OpenAPI gerada)
   |-- Validação de schemas
   |-- Identidade e escopo autorizados (delegatedToken, householdId=workspaceId)
   |-- Contratos tipados
   |
   v
Backend Financeiro
   |-- Contas, Cartões, Transações, Parcelamentos, Categorias, Relatórios
   |-- Mutações e confirmações (MutationApiClient / PendingOperationCoordinator → API V2)
   |-- Idempotência, recibos, reconciliação por recibo
   |
   v
Banco de dados autoritativo
```

### 6.1. Responsabilidades

**Frontend:** capturar mensagens/ações; exibir mensagens e eventos persistidos;
mostrar execução, erros e confirmações; não inventar sucesso; não decidir
operação financeira. **Ajuste 2.1:** 1 fonte pending-op + receipt canônico
(card TED vs página compromissos hoje duplicam decisão).

**Conversation Runtime:** recuperar histórico; manter sessão e pendências;
coordenar LLM; executar ciclo de ferramentas em limites; persistir turno;
recuperar falhas/reentregas. A17 só pós-`persistMessages` com `typedText`.

**LLM Runtime:** interpretar intenção/contexto; selecionar ferramentas (SDK)
ou operar sobre reads planejadas (REST V1); preencher args; interpretar
resultados; responder; pedir esclarecimentos.

**Tool Gateway:** expor só suportadas; validar; vincular identidade; preservar
autorização/limites por workspace; encaminhar; retornar erros estruturados.

**Backend:** validar regras; políticas de mutação; idempotência/integridade;
executar e emitir recibos; entregar dados oficiais.

## 7. Estratégia para o runtime de LLM

### 7.1. Inventário obrigatório (status 2.1)

- Modelo primário/fallback/provider/protocolo: **pendente de verificação
  operacional** via `evals/run-ted-v3-real-model-evals.mjs` (checa só presença
  de keys, nunca valores) + allowlist `registerAgentLlmRelayRoutes`.
  Não assumir tool support por aceitar chat completions.
- AI SDK compatível: `ai@5`, `streamText` + `stepCountIs(5)` no SDK; REST relay
  com `providerAttempted` + `reserve/finalize/releaseUsageAttempt`.
- Transportes: REST (PWA) sem tools; SDK com tools (mutação bloqueada em
  `tools.ts:449`, só MutationExecutor V2); broker single-inference.
- Tokens/custos/failover: ledger de uso + `relay-failover.ts` vs
  `private-broker-client.ts` vs `provider-registry.ts` (colapsar para 1).

### 7.2. Caminho preferencial (V1)

`deterministic_fix`: routeIntent colapsado (1 gate) + `channel-evidence.ts`
corrigido + relay preservado. Preserva identidade da chamada, nome/args da
tool (como reads planejadas), resultado correlacionado, histórico,
accounting, cancelamento/deadline.

### 7.3. Providers sem suporte nativo

Não simular autorização financeira interpretando texto livre como comando.
Ordem: (1) outro protocolo oficialmente compatível; (2) fallback validado;
(3) modo limitado explícito sem operações; (4) legado determinístico
temporário só para operações previamente validadas. Declarar honestamente o
suporte.

### 7.4. Comparação de modelos

POC reads-only (§6 PLAN Fase 2) com 8 cenários (contas, cartões, faturas,
total mês atual/passado, supermercado, "o que é cartão de crédito?", período
sem dados). Métricas: intenção correta, tool/read correta, args corretos,
resposta fundamentada, conclusão, alucinações, latência, tokens/custo,
chamadas desnecessárias. Troca de modelo só por resultado.

## 8. Registry e contratos de ferramentas

Fonte única de definição e exposição. Por ferramenta: nome estável, descrição
orientada à intenção, schemas in/out, classe read/mutation, auth, autorização,
confirmação, erro, disponibilidade. Catálogo da LLM derivado do executável.

**Ajuste 2.1 (bugs confirmados):**

- `get_month_summary`/`spending_insights` → `month-summary` existe no map mas
  nunca é planejado — corrigir `routeIntent` ("quanto gastei esse mês?" →
  agregação, nunca extrato).
- `list_cards` → hoje cai em `statements`; separar `cards` (GET
  /cards/accounts) de `statements`/`payables` (faturas).
- Podar V1 `get/confirm/cancel_pending` + `undo_last_action` do surface do
  modelo (manter só OpenAPI).
- Unificar `entity-resolver.ts` vs `tools/entity-resolution.ts` (1 resolver).
- Unificar `toolSkillLines()` (1 catálogo; `skill-inventory.ts` com 3 skills
  diverge do real).

### 8.1. Domínios mínimos

Transações (consulta/filtro/preparo de despesa/receita/correção-cancelamento);
Contas (lista/saldo/cadastro suportado); Cartões (lista/faturas/detalhes);
Parcelamentos (quantidade+valor, conta/cartão, confirmação); Relatórios
(mensal/período/categoria, base contábil); Categorias (lista/inferência/
validação autoritativa).

### 8.2. Regras de resultado

Estado (sucesso/vazio/falha/confirmação pendente), dados, escopo/período,
id/recibo, erro tipado, recuperabilidade. Nunca transformar falha em sucesso.

## 9. Roteamento e interpretação

Privilegiar contexto. Exemplo correto (total mensal → resumo compatível) vs
incorreto (regex `gast*` → extrato) — o incorreto é o bug #256 atual
(`intent-router.ts:118`).

Determinístico fica com protocolos onde semântica livre não basta: confirmar/
cancelar pendência, escopo/autorização, reentrega, expiração, interrupção.
Nunca reinterpretar consulta financeira normal para outro domínio.

## 10. Continuidade de conversa

### 10.1. Tipos de estado

Histórico vs contexto LLM vs operacional pendente vs preferências — podem
compartilhar storage, com responsabilidades distintas.

### 10.2. Intenção incompleta

"Comprei uma bicicleta em 10x." → estado parcial (tipo, descrição, parcelas,
faltantes, intentionId, identidade/workspace, TTL). Perguntar só o necessário.
"2500 sendo 10x 250 no Nubank." → recuperar intenção, associar turno,
validar, resolver cartão, atualizar rascunho, aplicar confirmação, executar só
quando autorizado. Nenhuma escrita só por estar completo.

### 10.3. Requisitos do estado pendente

Server-side, isolamento (workspace, ator, intenção), IDs estáveis, TTL,
cancel/negação, reentregas, anti-duplicação, revalidação, histórico.
Estender `SqlMutationDraftStore`; não criar 2ª FSM.

### 10.4. Correções do usuário

"Gastei 90 de carne." → [prepara/registra]. "Na verdade, foram 80." →
determinar rascunho editável vs pendente vs persistida; usar contrato
correspondente; nunca 2ª transação sem verificar relação.

## 11. Inferência de categorias

LLM sugere; gateway/backend valida contra catálogo do workspace; equivalência
autorizada ou esclarecimento; nunca inventar IDs; não alterar descrição.

## 12. Consultas financeiras

Preservar escopo, ator, período, filtros, moeda, base, proveniência.

### 12.1. Totais mensais

"Quanto gastei esse mês?" usa `get_month_summary`/analytics conforme intenção,
com base oficial identificada; filtros (cartão/conta/categoria/período)
exigem params compatíveis; nunca total global para recorte; ambiguidade
competência×pagamento só pede esclarecimento se material.

### 12.2. Cartões versus faturas

"Liste meus cartões" → `GET /cards/accounts`; "Mostre minhas faturas" →
statements; ausência de faturas ≠ ausência de cartões.

## 13. Mutação financeira

LLM prepara; backend executa. Schema, identidade, escopo, entidades reais,
valores normalizados, confirmação vigente, idempotência, recibo, conflitos.
Texto LLM ≠ autorização; anexo ≠ confirmação; autoexecute só no permitido.

## 14. Respostas e grounding

Geral (LLM direta); factual (sustentada no backend); operação (recibo);
ausência (só a demonstrada); erro (sem conclusão fictícia). Evitar
renderizadores que substituam correto por genérico; preservar guards contra
saldo inventado, afirmação sem evidência e falsa confirmação.

## 15. Frontend do agente

Mensagem permanece visível; resposta no turno certo; falha de rede não apaga
input; reload recupera persistido; sem duplicidade; pendências apresentadas;
confirmações atualizam; erros compreensíveis/recuperáveis; temporário ≠
persistido. Reutilizar componentes.

## 16. Observabilidade mínima

Turno, runtime/versão, modelo/provider, tool/read, resultado, falha/categoria,
duração, passos, uso/custo, intentionId, correlação confirmação-recibo. Sem
PII/segredos; nunca bloqueia operação válida.

## 17. Escopo pós-V1

Feature-flag: skills auto, competição por keywords, advisors opcionais,
multiagente, web avançada, multimodal não-essencial, automações proativas,
otimizações sem ganho provado. Não excluir sem análise de dependência.

## 18. Compatibilidade e rollout

Runtime legado preservado; novo isolado; seleção server-side; rollback sem
migração destrutiva; compatibilidade ou migração provada; testes dos dois
caminhos; nunca 2 mutações reais em paralelo. Shadow só observa/consulta sem
efeito (sem duplicar writes).

## 19. Requisitos não funcionais

Infra atual salvo incompatibilidade provada; limites anti-loop; timeout por
turno; accounting; falhas recuperáveis; sem advisor obrigatório; contexto
eficiente; privacidade; sem regressão de isolamento; sem custo/latência
injustificados.

## 20. Critérios de aceitação da V1

1. Issues #255, #256, #257 reproduzidas e corrigidas.
2. Consultas essenciais com dados e ferramentas corretos.
3. Mutações básicas preparadas/executadas conforme política.
4. Multi-turno preservando intenção/contexto.
5. Frontend sem perda/duplicidade.
6. Reentregas sem duplicar transações.
7. Falha de provider sem sucesso fictício.
8. Modelo ativo testado no fluxo real.
9. Sem falhas críticas que inviabilizem uso pessoal.
10. Rollback operacional.

## 21. Entregáveis exigidos

Mapa arquitetural; inventário; benchmark; POC; ADR; runtime consolidado;
contratos revisados; testes; E2E PWA; plano ativação/rollback; readiness.

## 22. Definição de sucesso

TED entende e executa tarefas financeiras comuns de forma natural e
consistente. Complexidade só se produzir capacidade necessária e comprovada.
Prioridade: agente confiável, não arquitetura impressionante.
