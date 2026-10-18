# ADR-028 — Undo implícito por ator-próprio (política de eleição de alvo)

**Status:** Aceita pelo operador em 2026-10-18 (opção A, entre A/próprio-always, B/status-quo e C/só-próprio total)
**Data:** 2026-10-18

## Contexto

O undo sem apontamento (`lastOperationId` ausente) elege o alvo por heurística.
O mecanismo vigente (`src/approvals/undo.ts:184-193`, FIX-188) é fail-closed na
eleição de **head**: preferência pelo próprio ator e, **quando ele não tem
nenhuma operação própria no workspace, fallback para a head do household**
(a operação mais recente, de qualquer ator). Head já consumida nunca leva a
walk-back silencioso para predecessor — o chamado recebe
`undo.nothing_to_undo`. O apontamento explícito por `lastOperationId` exige
match exato entre candidatos do workspace e mantém reversão atômica com claim
síncrono e registro idempotente.

Este contrato ficou **bloqueado esperando decisão do operador** desde a onda
de remediação (plano `docs/superpowers/plans/2026-10-17-full-project-review-remediation.md`,
T09 linha 173: "operador define se undo implícito é só próprio ou pode eleger
head do workspace. Não remover fallback nem habilitar cross-actor explícito
adicional antes dessa definição."). O pré-requisito factual (T09 fatia
factual: proveniência de ator persistida em `operation_records`/`audit_logs`,
PR #222 squash `4c40ae05`) já está fechado e em produção, o que permite
executar a decisão sem ampliar superfície de provider/legado (escopo de undo
separado do Pending V2 permanece o de ADR-021).

## Decisão (opção A — operador, 2026-10-18)

1. **Undo implícito elege SOMENTE operação do próprio ator.** Sem
   `lastOperationId`, o pool de candidatos é sempre filtrado por
   `actorId === actor`; o fallback para head do household é removido. Ator
   sem operação própria no workspace recebe `undo.nothing_to_undo` — nunca
   eleger, nem walk-back, nem head de terceiro.
2. **Correção cross-actor permanece possível por apontamento explícito:
   nomear = autorizar.** `lastOperationId` nomeando operação de outro ator no
   MESMO workspace continua válido, com o pipeline existente de confirmação
   vinculada ao alvo exibido (receipt canônico: `receipt.operationId` =
   pending ID e `receipt.entity.id` = alvo; SPEC V3 §9/§10; resultado incerto
   permanece `executing`, sem falso estado — ADR-013).
3. **Demais invariantes do FIX-188 preservados**: head consumida →
   `undo.nothing_to_undo` (nunca predecessor silencioso); claim síncrono
   garantindo único dono por `household:entity` em produção concorrente;
   `not_found` da reversão mapeado para `undo.nothing_to_undo`; replay por
   `Idempotency-Key` retorna o resultado canônico sem re-executar.
4. **Contrato externo inalterado.** Rotas, PWA e Agent não mudam: código de
   erro permanece `undo.nothing_to_undo`; nenhuma capacidade nova é exposta e
   nenhuma presunção de cliente é removida. A única mudança semântica é o
   undo implícito deixar de alcançar operações de terceiro.
5. **Auditoria de dependência do fallback:** a fatia de implementação deve
   verificar que nenhum fluxo intencional de Agent/PWA/API depende da
   heurística removida para funcionar; qualquer dependência encontrada vira
   descoberta a corrigir por apontamento explícito de `lastOperationId` com
   confirmação (nunca reintrodução silenciosa da heurística).

## Matriz de aceite (fecho da fatia decisória T09)

Especificada no plano T09 (linha 174) e executada na fatia:

- **Dois atores/dois workspaces**: undo implícito de A não alcança nem reverte
  operação do workspace B, nem operação de outro ator no workspace A
  (`undo.nothing_to_undo`); isolamento simétrico de B.
- **Head já consumida**: ator cuja única operação própria já foi revertida, com
  operação mais recente de terceiro no workspace → 404, sem eleger
  predecessor de terceiro.
- **Alvo explícito não autorizado**: `lastOperationId` de operação de OUTRO
  workspace → 404 `undo.nothing_to_undo` (sem `not_found` cru).
- **Cross-actor explícito autorizado (política A)**: ator B nomeando o id da
  operação de A no mesmo workspace → 200 com receipt vinculando o alvo exibido.
- **Redelivery**: mesmo `Idempotency-Key` no fluxo acima retorna o resultado
  canônico sem nova reversão.
- **Concorrência**: produtores concorrentes com keys distintos convergem para
  um único dono do claim `household:entity`; perdedores recebem
  `undo.nothing_to_undo`.
- **Zero reversão silenciosa de predecessor** permanece em todos os cenários.

## Consequências

- **Positivos:** menor superfície de autoridade (menor privilégio); eleição
  por heurística de operação de terceiro deixa de existir; matriz T09
  definitiva executada ponta a ponta; proveniência de ator (T09 factual)
  fornece o campo de filtração já persistido em produção.
- **Trade-off:** households colaborativos perdem o atalho implícito para
  desfazer operação do parceiro; a correção de operação de terceiro exige
  nomear o alvo e confirmar — deliberada e auditável por construção.
- **Risco e mitigação:** identidade inconsistente entre rota→undo e
  writer→records romperia a comparação `actorId`; a fatia conduz
  stop-and-report se tal divergência for observada (a fatia factual do T09
  já grava `actor_id`/`actor_type` conforme PR #222 e ADR-026).
- **Rollback:** reverter o commit da fatia restaura o fallback own-first →
  household head; sem migrations e sem mudança de contrato de rota.

## Registros de execução

- Implementação: branch `feat/t09-undo-own-only` (`src/approvals/undo.ts`
  eleição own-only + matriz RED→GREEN), review forte independente, PR e CI
  required checks; release na Contabo somente se o delta de API for código
  (pela via autorizada: wrapper `api-release-20260930.sh`), com smokes
  read-only e rollback tag.
- Referências: FIX-188 (`undo.ts`), SPEC V3 §9/§10, ADR-013 (receipt),
  ADR-021 (undo separado do Pending V2), plano de remediação T09 (linhas
  171-174).
