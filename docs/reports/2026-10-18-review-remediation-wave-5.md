# Relatório — Onda 5 (feat 45de23bd: T09 decisória own-only + gate YAML #13)

**Data:** 2026-10-18
**Autor:** Planner (sessão de execução pós-decisão do operador)
**Branch:** `feat/t09-undo-own-only` → **PR #224** → squash `45de23bd4b4a039102b548bc2425399e9d4a2635` na `main`

## 1. Escopo executado

Onda 5 do plano `docs/superpowers/plans/2026-10-17-full-project-review-remediation.md`, destravada pela decisão do operador
(neste dia, sessão anterior ao relatório da onda 4):

1. **Fatia 1 — T09 decisória (decisão A):** undo implícito elege SOMENTE operações do próprio ator; fallback para head
   do household removido; cross-actor permanece permitido APENAS por apontamento explícito de `lastOperationId`
   (nomear = autorizar), com confirmação vinculada ao receipt exibido.
2. **Fatia 2 — follow-up #13:** gate estrutural de YAML dos workflows (parseia todos `.github/workflows/*.yml|yaml` com
   o parser `yaml`; fail-closed para parse error/arquivo vazio/dir ausente; wiring pre-commit 9º gate + CI job `docs`).
3. **Docs — ADR-028** (`docs/adr/ADR-028-implicit-undo-own-actor.md`) + índice em `docs/adr/README.md`.

## 2. Commits (task-scoped; 4 commits squashados)

| Commit | Conteúdo |
|---|---|
| `c66ef05` | `feat(api)`: eleição own-only em `apps/api/src/approvals/undo.ts` + matriz de testes a–f2 (route level) |
| `c1ee3be` | `feat(ci)`: `scripts/check-workflows-yaml.mjs` + `*.test.mjs` + devDep `yaml@2.9.1` + `.husky/pre-commit` + `ci.yml` (job docs) |
| `2eb8ad1` | `docs(adr)`: ADR-028 + índice |
| `3ad6509` | `test(api)`: PG e2e (`canonical-audit-effect-ref`) nomiundo explicitamente o alvo do undo conforme ADR-028 item 5 |

## 3. Validação

- **Tester independente:** PASS 9/9 (T09: matriz completa vs aceite linha 174 — dois atores/dois workspaces, head consumida, alvo explícito não autorizado, redelivery/concorrência) e 6/6 (gate YAML + adversarial tabs fixture exit 1 citando arquivo); full API suite 2633 passed / 92 skipped; `tsc -p tsconfig.build.json` limpo.
- **Reviewers strong ×2:** APPROVED (1 P2 corrigido por fatia: teardown de fixtures; replay do caso (e) explicit cross-actor).
- **PG real 15 (container descartável):** undo route + 188 R1-R4/T09a-e-b (10/10) + effect-ref e2e (após fix `3ad6509`: 34/34 no conjunto de 3 arquivos).
- **CI PR #224:** 17/17 verdes no SHA final `3ad6509` incluindo required checks `Gate — all checks` + `quality (22, 10)`.
- **Incidente na CI:** job `Postgres — integration tests` falhou no 1º push do PR (`canonical-audit-effect-ref.test.ts` caso "HTTP string-form keyed expense → undo restores"): o teste usava undo IMPLÍCITO para reverter uma row escrita sem ator (`audit_logs.user_id = NULL` via claim path), confiando no fallback household-head removido. Diagnóstico: dependência legítima da heurística (não bug de identity-space). Correção (test-only): alvo nomeado explicitamente conforme ADR-028 item 5 (dependência vira apontamento; zero mudança de produção).

## 4. Deploys pós-merge (squash `45de23bd`)

### 4.1 Contado (CI main + deploy workflows)

- CI main `39159511989` — **success** no `45de23bd`.
- Agent Deploy run `39160184349` — deploy ✓ / Post-deploy smoke ✓ / **attestation=ATTESTED** (`deploy-smoke-pass sha=45de23bd… buildId=39159511988`).
- PWA Deploy run `39160184357` — deploy ✓ / Post-deploy smoke ✓ / **attestation=ATTESTED** (`sha=45de23bd…`).
- (1º par `39160059883/81` — corrida `workflow_run` conhecida: attestation-only; 2º par real.)

### 4.2 Release API Contabo via wrapper (`api-release-20260930.sh --execute`)

- Dry-run plano ✓; preparação: backup pré-release **`pi-db-20261018T202115Z.dump`** (396K; sha256 `37ad6a2b061a26f8f63953ea3d713ce91d82e9702f19094e44cd0080496d6293`, validado por `sha256sum -c`) + checkout pristine `~/infra/pi-finance-api/src-45de23b` (HEAD exato `45de23bd…`, dirty=0).
- Execução via nohup + watcher local (lição da onda 4: cliente SSH mata foreground longo — zero mutação foi feita antes da morte do cliente).
- **RELEASE OK** (log `release-45de23b.log`, ~20:22Z):
  - lane **source-build** do checkout pristine; imagem nova `pi-finance-api:release-45de23b` (id `sha256:1dede9418316a2911e96f11805fb0630a36c251aea0f73ab4b754409f704becf`), build args `BUILD_SHA=45de23bd…` `BUILD_ID=39159511989`.
  - Container recriado/iniciado; **rollback tag `pi-finance-api:rollback-pre-45de23b` = imagem anterior `18cca1561ca2`** (era `4c40ae05`, preservada na cadeia com `rollback-pre-4c40ae0` = `45b31ab89b15`).
  - Manifest `release-manifest-45de23bd4b4a039102b548bc2425399e9d4a2635.json` (outcome=released; `pre_image` = `18cca1561ca2…`; `pre_health_sha` = `4c40ae05…`).
  - Flags intactos: `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical`, `TED_RISK_BASED_AUTOEXECUTE=shadow`; `RestartCount=0`.

### 4.3 Smokes externos read-only (~20:3xZ)

| Endpoint | Resultado |
|---|---|
| API `https://api.synkroo.com.br/health` | `ok` + `sha=45de23bd4b…` + `built=2026-10-18T20:22:33Z` |
| API `/ready` | `{"status":"ready"}` |
| PWA BFF `…/api/backend/health` | `gitSha=45de23bd4b…` (round-trip edge→API) |
| Agent `/health` | `status=ready` + `buildSha=45de23bd4b…` |

## 5. Estado resultante

- **Produção:** API Contabo `pi-finance-api:main` = release `45de23bd…` (rollback íntegro para `4c40ae05`); Agent/PWA Cloudflare attested no mesmo SHA; schema top inalterado (V063; sem migrations).
- **Semântica de undo:** própria-A em produção (próprio-only; cross-actor só com nomeação explícita). Interfaces (rotas/PWA/Agent) inalteradas — apenas o alcance heurístico foi estreitado.
- **Gate novo:** pre-commit com 9º gate rápido (workflows-yaml) + job `docs` no CI com parse estrutural — o ci.yml editado passou pelo próprio gate (9 workflow files parsed).

## 6. Pendências / follow-ups

- Branch local `feat/t09-undo-own-only` mantida como âncora dos commits granulares (`3ad6509`): push dos commits granulares não existe (origin pós-squash); higiene = deletar quando conveniente (sem dep).
- O registro do **relatório destas decisões** segue como PR de docs separado (este arquivo + CHANGELOG se necessário).
- **Follow-ups #9–#14** do PR #222 continuam não-bloqueantes e sem escopo definido pelo operador (#13 foi o único autorizado e executado nesta onda).

## 7. Regras obedecidas nesta onda

- Merge = go explícito do operador ("pode executar") ✓; squash via GH (branch protection recusa push direto) ✓.
- TDD RED→GREEN nas duas fatias ✓; commits task-scoped, nunca `git add -A` (4 commits com caminhos explícitos, caminhos sem escape) ✓.
- Coders/reviewers/tester fazem NADA de git; Planner integra ✓.
- Mutação de produção pela única via autorizada: wrapper `api-release-20260930.sh --execute` com evidence flags + backup + rollback ✓.
- `docs/reports/`: sem machine names internos fora da lista não-permitida; smokes apenas para endpoints permitidos ✓.
