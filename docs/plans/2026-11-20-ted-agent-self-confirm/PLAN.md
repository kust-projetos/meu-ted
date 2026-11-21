# TED: confirmação feita pelo agente (sem card de aprovação)

Data: 2026-11-20. Status: **encerrado / superseded em 2026-11-21** pela remoção completa da aprovação ([ADR-034](../../adr/ADR-034-agente-executa-sem-aprovacao.md)); registro histórico.

> **Nota de status (2026-11-21):** este plano descreve a introdução de `TED_AGENT_SELF_CONFIRM` e do fallback com card Confirmar/Cancelar. A direção vigente, na branch `feat/ted-remocao-completa-aprovacao` (sem deploy), não tem flag nem card: as tools de ação executam diretamente quando a declaração de completude é favorável; na dúvida, o agente pergunta em texto. Pending V2 permanece apenas como motor interno server-side e o `undo` continua como rede de segurança. O rollback passou a ser o redeploy da imagem `ted-runtime:rollback-pre-<sha>`. As fatias e pendências abaixo são históricas e não descrevem o estado atual.

## Objetivo
Remover o passo de aprovação manual do usuário (card Confirmar/Cancelar). O agente TED
decide: se os dados estão completos, explícitos e sem ambiguidade, ele confirma e executa
direto; se houver dúvida ou ambiguidade, pergunta ao usuário em texto e NÃO executa.

## Decisões (registradas, tomadas sem consulta por autonomia delegada)
1. **Pending V2 permanece como pipeline server-side** (propose → confirm → execute → outcome).
   Preservam-se hash de proposta, atestação de uso único, `Idempotency-Key`, autorização por
   workspace/device, recibo canônico e undo. Só muda QUEM confirma: o gateway
   (`apps/ted-runtime`) chama confirm/execute/outcome na mesma volta do turno, usando o token
   delegado do usuário que ele já minta. Nenhuma mudança de contrato na API é necessária.
2. **Fail-closed por flag**: `TED_AGENT_SELF_CONFIRM=1` liga o novo comportamento. Desligada
   (padrão), o fluxo atual com card continua idêntico. Ligar em produção é ação do usuário.
3. **Dúvida → pergunta**: as tools `propose_*` recebem do agente uma declaração
   `assurance {complete, ambiguousEntity, explicitIntent}` (validada no gateway). Qualquer
   valor desfavorável ⇒ não executa; o gateway devolve a pergunta como texto (sem card).
   O gate `requireActionablePresentation` da API continua valendo: label não resolvido ⇒
   409 `approval.not_actionable` ⇒ gateway NÃO executa e cai para pergunta/card de fallback.
4. **Resultado incerto** (`approval.execution_uncertain`, `unverified`): nunca vira sucesso;
   a PWA mostra "não verificado" como hoje e o reconcile existente segue valendo.
5. **Undo permanece** (cartão de desfazer pós-execução é a rede de segurança do usuário).
6. Sem teto de valor novo; mutações de dinheiro (pagar fatura, transferir, payables) seguem
   a mesma regra de assurance. O autoexec de categoria passa a ser caso particular.
7. Fora de escopo: deploy, merge, mudança em produção, remoção de rotas/estados da API.

## Fatias e critérios de aceite
- **S1 runtime** (`apps/ted-runtime`): após `proposalIntents.take()`, se flag on e assurance
  ok ⇒ mint → propose → confirm → execute → outcome no gateway; resposta do chat traz
  `execution` (recibo/outcome) em vez de `proposal` acionável. Assurance ruim ⇒ resposta
  sem execução. Prompt do agente (`agent-system.mjs`) e descrições das tools atualizados:
  executar só com dados completos; perguntar em ambiguidade material.
  Aceite: testes novos em `apps/ted-runtime/tests/` cobrindo sucesso, assurance falha,
  409 not_actionable, execution_uncertain, idempotência (mesmo intentionId não executa 2x),
  flag off = comportamento antigo. `pnpm --filter @pi/ted-runtime test` (ver package.json) verde.
- **S2 PWA** (`apps/pwa`): com `execution` na resposta, renderizar recibo/estado terminal
  somente leitura (+ desfazer) sem botões Confirmar/Cancelar; manter card antigo quando a
  resposta traz `proposal` (flag off/fallback). Aceite: testes unit do TedChat/TedApprovalCard
  atualizados + novos; typecheck e lint verdes; E2E `ted-pending-ops` ajustados ao fixture.
- **S3 docs**: ADR curto `docs/adr/ADR-033-agente-confirma-pending-v2.md`, atualizar
  `docs/runbooks/ted-runtime-paridade-flags.md` (nova flag), corrigir
  `apps/ted-runtime/README.md:8` e `docs/security/approval-capability-inventory.md`.
- **Gate final**: `pnpm check:area` da área; `pnpm --filter` de api/contracts só se tocados.

## Pendências para o usuário
- Ligar `TED_AGENT_SELF_CONFIRM=1` no ambiente real (deploy é decisão do usuário).
- Avaliar teto de valor/exceção para pagar fatura e transferências após uso real.
