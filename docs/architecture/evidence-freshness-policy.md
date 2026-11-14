# Política de atualidade das evidências

## Escopo

Esta política rege claims financeiros e narração no Agent (`apps/agent`). A API (`apps/api`) continua sendo a única fonte da verdade financeira: a política não transfere nem duplica essa autoridade.

## Leituras cobertas

| Tipo de leitura | Origem |
| --- | --- |
| Saldos e totais por conta | `api.accounts` |
| Extrato e transações | `api.transactions` |
| Resumo mensal | `api.month-summary` |
| Cartões | `api.cards` |
| Faturas | `api.statements` |
| Contas a pagar | `api.payables` |
| Orçamentos | `api.budgets` |
| Metas | `api.goals` |
| Categorias | `api.categories` |
| Indicadores e detalhamento por categoria | `api.analytics.kpis`, `api.analytics.category-breakdown` |

Qualquer cifra, contagem ou nome financeiro narrado exige item `ok` e fresco no envelope do turno. Dados estruturais resolvidos no servidor (workspace, ator e device), memória do usuário e texto do histórico da conversa não são evidência financeira. Mensagens anteriores podem ser repetidas pelo modelo, mas nunca sustentam um claim sem evidência fresca.

## Janela e validação

`EVIDENCE_FRESHNESS_WINDOW_MS = 5 * 60_000` em `apps/agent/src/evidence/evidence-envelope.ts:57`. A coleta ocorre dentro do próprio turno e é carimbada pelo Worker; a janela detecta reuso ou atraso anômalo, não serve para manter cache. `retrievedAt` inválido, no futuro ou fora da janela torna o item vencido.

| Regra | Comportamento |
| --- | --- |
| R1 — suporte | Claim financeiro só é válido se sustentado por item `ok` (`apps/agent/src/evidence/grounding-validator.ts`). |
| R2 — descarte | `runGroundedRead` avalia `assessEvidenceFreshness` após a coleta e antes do render determinístico e da narração. Emite `agent.evidence.stale` e descarta itens `ok` vencidos do envelope (`apps/agent/src/orchestration/conversation-orchestrator.ts`, bloco `agent.evidence.stale`). |
| R3 — falha fechada | Se havia item `ok` e nenhum fresco resta, o turno retorna `FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT`; não narra ausência nem inventa valor. |
| R4 — eixos distintos | `empty` e `error` não significam staleness; ausência e falha são tratadas separadamente (A04/R04). |
| R5 — nova leitura | Sem refresh dedicado: `MAX_EVIDENCE_READS = 2` e `readCache` são por `intentionId`; redelivery pode reutilizar item cacheado, que o gate descarta. Falha fechada, por limitação declarada. |
| R6 — contradição | Se a mesma leitura tem item vencido e atual, o vencido é descartado e só o atual sustenta a resposta. Claim dependente do valor antigo falha a validação e aciona a única correção de grounding (`apps/agent/src/responses/grounded-response.ts`), com reavaliação explícita. Se persistir, falha fechada. |

## Ações consequenciais

A atualidade da leitura não substitui as precondições autoritativas da API:

- `apps/api/src/approvals/tool-registry.ts:944-957`: `executePayablePay` compara a conta a pagar autoritativa antes de debitar; se mudou, falha fechado com “Os dados da conta a pagar mudaram; refaça a proposta.”
- `apps/api/src/approvals/presentation.ts:266-273`: `accounts.update` degrada o card quando o `expectedName` não confere com o nome atual resolvido pelo servidor.
- `apps/agent/src/mutations/mutation-proposal.ts:6-16`: a proposta é vinculada por `proposalHash` e `idempotencyKey`; o Agent não repropõe automaticamente.

Portanto, “refresh nunca duplica mutação” é garantido por construção: o caminho de leitura só executa READs, e o Agent não recalcula nem reenvia a proposta ao confirmar.

## Telemetria e evidências

Telemetria registra contagens e latência, nunca payload financeiro: `tool.started`/`tool.completed` por leitura, `agent.evidence.stale` (com `intentionId`, `traceId`, `domain`, `staleCount`, `currentCount`) e `agent.grounding.validated`/`rejected`/`correction_*`.

Cobertura de regressão: `TEDV2-035` (evidência vencida), `TEDV2-064` (vencida não publica valor), `TEDV2-065` (fresca publica) e `TEDV2-066` (contradição antigo × novo), em `apps/agent/evals/ted-v2-regression-matrix.json`; também `apps/agent/tests/evidence/evidence-envelope.test.ts` e `apps/agent/tests/orchestration/attachment-grounded-evidence.test.ts`.

## Limites

Uma coleta que exceda cinco minutos falha fechada. O memo de leitura é por intenção/turno, nunca entre turnos. O histórico textual não é revalidado: simplesmente não sustenta claim.
