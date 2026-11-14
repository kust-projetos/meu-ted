# Saneamento final — 2026-11-14

Referência: `main@3d4e0c1` (CI `43607796925` e PWA CI `43607797036` verdes).
Nada foi deployado, mergeado ou alterado em produção. Relatório canônico desta
missão; backlog em [`PENDENCIAS.md`](../reference/PENDENCIAS.md) e
[`ROADMAP.md`](../ROADMAP.md).

## 1. Estado final da arquitetura

OpenCode (`apps/ted-runtime`) é o runtime conversacional principal. O A0
(`apps/agent`) permanece como fallback/rollback, broker único de
`financial.approval.propose` e emissor do live-sync. A API segue sendo a única
autoridade financeira; Pending V2 decide e executa. Live-sync ativo;
`TED_PRIVATE_VIEWS_ENABLED` OFF; WhatsApp fora de escopo. Nenhuma arquitetura
nova foi introduzida. Produção documentada: API `32a05cb`, Agent `15c9691`,
PWA `15c9691` (ATTESTED). Detalhe em
[`ARCHITECTURE-CURRENT.md`](../ARCHITECTURE-CURRENT.md).

## 2. Issues encerradas e justificativas

- **#151 — E2E determinístico:** fechada porque a suíte Playwright já é
  discover → validate → record → replay com fixture API, journal determinístico
  e sem LLM no caminho feliz (login, despesa, aprovação). Nenhum motor novo.
- **#136 — concorrência/recuperação:** fechada com provas existentes de
  renovação concorrente sem lost write, recuperação após restart e
  replay/dupla confirmação sem duplicar mutação
  (`DUPLICATE_FINANCIAL_EFFECT=0`).
- **#95 — DO keepalive:** fechada como não aplicável; `compatibility_date`
  `2026-07-01`, sem `waitUntil`/`schedule`/`setAlarm`/Workflow.
- **#131 — memória versionada:** não planejada nesta versão; promoção de skill
  já exige replay + safety + humano.
- **#134 — Clef-omni:** não planejado; áudio/visão default-off e decisão
  advisory.
- **#116 — views adaptativas:** fora do backlog ativo; preservada como
  possibilidade de produto.
- **PR #354 — encerrado sem merge:** `agents@0.3.10` exige `ai ^6`,
  `@ai-sdk/openai ^3` e `@ai-sdk/react ^3`, enquanto o PR mantém `ai ^5` e
  `openai ^2`; também sobe zod 3→4 em quatro diretórios.

## 3. Issues mantidas e respectivos motivos

- **#87 — KEEP + migração adiada:** o A0 ainda é necessário (broker, rollback,
  live-sync) e `agents`/`ai` são runtime. `@cloudflare/ai-chat` não tem
  consumidor real, mas foi retido porque o lockfile não pôde ser regenerado
  neste ambiente.
- **#235 — suspensa:** STT `TED_AUDIO_STT_ENABLED=0` e coorte vazia; residual
  de duração por formato documentado (F10).
- **#245 — gate humano:** purge de resíduos Test Family exige autorização,
  backup e escopo por household.
- **#246 — gate humano:** stores legacy só saem após cutover F3–F5
  ([ADR-024](../adr/ADR-024-legacy-canonical-conversion-policy.md)).

## 4. Correções realizadas

Nenhuma correção de código foi necessária: não houve defeito reproduzido nos
fluxos cobertos. A única dívida identificada — `@cloudflare/ai-chat` sem
consumidor real — não foi removida porque `pnpm install --lockfile-only`
excedeu 10 min em duas tentativas (inclusive offline); editar o lockfile à mão
não é aceitável. Fica registrada para remoção quando o lockfile puder ser
regenerado.

## 5. Testes executados e resultados

| Suíte | Escopo | Resultado |
|---|---|---|
| E2E jornadas críticas | auth + transaction-sheet + ted-pending-ops, `--retries=1` | 21/21 passed, 0 failed |
| Agent concorrência/memória | 6 arquivos focais (#136) | 132/132 |
| Agent failover | 3 arquivos de relay/failover | 44/44 |
| Runtime OpenCode | p0-recovery, retry-no-repeat, conversations, server | 40/40 |
| API Pending V2 | contract, adversarial, executor | 10/10 |
| Build Agent | `tsc --noEmit` | OK |
| Build PWA | `next build --webpack` | OK (~726 s) |

Journal do backend sintético verificado nas rotas de auth, despesa e
chat/decision. Com `--retries=0`, `AUTH-01/02` flakaram no cold start e
passaram no rerun; o gate oficial usa `--retries=1`, e o residual foi
registrado sem correção especulativa.

## 6. PRs criados, integrados ou pendentes

- **#354:** encerrado como incompatível (sem merge).
- **PR desta missão:** pendente de revisão/merge; contém apenas documentação
  (este relatório, `PENDENCIAS.md`, `ROADMAP.md`, `ARCHITECTURE-CURRENT.md` e
  `runtime-facts.json`).

## 7. Dependências humanas

- #245 e #246: decisão de operador, backup prévio e autorização explícita.
- Merge e deploy deste PR: autorização explícita; nenhum deploy foi executado.

## 8. Próximos passos estritamente necessários

1. Revisar e mergear o PR de documentação.
2. #246/#245 apenas quando houver autorização e backup.
3. #87 somente se houver necessidade funcional de AI SDK v6.
4. #235 somente quando a reativação de áudio for decidida.
