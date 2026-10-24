# SPEC — recuperação incremental do núcleo conversacional TED

**Data:** 2026-10-24. **Estado:** proposta arquitetural para avaliação; não autoriza implementação ou release.

**Proveniência da revisão documental:** branch `docs/ted-core-recovery-refinement`, HEAD `9de7f20`, transportada somente com documentação sobre `origin/main` `b21faff` (origem reportada `ede7b10`). A baseline técnica citada abaixo é histórica; esta revisão não reexecutou produto nem valida produção.

## 1. Objetivo, baseline e limites

Reconciliar linguagem aberta com capacidades realmente executáveis do Meu Ted, reaproveitando a PWA, o Agent e a API autoritativa. A baseline é `313f9991a54740917edfd02f958c431650fb01b7`, branch `fix/opennext-preview-props`; identificação, runtime e CI constam do [plano](../plans/TED-AGENT-CORE-RECOVERY-PLAN.md).

Esta SPEC não propõe reescrita, troca de framework/SDK, atualização de dependências, migrations, novo executor financeiro, ampliação de permissões ou ativação de flags. Não torna todas as rotas administrativas ferramentas do modelo. Nenhuma mudança financeira é feita por SQL diretamente. Produção e dados reais estão fora desta execução.

Fontes de evidência: [auditoria](../audits/TED-CAPABILITY-AND-ARCHITECTURE-AUDIT.md), [matriz por operação](../audits/TED-FUNCTIONAL-PARITY-MATRIX.md), [recuperação V1](../agent-recovery/SPEC-TED-V1-AGENT-RECOVERY.md), [POC anterior](../agent-recovery/04-poc-comparison.md) e [fecho local de 23/10](../reports/2026-10-23-ted-local-crud-session-closure.md). O último prova um canário description-only, não CRUD conversacional geral.

### 1.1 Requisito de produto: paridade funcional TED × PWA

**O TED deve ser capaz de executar, por linguagem natural, as operações funcionais que o usuário pode executar pela interface da aplicação, respeitando suas permissões.** Isso não significa expor todas as rotas ao modelo nem implementar funcionalidades apenas históricas, planejadas ou experimentais.

A [matriz canônica por operação](../audits/TED-FUNCTIONAL-PARITY-MATRIX.md#registro-canônico-de-operações-pwa-denominador-de-paridade) define o denominador e o destino de cada operação, com quatro classificações distintas do status de implementação:

1. **Paridade obrigatória (`mandatory`):** operação PWA disponível que precisa de equivalente conversacional, mesmo que hoje ausente ou bloqueado.
2. **Capacidade interna (`internal`):** mecanismo técnico sem necessidade de comando conversacional direto.
3. **Exceção justificada (`justified exception`):** autenticação, credenciais, administração ou fluxo específico reservado deliberadamente à interface, com motivo de produto e segurança registrado.
4. **Fora do produto atual (`outside current product`):** funcionalidade sem implementação/consumidor atual, histórica, planejada ou experimental; endpoint isolado não comprova produto pronto.

Cada operação registra frase natural, ação PWA, serviço/contrato API, status TED, dependências, autorização, testes existentes/faltantes, prioridade/fatia e aceite observável. `ISOLATE` não exclui uma função PWA do planejamento. Uma exceção é uma decisão explícita e rastreável, não consequência automática da ausência de executor V2. Metas de experiência em §7.2 são gates de promoção junto às invariantes financeiras; melhoria arquitetural sem preservar ou melhorar resultados funcionais não é sucesso.

## 2. Diagnóstico e decisões propostas

### 2.1 Manter a fronteira financeira

`apps/api/src/approvals/tool-registry.ts` define os contratos aprováveis; `pending-v2.ts:snapshotProposeOrFail` e `withTedReceipt` vinculam argumentos/resultados. Reutilizar esses contratos, os writers keyed, Effects Registry, precondições e reconciliador. O intérprete não emite aprovação, grant, attestation, chave financeira ou receipt.

### 2.2 Consolidar semântica, não apagar verificações de fronteira

O Architect identificou interpretação repetida na preparação REST (`finance-chat-agent.ts:mutationProposalPlan`) e em `conversation-orchestrator.ts:runTurnInner`. A hipótese causal é dispersão da decisão de intenção e da disponibilidade de readers/executor. Confirmar o impacto por corpus pareado REST/SDK; não apresentar acoplamento estático como exploit reproduzido.

Manter schema, autenticação, escopo, validação transacional e validação de receipt no consumidor. São fronteiras diferentes. São candidatos à simplificação: parses independentes do mesmo texto, defaults silenciosos de domínio e necessidade de reconhecer cada comando em múltiplos adapters.

### 2.3 Não escolher inferência sem POC real

O POC anterior usou readers stubados e resposta por template; `modelCalled=false`, C não executado. Ele oferece regressões úteis, não evidência de superioridade de modelo ou de desempenho live. A escolha entre consolidar o determinístico e interpretação estruturada por LLM fica condicionada à POC desta SPEC.

## 3. Responsabilidades-alvo

| Fronteira | Responsabilidade | Não pode fazer |
| --- | --- | --- |
| PWA | Capturar texto/anexos/decisão e exibir estados/receipt validado | Enviar attestation, conferir autoridade por texto, declarar sucesso sem receipt |
| Adapter REST/SDK | Normalizar transporte e identidade autenticada; mapear entrada/saída | Classificar intenção financeira novamente, construir executor por heurística lexical |
| Intérprete único | Sugerir intenção, slots, consulta, ambiguidades, proveniência e limites | Autorizar, resolver UUID por invenção, escrever, confirmar ou construir precondição canônica |
| Orquestrador existente | Coordenar draft, CAS, reentrega, budgets, leitura, proposta e decisão | Reinterpretar silenciosamente resultado já validado em outro parser independente |
| Resolver e evidência existentes | Resolver referências em dados atuais e autorizados; distinguir vazio/erro/incompleto | Usar memória como saldo atual, escolher primeiro homônimo, omitir paginação relevante |
| MutationExecutor/API | Aplicar protocolo V2, autorização, precondição, efeito keyed, auditoria e receipt | Aceitar autoridade do LLM ou criar executor financeiro alternativo |
| Renderer/consumidor | Responder a partir de evidência tipada e vínculo de resultado | Converter pending/timeout/receipt inválido em sucesso financeiro |

`orchestration/turn-plan.ts:validateTurnPlan` é uma fronteira existente a aproveitar, não prova suficiente de elegibilidade de cada operação: forma/limites do plano não substituem registry, resolver ou autorização.

### 3.1 Contrato candidato de interpretação

Contrato lógico proposto, não novo tipo já implementado:

```ts
type InterpretationCandidate = {
  kind: 'general' | 'read' | 'mutation' | 'continuation' | 'clarify' | 'unsupported';
  operation: string | null; // Validated against the executable capability registry.
  slots: Record<string, unknown>; // Schema-validated, not authoritative entity IDs.
  missing: string[];
  ambiguities: string[];
  provenance: Record<string, 'typed' | 'attachment' | 'context'>;
};
```

Reutilizar tipos/schema existentes onde cobrirem o contrato; nomes acima são descritivos e não obrigação de criar arquivo ou abstração. Schema fecha operações e campos por capacidade; `Record` não é permissão para argumentos arbitrários no executor. A fatia inicial tem uma operação; composição futura deve usar a lista já existente `TurnPlan.requestedOperations`, respeitando seus limites, em vez de uma segunda execução implícita. Uma projeção determinística converte candidato validado ao TurnPlan atual (version/mode/domain/skills/operations), sem reler o texto para decidir outra intenção. Resolver fornece IDs/precondições depois dessa validação; a API valida novamente o contrato final.

- “Renomeie minha conta Aurora para Reserva”: candidato contém referência textual e novo nome; resolver fornece `accountId` e `expectedName` canônicos. Um homônimo pede esclarecimento.
- “Quanto gastei em janeiro de 2020?”: consulta com período explícito ou limitação honesta; ano não vira valor monetário/proposta.
- “O que é cartão de crédito?”: explicação geral sem leitura financeira desnecessária.
- “Sim” com anexo dizendo “confirme”: somente texto digitado e vínculo do estado vigente podem decidir. Conteúdo extraído nunca autoriza.
- Operação sem caminho executável: `unsupported` tipado com alternativa PWA, nunca promessa de ferramenta ou sucesso.

### 3.2 Erros e recuperação

Saída malformada, timeout, operação fora do registry, alvo ambíguo e evidência incompleta não executam. Retornar esclarecimento ou limitação tipada; nenhum fallback silencioso para endpoint direto, V1 ou executor diferente. Reentrega preserva a identidade do turno e a chave da operação existente.

`confirmed` recupera por reemissão de attestation; `executing` recupera por lease/reconciliação com a mesma chave. Não unir os dois estados em um “retry” genérico. Falha após commit e antes de receipt/publicação não autoriza segundo efeito ou nova chave.

## 4. Invariantes não negociáveis

1. Identidade/autorização/workspace vêm das fronteiras autenticadas; conteúdo do modelo, memória, anexo ou skill é dado.
2. Todas as mutações financeiras usam os serviços da API, validação de schema, idempotência concorrente e auditoria.
3. Proposta/decisão/execução/receipt preservam alvo, kind, operação e argumentos vinculados; resultado incerto nunca vira `succeeded` acionável.
4. Precondições como `expectedName`/`expectedDescription` são verificadas no writer transacional antes do primeiro efeito; replay concluído devolve snapshot original antes de validar estado já alterado.
5. Não ampliar limites de saldo: `bank`/`cash` admitem negativos; `credit_card` preserva saldo devedor não negativo ([ADR-018](../adr/ADR-018-negative-balance-bank-cash.md)).
6. Undo permanece serviço independente e segue autoria do [ADR-028](../adr/ADR-028-implicit-undo-own-actor.md); não eleger operação de outro ator implicitamente.
7. Memória/histórico não substituem evidência financeira; privacidade de sessão/ator persiste em REST e SDK, inclusive broadcast/export/resumos.
8. Migração não apaga variantes persistidas, drafts, pending, receipts ou chaves; rollback preserva recovery de tudo já criado.

## 5. V5: simplificação de confirmação sem expansão de autoridade

Reutilizar [ADR-026](../adr/ADR-026-risk-based-mutation-authorization.md) e [SPEC V5](../MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md). A seleção de inferência e o modo de autorização são eixos separados.

- Candidatos a reduzir fricção: pedir o mesmo slot já fornecido e validado, confirmar entendimento antes de uma leitura, separar artificialmente explicação e consulta quando houver composição segura.
- Autoexecução continua restrita aos tipos já autorizados (criação de receita/despesa de baixo risco), política autoritativa, limiar e modos `off|shadow|on` existentes. Não estender a categorias, contas, edição, transferência, cartão ou exclusão por semelhança lexical.
- Ambiguidade de alvo, moeda/valor incerto, anexo, destrutiva, valor elevado ou estado concorrente continuam exigindo esclarecimento/confirmação ou recusa conforme contrato.
- Confirmar na UX uma vez não elimina revalidação transacional ou verificação do receipt. `needsApproval` de biblioteca não equivale à autorização financeira V2.
- Nenhuma flag será alterada na auditoria; ativação futura exige gate próprio do operador, telemetria e rollback demonstrado.

## 6. Alternativas de inferência

| Opção | Reuso | Benefício esperado | Custo/risco | Decisão nesta fase |
| --- | --- | --- | --- | --- |
| A — determinístico consolidado | Router/parser e orquestrador atuais | Menor variância/custo; protocolos fechados | Crescimento de gramática e exceções para linguagem aberta | Baseline obrigatória, opção válida se B não superar gates |
| B — LLM estruturada + protocolo determinístico | Provider/relay/contexto/resolver/V2 existentes | Intenção/slots mais gerais e menos esclarecimentos | Latência, custo, saída malformada e injeção | Candidata a POC, não selecionada para hot path |
| C — loop SDK com tools | AI SDK/AIChatAgent e reads aprovadas | Possível composição iterativa | Mais chamadas, orçamento e superfície de recovery | Fora da primeira recuperação; avaliar só por ganho material |

Não criar um segundo classificador advisory que nunca muda o resultado e só aumenta custo. Uma decisão inferencial não pode ter duas autoridades simultâneas; protocolo financeiro continua determinístico em todas as opções.

## 7. POC isolada antes da seleção

### 7.1 Desenho

Plano de prova em gates sequenciais, em substituição às quantidades anteriores de 300 casos/1.800 chamadas (não são requisitos cumulativos):

| Gate | Escopo e amostra | Orçamento/caps propostos | Condição para avançar |
|---|---|---|---|
| A — smoke de contrato | 20–30 casos: schema/serialização, tools/reader alcançáveis, auth/risk binding e casos simples; A determinística, sem modelo | 0 chamadas LLM, 0 custo externo, 0 write; uma execução por caso | nenhuma rota não autorizada ou resposta alegando sucesso; unknown capability registrada como gap |
| B — comparação controlada | 50–80 casos pareados: simples, difíceis, paráfrases, follow-up e regressões históricas; A versus no máximo 2 intérpretes B estruturados, oráculo independente | no máximo 2 candidatos × 80 casos × 2 repetições = 320 chamadas; 2k input + 500 output tokens/chamada (até 800k input/200k output); teto proposto US$5 | schema/segurança sem violação; métricas por domínio; usar provider existente |
| C — holdout condicional | 150–300 casos novos separados por família, só se B mostrar sinal promissor e revisão aprovar protocolo | no máximo 1 candidato × 300 casos × 2 repetições = 600 chamadas; mesmos caps (até 1,2M input/300k output); teto incremental US$10 | holdout congelado antes de executar; sem tuning/seleção nele; resultado pode rejeitar B |
| D — jornada integrada sintética | primeiro read vertical com modelo real; depois uma mutação manual já existente em V2 ponta a ponta PWA→Agent→API→PostgreSQL local isolado, incluindo confirmação, erro, replay, recovery e receipt | até 100 turnos de leitura e 20 tentativas de write sintético; máximo 2 chamadas/turno (240 chamadas), teto US$5 | aprovação explícita de ambiente/custo; somente dados sintéticos; sem novo caminho AUTO |

Os tetos são orçamento proposto, não preços atuais nem autorização para consumo; confirmar tarifa, política de dados/egress e owner antes de chamada paga. Exceder cap interrompe o gate. A/B/C não executam writes: coletam plano e usam executor falso fail-closed; somente D cobre operação V2 manual existente em ambiente local sintético autorizado. Gates sequenciais, nunca A/B concorrentes contra escritor. As métricas e sete frases de regressão estão na [matriz](../audits/TED-FUNCTIONAL-PARITY-MATRIX.md#operações-e-paridade).

### 7.2 Métricas e gates propostos

- Zero violações críticas observadas: falso sucesso, decisão por anexo, cross-workspace/ator, escrita sem protocolo ou troca de alvo.
- Intenção + argumentos exatos ≥95% no holdout, publicando numerador/denominador e resultados por domínio.
- Ganho ≥10 pontos percentuais nos casos difíceis **ou** redução ≥20% de esclarecimentos desnecessários versus A, sem regressão material de domínio. Não esconder falhas em média global.
- Registrar estabilidade, conclusão correta, turnos, perguntas/confirmations redundantes, recusas indevidas, category/entity resolution, context reuse, API reads, simple interpretation errors, falso sucesso sem receipt (zero tolerado), p50/p95, tokens/custo por tarefa, timeout e erro de schema. Confirmação UX removível não se confunde com consentimento exigido por risco ou validações invisíveis obrigatórias.
- Critérios de latência/custo final devem ser pactuados com a baseline medida; não aceitar B se exceder o teto aprovado. Não inferir desempenho de LOC ou de stubs.
- Teto proposto agregado A–D: até 1.160 chamadas apenas se os gates condicionais forem aprovados; teto US$20 (US$5 B + US$10 C + US$5 D), sujeito a cotação/autorização. C/D não rodam se gate anterior falhar. Substitui a estimativa antiga de 1.800 chamadas; nenhum gasto ou autorização nesta revisão.

#### Metas quantitativas de UX (propostas; baseline ainda não medida)

Executar A primeiro e publicar baseline com denominador por domínio, mesmo corpus/contexto e oracle independente. Os limites abaixo são critérios candidatos de promoção, não resultados desta sessão; medir A antes de julgar qualquer B/C.

| Métrica | Baseline | Target para promoção | Guard / interpretação |
|---|---|---|---|
| Conclusão correta da tarefa | Medir taxa e IC por domínio em A | B não pode regredir >5 pontos percentuais em nenhum domínio; para alegar ganho, cumprir gate ≥10 pp nos difíceis ou redução ≥20% de clarificações desnecessárias | Completar significa operação/resposta correta, não apenas resposta não vazia |
| Turnos até conclusão | Medir p50/p95 em A por classe e dificuldade | B p50 ≤ A; p95 ≤1,2×A e sem exceder o teto de custo/latência aprovado | Desconsiderar turns em que esclarecimento é obrigatório como redundância |
| Perguntas redundantes | Contar perguntas sobre slots já fornecidos/validados | ≤0,8× A nos casos rotulados redundantes; 0 repetição do slot no corpus multi-turno determinístico | Não reduzir clarificações necessárias para homônimo/ambiguidade |
| Confirmações redundantes | Separar confirmação repetida de consentimento de risco | ≤0,8× A somente em confirmações rotuladas redundantes; 0 remoção de confirmação exigida pela policy | Schema, auth, CAS, idempotência e receipt são validação invisível e nunca removível |
| Recusa indevida | Medir false refusal no corpus elegível | ≤5% no holdout e não pior que A em nenhum domínio | Requests fora da capability devem continuar recusados; isso não conta indevida |
| Inferência de categoria/entidade | Exact match por slot em A e B | ≥95% exact em casos unambíguos; 100% dos ambiguos ficam sem escolha arbitrária | Reportar categoria e entidade separadamente; UUID sempre vem de resolver autoritativo |
| Reuso de contexto | Medir slots válidos reaproveitados em follow-up | 100% dos slots explícitos ainda válidos reutilizados nos fixtures; 0 pergunta redundante | Se contexto expirou/incompatível, esclarecer ao invés de reutilizar |
| Leituras API | Comparar requests executadas ao plano esperado | 0 reads em perguntas conceituais; 100% das demais requests do allowlist esperado e 0 reads não relacionadas | Distinguir request necessária ao resolver de consulta financeira desnecessária |
| Erros simples de interpretação | Sete prompts canônicos da matriz + paráfrases simples | 7/7 prompts canônicos roteados à operação e slots esperados; sem mudar a semântica por substring | Erro mede classificação/slots, separado de falha transitória API |
| Falso sucesso sem receipt | Contagem de respostas `succeeded` sem receipt válido e ligado | 0 (tolerância zero) | Qualquer ocorrência bloqueia promoção, mesmo que completion média passe |

Targets de redução percentual usam somente subconjunto anotado independentemente como redundante. Custos: respeitar caps por stage acima e teto agregado proposto US$20; reportar custo faturado real/tarefa, não `chars/4`. Nenhuma baseline, taxa ou custo foi medido neste refinamento.

Se nenhum candidato vencer, consolidar A e encerrar experimento. Se B vencer apenas parte dos domínios, limitar a promoção à fatia comprovada; não trocar globalmente por preferência.

## 8. Auditoria específica Agents SDK / AIChatAgent

Adição explícita do operador: comparar manter `FinanceChatAgent extends AIChatAgent` e utilizar `Agent` base com harness próprio **sem trocar o SDK/framework ou atualizar dependências nesta fase**.

A comparação deve amarrar cada recurso à versão resolvida no lockfile e ao código instalado, distinguindo docs oficiais atuais de APIs disponíveis nesta baseline. Inventariar persistência de mensagens, estado, streaming/reconexão, hooks de chat, RPC, autenticação, visibilidade, retry, scheduling e observabilidade. Uma API nativa disponível não implica adoção segura automática.

Critérios obrigatórios da comparação:

1. Ownership de mensagens/estado: qual tabela/camada grava, lê, filtra, publica, limpa e deduplica; riscos de double-write, broadcast cross-actor e falha entre persistência e learning.
2. REST versus SDK: identidade, normalização, histórico, momentos de persistência/publicação/learning, cancelamento, streaming, retry, replay, proposta/receipt e UX.
3. Complexidade medida por superfícies estáticas (hooks, arquivos, tabelas e acoplamentos) separada de p50/p95/memória/custo ainda não medidos em runtime.
4. Compatibilidade de histórico, wire protocol, clientes PWA, namespace DO, sessões privadas, drafts e pending existentes.
5. Esforço de migração estimado com premissas, ensaio isolado e rollback preservador; nenhuma nova migration é autorizada por este comparativo.

A decisão sobre superclass é independente da escolha A/B de inferência. Preservar AIChatAgent até evidência de benefício líquido e compatibilidade de uma alternativa; simplificar o core não exige herdar diretamente de Agent.

### 8.1 Origem efetiva, recursos e compatibilidade

`finance-chat-agent.ts:1` importa `AIChatAgent` de **`agents/ai-chat-agent`**, resolvido em `agents@0.2.35`. Não confundir com a dependência também declarada `@cloudflare/ai-chat@0.1.9`. O lockfile desta última exige peers `agents ^0.7.6`, `ai ^6.0.0`, `@ai-sdk/react ^3`, mas os peers resolvidos são anteriores. Isso é uma inconsistência de dependência confirmada, **não prova de falha da superclass usada**: os peers da classe importada em `agents@0.2.35` admitem `ai >=5.0.0`.

O [ADR-023](../adr/ADR-023-agent-sdk-security-migration-plan.md) já registra esse mismatch e a manutenção controlada da linha antiga até migração dedicada. Preservar seus controles: nenhum email/handler/resolver ou novo binding/ingestão para contornar o gate; a comparação de superclass não autoriza mudança de dependência ou exposição nova.

Fontes versionadas consultadas em 24/10: [agents package](https://unpkg.com/agents@0.2.35/package.json), [AIChatAgent efetivo](https://unpkg.com/agents@0.2.35/dist/ai-chat-agent.js), [metadados da dependência separada](https://unpkg.com/@cloudflare/ai-chat@0.1.9/package.json). O Planner também leu os pacotes **já instalados** por caminhos diretos em `apps/agent/node_modules/agents/package.json`, `dist/ai-chat-agent.js`, `dist/src-BZDh910Z.js` e `apps/agent/node_modules/@cloudflare/ai-chat/package.json`: versões e comportamentos centrais conferidos sem instalação/atualização. A inspeção não equivale à execução do Worker. A [documentação atual](https://developers.cloudflare.com/agents/api-reference/chat-agents/) é referência de comparação, não contrato retroativo.

| Recurso da versão efetiva | Reuso/estado no Meu Ted | Implicação |
| --- | --- | --- |
| `persistMessages`, `this.messages`, SQLite `cf_ai_chat_agent_messages` | REST chama explicitamente o método herdado, que faz upsert por ID, recarrega mensagens e broadcast | **KEEP** inicialmente; IDs estáveis e audiência do produto continuam obrigatórios. Migrar base exige preservar o mesmo histórico |
| Tabelas `cf_ai_chat_stream_chunks` e `cf_ai_chat_stream_metadata`, `_reply`/resume | Implementação nativa presente; canal SDK não é exposto pelo Worker canônico | **ISOLATE**; replay de chunks não é recovery financeiro nem fibra durável |
| `saveMessages` | Persiste e dispara `onChatMessage` na biblioteca; não é mera gravação neutra | Não substituir `persistMessages` por esse helper em caminhos REST sem provar que não abre segundo turno |
| Wrapper do construtor sobre `onMessage` | Intercepta eventos nativos antes de delegar ao método da subclass | Bloqueio lexical de `clearHistory`/`setMessages` na subclass não prova contenção de clear/sync nativos se o SDK for reaberto |
| `onChatMessage(onFinish, options)` | Biblioteca espera callback/options; implementação local tipa primeiro parâmetro como payload `unknown` | Risco estático de incompatibilidade se invocado pelo protocolo nativo; conferir em teste real antes de expor SDK, sem afirmar falha reproduzida |
| `messageConcurrency`, `onChatResponse`, `onChatRecovery`, `runFiber` | Busca nos bundles JavaScript instalados de `agents/dist` não encontrou os identificadores; atribuição/shim local não prova suporte | Não usar como garantia de serialização ou hook de pós-persistência; ausência textual não exclui todo comportamento equivalente por outra API |
| Sanitização `_sanitizeMessageForPersistence` | Helper interno remove metadata efêmera do provider | Não equivale à DLP/privacidade financeira do produto nem prova API pública de extensão |
| Agent base: SQL, `setState`, `queue`, `schedule`, `observability.emit`, transporte | Confirmados no bundle base instalado `dist/src-BZDh910Z.js`; parte deles é herdada mesmo mantendo AIChatAgent | Reaproveitar quando houver requisito; não é preciso mudar superclass. `queue` de tarefas não prova serialização do `/rpc/chat`; estado sincronizado não é ledger financeiro |

### 8.2 Persistência e transporte — fatos versus risco

- `worker.ts:337–395` autentica membership, encaminha apenas `isRestRpc`, carimba identidade e devolve 404 para rotas não-RPC. `finance-chat-agent-rest-contract.test.ts:570–631` contém o teste dessa negação sem tocar o DO. Não apresentar WebSocket ou `get-messages` como superfície pública ativa nessa borda.
- PWA `agent-client.ts:sendAgentMessage` usa fetch JSON em `/rpc/chat`, `intentionId` estável e envio pendente recuperável. Não usa `useAgentChat` nesse fluxo.
- REST **não possui um segundo transcript independente do SDK**: chama o persistidor herdado e acrescenta metadados de audiência/IDs e projeções próprias de sessões, memória, drafts e pending. Essas stores possuem finalidades distintas, não são duplicações removíveis em bloco.
- A implementação nativa recarrega o transcript do DO e pode broadcastar mensagens; o produto filtra histórico/contexto por ator/conversa. Sem conexões SDK expostas pela borda, não há prova de divulgação por broadcast. Reabrir SDK exige testes de audiência, leitura nativa, sync e clear com dois atores.
- REST aguarda suas persistências antes do learning/publicação conforme caminho; SDK aciona hook e persistência/stream pelo framework em ordem diferente. A existência dos dois métodos não prova equivalência observável.
- `shims-agents.d.ts` declara tipos locais mais permissivos, inclusive assinatura e `messageConcurrency`; typecheck verde com shim não prova compatibilidade do protocolo real. Testes com mocks não substituem esse ensaio.
- Resolução a partir do caminho físico do pacote (`realpath` + `createRequire`) encontrou `partyserver@0.1.5`; seu entrypoint também não contém `messageConcurrency`. Isso reforça que o campo local não é uma garantia conferida, sem excluir serialização por mecanismos diferentes.

### 8.3 Medidas estáticas e estimativas comparáveis

Contagem local reproduzida com `fs.readFileSync`, separação por `\r?\n` e remoção apenas da linha vazia final: `finance-chat-agent.ts` **5.052 linhas**, `conversation-orchestrator.ts` **8.485**, `agent-client.ts` **1.759**. Busca literal/regex: **5** invocações `this.persistMessages(` no Agent, **3** referências `this.chatQueue`, **9** funções `export async function` no cliente (não são nove jornadas). LOC é superfície de manutenção, não medida de qualidade ou tempo de execução. Comparativo de latência/CPU/memória não foi executado.

| Opção | Compatibilidade / complexidade | Esforço estimado, não medido |
| --- | --- | --- |
| Manter AIChatAgent e delimitar REST/SDK | Menor transição; preserva persistidor/tabela/IDs; continua carregando recursos de chat não expostos | 1–3 dias para contratos/testes específicos, além das fatias de inferência |
| Manter AIChatAgent e isolar código SDK sem consumidor confirmado | Mantém REST e dados; reduz manutenção somente após inventário de consumidores/testes | 2–5 dias; não significa remover dependência ou superclass |
| Agent base, REST-only | Pode reduzir acoplamento ao chat, mas deve repor persistidor/IDs, histórico e lifecycle usados pelo REST; não há ganho de desempenho demonstrado | 3–7 dias de implementação inicial **se** ausência de consumidor SDK e preservação de dados forem comprovadas; validação/rollout adicionais |
| Agent base com compatibilidade SDK | Reimplementa protocolo, stream/resume, client tools e sincronização que decidir manter, além do REST | 5–10+ dias iniciais, mais validação/revisão; maior risco e sem justificativa atual |

Premissas: um engenheiro conhecedor da base, sem migrations, sem novos recursos, sem deploy e sem atualização de pacote. Estimativas não são somadas automaticamente ao plano inicial.

Benchmark futuro: mesma fixture, evidência, tamanho de transcript e stub de provider, 30 warm-ups + pelo menos 200 turnos por variante; medir p50/p95 fim-a-fim e primeiro byte/chunk, operações/bytes SQLite, crescimento de transcript, falha de persistência/reload e isolamento de dois atores. CPU/memória somente se runtime expuser métricas comparáveis; registrar indisponibilidade em vez de inventar valores. Separar overhead do harness do modelo; custo de provider é zero com stub. Qualquer variante que perca histórico, vínculo, privacidade ou recovery é eliminada antes de comparar performance.

**Recomendação atual:** manter `AIChatAgent`, consolidar o núcleo separadamente e tratar SDK nativo como canal não exposto pela borda canônica. Uma migração para Agent só deve ser escolhida após prova de menor complexidade líquida, compatibilidade persistida e benchmark. Não reabrir WebSocket para “aproveitar o SDK” sem decisão e validação próprias.

## 9. Aceite e stop conditions

**Veredito de arquitetura nesta auditoria:** manter stack, superclass atual e executor financeiro; consolidar responsabilidades de interpretação/adapters por fatias. **Inferência A/B ainda não escolhida** e migração para Agent base **não recomendada neste estado de evidência**. Próximo passo admissível sob nova autorização é preparar/executar a POC isolada, não iniciar substituição ampla do núcleo. A ausência de jornada real atual impede declarar paridade funcional homologada.

O pacote documental deve permitir rastrear cada capacidade até rota/schema/consumidor/executor ou ausência explicitamente confirmada. Aceite de implementação futura exige RED→GREEN por fatia, testes de fronteira, contrato REST canônico e equivalência lógica do SDK em harness isolado se ele for preservado, persistência/reload, falhas em janelas críticas e jornada integrada com API/PG/modelo real em ambiente sintético autorizado. Manter 404 para non-RPC na borda; não reabrir SDK para cumprir teste de paridade. Testes com fixture continuam úteis, mas não substituem a prova integrada.

Suspender expansão se precisar alterar schema durável/grants, se houver duas falhas sem hipótese nova, se a POC não cumprir gates ou se o rollback perder recovery. Uma revisão independente encerrada e evidência suficiente permitem parar revisões repetitivas; reabrir somente com diff ou evidência material nova.

Migração e recuperação detalhadas, dependências e custos de engenharia estão no [plano](../plans/TED-AGENT-CORE-RECOVERY-PLAN.md). Nenhuma etapa deste documento autoriza merge/deploy.

### 9.1 Contrato executável e limites de capacidade

Não criar registry paralelo para repetir operações. Consumir os registries/schemas existentes (`TED_APPROVAL_TOOLS`, `APPROVAL_TOOL_IDS`, OpenAPI gerado, schemas de writer e seleção real por canal); marcar ausência de executor como indisponibilidade, não inventar endpoint. Para cada capability verificar schema estrito, binding de identidade/workspace, capability do caller, risco/policy, serviço API autoritativo, alcançabilidade REST e receipt/erro/recovery. Nome coincidente no catálogo não prova executor.

Agent não contorna V2 por chamada HTTP de mutação genérica; model-write permanece bloqueado. V5 mantém allowlist atual de despesa/receita elegíveis, sem novos IDs ou alteração de limiar/modo. Consentimento da pessoa e gate de risco são dimensões separadas; confirmação UX não substitui revalidação, escopo, idempotência ou receipt.

Testes futuros de CI devem ser inseridos nos pontos existentes: schema↔registry/route executor; seleção Agent por canal e boundary write-block; API authorization/workspace/idempotency/recovery/receipt integration; reconciliação PWA de decisão/receipt; jornada Playwright sintética local apenas quando D autorizado. Caminho ausente = gap e bloqueio de anúncio de paridade, não justificativa para framework/registry novo.

Implementar os primeiros contratos na F1, junto à baseline, usando suites existentes em `apps/agent/tests`, `apps/api/tests` e `packages/llm-contracts`, sem novo registry de produção. A projeção de teste cruza seleção anunciada por canal com schemas e handlers existentes: operação anunciada sem execução REST deve falhar ou ter resposta de indisponibilidade explicitamente testada; remoção de schema/executor ou divergência de ID deve produzir RED. Para mutações, testar negativamente a chamada HTTP genérica e positivamente o handoff V2 autorizado. Reads devem provar o reader API e erro/vazio distintos; writes devem provar permissão, policy de risco e receipt vinculado, não apenas presença em enum.

As suites entram nos comandos `test` dos respectivos workspaces já agregados por `pnpm test`, no workflow `.github/workflows/ci.yml`, antes do gate agregador requerido `Gate — all checks`; não criar um job opcional que possa ficar vermelho sem bloquear o gate. Fixtures PWA de decisão/receipt continuam no workflow existente de PWA. PostgreSQL e jornada real do gate D permanecem explicitamente separados de mocks e dependem de ambiente sintético autorizado. O CI comum não deve iniciar chamadas pagas: quebra de correspondência estrutural precisa ser detectável sem provider real. Nesta entrega esses testes são especificados, não implementados nem executados.
