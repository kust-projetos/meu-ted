# Approval capability inventory

**Scope:** G5.2.6 approval boundary. The API is the only side-effect boundary; clients may request writes but do not bypass the API. **Estado vigente (2026-11-21):** o TED não tem superfície de aprovação — as tools de ação executam diretamente sob validação server-side ([ADR-034](../adr/ADR-034-agente-executa-sem-aprovacao.md), que supersede o [ADR-033](../adr/ADR-033-agente-confirma-pending-v2.md)); o Pending V2 permanece apenas como motor interno server-side e o `undo` é a rede de segurança do usuário.

## Matrix

| Capability | API write boundary | Risk rule | Pi/Agent path |
|---|---|---|---|
| Accounts | `POST /accounts`, `PATCH /accounts/:id`, `POST /accounts/:id/deactivate` | `initialBalanceCents >= limit`; deactivate always | `create_account`, `update_account`, `deactivate_account` → API |
| Categories | `POST /categories`, `PATCH /categories/:id`, `POST /categories/:id/deactivate` | deactivate always | `create_category`, `update_category`, `deactivate_category` → API |
| Transactions | `POST /transactions/expense`, `/income`, `/transfers`; `PATCH /transactions/:id`; `DELETE /transactions/:id` | amount `>= limit`; delete always | `create_expense`, `create_income`, `create_transfer`, `update_transaction`, `delete_transaction` → API |
| Cards | `POST /cards`, `/cards/purchases`, `/cards/installments`, `/cards/recurring`, `/cards/statements/:id/pay`; `PATCH /cards/:id`, `/cards/purchases/:id` | credit limit/purchase/payment/update amount `>= limit` | `create_credit_card_account`, `create_card_purchase`, `create_card_installments`, `pay_statement` → API |
| Payables | `POST /payables`, `/payables/:id/pay`, `/payables/:id/unpay`, `/payables/:id/cancel`, `/payables/templates`, `/payables/from-template`; `PATCH /payables/:id` | amount `>= limit`; unpay/cancel always | `create_account_payable`, `mark_account_paid`, `cancel_account_payable`, `create_payable_template`, `create_payable_from_template` → API |
| Goals | `POST /goals`, `/goals/:id/contribute`, `/goals/:id/cancel`; `PATCH /goals/:id` | target/contribution amount `>= limit`; cancel always | `create_goal`, `contribute_to_goal`, `cancel_goal` → API |
| Budgets | `POST /budgets`; `PATCH /budgets/:id` | amount `>= limit` | `create_budget`, `update_budget` → API |
| Subscriptions | `POST /subscriptions`, `/subscriptions/:id/cancel`; `PATCH /subscriptions/:id` | amount `>= limit`; cancel always | `create_subscription` boundary (when exposed), current HTTP route → API |
| Pending approval (motor interno) | V2: `POST /pending-operations/v2/propose`, `POST /pending-operations/v2/:id/confirm`, `POST /pending-operations/v2/:id/execute`, `GET /pending-operations/v2/:id/outcome`. Rotas V1 `POST /approve`, `/reject`, `/:id/approve`, `/:id/reject` **removidas** (PR-1 `retire-pending-v1`); apenas `/undo` permanece do V1. | requester and workspace binding; capability delegada estreita; atestação de uso único; `requireActionablePresentation` | `apps/ted-runtime` não expõe mais RPCs `pending-operations/*`: o gateway aciona o pipeline internamente sob as tools de ação (`record_expense` … `pay_payable`) e mantém somente as RPCs de `undo`. |

## Runtime boundaries

- **API:** `apps/api/src/approvals/guard.ts` evaluates `ApprovalPolicy` and creates `PendingOperation` before a guarded side effect. `apps/api/src/routes/index.ts` injects the same policy/store into all financial route modules.
- **Persistence:** Postgres uses `createPostgresPendingOperationStore`; `V023__pending_operations.sql` is included in both canonical and legacy migration manifests. Tests use the in-memory store explicitly.
- **TED runtime (vigente):** `apps/ted-runtime` registra a ação, declara `assurance` como metadado de completude e o gateway aciona `propose → confirm → execute → outcome` na mesma volta do turno, usando o token delegado do usuário. O modelo nunca recebe credencial, capability, hash ou `operationId`. Falha de dado/ambiguidade, 409 `approval.not_actionable`, pipeline indisponível ou erro ⇒ pergunta em texto, sem card e sem sucesso falso; `unverified` nunca vira sucesso.
- **Histórico — Agent (A0 descontinuado em 2026-11-17):** `apps/agent/src/index.ts` emitia token delegado de curta duração com workspace, ator, papel, capabilities e intention ID; a API aplicava `financial.write`.
- **Histórico — Pi:** `.pi/extensions/financial-tools/generated/http-tools.ts` enviava tools migradas por `requestPiApiJson`, com pending-operations habilitadas em `capability-flags.ts`; nenhuma tool executava SQL ou aprovava localmente.
- **Identity:** API `authenticatedContext.deviceId` is the requester for device-token calls; delegated calls use the token subject; both are passed to `PendingOperationStore` and checked again on approval/rejection.
- **Separação de estágios (histórico G5.2.7):** a aprovação apenas mudava o status; a execução atômica do payload aprovado pertence ao estágio seguinte. Nenhuma rota deste inventário executa o payload *durante* a aprovação — a chamada `execute` é distinta da `confirm`, inclusive quando o gateway as encadeia no mesmo turno.

## Fluxo V2 e execução direta pelo agente

O pipeline `propose → confirm → execute → outcome` permanece como motor interno server-side, com a API como única autoridade financeira (hash de proposta, atestação de uso único, `Idempotency-Key`, workspace/ator/device resolvidos server-side, recibo canônico e undo). A atestação nunca vai ao browser.

- **Execução direta (sem flag, sem card):** o gateway `apps/ted-runtime` encadeia confirm/execute/outcome na mesma volta do turno quando as tools de ação (`record_expense`, `record_income`, `record_card_purchase`, `transfer_between_accounts`, `pay_card_statement`, `create_account`, `create_category`, `update_transaction`, `rename_account`, `deactivate_account`, `rename_category`, `deactivate_category`, `create_payable`, `pay_payable`) declaram `assurance {complete, ambiguousEntity, explicitIntent}` favorável e a API valida a apresentação. `TED_AGENT_SELF_CONFIRM` e `isSelfConfirmEnabled` não existem mais.
- **Falha fechada em texto:** assurance ausente/desfavorável, 409 `approval.not_actionable`, pipeline indisponível ou erro ⇒ o agente pergunta ao usuário em texto e não chama a tool de ação; nunca há card, proposta pendente ou sucesso falso. `unverified` segue sem recibo e sem status `succeeded`; o reconcile existente permanece. As tools `correct_pending_proposal` e `cancel_pending_proposal` foram removidas.
- **Undo mantido:** `undo_last_action` continua gerando o card de desfazer do usuário; as RPCs de `undo` (active/decision) são servidas pelo gateway, que não expõe mais `pending-operations/propose|active|decision`.
- **Rotas V1 removidas:** `POST /approve`, `/reject`, `/:id/approve` e `/:id/reject` estão desmontadas desde o PR-1 `retire-pending-v1`; `/undo` é a única rota V1 mantida.
- **Rollback:** não há mais flag para desligar; o rollback é o redeploy da imagem `ted-runtime:rollback-pre-<sha>`. API, ledger e dados financeiros não são alterados; a recuperação de um efeito já executado é feita pelo `undo`.
- **Lacuna conhecida:** `transactions.update` aceita somente `transactionId`, `description` e `expectedDescription` (CAS da descrição); a tool `update_transaction` não altera categoria, valor ou data e rejeita esses campos com `tool.invalid_args`.

Referências: [ADR-010 — Pending Operation V2](../adr/ADR-010-pending-operation-v2.md), [ADR-034 — Agente executa sem aprovação](../adr/ADR-034-agente-executa-sem-aprovacao.md) (supersede o [ADR-033](../adr/ADR-033-agente-confirma-pending-v2.md)), [runbook de paridade de flags](../runbooks/ted-runtime-paridade-flags.md) e [plano de 2026-11-20](../plans/2026-11-20-ted-agent-self-confirm/PLAN.md) (nota de status).
