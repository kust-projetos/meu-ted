# Revisão da SPEC/PLAN V5 — Autonomia por Risco e Inteligência Conversacional

**Data:** 2026-10-02
**Baseline:** `main@6bcdebb` (topo de `origin/main` no dia — zero drift; `6bcdebb` é ancestral direto)
**SPEC revisada:** [../MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md](../MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md)
**PLAN revisado:** [../MEU-TED-PLANO-V5-AUTONOMIA-POR-RISCO.md](../MEU-TED-PLANO-V5-AUTONOMIA-POR-RISCO.md)
**Método:** inventário read-only da Fase 0 por subagent explorer independente + leitura direta dos arquivos críticos pelo Planner (`policy.ts`, `tool-registry.ts`, `provider-adapter.ts`, `lint-docs.mjs`, CHANGELOG, ADR-021, `package.json`). Gate de risco da ação registrado no Jev (`recommendation: confirm`, score 2.27, prob. de tocar produção 0.62 — rollout shadow-first confirmado como obrigatório).

---

## Veredito

**APROVADA COM AJUSTES — implementação autorizada.**

A SPEC é arquiteturalmente sólida: preserva todas as fronteiras V2/V3/V4/V4.1
(API autoritativa, PendingOperation obrigatória, attestation, receipt,
lease/reconciliation, idempotência, binding triplo) e adiciona apenas uma
política determinística de risco + um caminho de autoautorização próprio.
Nenhum invariante proposto conflita com ADR-010/012/013/014/021. Os ajustes
abaixo são de precisão técnica e sequenciamento, não de direção.

---

## Findings

### F-01 — `approvalRequired` é declarativo, não operacional (MÉDIO, ajuste de expectativa)

A SPEC §1/§22 assume que `approvalRequired: true` no registry é o mecanismo
que força confirmação. A leitura do código mostra que o campo **não é
consumido operacionalmente pela API**: o enforcement real é o fluxo V2 — toda
mutação passa obrigatoriamente por `propose → confirm → attestation →
execute` — e pelas capabilities por rota (`financial.approval.propose/read/
confirm/execute/reconcile/retry/cancel` em
`apps/api/src/routes/pending-operations.ts:23-31,73-78`).

**Consequência:** a evolução real não é "trocar o valor do campo", e sim
adicionar (a) política de risco determinística na API e (b) um caminho de
autoautorização que reavalie a policy server-side. O campo permanece como
metadado (`approvalRequired` mantido por compat + novos campos `authorizationPolicy`
e `autoExecutionEligible`), e o teste de contrato que compara as chaves exatas
(`apps/api/tests/approvals/tool-registry.test.ts:95`) é atualizado junto (RED→GREEN).

### F-02 — INV-03 (LLM não autoriza) já tem base de código forte (POSITIVO)

`apps/agent/src/orchestration/provider-adapter.ts:19-30` rejeita
(`agent.invalid_provider_output`) qualquer campo de autoridade no output do
provedor — incluindo `capability`, `workspaceId`, `actorId`, `deviceId`,
`idempotencyKey`, `attestation`, `writeAuthorized`, `approvalRequired` — e
`validateProviderOutput` força sempre
`policy = { capability: 'financial.read', writeAuthorized: false,
approvalRequired: true }`. **Ação:** estender o conjunto
`forbiddenAuthorityFields` com os novos campos de decisão (`risk`,
`authorizationMode`, `autoExecute`, `decision`, `reason`, `authorize` etc.)
para que a evolução da MutationPolicy nunca abra superfície ao modelo.

### F-03 — Capability e endpoint de autoautorização não existem (trabalho novo, sem colisão)

Não há `financial.approval.autoexecute` nem rota `authorize`. Capabilities
existentes do V2: `financial.approval.propose/read/confirm/execute/reconcile/
retry/cancel`. O delegated token (`apps/api/src/auth/delegated-token.ts`)
aceita strings de capability com binding assinado workspace/actor/device e TTL
300s — a nova capability segue o mesmo mecanismo. O inventário de capabilities
é verificado por `pnpm capabilities:check`
(`scripts/check-tool-capability-inventory.mjs`) — deve ser atualizado quando a
capability for introduzida (PR B).

### F-04 — `confirm` emite attestation; `authorize` deve reusar a mesma máquina (ALTO, requisito de design)

O caminho `POST /pending-operations/v2/:id/confirm` valida presentation e
delega ao `PendingOperationV2Store.confirm`, que emite attestation consumida
pelo `execute`. A autoautorização (SPEC §10) NÃO pode fingir um clique: deve
ser um método/rota próprio (`authorize` com `mode: 'auto'`) que reutilize os
mesmos primitivos de transição/attestation/execute, persistindo
`authorization_mode = 'auto'` — nunca registrando auto como confirmação
manual. Estados V2 (`proposed/confirmed/executing/succeeded/failed/cancelled/
expired`), lease (60s default) e TTL de proposta (30min) já dão conta da
semântica; nenhum estado novo é necessário.

### F-05 — Duplicate detector existe, mas roda fora do fluxo de proposta (MÉDIO)

`findDuplicate` (`apps/api/src/transactions/duplicate-detector.ts`, limiar de
similaridade 0.6) hoje só é alcançável via `POST /transactions/detect-duplicate`.
A Fase 7 é integração real: a avaliação de risco server-side (no
propose/authorize) deve consultar o detector existente — sem heurística
paralela — e bloquear autoexecução em caso de suspeita. Redelivery (mesma
idempotency key) continua sendo tratado pela idempotência, mecanismo distinto.

### F-06 — Guard de intenção explícita atual é heurístico por prefixo (MÉDIO)

`validateActorIntentForMutation`
(`apps/agent/src/safety/tool-approvals.ts:30-50`) bloqueia mutação quando a
última mensagem do ator começa com padrões de consulta; caso contrário,
permite. Ele nunca foi autoridade — a aprovação é da API. A Fase 6 estende
esse guard com verbos de mutação explícita (registre/adicione/lance/anote/
inclua e variações) usados APENAS como pré-filtro conservador para solicitar
autoautorização; a API reavalia risco com dados objetivos e decide sozinha.

### F-07 — Threshold por workspace já suportado (POSITIVO)

`createApprovalPolicy` já aceita `highValueLimitCents` e `limitsByWorkspace`
(`policy.ts:18-28`) com `DEFAULT_HIGH_VALUE_LIMIT_CENTS = 50_000`. A matriz
RED deve cobrir o override. O valor não pode ser duplicado no Agent/PWA.

### F-08 — Undo é serviço separado fora de V2 (ADR-021) — SPEC alinhada (POSITIVO)

A SPEC §18 não autoexecuta Undo e o trata como operação sensível separada —
consistente com ADR-021 (undo com proposta própria, CAS, `financial.undo.execute`,
nunca tool do modelo). A métrica `undo-after-autoexecute` cruza dois serviços;
instrumentar nos dois lados (agente registra o link operationId→undoRequest).

### F-09 — Recuperação/lease já existentes cobrem a Fase 10 (POSITIVO)

`approval.execution_uncertain` (`tool-registry.ts:73-93`) mantém a operação em
`executing` sem persistir `failed` e sem retry; reconciliação reexecuta a
MESMA idempotency key após lease vencido; rotas `/reconcile` e `/expire`
existem. Autoexecução não introduz nenhum mecanismo novo — apenas não pode
adicionar retry agressivo.

### F-10 — Migração V059 aditiva é segura (POSITIVO)

Migrations vivem em `apps/api/src/read-models/sql/` (topo atual:
`V058__account_initial_balance_anchor.sql`), aplicadas por
`apps/api/src/scripts/migrate.ts` (`pnpm --filter meu-ted-api db:migrate`),
com schema canônico via `DB_SCHEMA=canonical`. Quatro colunas nullable são
backward compatible; testes PG existentes em `apps/api/tests/approvals/pending-postgres.test.ts`
e `tests/integration/` servem de padrão.

### F-11 — Observabilidade tem contrato rígido (POSITIVO, requisito)

`apps/api/src/audit/events.ts` valida eventos com allowlists por tipo
(`OBSERVABILITY_EVENT_TYPES`, `buildObservabilityEvent`) e sanitização
recursiva que rejeita credenciais/tokens/valores financeiros completos
(`ObservabilityPrivacyError`). Os novos eventos
(`mutation.authorization.evaluated`, `mutation.autoauthorized`, etc.) devem ser
registrados nas allowlists com dimensões mínimas (tool, risk tier, decision,
reason, status).

### F-12 — Flag de rollout segue padrão existente (INFORMATIVO)

Padrão canônico: parsing fechado de env com default documentado e testes para
valores ausentes/off (ex.: `SESSION_BEARER_FALLBACK_ENABLED` em
`apps/api/src/routes/index.ts:169-179`). `TED_RISK_BASED_AUTOEXECUTE`
(`off|shadow|on`, default `off`) segue o mesmo padrão na API e no Agent.

### F-13 — Governança de merge/deploy (INFORMATIVO)

Branch protection exige `Gate — all checks` + `quality`; push direto a `main`
é recusado. Deploy de API é pelo fluxo autorizado (wrapper na VPS, rollback
tags); PWA/Agent via Cloudflare (workflows). Deploy somente depois do
feature-set completo (Fase 22), nunca por PR intermediário.

---

## Decisões

- **D-01 — Ordem de PRs:** PR A (policy + registry + contratos + migration V059 + ADR-026) → PR B (endpoint authorize + capability + persistência + security) → PR C (Agent: guard de intenção explícita, coordinator, MutationPolicy evolutiva) → PR D (PWA + E2E + observabilidade + rollout + docs canônicos). Cada PR com review independente.
- **D-02 — Divisão de autoridade na decisão de risco:** a API decide com dados objetivos (tool allowlist, amount, destructive, duplicidade server-side, completude dos args canônicos). A "intenção explícita" é avaliada por código determinístico no Agent (pré-filtro para solicitar autoautorização) e NUNCA viaja como autoridade; a API nunca autoexecuta por conta própria sem solicitação com capability estreita.
- **D-03 — `authorize` ≠ `confirm`:** rota/método próprio que reusa os primitivos de transição + attestation + execute, persistindo `authorization_mode='auto'` com `authorization_reason` e `risk_tier`; confirmação manual continua registrando `manual`.
- **D-04 — Compatibilidade:** campos novos são aditivos; `approvalRequired` mantido; nenhum rename massivo; testes de contrato atualizados no mesmo PR (RED→GREEN).
- **D-05 — Shadow é obrigatório antes de ON:** default `off`; shadow registra decisão hipotética sem efeito; kill switch = voltar a flag para `off`.
- **D-06 — Revisão da SPEC documentada:** os ajustes desta revisão foram anotados na própria SPEC (notas de revisão §1, §28 e cabeçalho) e no PLAN (notas de execução da Fase 0).

## Ajustes ao plano original

- **A-01 (F2):** preservar `createApprovalPolicy` e adicionar a API de decisão rica no mesmo módulo (evolução compatível, não rewrite).
- **A-02 (F3):** o teste `tool-registry.test.ts:95` compara chaves exatas do contrato — atualizá-lo faz parte do ciclo RED→GREEN, não é "quebra acidental".
- **A-03 (F6):** estender `validateActorIntentForMutation` (prefixos de consulta + verbos de mutação explícita), mantendo o guard conservador e não-autoritativo.
- **A-04 (F7):** integrar `findDuplicate` existente na avaliação server-side; provar redelivery ≠ duplicata com testes separados.
- **A-05 (F15):** parsing de flag no padrão `SESSION_BEARER_FALLBACK_ENABLED`.
- **A-06 (F20):** `capabilities:check` e `architecture:check` precisam ser atualizados quando a nova capability/rota entrarem (PR B em diante).

## Riscos residuais

- **R-01:** ampliar `forbiddenAuthorityFields` exige sincronia com a evolução da MutationPolicy do orchestrator (PR C) — risco de falso positivo ao validar planos; mitigar com testes do provider-adapter.
- **R-02:** a integração do detector de duplicados no caminho autoritativo adiciona latência ao propose; aceitável (busca por workspace + janela recente), monitorar.
- **R-03:** UX sem ApprovalCard muda o rehydration do histórico (§25.4 da SPEC V3: cards rehydratam de estado server-attached); o PR D precisa cobrir reload com operação autoexecutada.
- **R-04:** execução local de integração PostgreSQL depende de PG descartável disponível; se indisponível, a validação fica a cargo do CI required — nunca declarar GREEN parcial.

## Go/No-Go

**GO** para implementação faseada a partir do PR A, sob as regras de execução
do PLAN (RED→GREEN por fase, gates F0–F24, review independente por PR, shadow
obrigatório antes de ON, deploy somente na Fase 22).
