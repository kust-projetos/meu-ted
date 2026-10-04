# Migração VPS: Hostinger → Contabo (pi-financeiro) — 2026-10-03

**Status:** CONCLUÍDA — corte DNS em `2026-10-03T00:10:07Z`, smokes verdes.
**Escopo aprovado pelo operador:** somente a stack `pi-financeiro` (API + Postgres + dados). ai-memory, synkroo-prod, waha, infisical e Hermes **permanecem na Hostinger**.
**Motivação:** Hostinger com disco a 95% (2.8G livres de 48G).

## Topologia resultante

| Componente | Antes | Depois |
|---|---|---|
| `pi-finance-api` | Hostinger (container `pi-finance-api:main`) | **Contabo** (`<ip-vps-contabo>`, build `31d8c7919d5b` no SHA `e86eae9`) |
| `pi-finance-postgres` | Hostinger (pg 15.18, volume 78M) | **Contabo** (pg 15.19, mesmo dump) |
| TLS / borda | Traefik Hostinger (80/443) | **Traefik Contabo** (80/443, `acme.json` herdado + emissão nova comprovada) |
| DNS `api.synkroo.com.br` | A → `<ip-hostinger-legada>` (proxied) | **A → `<ip-vps-contabo>`** (proxied, record id `4450536551ff…`) |
| Demais hostnames (aimem, infisical, waha, whatsapp-sidecar, túneis) | Hostinger | **Inalterados** (Hostinger) |
| PWA / Agent | Cloudflare Workers | **Inalterados** |

## Fases executadas

### F0 — Preparação Contabo
- Docker 29.1.3 + docker-compose-v2 2.40.3 (pacotes Ubuntu `resolute`; repo docker.com sem build para 26.04).
- UFW: `80/tcp`, `443/tcp` adicionados (22 já presente).
- Rede docker `proxy`; diretórios `~/infra/{traefik,pi-finance-postgres,pi-finance-api,backup}`.
- Transferência Hostinger→Contabo (relay Windows, sha256 conferido nos 3 pontos): composes, `.env`s, `acme.json` (chmod 600), wrapper `api-release-20260930.sh`.
- Validações: `POSTGRES_PASSWORD` com hash idêntico nos dois `.env` (`fd10d82a…`); **zero** referências ao IP antigo em `.env`s/composes; todas as chaves fail-closed presentes (BETTER_AUTH_*, AGENT_*, TRUSTED_ORIGINS, etc.).

### F1 — Traefik + ensaio de borda
- **Fix aplicado:** `.env` do Traefik fixava `DOCKER_API_VERSION=1.55`; daemon 29.1.3 aceita máx 1.52 → provider Docker em erro. Linha removida (negociação automática). Logs limpos.
- `acme.json` herdado carregado: cert `api.synkroo.com.br` válido até 20/Nov/2026.
- **Técnica de ensaio (api-cut):** registro DNS descartável `api-cut.synkroo.com.br` → Contabo + nginx temporário com router `Host(api-cut)` + `certresolver=cf`. Provas obtidas **antes** de tocar produção:
  - emissão ACME nova na Contabo via DNS-challenge (cert LE YR2, exp 31/Dez/2026) → `CF_DNS_API_TOKEN` válido;
  - rota edge Cloudflare → Contabo 443 → backend → 200 com TLS verificado.
- Zona Cloudflare: SSL mode `full`, Authenticated Origin Pulls `off`, CAA libera Let's Encrypt — sem bloqueios.

### F2 — Postgres + validação de dados
- Dump inicial 22:43Z (`sha256 39fd2b43…`), restore com `--no-owner --no-privileges --exit-on-error` — sem erros.
- Validação idêntica linha a linha (script SQL: extensões, encoding, `_migrations` completo com 40 versões, listagem e row counts de TODAS as tabelas do schema `canonical`) Hostinger vs Contabo — **única divergência: `server_version` 15.18 → 15.19** (patch da mesma major; dump/restore idempotente nisso).
- Sink Release B preservado (contagens conferidas — ver seção Release B).

### F3 — API na Contabo
- Build do source pristine no SHA exato `e86eae93ea2d084bde2141cf4d627c86a0548533` (git archive → tar → build com `BUILD_SHA` 40-hex, `BUILD_ID=37058974818`).
- Compose com melhorias: `mem_limit` API 384m / PG 512m (swap 1g) + `logging json-file 10m×3`; router com host de ensaio incluído para o teste de borda (removido do compose em disco após o corte; entra em vigor no próximo recreate).
- Gates: container healthy; `/health` → `gitSha` 40-hex exato; `/ready` 200; boot sem fatal; round-trip real ao banco provado (`POST /auth/sign-in/email` com credencial inválida → 401 `INVALID_EMAIL_OR_PASSWORD` + 1 conexão idle do pool em `pg_stat_activity`).
- `MIGRATIONS_MODE=disabled` e `TED_RISK_BASED_AUTOEXECUTE=shadow` preservados no compose.

### F4 — Janela de corte (00:08–00:10Z)
1. `docker compose stop pi-finance-api` na **Hostinger** (fallback **frio** — quiesce de escrita; Postgres ficou up, congelado como referência).
2. Dump final `dfadc96a76bb4b6a53ac5d94fcbec6d2c0c7f492b66db460c934945a8a91908e` (diferiu do inicial → re-restore obrigatório e executado: DROP/CREATE/restore sem erros).
3. Revalidação idêntica linha a linha + login probe 401.
4. **Flip DNS** via API Cloudflare (PATCH record `4450536551ff…` → `<ip-vps-contabo>`, proxied).
5. Smokes: `/health` com `builtAt` do build Contabo (22:48:43Z) via edge; `/ready` 200; PWA `/api/backend/health` → mesmo build.

### F5 — Estabilização
- Backup diário Contabo: `~/infra/backup/backup-pi.sh` (cron `30 3 * * *`; gera `pi-db-<ts>.dump` + `.sha256` no layout que o guard do wrapper consome, + tar dos configs; retenção 14). Execução manual de prova OK (`pi-db-20261003T001142Z.dump`).
- Limpeza: registro `api-cut` deletado; diretório de ensaio removido; dumps de migração removidos das duas VPS; composes de backup (`*.bak-pre-contabo-migration`) preservados.
- `release-b-reminder.yml`: template atualizado para nomear a **Contabo** (a Hostinger congelada retornaria 0 eventos = falso PASS) e o flip do Release B na Contabo.
- `AGENTS.md`: topologia e histórico atualizados.

## Rollback

> **Atualização 2026-10-03 (pós-remoção da Hostinger):** o pi-financeiro foi REMOVIDO da Hostinger no mesmo dia da migração (containers, volume `pi_finance_pgdata`, 13 tags de imagem, diretórios `~/infra/pi-finance-*`; disco 95%→85%). O rollback N1 abaixo (reverter DNS para a Hostinger) **não existe mais**. Rollback atual: âncora de restore `backups-local/pi-financeiro-contabo-anchor-pre-hostinger-removal-20261003.dump` (sha256 `285d2065…`, estado pós-E2E) + backups diários da Contabo (`~/infra/backup`) + histórico de configs da Hostinger em `backups-local/pi-financeiro-hostinger-configs-history-20261003.tar.gz` (sha256 `e7ece66f…`).

- **N1 (histórico, extinto):** reverter o A record `api` → `<ip-hostinger-legada>` no Cloudflare. Válido apenas entre o corte (00:10Z) e a remoção da Hostinger.
- **N2 (atual, pós-escrita na Contabo):** a Contabo é a ÚNICA origem — recuperação é por restore dos dumps listados acima em nova instância da stack (compose preservado no histórico + repositório).

## Gate Release B (D11-R2) — estado capturado no corte

```
SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM audit_logs
WHERE event_type = 'auth.request.legacy_bearer_used'
AND created_at >= '2026-10-01T20:14:00Z';
```

- Hostinger (congelada no corte) e Contabo (ativa): **115 eventos**, min `2026-10-02T12:05:47Z`, max `2026-10-02T21:36:06Z` — **idênticos** (restauração fiel).
- Pela regra do gate (qualquer evento reinicia 14 dias a partir do último), a nova janela fecha ~**2026-10-16T21:36Z**. O workflow `release-b-reminder.yml` (gate 2026-10-15) instrui a consulta na Contabo.
- Contingência de acesso durante a migração: o IP da estação foi banido temporariamente (proteção anti-bruteforce Hostinger; volume alto de conexões SSH) e expirou sozinho (~15 min). Sem impacto no tráfego (443). Se ocorrer de novo, aguardar ou desban via painel (`fail2ban-client unbanip`).

### Teste E2E autenticado pós-corte (2026-10-03, credencial fornecida pelo operador)

Prova de ponta a ponta do pipeline `Cloudflare edge → Traefik → API (Better-Auth + workspace + idempotência) → Postgres Contabo`:

1. Login real `POST /auth/sign-in/email` → **200** (cookie de sessão).
2. `GET /workspaces` → 5 workspaces (resolução server-side OK).
3. `GET /accounts` com `x-workspace-id` → **20 contas reais** (dados íntegros na Contabo).
4. `POST /accounts` com `Idempotency-Key: mig-validation-…` → **201**, conta `f5b3c510-0674-46af-89d6-a52b2ee21ee5`.
5. Replay com a MESMA key → **mesmo id**, sem duplicar (idempotência provada).
6. `POST /accounts/:id/deactivate` → 200, `inactive` (limpeza; catálogo volta a 20 ativas).

## Pendências / próximos passos

1. **Primeiro release na Contabo via wrapper** (`api-release-20260930.sh --execute`): é ele quem cria `rollback-pre-<sha>` e o manifest local. O build desta migração foi bootstrap one-off.
2. **Cert órfão `api-cut`** permanece renovável no `acme.json` da Contabo (inofensivo; some no próximo recreate com label limpo + renewal natural). Opcional: podar entrada do acme.json.
3. **Hostinger:** pi-financeiro **REMOVIDO em 2026-10-03** (autorização do operador; containers/volume/imagens/diretórios; disco 95%→85%; monitor/backup sem referências; demais stacks intactas). Âncoras de preservação em `backups-local/`: `pi-financeiro-contabo-anchor-pre-hostinger-removal-20261003.dump` (sha256 `285d2065…`) e `pi-financeiro-hostinger-configs-history-20261003.tar.gz` (sha256 `e7ece66f…`).
4. **Rotação de segredos:** nada foi transferido de chave SSH entre VPS (contorno por relay não chegou a ser necessário). `.env`s copiados permanecem válidos.
5. **Monitoramento:** replicar `healthcheck.sh`/Healthchecks.io na Contabo se desejado (hoje só o backup tem cron).
6. Docs canônicos (`ARCHITECTURE-CURRENT.md`) podem receber nota da nova origem em atualização futura.

## Mudanças no working tree (regra 4 — sem commit até revisão)

- `AGENTS.md` (topologia + histórico)
- `.github/workflows/release-b-reminder.yml` (template da issue)
- `docs/reports/2026-10-03-vps-migration-contabo.md` (este relatório)
