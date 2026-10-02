# SPEC — Meu TED V3: Hardening Ponta a Ponta

**Projeto:** Meu TED
**Status:** Ready for Planning (plano de execução em [`superpowers/plans/2026-09-14-meu-ted-v3-hardening.md`](superpowers/plans/2026-09-14-meu-ted-v3-hardening.md)) — **rev. 3:** revisão final de consistência (handoff recuperável draft → PendingOperation; recovery `confirmed` ≠ `executing`; MutationReceipt TED vs writes normais)
**Baseline auditada:** `main@e5f21177fc970c631fe47b80c584485fe0e0d47b`
**Data:** 14/09/2026
**Antecessora:** [`MEU-TED-SPEC-CONSOLIDACAO-E-AGENTE-V2.md`](MEU-TED-SPEC-CONSOLIDACAO-E-AGENTE-V2.md)
**Natureza:** hardening e correção; não é uma reescrita do produto.
**Idioma da documentação:** pt-BR
**Idioma do código:** inglês técnico

> Esta SPEC não autoriza reescrever o Meu TED, trocar de stack, executar deploy em produção, alterar segredos nem apagar dados. Autoriza correções e hardening entre as camadas existentes (PWA → Agent → API → PostgreSQL), migrations novas aditivas e testes de comportamento. Deploy somente após os gates da seção 27.

---

## 1. Resumo executivo

A arquitetura V2 do Meu TED continua sendo considerada correta em suas decisões fundamentais:

- API como autoridade financeira;
- PostgreSQL como estado financeiro persistente;
- Agent sem autoridade própria para escrever diretamente;
- PWA sem acesso direto ao banco;
- pending operations V2;
- attestation opaca;
- idempotência;
- `ConversationOrchestrator`;
- transporte same-origin;
- write policy;
- grounding;
- CI e gates de arquitetura.

A validação local registrada no repositório apresenta **13/13 gates verdes**, cobrindo lint, tipos, testes, builds, segurança, arquitetura, capabilities e smoke.

Entretanto, a auditoria ponta a ponta encontrou lacunas que os testes atuais não detectam. Algumas delas impedem que o fluxo financeiro conversacional V2 funcione corretamente em situações reais.

A presente SPEC não substitui a arquitetura V2. Ela fecha as lacunas entre as camadas.

A arquitetura desejada passa a ser:

```text
Usuário
   │
   ▼
PWA / TED
   │
   ▼
Intent
   │
   ▼
Parse de intenção financeira
   │
   ▼
Resolução autoritativa de entidades
   │
   ▼
Validação do contrato canônico
   │
   ▼
Pending Operation
   │
   ▼
Apresentação estruturada ao usuário
   │
   ▼
Confirmação / Cancelamento
   │
   ▼
Claim persistente da execução
   │
   ▼
Executor idempotente
   │
   ▼
Resultado persistido
   │
   ▼
Mutation Receipt
   │
   ▼
Reconciliação PWA
   │
   ▼
Estado visual atualizado
```

Nenhuma dessas etapas pode ser substituída por texto do modelo.

## 2. Resultado da reauditoria

### 2.1 Achados confirmados

| ID | Severidade | Achado | Estado |
| --- | --- | --- | --- |
| H-01 | **P0** | Propostas do TED não possuem todos os argumentos exigidos pelo executor | Confirmado |
| H-02 | **P0** | Confirmação/cancelamento por linguagem natural não percorre corretamente o pipeline autoritativo | Confirmado |
| H-03 | **P1** | Resposta perdida no `confirm` pode deixar operação confirmada sem attestation recuperável | Confirmado |
| H-04 | **P1** | Rollback do `execute` pode ressuscitar attestation consumida | Confirmado |
| H-05 | **P1** | Correção de H-04 precisa tratar crash com operação presa em `executing` | Confirmado por análise de consequência |
| H-06 | **P1** | READ financeiro ainda possui `legacy pass-through` sem evidência | Confirmado |
| H-07 | **P1** | PWA pode permanecer com resumo/saldos desatualizados após mutação bem-sucedida | Confirmado |
| H-08 | **P1** | Microfone pode permanecer ativo ao fechar/trocar contexto | Confirmado |
| H-09 | **P1** | UI oferece anexos que não são realmente transportados ao Agent | Confirmado |
| H-10 | **P1** | Card de aprovação não apresenta informação financeira suficiente | Confirmado |
| H-11 | **P2** | Autenticação ainda depende funcionalmente de bearer em `localStorage` | Confirmado |
| H-12 | **P2** | Overlays não possuem gerenciamento completo de foco | Confirmado |
| H-13 | **P2** | Chat perde qualidade/resiliência em falhas transitórias | Confirmado |
| H-14 | **P2** | Operações pendentes praticamente não são visíveis fora da conversa | Confirmado |
| H-15 | **P3** | `AppStateProvider` e alguns componentes estão grandes demais | Confirmado, mas não bloqueante |
| H-16 | Release | `main` não está protegida e CI remoto não está verde | Confirmado |

## 3. Achado novo crítico — contrato de mutação quebrado

A segunda auditoria encontrou um problema mais grave que a primeira não havia elevado adequadamente.

O parser financeiro atual produz:

```ts
{
  kind,
  amountCents,
  description,
  date,
  categoryQuery?
}
```

Ele não resolve `accountId`.

O `ConversationOrchestrator` transforma isso em uma proposta contendo basicamente:

```ts
{
  amountCents,
  description,
  date,
  categoryId? | categoryQuery?
}
```

Entretanto, o executor da API utiliza os schemas reais:

```ts
createExpenseInputSchema
createIncomeInputSchema
```

e ambos exigem:

```text
description
amountCents
date
accountId UUID
categoryId UUID
```

O executor valida novamente esses schemas antes de escrever.

Além disso, `createMutationProposal()` já rejeita uma despesa sem `categoryId`.

Logo, o fluxo:

```text
"Gastei R$ 50 no mercado"
```

pode identificar corretamente:

```text
R$ 50
mercado
hoje
expense
```

mas não possui necessariamente:

```text
accountId
categoryId
```

e, portanto, não deve sequer virar uma operação confirmável.

### Decisão

**É proibido criar uma pending operation executável enquanto seus argumentos não forem integralmente resolvidos e validados pelo contrato canônico da ferramenta.**

## 4. Objetivos

Esta SPEC deve garantir que:

1. toda mutação financeira aprovada possa realmente ser executada;
2. o usuário confirme exatamente a operação que será executada;
3. confirmação por botão e por linguagem natural usem a mesma máquina de estados;
4. nenhuma attestation possa ser reutilizada;
5. falhas de rede não deixem operações irrecuperáveis;
6. crashes não deixem operações eternamente em `executing`;
7. nenhuma informação financeira pessoal seja inventada quando a evidência falhar;
8. PWA reflita rapidamente o estado financeiro autoritativo após mutações;
9. recursos visíveis na interface correspondam a capacidades reais;
10. a experiência de confirmação financeira seja suficientemente explícita;
11. os testes exercitem o fluxo real entre PWA → Agent → API → PostgreSQL;
12. o deploy somente seja liberado quando CI e governança estiverem novamente verdes.

## 5. Não objetivos

Esta SPEC **não autoriza**:

- reescrever o Meu TED;
- substituir Next.js;
- trocar PostgreSQL;
- trocar Cloudflare;
- substituir o `ConversationOrchestrator`;
- criar microserviços adicionais sem necessidade comprovada;
- dividir todo o `AppStateProvider` de uma vez;
- redesenhar todas as telas;
- aumentar arbitrariamente a abstração;
- reativar `[EXEC_ACTION]`;
- permitir execução financeira por tool calling direto do LLM;
- remover idempotência ou aprovação;
- mover autoridade financeira para o Agent ou PWA;
- criar framework de transação distribuída, fila de mensagens, event sourcing ou saga engine genérica para o handoff draft → PendingOperation — essa fronteira é resolvida com idempotência, estado intermediário mínimo, retry e reconciliação (§7.8);
- transformar writes normais em PendingOperations apenas para obter receipt/reconciliação.

Também não será feita uma "otimização geral de performance".

O bundle inicial registrado está em aproximadamente **136,8 KB gzip**, abaixo do gate de 200 KB. Portanto não há evidência que justifique uma reescrita por performance neste momento.

## 6. Invariantes obrigatórios

### INV-01 — Autoridade

```text
PostgreSQL/API > Agent > PWA
```

PWA e LLM nunca são fonte da verdade financeira.

### INV-02 — Confirmação = execução

Os dados apresentados ao usuário devem ser semanticamente idênticos aos dados vinculados à pending operation executada.

Não é permitido:

```text
Confirmado:
Mercado / R$50 / Nubank

Executado:
Mercado / R$50 / Itaú
```

### INV-03 — Sem sucesso antecipado

"Registrado", "cancelado", "pago", "confirmado" ou equivalente somente pode ser exibido depois do estado autoritativo correspondente.

### INV-04 — Uma ação financeira, no máximo uma mutação

Retries, reconexões, timeouts e crashes não podem criar lançamentos duplicados.

### INV-05 — Attestation fora do browser

A PWA nunca recebe:

- attestation;
- hash de attestation;
- delegated token financeiro;
- capability write.

### INV-06 — Dados financeiros exigem evidência

Nenhum saldo, gasto, orçamento, fatura, conta ou transação pessoal pode ser afirmado apenas pelo modelo.

### INV-07 — Estado visual não pode fingir estar atualizado

Caso a reconciliação pós-mutação falhe, a UI deve marcar o dado como stale/degradado em vez de continuar apresentando-o como atual.

### INV-08 — UI não pode prometer capability inexistente

Um botão "Anexar imagem", "PDF" ou "Gravar áudio" só pode existir como função ativa quando esse conteúdo puder realmente chegar ao pipeline responsável por processá-lo.

### INV-09 — Handoff draft → PendingOperation recuperável

Cada draft completado produz **0 ou 1** PendingOperation — nunca 2. Retries, timeouts, respostas perdidas e restarts do Agent não alteram esse total. Nenhum draft pode permanecer em estado que impeça descobrir deterministicamente se a PendingOperation correspondente existe (§7.8).

### INV-10 — Cancelamento efetivo

O usuário nunca recebe confirmação de cancelamento enquanto uma operação financeira correspondente continue ativa sem controle autoritativo. "Cancelado" somente é respondido após: a operação ter sido cancelada na API (§8.5) ou verificado que nenhuma operação chegou a ser criada (§7.8).

## 7. H0 — Contrato canônico das mutações

**Prioridade: P0**

### 7.1 Pipeline obrigatório

Uma mensagem mutável deve passar por:

```text
parse
 ↓
resolve entities
 ↓
validate canonical args
 ↓
propose
```

e nunca:

```text
parse
 ↓
propose incompleto
 ↓
resolver depois
```

### 7.2 Resolução de conta

Para `transactions.expense.create` e `transactions.income.create`, deve existir um `accountId` autoritativo antes da proposta.

É permitido resolver automaticamente somente quando:

- o usuário indicar uma conta que tenha correspondência inequívoca; ou
- existir exatamente uma conta válida; ou
- existir política explícita de conta padrão definida no servidor.

Quando houver mais de uma opção razoável:

```text
TED:
Em qual conta devo registrar?

• Nubank
• Itaú
• Dinheiro
```

Nenhuma escolha silenciosa deve ser feita pelo LLM.

### 7.3 Resolução de categoria

A categoria pode ser sugerida semanticamente, porém a proposal deve conter um `categoryId` real.

Pipeline:

```text
"mercado"
   ↓
candidate: Alimentação
   ↓
lookup real
   ↓
categoryId UUID
   ↓
proposal
```

É proibido que a pending operation final permaneça com:

```ts
categoryQuery: "alimentação"
```

quando o executor exige `categoryId`.

Se não houver correspondência única, deve haver clarificação.

### 7.4 Validação antes da proposal

A API deve validar o payload específico da ferramenta no próprio endpoint de `propose`.

Hoje os testes de rota aceitam inclusive:

```ts
normalizedArgs: {}
```

e esperam criação bem-sucedida.

Isso deve deixar de ser possível.

Para:

```text
transactions.expense.create
```

a API deve validar contra o contrato de expense.

Para:

```text
transactions.income.create
```

contra o contrato de income.

Uma pending operation inválida nunca deve existir no banco.

### 7.5 Registro canônico de ferramentas (Approval Tool Contract)

Deve existir uma única fonte de contrato para cada ferramenta V2 do protocolo de aprovação, contendo no mínimo:

```ts
{
  tool,
  inputSchema,
  approvalRequired,
  executor
}
```

Inicialmente:

```text
transactions.expense.create
transactions.income.create
```

Nenhum novo tool mutável será habilitado no V2 sem entrar nesse registry.

**Separação de responsabilidades:** este contrato governa apenas o pipeline de aprovação/execução do TED (propose → confirm → execute). Os alvos de reconciliação (`affectedTargets`) **não** fazem parte dele — vivem no Mutation Effects Registry (§15.1), que é determinístico, compartilhado com os writes normais da PWA e nunca derivado do LLM. Writes que não passam pelo protocolo de pending operation não devem ser transformados artificialmente em approval tools para obterem reconciliação.

### 7.6 Missing fields reais

`TurnPlan.missingFields` não pode permanecer artificialmente vazio quando faltam:

```text
accountId
categoryId
amount
date
```

Ele deve refletir a realidade do plano.

### 7.7 Idempotência do turno

A PWA deve gerar um identificador estável para a mensagem/turno.

Retries do mesmo envio devem reutilizar esse ID.

O `intentionId` usado como base de idempotência de uma proposal não deve mudar só porque a resposta HTTP anterior foi perdida.

A chave de idempotência enviada ao `propose` é determinística por unidade de intenção: para proposal direta (sem draft) deriva do `intentionId`; para proposal originada de draft deriva do `draftId` e é a **mesma** em toda reemissão do propose daquele draft — retry HTTP, restart do Agent e reconciliação inclusos. Gerar chave nova em retry é proibido. A API deduplica por `(workspaceId, idempotencyKey)` com fingerprint do payload (`proposal_hash`): mesma chave + mesmo payload retorna a operação existente; mesma chave + payload divergente é erro definitivo (`idempotency.conflict`).

### 7.7.1 Inventário de identificadores

| Identificador | Gerado por | Escopo | Reutilizado quando | NÃO reutilizado quando |
| --- | --- | --- | --- | --- |
| `messageId` | PWA | mensagem/turno do chat | retry do mesmo envio; reload da página | nova mensagem do usuário |
| `intentionId` | Agent | intenção mutável do turno | retry do mesmo turno (base da chave de propose sem draft) | nova intenção |
| `draftId` | Agent | MutationDraft no Durable Object | todas as continuações e reemissões do mesmo draft | novo draft (após `replaced`/`expired`) |
| `proposalIdempotencyKey` | Agent, derivada do `draftId` (com draft) ou do `intentionId` (sem draft) | dedup do propose na API `(workspaceId, key)` + fingerprint | toda reemissão do mesmo propose (timeout, resposta perdida, restart, reconciliação) | propose de outro draft ou outro turno |
| `PendingOperation.id` | API | operação autoritativa | apenas referenciado (nunca regenerado) | — |
| chave de idempotência de execução | derivada da chave de propose no propose; persistida na operação | WriteStore do executor | retry/reconcile da **mesma** operação (§11.3) | outra operação |
| `mutationId` (receipt, §15.1) | API no sucesso | mutação bem-sucedida (TED ou write normal) | correlação/dedup de reconciliação no consumidor | outra mutação |
| attestation | API, opaca | confirm → execute | nunca (rotação invalida a anterior, §9) | — |

Dois identificadores só coexistem quando resolvem problemas de escopos distintos: `messageId`/`intentionId` governam o turno; a `proposalIdempotencyKey` do draft sobrevive ao turno porque o draft é multi-turno. Nenhum identificador novo é criado onde um existente basta.

### 7.8 MutationDraft — persistência da intenção durante clarificações

Extensão do achado H-01: sem um estado intermediário, o fluxo de clarificação do §7.2/§7.3 exigiria que a resposta curta do usuário (ex.: `"Nubank"`) fosse completada por inferência livre do LLM ou por releitura insegura do histórico da conversa. Nenhum dos dois é aceitável.

A intenção estruturada incompleta deve sobreviver entre turnos em um estado intermediário:

```ts
MutationDraft {
  draftId;
  workspaceId;
  actorId;
  deviceId;
  conversationId?;

  tool;
  resolvedArgs;      // apenas argumentos já resolvidos
  missingFields;     // reflete §7.6

  proposalIdempotencyKey; // estável, derivada do draftId (§7.7.1)
  proposalId?;            // id da PendingOperation, persistido quando conhecido
  proposeOutcome?;        // created | existing | rejected | unknown

  createdAt;
  updatedAt;
  expiresAt;         // TTL obrigatório
}
```

A estrutura final pode variar conforme os contratos reais existentes; os invariantes não.

#### Invariantes do MutationDraft

- NÃO é uma PendingOperation;
- NÃO representa autorização financeira;
- NÃO pode ser executado;
- NÃO pode gerar attestation;
- NÃO pode contornar a validação canônica (§7.4);
- NÃO é fonte financeira autoritativa (INV-01 permanece `PostgreSQL/API > Agent > PWA`);
- serve somente para preservar a intenção estruturada durante clarificações;
- deve ser vinculado a `workspace + actor + device`;
- deve possuir TTL (ordem de minutos, valor em configuração);
- deve ser descartado após: proposal criada; cancelamento; expiração; ou substituição explícita por nova intenção incompatível.

#### Ciclo de vida

```text
active
  ├── proposing  → CAS de consumo vencido; propose em andamento (§7.8 Handoff)
  ├── discarded  → cancelamento ou interrupção explícita
  ├── expired    → TTL vencido
  └── replaced   → nova intenção incompatível

proposing
  ├── consumed   → PendingOperation criada ou confirmada como existente (proposalId persistido)
  └── discarded  → rejeição definitiva do propose (nenhuma PendingOperation criada)
```

#### Fluxo obrigatório

```text
mensagem inicial
→ parse
→ resolve o que for possível
→ faltam campos
→ MutationDraft criado (idempotente por turno — §7.7)
→ clarification

resposta do usuário
→ carregar draft correspondente (workspace + actor + device + conversa)
→ resolver somente o campo faltante
→ revalidar todos os args
→ se ainda incompleto: atualizar draft
→ se completo: validar canonicamente (§7.4) → CAS `active → proposing` → propose idempotente (§7.7.1) → `consumed` + `proposalId` (protocolo recuperável abaixo)
```

#### Ambiguidade

Se existirem dois drafts compatíveis com uma resposta como `"Nubank"`, não escolher silenciosamente: solicitar desambiguação e não propor nada.

#### Substituição segura

Uma nova mensagem claramente independente (ex.: `"esquece isso, recebi 500 reais de João"`) nunca completa o draft anterior: trata-se de nova intenção; o draft antigo é descartado (`replaced`) e nenhum campo financeiro (`amountCents`, `description`, `kind`, `date`, categoria) é herdado. Cenários de interrupção, cancelamento e substituição têm testes obrigatórios (§25.3).

#### Consumo atômico

O consumo do draft (`active → proposing`) deve ser atômico no storage do Durable Object (compare-and-set), porque duas continuações distintas podem chegar para o mesmo draft:

- exatamente uma continuação vence o CAS e segue para o propose; as demais recebem erro determinístico (ex.: `draft.already_consumed`) e nenhuma pending operation é criada por elas;
- corrida cancelamento × continuação: o primeiro evento vence — se o cancelamento vence, o draft vira `discarded`; se a continuação vence, um cancelamento posterior atua sobre a PendingOperation criada (caminho §8), nunca sobre o draft;
- reenvio do mesmo turno após consumo: a idempotência de §7.7 retorna a proposal existente; nunca cria segunda pending operation.

O CAS garante um único proponente; ele **não** torna draft + propose uma transação única — a fronteira entre Durable Object e PostgreSQL é fechada pelo protocolo recuperável abaixo, não por atomicidade distribuída.

#### Handoff draft → PendingOperation (protocolo recuperável)

`MutationDraft` vive no Durable Object; `PendingOperation` é criada pela API e persistida no PostgreSQL. CAS no DO somado ao `POST /propose` **não** constitui uma única transação — não existe atomicidade entre DO, API e PostgreSQL. O handoff é um protocolo explícito, recuperável e idempotente (INV-09):

```text
active
   ↓ CAS (uma única continuação vence)
proposing
   ↓ propose com a proposalIdempotencyKey estável (derivada do draftId, §7.7.1)
   ├─ criada / existente (mesma chave + mesmo payload)
   │      ↓
   │   consumed + proposalId persistido
   │
   ├─ timeout / 5xx / falha de transporte / desfecho desconhecido
   │      ↓
   │   permanece proposing
   │      ↓
   │   retry com a MESMA proposalIdempotencyKey (tentativas limitadas, com backoff)
   │
   └─ rejeição definitiva (ex.: 4xx de validação/negócio; nenhuma operação criada)
          ↓
       discarded (propose_rejected) — nunca consumed silenciosamente; usuário informado
```

Propriedades obrigatórias:

- a chave de propose é a mesma em toda reemissão — retry HTTP, restart do Agent e reconciliação inclusos; a API responde à mesma chave com mesmo payload retornando a operação existente, e a mesma chave com payload divergente é erro definitivo — logo a recuperação é determinística;
- `consumed` só é atingido quando o Agent sabe (ou passou a poder descobrir deterministicamente) que a PendingOperation existe, e o `proposalId` é persistido no draft;
- restart com draft em `proposing` — morreu **antes** de chamar a API ou **depois** de a API persistir a proposal sem o Agent ter recebido a resposta — é recuperado reemitindo o propose com a mesma chave; o resultado final é sempre 0 ou 1 PendingOperation;
- cancelamento durante `proposing` (§8.5) resolve o desfecho pela mesma chave antes de responder ao usuário (INV-10);
- enquanto o desfecho permanece desconhecido, a resposta ao usuário é inconclusiva — nunca sucesso, nunca cancelamento (INV-03, INV-10);
- o draft continua sem autoridade financeira: a PendingOperation criada é o único estado autoritativo (INV-01).

#### Armazenamento

O draft vive no lado do Agent (storage do Durable Object da conversa), nunca na PWA como autoridade e nunca na API como estado financeiro. Perda de um draft `active` apenas degrada a UX (os dados são pedidos novamente); um draft `proposing` é recuperado no restart pela reemissão do propose com a mesma `proposalIdempotencyKey` (protocolo acima) — nunca produz risco financeiro nem PendingOperation duplicada. O draft nunca contém nem gera attestation.

## 8. H0 — Unificar confirmação e cancelamento

**Prioridade: P0**

Atualmente o botão do `TedApprovalCard` possui um RPC específico e seguro.

Entretanto, o `/rpc/chat` cria `MutationApiClient` apenas para novas propostas. Uma mensagem posterior de confirmação não recebe automaticamente o mesmo contexto de decisão.

O `ConversationOrchestrator` somente executa a branch de confirmação quando há `client`, e a branch de cancelamento atual responde "cancelado" sem persistir a decisão.

### 8.1 Uma única máquina de decisão

Criar uma autoridade de Agent para pending operations, conceitualmente:

```text
PendingOperationCoordinator
```

responsável por:

```text
propose
listActive
resolveDecisionTarget
confirm
cancel
retry
execute/reconcile
```

Não criar caminhos paralelos.

### 8.2 Botão e linguagem natural

Devem convergir:

```text
[Aprovar]
     │
     ├──────────────┐
                    ▼
              Decision Service
                    ▲
     ┌──────────────┘
     │
"sim, confirma"
```

O mesmo para:

```text
[Cancelar]
"não, cancela"
```

E para retry: "tenta de novo" / "refaz" sobre uma operação `failed` passa pelo mesmo Decision Service — nova attestation e no máximo uma nova execução (§9, §13).

### 8.3 Resolução autoritativa da operação pendente

Adicionar consulta Agent-only:

```http
GET /pending-operations/v2/active
```

ou equivalente.

A API deve resolver operações por:

```text
workspace
actor
device
status
```

a partir da identidade autenticada.

A PWA não deve informar ao Agent quais operações ela "acha" que estão pendentes como fonte de autoridade.

### 8.4 Regras de decisão

Zero operações:

```text
Não há nenhuma operação pendente para confirmar.
```

Uma operação: pode confirmar/cancelar.

Duas ou mais: não executar nenhuma. Responder com desambiguação.

Exemplo:

```text
Tenho duas operações aguardando confirmação:

1. Despesa de R$ 50,00 no Nubank
2. Receita de R$ 2.000,00 no Itaú

Qual delas deseja confirmar?
```

### 8.5 Cancelamento

A frase:

```text
"cancela"
```

só pode retornar sucesso depois de:

```text
API → execution_status = cancelled
```

O comportamento atual de apenas renderizar `cancelled` deve ser eliminado.

O cancelamento também descarta qualquer `MutationDraft` ativo do mesmo contexto (§7.8): não pode sobrar intenção estruturada capaz de virar proposal após um cancelamento explícito.

Se o cancelamento chegar enquanto o handoff draft → PendingOperation está em `proposing` (§7.8), a resposta "cancelado" somente é dada após resolver o desfecho do propose pela mesma `proposalIdempotencyKey`: se a PendingOperation existe, ela é cancelada autoritativamente pelo caminho acima; se o desfecho definitivo é "nenhuma operação criada", o draft é descartado; enquanto o desfecho permanece desconhecido, a resposta é inconclusiva — nunca "cancelado" com uma operação correspondente possivelmente ativa (INV-10).

## 9. H1 — Attestation recuperável

**Prioridade: P1**

Hoje o primeiro `confirm()` gera a attestation e persiste somente seu hash.

O Agent só aceita a resposta de `confirm`/`retry`/`cancel` quando o `id`
retornado pela API corresponde exatamente à PendingOperation solicitada. Um
ID ausente ou divergente é bloqueado antes de usar a attestation e antes de
chamar `/execute`; nenhuma execução pode ser redirecionada para outra
PendingOperation.

Se a transação confirmar no PostgreSQL mas a resposta HTTP desaparecer:

```text
DB = confirmed
browser/Agent = não recebeu token
```

Um segundo `confirm()` retorna o record confirmado sem gerar outra attestation.

### Regra nova

Se:

```text
status = confirmed
AND attestation_consumed_at IS NULL
```

um novo `confirm` deve:

1. gerar nova attestation;
2. substituir o hash antigo;
3. invalidar imediatamente a attestation anterior;
4. retornar apenas a nova;
5. manter exatamente uma attestation válida.

Não armazenar plaintext.

### Não reemitir quando

```text
executing
succeeded
failed
cancelled
expired
```

A reemissão é o **único** mecanismo de recuperação do estado `confirmed`. Execution lease (§11) não participa desse estado: as colunas de lease só são escritas no claim (TX1, §10), de modo que uma operação `confirmed` nunca possui lease a expirar nem reconciler de lease aplicável. Os cenários restart **após confirm antes do claim** (recuperação por §9) e restart **após claim** (recuperação por §11) são janelas de crash distintas, com mecanismos distintos e testes separados (§25.4).

## 10. H1 — Claim de execução fora da transação do executor

**Prioridade: P1**

Hoje o claim da attestation, o executor e a finalização ocorrem dentro do mesmo `withTransaction`.

`withTransaction()` executa `ROLLBACK` quando o callback lança erro.

Logo, uma falha depois do consumo da attestation pode desfazer:

```text
attestation_consumed_at
execution_status = executing
execution_status = failed
```

e restaurar uma operação confirmada como se o token nunca tivesse sido usado.

### Novo protocolo

TX1 — claim:

```text
BEGIN
SELECT ... FOR UPDATE
validar identidade
validar status
validar TTL
validar attestation
consumir attestation
status = executing
execution_claimed_at = now
execution_lease_expires_at = now + lease
execution_attempt_count += 1
COMMIT
```

Fora de transação:

```text
executor(persisted operation)
```

O executor continua usando a `idempotencyKey` persistida.

TX2 — sucesso (contrato fechado API+Agent+PWA):

```text
BEGIN
lock operation
status = succeeded  // somente com receipt válido
execution_result = { status, operationId: <tx id>, receipt }
receipt.operationId = <pending operation id>
receipt.entity = { type: 'transaction', id: <tx id> }
mutation_id = receipt.mutationId
COMMIT
```

`succeeded` sem receipt é resultado inválido/incerto (nunca sucesso parcial):
o Agent rejeita com `approval.incomplete_result` e a API mantém `executing`
para reconciliação.

TX2 — falha determinística pré-write:

```text
BEGIN
lock operation
status = failed
failed_at = now
failure_code = código sanitizado
COMMIT
```

Somente depois o erro pode ser retornado ao caller. Retry explícito é
permitido apenas a partir de `failed`, pela mesma operação (`failed →
confirmed`, nova attestation, §13).

Resultado incerto (pós-write): throw do writer após o início da escrita,
resultado de sucesso ausente/inválido, falha de normalização do receipt ou
falha de construção do receipt — incluindo `approval.incomplete_result` —
NÃO persiste `failed`, NÃO emite evento `fail` e NÃO expõe retry/nova
aprovação. A operação permanece `executing`
(`approval.execution_uncertain`, 409) até a reconciliação da lease expirada
com a mesma `idempotencyKey` (§11.3).

## 11. H1 — Recuperação de `executing` abandonado

Separar a execução da transação resolve o replay, mas cria um possível crash window:

```text
TX1 COMMIT
status = executing
      ↓
processo morre
      ↓
TX2 nunca acontece
```

Portanto a implementação **não estará completa** apenas separando as transações.

### 11.1 Lease

Adicionar:

```text
execution_claimed_at
execution_lease_expires_at
execution_attempt_count
```

A lease existe somente a partir do claim (TX1). O estado `confirmed` **não** possui lease — sua recuperação é a reemissão de attestation (§9), não reconciliação de lease. Testes tratam `confirmed` e `executing` como janelas de crash distintas (§25.4).

### 11.2 Durante lease válida

Uma nova tentativa deve retornar:

```text
approval.execution_in_progress
```

e nunca duplicar a execução.

### 11.3 Lease expirada

Uma operação ainda em `executing` poderá ser reconciliada por caminho Agent/API controlado.

O reconciliador:

1. trava a operação;
2. confirma que a lease expirou;
3. renova a lease;
4. incrementa attempt;
5. reaplica o **mesmo executor com a mesma idempotencyKey**;
6. persiste succeeded/failed.

Isso é recuperação da execução original, não uma nova aprovação do usuário.

### 11.4 Estados terminais

```text
succeeded
cancelled
expired
```

nunca voltam para execução.

## 12. Migração V052

Criar migration dedicada, sugerida como:

```text
V052__pending_operation_execution_recovery.sql
```

Adicionar conforme necessário:

```text
attestation_issued_at
execution_claimed_at
execution_lease_expires_at
execution_attempt_count DEFAULT 0
failure_code
mutation_id
```

`mutation_id` persiste a identidade do MutationReceipt no caminho TED (§15.1), gerada no TX2 de sucesso.

Criar índice para recuperação de operações:

```text
execution_status = 'executing'
AND execution_lease_expires_at < now()
```

Não persistir:

- plaintext attestation;
- stack trace;
- prompt;
- conteúdo financeiro desnecessário em `failure_code`.

## 13. Máquina de estados V2

Estados permitidos:

```text
proposed
   ├── confirmed
   ├── cancelled
   └── expired

confirmed
   ├── executing
   ├── cancelled
   └── expired

executing
   ├── succeeded
   └── failed

failed
    └── confirmed  ← retry explícito, nova attestation (somente falha determinística pré-write)

succeeded  [terminal]  ← somente com receipt válido (§10)
cancelled  [terminal]
expired    [terminal]
```

Resultado incerto não é transição: `executing` permanece `executing`
(`approval.execution_uncertain`), sem persistir `failed`, sem evento `fail`
e sem retry/nova aprovação até a reconciliação da lease expirada com a mesma
`idempotencyKey` (§11.3).

É proibido:

```text
executing → confirmed
succeeded → executing
cancelled → confirmed
expired → confirmed
```

## 14. H1 — Grounding financeiro fail-closed

**Prioridade: P1**

O provider de evidência está corretamente ligado a tools READ autoritativas para:

- contas;
- transações;
- resumo mensal;
- faturas;
- contas a pagar;
- orçamentos;
- metas;
- categorias.

Entretanto, o orchestrator ainda possui:

```text
No evidence → legacy pass-through → responseProvider
```

para determinados casos.

### Regra

Qualquer solicitação que possa gerar afirmação sobre o estado financeiro específico do usuário deve exigir evidência.

Exemplos:

```text
"quanto tenho?"
"quanto gastei?"
"qual minha fatura?"
"como está meu orçamento?"
"quais contas estão vencidas?"
```

Se:

```text
evidence = null
```

ou:

```text
todos os EvidenceItems = error
```

responder de forma determinística:

```text
Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.
```

Não enviar a pergunta ao LLM para ele "tentar responder".

### Empty ≠ Error

Um READ autoritativo que retorna:

```text
status = empty
```

pode sustentar:

```text
"não há transações nesse período"
```

Um READ com:

```text
status = error
```

não pode.

## 15. H1 — Reconciliação financeira da PWA

**Prioridade: P1**

A Home utiliza o `dashboardSummary` do servidor para saldo, receitas, despesas e resultado.

Entretanto vários mutators atualizam apenas seus arrays locais e não invalidam automaticamente o resumo financeiro correspondente.

O mesmo ocorre depois de uma aprovação pelo TED: o callback atual recarrega principalmente o histórico da conversa.

### 15.1 Mutation Receipt

Toda mutação bem-sucedida deve gerar um receipt seguro. O receipt cobre **duas origens**: mutações do protocolo TED (PendingOperation → executor) e writes normais da PWA/API — que não possuem PendingOperation. Por isso a identidade do receipt é o `mutationId`, e `operationId` existe apenas quando a origem é uma PendingOperation:

```ts
type MutationReceipt = {
  mutationId: string;          // identidade universal da mutação; gerado pela API no sucesso
  mutationKind: MutationKind;  // chave do Mutation Effects Registry (§15.1.1)
  status: "succeeded";
  affectedTargets: RefreshTarget[];
  operationId?: string;        // presente SOMENTE quando a origem é uma PendingOperation (TED)
  entity?: {
    type: string;
    id: string;
  };
};
```

Regras de identidade:

- `mutationId` é gerado pela API (nunca pelo LLM, nunca pela PWA) uma única vez por mutação bem-sucedida; no caminho TED é gerado no TX2 de sucesso e persistido (`mutation_id`, §12); em writes normais é emitido na resposta de sucesso;
- `mutationId` serve a correlação de logs, deduplicação de reconciliação no consumidor, debug, reconciliação e testes; ele **não** substitui os mecanismos existentes de idempotência de escrita (`Idempotency-Key` + fingerprint, attestation de uso único) — não é um novo mecanismo de proteção de duplicidade financeira;
- `operationId` é o id da PendingOperation de origem; receipt de write normal é válido **sem** `operationId` — writes normais não são transformados em PendingOperations para obter o campo;
- `mutationKind` no caminho TED corresponde ao tool do Approval Tool Contract (§7.5); em writes normais corresponde ao kind registrado no mesmo registry (§15.6).

Exemplo (write normal de transação, sem PendingOperation):

```json
{
  "mutationId": "...",
  "mutationKind": "transaction.create",
  "status": "succeeded",
  "affectedTargets": [
    "transactions",
    "accounts",
    "dashboard-summary",
    "budgets",
    "quick-insights"
  ]
}
```

`affectedTargets` deve vir de um registry determinístico da operação, não do LLM. O mesmo `MutationReconciler` (§15.2) consome receipts das duas origens sem conhecer detalhes do protocolo de aprovação.

### 15.1.1 Mutation Effects Registry (separado do Approval Tool Contract)

Os efeitos de reconciliação vivem em um registro próprio e determinístico:

```ts
{
  mutationKind,
  affectedTargets
}
```

Exemplos:

```text
transaction.create → transactions, accounts, dashboard-summary, budgets, quick-insights
payable.update     → payables, dashboard-summary, quick-insights
```

Requisitos:

- determinístico e compartilhável: a mesma tabela serve ao caminho TED (approval contract → executor → mutation effects → receipt) e ao caminho de writes normais da PWA (API mutation → mutation effects → receipt);
- ambos os caminhos chegam ao mesmo `MutationReconciler` (§15.2);
- nunca derivado do LLM e nunca espalhado em `if/else` por componentes;
- writes normais não são transformados em approval tools para obter reconciliação;
- toda mutação suportada deve possuir efeitos registrados; nenhuma mutação nova pode retornar sucesso sem uma política de reconciliação definida, salvo exceção explicitamente classificada como `no-refresh`;
- cobre os writes listados em §15.6 e as mutações do protocolo V2 (§7.5).

### 15.2 Mutation Reconciler

Criar na PWA uma única camada conceitual:

```text
MutationReconciler
```

Ela recebe o receipt e refaz somente as consultas necessárias.

Não espalhar:

```ts
refreshTransactions();
refreshAccounts();
refreshSomethingElse();
```

por dezenas de componentes.

### 15.3 Após lançamento comum

```text
optimistic UI
   ↓
API succeeds
   ↓
reconciliation
   ↓
server state replaces/validates optimistic state
```

### 15.4 Após aprovação pelo TED

```text
Aprovar
 ↓
Agent
 ↓
API
 ↓
succeeded
 ↓
MutationReceipt
 ↓
PWA reconciliation
 ↓
chat history + financial UI refresh
```

### 15.5 Falha na reconciliação

Se a mutação foi confirmada mas o refresh falhou:

```text
NÃO fazer rollback da mutação já persistida.
```

Em vez disso:

```text
status visual = stale
banner = "Lançamento registrado, mas não foi possível atualizar todos os dados."
```

e disponibilizar retry de refresh.

### 15.6 Abrangência

A política deve incluir não apenas TED, mas writes normais:

- transaction create/update/delete;
- transfer;
- payable;
- statement;
- budget;
- goal;
- account;
- category;
- subscription;
- undo.

## 16. H1 — Card de aprovação financeira

**Prioridade: P1**

O card atual possui basicamente:

```text
Ação: <summary>
Aprovar
Rejeitar
```

e o tipo transportado contém apenas:

```ts
id
status
operation
summary?
```

Os testes atuais verificam corretamente que attestation não chega ao browser, mas não verificam que o usuário recebeu os dados financeiros que está aprovando.

### Novo contrato visual

Criar uma projeção segura:

```ts
PendingOperationPresentation = {
  id;
  status;
  tool;
  title;
  amountCents?;
  description?;
  date?;
  account?: {
    id;
    label;
  };
  category?: {
    id;
    label;
  };
  expiresAt;
  warnings[];
};
```

Nenhum desses valores pode ser inventado pela PWA.

### Exemplo

```text
Confirmar despesa

Mercado

Valor       R$ 850,00
Conta       Nubank
Categoria   Alimentação
Data        14/09/2026

O valor será registrado no seu histórico financeiro.

[ Confirmar R$ 850,00 ]
[ Cancelar ]
```

### Regra crítica

O card deve ser derivado dos mesmos argumentos canônicos/hash-bound que serão executados.

Não usar `summary` livre do LLM como única representação da operação.

### Contrato de estados visíveis

Todo estado do fluxo financeiro possui apresentação obrigatória, derivada do estado autoritativo (nunca do LLM), em pt-BR:

| Estado autoritativo | Apresentação obrigatória |
| --- | --- |
| clarificação (draft ativo, §7.8) | pergunta objetiva do campo faltante — "aguardando informação" |
| proposing (handoff §7.8) | estado interno transitório do Agent; visual = envio em processamento (§19.1); nunca sucesso, nunca cancelamento (INV-03, INV-10) |
| proposed | card §16 com dados + Confirmar/Cancelar — "aguardando aprovação" |
| executing | "processando operação…" — nunca sucesso antecipado (INV-03); em resultado incerto o card trava (sem Confirmar/Cancelar/retry), não chama `onResolved` nem declara sucesso, e orienta atualizar/rechecar antes de nova decisão |
| succeeded | "concluída" + reconciliação (§15) — somente com receipt válido (§10) |
| failed | "falhou" + ação de retry pelo mesmo Decision Service (§8) |
| cancelled / expired | estado explícito, sem sucesso antecipado |
| stale (refresh falho) | banner degradado + retry de refresh (§15.5) |

Essa tabela é verificável por teste (§25.6) e vale dentro do TED mesmo que o indicador externo (§22) permaneça deferido.

## 17. H1 — Ciclo de vida do microfone

**Prioridade: P1**

Atualmente `recording=true` é definido antes da autorização do navegador, e uma falha de permissão mantém o estado visual de gravação. O fechamento do chat limpa o boolean, mas não garante o encerramento do `MediaRecorder` e das tracks.

### 17.1 Estado

Substituir:

```ts
recording: boolean
```

por:

```ts
type RecordingState =
  | "idle"
  | "requesting"
  | "recording"
  | "processing"
  | "error";
```

### 17.2 Somente considerar recording quando

```text
getUserMedia success
+
MediaRecorder created
+
recorder.start success
```

### 17.3 Cleanup único

Criar uma função central, conceitualmente:

```text
cleanupMedia()
```

que:

- pare MediaRecorder ativo;
- pare todas MediaStreamTracks;
- limpe refs;
- revogue URLs locais quando necessário;
- seja idempotente.

Executar em:

- botão Parar;
- fechar TED;
- unmount;
- mudança de workspace;
- nova sessão;
- expiração/logout.

### 17.4 Permissão negada

Deve resultar em:

```text
recordingState = error/idle
```

e jamais:

```text
🔴 gravando…
```

## 18. H1 — Anexos: capability real ou interface oculta

**Prioridade: P1 de verdade de produto**

A PWA cria anexos com:

```text
URL.createObjectURL(file)
```

e envia metadata para o Agent. O próprio fluxo atual reconhece que utiliza informações textuais do anexo quando multipart não existe.

Uma `blob:` URL existe apenas naquele browser.

Logo:

```text
Preview funciona ≠ Agent recebeu arquivo
```

Os testes atuais validam preview e botões, mas não demonstram que os bytes chegam ao Agent.

### 18.1 Requisito imediato

Enquanto não houver ingestão real:

```text
imagem = desabilitada/oculta
PDF    = desabilitado/oculto
áudio  = desabilitado/oculto
```

A disponibilidade deve ser controlada por capability/configuração real.

### 18.2 Evolução multimodal

Quando implementada:

```text
Browser
 ↓
upload autenticado
 ↓
validação MIME/tamanho
 ↓
storage privado
 ↓
attachmentId opaco
 ↓
Agent
 ↓
imagem → vision
PDF → extraction
áudio → transcription
```

Nunca transmitir ao backend uma `blob:` URL esperando que ele a leia.

### 18.3 Segurança

Cada attachment deve ser vinculado a:

```text
workspace
actor
owner/uploader
TTL
MIME
size
```

e não ser público por padrão.

### 18.4 Cleanup

`URL.revokeObjectURL` deve ocorrer em:

- remoção;
- sucesso do envio;
- cancelamento;
- close;
- workspace switch;
- new session;
- unmount.

## 19. H2 — Resiliência do TED Chat

**Prioridade: P2**

### 19.1 Optimistic message para texto

Hoje o comportamento otimista é mais completo para mensagens com anexo.

Toda mensagem deverá aparecer imediatamente:

```text
sending
 ↓
sent
```

ou:

```text
sending
 ↓
failed
 ↓
[Tentar novamente]
```

### 19.2 Falha de refresh não apaga histórico

Se já existe histórico e `fetchAgentHistory()` falhar:

```text
manter mensagens existentes
+
mostrar aviso de atualização
```

Somente mostrar empty/error state quando não existir histórico carregado.

### 19.3 Draft e anexos

Falha de envio deve permitir retry sem exigir que o usuário monte a mensagem novamente.

### 19.4 Status em pt-BR

```text
connecting → conectando…
ready      → online
streaming  → escrevendo…
error      → indisponível
```

### 19.5 Mobile

Instruções:

```text
Enter / Shift+Enter
```

não precisam ocupar espaço em ambientes touch sem teclado físico.

## 20. H2 — Migração final para autenticação cookie-first

**Prioridade: P2**

A arquitetura de transporte same-origin está correta, porém o frontend ainda condiciona partes do fluxo a um token JavaScript.

A migração não deve consistir simplesmente em apagar `localStorage`.

### 20.1 Estado de sessão único

Definir:

```ts
type SessionState =
  | "unknown"
  | "authenticated"
  | "offline-authenticated"
  | "unauthenticated"
  | "expired";
```

### 20.2 API usável

Deixar de definir:

```text
API disponível = existe bearer no localStorage
```

e passar para:

```text
API disponível = sessão autenticada válida
```

### 20.3 Cookie

Para requests browser comuns:

```text
credentials: include
```

e BFF same-origin devem ser a autoridade.

### 20.4 Device binding

A migração não pode quebrar o device binding do Agent.

O inventário de:

- device token;
- connection token;
- snapshot namespace;
- logout;
- reconnect;

deve ser concluído antes da retirada do bearer legado.

### 20.5 Snapshots

Se snapshots locais atualmente utilizarem token como namespace/chave, criar primeiro um identificador local não secreto apropriado.

### 20.6 DoD da migração

Provar via E2E:

```text
login
→ cookie
→ bootstrap
→ write
→ refresh
→ Agent
→ logout
```

com nenhum bearer financeiro de longa duração armazenado em `localStorage`.

## 21. H2 — Acessibilidade dos overlays

**Prioridade: P2**

Preservar o body scroll lock reference-counted existente.

Adicionar primitive compartilhada para:

```text
initial focus
focus trap
focus restore
Escape
aria-labelledby
stacking
background inert
reduced motion
```

Aplicar a:

- BottomSheet;
- dialogs;
- ConfirmActionDialog;
- TED Chat.

> **Emenda 2026-10-01:** o chat do TED deixou de ser dialog/overlay e passou
> a ser a página dedicada `/ted` (`role="region"`, sem `aria-modal`, sem
> scroll lock, sem focus trap/Escape/restore). O owner de overlay (§21) não
> se aplica mais ao TED; BottomSheet, dialogs e ConfirmActionDialog seguem
> cobertos.

O BottomSheet atual já possui `role="dialog"`, `aria-modal`, Escape e scroll lock, mas não implementa todo o gerenciamento de foco.

Não introduzir uma biblioteca UI inteira apenas para essa correção sem necessidade demonstrada.

## 22. H2 — Visibilidade das operações pendentes

A Home e notificações devem poder refletir:

```text
proposed
failed/retryable
executing
```

O `HeroSection` já possui suporte conceitual para um `pendingCount`, mas o dado não está efetivamente conectado.

A atual tela de Aprovações apenas informa que as decisões são feitas dentro do TED.

### Requisito

Mostrar algo como:

```text
1 aprovação pendente
```

e permitir abrir o TED já focado nela.

> **Emenda 2026-10-01:** o deep-link agora é a rota `/ted?operationId=…`
> (navegação via `openTedChat({ operationId })` → `router.push`; a página lê
> `?operationId=` como `focusedOperationId`). Display routing only,
> inalterado: o Decision Service continua dono de confirm/cancel/retry.

Não criar um segundo executor de aprovação na tela de Aprovações.

Caso essa tela passe a listar operações, as decisões devem reutilizar o mesmo Agent Decision Service.

## 23. H3 — Arquitetura interna do frontend

**Prioridade: P3 / evolução**

Não fazer refactor massivo nesta SPEC.

O `AppStateProvider` está grande, mas funcional.

A estratégia é progressiva.

### 23.1 Primeiro extrair

```text
MutationReconciler
SessionState
```

porque possuem valor arquitetural imediato.

### 23.2 Depois, sob demanda

Considerar:

```text
FinanceReadContext
PlanningContext
CommitmentsContext
ProfileContext
```

ou stores com selectors.

### 23.3 AppShell

Quando uma nova responsabilidade precisar ser adicionada, considerar separar:

```text
AppShell
├ NavigationShell
├ TransactionComposerController
├ OverlayLayer
└ TedLauncher
```

Não refatorar somente para diminuir quantidade de linhas.

## 24. Pequenos ajustes aprovados

Podem ser implementados juntamente com os workstreams correspondentes:

- substituir HTTP em `useLayoutEffect` por `useEffect`;
- padronizar touch targets importantes para ~44px;
- revisar `role="menu"` do FAB: implementar comportamento ARIA completo ou preferencialmente tratá-lo como popover/lista de botões;
- revisar nomenclatura de "Minhas Contas" versus "Contas e Cartões";
- esconder instruções de teclado em touch;
- mapear todos os status visíveis para pt-BR.

> **Emenda 2026-10-01:** o FAB do TED deixou de ser disclosure
> (`aria-haspopup="dialog"`/`aria-expanded` removidos) e virou navegação
> para `/ted` (oculto na própria `/ted` e sob overlays — A1 mantido).

Nenhum deles sozinho bloqueia release.

## 25. Testes obrigatórios

Esta SPEC exige testes de comportamento, não apenas testes de classes isoladas.

### 25.1 Problema dos testes atuais

Há boa cobertura quantitativa, porém algumas lacunas importantes.

O teste in-memory de pending V2 utiliza proposta contendo apenas:

```ts
normalizedArgs: {
  amountCents: 1250
}
```

que não representa um payload executável real de expense.

O teste chamado `pending-v2-postgres-red.test.ts` atualmente apenas verifica:

```ts
typeof createPostgresPendingOperationV2Store === "function"
```

e não exerce o protocolo transacional real.

Os testes de rota também aceitam proposals com `{}`.

Portanto:

> 13/13 gates verdes não contradizem os achados desta auditoria; os cenários não estão sendo exercitados nesses gates.

### 25.2 Contract tests comuns

A mesma suíte de máquina de estados deverá rodar contra:

```text
InMemoryPendingStore
PostgresPendingStore
```

Não manter comportamentos diferentes entre os dois.

Testes de contrato do Mutation Effects Registry:

```text
cada mutação suportada → possui efeitos registrados
sucesso sem política de reconciliação → falha
exceto classificação explícita no-refresh
```

### 25.3 Testes P0

Mutação completa:

```text
"Gastei R$ 50 no mercado"
```

sem conta/categoria suficiente:

```text
→ clarification
→ nenhuma pending operation
```

Com entidades resolvidas:

```text
→ canonical args
→ proposal
→ card
→ confirm
→ exatamente 1 transaction
```

Confirmação natural:

```text
proposal
→ "sim"
→ mesma operação é confirmada
→ exatamente uma execução
```

Cancelamento natural:

```text
proposal
→ "cancela"
→ DB = cancelled
→ executor nunca chamado
```

Múltiplas pendentes:

```text
2 propostas
→ "sim"
→ nenhuma executada
→ solicitação de desambiguação
```

### 25.3.1 Testes P0 — MutationDraft multi-turno

Fluxo feliz:

```text
"Gastei R$ 85 no mercado"
→ falta conta
→ draft criado
→ "Nubank"
→ draft recuperado
→ proposal contém amount/date/description/category/account corretos
```

Casos de falha obrigatórios:

```text
draft expirado
→ resposta curta não executa nada

2 drafts possíveis
→ resposta ambígua
→ nenhum propose

"cancela"
→ draft descartado
→ nenhuma PendingOperation

nova intenção incompatível ("esquece isso, recebi 500 reais de João")
→ não herda campos financeiros do draft anterior

reenvio do mesmo turno (resposta HTTP perdida)
→ nenhum draft duplicado (idempotência §7.7)

duas continuações concorrentes do mesmo draft
→ exatamente uma proposal (consumo atômico §7.8)

continuação concorrente com "cancela"
→ primeiro evento vence; nenhuma duplicidade

reenvio após consumo
→ proposal existente reutilizada; nenhuma segunda pending operation
```

### 25.3.2 Testes P0 — handoff MutationDraft → PendingOperation

O handoff do §7.8 é um protocolo entre dois sistemas (Durable Object ↔ API ↔ PostgreSQL) sem transação distribuída. Casos obrigatórios:

Caso A — resposta perdida após a API persistir:

```text
draft active → proposing
→ API persiste a proposal
→ resposta HTTP perdida
→ Agent reemite o propose com a MESMA proposalIdempotencyKey
→ API retorna a MESMA PendingOperation
→ draft consumed + proposalId
→ exatamente 1 PendingOperation
```

Caso B — crash antes da chamada à API:

```text
draft active → proposing
→ Agent crash antes de chamar a API
→ restart
→ draft `proposing` recuperado do storage
→ propose com a MESMA proposalIdempotencyKey
→ exatamente 1 PendingOperation
```

Caso C — erro definitivo do propose:

```text
propose retorna rejeição definitiva (ex.: validação/negócio, 4xx)
→ nenhuma PendingOperation criada
→ draft discarded (propose_rejected); nunca consumed silenciosamente
→ usuário informado
```

Caso D — propose concorrente:

```text
duas chamadas propose com a MESMA proposalIdempotencyKey
→ uma única PendingOperation
→ a segunda chamada recebe a existente (ou erro determinístico de fingerprint divergente)
```

Caso E — "cancela" durante proposing:

```text
"cancela" enquanto o propose está em voo ou com desfecho desconhecido
→ desfecho resolvido pela MESMA proposalIdempotencyKey
→ se a PendingOperation existe: cancelamento autoritativo (§8.5) antes de responder
→ se nenhuma existe: draft discarded antes de responder
→ somente depois a resposta "cancelado"
→ nenhuma operação ativa restante (INV-10)
```

Em todos os casos: efeito financeiro final 0 ou 1; INV-09 e INV-10 verificáveis por asserção.

### 25.4 Fault injection

Obrigatório reproduzir:

Confirm response loss:

```text
DB confirma
↓
resposta HTTP perdida
↓
confirm novamente
↓
nova attestation
↓
execução única
```

Executor falha (falha determinística pré-write):

```text
claim committed
↓
executor throws antes da escrita
↓
DB = failed + failure_code sanitizado
↓
attestation antiga continua consumida
↓
retry explícito pela mesma operação (failed → confirmed, nova attestation)
```

Executor com resultado incerto (pós-write, sem receipt válido ou falha de
receipt): DB permanece `executing` (`approval.execution_uncertain`), sem
`failed`, sem evento `fail`, sem retry/nova aprovação — reconciliação da
lease expirada com a mesma `idempotencyKey` (§11.3).

Replay:

```text
mesma attestation
↓
segunda execução
↓
403 approval.attestation_replayed
```

Crash após claim:

```text
executing committed
↓
process dies
↓
lease expires
↓
reconciler
↓
mesma idempotencyKey
↓
0 ou 1 efeito financeiro total
```

Falhas de infraestrutura e recarga (obrigatórias). Cada classe de falha é um cenário nomeado próprio — `response loss`, `transport timeout`, `agent crash`, `API crash`, `PostgreSQL failure`, `executor failure`, `browser reload` — sem testes genéricos de "restart", porque os mecanismos de recuperação diferem por estado:

```text
API restart após confirm antes da resposta (response loss; status = confirmed)
→ confirm novamente → nova attestation (§9) → execução única (H-03)
→ NUNCA via lease: lease não existe antes do claim

API crash após claim, antes do executor/finalização (status = executing)
→ lease válida: approval.execution_in_progress
→ lease expirada: reconciler com a mesma idempotencyKey (§11)
→ 0 ou 1 efeito financeiro total (H-05)

transport timeout no confirm (resposta em voo perdida, operação já confirmada)
→ mesmo caminho do response loss: re-confirm com reemissão de attestation (§9)

falha do PostgreSQL durante claim ou TX2
→ operação permanece em estado recuperável; nenhuma mutação fantasma

Agent restart durante clarificação (draft active)
→ draft recuperado do storage ou dados re-pedidos; nenhuma proposal parcial

Agent crash no handoff draft → proposal (draft `proposing`) — casos A/B/D/E de §25.3.2
→ reemissão do propose com a MESMA proposalIdempotencyKey
→ 0 ou 1 PendingOperation; draft nunca perdido com desfecho irrecuperável

reload do browser durante proposed/executing
→ estado autoritativo recarregado do servidor; nenhum dado inventado

duplo clique / dupla mensagem no mesmo turno
→ idempotência de §7.7; no máximo uma proposal e uma execução
```

### 25.5 E2E real com PostgreSQL

Adicionar pelo menos:

```text
PWA/Agent
→ API
→ PostgreSQL
→ WriteStore real
```

para expense e income.

Não usar apenas `v2Executor: async () => succeeded`.

### 25.6 Frontend

Testar:

- close do TED encerra tracks;
- unmount encerra tracks;
- mudança de workspace encerra tracks;
- permissão negada nunca mostra `gravando`;
- object URLs revogadas;
- refresh failure preserva histórico;
- erro de envio preserva mensagem para retry;
- card apresenta valor/data/conta/categoria;
- attestation nunca aparece no payload browser;
- approval success atualiza Home sem reload manual;
- write normal atualiza Home sem reload manual;
- stale reconciliation exibe estado degradado.

### 25.7 Grounding

Adicionar cenários:

```text
evidence null
evidence timeout
all error
empty legítimo
prompt injection pedindo para inventar saldo
```

Nenhum caso de erro pode resultar em número financeiro inventado.

## 26. Evals com modelos reais

Os testes determinísticos continuam obrigatórios.

Além deles, antes do rollout final executar evals reais cobrindo ao menos:

```text
consulta de saldo
consulta de gasto
consulta ambígua
mutação incompleta
mutação completa
confirmação
cancelamento
múltiplas pendentes
prompt injection
falha de evidence
```

Os próprios relatórios atuais registram que os evals com modelos reais continuam pendentes.

## 27. CI e governança

### 27.1 CI remoto

O SHA atual possui:

```text
CI      → failure
PWA CI  → failure
Deploys → skipped
```

Os jobs do CI aparecem como failure sem steps executados, enquanto a documentação do próprio repositório registra bloqueio por billing/spending limit do GitHub Actions (ver [`reports/agent-v2-implementation-report.md`](reports/agent-v2-implementation-report.md)).

Portanto não classificar o estado atual como "testes de código falharam".

Classificação correta:

```text
CI remoto não validado/verde por bloqueio operacional.
```

### 27.2 Gate de release

Antes do deploy:

```text
resolver billing
↓
CI
↓
PWA CI
↓
todos verdes para o mesmo SHA
↓
deploy
```

### 27.3 Proteção da main

A `main` atual está sem proteção e sem required checks.

Configurar ruleset/branch protection para:

- exigir os gates finais de CI;
- exigir os jobs PWA relevantes;
- impedir force push;
- impedir delete;
- exigir branch atualizada antes do merge quando aplicável.

Como o projeto pode ser desenvolvido por uma única pessoa, não é obrigatório exigir aprovação de outro humano.

O objetivo é impedir merge/deploy de código vermelho, não criar burocracia.

## 28. Ordem de prioridade

### BLOCO A — P0: restaurar o fluxo financeiro do TED

1. contrato canônico de tools (Approval Tool Contract);
2. resolução de `accountId/categoryId`;
3. persistência da intenção multi-turno (MutationDraft);
4. validação completa no `propose`;
5. impedir pending operation incompleta;
6. unificar botão + linguagem natural;
7. listagem autoritativa de pendentes;
8. cancelamento real;
9. confirmação natural real;
10. E2E Agent → API → PostgreSQL.

Nenhum rollout do novo Agent deve ocorrer antes deste bloco.

### BLOCO B — P1: hardening transacional

10. confirm recuperável;
11. claim em TX separada;
12. finalização persistente;
13. execution lease;
14. stale execution reconciliation;
15. testes de crash/replay/concurrency.

### BLOCO C — P1: verdade e consistência

16. remover financial `legacy pass-through`;
17. MutationReceipt + Mutation Effects Registry (determinístico, comum a TED e writes normais);
18. MutationReconciler;
19. refresh pós-TED;
20. refresh pós-write comum;
21. approval card estruturado.

### BLOCO D — P1: TED frontend

22. lifecycle do microfone;
23. state machine de gravação;
24. capability gate para anexos;
25. cleanup de blobs.

### BLOCO E — P2: experiência e segurança (condicional — ver política de §32)

26. chat optimistic/resiliente;
27. overlay accessibility;
28. pending-operation indicator;
29. cookie-first migration;
30. pequenos ajustes de UX.

### BLOCO F — Release

31. nova auditoria independente;
32. `validate:final`;
33. testes PostgreSQL reais;
34. real-model evals;
35. CI remoto verde;
36. protection/ruleset;
37. deploy Agent/PWA;
38. smoke pós-deploy.

## 29. Rollout

### Fase 1 — desenvolvimento

Branch dedicada a partir da `main` auditada.

Nenhum deploy automático durante desenvolvimento.

### Fase 2 — validação

Executar:

```text
lint
typecheck
Agent tests
API tests
PWA tests
Postgres integration
architecture:check
write-policy
security
build
E2E
deterministic evals
real-model evals
```

### Fase 3 — auditoria pós-implementação

Auditor diferente do implementador deve rastrear manualmente:

```text
PWA
→ Agent
→ Pending Operation
→ API
→ PostgreSQL
→ PWA reconciliation
```

e responder:

```text
O que o usuário viu é exatamente o que foi executado?
```

### Fase 4 — produção

Ordem sugerida:

```text
migration V052
↓
API
↓
health/readiness
↓
Agent
↓
PWA
↓
E2E smoke
```

## 30. Rollback

Rollback deve continuar separado:

```text
API
Agent
PWA
```

A migration deve ser backward-compatible quando possível.

Nunca considerar rollback aceitável se ele:

- reativar `[EXEC_ACTION]`;
- permitir write do LLM;
- retirar confirmação;
- permitir attestation no browser.

Operações `executing` existentes devem ser reconciliadas antes de rollback de uma versão que altere a state machine.

## 31. Definition of Done

Itens marcados com **[P2]** aceitam a disposição "concluído OU deferido" conforme a política de §32; todos os demais são obrigatórios para o release V3.

### Mutação

- [ ] nenhuma proposal inválida pode ser persistida;
- [ ] expense e income possuem `accountId/categoryId` reais;
- [ ] clarificação multi-turno preserva a intenção original em `MutationDraft` sem inferência livre do LLM;
- [ ] draft expirado, ambíguo, cancelado ou substituído nunca gera proposal nem execução;
- [ ] handoff draft → PendingOperation é recuperável e idempotente: 0 ou 1 PendingOperation por draft completado em todos os cenários de §25.3.2 (resposta perdida, crash, propose concorrente, erro definitivo);
- [ ] "cancela" durante `proposing` só responde cancelado após resolver o desfecho do propose pela mesma chave (INV-10);
- [ ] o card representa os mesmos args executados;
- [ ] confirmação por botão funciona;
- [ ] confirmação por texto funciona;
- [ ] cancelamento por botão funciona;
- [ ] cancelamento por texto funciona;
- [ ] múltiplas pendentes não são executadas por confirmação ambígua.

### Attestation

- [ ] resposta perdida de confirm é recuperável;
- [ ] token antigo fica inválido após rotação;
- [ ] token consumido nunca volta a válido após erro;
- [ ] retry em failed emite nova attestation;
- [ ] crash em executing é recuperável por lease/reconciliation;
- [ ] restart em `confirmed` recupera por reemissão de attestation sem uso de lease; restart em `executing` recupera por lease/reconciler — cenários distintos e testados separadamente (§25.4);
- [ ] replay não causa duplicidade.

### Grounding

- [ ] dado financeiro pessoal nunca usa pass-through sem evidência;
- [ ] erro de evidence não produz números inventados;
- [ ] empty legítimo continua funcional.

### Frontend

- [ ] microfone sempre é encerrado;
- [ ] UI nunca mostra gravação inexistente;
- [ ] capabilities de anexo refletem suporte real;
- [ ] cards de aprovação mostram dados relevantes;
- [ ] sucesso financeiro reconcilia o estado da PWA;
- [ ] falha de refresh gera stale, não dado silenciosamente desatualizado;
- [ ] receipts de writes normais são válidos sem PendingOperation (`mutationId` universal; `operationId` somente no caminho TED);
- [ ] `MutationReconciler` consome receipts das duas origens (TED e writes normais) sem acoplamento ao protocolo de aprovação;
- [ ] **[P2]** histórico não desaparece por erro transitório.

### Segurança

- [ ] attestation continua fora do browser;
- [ ] identity bindings continuam válidos;
- [ ] device binding continua válido;
- [ ] localStorage não ganha novos segredos;
- [ ] **[P2]** migração cookie-first possui testes próprios (dispensável apenas via deferral formal de §32).

### Validação

- [ ] suíte state-machine roda contra in-memory e PostgreSQL;
- [ ] E2E real PWA/Agent/API/Postgres passa;
- [ ] `pnpm validate:final` passa;
- [ ] evals determinísticas passam;
- [ ] evals com modelos reais passam no baseline aprovado;
- [ ] CI remoto passa no mesmo SHA;
- [ ] PWA CI passa no mesmo SHA;
- [ ] main protegida;
- [ ] auditoria independente sem P0/P1 aberto;
- [ ] smoke pós-deploy passa.

## 32. Critério final de release

O Meu TED somente será considerado **candidato a produção V3** quando:

```text
P0 = 0
P1 = 0
CI = green
PWA CI = green
real-model eval = aprovado
post-implementation audit = aprovado
production smoke = aprovado
```

P2 e P3 documentados podem permanecer, desde que não criem risco de:

```text
mutação financeira incorreta
duplicidade
exposição de segredo
falsa confirmação
dado financeiro inventado
estado visual enganoso
```

### Política P2/P3 vs gate de release

- P0/P1 são obrigatórios para o release V3; P2/P3 não são obrigatórios por severidade.
- Todo BLOCO E está fora do caminho crítico de release (Core Release Path: Fase 0 do plano de execução (contratos compartilhados) → A → B → C → D → F); a implementação de release não pode depender dele por definição.
- **Promoção automática:** um item P2/P3 sobe para P1/blocker se, durante a implementação ou a auditoria, demonstrar risco concreto a: segurança, autoridade financeira, device binding, privacidade, confirmação ou reconciliação confiável — ou violar qualquer invariante INV-01..INV-10.
- **Disposição de cada item P2/P3 no DoD:** `concluído` OU `deferido explicitamente`, sendo o deferral registrado com: risco avaliado, nenhum invariante crítico afetado e follow-up registrado (issue/backlog). Não existe terceira opção.
- Análise individual do BLOCO E nesta SPEC: chat resiliência (§19), overlay a11y (§21), indicador de pendentes (§22) e ajustes de UX (§24) são deferíveis sem tocar invariantes. Cookie-first (§20) permanece P2/deferido: `credentials: include` já existe (§35.3, item 2), a V3 não introduz novos segredos em `localStorage` e o risco se torna crítico apenas durante a retirada do bearer. **Gatilho de promoção:** se qualquer mudança da V3 exigir novo segredo de longa duração em `localStorage`, ou se a auditoria independente (§29 Fase 3) encontrar vetor concreto de exposição, o cookie-first sobe para P1 e passa a bloquear o release.

## 33. Decisões resultantes da revisão crítica da própria SPEC

Durante a elaboração desta SPEC as recomendações anteriores foram reavaliadas.

### Mantido e promovido

**Contrato de mutação incompleto → P0.**

A análise direta do parser, orchestrator, proposal e executor provou incompatibilidade real.

### Novo P0

**Confirmação/cancelamento conversacional.**

A integração do `/rpc/chat` não fornece ao turno posterior a mesma infraestrutura de decisão usada pelo Approval RPC.

### Mantido, mas ampliado

**Separação da transação de execução.**

A recomendação original de separar claim e executor estava correta, porém incompleta. Foi adicionada lease/reconciliation para não substituir replay por operações eternamente `executing`.

### Novo P1

**Reconciliação pós-mutação da PWA.**

A revisão do estado global mostrou que writes locais e approvals podem deixar `dashboardSummary` e domínios relacionados desatualizados.

### Rebaixado

**Migração para cookie-only: P1 → P2.**

O desenho atual é dívida arquitetural e de segurança, mas o `AuthGate` ainda exige o token legado, impedindo hoje parte dos estados inconsistentes imaginados na primeira análise. O problema se torna crítico durante a retirada desse mecanismo, não necessariamente antes dela.

### Escopo reduzido

**Attachments.**

Não é necessário implementar toda a pipeline multimodal para concluir o hardening. O requisito mínimo é parar de anunciar uma capability que não existe. A ingestão multimodal real pode vir depois.

### Rejeitado

**Grande refactor de frontend agora.**

Não há evidência que justifique reescrever `AppStateProvider`, `AppShell` ou todas as páginas antes do hardening.

### Rejeitado

**Otimização ampla de bundle.**

O initial JS atual está dentro do budget existente; otimização deve ser dirigida por medição, não por tamanho de arquivo isolado.

## 34. Resultado esperado

Depois desta SPEC, a fundação deverá atingir o seguinte comportamento:

```text
Usuário:
"Gastei R$ 85 no mercado"

TED:
"Em qual conta?"

Usuário:
"Nubank"

        ↓

resolução:
accountId = UUID Nubank
categoryId = UUID Alimentação

        ↓

validação canônica

        ↓

pending operation autoritativa

        ↓

TED:

Confirmar despesa

Mercado
R$ 85,00
Nubank
Alimentação
14/09/2026

[Confirmar R$ 85,00]
[Cancelar]

        ↓

"sim"

        ↓

mesmo Decision Service do botão

        ↓

attestation
        ↓
claim COMMIT
        ↓
executor idempotente
        ↓
success COMMIT
        ↓
MutationReceipt
        ↓
PWA reconciliation

        ↓

TED:
"Despesa registrada."

HOME:
saldo atualizado
despesas atualizadas
orçamento atualizado
extrato atualizado
```

Com qualquer falha no caminho:

```text
o sistema prefere dizer
"não consegui concluir"
```

a inventar, duplicar ou declarar sucesso prematuramente.

## Conclusão

A V2 resolveu o problema arquitetural central do Meu TED. Esta V3 não deve reconstruí-la.

O objetivo agora é transformar uma arquitetura conceitualmente segura em uma arquitetura **operacionalmente segura ponta a ponta**.

A prioridade não é adicionar mais abstrações.

É fechar as lacunas entre:

```text
intenção
→ proposta
→ confirmação
→ execução
→ persistência
→ representação na interface
```

e garantir que cada uma dessas transições possua uma autoridade, um contrato e um teste verificável.

---

## 35. Apêndice — Reauditoria de validação no código (2026-09-14)

Reauditoria independente realizada por 4 subagentes de exploração sobre a baseline `main@e5f21177fc970c631fe47b80c584485fe0e0d47b` (commit de documentação sobre o SHA de código `8541f19`), inspecionando `apps/agent`, `apps/api`, `apps/pwa`, `docs/` e `.github/workflows/`. Objetivo: validar cada achado contra o código real antes do planejamento. Os números de linha referem-se a essa baseline.

### 35.1 Validação por achado

| ID | Veredito | Evidência principal |
| --- | --- | --- |
| H-01 | Confirmado | Parser sem `accountId`: `apps/agent/src/mutations/financial-parser.ts:1-3,28-31`; `normalizedArgs` montado sem conta em `apps/agent/src/orchestration/conversation-orchestrator.ts:209-222`; `missingFields: []` fixo em `apps/agent/src/orchestration/intent-router.ts:64` e `apps/agent/src/finance-chat-agent.ts:970-986`; validação real só no execute: `apps/api/src/writes/types.ts:91-110` + `apps/api/src/approvals/executor.ts` (`createPendingOperationV2Executor` em `apps/api/src/routes/index.ts:154-170`); propose V2 aceita `normalizedArgs` genérico: `apps/api/src/routes/pending-operations.ts:64` e `apps/api/src/approvals/pending-v2.ts:70,110`. |
| H-02 | Confirmado | `MutationApiClient` só criado para turno mutante: `apps/agent/src/finance-chat-agent.ts:1116-1121`; branch de confirmação exige `client`: `conversation-orchestrator.ts:225`; `resolveConfirmation` exige `pendingOperationIds.length===1` (`apps/agent/src/mutations/confirmation-resolver.ts:10`) e o chat nunca injeta pendentes server-side (`conversation-orchestrator.ts:85-87`); cancel NL só responde texto: `conversation-orchestrator.ts:247-251`; botão usa RPC distinto: `finance-chat-agent.ts:900-967,1058-1061`. |
| H-03 | Confirmado | Segundo `confirm()` em `confirmed` retorna sem token: `apps/api/src/approvals/pending-v2.ts:78` (Postgres; `mapV2:44-54` omite attestation). Divergência: store in-memory (`:122-125`) devolve o objeto original ainda com attestation. |
| H-04/H-05 | Confirmado | Claim + executor + finalização dentro de um único `withTransaction`: `pending-v2.ts:79`; `ROLLBACK` em throw: `apps/api/src/db/pool.ts:44-63`; o catch do execute faz `UPDATE failed` que também sofre rollback. |
| H-06 | Confirmado | `evidenceProvider` → `null` quando nada mapeável: `apps/agent/src/orchestration/channel-evidence.ts:289-290` (com `DOMAIN_DEFAULT_READ:131-142`); pass-through direto ao `responseProvider`: `conversation-orchestrator.ts:150-158`. |
| H-07 | Confirmado | Mutators só tocam arrays locais: `apps/pwa/src/lib/state/app-state-context.tsx:538-1361` (múltiplos pontos); `refreshDomains:1637-1684` não cobre `dashboardSummary` (`refreshDashboardSummary:1622-1630` isolado); callback pós-aprovação só recarrega conversa: `apps/pwa/src/features/ted/TedChat.tsx:379`. |
| H-08 | Confirmado | `setRecording(true)` antes de `getUserMedia`: `TedChat.tsx:160-199` (catch comenta explicitamente manter "gravando"); fechar chat só limpa boolean: `TedChat.tsx:98-102`. |
| H-09 | Confirmado | `URL.createObjectURL` + metadata textual sem bytes: `TedChat.tsx:127,143,185,234-240`; botões sempre habilitados: `TedChat.tsx:431-454`; upload real só existe como mock de teste. |
| H-10 | Confirmado | Contrato mínimo do card: `apps/pwa/src/features/ted/TedApprovalCard.tsx:6-11`, UI `Ação: summary` em `:76`; attestation nunca cruza o browser (testes existentes em `agent-client.test.ts:37` e `TedApprovalCard.test.tsx:35` permanecem válidos). |
| H-11 | Confirmado com nuances | Bearer em `localStorage`: `apps/pwa/src/lib/api/token-store.ts:9-15,33-39`, `AuthGate.tsx:27,70,84`, gate em `RootProviders.tsx:28-34,62`. **Nuance 1:** `credentials: include` já está presente (`apps/pwa/src/lib/api/client.ts:172` e todo `agent-client.ts`), então §20.3 já é realidade parcial. **Nuance 2:** snapshots já usam fingerprint SHA-256 do token, não o token cru (`apps/pwa/src/lib/state/snapshot-store.ts:34-46`) — §20.5 está parcialmente resolvido; falta identificador estável independente de token. |
| H-12 | Confirmado | Existem `role="dialog"`, `aria-modal`, Escape e scroll lock ref-counted (`BottomSheet.tsx:211-212,128-141`; `apps/pwa/src/lib/ui/overlay-a11y.ts:26-56`); faltam initial focus, focus trap, focus restore e inert (padrão parcial só em `ConfirmActionDialog.tsx:48-56`). |
| H-13 | Confirmado | Otimismo só com anexo: `TedChat.tsx:210-221`; catch de `fetchAgentHistory` zera mensagens: `TedChat.tsx:72-77`; retry não preserva draft/anexos: `TedChat.tsx:223-226,248-252`; já existe abort controlado em `agent-client.ts:128-155,306-318`. |
| H-14 | Confirmado | `pendingCount` renderiza dot mas recebe `null` hardcoded: `apps/pwa/src/features/home/components/HeroSection.tsx:17,43,129-134` + `apps/pwa/src/features/home/HomePage.tsx:139-142`; tela de Aprovações apenas informativa: `apps/pwa/src/features/pending-operations/PendingOperationsPage.tsx:32-46`. |
| H-15 | Confirmado | `app-state-context.tsx`: 1833 linhas; `AppShell.tsx`: 334 linhas. |
| H-16 | Confirmado | Gate de deploy exige CI + PWA CI do mesmo SHA, fail-closed: `.github/workflows/pwa-deploy.yml:23-57` (idem `agent-deploy.yml`); bloqueio de billing registrado em `docs/reports/agent-v2-implementation-report.md:158-160`. |

### 35.2 Verificações adicionais

- **Sem endpoint de listagem:** não existe `GET /pending-operations/v2/active` (apenas `GET /:id` e `GET /:id/status` em `pending-operations.ts:74-75`; list só na V1). §8.3 é trabalho novo.
- **Sem registry de tools:** não há `affectedTargets`/`approvalRequired` como catálogo em `apps/api/src` (executor é `if tool===...` em `routes/index.ts:157,163`). §7.5 e §15.1 são trabalho novo.
- **Sem colunas de lease:** a tabela V2 (`apps/api/src/read-models/sql/V051__pending_operation_bindings.sql:4-15`) não possui `attestation_issued_at`, `execution_claimed_at`, `execution_lease_expires_at`, `execution_attempt_count` nem `failure_code`. §12 é trabalho novo; última migration é `V051`.
- **Testes frágeis confirmados:** `apps/api/tests/approvals/pending-v2-postgres-red.test.ts` tem 8 linhas e só verifica `typeof`; suíte in-memory usa `normalizedArgs:{amountCents:1250}` (`pending-v2.test.ts:12`); rotas aceitam `normalizedArgs:{}` com `201` (`tests/routes/pending-operations-v2.test.ts:61,86`). §25.1 confirmado.
- **Idempotência de turno frágil (reforço ao §7.7):** `intentionId` tem fallback `intent-${Date.now()}` com random (`conversation-orchestrator.ts:78`, `finance-chat-agent.ts:1099-1101`); retry/reload gera chave nova e o dedup da API por `(workspaceId, idempotencyKey)` (`pending-v2.ts:71-73,111-115`) não protege. `deriveIdempotencyKey` (`apps/agent/src/tools/intention-ledger.ts:10-17`) existe mas não é usado no propose.

### 35.3 Correções à SPEC identificadas pela reauditoria

1. **§9 / DoD "retry em failed emite nova attestation": comportamento já implementado.** O `retry` (failed → confirmed) já emite nova attestation e zera `attestation_consumed_at` (`pending-v2.ts:80` Postgres; `:158-165` in-memory). O item de DoD correspondente vira verificação de não regressão, não trabalho novo. O que falta é apenas a reemissão do caso `confirmed` com attestation não consumida (H-03).
2. **§20.3 `credentials: include` já presente** nos clientes HTTP da PWA. O trabalho da migração cookie-first concentra-se no `AuthGate`/`RootProviders` (deixar de condicionar a API ao bearer) e no inventário de device binding/snapshot namespace, não em adicionar `credentials`.
3. **§20.5 snapshots:** o namespace já é fingerprint SHA-256 do token, não o token cru. Falta apenas substituir por identificador local estável independente de token antes da retirada do bearer.

Essas correções não alteram prioridades nem o escopo dos blocos A–F; apenas reduzem o trabalho do bloco E e convertem um item de DoD em teste de não regressão.
