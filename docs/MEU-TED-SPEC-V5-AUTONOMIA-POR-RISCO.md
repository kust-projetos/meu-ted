# Meu TED — SPEC: Autonomia por Risco e Inteligência Conversacional

**Status:** proposta aceita para implementação (ver revisão de baseline em
[reports/2026-10-02-ted-risk-authorization-spec-review.md](reports/2026-10-02-ted-risk-authorization-spec-review.md))
**Data:** 2026-10-02
**Baseline analisada:** `main@6bcdebb` (igual à `main` do dia — zero drift)
**Projeto:** Meu TED
**Escopo principal:** `apps/agent`, `apps/api`, `apps/pwa`, `packages/llm-contracts`
**Objetivo:** tornar o TED mais inteligente, natural e autônomo sem transferir autoridade financeira para a LLM.

---

# 1. Contexto

O TED atual possui uma arquitetura de segurança madura:

```text
Usuário
  ↓
TED / ConversationOrchestrator
  ↓
PendingOperation V2
  ↓
API autoritativa
  ↓
confirmação
  ↓
attestation
  ↓
MutationExecutor
  ↓
WriteStore
  ↓
PostgreSQL
  ↓
MutationReceipt
```

Esse fluxo protege contra duplicação, prompt injection, workspace incorreto, identidade incorreta, retries perigosos, resultados incertos e falso sucesso.

Entretanto, o fluxo atual trata praticamente toda criação de receita/despesa pelo TED como uma operação que exige confirmação manual.

Exemplo atual:

```text
Usuário:
"Registre R$ 35 de almoço no Nubank."

TED:
"Confirmar R$ 35,00?"
```

Isso produz uma confirmação redundante: o próprio comando do usuário já expressou explicitamente a intenção de registrar a transação.

O projeto já possui `apps/api/src/approvals/policy.ts`, incluindo limite padrão de `50_000` centavos, mas o fluxo V2 do TED ainda utiliza contratos com `approvalRequired: true`.

O objetivo desta evolução é separar:

- interpretação da intenção;
- análise de risco;
- autorização;
- execução.

A confirmação manual deixa de ser universal e passa a ser exigida somente quando houver motivo concreto.

> **Nota da revisão 2026-10-02:** a leitura do código mostrou que
> `approvalRequired` no tool registry é **declarativo** — o enforcement real
> vem do fluxo V2 (propose → confirm → attestation → execute) e das
> capabilities por rota (`financial.approval.*`). A evolução correta portanto
> adiciona decisão de risco determinística na API e um caminho de
> autoautorização próprio; o campo do registry vira metadado de elegibilidade.

---

# 2. Objetivo

Transformar o TED em um agente com:

```text
INTENT
   ↓
ENTITY RESOLUTION
   ↓
COMPLETENESS
   ↓
RISK POLICY
   ↓
AUTHORIZATION
   ↓
EXECUTION
   ↓
RECEIPT / UNDO
```

O comportamento esperado é:

```text
Leitura
→ executar diretamente

Mutação explícita + completa + baixo risco
→ executar automaticamente

Mutação incompleta/ambígua
→ perguntar apenas o que falta

Mutação de alto risco
→ solicitar confirmação

Mutação destrutiva
→ solicitar confirmação forte

Resultado incerto
→ não repetir; reconciliar

Sucesso
→ informar resultado + disponibilizar Undo quando aplicável
```

---

# 3. Não objetivos

Esta fase NÃO deve:

- permitir escrita financeira direta pela LLM;
- permitir que o modelo atribua sua própria permissão;
- remover idempotência;
- remover PendingOperation V2;
- remover MutationReceipt;
- remover binding de workspace/actor/device;
- remover execution lease/reconciliation;
- remover auditoria;
- permitir autoexecução de ações destrutivas;
- permitir memória atuar como autoridade financeira;
- expandir autoexecução para todas as ferramentas de uma vez;
- fazer refatoração massiva apenas para trocar o termo `approval`.

A prioridade é mudar comportamento sem enfraquecer as fronteiras atuais.

---

# 4. Invariantes obrigatórios

## INV-01 — API continua autoridade

A API continua sendo a única autoridade de escrita financeira.

Nenhuma LLM, PWA, Durable Object ou memória pode escrever diretamente no banco.

## INV-02 — Toda escrita do TED continua passando por PendingOperation

Mesmo operações executadas automaticamente devem seguir:

```text
propose
→ authorize
→ execute
→ receipt
```

É proibido criar um segundo caminho:

```text
TED → WriteStore
```

ou:

```text
TED → POST /transactions diretamente
```

## INV-03 — LLM não determina autorização

O modelo pode interpretar linguagem e ajudar na conversa.

Ele NÃO pode retornar algo como:

```json
{
  "risk": "low",
  "autoExecute": true
}
```

e esse resultado ser aceito como autoridade.

Risco e autorização devem ser calculados deterministicamente pelo código.

## INV-04 — identidade permanece obrigatória

Autoexecução exige:

- `workspaceId`;
- `actorId`;
- `deviceId`;
- token delegado válido;
- capability específica;
- PendingOperation vinculada à mesma identidade.

Qualquer divergência falha fechado.

## INV-05 — idempotência permanece obrigatória

A mesma intenção/redelivery deve convergir para:

- mesma PendingOperation;
- mesma `idempotencyKey`;
- no máximo um efeito financeiro.

## INV-06 — resultado incerto nunca gera retry cego

Se a escrita pode ter ocorrido mas o receipt não foi comprovado:

```text
status = executing
→ execution lease
→ reconciliation
```

Nunca:

```text
erro
→ executar novamente como operação nova
```

## INV-07 — autoexecução é allowlist

Na primeira versão, somente:

- `transactions.expense.create`
- `transactions.income.create`

podem ser candidatos à autoexecução.

Todo outro mutator permanece manual até possuir política própria.

## INV-08 — destrutivos sempre manuais

Operações como:

- exclusão;
- cancelamento;
- desativação;
- pagamento;
- reversão de pagamento;
- cancelamento de compra;
- alterações destrutivas;
- undo financeiro;

não podem usar o fluxo de autoexecução nesta fase.

## INV-09 — memória não concede autoridade

Memória pode:

- melhorar linguagem;
- sugerir uma conta;
- ordenar opções;
- lembrar preferências.

Memória não pode:

- inventar `accountId`;
- inventar `categoryId`;
- confirmar uma transação;
- elevar confiança de autorização;
- substituir authoritative entity resolution.

## INV-10 — nenhum sucesso sem receipt

O TED só pode dizer:

> "Registrei..."

quando houver `MutationReceipt` válido e ligado à operação executada.

---

# 5. Modelo de risco

Criar uma política determinística com quatro níveis.

## LOW

Elegível para autoexecução.

Requisitos cumulativos:

- ferramenta na allowlist de autoexecução;
- intenção explicitamente mutante;
- dados completos;
- entidades resolvidas de forma inequívoca;
- identidade/device válidos;
- valor abaixo do limite de alto valor;
- operação reversível;
- nenhuma indicação de duplicidade relevante;
- nenhuma warning que exija revisão humana.

Resultado:

```text
AUTO_EXECUTE
```

## MEDIUM

Exige clarificação ou revisão.

Exemplos:

- entidade ambígua;
- possível duplicidade;
- resolução de conta/categoria fraca;
- informação relevante faltando;
- intenção linguística não explicitamente mutante.

Resultado:

```text
CLARIFY
```

ou, quando os dados estiverem completos mas houver risco contextual:

```text
REQUIRE_CONFIRMATION
```

## HIGH

Operação válida, porém de impacto elevado.

Primeiro critério:

```text
amountCents >= highValueLimitCents
```

O valor inicial deve preservar a configuração existente:

```text
50_000 cents
= R$ 500,00
```

Resultado:

```text
REQUIRE_CONFIRMATION
```

O threshold deve continuar configurável, não espalhado como literal pelo código.

## DESTRUCTIVE

Qualquer ação classificada como:

- destructive;
- cancellation;
- deactivation;
- payment;
- irreversible ou de reversão sensível.

Resultado obrigatório:

```text
REQUIRE_CONFIRMATION
```

---

# 6. Intenção explícita

Autoexecução exige uma intenção explícita do ator.

Exemplos inicialmente elegíveis:

```text
"Registre R$ 35 de almoço no Nubank."
"Adicione uma despesa de R$ 20 de gasolina."
"Lance R$ 120 de salário extra."
"Anote R$ 50 de farmácia na conta X."
```

A avaliação deve usar código determinístico sobre a mensagem original do ator.

Não utilizar output do modelo como autorização.

Exemplos que NÃO devem autoexecutar na primeira versão:

```text
"Gastei 80 no mercado."
"Paguei 120 ontem."
"Acho que foram 35 de almoço."
"E se eu registrasse 300?"
"Quanto ficaria se eu adicionasse 500?"
```

Esses casos podem gerar:

- pergunta;
- proposta;
- sugestão;

mas não execução automática.

Essa abordagem deve começar conservadora. Ampliação futura depende de telemetria e testes.

---

# 7. Resolução inteligente de entidades

O TED deve perguntar somente o que realmente falta.

Exemplo:

```text
Usuário:
"Registre 300 que gastei ontem."

TED:
"Em qual conta foi essa despesa?"
```

Não repetir:

- valor;
- data;
- tipo;

quando esses campos já estão resolvidos.

O `MutationDraft` existente deve continuar sendo utilizado.

## Entidade inequívoca

Se o entity resolver retornar uma única correspondência canônica válida:

```text
"Nubank"
→ accountId X
```

o fluxo pode continuar.

## Entidade ambígua

Se houver mais de uma correspondência plausível:

```text
"Nubank pessoal"
"Nubank compartilhado"
```

o TED deve perguntar.

Nunca escolher silenciosamente para ganhar fluidez.

---

# 8. Memória e preferências

A memória deve ser utilizada para melhorar a conversa, não para criar autoridade.

Exemplo permitido:

```text
Usuário:
"Registre 80 no mercado."

Memória:
usuário frequentemente usa Nubank para supermercado.

TED:
"Foi pelo Nubank?"
```

Não permitido:

```text
memória → accountId Nubank → autoexecute
```

sem confirmação/resolução autoritativa.

No futuro, preferências explicitamente configuradas pelo usuário poderão se tornar defaults autoritativos, mas isso exige contrato próprio fora da memória livre da LLM.

---

# 9. Nova decisão de autorização

Evoluir o conceito atual de `ApprovalPolicy` para representar:

```ts
type MutationRiskTier =
  | "low"
  | "medium"
  | "high"
  | "destructive";

type MutationAuthorizationDecision =
  | {
      action: "auto_execute";
      risk: "low";
      reason: "explicit_low_risk";
    }
  | {
      action: "clarify";
      risk: "medium";
      reason:
        | "missing_fields"
        | "ambiguous_entity"
        | "possible_duplicate"
        | "intent_not_explicit";
    }
  | {
      action: "require_confirmation";
      risk: "medium" | "high" | "destructive";
      reason:
        | "possible_duplicate"
        | "high_value"
        | "destructive"
        | "policy_required";
    };
```

O nome exato pode ser adaptado ao padrão do projeto.

Não espalhar regras entre Agent, PWA e API.

A política financeira final deve pertencer à API.

---

# 10. Autoautorização segura

Criar uma operação distinta de confirmação manual.

Não fingir que um botão foi clicado.

Fluxo alvo:

```text
Actor message
  ↓
deterministic explicit-intent guard
  ↓
entity resolution
  ↓
POST propose
  ↓
API risk policy
  ↓
LOW?
 ┌───────┴────────┐
 sim              não
 ↓                 ↓
auto-authorize   manual/clarify
 ↓
attestation
 ↓
execute
 ↓
receipt
```

A implementação pode introduzir uma rota equivalente a:

```text
POST /pending-operations/v2/:id/authorize
```

com modo interno:

```json
{
  "mode": "auto"
}
```

ou outro contrato equivalente consistente com a arquitetura.

Não reutilizar silenciosamente `confirm` de forma que uma autorização automática seja registrada como confirmação manual.

---

# 11. Capability específica

Criar capability estreita para autoexecução.

Exemplo:

```text
financial.approval.autoexecute
```

ou nome semanticamente equivalente.

Essa capability:

- não pode ser fornecida à LLM;
- não pode ser enviada pelo browser;
- só pode ser mintada pelo Agent server-side;
- exige device binding;
- exige workspace/actor binding;
- só vale para o fluxo PendingOperation V2;
- não substitui `financial.write` geral.

Adicionar architecture/security test garantindo que nenhuma outra camada possa emitir essa capability.

---

# 12. Persistência e auditoria

Adicionar migration aditiva após V058.

Sugestão:

```text
V059__pending_operation_authorization.sql
```

Campos:

```text
authorization_mode
authorization_reason
risk_tier
authorized_at
```

Valores possíveis de `authorization_mode`:

```text
manual
auto
```

Não quebrar PendingOperations antigas.

Campos devem ser nullable/backward compatible.

Exemplo de operação autoexecutada:

```text
authorization_mode = auto
authorization_reason = explicit_low_risk
risk_tier = low
```

Operação de R$ 1.000 confirmada:

```text
authorization_mode = manual
authorization_reason = high_value
risk_tier = high
```

---

# 13. Duplicate awareness

Antes de autoexecutar, utilizar a infraestrutura de detecção de duplicidades existente quando aplicável.

Possível duplicidade deve impedir autoexecução.

Exemplo:

```text
R$ 35
Almoço
Nubank
hoje
```

quando uma operação muito semelhante já existe.

Resultado:

```text
REQUIRE_CONFIRMATION
```

ou:

```text
CLARIFY
```

Nunca:

```text
duplicate suspected → autoexecute
```

Idempotência continua protegendo redelivery da mesma intenção, mas não substitui duplicate detection para duas intenções diferentes.

---

# 14. UX de baixo risco

Entrada:

```text
"Registre R$ 35 de almoço no Nubank."
```

Saída desejada:

```text
Despesa de R$ 35,00 em Alimentação registrada no Nubank.

Desfazer
```

Não exibir `TedApprovalCard`.

A PWA deve reconciliar o estado através do receipt.

---

# 15. UX de alto valor

Entrada:

```text
"Registre uma despesa de R$ 2.000 no Nubank."
```

Saída:

```text
Confirmar despesa

Valor: R$ 2.000,00
Conta: Nubank
Categoria: ...
Data: ...

[Confirmar] [Cancelar]
```

O `TedApprovalCard` continua sendo usado.

---

# 16. UX de ambiguidade

Entrada:

```text
"Registre R$ 300 que gastei ontem."
```

Saída:

```text
Em qual conta foi essa despesa?
```

Se categoria também faltar, não bombardear o usuário com várias perguntas desnecessárias quando o Draft puder resolver progressivamente.

Continuar o `MutationDraft`.

---

# 17. UX de possível duplicidade

Entrada:

```text
"Registre R$ 35 de almoço no Nubank."
```

Se existir lançamento altamente semelhante:

```text
Encontrei uma despesa semelhante de R$ 35,00 hoje no Nubank.

Deseja registrar outra mesmo assim?
```

Nunca executar silenciosamente.

---

# 18. Undo

Autoexecução só deve ser liberada inicialmente para operações que possuam caminho de reversão auditável.

Após autoexecução bem-sucedida, a UI deve permitir Undo quando aplicável.

Undo continua sendo operação sensível.

Não autoexecutar Undo apenas porque a operação original foi automática.

---

# 19. Recuperação inteligente

O TED deve distinguir:

## Pre-write determinístico

Exemplo:

```text
validation.invalid_arguments
```

Pode:

- corrigir;
- perguntar;
- ou permitir retry conforme contrato.

## Resultado incerto

Exemplo:

```text
approval.execution_uncertain
```

Não pode executar novamente.

Deve informar estado de processamento e utilizar lease/reconciliation.

## Tool/read transitório

Pode tentar novamente de forma limitada quando:

- não existe risco de novo efeito financeiro;
- a política de retry permitir.

Não criar loops.

---

# 20. Comportamento conversacional

Refinar as instruções do TED para:

- responder diretamente;
- não repetir dados já fornecidos;
- perguntar somente campos realmente faltantes;
- usar linguagem natural em pt-BR;
- evitar mensagens internas como `approval`, `attestation`, `pending operation`;
- não dizer "não tenho acesso" quando existe ferramenta autorizada;
- diferenciar claramente consulta, sugestão e execução;
- comunicar resultado somente após confirmação autoritativa;
- não inventar saldos, IDs, contas, categorias ou sucesso.

Resposta de ação bem-sucedida deve privilegiar:

```text
ação + resultado + informação principal + undo
```

e não explicações sobre infraestrutura.

---

# 21. TurnPlan / MutationPolicy

O contrato atual contém:

```ts
approvalRequired: true
```

fixo.

Esse contrato deve evoluir.

Sugestão conceitual:

```ts
type MutationAuthorizationMode =
  | "none"
  | "clarify"
  | "auto"
  | "manual";

type MutationPolicy = {
  authority: "api";
  authorizationMode: MutationAuthorizationMode;
  risk?: MutationRiskTier;
  reason?: string;
};
```

O formato final deve evitar duplicar a decisão da API.

A política retornada ao TurnResult deve refletir a decisão autoritativa, não prever arbitrariamente o resultado antes da resolução.

---

# 22. Tool registry

O atual:

```text
approvalRequired: true
```

de `transactions.expense.create` e `transactions.income.create` deve deixar de significar confirmação humana obrigatória.

Evoluir para algo semanticamente equivalente a:

```text
authorization: risk_based
autoExecutionEligible: true
```

Não fazer rename massivo de todo o projeto apenas por estética.

Preservar compatibilidade enquanto possível.

---

# 23. Ferramentas destrutivas

`apps/agent/src/safety/tool-approvals.ts` continua sendo guardrail.

Ferramentas como:

```text
pay_statement
pay_payable
mark_account_paid
unpay_payable
cancel_payable
cancel_account_payable
cancel_goal
deactivate_account
deactivate_category
cancel_card_purchase
delete_transaction
```

continuam exigindo confirmação manual.

Não expandir autoexecução para essas tools nesta SPEC.

---

# 24. Observabilidade

Adicionar eventos sanitizados equivalentes a:

```text
mutation.authorization.evaluated
mutation.autoauthorized
mutation.manual_confirmation_required
mutation.clarification_required
mutation.autoexecute.succeeded
mutation.autoexecute.blocked
```

Dimensões permitidas:

- tool;
- risk tier;
- decision;
- reason;
- status.

Evitar logar:

- prompt completo;
- token;
- attestation;
- credenciais;
- valores financeiros brutos quando desnecessários.

Métricas importantes:

```text
auto-execute rate
clarification rate
manual-confirmation rate
possible-duplicate rate
autoexecute failure rate
execution-uncertain rate
undo-after-autoexecute rate
```

`undo-after-autoexecute` é um sinal útil para avaliar falsos positivos da política.

---

# 25. Shadow mode

Antes de habilitar autoexecução em produção, criar:

```text
TED_RISK_BASED_AUTOEXECUTE=off
```

e um modo shadow equivalente.

No shadow:

```text
policy = AUTO_EXECUTE
```

mas o comportamento real continua:

```text
manual confirmation
```

Registrar somente a decisão hipotética.

Isso permite validar:

- quantas operações seriam executadas automaticamente;
- quantas posteriormente foram canceladas;
- quantas geraram Undo;
- divergências.

Nenhuma escrita extra deve ser realizada pelo shadow.

---

# 26. Rollout

Etapas:

```text
OFF
↓
SHADOW
↓
CANARY LOW-RISK
↓
LOW-RISK 100%
```

Não ativar HIGH ou DESTRUCTIVE automaticamente.

Um kill switch deve retornar o sistema imediatamente ao comportamento atual.

---

# 27. Testes obrigatórios

Cobrir pelo menos:

### Policy

- R$ 35 explícito → low/auto.
- R$ 499,99 → low/auto.
- R$ 500 → high/manual.
- R$ 2.000 → high/manual.
- destrutivo → manual.
- tool fora da allowlist → manual.
- possível duplicate → não auto.
- missing field → clarify.
- entidade ambígua → clarify.
- intenção não explícita → não auto.

### Security

- modelo não pode escolher `auto_execute`;
- browser não pode enviar capability auto;
- workspace mismatch → 403;
- actor mismatch → 403;
- device mismatch → 403;
- operação expirada → falha;
- attestation replay → falha;
- autoauthorization em tool destrutiva → falha.

### Idempotência

Redelivery do mesmo:

```text
"Registre R$ 35..."
```

com mesmo intention/message id deve produzir exatamente uma transação.

### Outcome uncertainty

Simular:

```text
write committed
response lost
```

e provar:

```text
1 efeito financeiro
status executing/reconciliation
nenhuma segunda transação
```

### Conversation

- pergunta somente campo faltante;
- continuação de draft funciona;
- nova intenção substitui draft antigo corretamente;
- múltiplos drafts geram disambiguation;
- memória nunca concede autorização.

### PWA/E2E

Cenário 1:

```text
R$35 explícito
→ sem ApprovalCard
→ transação aparece
→ receipt válido
→ Undo disponível
```

Cenário 2:

```text
R$1000
→ ApprovalCard
→ nenhuma escrita antes da confirmação
```

Cenário 3:

```text
dados incompletos
→ pergunta
→ nenhuma PendingOperation executável
```

Cenário 4:

```text
possible duplicate
→ nenhuma autoexecução
```

---

# 28. Arquivos prováveis

API:

```text
apps/api/src/approvals/policy.ts
apps/api/src/approvals/tool-registry.ts
apps/api/src/approvals/pending-v2.ts
apps/api/src/routes/pending-operations.ts
apps/api/src/auth/delegated-token.ts
apps/api/src/audit/events.ts
apps/api/src/read-models/sql/V059__pending_operation_authorization.sql
```

Agent:

```text
apps/agent/src/orchestration/conversation-orchestrator.ts
apps/agent/src/orchestration/intent-router.ts
apps/agent/src/orchestration/pending-operation-coordinator.ts
apps/agent/src/mutations/mutation-api-client.ts
apps/agent/src/mutations/mutation-executor.ts
apps/agent/src/safety/tool-approvals.ts
apps/agent/src/finance-chat-agent.ts
apps/agent/src/agent-config/instructions.ts
```

PWA:

```text
apps/pwa/src/features/ted/TedChat.tsx
apps/pwa/src/features/ted/TedApprovalCard.tsx
apps/pwa/src/lib/api/agent-client.ts
```

Shared:

```text
packages/llm-contracts/
```

Documentação:

```text
docs/ARCHITECTURE-CURRENT.md
docs/ARCHITECTURE-TARGET.md
docs/ROADMAP.md
docs/adr/
CHANGELOG.md
AGENTS.md
```

O agente deve validar caminhos reais antes de editar. (Validado em
2026-10-02: todos existem; diretório real de migrations é
`apps/api/src/read-models/sql/`, topo `V058__account_initial_balance_anchor.sql`.)

---

# 29. Nova ADR

Criar ADR específica:

```text
ADR-026 — Risk-Based Mutation Authorization
```

Deve registrar:

- API continua autoridade;
- confirmação humana ≠ autorização técnica;
- autoexecução só ocorre por policy determinística;
- LLM nunca concede autorização;
- PendingOperation continua obrigatória;
- autoexecução começa apenas em transaction create;
- destructive permanece manual;
- shadow/canary/kill-switch.

---

# 30. Critérios de aceite

A implementação somente pode ser considerada concluída quando:

1. uma despesa explícita de baixo risco puder ser registrada sem confirmação manual;
2. a mesma operação continuar passando por PendingOperation + API + receipt;
3. R$500 ou mais continuar exigindo confirmação;
4. ferramentas destrutivas continuarem exigindo confirmação;
5. ambiguity/missing data nunca causar autoexecução;
6. duplicate suspicion bloquear autoexecução;
7. memória não puder conceder autoridade;
8. redelivery não criar duplicata;
9. outcome incerto continuar protegido pelo lease/reconciliation;
10. cross-workspace/device attacks falharem fechado;
11. PWA reconciliar sucesso pelo receipt;
12. Undo permanecer separado e protegido;
13. shadow mode funcionar sem efeito financeiro adicional;
14. kill switch restaurar o comportamento anterior;
15. todos os testes novos começarem RED e terminarem GREEN;
16. suites completas da API, Agent, PWA e integração PostgreSQL passarem;
17. architecture/security checks passarem;
18. documentação e ADR serem atualizadas;
19. revisão independente não encontrar P0/P1;
20. nenhuma alteração enfraquecer os invariantes V3/V4/V4.1 existentes.

---

# 31. Resultado esperado

Antes:

```text
Usuário
"Registre R$35 de almoço."

TED
"Confirma?"
```

Depois:

```text
Usuário
"Registre R$35 de almoço no Nubank."

TED
"Despesa de R$35,00 em Alimentação registrada no Nubank."

[Desfazer]
```

Mas internamente:

```text
explicit actor intent
      ↓
canonical resolution
      ↓
PendingOperation
      ↓
API risk policy
      ↓
auto authorization
      ↓
attestation
      ↓
MutationExecutor
      ↓
idempotent WriteStore
      ↓
PostgreSQL
      ↓
MutationReceipt
```

A experiência fica mais inteligente.

A arquitetura continua segura.
