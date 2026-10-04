# TED Inteligente V1 — implementação P3 (A07, A09-integração, A16)

**Data:** 2026-10-04 · **Branch:** `feat/ted-agent-inteligente-v1-p3` · **Base:** `main@5437b5a`
**Commits:** A07 (`391eaf1`) · A09-integração · A16 — ver `git log`
**Artefatos:** [SPEC](../MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md) · [PLAN](../MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md) · [Spike A09](2026-10-04-ted-inteligente-v1-a09-spike.md) · [Relatórios P1/P2](2026-10-04-ted-inteligente-v1-p2-a11-a12-a09-spike.md)
**Autorização:** operador autorizou continuar após os gates; interpretação validada (jev 0.87): implementar seguindo as recomendações da SPEC §11 — código default-off, nada ativado, V5/elegibilidade intocadas, decisões materiais de operador preservadas (A13–A15/G05 e `conversationId`/G02 permanecem fora).

## Resultado

| Fatia | Requisito | Entrega | Suíte Agent |
| --- | --- | --- | --- |
| A07 (🔴) | R07 (AC14/AC15/AC16) | `goalId` derivado por leitura (= draftId), `revision` monotônica do store com `expectedRevision` (UPDATE … RETURNING; in-memory idem), `originMessages`/`relations` (8 tipos)/`fieldProvenance` aditivos com migração idempotente (5 colunas); fragmentos completam draft ("de carne"→categoryQuery, "ontem"→data com relógio injetável); correção "não, 500" via update+guarda com token inteiro/moeda/ambiguidade; escrita pós-await com guarda de três vias (contribuição obsoleta nunca sobrescreve correção interveniente); patch de `resolvedArgs` exige `status:'active'`; `conversationId` NÃO populado (G02) | 1090 → 1129 |
| A09-integração | R09 (AC18/AC19) — caminho REUSO pós-spike | `/analytics/kpis` + `/analytics/category-breakdown` viram tools do agente (OpenAPI forma rica + regeneração 54 tools + inventário CAP-073/074 + literais → constantes nomeadas); `analytics-envelope.ts`: sempre `period=custom`+from/to (armadilha do `resolveRange` fechada), `daily-heatmap` fora do caminho custom, envelope `effectivePeriod{toExclusive}`+`boundary`+`basis`, `totalCents` inseguro → `totalCentsExact`+`approximate`; `categoryId` sintético "outras" no contrato; **zero rota nova; G-A/G-B/G-C abertos** | 1129 → 1162 |
| A16 | R15 (AC25) — default-off | `judgment/provider.ts`: fronteira de 1 método (`evaluate`) com abstinência tipada, breaker por endpoint\|model (2 falhas/300s/half-open; 4xx de conteúdo não contamina), deadline 2s cobrindo fetch+corpo, 1 chamada/turno sem evicção silenciosa, allowlist de modelos, envs opcionais default-off, **nenhum wiring no hot path** — nada concede permissão; `resolveWithJudgment` devolve o determinístico | 1162 → 1172 |

Ciclo de review: A07 (tester PASS com 1 bug de robustez; reviewer 5 findings — sobrescrita pós-await, gramática truncada, falso-positivo do UPDATE, datas contraditórias, fragmento×conta homônima — todos corrigidos; 2ª rodada achou re-aplicação obsoleta pós-contenção — corrigida com guarda de três vias); A09-int e A16 (reviewer combinado: 4 findings — integração no caminho executável, slice "outras" no contrato, deadline do corpo, evicção do teto — todos corrigidos).

## Evidência final

| Gate | Resultado |
| --- | --- |
| Suíte completa do Agent | **1172 passed / 1 skipped** (+82 nesta leva; +361 no total das 3 levas) |
| `apps/api` suíte completa | 2448/56skip (gate autoritativo de tools 1/1) |
| `node scripts/generate-agent-tools.mjs --check` | 54 tools up to date |
| `node scripts/check-tool-capability-inventory.mjs` | 54 registered / 74 rows |
| Typecheck / lint / docs:lint / governance | verdes |

## Decisões documentadas

1. **G02 fora do escopo**: `conversationId` é código morto (7 ocorrências, todas no draft store; nunca populado pelo transporte) e populá-lo muda `sameContext`/isolamento — investigação registrada, decisão permanece humana. Teste permanente P8 trava `conversation_id` NULL.
2. **Correção via `update`+`expectedRevision`** (não ampliou a assinatura `cas`); guard de três vias: contribuição do turno só re-aplica onde a base fresca ainda carrega exatamente o que ele deixou — falha a favor do fresco, documentada.
3. **`period` obrigatório nas tools** (narrowing-only, documentado no teste autoritativo da API): sem ele o `resolveRange` descarta `from`/`to` em silêncio (spike §3.1).
4. **Preset sem intervalo passa direto** (intenção explícita, a API resolve deterministicamente); intervalo nomeado sempre vence o preset.
5. **A16 sem integração real**: sem credencial inventada (401 = abstinência), sem hot path, sem dependência nova; breaker por `endpoint|model`; contagem in-memory (`stats()`) — ledger durável é A10.
6. **Achado de ambiente**: `pnpm boundary:check` falha por arquivo PWA **não rastreado** (dívida local, fora do CI); scripts `.mjs` de schema-contract falham com ENOENT em `.pi/extensions/**` (árvore removida em P3 `f640e84`) — pré-existentes, fora do CI.

## G03 — lacunas fechadas (adendo §11.1, pós-autorização)

Com a autorização do operador, o adendo da SPEC (`cc48b9e`, patch ANTES do código) definiu a via conservadora e a implementação seguiu à risca:

- **G-A**: `basis=competencia` opt-in nas 4 superfícies de despesa — exclui pagamentos de fatura do agregado (compra permanece na competência). Default `liquidez` **byte a byte inalterado** (locks A–E/I–K do fixture travam). Fonte legacy (V056 excluída) → **recusa tipada 400** antes de qualquer I/O.
- **G-B**: `totalCentsExact: string` + `approximate: true` quando o total excede `Number.MAX_SAFE_INTEGER` (`analytics/exact.ts`; o `::text` do PG é a autoridade; `Number()` só dentro do safe). Breakdown/slices com companion por campo.
- **G-C**: envelope de prova nas 6 rotas (`transactionCount`/`asOf`/`basis`/`semanticsVersion`/`effectiveFilter`/`emptyReason`) — aditivo; honestidade da janela verificada (heatmap alinhado à grade 4×7; net-worth declara `to: null`); recusa `analytics.basis_unsupported` fora das superfícies de despesa e no legado.
- **Fixture do spike virou teste real** (22 + 9 novos): casos F/H/L RED→GREEN; o RED provou **erro aritmético na própria fixture** (soma correta `10000000000000001`) — corrigida com marca no relatório do spike.
- Contagens: API **2479/56skip**, agent 1179/1skip; gerador 54 tools, capabilities 54/74.
- **NÃO auto-deploya**: releases de API são via wrapper na VPS (gate humano) — produção segue `e86eae9` até o wrapper rodar com este SHA. PG twin roda no CI (`Postgres — integration tests`).

## Estado do plano

- **Concluídas:** A00–A12, A16, A09-spike, A09-integração (reuso), **G03** (G-A/G-B/G-C).
- **Bloqueadas por gates humanos (não iniciadas):** A13–A15 (G05 — storage/modelos), A17–A18 (G06 — consentimento/compartilhamento), A07.2 `conversationId` (G02).
- **Follow-ups:** ligar envelope analytics ao caminho de evidência (A04/A09 pós-G03); instância única do JudgmentProvider por DO no wiring futuro; V13 do plano (6 rotas); copy de produto para `competencia` "subtrair" em janelas de liquidação (o envelope já torna legível).
