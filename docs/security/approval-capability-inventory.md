# Approval capability inventory

**Scope:** G5.2.6 approval boundary. The API is the only side-effect boundary; Agent and Pi may request writes but do not bypass API approval.

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
| Pending approval | V2: `POST /pending-operations/v2/propose`, `POST /pending-operations/v2/:id/confirm`, `POST /pending-operations/v2/:id/execute`, `GET /pending-operations/v2/:id/outcome`. Rotas V1 `POST /approve`, `/reject`, `/:id/approve`, `/:id/reject` **removidas** (PR-1 `retire-pending-v1`); apenas `/undo` permanece do V1. | requester and workspace binding; capability delegada estreita; atestação de uso único; `requireActionablePresentation` | `get_pending_operation`, `confirm_pending_operation`, `cancel_pending_operation` → API (V2) |

## Runtime boundaries

- **API:** `apps/api/src/approvals/guard.ts` evaluates `ApprovalPolicy` and creates `PendingOperation` before a guarded side effect. `apps/api/src/routes/index.ts` injects the same policy/store into all financial route modules.
- **Persistence:** Postgres uses `createPostgresPendingOperationStore`; `V023__pending_operations.sql` is included in both canonical and legacy migration manifests. Tests use the in-memory store explicitly.
- **Agent:** `apps/agent/src/index.ts` emits a short-lived delegated token with workspace, actor, role, capabilities and intention ID. The API pre-handler enforces `financial.write`; Agent never writes directly to a store.
- **Pi:** `.pi/extensions/financial-tools/generated/http-tools.ts` sends migrated tools through `requestPiApiJson`. Pending-operation tools use the same client and are enabled in `capability-flags.ts`; no Pi tool executes SQL or approves locally.
- **Identity:** API `authenticatedContext.deviceId` is the requester for device-token calls; delegated calls use the token subject; both are passed to `PendingOperationStore` and checked again on approval/rejection.
- **Next stage:** approval changes status only. Atomic execution of the approved payload belongs to G5.2.7; no route in this inventory executes a pending payload during approval.

## Fluxo V2 e confirmação pelo agente

O fluxo de aprovação é `propose → confirm → execute → outcome`, com a API como única autoridade financeira (hash de proposta, atestação de uso único, `Idempotency-Key`, workspace/ator/device resolvidos server-side, recibo canônico e undo). A atestação nunca vai ao browser.

- **Confirmação pelo usuário:** a PWA envia só a decisão e o `requestId` (nunca atestação ou segredo) pelo card Confirmar/Cancelar. É o caminho padrão, preservado quando `TED_AGENT_SELF_CONFIRM` está off.
- **Confirmação pelo agente (`TED_AGENT_SELF_CONFIRM=1`, default-off):** o gateway `apps/ted-runtime` chama confirm/execute/outcome na mesma volta do turno, com o token delegado do usuário que já possui, somente quando a `assurance {complete, ambiguousEntity, explicitIntent}` das tools `propose_*` é favorável. Com dúvida/ambiguidade material, o gateway não executa e devolve a pergunta em texto (sem card). O gate `requireActionablePresentation` da API continua valendo: 409 `approval.not_actionable` ⇒ sem execução e fallback para pergunta/card. Resultado incerto (`approval.execution_uncertain`, `unverified`) nunca vira sucesso; o reconcile existente e o undo permanecem. O modelo nunca recebe credencial, capability, hash ou `operationId`; não há mudança de contrato na API.
- **Rotas V1 removidas:** `POST /approve`, `/reject`, `/:id/approve` e `/:id/reject` estão desmontadas desde o PR-1 `retire-pending-v1`; o modelo de tools do Agent nunca as usou e a produção já servia somente V2. `/undo` é a única rota V1 mantida.
- **Reverter:** desligar `TED_AGENT_SELF_CONFIRM` (`0` ou variável ausente) retorna ao card, sem alterar API, ledger ou dados.

Referências: [ADR-010 — Pending Operation V2](../adr/ADR-010-pending-operation-v2.md), [ADR-033 — Confirmação pelo agente](../adr/ADR-033-agente-confirma-pending-v2.md), [runbook de paridade de flags](../runbooks/ted-runtime-paridade-flags.md) e [plano da mudança](../plans/2026-11-20-ted-agent-self-confirm/PLAN.md).
