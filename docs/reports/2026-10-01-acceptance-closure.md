# Fechamento de aceite — 4 itens — 2026-10-01

- **Data:** 2026-10-01 · **Status:** `FINAL` (aceite dos 4 itens pendentes da sessão 2026-09-30)
- **Baselines:** início `main@0b38535` → `375af2c` (PR #47) → `06c00c2` (PR #48) → `29c015d` (PR #49)
- **Método:** orquestração OpenCode (subagents + gates jev); verificações externas read-only; live E2E com autorização explícita do operador a cada limite (mutação financeira de teste e deploy de API)
- **Escopo:** workspace de teste dedicado ("Test Family" `550e8400-e29b-41d4-a716-446655440000`) para toda mutação financeira; nenhum dado real do casal tocado; PROIBIDO respeitado (approval `14915dbd`/tx `60b657d5` nunca repetidos)

## Item 1 — Testes funcionais (falhas E2E de 2026-09-25) — RESOLVIDO

- As 8 falhas mobile de 25/09 eram o conjunto conhecido/legado (`ted-chat-workspaces`, `TX-06`, `TRF-01`, `TRF-02`, `workspaces-multiuser ×3`) + specs desktop FAB-dependentes — pendências antigas, fora do escopo da closure.
- O falso-verde do comprehensive no PWA CI está **provado corrigido**: run `36866724275` (SHA `0b38535`) executou o job `e2e` com steps 8 "Build shared contracts" + 9 "Run comprehensive E2E" (Playwright real, success). Repetido verde nos PRs #47/#48/#49 (ex.: `36894374095` e2e 14m03s).
- O spec `live-closure` foi endurecido (PR #47): seleção de card por id fresco da resposta do POST `/rpc/chat` (nunca `.first()` sobre cards stale) + descrição dentro do `<dl>` de aprovação.

## Item 2 — API em produção alinhada ao CI — RESOLVIDO (dupla prova)

- 13:20 UTC: API em `0b38535` (build `36866723740`, CI #255 success no merge do PR #46), `/ready` 200; PWA/Agent Deploy success no mesmo SHA (re-disparo após a corrida `workflow_run` conhecida).
- 17:5x UTC: API re-deployada para `29c015d` (fix do PR #49) via wrapper versionado `api-release-20260930.sh` (lane source-build, CI run `36900550367` atestado verde): `/health` `gitSha=29c015d…`, `/ready` 200, `buildId=36900550367`, manifest em `/home/deploy/infra/pi-finance-api/release-manifest-29c015d….json`, rollback tag `pi-finance-api:rollback-pre-29c015d` preservada.
- PWA/Agent em produção: `06c00c2` (builds `36896164604`; workflows `36897237706`/`36897237128` success) — código-identicos ao main atual (PR #49 altera só `apps/api`).

## Item 3 — Banco canônico: preparação, repair e recuperabilidade — RESOLVIDO (cutover segue gate humano)

- Backup `pi-canonical-20260930T194523Z` (V058) com restore provado em PG15/16 descartável (checksum match) — sessão 2026-09-30.
- **Repair executado e commitado em produção** (autorização explícita na sessão 09-30, executor revisado pela security): sondagem read-only de hoje (canal SELECT-only documentado) — `repair_committed=2`, `repair_compensated=0`.
- **Residual zero**: `residual_count=0` sobre 32 contas vivas (saldo = âncora + deltas exatos). As contas extras com âncora 10000 além do target set são fixtures E2E rotuladas ("Conta E2E …"), não corrupção.
- Backup pré-release fresco antes do deploy da API: `pi-canonical-prerelease-20261001T174039Z.dump` (sha256 `1b7252a5…`).
- O **cutover** legacy→canonical permanece gate humano documentado (plano 2026-09-22, F2→F5) — a transição não está "incompleta por esquecimento", é gated por design.

## Item 4 — Validação real autenticada ponta a ponta — RESOLVIDO (live closure PASS)

**`live-closure` PASS em produção: criar → editar → confirmar → desfazer → cancelar → reload → excluir (RUN_ID `closure0930-muptyzne`, conta criada 2026-10-01T17:51:21Z; saída Playwright: `ok 1 … (28.1s)` / `1 passed (29.4s)`)** contra API `29c015d` + PWA/Agent `06c00c2`, com guards de escopo fail-closed, cardinalidade exata de decisões (2 decisions + 1 undo + 1 verify-target), zero writes fora do Test Family, zero erros de página/console/servidor e reversão verificada no ledger pós-reload (leitura paginada pelo próprio spec, admin autenticado).

A run só fechou após **3 causas raiz reais encontradas e corrigidas** (nenhuma era conhecida antes do live):

1. **Card de aprovação** — descrição fora do `<dl>` + seleção de card por `.first()` podia decidir card stale (PR #47, PWA).
2. **Intent de undo não reconhecia "desfaça"** — `UNDO_INTENT_RE` cobria só `desfaz|desfazer` (ç ≠ z); "desfaça a última ação" caía no fallback `unsupported`. Fix do radical `desfaç` nas duas cópias + negação continua fail-closed (PR #48, Agent; 778/778).
3. **Veto de escopo no undo delegado (API)** — o preHandler global exigia `financial.write` genérico para toda escrita; o token de undo carrega **só** `financial.undo.execute` (design narrow) e era vetado → 403 em ~2ms no API (log VPS `req-1gp`) → 502 `agent.approval_failed` no agent. Fix: `undoScopeAdmitted` isento do requisito genérico, re-check estreito na rota mantido (PR #49, API; 2399/2399).
4. Alinhamento final do spec ao UX real de exclusão (dialog de detalhe → confirm "Excluir lançamento" em 2 passos) — neste PR, spec-only.

## Deploys e identidade de release (2026-10-01)

| Runtime | SHA | Build | Evidência |
| --- | --- | --- | --- |
| API (VPS) | `29c015d` | `36900550367` | `/health` gitSha + manifest + rollback tag |
| PWA (Cloudflare) | `06c00c2` | `36896164604` | `/api/build-info` gitSha |
| Agent (Cloudflare) | `06c00c2` | `36896164604` | `/health` buildSha, `ready` |

## Evidência e reprodutibilidade

Sondagens executadas nesta sessão pelo Planner via túnel SSH SELECT-only
(mesmo canal documentado em `scripts/ops/repair-executor-0930.ps1` e no
precedente de reconciliação 2026-09-21), contra o banco
`pi_financeiro_canonical` no container `pi-finance-postgres`. Qualquer
auditor pode reexecutar os comandos abaixo e comparar.

**Sonda do repair (2026-10-01 ~17:00–17:30 UTC):**

```sql
SELECT 'anchors_10000', count(*) FROM accounts WHERE initial_balance_cents = 10000
UNION ALL SELECT 'repair_committed', count(*) FROM audit_logs
  WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.committed'
UNION ALL SELECT 'repair_compensated', count(*) FROM audit_logs
  WHERE operation = 'financial_repair.anchor_backfill' AND event_type = 'financial_repair.compensated';
-- saída observada: anchors_10000~32 | repair_committed~2 | repair_compensated~0
```

`anchors_10000` acima do esperado do target set (31) porque contas-fixture
E2E rotuladas também nascem com âncora R$100,00 (ex.: `Conta E2E Closure
closure0930-muptyzne`, criada 17:51:21Z) — conferido por
`SELECT id, name, created_at FROM accounts WHERE initial_balance_cents = 10000 … ORDER BY created_at DESC`.

**Sonda do residual (mesma janela):**

```sql
WITH delta AS (SELECT a.id, a.balance_cents, a.initial_balance_cents,
  (SELECT COALESCE(sum(CASE WHEN t.kind = 'income' THEN t.amount_cents
     WHEN t.kind = 'expense' THEN -t.amount_cents
     WHEN t.kind = 'transfer' AND t.transfer_to_account_id = a.id THEN t.amount_cents
     WHEN t.kind = 'transfer' THEN -t.amount_cents ELSE 0 END), 0)
   FROM transactions t
   WHERE (t.account_id = a.id OR t.transfer_to_account_id = a.id) AND t.deleted_at IS NULL) AS d
  FROM accounts a WHERE a.deleted_at IS NULL)
SELECT 'residual_count', (count(*))::text FROM delta WHERE balance_cents <> initial_balance_cents + d
UNION ALL SELECT 'accounts_total', (count(*))::text FROM delta;
-- saída observada: residual_count~0 | accounts_total~32
```

**Live closure PASS (RUN_ID `closure0930-muptyzne`):** executado localmente
com Playwright 1.61.1 (`pnpm -C apps/pwa exec playwright test --config
e2e/live-closure.config.ts`), opt-in `PWA_LIVE_E2E=1` +
`PWA_LIVE_BASE_URL=<host de produção do PWA, fornecido pelo operador via
env/GitHub Variable — hostname interno sanitizado por SPEC §13.4>` +
credenciais admin de `.env.e2e.local` (fora do repo). Saída literal:
`ok 1 e2e\specs\live-closure.spec.ts:197:7 › … › fechamento: criar →
editar → confirmar → desfazer → cancelar → reload → excluir (28.1s)` /
`1 passed (29.4s)` (28,1s é o teste; 29,4s inclui setup do worker). A
identidade RUN_ID está nos nomes das entidades criadas no ledger (conta
`Conta E2E Closure closure0930-muptyzne`, 17:51:21Z, verificada por
SELECT read-only) e nas descrições das transações do run — o spec só
decide/exclui entidades do próprio run (`isRunOwnedEntity`).

## Limites e o que continua aberto (sem claim)

- Cutover canonical (F3–F5) e Release B (janela termina 2026-10-02) permanecem gates humanos.
- Dados de teste de runs anteriores permanecem no workspace Test Family (padrão estabelecido; higiene parcial por run — o spec exclui apenas o que o próprio run criou).
- Falhas 1ª tentativa dos deploys Cloudflare são a corrida `workflow_run` conhecida; re-disparos verdes documentados nos run ids acima.
