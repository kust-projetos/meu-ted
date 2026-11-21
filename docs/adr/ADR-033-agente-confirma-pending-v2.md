# ADR-033 — Confirmação de Pending V2 feita pelo agente TED

**Status:** Superseded by ADR-034 (2026-11-21) — decisão histórica, mantida apenas como registro; a direção vigente remove a flag, o card e o conceito de aprovação.
**Data:** 2026-11-20

> **Superseded by [ADR-034](ADR-034-agente-executa-sem-aprovacao.md):** o agente executa sem aprovação, sem `TED_AGENT_SELF_CONFIRM` e sem card Confirmar/Cancelar. O texto abaixo descreve a decisão original e não é mais o estado vigente.

## Contexto

O fluxo Pending V2 ([ADR-010](ADR-010-pending-operation-v2.md)) exige um passo de aprovação manual (card Confirmar/Cancelar) na PWA. O [`apps/ted-runtime`](../../apps/ted-runtime/README.md) é o único runtime conversacional desde a descontinuação do A0 ([ADR-031](ADR-031-ted-opencode-first.md)). O [plano desta mudança](../plans/2026-11-20-ted-agent-self-confirm/PLAN.md) remove o card: quando os dados estão completos, explícitos e sem ambiguidade, o próprio agente confirma e executa; na dúvida, pergunta ao usuário em texto e não executa.

## Decisão

1. O pipeline Pending V2 permanece server-side e inalterado (propose → confirm → execute → outcome). Preservam-se hash de proposta, atestação de uso único, `Idempotency-Key`, autorização por workspace/device, recibo canônico e undo. Não há mudança de contrato na API.
2. Quem confirma é o gateway `apps/ted-runtime`: com a flag ligada, ele chama confirm/execute/outcome na mesma volta do turno, usando o token delegado do usuário que já possui. O modelo nunca recebe credencial, capability, hash de proposta ou `operationId`.
3. Fail-closed por flag: `TED_AGENT_SELF_CONFIRM=1` liga o novo comportamento; desligada (padrão), o fluxo com card continua idêntico. Ligar em produção é decisão do operador.
4. Dúvida vira pergunta: as tools `propose_*` recebem do agente uma declaração `assurance {complete, ambiguousEntity, explicitIntent}`, validada no gateway. Qualquer valor desfavorável ⇒ sem execução; o gateway devolve a pergunta como texto, sem card. O gate `requireActionablePresentation` da API continua valendo: label não resolvido ⇒ 409 `approval.not_actionable` ⇒ sem execução e fallback para pergunta/card.
5. Resultado incerto (`approval.execution_uncertain`, `unverified`) nunca vira sucesso; a PWA mantém "não verificado" e o reconcile existente segue valendo.
6. Undo permanece como rede de segurança do usuário. Sem teto de valor novo; mutações de dinheiro (pagar fatura, transferir, payables) seguem a mesma regra de assurance; o autoexec de categoria da emenda do ADR-031 passa a ser caso particular.

## Consequências

- O card deixa de aparecer quando o agente confirma: a resposta do chat traz `execution` (recibo/outcome) em vez de `proposal` acionável. Com a flag off ou no fallback, o card antigo continua.
- Nenhuma autoridade nova é conferida ao LLM: a autoridade financeira permanece exclusivamente na API.
- As rotas V1 `/approve` e `/reject` já estavam removidas (PR-1 `retire-pending-v1`); este ADR não remove rotas nem estados da API — ver o [inventário de aprovação](../security/approval-capability-inventory.md).
- Fora de escopo: deploy, merge, mudança em produção e remoção de rotas/estados da API.

## Rollback

Desligar `TED_AGENT_SELF_CONFIRM` (valor `0` ou variável ausente) retorna ao fluxo com card Confirmar/Cancelar. A API, o ledger e os dados não são alterados.

## Referências

- [Plano — TED: confirmação feita pelo agente](../plans/2026-11-20-ted-agent-self-confirm/PLAN.md).
- [ADR-010 — Pending Operation V2](ADR-010-pending-operation-v2.md).
- [ADR-031 — OpenCode como núcleo conversacional do Meu TED](ADR-031-ted-opencode-first.md).
- [Runbook — Paridade de flags do TED Runtime](../runbooks/ted-runtime-paridade-flags.md).
