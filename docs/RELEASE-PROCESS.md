# Processo de release (tag SOMENTE após atestação final)

> **Regra de ouro: tag manual fora do fluxo é PROIBIDA.** O único caminho
> autorizado para criar tag/release é o workflow
> [`release-promote.yml`](../.github/workflows/release-promote.yml)
> (disparo manual). A tag `v1.0.0` foi criada antes de CI/deployments do
> commit documental final terminarem — este processo existe para que isso
> não se repita.

## Ordem canônica

1. Push na `main` → **CI + PWA CI** (job `Gate — all checks`) verdes.
2. `workflow_run` dispara **Agent Deploy** e **PWA Deploy**:
   `gate → deploy → smoke → attest`, exigindo `attestation=ATTESTED` com
   `reason=deploy-smoke-pass` no **mesmo SHA** (verde com
   `deploy=skipped` **não** é release).
3. **API na Contabo** via wrapper manual `api-release-20260930.sh
   --execute` (backup pré-release + manifesto + rollback tag + smokes
   `/health`+`/ready` com `gitSha`/`buildId` casados).
4. **Homologação live manual**: E2E `live-mobile-full` PASS
   (`workspaceWriteViolations` vazio, só Test Family) + limpeza
   verificada (0 resíduos "Teste E2E*").
5. **Este fluxo**: `Actions → Release Promote → Run workflow`, preenchendo
   os inputs abaixo. Só então a tag anotada + GitHub Release são criadas —
   **por último**.

## Inputs do `workflow_dispatch`

| Input | Significado |
|---|---|
| `sha` | SHA web/main candidato (40-hex), precisa ser o HEAD atual da `main`. |
| `api_sha` | SHA da API em produção (40-hex; igual a `sha` quando unificado — camadas têm SHAs independentes, ex.: API `fd3481f` vs Agent/PWA `715b2cf`). |
| `version` | Nome da tag (`vMAJOR.MINOR.PATCH`, ex.: `v1.0.1`). |
| `api_manifest` | Arquivo do manifesto do release na VPS (ex.: `release-manifest-<sha>-<ts>.json`). |
| `e2e_evidence_url` | URL `https` da evidência do E2E live PASS. |
| `confirm_api_release` | `true` = API via wrapper confirmada (backup + manifesto + smokes). |
| `confirm_e2e_pass` | `true` = homologação live PASS + limpeza confirmadas. |

## O que o workflow valida (tudo fail-closed)

- Formato dos inputs + ambas as confirmações `true`.
- `sha` == HEAD atual da `main` (sem taguear SHA defasado).
- **CI + PWA CI** `success` (push-originated) para `sha` **e** `api_sha`.
- **Agent Deploy + PWA Deploy**: existe run do mesmo `sha` com jobs
  `gate`+`deploy`+`smoke`+`attest` todos `success` — isto equivale a
  `ATTESTED`/`deploy-smoke-pass` (derivado dos jobs, nunca do verde do
  workflow sozinho).
- Identidade live da API: `GET https://api.synkroo.com.br/health`
  com `gitSha == api_sha` (manifesto/smoke casado).
- Tag inexistente (tags nunca são movidas; repetir exige bump de versão).

Qualquer falha acima **aborta sem criar tag nem release**.

## Notas operacionais

- Sem trigger em `push`/`tag`: o workflow só roda por despacho manual.
- Não altera branch protection (`Gate — all checks` + `quality (22, 10)`
  continuam obrigatórios).
- A tag aponta para `sha` (baseline viva/main); o corpo da tag e da
  Release registra `api_sha`, manifesto, runs de deploy e evidência E2E.
- Rollback de API continua pelo mecanismo do wrapper (rollback tags
  `pi-finance-api:rollback-pre-*` na VPS), independente da tag Git.
