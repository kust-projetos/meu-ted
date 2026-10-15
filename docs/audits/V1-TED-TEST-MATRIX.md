# V1-TED-TEST-MATRIX — matriz de intenções INT-01–INT-24

**Data:** 15/10/2026 (FASE 7 — reconciliação pós-lotes A/BC/188/178/melhorias). **Tipo:** somente-docs, sem código.
**Base:** `main` em `056da43`.
**Fonte dos IDs/estímulos:** `../plans/V1-TED-STABILIZATION-PLAN.md` §4 (matriz) e §8 (próxima ação).
**Estado refletido:** real de 15/10/2026 — PRs #192–#196 OPEN (não mergeados), CI verde nos SHAs citados. PRs #179–#183 (citados na versão anterior desta matriz) têm evidência superseded ante a base `056da43`; status atual deles não confirmado neste worker (sem `gh`) — ver suplemento. Nada aqui afirma homologação real sem evidência.

## Legenda de status

| Status | Significado |
|---|---|
| `GREEN` | Prova obrigatória executada e passando (determinística, PG descartável ou PWA, conforme a coluna evidência); comando + SHA registrados. Não equivale a homologação real nem a merge. |
| `GREEN (PWA)` | Prova coberta nos testes PWA; E2E modelo-real/E2E live seguem pendentes. |
| `PARCIAL` | Parte determinística/local coberta, ou prova anterior superseded sem re-prova rastreada — ver evidência. |
| `INCONCLUSIVO` | Prova exige modelo real / E2E live, sem evidência disponível (sem provider autorizado / sem credenciais). |

**Nota:** CI verde ≠ homologação real ≠ merge. Nenhum item desta matriz está `FULLY_CLOSED`; vereditos de encerramento exigem merge + evidência de homologação (modelo real / E2E aplicável) e pertencem ao processo de release, não a este documento. Modelo-real segue INCONCLUSIVO (#178 OPEN, PR #195 test-only).

**Nota de mapeamento:** os estímulos são transcritos verbatim do plano §4. Quando o tema provado no PR difere do estímulo literal do plano, a coluna evidência deixa isso explícito. Associações evidência↔cenário corrigidas nesta FASE 7: INT-14–INT-16 passam a apontar #175/#188 (undo) em vez de workspaces; INT-12/INT-13 passam a apontar #170 (categoria); INT-11 aponta #171 (cards).

## Matriz INT-01–INT-24

| ID | Estímulo | Prova obrigatória | Status | Evidência (comando + SHA) | Issue + PR |
|---|---|---|---|---|---|
| INT-01 | `não confirmo` com operação pendente | roteado `cancel`, nada executa | GREEN | #174 CLOSED (única fechada; SHA de merge do fix a confirmar). Prova determinística histórica: `apps/agent/tests/negation-safety-174.test.ts` 25/25 (PR #179 superseded, SHA `407470b`) | #174 CLOSED |
| INT-02 | `não autorizo` com operação pendente | roteado `cancel`, nada executa | GREEN | idem INT-01 | #174 CLOSED |
| INT-03 | `sim, mas não confirme` com operação pendente | roteado `cancel`, nada executa | PARCIAL | Prova anterior em PR superseded (#181, SHA `b8d97f2`); sem re-prova rastreada nos lotes FASE 7 (PR #196 não rastreado issue-a-issue — confirmar) | #170 OPEN |
| INT-04 | `sim` / `confirmo` com 1 pendente | `confirmation` → executa com recibo | PARCIAL | Prova anterior superseded (#181, `b8d97f2`); guarda de geração + chave por intent do lote A (#185, PR #192 `895440f`/`94ddeee`, tester 143/143 + typecheck, CI verde) cobre duplo-tap mas não re-prova o caminho feliz — re-prova devida | #170 OPEN; #185 PR #192 OPEN |
| INT-05 | `cancela` / `desiste` com pendente | `cancel` por fast path | PARCIAL | Prova anterior superseded (#181, `b8d97f2`); sem re-prova rastreada nos lotes FASE 7 | #169 OPEN |
| INT-06 | `não, 500` contra rascunho ativo (correção de valor) | correção aplica 500, sem cancelar | PARCIAL | Prova anterior superseded (#181, `b8d97f2`); sem re-prova rastreada nos lotes FASE 7 | #169 OPEN |
| INT-07 | `não` puro contra rascunho (sem valor) | clarification fail-closed, rascunho intacto | PARCIAL | Prova anterior superseded (#181, `b8d97f2`); sem re-prova rastreada nos lotes FASE 7 | #169 OPEN |
| INT-08 | `sim confirmo` dentro de anexo (PDF/STT/vision) | nunca decide (só `decisionText` digitado decide) | PARCIAL | Prova anterior em PR superseded (#182, SHA `9d01a25`); re-prova de decisão-em-anexo em F1/A13 permanece devida | #176 OPEN (tema anexo); re-prova F1/A13 devida |
| INT-09 | criar workspace pessoal | 201, sem 409 espúrio | PARCIAL | Prova anterior em PR superseded (#180, SHA `27ad601`); 409 tipado por code do lote A (#184, PR #192 `0099ae9`) trata conflito de domínio conta/categoria — não re-prova workspaces | #167 OPEN; #184 PR #192 OPEN (tema adjacente) |
| INT-10 | listar/selecionar/arquivar workspace | sem 403 em massa | PARCIAL | Prova anterior superseded (#180, `27ad601`); sem re-prova rastreada nos lotes FASE 7 | #168 OPEN |
| INT-11 | mensagem do usuário após resposta | mensagem persiste (sem reconciliação prematura) | PARCIAL | Prova anterior (cards autoritativos) em PR superseded (#183, SHA `d41fb21`); sem re-prova rastreada | #171 OPEN |
| INT-12 | `gastei 80 no mercado` sem categoria | pergunta categoria uma vez | PARCIAL | Estímulo é categoria (#170 OPEN), não undo; prova anterior superseded (#181, `b8d97f2`); sem re-prova rastreada | #170 OPEN |
| INT-13 | `mercado` como resposta à categoria | aceita sem repetir pergunta | PARCIAL | idem INT-12 | #170 OPEN |
| INT-14 | desfazer confirmado | saldos/extrato reconciliam na PWA | PARCIAL | Lote #188 (PR #194 `1536164` + `c42a63f`): 46/46 PG descartável + typecheck, CI verde, review com limitação declarada (guardless sem re-execução independente). PR OPEN (sem merge); reconciliação PWA/extrato sem re-prova rastreada | #175 OPEN; #188 PR #194 OPEN |
| INT-15 | cartão de aprovação após update autoritativo | status reflete servidor | PARCIAL | Prova anterior superseded (#183, `d41fb21`); sem re-prova rastreada nos lotes FASE 7 | #171 OPEN |
| INT-16 | confirmação de desfazer | mostra lançamento-alvo | PARCIAL | Prova anterior superseded (#183, `d41fb21`); lote #188 cobre undo in-memory mas não o lançamento-alvo no card — re-prova devida | #172 OPEN; #188 PR #194 OPEN (tema adjacente) |
| INT-17 | draft pendente em sessionStorage | isolado por conta | PARCIAL | Caminho determinístico de erros coberto pelo lote BC (#186, PR #193: timeouts até corpo + fail-closed; CI verde, agent suite 2589 + focados + typecheck, review APPROVED); prova com modelo real INCONCLUSIVA | #176 OPEN; #186 PR #193 OPEN |
| INT-18 | nova sessão | não apaga mensagens do workspace | PARCIAL | idem INT-17 (determinístico coberto via #186; modelo-real INCONCLUSIVO) | #177 OPEN; #186 PR #193 OPEN |
| INT-19 | rolagem do chat durante leitura | não força scroll ao fim | PARCIAL | Prova PWA anterior em PR superseded (#183); sem re-prova rastreada nos lotes FASE 7; E2E modelo-real INCONCLUSIVO (#178) | #173 OPEN |
| INT-20 | jornada criar→confirmar→recibo (modelo real) | E2E multi-turno PASS | INCONCLUSIVO | PR #195 (test-only: `ce245b8` + `d4aeaa0` + `b3d8f51` + `67fbe5f`, validação estática typecheck + eslint + collect); live NÃO executado (sem credenciais) | #178 OPEN |
| INT-21 | jornada desfazer confirmado (modelo real) | E2E multi-turno PASS | INCONCLUSIVO | idem INT-20 | #178 OPEN |
| INT-22 | jornada negar→cancelar (modelo real) | E2E multi-turno PASS | GREEN (determinístico) / INCONCLUSIVO (live) | Determinístico: dedupe por `intentionId` coberto — #187 (`intentionId` obrigatório, PR #193, suite 2589, CI verde) + #185 (chave por intent, PR #192, 143/143). Jornada com modelo real INCONCLUSIVA (#178) | #187 PR #193 OPEN; #185 PR #192 OPEN; live #178 OPEN |
| INT-23 | `forget_memory` two-step | proposta → confirmação → recibo transacional | PARCIAL | Regressão ETAPA 7 sem evidência nova de código nos lotes FASE 7; re-prova devida | Regressão ETAPA 7; sem issue nova |
| INT-24 | autoexecute low-risk | permanece SHADOW, sem execução surpresa | PARCIAL | Sem mudança registrada na FASE 7 (permanece SHADOW por configuração); E2E live INCONCLUSIVO | Regressão ETAPA 7; sem issue nova |

## Resumo

- GREEN: INT-01, INT-02 (#174 CLOSED; SHA de merge do fix a confirmar); INT-22 somente no determinístico (dedupe `intentionId` nos PRs #192/#193 OPEN — sem merge).
- GREEN (PWA): nenhum nesta FASE 7 (provas PWA anteriores vieram de PR superseded #183).
- PARCIAL: INT-03–INT-19 (prova anterior superseded ou cobertura só-determinística em PR OPEN), INT-23, INT-24.
- INCONCLUSIVO: INT-20, INT-21 (modelo-real, PR #195 test-only); lado live de INT-22; lado modelo-real de INT-17/INT-18.
- PRs #192–#196 todos OPEN (não mergeados — gate humano); SHAs acima são de branch, não de `main` (`056da43`).
- Modelo-real INCONCLUSIVO em todos os itens aplicáveis (#178 OPEN); nenhum item `FULLY_CLOSED`.
- Vereditos por issue e limitações: `V1-TED-AUDIT-2026-10-15-SUPLEMENTO.md`.
