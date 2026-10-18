# Relatório — Review Remediation Wave 4 (T09–T13) — fecho

Data: 2026-10-18 · Branch `fix/review-remediation-wave-4` · **PR #222** · Plan: `docs/superpowers/plans/2026-10-17-full-project-review-remediation.md`

## 1. Resultado

- **Merge**: squash `4c40ae05ad45c3d396ba42c1004dcdbe0bc47f8b` na `main` (27 commits: 21 fatias + 6 de fix de integração; base `35f31f2`), após go explícito do operador. **Produção alinhada tanto no lado Cloudflare (Agent/PWA deploys + smokes) quanto na API Contabo (RELEASE OK + smokes) nesta mesma SHA.**
- **Escopo fechado**: T09-fática, T10, T11a/b/c, T12a–f (T12f com fix `57f62fb`/`497bb1c` → r3 APPROVED + r4 do cast), T13 (gate de facts fail-closed `32efcc1` → r2 APPROVED + correção de allowlist), T09 com fix de guard `06616ae` (r4 APPROVED). **T12g DEFERRED** definitivo; fonte decisória do T09 (política undo/cross-actor) seguiu **BLOQUEADA** para decisão do operador — forrado no relatório.
- **Reviews**: 12/12 fatias com reviewer forte APPROVED (P0=P1=P2=0). As 5 cobertas por substituto cheap durante indisponibilidade de quota foram refeitas com reviewer forte após renovação (T11b r2, T11c, T12c, T12d — ver corpo do PR).
- **CI**: round 1 (run `39139365327`) expôs 2 falhas reais (guard G2 stale × V016; TS2345 `parse(null)`) + incidente de YAML do `ci.yml` (`8c6ef48`); round 2: **16/16 verde** incl. `Gate — all checks` + `quality (22, 10)`; `mergeStateStatus CLEAN`.

## 2. Pós-merge (esta sessão)

### 2.1 Descoberta de estado vivo (evidência, não afirmação)
- `/health` live da API: `gitSha c43a728…` (PR #201, built 2026-10-16T16:39:12Z, buildId `38928330765`) — **produção não estava em `fd3481f`** como registros anteriores indicavam; delta real = `c43a728..4c40ae0` (wave C + wave 4; 90 files, +11310/−738).
- Schema prod: `_migrations` top = **V063** (V061/V062/V063 já presentes no release de 16-10) → delta `c43a728..4c40ae0` **sem migrations**; release source-only.
- Flags preservadas no container live: `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical`, `TED_RISK_BASED_AUTOEXECUTE=shadow`.

### 2.2 Deploys Cloudflare (Agent/PWA)
- **Confirmados por smoke externo read-only** (após `CI push` `39146772863` e `PWA CI` `39146772867` success):
  - Corrida `workflow_run` conhecida reproduzida e benigna: 1º par de deploys (runs `39147324295`/`39147324228`, ~20s) registrou **`deploy-skipped`** (attestation-only, records-only); 2º par (`39147407328` PWA Deploy 1m53s / `39147407356` Agent Deploy 1m04s) executou deploy + smoke real.
  - Agent `/health` no worker de produção (origem pinada em `apps/pwa/src/proxy-utils.ts` como `EXPECTED_AGENT_ORIGIN`): `status ready`, `buildSha 4c40ae05ad45c3d396ba42c1004dcdbe0bc47f8b` (merge SHA exato), `buildId 39146772867`; `/health/agent`: `ready`, binding `FINANCE_CHAT_AGENT`.
  - PWA `/api/build-info` no worker de produção (origem pinada como `EXPECTED_PWA_ORIGIN`): `gitSha 4c40ae05…` idêntico, `buildId 39146772867`.
- (Origens de produção em `workers.dev`, pinadas em `apps/pwa/src/proxy-utils.ts`.)

### 2.3 Release API na Contabo (wrapper `api-release-20260930.sh`)
- Backup pré-release: `~/infra/backup/pi-db-20261018T165744Z.dump` (405 KB) sha256 `d36b6cfc4bcb24426b98aff874817e791a372be10416c3e1330da8faabd15a37`.
- Lane source-build: checkout pristine `~/infra/pi-finance-api/src-4c40ae0` (HEAD == merge SHA; árvore limpa).
- Dry-run validado; **RELEASE OK** (`/tmp/api-release-4c40ae0.log`): imagem `pi-finance-api:release-4c40ae0` (id `18cca1561ca2` = `main`), container recreado **healthy**, manifest `release-manifest-4c40ae05ad45c3d396ba42c1004dcdbe0bc47f8b.json`, rollback `pi-finance-api:rollback-pre-4c40ae0` (aponta para a imagem anterior `45b31ab89b15` = era `c43a728`).
  - Nota operacional: 1ª tentativa de execute rodou sem `nohup` e foi interrompida pelo timeout do cliente SSH (build morto, zero mutação — container seguira intacto, rollback tag já ancorada). Re-execute com nohup + watcher: sucesso.
- **Smoke pós-release (externo, read-only):** edge `https://api.synkroo.com.br/health` → `gitSha 4c40ae05…`, `buildId 39146772863` (a run de CI verde atestada), `builtAt 2026-10-18T17:22:40Z`; `/ready` → `ready`; BFF PWA `/api/backend/health` → mesmo `gitSha` (round-trip edge→worker→API→Traefik→container→PG provado).
- Flags preservadas no container pós-release: `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical`, `TED_RISK_BASED_AUTOEXECUTE=shadow`.
- Nota operacional extra: todos os containers da VPS "Up 2 hours" durante a sessão (prova de reboot do host ~14:5xZ) — todos healthy (incl. `ai-memory`, `synkroo-prod-postgres`, `waha`, `traefik`).

## 3. Follow-ups registrados (14, não-bloqueantes)
Ver corpo consolidado do PR #222 — incl. gate estrutural de YAML de workflows (item 13) e alinhamento de typecheck de testes `tsconfig.json` × `tsconfig.build.json` (item 14).

## 4. Resíduos e riscos residuais
- Fatia decisória T09 (undo/cross-actor) permanece aberta ao operador.
- `Gate — all checks` materializa apenas com `ci.yml` sintaticamente válido no PR head (melhorar com item 13).
- A19 contínua NOT READY (rollout controlado pendente); Release B flip gate `2026-10-24T22:09:01.594968Z`; canary TED é gate humano — ver `docs/MEU-TED-V1-FINAL-STATE.md`.
- `tsc --noEmit` local da API nasce RED em erros pré-existentes (inclui testes; CI typechecks `tsconfig.build.json` — ver follow-up 14).

## 5. Artefatos
- PR: https://github.com/kust-projetos/meu-ted/pull/222 (squash `4c40ae0`, mergeStateStatus CLEAN, 16/16 checks).
- CI: round 2 nos runs `39141177872`/`39141177873` (PR); main push `39146772863` (CI) + `39146772867` (PWA CI); deploys `39147407356` (Agent), `39147407328` (PWA) + par skipado `39147324228`/`…295`.
- Backups: `pi-db-20261018T165744Z` (pré-release; diários em `~/infra/backup`, retenção 14).
- Manifest: `~/infra/pi-finance-api/release-manifest-4c40ae05…json`; log do wrapper: `/tmp/api-release-4c40ae0.log`.
