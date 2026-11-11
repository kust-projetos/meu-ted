# Diagnóstico técnico e matriz de substituição

**Data:** 2026-10-30. **Checkout inicial:** `218960d0fb0fba153dcf2bc4165b2a7a44495276`. **Revisão conferida para linhas/contagem:** `c9e73f114d72e4f270330978979d5e811dc1153c`. Outro trabalho adicionou duas linhas de binding de conversa no orquestrador e testes durante esta sessão; essas alterações foram preservadas. As referências não descrevem produção. Análise estática com consulta documental; sem reexecução de campanhas LLM.

## 1. Conclusão sustentada pela evidência

A hipótese de excesso de interpretação procedimental tem **suporte concreto**: a rota pública do TED faz planejamento, seleção de leitores, descoberta/continuação de rascunhos e decisões antes da geração; há respostas que nunca chegam à LLM. Isso explica classes específicas de rigidez e bugs históricos. **Não está provado** que todos os problemas derivem desse desenho nem que OpenCode os resolva.

Há uma oportunidade maior que apenas trocar provider: comparar o caminho atual com um loop em que a LLM pode consultar tools, interpretar os resultados e continuar. Preservar o roteador semântico inteiro antes do OpenCode impediria testar essa hipótese. Em contrapartida, remover a fronteira de autorização/proposta/receipt para “liberar a LLM” violaria o contrato do produto.

## 2. Fluxo efetivamente entregue à PWA

```text
TedChat → composeChatSend / sendAgentMessage
  → Next /api/agent/[...path] (same-origin, origem, headers, limites)
  → Worker /agents/finance-chat-agent/:workspace/rpc/chat
     → membership + canonical workspace + actor/device confiáveis
     → FinanceChatAgent DO por workspace
        → intenção/audiência/privacidade, histórico e rascunhos
        → routeIntent + ConversationOrchestrator.runTurn
           ├─ leitura planejada → API → evidência → render/grounding
           ├─ proposta/decisão → API Pending V2 → estado/recibo
           └─ quando necessário, provideUnifiedResponse
                 → API /internal/agent/llm-relay → provider
        → persistir par de mensagens/resultados e projetar AgentTurn
  → PWA valida pending/receipt, mostra output/card e reconcilia dados
```

### Pontos verificáveis

| Etapa | Fonte e contrato |
|---|---|
| UI | `apps/pwa/src/features/ted/TedChat.tsx:1016,1194`: envio e composição; `AgentTranscript.tsx` também consome client |
| Identidade do envio | `apps/pwa/src/lib/api/agent-client.ts:624,1188–1255`: `messageId` estável/persistido; JSON exato `{text, attachments, intentionId: messageId}`. URL `/api/agent/agents/finance-chat-agent/:workspaceId/rpc/chat` por default |
| Resposta | Mesmo client: `{turnId,intentionId,status,output,memorized,pendingOperation,undoProposal}` é projetado para `AgentTurn`. Não é o JSON nativo de OpenCode nem `response.text` do orquestrador |
| Proxy | `apps/pwa/src/app/api/agent/[...path]/route.ts`: `forwardHeaders`, `readBoundedBody`, `proxy`; tetos por rota, origin/CSRF, timeout 120s, repasse same-origin |
| Autenticação | `apps/agent/src/worker.ts:337–390`: `authorizeWorkspaceMembership`, canonical ID, sobrescrita de `x-agent-actor/role/workspace/device`; `idFromName(canonicalId)` |
| Superfície pública | `worker.ts:358,393–399`: allowlist RPC; **rotas não-RPC retornam 404**. `onChatMessage` existe no código, mas não é um segundo caminho público habilitado da PWA por esse gateway |
| REST | `apps/agent/src/finance-chat-agent.ts:4077,4270–4322`: monta contexto e clientes, verifica sinais/rascunhos, chama `runTurn` |
| Plano | `apps/agent/src/orchestration/conversation-orchestrator.ts:7220–7245`: `runTurnInner` usa `routeIntent(input.text,decisionText)` salvo plano injetado; plano limita skills/ops |
| Geração | `finance-chat-agent.ts:1608–1630,1805–1838`: `provideUnifiedResponse` vem depois do plano; relay recebe provider/model/prompt/system/sessionId/maxOutputTokens, **não um catálogo de tools** nesse payload |
| Persistência | `finance-chat-agent.ts:4322–4445`: persiste resposta final grounded/determinística com IDs derivados da intenção e audiência; learning depende da publicação/evidência |
| Decisão PWA | `agent-client.ts:1268–1364`: envia `{decision,requestId}` ao Agent; valida resposta estrita, operationId, receipt e contexto do alvo. Não recebe atestação |

O comentário de arquitetura em `apps/agent/AGENTS.md` descreve duas implementações de inferência (SDK/relay); a acessibilidade pública deve ser deduzida do gateway atual. Não confundir existência de código com rota realmente utilizada.

## 3. Responsabilidades próprias e sobreposições

### Interpretação e seleção

- `orchestration/intent-router.ts:320` (`routeIntent`) classifica modos/domínios/ambiguidades e operações.
- `conversation-orchestrator.ts:7270–7290,7335–7479` combina reconhecimento lexical, prioridades de rename/undo/forget/confirmação, continuação de rascunhos e coleta de campos.
- `finance-chat-agent.ts:4270–4297` calcula novamente sinais que determinam quais clientes/readers serão disponibilizados ao turno. Isso é acoplamento real entre semântica e disponibilidade de ferramenta.
- `conversation-orchestrator.ts:8360–8501` encerra classes unsupported/conceituais/leitura antes do provider; `:8542–8559` só então chama `responseProvider` no terminal genérico.
- `mutations/semantic-interpretation.ts`, módulos de creation/rename/deactivate e `mutations/mutation-draft.ts` carregam parte da interpretação e continuidade. Não são todos duplicatas da API: rascunho incompleto ainda não é uma operação financeira persistida.
- `agent-config/index.ts`, `skills/`, `select-skill.ts` e `tools.ts` montam contexto e catálogo com seleção/budget próprios. Há espaço para instrução e skill nativas; a suficiência depende de avaliação.

### Contexto e estado

`agent-config/memory/sessions.ts`, `store.ts`, `compact.ts`, `learn.ts` e `finance-chat-agent.ts` gerem histórico, resumos, preferências e aprendizado. O REST já injeta histórico visível (`sdkVisibleTurns`, `finance-chat-agent.ts:1641–1671`); “não há contexto” seria incorreto. O problema a medir é **qual contexto chega a qual decisão e ferramenta**.

Privacidade/visibilidade é contrato do produto: ADR-027, `privacy/conversation-visibility.ts` e metadados de audiência separam conversa coletiva e privada. Sessão nativa não substitui esse predicado. Preferências duráveis/forget transacional também não são equivalentes à compactação de histórico.

### Financeiro e apresentação

`orchestration/pending-operation-coordinator.ts` e `mutations/api-client.ts` adaptam protocolo, enquanto `apps/api/src/approvals/pending-v2.ts` é a autoridade. A PWA não é só uma caixa de texto: exige envelopes de proposta/resultado, apresentação acionável e recibos vinculados.

Parte da complexidade de confirmação textual vive no Agent (sightings, apresentações, binding antes de efeitos), por exemplo `conversation-orchestrator.ts:7292–7317,7912–8179`. A API valida identidade/estado/argumentos, mas seu gate `requireActionablePresentation` afirma explicitamente que prova **displayability, não que o humano viu a proposta** (`apps/api/src/routes/pending-operations.ts:89–109`). A POC pode usar confirmação por ação autenticada no card para reduzir essa coordenação; isso é uma limitação explícita de paridade conversacional, não uma equivalência automática.

## 4. Contratos financeiros que sobrevivem ao harness

- Identidade server-side: `pending-operations.ts:49–54,77–87`; contexto autenticado prevalece. O fallback legado de device token não é modelo de identidade para a nova integração. Capability `financial.approval.*` delegada é obrigatória; cookie ou chave comum isoladamente não basta.
- Proposta: `POST /pending-operations/v2/propose`, validação de tool/args, identidade, hash, TTL e replay por chave persistida.
- Confirmação/execução: atestação produzida/consumida no servidor, intention binding, claim/lease e revalidação. Atestação nunca vai ao modelo ou ao browser.
- Incerto: `pending-v2.ts:635–860` mantém execução incerta recuperável e reusa idempotency key. Texto “feito” não substitui `MutationReceipt`.
- Contratos compartilhados: `packages/llm-contracts/src/types.ts:379–389`, `schemas.ts` e effects registry.
- **Nove tools V2 no checkout:** expense/income create, transactions.update, accounts.create/deactivate/update, categories.create/update/deactivate. `transactions.update` é descrição-only; rename conta usa `accountId/name/expectedName`. ADR-021 histórico “só transações” não descreve sozinho o checkout atual; ADR-029 documenta a extensão de rename.
- Undo é caminho separado e actor-scoped conforme ADR-028; não é “revert session” do OpenCode. Autoexecute segue política/flags da API; a POC mantém manual.

`apps/api/src/routes/pending-operations.ts:18–46` documenta que rotas V1 foram retiradas, mas o contrato gerado ainda lista referências aposentadas. Portanto **reaproveitar contrato não significa expor todas as tools geradas sem verificar endpoint/capability real**.

## 5. O que os experimentos anteriores realmente provam

| Evidência | Observado | Conclusão permitida / limite |
|---|---|---|
| `docs/agent-recovery/04-poc-comparison.md` (20/10) | S7 conceito roteava leitura, S8 ano roteava mutação; POC mínimo template/stubs, `modelCalled=false`; C não executado | Há falhas históricas anteriores à LLM. Esses casos foram corrigidos depois; não afirmar bug vivo nem desempenho cognitivo do POC |
| `apps/agent/evals/reports/ted-f1-baseline.json` | 60 cenários, `llmCalls:0`, 16 syntheticRelayCalls, externalNetwork/realWriter false | F1 exercita fluxo real de código com dependências sintéticas; **não é avaliação com modelo real** |
| `ted-f1-journeys.json` | 10 jornadas; syntheticInMemoryOnly true, llmCalls 0, realWriter false | Boa fonte de jornadas/oráculos; não comprova transação real nem compreensão da LLM |
| Relatório B0 de 29/10 | 2/23 PASS, 17/23 schemas válidos; 6 erros descritor/parser, financialCompletion unobservable | Há erro de contrato/prompt e restrição de observabilidade; não equivale a 21 erros financeiros |
| Fechamento F2 de 30/10 | B2 DeepSeek e B4 Muse: 3/23; rejeição de B configurado; sem observação de conclusão financeira | Resultado histórico preservado. Não mede um loop nativo com descoberta de entidades e execução real de tools |
| Diagnóstico posterior do B2 | Registro distingue O=10 (oráculo), P=5 (prompt), H=3 (harness), M=1 (modelo), C=0 (parser); lente offline alterou classificação sem reescrever veredito | Hipótese “modelo mal servido” plausível, não provada. Esses números são registros históricos, não nova medição nesta sessão |

Fontes: [POC anterior](../agent-recovery/04-poc-comparison.md), [diagnóstico B0](../reports/2026-10-29-f2b0-diagnostico-problemas.md), [decisão F2](../decisions/2026-10-29-fechar-f2.md). A nota “prompt corrigido não validado” do relatório B0 é temporal; o fechamento posterior registra B2/B4 com schemas válidos. Não propagá-la como estado atual.

### Causalidade por classe

| Classe | Exemplo comprovado/documentado | O que a troca de harness pode fazer |
|---|---|---|
| Roteamento semântico próprio | S7/S8 históricos; branches determinísticos atuais e sinais que habilitam clientes | Retirar o pré-planejamento do caminho experimental e medir compreensão com tools |
| Contrato/prompt/oráculo | Descritor F2 incompatível e comparação de provenance/period/casing | Não desaparece por trocar runtime; schemas e oracle continuam precisando alinhamento |
| Provider/integração | Relatórios históricos de device token/quota/redirect/protocolo; tratamento atual em `llm/*` e relay | OpenCode pode absorver adaptação de provider, mas não corrige token TED/quota/permissão por si só |
| Backend/integridade | Receipt/lease/replay, descrição-only, capability de parcelamento não exposta | Preservar API; harness não cria capacidade ausente nem remove restrição de domínio |
| Contexto/UX | Rascunho parcial, audiência e confirmação de alvo apresentado | Sessões ajudam continuidade; contrato entre turno e operação ainda precisa de prova |

Não há base para uma porcentagem causal global (“todos os erros são regex” ou “o modelo é incapaz”). Nem o tamanho dos arquivos nem 3/23 isoladamente demonstram isso.

## 6. Tamanho medido, não economia prometida

Contagem física em 30/10, `.ts/.tsx/.js/.mjs`, excluindo diretórios `generated` e arquivos `.d.ts`; inclui comentários, linhas vazias e POCs. Subpastas são subconjuntos, **não somar à linha total**.

| Escopo | Arquivos | Linhas físicas |
|---|---:|---:|
| `apps/agent/src` | 141 | 48.572 |
| `src/orchestration` | 10 | 13.262 |
| `src/agent-config` | 30 | 6.851 |
| `src/mutations` | 21 | 7.659 |
| `src/llm` | 10 | 1.909 |
| `src/attachments` | 8 | 2.670 |
| `src/safety` | 3 | 585 |
| `src/poc-minimal` | 7 | 510 |
| `src/poc-structured` | 3 | 1.226 |
| `finance-chat-agent.ts` | 1 | 5.052 |
| `conversation-orchestrator.ts` | 1 | 8.568 |
| `intent-router.ts` | 1 | 1.126 |
| `worker.ts` | 1 | 407 |
| PWA `agent-client.ts` | 1 | 1.759 |

Reprodução (Node, raiz do repositório; somente leitura):

```js
const fs = require('node:fs'), path = require('node:path');
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(e =>
    e.isDirectory() ? (e.name === 'generated' ? [] : walk(path.join(dir,e.name))) :
    /\.(ts|tsx|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path.join(dir,e.name)] : []);
}
const files = walk('apps/agent/src');
const physicalLines = files.reduce((n,f) => {
  const s = fs.readFileSync(f,'utf8');
  return n + (s.match(/\n/g)||[]).length + (s.endsWith('\n') || !s.length ? 0 : 1);
},0);
console.log({files:files.length,physicalLines});
```

As 48.572 linhas não são todas “orquestração removível”. Só após paridade por responsabilidade será possível medir economia líquida, incluindo plugin, gateway, persistência e operação adicionados.

## 7. Matriz de substituição proposta

| Componente atual | Classificação | Destino/justificativa | Risco / prova exigida |
|---|---|---|---|
| API, PostgreSQL, writes, approvals, auditoria | **Manter na API** | Autoridade financeira já implementada | Paridade de identidade, idempotência, lease, receipt |
| `packages/llm-contracts` | **Reaproveitar** | Schemas/outcomes/presentation/effects | Mapeamento sem afrouxar validação; versões isoladas de Zod |
| `generated/http-tools.ts` | **Reaproveitar parcialmente** | Contratos/clientes das rotas vivas, não arquivo como catálogo completo | V1 stale; verificar rota, capability e shape |
| `worker.ts` auth e PWA BFF | **Reaproveitar / simplificar** | Manter fronteira confiável e envelopes; runtime atrás dela | Binding ator/workspace/device e CSRF |
| `routeIntent`, parsing lexical/semântico | **Substituir no experimento** | LLM + schemas/tools/instruções; baseline preservada | Valor/data/alvo incorreto; avaliação pareada |
| `ConversationOrchestrator` | **Separar e simplificar** | Retirar planejamento semântico concorrente; reaproveitar protocolo em cliente pequeno | Não transportar monólito para novo runtime; não retirar invariantes |
| `MutationDraft` de campos incompletos | **Simplificar / investigar** | Continuidade nativa + proposta somente com args completos | Contexto compactado, correção de alvo e restart; não tratar draft como autorização |
| Coordinator de pending V2 | **Reaproveitar contrato / simplificar adaptação** | API continua state machine; canal encaminha decisões explícitas | Replay/redelivery/apresentação; confirmação texto exige fatia própria |
| `onChatMessage` e relay conversacional | **Substituir após migração** | Um loop nativo no braço novo | Relay atual é texto, não simplesmente proxy de tool calling; medir integração do provider |
| `llm/*` catálogo/factories/failover | **Substituir o equivalente nativo** | Config de provider do harness | Não presumir fallback/quotas/privacidade equivalentes |
| Seleção própria de skills | **Substituir por recurso nativo** | Skills TED empacotadas e catálogo curto | Catálogo anunciado não garante uso correto; sem skills pessoais |
| Histórico/compactação | **Substituir por recurso nativo + adaptar visibilidade** | Sessões persistentes e resync | ADR-027, retenção, resumo incompleto, compat PWA |
| Memória durável/preferências/forget | **Investigar / manter fora da primeira POC** | Não equivalem a histórico nativo | Perda de preferências, consentimento/forget; não prometer paridade |
| `responses/*`, evidence envelope | **Simplificar seletivamente** | API structured results e receipt para estados, LLM para prosa | Preservar números/escopo/ausência; texto gerado pode mentir mesmo sem escrita |
| `decision/*`, judgment opcional | **Descontinuar no braço experimental** | Um agente/modelo, sem roteador auxiliar | Não confundir desligamento experimental com remoção da baseline |
| Anexos/R2/STT/Vision/PDF/web | **Manter / adiar integração** | Serviços separados com limites e proveniência | Capabilities fora do MVP experimental; sem egress novo |
| PWA cards/history/reconciliation | **Reaproveitar com adaptador** | Contrato `AgentTurn` e decisões existentes | OpenCode event não é receipt; UX sem falso sucesso |
| Testes financeiros, F1 e cenários | **Reaproveitar** | Expectativas independentes e corpus | Não usar DTO antigo como único oráculo nem regravar históricos |
| Legacy Pi e `FINANCE_RUNTIME_STAGE` | **Histórico, não restaurar** | Princípio single-owner reaproveitado | Busca em código `apps` não encontrou a variável; gateway documenta retirada do gate |

Cada substituição é candidata, não remoção autorizada. A primeira fatia mede leitura e uma proposta, não promete equivalência para todas as capabilities do produto.
