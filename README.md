# Meu Ted

Sistema de gestão financeira pessoal e familiar com PWA, API autoritativa e o
assistente TED. Dados financeiros e decisões de escrita pertencem à API; o TED
é um cliente conversacional sujeito às mesmas fronteiras de identidade,
capability, confirmação e idempotência.

## Componentes ativos

| Componente | Responsabilidade | Runtime |
| --- | --- | --- |
| `apps/api` | Fonte de verdade financeira, Better-Auth, autorização de workspace e pending operations V2 | Hostinger VPS + PostgreSQL 16 |
| `apps/pwa` | Cliente web/mobile canônico e proxies same-origin privados | Cloudflare Pages/Workers + OpenNext |
| `apps/agent` | TED V2: orquestração, memória conversacional e decisão de aprovação delegada | Cloudflare Workers + Durable Objects |
| `apps/codex-broker` | Broker isolado para provider Codex; sem capability financeira ou acesso a PostgreSQL | Container Node 22 |
| `packages/llm-contracts` | Contratos compartilhados entre API e Agent | Biblioteca interna do monorepo |

O antigo `apps/whatsapp-bridge` e a extensão `.pi/extensions/financial-tools`
não são componentes ativos nem fontes de produção.

## Fronteiras obrigatórias

1. A API é a única autoridade para dados financeiros e pending operations.
2. O browser usa `/api/backend` e `/api/agent`; ele não recebe atestação,
   capability de escrita ou identidade financeira livre.
3. O Agent normaliza os canais em um pipeline V2. Durable Objects persistem
   conversa e memória não autoritativa, nunca dados financeiros.
4. `MutationExecutor` é a única fronteira do Agent para confirmar/executar
   uma pending operation V2. A operação deve estar vinculada a workspace,
   ator e dispositivo e ser confirmada antes da escrita.
5. Rollback pode reverter roteamento de leitura, mas nunca reativa
   `[EXEC_ACTION]`, writes V1 ou bypasses de capability.

## Topologia de produção

- **Borda (Cloudflare):** PWA (`apps/pwa`, OpenNext) e Agent (`apps/agent`,
  Workers + Durable Objects) deployados por workflows com gate same-SHA.
- **Backend (Hostinger VPS):** `apps/api` em container com PostgreSQL 16 local,
  exposto sob HTTPS; API nunca roda no setup local de produção.
- **Autenticação:** Better-Auth (email/senha com convites administrativos);
  resolução de workspace e permissões é integralmente server-side.

Detalhes em [Arquitetura atual](docs/ARCHITECTURE-CURRENT.md).

## Requisitos

- Node.js `>= 22.12.0`
- pnpm `>= 9.0.0` (o CI usa pnpm 10)
- PostgreSQL 16 local descartável para `test:integration`

## Desenvolvimento local

```bash
pnpm install        # também ativa o hook de pré-commit (husky, via script prepare)
pnpm dev            # PWA em modo dev (apps/pwa)
pnpm dev:api        # API em modo dev (apps/api)
pnpm build:all
pnpm test
```

## Comandos principais

```bash
pnpm docs:lint
pnpm typecheck
pnpm test
pnpm lint
pnpm governance:check
pnpm architecture:check
pnpm validate:final
```

`pnpm validate:final` gera evidências locais em `docs/reports/`. Não executa
deploy, migration de produção nem altera segredos.

## Qualidade e gates

- **Hook de pré-commit (husky):** roda 7 gates rápidos (fs/git, sem build) em
  ~15s: `docs:lint`, `action-pins:check`, `test:skip-gate`, `capabilities:check`,
  `write-policy:check`, `governance:check` e `public-safety --strict`.
  Bypass de emergência: `git commit --no-verify` (justificar no PR).
- **CI obrigatório (required checks):** `Gate — all checks` (`.github/workflows/ci.yml`)
  e `quality (22, 10)` (`.github/workflows/pwa-ci.yml`). Gates pesados —
  `typecheck`, `test`, `security:*`, E2E — são **CI-autoritativos**:
  não rodam no hook por custo. Nota de cobertura de lint: o CI roda `lint`
  apenas de API (`ci.yml:36`) e PWA (`ci.yml:135`); o lint de Agent/Broker roda
  localmente via `pnpm lint` (gate obrigatório de conclusão — regra 5 do AGENTS.md),
  pois nenhum job de CI o executa.
- **gitleaks:** executa apenas no CI (`.gitleaks.toml` cobre `.github/workflows/`);
  localmente o script sai sem escanear no Windows por design — não confie no
  scan local de segredos.
- **Regras de engenharia** (TDD RED→GREEN, isolamento por `workspace_id`,
  idempotência obrigatória, saldos por tipo de conta): ver [AGENTS.md](AGENTS.md).

## Estrutura do monorepo

```
apps/api                # API autoritativa (Fastify 5, Kysely, PostgreSQL, Zod, Better-Auth)
apps/pwa                # PWA canônica (Next.js 16, React 19, Tailwind CSS v4, Serwist)
apps/agent              # Assistente TED (Cloudflare Agents SDK + Durable Objects/SQLite)
apps/codex-broker       # Broker isolado do provider Codex
packages/llm-contracts  # Contratos compartilhados API <-> Agent
docs/                   # Documentação canônica (PRODUCT, ARCHITECTURE, ROADMAP, adr/, runbooks/, reports/)
scripts/                # Gates de qualidade, governança e validação
```

## Deploy

- **PWA e Agent:** Cloudflare via `workflow_run` pós-CI em `main`
  (`.github/workflows/pwa-deploy.yml`, `.github/workflows/agent-deploy.yml`),
  com gates de fork fail-closed e same-SHA.
- **API:** Hostinger VPS (`pi-stack`) — imagem publicada no GHCR por digest na
  `main`, com backup pré-release e tags de rollback preservadas.
- `../pi-finance-web` está **depreciado**: nunca usar para auditoria, deploy ou
  como origem de produção.

## Documentação canônica

- [Produto](docs/PRODUCT.md)
- [Arquitetura atual](docs/ARCHITECTURE-CURRENT.md)
- [Arquitetura alvo](docs/ARCHITECTURE-TARGET.md)
- [Roadmap](docs/ROADMAP.md)
- [ADRs](docs/adr/README.md)
- [Regras de agente e estado do projeto](AGENTS.md)
- [Runbook de migration V2](docs/runbooks/api-migration-v2.md)
- [Runbook de backup/restore](docs/runbooks/backup-restore.md)
- [Relatórios de sessão](docs/reports/2026-10-02-repo-config-audit.md) (último: auditoria de configuração do repositório)
