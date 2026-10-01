# Changelog

Formato: seção `Unreleased` para trabalho não lançado; releases só com
versão/tag declarada pela governança. Nada abaixo inventa versão ou release.

## Unreleased (2026-09-30 — acceptance verification PR #44, baseline `096c4e612fbcb7307a1431fa4f1920eb9434d22f`; sem aceite total)

### Release observada (baseline, não é release nova)

- Baseline `main@096c4e6` (PR #44): CI
  [36726347748](https://github.com/kust-projetos/meu-ted/actions/runs/36726347748)
  success + PWA CI
  [36726347704](https://github.com/kust-projetos/meu-ted/actions/runs/36726347704)
  success (com falso-verde confirmado no comprehensive, ver abaixo); deploys
  PWA [36727388392](https://github.com/kust-projetos/meu-ted/actions/runs/36727388392)
  + Agent [36727389081](https://github.com/kust-projetos/meu-ted/actions/runs/36727389081)
  success.
- Infra read-only UTC 2026-09-30T16:09:48Z: runtime API/PWA/Agent com SHA
  igual; API build `36726347748`, PWA build `36726347704`.

### Local / não deployado (fixes)

- API: fix do writer `createAccountInTx` (grava saldo + âncora no mesmo
  INSERT para futuras criações) + provas em PG descartável (8 + parity 6 +
  legacy 3 green) e 7 fake testes. Não deployado; produção segue sem reparo.
- Harness: ports `E2E_FIXTURE_PORT`/`E2E_NEXT_PORT`/`E2E_HARNESS_PORT`, reuse
  false, runner Playwright-owned; rodada final `apps/pwa` 89/89 PASS
  (7 files).
- Workflow: job e2e em `.github/workflows/pwa-ci.yml` com build de shared
  contracts antes do comprehensive; teste
  `src/__tests__/pwa-ci-workflow.test.ts` 2 passed; run-ci-failure sem
  dependência de git, propaga 42. CI remota nova pendente, sem disparo.

### Gates finais pós-fix (tester PASS)

- docs:lint 12/0 e governance PASS pós-docs; `pnpm test:pwa` rerun (250
  files) 2242 PASS; type 4ws, API 2361/52skip, Agent 763/1skip, broker 25
  anteriores valem (API sem mudança).
- Harness `apps/pwa` 89/89 PASS (7 files: 47 fixture + 29 failure guard +
  4 harness + 4 ports + 2 failclosed + 1 run-ci failure + 2 workflow); PG
  indep Planner 17/17 PASS (DDL manual V058 — sem provar migration/restore).
- AUTH 01 pass; subset históricos 23/23 PASS; mobile 148/26 e desktop 39
  herdados (app sem mudança de comportamento).

### Pendências (sem afirmar como verdes)

- CI comprehensive com falso-verde CONFIRMADO (`36726347704`, job
  `109924092896`: falha de build mascarada por trap, zero Playwright
  executado); fix local do workflow implementado, CI remota nova pendente
  sem disparo.
- Runtime SW/push failed sem causa identificada.
- Prova de restore do banco pendente (só existência de backups observada).
- Live bloqueado: sem credenciais admin; faltam edição, exclusão, undo e
  recovery com guards test family.
- Revisão independente de código e documentação APPROVED; o aceite de produção permanece parcial.

### Correções locais / não lançadas (2026-09-30 — closure funcional EM ANDAMENTO, sem release)

- Relatório de execução em `docs/reports/2026-09-30-production-functional-closure.md`
  (status `INPROGRESS`, sem aceite final; o relatório parcial
  `2026-09-30-acceptance-verification.md` permanece histórico).
- Backup canônico `pi-canonical-20260930T194523Z` (V058) + restore PG15/16 com
  checksum match em descartável; origem do residual +10000c identificada
  (criação `31`, match HH origem→ledger, target set
  `c30e17441d7899283182684a59099d7d`); repair em produção NÃO executado.
- SW causa provada (SW contorna `page.route`; `connect-src 'self'` bloqueava
  fixture → rewrite HTTP no harness; 6 PWA + 4 push passed). Gates API
  2398/56skip, Agent 778/1skip, broker 25, PWA 2273 + type/docs/governance
  strict, pins 81, smoke 8 verdes. CodeReviewer APPROVED, security do undo
  APPROVED, wrapper com 1 guard em ajuste final — sem claim final.
