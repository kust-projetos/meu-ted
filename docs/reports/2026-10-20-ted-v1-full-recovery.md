# TED V1 — recuperação completa (skills, entidades, routing, POC) — closure

**Data:** 2026-10-20
**Branches/PRs:** `feat/ted-v1-full-recovery` → #266 (squash `b56ec67`) + #267 (squash `6c76a66`)
**Produção:** Agent/PWA `6c76a66` (ATTESTED), API `0405fba` (inalterada)
**Status:** DONE (código + deploy + E2E live)

## Escopo entregue

- **Skills (Fase 4, #236/#237):** `toolSkillLines()`/`selectToolsFor` fonte única; `skill-inventory.ts` deletado; `intent-router` usa catálogo canônico; teste `skills-single-catalog` (contrato + teto 8 com priorização das tools planejadas).
- **Surface V1 (#238):** contrato trava `get/confirm/cancel_pending` + `undo_last_action` fora do modelo (testado nos 3 call sites).
- **Entidades:** `tools/entity-resolution.ts` deletado (sem caller); `mutations/entity-resolver.ts` autoritativo; `confirmation-roles-contract` trava os 3 papéis (guarda/construtor/projeção).
- **Routing (POC S7/S8/S3 + review):** conceito→general ("O que é cartão?"); ano-como-valor bloqueado (isenção só com marcador colado; "total de 2020"/"em reais em janeiro de 2020"→leitura/unsupported); ano isolado→`unsupported_year` honesto; fatura nua→`list_statements`; ausência de statements diz "faturas" (fix S3-wording #267); `requestedTools` prioriza o plano.
- **POC reads-only (Fase 2):** `apps/agent/src/poc-minimal/` isolado + `docs/agent-recovery/04-poc-comparison.md` (A×B; C bloqueado por gate de custo). Decisão CONFIRMADA: `deterministic_fix`; `sdk_loop` experimento isolado.
- **Frontend (Fase 7):** auditoria concluiu sem mudanças — 1 fonte de decisão já vale (162 testes verdes). #239–#242 = post-V1 (labels GH).
- **Não feito por decisão registrada:** colapso `llm/*` (P8, sem bug demonstrado); unificação `undoLastAction` legado (arquitetural); re-probe C com modelo de referência (gate de custo).

## Evidências

- Suite agent 2905 passed/1 skipped (final), tsc limpo, 3 rodadas reviewer (2× CHANGES_REQUIRED com P1/P2 reais endereçados → APPROVED P0/P1 zero), tester PASS.
- CI PRs + CI main verdes (2 flakes `t07c-workspace-cold-boot` `unreachable` vs `unauthenticated` — mesmo teste, verde no rerun; registrar como flake conhecido).
- Deploys ATTESTED `b56ec67` e `6c76a66` (pares 13–15s = corrida workflow_run conhecida).
- E2E live: regressão `live-ted-conversation` PASS (1.7–1.8m) em ambos os SHAs; S7/S8 sem mutação; S3 "faturas" nunca "conta a pagar"; #256 com totais (seed R$ 42,50 removido, resíduo zero — sessão anterior).
- Anomalias de harness (não bloqueiam): fetch direto 403 vs app 200 (investigar endurecimento pós-Release-B); login flakou 2× (throttle/cold start).

## Critérios de aceite (SPEC §20)

Todos atendidos no escopo V1; rollback = revert (sem migração). Issues #236–#238 fecháveis por este trabalho; #239–#242 post-V1; follow-ups: fast-path plural, prefixos lexicais, `undoLastAction`, agregação anual, fetch-403, flake `t07c`.
