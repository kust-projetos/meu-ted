# ADR-021 — PendingOperation V2 restrito a criação de transações; V1 fora da superfície do modelo; undo conversacional separado

**Status:** Aceito
**Data:** 2026-09-19

## Contexto

A V4.1 deixou um débito aberto de migração pending-ops V1→V2 antes de remover
a V1 (`docs/reports/v4.1-final-report.md:30`,
`docs/reports/v4.1-release-bridge-execution.md:91`): a cobertura V2 além de
transações e o contrato de undo dependiam de decisão de produto. O inventário
de mutações (`docs/reports/v4.1-mutation-inventory.md:9-32`) mostra o mapa
real — expense/income já em V2, demais domínios (transfers, payables, cards,
goals, budgets, subscriptions) ainda em V1/pending diversos.

O owner decidiu nesta sessão o escopo final: **PendingOperation V2 fica
limitado a `transactions.expense.create` e `transactions.income.create`**;
as tools V1 pending saem da superfície do modelo; o undo conversacional
permanece um endpoint/serviço separado, idempotente, com confirmação
explícita, fora do protocolo V2.

## Decisão

1. **Escopo V2 fechado em dois tools.** Somente
   `transactions.expense.create` e `transactions.income.create` trafegam pelo
   protocolo PendingOperation V2 (contrato ADR-010: bindings workspace/actor/
   device, hash SHA-256 canônico, TTL, idempotência). Nenhum outro domínio é
   admitido em V2 por este ADR — transferências, payables, cartões, metas,
   orçamentos e assinaturas seguem seus fluxos atuais fora de V2.
2. **V1 pending fora da superfície do modelo.** `get_pending_operation`,
   `confirm_pending_operation` e `cancel_pending_operation` são retiradas da
   exposição ao modelo (estado já implementado em fonte:
   `apps/agent/src/agent-config/tools.ts:16-21,106-118,237-240` —
   `RETIRED_MODEL_TOOLS` + guarda em `buildExposedTools`). O registro gerado
   OpenAPI pode continuar listando as entradas V1; seleção e exposição as
   filtram defensivamente. Falha sob composição `v2Only` de produção é o
   comportamento esperado, não erro a corrigir.
3. **Undo conversacional é serviço independente, fora do V2, sem tool do
   modelo.** `undo_last_action` está aposentado da superfície do modelo
   (`apps/agent/src/agent-config/tools.ts` — `RETIRED_MODEL_TOOLS`) e nenhuma
   skill o referencia. Texto livre NUNCA executa desfazer:
   - um pedido (`desfaz…`, sem negação e sem confirmação textual) cria
     APENAS uma proposta persistente no SQLite do `FinanceChatAgent` DO
     (`apps/agent/src/mutations/undo-proposal.ts`), com alvo
     (`targetLastOperationId`) fixado na hora da proposta por prévia
     autoritativa (`GET /audit-logs`, operação reversível mais recente,
     preferência do próprio ator), vínculo workspace/ator/dispositivo,
     expiração (10 min), transição CAS (`proposed` → `executing` →
     `confirmed`/`cancelled`/`expired`) e chave de idempotência estável
     (`undo:<workspace>:<requestId>`, `requestId` = `intentionId` do turno);
   - confirmação/cancelamento acontece EXCLUSIVAMENTE no RPC autenticado
     `POST /rpc/undo/decision` (corpo estrito `{decision,requestId}`,
     identidade só do contexto autenticado gateway→DO). `confirm` reivindica
     primeiro a proposta de forma atômica e persistente (`proposed` →
     `executing`, vinculada à identidade) ANTES de qualquer efeito, e só
     então chama o endpoint existente `POST /pending-operations/undo` com o
     alvo FIXO, a chave estável e a capability estreita
     `financial.undo.execute` (nunca `financial.write` genérico), fechando
     em `confirmed` com o resultado gravado; `cancel` vence SOMENTE enquanto
     `proposed` e nunca chama a API — contra `executing` falha fechado com
     `undo.executing` (409, pendente verídico), nunca um `cancelled`
     pareado com efeito.
     Negação em linguagem natural, vínculo divergente, proposta
     ausente/expirada/terminal e corpo fora do contrato falham fechados;
     repetição após falha de transporte reusa mesma chave/alvo (a proposta
     segue `executing` e a nova tentativa converge pelo dedup da API) e
     reconfirmação do mesmo `requestId` reproduz o resultado
     gravado sem reexecutar.
   Não participa de hash/binding/TTL de proposta V2 nem consome attestation
   V2; `POST /pending-operations/undo` exige `financial.undo.execute` para
   chamadores delegados (device-token inalterado).

## Invariantes

- **Modelo nunca vê nem chama V1 pending nem undo.** Qualquer caminho que exponha
  `get/confirm/cancel_pending_operation` ou `undo_last_action` ao modelo é regressão deste ADR.
- **V2 nunca carrega undo.** Proposta V2 não codifica desfazer; undo não
  aceita `proposalHash` nem attestation V2 como autorização.
- **Confirmação em duas etapas para undo, sem execução por texto.** Pedido
  em texto cria proposta; só o RPC autenticado decide; sem ambos (ou com
  negação), nada executa.
- **Paridade de endpoint do undo (lado API).** O confirm do RPC chama o
  `POST /pending-operations/undo` existente com `lastOperationId` fixo; a
  paridade OpenAPI/operação gerada continua válida no backend, mas o modelo
  nunca a invoca.

## Consequências

- Expansão de V2 para outros domínios exige novo ADR com cobertura de
  bindings, hash e idempotência por domínio — este ADR não a autoriza.
- Remoção do código/rotas V1 da API é etapa separada e **não autorizada aqui**;
  até lá, V1 segue existindo no backend, apenas invisível ao modelo.
- Rollback deste ADR: revogar por novo ADR; reabrir V1 ao modelo exige
  reavaliar composição `v2Only`, guards de seleção e suíte de aprovação.
- **Este ADR não autoriza deploy, DML/DDL, acesso a produção/VPS, GC, rewrite
  de histórico ou rotação de credenciais.**

## Referências

- `docs/adr/ADR-010-pending-operation-v2.md` (contrato V2 — inalterado).
- `docs/reports/v4.1-mutation-inventory.md:9-32` (mapa V1/V2 por domínio).
- `docs/reports/v4.1-release-bridge-execution.md:91` (débito V1→V2 como gate
  de produto).
- `apps/agent/src/agent-config/tools.ts:16-21,106-118,182-198,237-240`
  (implementação em fonte: aposentadoria V1, intent/endpoint de undo).
- `apps/agent/src/orchestration/conversation-orchestrator.ts:392-393,696`
  (mapeamento kind → `transactions.{expense,income}.create`).

## Adendo 2026-09-30 — verificador read-only `verify-target` (narrow, sem ampliar V2)

- **Rota:** `POST /rpc/undo/:requestId/verify-target`; body estrito de chave
  única `{ expectedEntity: { type: 'transaction', id: 'UUID' } }`; resposta
  `{ requestId, matches }`; nada persiste. Sem campo `target`, sem objeto
  `transaction`, sem idempotency keys no contrato.
- **Checks:** identidade só dos headers verificados do gateway; delegação
  estreita `financial.read` para a leitura de audit; alvo fixo
  `targetLastOperationId` (nunca o newest do preview); só `proposed` +
  não-expirado; só `transactions.*.create`; re-leitura pós-audit com falha
  fechada em `undo.target_changed`. Nunca chama preview/undo/mutação de store.
- **Escopo:** nenhuma nova tool V2, nenhuma escolha de alvo pelo modelo —
  este ADR segue inalterado no escopo; o verificador é superfície read-only
  separada. Fontes: `apps/agent/src/finance-chat-agent.ts`
  (`handleUndoVerifyTarget`), `apps/agent/src/mutations/undo-proposal.ts`
  (`verify`).
