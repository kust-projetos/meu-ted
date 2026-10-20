# #256/#257 — total mensal e cartões (foco) + SPEC/PLAN/ADR v2.1 — closure

**Data:** 2026-10-20
**Branch:** `fix/issue-255-partial-draft` → PR #263 (squash `fc3006c`)
**Produção:** Agent/PWA `fc3006c` (ATTESTED), API `0405fba` (inalterada)
**Status:** DONE (código + deploy + E2E live); docs neste relatório

## Resumo

- #256: "Quanto gastei esse mês?" planeja `get_month_summary` (com janela
  corrente/anterior, UTC) e renderiza o total — nunca extrato. Antes: regex
  `gast*|despesas?` caía em `list_transactions` e o fallback transacional +
  render de extrato suplantavam o resumo mesmo com a operação presente.
- #257: "Liste meus cartões" lê o pool `GET /cards/accounts` (`api.cards`);
  antes `list_cards` mapeava para `statements` e a ausência respondia
  "faturas". Ausência agora responde "cartões".
- SPEC/PLAN/ADR v2.1 revisados com evidência da auditoria
  (`docs/agent-recovery/`): cadeia real PWA→relay-vs-SDK, 1 gate de intent,
  registry único, `deterministic_fix` mantido (`jev_decide` inconclusivo
  0.48×0.50, critérios do projeto desempatam); `jev_gate` allow.

## Implementação (TDD RED→GREEN, 3 rodadas)

1. **Rodada 1 (coder):** ramo month-summary no `routeIntent`, `ReadKind
   'cards'` + reader `/cards/accounts`, ausência `cartões`; testes issue-256
   (4) + issue-257 (4). Suite 2839/1, tsc limpo.
2. **Review 1 → CHANGES_REQUIRED (1 P1 real):** resumo suplantado por extrato
   via fallback de domínio quando havia lançamentos; "mês passado" consultava
   o mês atual; listagem explícita com mês capturada pelo resumo.
3. **Rodada 2:** `selectReads` sem fallback transacional sob resumo,
   `renderMonthSummary` determinístico com precedência (irrenderizável cai no
   generativo, nunca extrato), `resolveSummaryYearMonth(text,now)` injetável,
   `isExplicitListing`/`isCategoryQualified`. Testes 5–11. Suite 2846/1.
4. **Review 2 → CHANGES_REQUIRED (2 P2 reais):** `\b` final impedia plurais
   ("transações/lançamentos/extratos"); categoria com `no/na` ("no mercado")
   virava resumo global.
5. **Rodada 3:** boundary removido dos radicais + preposições estendidas com
   lookahead `mes|mensal` (guarda "no mês passado") + mesmo fix no gatilho
   `list_transactions`. Testes 12–16 (RED pela razão certa antes do fix).
   Suite 2851/1, tsc limpo.
6. **Review 3 → APPROVED** (sem P0/P1; residuais LOW documentados:
   fast-path `recent_transactions` plural, prefixos `despes*`/`gastr*` —
   follow-ups, sem escrita).

## Integração com a main

A main avançou em paralelo (PR #260 fechou #255 como `dd4b164`, PR #261
docs). Merge `f82c7bb`: conflito add/add em
`issue-255-partial-draft.test.ts` resolvido a favor da main + expectativa
#257 (teste 5: "cartões", nunca "faturas"). Auto-merge preservou nossas
mudanças (orchestrator com precedência do resumo + #255 da main).
Verificação pós-merge: 150/150 focados, 2851 full, tsc limpo.

## CI / merge / deploy

- PR #263: CI 18/18 SUCCESS + PWA CI (quality, e2e) verdes; MERGEABLE.
- Merge squash `fc3006c` na main; CI da main verde.
- Deploys Cloudflare ATTESTED `fc3006c` (Agent run `39357535830`, PWA run
  `39357535804`; par anterior 16s = corrida workflow_run conhecida).
- Smokes read-only: PWA `/api/build-info` `gitSha=fc3006c…`, Agent `/health`
  `ready buildSha=fc3006c…`, API `/health` `0405fba` (sem redeploy).

## E2E live (produção, modelo real, Test Family `550e8400-…`)

- **Regressão** `live-ted-conversation`: 1 passed em 104s (mesmo-draft,
  confirmação/negação/reload/undo, limpeza zero) — PASS.
- **T2 #257** (só leitura): "Liste meus cartões" → "Ainda não encontrei
  cartões aqui…" (contém `cartões`, zero `fatura`) — PASS (~11s).
- **T1 #256 vazio** (só leitura): "Quanto gastei esse mês?" sem dados →
  "Não há lançamentos no período…" (sem extrato; copy honesta) — roteamento
  PASS, total não verificável (mês vazio).
- **T1 #256 com dados** (seed escopado 1 conta + 1 despesa R$ 42,50, ambas
  removidas): "Quanto gastei esse mês?" → **"Resumo 2026-10: gastos R$ 42,50,
  receitas R$ 0,00, saldo -R$ 42,50 (1 lançamentos)."** — PASS. Limpeza:
  DELETE 200 + deactivate 200; resíduo zero em 2 leituras (contas e
  transações `total:0`, sem markers); re-pergunta volta ao empty-state.
- Tentativa inicial de seed via `fetch` direto falhou com
  `auth.workspace_forbidden` enquanto o client do app obtinha 200/201 nas
  mesmas rotas (contas zeradas à época impediram concluir pela via direta;
  seed refeito pelos fluxos UI). **Anomalia de harness registrada:**
  divergência fetch-direto vs client do app — investigar antes de futuros E2E
  com seed direto (possível endurecimento pós-Release-B sessão+header vs
  bearer legado). Sem impacto no veredito.

## Critérios de aceite (SPEC §20)

1. #255/#256/#257 reproduzidos e corrigidos — OK (live em `fc3006c`).
2. Consultas com dados/tools corretos — OK. 3. Mutações — intocadas,
   regressão PASS. 4. Multi-turno — regressão PASS. 5. Frontend sem
   perda/duplicidade — regressão PASS. 6. Reentregas — idempotência
   preservada (dup-check 200 no seed). 7. Falha de provider sem sucesso
   fictício — guards intactos. 8. Modelo ativo testado no fluxo real — OK.
9. Sem P0/P1 conhecido no escopo — OK (P2/LOW como follow-ups).
10. Rollback operacional — revert de commit único, sem migração.

## Residuais / follow-ups (não bloqueiam)

- Fast-path `recent_transactions` com mesmo `\b` de plural; predicados
  `despes*`/`gastr*` aceitam prefixos; "gastos do trimestre" vira listagem.
- `fetch` direto 403 vs app 200 (harness) — investigar.
- Release B, STT/Vision/PDF/web/autoexec, F3–F5: fora do escopo, inalterados.
- Issues #236–#242 seguem backlog; #255 CLOSED pela #260; #256/#257 fechadas
  por este trabalho (a encerrar nas issues após este relatório).

## Evidências

- Commits: `b053486` (código+testes), `bc1744a` (docs v2.1), `f82c7bb`
  (merge main), squash `fc3006c`.
- Suites: 2851 passed/1 skipped (agent), 150/150 focados pós-merge,
  65/65 verificação do Planner, tsc limpo, pre-commit + CI verdes.
- Reviews: 2× CHANGES_REQUIRED endereçados + APPROVED final (P0/P1 zero).
- Live: regressão 104s PASS; T2 11s PASS; T1 com totais PASS + limpeza zero;
  screenshots em `test-results/` (gitignored).
