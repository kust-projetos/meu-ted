# TED Inteligente V1 — implementação P1 (A10, A06, A08)

**Data:** 2026-10-03 · **Branch:** `feat/ted-agent-inteligente-v1-p0` · **Base do P0:** `2e5e88b`
**Commits:** `0073eab` (A10) · `d327f88` (A06) · `f276c89` (A08)
**Artefatos:** [SPEC](../MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md) · [PLAN](../MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md) · [Relatório P0](2026-10-03-ted-inteligente-v1-impl-a03-a01.md)
**Autorização:** operador autorizou nesta sessão a continuação autônoma da implementação do PLAN. Orquestração: Planner (OpenCode) + MCP jev (gates/decisões) + subagents nativos coder/tester/reviewer com participação observada por fatia e ciclo RED→GREEN→review→fix→re-review.

## Resultado

Três fatias implementadas, revisadas e commitadas; nenhum deploy, migration ou mudança de flag (INV-12 preservado). A07 permanece bloqueada pelos gates humanos G01/G02; A09-integração por G03; A13–A18 por G04/G05/G06 — nenhuma foi iniciada.

| Fatia | Requisito | Entrega principal | Suíte Agent |
| --- | --- | --- | --- |
| A10 | R10 (AC20/AC30) | Teto compartilhado de 2 recuperações/turno (grounding retry conta 1), fingerprint sha256 anti-repetição (kind/args/escopo/revisão+hint), paradas seguras (`budget_exhausted`/`no_new_strategy` → esclarecimento), accounting numérico sanitizado (`turn.budget`) | 911 → 940 |
| A06 | R06 (AC12/AC13) | `semantic-interpretation.ts`: normalização delimitada pt-BR (abreviações `gstei/d/hj/nubnk`), candidato validado com proveniência por campo, esclarecimento determinístico para aproximação/moeda/datas contraditórias/negação; roteamento real honra a ambiguidade (não cai em leitura); draft ativo não contorna; conta é pista de texto (A08 resolve) | 940 → 982 |
| A08 | R08 (AC08/AC17) 🔴 | Ordem explicit > confirmed > determinístico > `semantic_candidate` (≤3, nunca seleciona) > esclarecimento; revalidação imediata antes dos 3 pontos de propose; alias/ID morto/inativo/fora-do-escopo invalidado; scope do reader ligado com equivalência provada (`workspaceId` → claim → `household_id`); guarda anti-substituição-silenciosa (nome citado mais específico que a ativa casada → esclarece, inclusive minúscula/aspas/alias confirmado) | 982 → 1031 |

Ciclos de review: A10 (1 rodada — hook observacional isolado, `proposeAttempts` contabilizado, `resolutionHint` no fingerprint); A06 (2 rodadas — roteamento da ambiguidade no caminho real, interceptação antes de draft ativo, corrupção de descrição "vitamina D" eliminada, coerência de fingerprint A06×A10); A08 (3 rodadas adversariais — normalização idempotente de `scopeId`, confirmed > semântico com `overrode` simétrico, wiring de scope em produção, falso negativo minúscula/aspas fechado).

## Evidência final (executada nesta sessão)

| Gate | Resultado |
| --- | --- |
| Suíte completa do Agent | **1031 passed / 1 skipped** (baseline P0: 911/1skip; +120 testes) |
| `pnpm test` (monorepo) | API **2448/56skip** · Agent **1031/1skip** · PWA **2406** · broker 23 · contracts 25 — 100% verde |
| `pnpm typecheck` | verde (4 workspaces) |
| `pnpm lint` | 0 errors (26 warnings pré-existentes, nenhum em arquivo da fatia) |
| `pnpm docs:lint` | 12 docs, 0 issues |
| `pnpm governance:check` | sem mudança D01–D19 |
| Pré-commit (husky, 7 gates) | PASS nos 3 commits |
| Tester independente | A10 5/5 PASS · A06 PASS com 3 bugs (corrigidos) · A08 16 sondas adversariais + 1 correção obrigatória (corrigida) |
| Reviewer independente | A10 APPROVED (após fixes) · A06 CHANGES→corrigido→verificação Planner (reviewer indisponível por limite de uso; fallback documentado) · A08 CHANGES×3 rodadas→fechado |

## Decisões e desvios do PLAN (documentados)

1. **`usage-policy.ts` e `turn-plan.ts` intocados** (o PLAN os listava como alvo GREEN): o explorer provou que o ledger de tokens não tem noção de eixos e que tocar `llm/failover.ts` quebraria a garantia de 401. O teto vive no módulo novo inerte `orchestration/turn-budget.ts` injetado no orquestrador — validado com jev (0.8/0.83 "likely").
2. **Sem sink durável de telemetria**: contadores por eixo vão pelo sink de eventos existente (`console`), numéricos apenas. Persistência/retenção/cardinalidade permanecem decisão aberta (SPEC §9) — insumo para G07.
3. **Timezone sem autorização** (A06): marcação visível `timeZoneSource: 'default'` + data explícita no card, em vez de esclarecimento time-dependent (só dispararia na virada da meia-noite).
4. **Helper de teste corrigido** (A10): o override de `description` caía fora de `args` — bug de plumbing do teste novo, asserções intactas (conferidas linha a linha pelo tester).
5. **Plano de ambiguidade usa `mode: 'unsupported'`** (A06): evita mint de token delegado para um mero esclarecimento; efeito colateral documentado — o turno deixa de ser `read`, então a troca pergunta/esclarecimento passa a persistir no histórico (correto para uma pergunta).
6. **`EntityReader.scope` ligado em produção** (A08) com equivalência provada em código: `input.workspaceId` → claim do token delegado → `householdId` do contexto → filtro SQL → linha ecoa o mesmo valor (`entity-reader-scope-wiring.test.ts` pinna o contrato). Blast radius: se a equivalência quebrar upstream, o scope rejeita linha válida (fail-closed).
7. **Follow-up estrutural (fatia futura, §8 do PLAN):** a listagem `/accounts` filtra inativas/removidas no store (`postgres-store.ts:83-93`), então "referência a entidade indisponível" só fecha de vez com opt-in de indisponíveis na API (`includeInactive` + OpenAPI + regeneração `generate-agent-tools.mjs` + capability). O resolver já consome o dado quando presente (`isActiveRow`/`unavailableBlocks`, provado com reader sintético).
8. **Comportamento conservador novo** (aceite de produto implícito): entradas cujo nome citado é mais específico que a conta ativa casada ("no Nubank PJ" com só "Nubank" ativa) agora esclarecem em vez de propor na conta errada (defeito real pré-existente, provado em RED).

## Próximas fatias (DAG restante)

1. **A11** — segurança web (R14 pré-requisito, 🔴): wiring do `lookup` no caminho real do Worker (V6), teto de leitura em stream (V8), redirect por hop, sem cookies. Desbloqueia A12.
2. **A12** — envelope de web research com evidência (AC24).
3. **A09-spike** — matriz pergunta×read-model + fixtures financeiras (evidência para G03; sem rota nova).
4. **Bloqueadas por gates humanos:** A07 (G01/G02), A09-integração (G03), A13–A15 (G05), A16 (G04), A17–A18 (G06).

Evidência complementar: execução completa registrada na sessão do Planner (provas RED de cada fix, contagens por rodada de teste/review, sondas adversariais do tester e contraexemplos do reviewer com âncoras path:linha).
