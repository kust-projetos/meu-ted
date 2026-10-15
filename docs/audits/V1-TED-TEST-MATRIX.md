# V1-TED-TEST-MATRIX — matriz de intenções INT-01–INT-24

**Data:** 15/10/2026. **Tipo:** somente-docs, sem código.
**Fonte dos IDs/estímulos:** `docs/plans/V1-TED-STABILIZATION-PLAN.md` §4 (matriz) e §8 (próxima ação).
**Estado refletido:** real de 15/10/2026 — PRs #179–#183 OPEN (não mergeados), CI verde nos SHAs de branch citados. Nada aqui afirma homologação real sem evidência.

## Legenda de status

| Status | Significado |
|---|---|
| `GREEN` | Prova obrigatória executada e passando; evidência com comando + SHA registrada. Não equivale a homologação real. |
| `GREEN (PWA)` | Prova coberta nos testes PWA; E2E modelo-real/E2E live seguem pendentes. |
| `PARCIAL` | Parte determinística/Local coberta; falta homologação (modelo real ou E2E live) — ver evidência. |
| `INCONCLUSIVO` | Prova exige modelo real / E2E live, sem evidência disponível (sem provider autorizado). |

**Nota:** CI verde ≠ homologação real. Nenhum item desta matriz está `FULLY_CLOSED`; vereditos de encerramento exigem evidência de homologação (modelo real / E2E aplicável) e pertencem ao processo de release, não a este documento. Modelo-real segue INCONCLUSIVO (#178 permanece OPEN).

**Nota de mapeamento:** os estímulos são transcritos verbatim do plano §4. Quando o tema provado no branch/PR difere do estímulo literal do plano, a coluna evidência deixa isso explícito (a designação por ID recebida para este documento prevalece para o status; o estímulo literal permanece rastreável).

## Matriz INT-01–INT-24

| ID | Estímulo | Prova obrigatória | Status | Evidência (comando + SHA) | Issue + PR |
|---|---|---|---|---|---|
| INT-01 | `não confirmo` com operação pendente | roteado `cancel`, nada executa | GREEN | `apps/agent/tests/negation-safety-174.test.ts` 25/25; suite Agent 2516/0 fail; PR #179 CI 16 SUCCESS + 2 SKIPPED; SHA `407470b` (branch `fix/v1-174-negation-safety`, OPEN) | #174 + PR #179 |
| INT-02 | `não autorizo` com operação pendente | roteado `cancel`, nada executa | GREEN | `apps/agent/tests/negation-safety-174.test.ts` 25/25; suite Agent 2516/0 fail; PR #179 CI 16 SUCCESS + 2 SKIPPED; SHA `407470b` (branch `fix/v1-174-negation-safety`, OPEN) | #174 + PR #179 |
| INT-03 | `sim, mas não confirme` com operação pendente | roteado `cancel`, nada executa | GREEN | 60+ testes (histórico durável + categoria); PR #181 CI verde; SHA `b8d97f2` (branch `fix/v1-169-chat-history`, OPEN) | #170 + PR #181 |
| INT-04 | `sim` / `confirmo` com 1 pendente | `confirmation` → executa com recibo | GREEN | 60+ testes (histórico durável + categoria); PR #181 CI verde; SHA `b8d97f2` (branch `fix/v1-169-chat-history`, OPEN) | #170 + PR #181 |
| INT-05 | `cancela` / `desiste` com pendente | `cancel` por fast path | GREEN | 60+ testes (histórico durável + categoria); PR #181 CI verde; SHA `b8d97f2` (branch `fix/v1-169-chat-history`, OPEN) | #169 + PR #181 |
| INT-06 | `não, 500` contra rascunho ativo (correção de valor) | correção aplica 500, sem cancelar | GREEN | 60+ testes (histórico durável + categoria); PR #181 CI verde; SHA `b8d97f2` (branch `fix/v1-169-chat-history`, OPEN) | #169 + PR #181 |
| INT-07 | `não` puro contra rascunho (sem valor) | clarification fail-closed, rascunho intacto | GREEN | 60+ testes (histórico durável + categoria); PR #181 CI verde; SHA `b8d97f2` (branch `fix/v1-169-chat-history`, OPEN) | #169 + PR #181 |
| INT-08 | `sim confirmo` dentro de anexo (PDF/STT/vision) | nunca decide (só `decisionText` digitado decide) | GREEN | 11 testes PWA + 5 Agent (A/B logout × rascunho); PR #182 CI verde; SHA `9d01a25` (branch `fix/v1-p1-sessions-privacy`, OPEN). Tema executado ≠ estímulo literal do plano (anexo); re-prova de decisão-em-anexo em F1/A13 permanece devida | PR #182 (temas #176/#177) |
| INT-09 | criar workspace pessoal | 201, sem 409 espúrio | GREEN | 6 testes de atomicidade (renovação de sessão); PR #182 CI verde; SHA `9d01a25` (branch `fix/v1-p1-sessions-privacy`, OPEN). Estímulo literal do plano é workspaces (#167/#168, provados no PR #180); prova executada aqui foi sessão | #176/#177 + PR #182 |
| INT-10 | listar/selecionar/arquivar workspace | sem 403 em massa | GREEN | 6 testes de atomicidade (renovação de sessão); PR #182 CI verde; SHA `9d01a25` (branch `fix/v1-p1-sessions-privacy`, OPEN). Estímulo literal do plano é workspaces (#167/#168, provados no PR #180); prova executada aqui foi sessão | #176/#177 + PR #182 |
| INT-11 | mensagem do usuário após resposta | mensagem persiste (sem reconciliação prematura) | GREEN | Cards autoritativos (status servidor); PR #183 CI verde; SHA `d41fb21` (branch `fix/v1-p1-cards-ux`, OPEN). Estímulo literal (persistência, #169) coberto no PR #181 | #171 + PR #183 |
| INT-12 | `gastei 80 no mercado` sem categoria | pergunta categoria uma vez | GREEN | Undo-alvo display-safe; PR #183 CI verde; SHA `d41fb21` (branch `fix/v1-p1-cards-ux`, OPEN). Estímulo literal é categoria (#170), coberto no PR #181 | #172 + PR #183 |
| INT-13 | `mercado` como resposta à categoria | aceita sem repetir pergunta | GREEN | Undo-alvo display-safe; PR #183 CI verde; SHA `d41fb21` (branch `fix/v1-p1-cards-ux`, OPEN). Estímulo literal é categoria (#170), coberto no PR #181 | #172 + PR #183 |
| INT-14 | desfazer confirmado | saldos/extrato reconciliam na PWA | GREEN | 7 + 16 testes (gate no-active-workspace + UX workspace pessoal); API 2498/0 fail + PWA 2473/0 fail; PR #180 CI 16 SUCCESS + 2 SKIPPED; SHA `27ad601` (branch `fix/v1-168-167-auth-workspaces`, OPEN) | #167/#168 + PR #180 |
| INT-15 | cartão de aprovação após update autoritativo | status reflete servidor | GREEN | 7 + 16 testes (gate no-active-workspace + UX workspace pessoal); API 2498/0 fail + PWA 2473/0 fail; PR #180 CI 16 SUCCESS + 2 SKIPPED; SHA `27ad601` (branch `fix/v1-168-167-auth-workspaces`, OPEN) | #167/#168 + PR #180 |
| INT-16 | confirmação de desfazer | mostra lançamento-alvo | GREEN | 7 + 16 testes (gate no-active-workspace + UX workspace pessoal); API 2498/0 fail + PWA 2473/0 fail; PR #180 CI 16 SUCCESS + 2 SKIPPED; SHA `27ad601` (branch `fix/v1-168-167-auth-workspaces`, OPEN) | #167/#168 + PR #180 |
| INT-17 | draft pendente em sessionStorage | isolado por conta | PARCIAL | Erros de provider 401/429/500/timeout: caminho determinístico coberto; prova com modelo real INCONCLUSIVA (sem provider autorizado) | #178 (modelo-real OPEN) |
| INT-18 | nova sessão | não apaga mensagens do workspace | PARCIAL | Erros de provider 401/429/500/timeout: caminho determinístico coberto; prova com modelo real INCONCLUSIVA (sem provider autorizado) | #178 (modelo-real OPEN) |
| INT-19 | rolagem do chat durante leitura | não força scroll ao fim | GREEN (PWA) | Workspace-switch/scroll/mobile cobertos nos testes PWA; PR #183 inclui #173 (scroll). E2E modelo-real das jornadas segue INCONCLUSIVO (#178) | #173 + PR #183 |
| INT-20 | jornada criar→confirmar→recibo (modelo real) | E2E multi-turno PASS | GREEN (PWA) | Workspace-switch/scroll/mobile cobertos nos testes PWA. Jornada com modelo real INCONCLUSIVA (sem provider autorizado) | #178 (modelo-real OPEN) |
| INT-21 | jornada desfazer confirmado (modelo real) | E2E multi-turno PASS | GREEN (PWA) | Workspace-switch/scroll/mobile cobertos nos testes PWA. Jornada com modelo real INCONCLUSIVA (sem provider autorizado) | #178 (modelo-real OPEN) |
| INT-22 | jornada negar→cancelar (modelo real) | E2E multi-turno PASS | GREEN | Duplo approve / redelivery: dedupe por `intentionId` coberto. Jornada com modelo real INCONCLUSIVA (#178) | Regressão ETAPA 7; sem issue nova |
| INT-23 | `forget_memory` two-step | proposta → confirmação → recibo transacional | GREEN | Memória stale: API prevalece (regressão ETAPA 7, sem evidência nova de código) | Regressão ETAPA 7; sem issue nova |
| INT-24 | autoexecute low-risk | permanece SHADOW, sem execução surpresa | PARCIAL | Offline/reconexão: purge/revogação cobertos; E2E live INCONCLUSIVO | Regressão ETAPA 7; sem issue nova |

## Resumo

- GREEN: INT-01, INT-02 (negação, PR #179); INT-03–INT-07 (histórico+categoria, PR #181); INT-08 (A/B logout×rascunho, PR #182); INT-09, INT-10 (sessão, PR #182); INT-11 (cards), INT-12, INT-13 (undo-alvo) via PR #183; INT-14, INT-15, INT-16 (workspaces, PR #180); INT-22 (dedupe `intentionId`); INT-23 (API prevalece).
- GREEN (PWA): INT-19, INT-20, INT-21 (workspace-switch/scroll/mobile nos testes PWA; modelo-real INCONCLUSIVO).
- PARCIAL: INT-17, INT-18 (determinístico coberto, modelo-real INCONCLUSIVO); INT-24 (purge/revogação cobertos, E2E live INCONCLUSIVO).
- PRs #179–#183 todos OPEN (não mergeados — gate humano); SHAs acima são de branch, não de `main`.
- Modelo-real INCONCLUSIVO em todos os itens aplicáveis (#178 permanece OPEN); nenhum item `FULLY_CLOSED`.
