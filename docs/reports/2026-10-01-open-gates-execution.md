# Execução dos gates abertos — 2026-10-01 (itens 1–6)

- **Data:** 2026-10-01 · **Status:** `FINAL` (itens 1, 3, 4, 5, 6 concluídos; item 2 concluído com NO-GO documentado do real-dump)
- **Baselines:** início `main@476ba7d`; sessão derivada da closure de aceite do mesmo dia (`docs/reports/2026-10-01-acceptance-closure.md`)
- **Autorizações:** Rota A da Release B e execução dos itens 1–6 aprovadas pelo operador; cleanup do Test Family executado após dry-run revisado; `CLOUDFLARE_API_TOKEN` permanece como está (decisão do operador)

## 1. Registry de exceções da reconciliação — RESOLVIDO sem código

- **Achado:** o mecanismo de provenance já existia (`applyHistoricalExceptions`, `apps/api/src/scripts/reconciliation/historical-exceptions.ts:365`): `fresh` declara um banco que nunca teve o conjunto histórico (ADR-017/018) e espera zero.
- O recon canônico de produção **nunca teve** o conjunto (rota fresh) — o default `historical` é que gerava os 3 falsos drifts de contagem (47/8/1 esperados, 0 reais).
- **Comando canônico de produção (drifted=0):**
  `docker exec pi-finance-api node dist/scripts/reconciliation/run.js --schema=canonical --provenance=fresh --format=text`
  → `checked=37 drifted=0 info=0` (evidência desta sessão; qualquer auditor pode reexecutar).
- Sem mudança de código: o gate fail-closed por contagem continua ativo para bases `historical`.

## 2. F2 (rehearsal do conversor) — smoke PASS; real-dump NO-GO documentado

- **Smoke sintético: PASS** (`node scripts/rehearse-canonical-conversion.mjs`, 28.6s): conversão `completed`, preflight `ready`, **rerun noop** (idempotente), reconciliação com match exato da baseline sintética (5 findings), dump pós-conversão sha256 `1603ce08…`.
- **Real-dump (formal): executado → NO-GO técnico.** Dump do legacy de produção (`pi_financeiro`, 244.922 bytes custom-format) → restore local descartável → anonimização verificada (emails/nomes/phones/tokens mascarados; sessões/verifications/oauth zerados; checks `*_bad=0`; dump anônimo 76.407 bytes gz, sha256 `29fce0f2…` — artefato local, nunca versionado) → rehearsal com `--dump`:
  - Provas parciais: load ✓; baseline legacy por household `drifted=0` (5 households); `convert:canonical:dry` `ready=true` ✓.
  - **Bloqueio fail-closed na fase `balances`**: transação `49c01613…` é expense **sem statement vinculado** no credit_card `91e8805d…` — "refusing to guess its statement". Dado ambíguo surgido no legacy entre 25/09 e o flip para o canônico.
  - **Veredito:** conversão legacy→canonical sobre o estado atual do legacy = NO-GO (correto do conversor). **Irrelevante para produção**: a API já serve o canônico (rota fresh concluída); o legacy é arquivo. Reavivar o caminho exigiria decisão humana sobre a transação ambígua — não recomendado.
- Container de rehearsal removido pelo próprio harness no fail (higiene confirmada).

## 3. `release-b-reminder.yml` atualizado para D11-R2

- Gate **2026-10-15** (janela iniciada 2026-10-01T20:14Z, pós smoke documentado).
- Query corrigida para o **shape canônico** (`event_type`, DB `pi_financeiro_canonical`, container `pi-finance-postgres`) + filtro `created_at >= 2026-10-01T20:14:00Z` (exclui o smoke pré-janela).
- A query antiga (`action` em `pi_financeiro`) contava tabela vazia por construção (falso-zero).

## 4. Workflows-lembrete future-dated (padrão do reminder Release B)

- `.github/workflows/future-gate-localstorage-20261201.yml` — revisão da janela ADR-011/015 (compat localStorage/bearer): `token-store.ts`, `legacy-usage.ts`, `SESSION_BEARER_FALLBACK_ENABLED`. Nota no corpo: se a Release B já flippou, reduz a remover caminhos mortos.
- `.github/workflows/future-gate-allowlists-20261231.yml` — renovação/correção das allowlists com expiração 2026-12-31 (`pwa-audit-allowlist.json` — sharp + cadeia LHCI incluindo as adições de 2026-10-01 — e `.trivyignore`), com comandos de validação local no corpo.
- Ambos: cron diário, idempotentes (label + prefixo de título), somente leitura + issue.

## 5. `refs/pi-rewind/store` — inventário + preservação

- **Inventário (read-only):** 1 ref, **2 commits** exclusivos de `main` (`a16ad5c` "pi rewind snapshot" + `fae8228` "pi rewind store", 2026-09-24 22:43 -03): snapshot completo de **1.934 arquivos / 341.598 linhas** da working tree daquela data. A nota histórica "1.970 commits" era a contagem de **arquivos** do snapshot. Repo total: pack 7,90 MiB (sem pressão de GC).
- **Preservação executada:** `backups-local/pi-rewind-store-20261001.bundle` (5.493.446 bytes, `git bundle verify` OK — "complete history").
- **Plano:** manter a ref (objetos vivos; clones normais não a trazem — restaurar com `git fetch origin 'refs/pi-rewind/store:refs/pi-rewind/store'` ou o bundle); recomendação adicional: `git push origin refs/pi-rewind/store` (backup off-machine, aditivo); **nunca deletar sem sign-off do owner** (é âncora de rewind do tooling pi).

## 6. Cleanup do workspace Test Family — EXECUTADO (soft, via API revisada)

- **Canal:** produção API, auth **cookie-only** (bearer emitiria eventos dentro da janela Release B recém-aberta), escopo travado no workspace `550e8400…` e em contas nomeadas `Conta E2E *`.
- **Dry-run:** 17 contas E2E, 27 transações vivas, 0 erros previstos.
- **EXECUTE:** 27 `DELETE /transactions/:id` (keyed, soft-delete) + 17 `POST /accounts/:id/deactivate` (soft, auditado `account.delete`) — **0 erros**.
- **Verificação pós:** re-listagem → `E2E accounts: 0`. Nenhum dado do workspace real (`junio`) tocado; nenhuma aprovação histórica repetida (PROIBIDO respeitado).

## O que fica aberto (gates humanos/decisões)

- **Release B flip** após 2026-10-15 com contagem zero (`SESSION_BEARER_FALLBACK_ENABLED=off` + rebuild PWA `NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off`).
- **F2 real-dump NO-GO**: se alguém quiser reanimar o caminho legacy→canonical, a transação `49c01613…` exige decisão humana (vincular statement ou arquivar); recomendação: não reanimar.
- **Legacy DB** permanece como archive intocado.
- Refs de rewind: push off-machine opcional (comando no §5).
