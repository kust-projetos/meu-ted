# Verificação de aceite — 2026-09-30 (PR #44, baseline `096c4e612fbcb7307a1431fa4f1920eb9434d22f`) — FINAL parcial, sem aceite total

- **Data:** 2026-09-30
- **Baseline:** `main@096c4e612fbcb7307a1431fa4f1920eb9434d22f` (PR #44)
- **Orquestração:** DELEGATED (subagents participaram; tester executou os
  gates pós-fix; revisão independente de código e documentação APPROVED,
  sem afirmar aceite total).
- **Idioma:** pt-BR. Este documento separa release observada ×
  unreleased/local × pendências e **não declara aceite total**.

## Resumo (4 itens)

| # | Item | Estado |
|---|------|--------|
| 1 | Funcional + históricos | Verificados (AUTH 01 pass, subset 23/23 PASS, PG indep 17/17); SW/push e CI remota nova pendentes |
| 2 | API release | Confirmada na baseline observada |
| 3 | Banco operacional | Reconciliação lida; prova de restore pendente |
| 4 | Live | Bloqueado (sem credenciais admin + cobertura faltante) |

## 1. Release observada (baseline)

- CI: [36726347748](https://github.com/kust-projetos/meu-ted/actions/runs/36726347748)
  success + PWA CI
  [36726347704](https://github.com/kust-projetos/meu-ted/actions/runs/36726347704)
  success (com ressalva no §2).
- Deploys: PWA
  [36727388392](https://github.com/kust-projetos/meu-ted/actions/runs/36727388392)
  + Agent
  [36727389081](https://github.com/kust-projetos/meu-ted/actions/runs/36727389081)
  success.
- Infra read-only UTC 2026-09-30T16:09:48Z: runtime API/PWA/Agent com SHA
  igual; API build `36726347748`, PWA build `36726347704`.
- `DATABASE_URL` sanitizada (sem segredos): host `pi-finance-postgres`,
  db `pi_financeiro_canonical`, `DB_SCHEMA=canonical`.
- Canônico top V058 (31 accounts / 28 tx) vs legado `pi_financeiro` V054
  (29 accounts) preservado. Banco fresh — sem conversão nem
  archive-and-bootstrap; só existência de backups observada, sem prova de
  restore.

## 2. CI comprehensive: falso-verde CONFIRMADO

- `gh run view 36726347704 --job 109924092896 --log`: `[run-ci]` build
  14:05:52, `Failed compile` 14:06:02 (`Can't resolve
  @pi-finance/llm-contracts/types`); `cleaning up`; **nenhum** comprehensive
  Playwright executado apesar de `conclusion: success`. O trap de cleanup
  (`exit RESULT 0`) mascara a falha de build.
- Runner local sem trap corrige e propaga failure 42 com zero Playwright
  calls; squatter test async 88 tests pass.
- Fix LOCAL do workflow implementado: job e2e em
  `.github/workflows/pwa-ci.yml` faz build dos shared contracts antes do
  comprehensive; teste `src/__tests__/pwa-ci-workflow.test.ts` 2 passed;
  teste run-ci-failure sem dependência de git (shallow CI), versão atual
  propaga 42 green. CI remota NOVA pendente, sem disparo.

## 3. Reconciliação (somente leitura)

- Comando correto, dentro do container read-only:
  `node dist/scripts/reconciliation/run.js --schema=canonical --format=text`.
- Resultado canônico: checked 31, drifted 34 = 31 accounts residual +10000c
  + 3 `historical_exception_count_mismatch` em allowlist; legado 47/8/1,
  actual 0.
- Limites: sem inferir saldo exibido errado; sem autorizar backfill.

## 4. Causa raiz + fix local (não deployado)

- Debugger comprovou: writer `createAccountInTx` omite a âncora (default 0).
- Fix LOCAL: grava saldo + âncora no mesmo INSERT para futuras criações.
- Prova do Coder em PG descartável: 8 + parity 6 + legacy 3 green; 7 fake
  testes.
- Não deployado; produção segue sem reparo.

## 5. Gates finais pós-fix (tester PASS)

- Comando final na raiz do repo: `pnpm docs:lint`, `pnpm typecheck`,
  `pnpm test`, `pnpm governance:check`.
- Resultado final: docs:lint 12/0 e governance PASS pós-docs; `pnpm
  test:pwa` na raiz (rerun, 250 files) 2242 PASS; type 4 workspaces, API
  2361/52skip, Agent 763/1skip, broker 25 anteriores valem (API sem
  mudança).
- PG independente do Planner 17/17 PASS (3 files), 2026-09-30 local
  16:21:29, duration 10.12s, em Postgres 16 alpine descartável (container
  `pi-acceptance-anchor-verify-0930`, 127.0.0.1:55439, db
  `acceptance_anchor_test`, com `_test_marker`). Comando com cwd
  `apps/api`: `pnpm exec vitest run
  tests/writes/account-initial-anchor-postgres.test.ts
  tests/integration/postgres-canonical-parity-v41.test.ts
  tests/contract/legacy-canonical-parity.test.ts` (envs só por nome:
  `DATABASE_URL_TEST` + `DB_TEST_MARKER`, sem valor). Container parado e
  removido (flag rm), nenhum banco real tocado. Declara-se explicitamente:
  prova behavioral do writer em DDL manual compatível com V058; NÃO prova
  aplicação de migration nem restore de produção.
- Harness final (cwd `apps/pwa`): `pnpm exec vitest run e2e/support
  e2e/fixture-api src/__tests__/pwa-ci-workflow.test.ts` = 7 files, 89/89
  PASS (47 fixture + 29 failure guard + 4 harness + 4 ports + 2 failclosed
  + 1 run-ci failure + 2 workflow).
- E2E subset 23/23 PASS no port fix final (specs: UI shared, ted-chat,
  transaction, transfer, workspaces); invocação exata
  (config/project/--grep/IDs) conforme rodada do tester. Mobile full 148/26
  e desktop 39 herdados de antes do test fix final, com o app sem mudança
  de comportamento. AUTH 01 pass.
- Runtime SW/push failed sem causa identificada; sem afirmar lentidão.
- Artefatos live `e2e/test-results` preexistentes não encontrados ao final;
  resíduo `passed` não conta como evidência, causa da remoção não atribuída.
  Risco: sem esses artefatos, a trilha auditável do live fica incompleta.
- MCP Jev: gates advisory allow + decide banco operacional, aceite pendente
  (não prova execução).

## 6. Live (bloqueado)

- Sem credenciais admin; cobertura faltante: edição, exclusão, undo e
  recovery com guards test family — somente com autorização e apenas com
  dados do test run.

## Proibições vigentes

- Proibido rodar mutação financeira manual.
- Proibido repetir approval `14915dbd` / tx `60b657d5`.

## Próximos passos precisos

1. Disparar a CI remota NOVA com o fix do workflow e anexar o run ID.
2. Deploy do fix de âncora pelo fluxo autorizado, sem mutação manual
   (produção segue sem reparo).
3. Prova de restore do banco (só existência de backups observada) +
   registrar a proveniência da reconciliação; aceite dos 34 findings
   (31 residual +10000c + 3 allowlist) pendente.
4. Investigar a causa do fail SW/push (0/6, 0/4) antes de qualquer afirmação.
5. Live completo — edição, exclusão, undo e recovery com guards test
   family — com autorização, só dados do test run.
