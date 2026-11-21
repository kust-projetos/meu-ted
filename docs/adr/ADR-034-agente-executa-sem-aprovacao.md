# ADR-034 — Agente TED executa sem aprovação

**Status:** aceita em 2026-11-21 na branch `feat/ted-remocao-completa-aprovacao` (sem deploy); **supersede o [ADR-033](ADR-033-agente-confirma-pending-v2.md)**; sem autorização de produção.
**Data:** 2026-11-21

## Contexto

O [ADR-033](ADR-033-agente-confirma-pending-v2.md) introduziu a confirmação de Pending V2 pelo agente sob a flag `TED_AGENT_SELF_CONFIRM`, mantendo o card Confirmar/Cancelar como caminho padrão. Essa configuração deixou de fazer sentido: o runtime passou a executar ações diretamente e a PWA deixou de ter superfície de aprovação. A aprovação manual não é mais um conceito do produto — apenas o `undo` permanece como rede de segurança do usuário.

O [`apps/ted-runtime`](../../apps/ted-runtime/README.md) continua sendo o único runtime conversacional desde a descontinuação do A0 ([ADR-031](ADR-031-ted-opencode-first.md)). A API financeira ([ADR-004](004-api-source-of-truth.md)) permanece a única autoridade de escrita e o [Pending V2](ADR-010-pending-operation-v2.md) continua sendo o motor server-side de execução, auditoria e idempotência — sem mudança de contrato.

## Decisão

1. As 14 tools `propose_*` viram tools de **ação** com o mesmo mapeamento interno para os ids da API (`PROPOSAL_TOOL_SPECS`) e validação/idempotência preservadas: `record_expense`, `record_income`, `record_card_purchase`, `transfer_between_accounts`, `pay_card_statement`, `create_account`, `create_category`, `update_transaction`, `rename_account`, `deactivate_account`, `rename_category`, `deactivate_category`, `create_payable` e `pay_payable`. `undo_last_action` continua disponível e gera o card de desfazer. `correct_pending_proposal` e `cancel_pending_proposal` foram removidas.
2. A execução é **incondicional**: `TED_AGENT_SELF_CONFIRM`, `isSelfConfirmEnabled` e a correção/supersede de pending no gateway não existem mais. O gateway chama o pipeline na mesma volta do turno quando a declaração `assurance {complete, ambiguousEntity, explicitIntent}` enviada pela tool é favorável e a API valida a apresentação.
3. Falha fechada em texto: assurance ausente/desfavorável, 409 `approval.not_actionable`, pipeline indisponível ou erro ⇒ o agente pergunta ao usuário em texto e **não** chama a tool de ação; nunca há card de aprovação e nunca há sucesso falso. `unverified` segue sem recibo e sem status `succeeded`; o reconcile existente permanece.
4. O [Pending V2](ADR-010-pending-operation-v2.md) permanece **apenas como motor interno server-side** (propose → confirm → execute → outcome): hash de proposta, atestação de uso único, `Idempotency-Key`, autorização por workspace/device, recibo canônico e undo. As RPCs `pending-operations/propose|active|decision` do gateway foram removidas; as RPCs de `undo` continuam servidas pelo gateway. A API não mudou.
5. A PWA não renderiza mais cards Confirmar/Cancelar nem pedido de aprovação: a resposta traz o recibo/estado terminal somente leitura e a ação de desfazer. O inventário de capacidades está em [approval-capability-inventory](../security/approval-capability-inventory.md).
6. **Lacuna conhecida:** `transactions.update` na API aceita somente `transactionId`, `description` e `expectedDescription` (CAS da descrição atual). `update_transaction` expõe exatamente esses campos e rejeita `categoryId`, `amountCents` e `date` com `tool.invalid_args`. Alterar categoria/valor/data exige estender o contrato da API com CAS para esses campos — fora do escopo desta decisão.

## Consequências

- Não existe mais flag para ligar/desligar a execução pelo agente; a condição é a declaração de completude associada à validação server-side, não uma chave de configuração.
- Nenhuma autoridade nova é conferida ao LLM: a autoridade financeira permanece exclusivamente na API, que valida workspace, ator, dispositivo e idempotência.
- O card de aprovação desaparece da PWA; a única superfície interativa pós-execução é o `undo`.
- Textos de prompt, descrições de tools e catálogo gerado não contêm mais linguagem de aprovação/proposta pendente.
- O [plano de 2026-11-20](../plans/2026-11-20-ted-agent-self-confirm/PLAN.md) e o [runbook de flags](../runbooks/ted-runtime-paridade-flags.md) são históricos quanto à flag antiga; este ADR é a referência vigente.

## Rollback

Não há mais `TED_AGENT_SELF_CONFIRM=0`: o rollback é **redeploy da imagem `ted-runtime:rollback-pre-<sha>`** (tag criada antes do deploy da mudança, identificada pelo SHA publicado). A API, o ledger e os dados financeiros não são alterados; apenas o runtime volta à versão anterior. A recuperação de uma operação já executada continua sendo feita pelo `undo`, não por reversão de flag.

## Referências

- [ADR-033 — Confirmação de Pending V2 feita pelo agente](ADR-033-agente-confirma-pending-v2.md) (superseded por este ADR).
- [ADR-010 — Pending Operation V2](ADR-010-pending-operation-v2.md).
- [ADR-031 — OpenCode como núcleo conversacional do Meu TED](ADR-031-ted-opencode-first.md).
- [Plano — TED: confirmação feita pelo agente](../plans/2026-11-20-ted-agent-self-confirm/PLAN.md) (nota de status).
- [Runbook — Paridade de flags do TED Runtime](../runbooks/ted-runtime-paridade-flags.md).
- [README do TED Runtime](../../apps/ted-runtime/README.md).
