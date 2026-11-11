# V1 — Reconciliação funcional e plano de execução

**Data:** 2026-11-10  
**Base observada:** `main@a9ace19` (o commit `e3ede0b` citado na missão é ancestral)  
**Escopo:** concluir pendências funcionais da V1 no caminho OpenCode-first, sem
reabrir arquitetura.

## 1. Estado real do checkout

| Item | Estado observado |
|---|---|
| Branch | `main`, 2 commits à frente de `origin/main` (`e9f7d8e`, `a9ace19` — Better Auth) |
| Alteração local preservada | `apps/agent/src/finance-chat-agent.ts` (roteamento de compra no cartão, não commitada) |
| `apps/ted-runtime` | SDK OpenCode 2.2.4; 14 ferramentas no catálogo |
| Flags | `TED_OPENCODE_P3_READS_ENABLED` / `TED_OPENCODE_P3_WRITES_ENABLED`; `TED_PRIVATE_VIEWS_ENABLED` |
| Pending V2 | 12 tools em `APPROVAL_TOOL_IDS`; payables ausentes |
| CI/produção | Não reexecutados nesta sessão; sem deploy |

## 2. Ferramentas OpenCode — estado antes desta execução

### Leituras (14 definidas; 7 expostas no opt-in de leitura)

| Domínio | Ferramenta | Estado |
|---|---|---|
| Contas | `list_accounts` | IMPLEMENTADO (default) |
| Dashboard | `get_month_summary` | IMPLEMENTADO (default) |
| Categorias | `list_categories` | IMPLEMENTADO (opt-in leitura) |
| Cartões | `list_credit_cards` | IMPLEMENTADO (opt-in leitura) |
| Faturas | `list_card_statements` | IMPLEMENTADO (opt-in leitura) |
| Transações | `list_recent_transactions` | IMPLEMENTADO (opt-in leitura) |
| Insights | `spending_insights` | IMPLEMENTADO (opt-in leitura) |
| Analytics | KPIs, breakdown, fluxo de caixa, consumo de orçamento, patrimônio | **FALTA** |
| Orçamentos | listar, limites, tendências | **FALTA** |
| Metas | listar/progresso | **FALTA** |
| Contas a pagar | listar/vencimentos/lembretes | **FALTA** |
| Auditoria | histórico/recibos | **FALTA** |

### Escritas por proposta (7)

`propose_expense`, `propose_income`, `propose_card_purchase`,
`propose_transfer`, `propose_statement_payment`, `propose_account_create`,
`propose_category_create` — todas já ligadas ao broker do Agent e ao Pending V2.

### Escritas aprovadas ausentes no OpenCode

`transactions.update` (descrição), `accounts.update`, `accounts.deactivate`,
`categories.update`, `categories.deactivate` — contrato Pending V2 **existe** na
API (`APPROVAL_TOOL_IDS`), falta a ferramenta `propose_*` no runtime, o schema no
broker e o schema no cliente PWA.

### Contas a pagar

`POST /payables` e `POST /payables/:id/pay` existem, mas **não** estão em
`APPROVAL_TOOL_IDS`. O executor V1 de pending operations já sabe executá-los;
o caminho V2 precisa do menor contrato novo.

## 3. Matriz de três estados

| Capacidade | Estado | Ação nesta missão |
|---|---|---|
| Despesa/receita/transferência/compra/fatura/conta/categoria (criação) | IMPLEMENTADO | Não reimplementar |
| Consultas de contas/dashboard/categorias/cartões/faturas/transações/insights | IMPLEMENTADO | Não reimplementar |
| Analytics (KPIs, categorias, fluxo de caixa, orçamento, patrimônio) | FALTA | Implementar leitura |
| Orçamentos (listar/limites/tendências) | FALTA | Implementar leitura |
| Metas (listar/progresso) | FALTA | Implementar leitura |
| Contas a pagar (listar/vencimentos/lembretes) | FALTA | Implementar leitura |
| Auditoria (histórico) | FALTA | Implementar leitura |
| Editar descrição, renomear/desativar conta e categoria | FALTA | Implementar proposta + Pending V2 |
| Criar/pagar conta a pagar por conversa | FALTA | Implementar contrato Pending V2 mínimo + proposta |
| Metas/orçamentos por conversa (mutação) | PÓS-V1 | PWA continua dona |
| Exclusões arbitrárias, áudio/visão/PDF, web, notificações proativas | PÓS-V1 | Manter fora |
| Conversas privadas | PÓS-V1 | Manter flag desligada |

## 4. Achados das pendências transversais

- **Better Auth:** `main` contém `a9ace19` (merge do PR #284), com upgrade de
  segurança. O PR #284 continua aberto no GitHub (draft) — fechar é ação externa,
  requer confirmação do usuário. Nenhum novo upgrade é necessário.
- **Bearer legado:** não há evidência local nova de uso; consulta a banco
  canônico não executada nesta sessão (sem acesso a produção).
- **Conversas privadas:** flag não habilitada; sem mudança nesta missão.
- **CI/PWA:** Biome e flakes não reproduzidos; correções só com falha
  reproduzida. O job dedicado do `ted-runtime` continua ausente (registrado).
- **Patch local do cartão:** preservado. Só deve ser aplicado se reproduzir
  defeito real; a validação live exige autorização de provider/modelo/orçamento.

## 5. Limites de autorização

Sem deploy, merge, produção, dados reais ou inferência paga. A campanha live de
8–10 jornadas continua pendente de autorização explícita de provider, modelo e
teto. Todas as provas desta sessão são determinísticas/sintéticas.

## 6. Execução desta sessão

### Entregue

| Área | Alteração |
|---|---|
| Leituras TED | 12 novas ferramentas: analytics (KPIs, breakdown, fluxo de caixa, consumo de orçamento, patrimônio), orçamentos (listar/check/tendências), metas, contas a pagar (listar/lembretes) e auditoria |
| Transporte | allowlist exata das novas rotas + padrão UUID para `/budgets/:id/trends`; nenhum POST |
| Propostas TED | `propose_transaction_update`, `propose_account_update`, `propose_account_deactivate`, `propose_category_update`, `propose_category_deactivate` |
| Contas a pagar | novo contrato Pending V2 `payables.create` / `payables.pay` (schemas, executores, recibos, apresentação acionável) + `propose_payable_create` / `propose_payable_pay` |
| Broker Agent | schemas estritos das 7 novas propostas (nenhuma capacidade de confirmar/executar) |
| PWA | schemas/sanitização das 7 novas propostas, rótulos de recuperação e copy de efeito dos payables |
| Testes | runtime (leituras, propostas, payables), broker Agent, contratos API/Pending V2 e typecheck API/Agent/PWA |

### Evidências executadas

- `apps/ted-runtime`: 148 testes focados PASS (leituras, propostas, catálogo,
  permissões, contrato de API); suíte completa teve 3 falhas de ambiente já
  conhecidas (timeouts/SIGKILL em testes de SDK real, não relacionadas).
- `apps/api`: `pending-v2-payables` 5/5 PASS; `tool-registry` 16/16 PASS;
  `mutation-receipt-coverage` PASS; `pending-v2-wiring` 4/4 PASS; `typecheck` PASS.
- `apps/agent`: `pending-propose-rpc` 18/18 PASS; `f2a-structured-interpretation`
  18/18 PASS; `typecheck` PASS.
- `apps/pwa`: `typecheck` PASS; CI `quality (22, 10)` PASS (inclui `Test PWA`).
- `packages/llm-contracts`: build PASS; `pnpm docs:lint` PASS; gates
  `capabilities:check`, `write-policy:check`, `governance:check`,
  `boundary:check`, `test:skip-gate` e `public-safety --strict` PASS.
- **CI remoto no SHA `a7fd363` (PR #318): `CI` PASS (todos os jobs, incluindo
  `Financial integrity — Postgres`, `TED Runtime` e `Gate — all checks`) e
  `PWA CI` PASS (`quality (22, 10)`).**

O runner Vitest da PWA não inicia worker neste host Windows (issue #277); a
validação efetiva do teste de componente veio do CI Linux.

### Pendente / não executado

- **Fase 4 (campanha live): BLOCKED_PROVIDER.** O piloto P3.9 real passou
  **7/7** duas vezes após a correção do prompt (commit `0835cb7`): 7
  propostas/7 confirmações/7 recibos, sem escrita antes de aprovação.
- Um turno de leitura nova executou `list_budgets`, `list_goals`,
  `list_payables` e `analytics_kpis` com sucesso e produziu resposta
  fundamentada (workspace sintético vazio); as tentativas seguintes
  retornaram **HTTP 429 `provider.rate-limit`** (“The inference service is
  overloaded”, `retryAfterMs` ~25–29 s). Nenhuma escrita/duplicidade.
- Correções de harness aplicadas: allowlist live-real do P2D agora inclui as
  leituras V1 (`/budgets`, `/goals`, `/payables`, `/analytics/*`,
  `/transactions`, `/audit-logs`, trends por UUID), com teste offline
  dedicado; o spec P2D foi ajustado para não usar “botão enviar habilitado”
  como sinal de fim de turno (o composer fica desabilitado com input vazio).
- Correção PWA: resposta de turno multi-ferramenta não é mais anexada duas
  vezes quando o histórico já a traz com o mesmo `turnId` (chave React
  duplicada); teste de identidade cobre o caso.
- **Fase 4 (datas/contexto/ambiguidade):** requer nova janela de provider.
  O runtime não possui system prompt configurável; a regra de data ambígua
  está nas descrições das ferramentas e precisa de campanha real.
- **Fase 5:** Bearer legado (consulta ao banco canônico), isolamento WebSocket
  (`TED_PRIVATE_VIEWS_ENABLED` permanece desligada), flakes de CI/PWA, smoke de
  produção, deploy, rollback e fechamento de issues/PRs. Fechar PR #284/issue
  #283 é ação externa e requer confirmação do usuário; a evidência local mostra
  `better-auth@1.7.7` instalado e o upgrade já integrado em `a9ace19`.
- **Live/E2E:** nenhum deploy, nenhum dado real, nenhuma inferência paga além
  da campanha acima. O provider reportou `cost: 0` nas mensagens analisadas;
  faturamento não confirmado.

