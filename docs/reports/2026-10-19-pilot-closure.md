# Relatório — Fechamento do piloto privado (2026-10-19)

**Baseline:** `main@0405fba594d2758459b003165082604dc91b51fc` (PR #226 squash).
**Plano:** `docs/reports/2026-10-19-pilot-closure-plan.md`. **Missão:** estabilizar para ≤5 usuários, sem features novas.

## 1. Produção (três camadas, SHA único `0405fba`)

| Camada | Evidência |
|---|---|
| API Contabo | wrapper `api-release-20260930.sh --execute`, lane source-build do pristine `src-0405fba` (HEAD exato, dirty=0); backup pré-release `pi-db-20261019T110051Z.dump` (sha256 `fd99cac5…`, `sha256sum -c` OK); RELEASE OK; manifest outcome=released; rollback tag `rollback-pre-0405fba` = imagem `45de23b` preservada; container healthy, restarts=0; flags `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical`, `TED_RISK_BASED_AUTOEXECUTE=shadow` intactos; `/health` sha+buildId `39240378530` + `/ready` ready |
| Agent Cloudflare | run `39241418250`: deploy ✓ + smoke `attempt 1/8 PASS buildSha` + **ATTESTED deploy-smoke-pass** `0405fba` |
| PWA Cloudflare | run `39241418243`: deploy ✓ + smoke + **ATTESTED deploy-smoke-pass** `0405fba` |
| CI | main `39240378530` + PWA CI `39240378590` verdes; required checks SUCCESS; merge CLEAN |

## 2. Defeitos corrigidos (PR #226, TDD RED→GREEN, tester + reviewer independentes)

| Issue | Correção | Validação |
|---|---|---|
| #214 | subscriptions-adapter: identidade pré-fetch + descarte pós-switch + `expectedSubject` | tester 40–52/52, reviewer APPROVED |
| #216 | migrateV1toV2 serializado + validação partição/conteúdo + cleanup condicional com liveness (`deleteV2SnapshotIfOwned`) | idem + 2 rodadas reviewer (P2 delete incondicional + gap liveness) |
| #215 | coherence check fail-closed aba×subject×V3 em bootstrap/paginação/fallback/preload/publicação/commit V3 (architect: opção a) | tester 158+7/7 (3x sem flake), reviewer APPROVED (2 rodadas: commit V3 + thẩm định) |
| CI | fixtures `name` (TS2741, typecheck local exclui testes) + gate async do effect (lint set-state-in-effect) | full tsc + eslint limpos |

Issues #169–#173, #175, #176: verificadas corrigidas no código (FIX-170, sent-awaiting-history, approval rank, undo display-safe, scroll parked, undo-reconcile, pending-send por ator) — todas CLOSED com evidência após o E2E live.

## 3. E2E live com modelo real (produção `0405fba`, Test Family, sem tocar dados reais)

- **live-mobile-full PASS (1.2 min):** login → conta → transação → extrato → TED leitura de dado real → TED mutação com aprovação (1 único POST de decisão).
- **live-ted-conversation PASS (1.5 min):** o caso #170 ponta a ponta — `gastei 90 com carne` → pergunta de categoria → `mercado` no mesmo draft → proposta → confirmação → negação → reload → undo.
- **Limpeza verificada:** 2 txs soft-delete (DELETE + `Idempotency-Key`, 200) + 1 conta deactivate (200); re-verificação: 0 contas + 0 txs E2E restantes. (Ajustes de estrada: DELETE sem content-type — 415 com body vazio; deactivate exige `Content-Type` json.)

## 4. Limitações pós-piloto (não afetam jornada essencial)

PWA-05 flakes (CI-only), AGT-03 monólitos (deferred), STT finding (coorte restrita, fora do piloto), Vision (quota/privacidade), PDF fail-closed, web indisponível, autoexecute shadow, Release B flip (gate ~24/10, PWA-01 já desacoplado), cutover F3–F5, `migrateV2toV3` sem cláusula de aba (sem chamador em produção), typecheck local exclui `*.test.ts` (pegou 1 falha só no CI).

## 5. Links

PR #226 · CI main `39240378530` · PWA CI `39240378590` · Agent Deploy `39241418250` · PWA Deploy `39241418243` · issues #169–#173, #175, #176, #214–#216 CLOSED.

## 6. Veredito

**PILOT_READY_WITH_LIMITATIONS** — todas as jornadas essenciais (texto, leitura, proposta, aprovação, correção, cancelamento, desfazer, reload, retry, isolamento) provadas live com modelo real em `0405fba`; P0=0; sem duplicação; backup/rollback íntegros; limitações do §4 fora do caminho essencial.
