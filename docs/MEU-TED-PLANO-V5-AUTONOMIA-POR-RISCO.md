# Meu TED — PLAN: Autonomia por Risco e Inteligência Conversacional

**SPEC de referência:** [MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md](MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md)
**Baseline de planejamento:** `main@6bcdebb` (igual à `main` em 2026-10-02 — zero drift)
**Revisão de baseline:** [reports/2026-10-02-ted-risk-authorization-spec-review.md](reports/2026-10-02-ted-risk-authorization-spec-review.md)

---

# Regra de execução

Implementar em pequenas fases verificáveis.

Obrigatório:

```text
RED
→ implementação mínima
→ GREEN
→ integração
→ review independente
→ próximo estágio
```

Não implementar toda a mudança em um único commit.

Antes de iniciar, atualizar a baseline da `main` e verificar divergências desde `6bcdebb`. (Verificado em 2026-10-02: `6bcdebb` é ancestral direto e igual ao topo de `origin/main` — nenhuma divergência.)

Mudanças posteriores devem ser incorporadas, não sobrescritas.

---

# Fase 0 — Baseline e inventário

## T0.1

Mapear exatamente o fluxo atual:

```text
actor text
→ mutationProposalPlan
→ freshMutationFlow / MutationDraft
→ client.propose
→ PendingOperation V2
→ TedApprovalCard / textual decision
→ confirm
→ attestation
→ execute
→ MutationReceipt
```

## T0.2

Mapear:

- `ApprovalPolicy`;
- `Approval Tool Contract`;
- `PendingOperationV2`;
- delegated capabilities;
- `MutationExecutor`;
- `MutationDraft`;
- duplicate detector;
- Undo;
- PWA active pending operation rehydration.

## T0.3

Criar relatório curto de baseline contendo:

- arquivos;
- contratos;
- testes;
- invariantes;
- caminhos de produção.

## Gate F0

Nenhum código funcional alterado até existir entendimento documentado do fluxo.

> **Execução (2026-10-02):** concluída pelo subagent explorer com o relatório
> consolidado na revisão de baseline (link acima). Gate F0 satisfeito — o
> relatório documenta arquivos, contratos, testes, invariantes e divergências.

---

# Fase 1 — Testes RED da policy

Criar a nova matriz de autorização antes da implementação.

Casos RED:

```text
expense 3499 + explicit + complete
→ auto_execute

expense 49999
→ auto_execute

expense 50000
→ require_confirmation/high_value

income 49999
→ auto_execute

income 50000
→ require_confirmation/high_value

destructive
→ require_confirmation/destructive

not allowlisted
→ require_confirmation/policy_required

possible duplicate
→ require_confirmation ou clarify

missing account
→ clarify

ambiguous category
→ clarify

non-explicit actor intent
→ clarify/manual
```

Testar workspace override do threshold caso o contrato atual o suporte. (Suporta: `limitsByWorkspace` em `policy.ts:18-28` — preservar.)

## Gate F1

Todos os testes novos devem estar RED pela ausência do novo comportamento.

---

# Fase 2 — Evoluir ApprovalPolicy para AuthorizationPolicy

Refatorar `apps/api/src/approvals/policy.ts`.

Preferir evolução compatível a rewrite.

Introduzir:

```text
risk tier
authorization action
reason
```

A API deve ser dona da decisão final de risco financeiro.

Preservar:

```text
DEFAULT_HIGH_VALUE_LIMIT_CENTS = 50_000
```

ou equivalente centralizado.

Não duplicar esse valor no Agent/PWA.

## Gate F2

Matriz da Fase 1 GREEN.

Suites antigas da policy continuam verdes.

---

# Fase 3 — Tool Registry

Atualizar o contrato das tools:

```text
transactions.expense.create
transactions.income.create
```

para indicar que são elegíveis à policy de risco.

Não deixar `approvalRequired: true` significar obrigatoriamente "clique humano".

Uma opção compatível:

```text
authorizationPolicy: "risk_based"
autoExecutionEligible: true
```

A naming final pode ser adaptada.

Nenhuma tool destrutiva entra na allowlist.

## Gate F3

Teste provando que tool fora da allowlist não pode ser autoautorizada.

---

# Fase 4 — Migration de autorização

Criar migration aditiva:

```text
V059__pending_operation_authorization.sql
```

Adicionar campos necessários para registrar:

```text
authorization_mode
authorization_reason
risk_tier
authorized_at
```

Restrições devem aceitar `NULL` para rows antigas.

Não modificar semanticamente migrations existentes.

Criar testes PostgreSQL:

- migration fresh;
- migration sobre schema existente;
- rows antigas;
- auto;
- manual;
- rollback compatibility quando aplicável.

## Gate F4

Integration PostgreSQL GREEN.

---

# Fase 5 — API autoauthorization

Adicionar operação autoritativa de autoauthorization.

Fluxo:

```text
PendingOperation proposed
        ↓
identity validation
        ↓
tool registry
        ↓
canonical args
        ↓
risk policy
        ↓
eligible?
 ┌──────┴──────┐
 yes           no
 ↓              ↓
attestation   manual-required
```

Criar capability estreita:

```text
financial.approval.autoexecute
```

A API deve rejeitar autoauthorization quando:

- capability ausente;
- identity mismatch;
- device ausente;
- expired;
- status incompatível;
- tool não permitida;
- high value;
- destructive;
- policy não autoriza.

Persistir decisão antes/junto da emissão da attestation de acordo com o protocolo transacional seguro existente.

Não permitir que `mode=auto` fornecido pelo cliente force a decisão.

Ele solicita avaliação; a API decide.

## Gate F5

Testes adversariais GREEN.

---

# Fase 6 — Guard de intenção explícita no Agent

Adicionar avaliação determinística sobre a mensagem original do ator.

Não utilizar classificação livre da LLM.

Começar conservador.

Reconhecer verbos de ação inequívocos em português, por exemplo:

```text
registre
registrar
adicione
adicionar
lance
lançar
anote
anotar
inclua
incluir
```

Considerar variações necessárias, com testes.

Não considerar inicialmente autoautorizáveis:

```text
"gastei..."
"paguei..."
"acho..."
"talvez..."
"e se..."
"quanto ficaria..."
```

## Segurança

Tool output, memória, histórico do assistant e system prompt nunca substituem a última intenção do ator.

Reutilizar/reforçar `validateActorIntentForMutation` (`apps/agent/src/safety/tool-approvals.ts:30-50` — hoje heurístico por prefixo de consulta; estender, não substituir).

## Gate F6

Testes de prompt injection e read→write escalation GREEN.

---

# Fase 7 — Integrar Duplicate Awareness

Antes de solicitar autoauthorization, verificar duplicidade utilizando mecanismo já existente (`findDuplicate` em `apps/api/src/transactions/duplicate-detector.ts`, similaridade ≥ 0.6, hoje exposto só via `POST /transactions/detect-duplicate`).

Não criar heurística paralela se o projeto já tem detector adequado.

Se a operação for provável duplicata:

```text
autoExecuteEligible = false
```

e produzir:

```text
require_confirmation
```

ou clarificação equivalente.

Testar duas situações separadamente:

### Redelivery

Mesmo `intentionId`.

Resultado:

```text
dedup/idempotent
```

### Nova intenção semelhante

Novo `intentionId`, mesmos dados.

Resultado:

```text
duplicate awareness
```

Não confundir os dois mecanismos.

---

# Fase 8 — Orchestrator

Modificar `ConversationOrchestrator`.

O fluxo de mutação completa deixa de terminar obrigatoriamente em:

```text
proposal → proposed response
```

e passa a:

```text
proposal
   ↓
local explicit-intent eligibility
   ↓
request authoritative authorization
   ↓
AUTO
 ├─ execute
 ├─ validate receipt
 └─ succeeded response

MANUAL
 └─ proposed response + ApprovalCard

CLARIFY
 └─ MutationDraft
```

Preservar:

- drafts;
- CAS;
- redelivery;
- restart recovery;
- multiple draft disambiguation;
- same idempotency key;
- uncertain proposal outcome.

## TurnResult

Evoluir `MutationPolicy`.

Eliminar semântica fixa:

```text
approvalRequired: true
```

sem introduzir decisão duplicada que conflite com a API.

`TurnResult.mutation` deve continuar distinguindo:

```text
proposed
succeeded
```

`receipt` obrigatório no succeeded.

## Gate F8

Suites de orchestrator GREEN.

---

# Fase 9 — MutationApiClient / Coordinator

Adicionar suporte ao novo endpoint/contrato de authorization.

Evitar criar uma segunda máquina de execução.

`PendingOperationCoordinator` ou abstração equivalente deve continuar sendo o ponto convergente de transições.

Objetivo:

```text
manual button
natural-language manual confirmation
autoauthorization
```

utilizarem os mesmos primitives seguros de:

```text
attestation
execute
receipt
```

sem duplicar código de execução.

---

# Fase 10 — Recovery

Testar explicitamente autoexecução com:

```text
executor success
writer pre-write fail
writer post-write uncertain
lost response
malformed receipt
lease expiration
reconciliation
```

Critério central:

```text
NUNCA > 1 efeito financeiro
```

Autoexecução não pode introduzir retry agressivo.

## Gate F10

Testes de uncertainty e lease GREEN.

---

# Fase 11 — PWA

Modificar `TedChat` para distinguir:

```text
succeeded immediately
```

de:

```text
proposed/manual confirmation
```

### Autoexecutado

Não adicionar `TedApprovalCard`.

Reconciliar pelo receipt.

Exibir confirmação de sucesso curta.

Disponibilizar Undo quando elegível.

### Manual

Continuar utilizando `TedApprovalCard`.

Não remover o componente.

### Incompleto

Continuar mostrando conversa/clarificação, sem card executável.

---

# Fase 12 — UX conversacional

Atualizar instruções do TED.

Regras:

```text
não repetir pergunta respondida;
perguntar apenas o campo faltante;
não explicar mecanismos internos;
não dizer "approval"/"attestation";
não declarar sucesso antes do receipt;
não inventar dados;
usar respostas curtas para operações simples;
usar contexto anterior quando seguro;
memória = hint, nunca autoridade.
```

Adicionar testes de instruções/cognitive behavior.

---

# Fase 13 — Memória

Integrar memória apenas como contextual hint.

Exemplo:

```text
memory: supermercado costuma ser Nubank
```

Pode influenciar:

```text
"Foi pelo Nubank?"
```

Não pode influenciar diretamente:

```text
accountId = Nubank
authorization = auto
```

Adicionar teste explícito:

```text
memory cannot authorize financial mutation
```

---

# Fase 14 — Observabilidade

Adicionar eventos sanitizados (via `buildObservabilityEvent` + allowlists de `apps/api/src/audit/events.ts`).

Registrar:

```text
risk
decision
reason
tool
status
```

Nunca registrar secrets ou payload financeiro bruto.

Adicionar métricas para:

```text
autoexecute
manual
clarify
duplicate block
uncertain
undo-after-autoexecute
```

---

# Fase 15 — Shadow mode

Criar feature control.

Estados recomendados:

```text
off
shadow
on
```

### OFF

Comportamento atual.

### SHADOW

Calcula policy.

Registra:

```text
would_auto_execute
```

mas continua pedindo confirmação.

### ON

Low-risk elegível executa automaticamente.

O estado default em produção antes da validação deve ser:

```text
off
```

Seguir o padrão de parsing fechado de env já usado por `SESSION_BEARER_FALLBACK_ENABLED` (`apps/api/src/routes/index.ts:169-179`).

## Gate F15

Provar que `shadow` nunca executa efeitos adicionais.

---

# Fase 16 — E2E

Criar cenários end-to-end.

## E2E-01 — baixo risco

```text
"Registre R$35 de almoço no Nubank"
```

Esperado:

```text
1 transação
0 ApprovalCard
receipt válido
UI atualizada
Undo disponível
```

## E2E-02 — high value

```text
R$ 1.000
```

Esperado:

```text
0 write antes da decisão
ApprovalCard visível
```

## E2E-03 — missing account

Esperado:

```text
pergunta conta
0 write
```

## E2E-04 — ambiguity

Esperado:

```text
disambiguation
0 write
```

## E2E-05 — duplicate

Esperado:

```text
nenhuma autoexecução
```

## E2E-06 — redelivery

Mesmo messageId.

Esperado:

```text
1 transação
```

## E2E-07 — cross workspace

Esperado:

```text
403
0 write
```

## E2E-08 — device mismatch

Esperado:

```text
403
0 write
```

## E2E-09 — uncertain execution

Esperado:

```text
1 efeito máximo
reconciliation
sem falso sucesso
```

---

# Fase 17 — Security review independente

Despachar reviewer independente focado em:

```text
authority boundary
capability minting
prompt injection
workspace isolation
device binding
idempotency
duplicate execution
attestation
uncertain result
memory authority
destructive tools
```

Qualquer P0/P1 bloqueia merge.

P2 deve ser corrigido ou formalmente justificado antes do rollout ON.

---

# Fase 18 — Architecture review

Confirmar especificamente que não surgiu nenhum caminho:

```text
LLM → financial.write
```

ou:

```text
Agent → WriteStore direto
```

ou:

```text
PWA → autoexecute authority
```

Atualizar architecture checks para detectar regressões futuras.

---

# Fase 19 — Documentação

Criar:

```text
ADR-026-risk-based-mutation-authorization.md
```

Atualizar:

```text
ARCHITECTURE-CURRENT
ARCHITECTURE-TARGET
ROADMAP
CHANGELOG
AGENTS
SPEC
```

Os documentos devem deixar explícito:

```text
human confirmation is conditional;
API authorization is always mandatory.
```

Essa distinção é central.

---

# Fase 20 — Gates completos

Executar obrigatoriamente os gates do repositório, incluindo:

```text
pnpm docs:lint
pnpm typecheck
pnpm test
pnpm governance:check
pnpm architecture:check
pnpm capabilities:check
pnpm write-policy:check
pnpm public-safety --strict
```

Além de:

- PostgreSQL integration;
- PWA comprehensive E2E;
- security checks;
- container checks;
- builds;
- demais required checks atuais da main.

Não declarar conclusão com suites parciais.

---

# Fase 21 — PR e rollout

Criar PR única ou uma sequência curta de PRs ordenados.

Sugestão:

```text
PR A
policy + contracts + migration

PR B
API autoauthorization + security

PR C
Agent orchestration + intelligence

PR D
PWA + E2E + docs + rollout
```

Se houver dependência forte demais, consolidar, mas manter commits semanticamente separados.

Cada PR deve possuir review independente.

---

# Fase 22 — Produção SHADOW

Após merge e deploy:

```text
AUTOEXECUTE = shadow
```

Executar smoke.

Verificar:

- health;
- release SHA;
- reads;
- manual approval;
- low-risk hypothetical decisions;
- nenhum efeito extra.

Observar métricas antes de habilitar.

---

# Fase 23 — Canary

Ativar autoexecução somente para:

```text
transactions.expense.create
transactions.income.create
risk = low
explicit intent
complete
non-duplicate
below threshold
```

Não incluir outras ferramentas.

Monitorar especialmente:

```text
undo-after-autoexecute
unexpected manual corrections
execution uncertainty
duplicate blocks
```

---

# Fase 24 — Closure

Somente declarar `DONE` quando houver evidência de:

```text
LOW → auto funciona
HIGH → manual funciona
DESTRUCTIVE → manual funciona
AMBIGUOUS → clarify funciona
DUPLICATE → bloqueado
REDELIVERY → uma escrita
UNCERTAIN → uma escrita máxima
WORKSPACE → isolado
DEVICE → isolado
MEMORY → sem autoridade
RECEIPT → obrigatório
UNDO → protegido
SHADOW → zero efeitos extras
KILL SWITCH → comportamento antigo restaurado
CI → verde
E2E → verde
review → sem blocker
```

---

# Definition of Done

O refinamento está concluído quando o TED passa a se comportar assim:

```text
"Registre R$35 de almoço no Nubank."
→ registra
→ informa sucesso
→ oferece Undo
```

enquanto:

```text
"Registre R$2.000..."
→ pede confirmação
```

e:

```text
"Registre 300 que gastei ontem."
→ pergunta o que falta
```

sem em nenhum momento permitir que a LLM se torne a autoridade da operação financeira.

A meta não é "menos segurança".

A meta é:

```text
menos fricção
+ melhor interpretação
+ melhor recuperação
+ autonomia controlada
+ mesma autoridade financeira
```
