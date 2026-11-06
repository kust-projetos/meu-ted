# Meu Ted

Sistema de gestão financeira pessoal e familiar com PWA, API autoritativa e o
assistente TED. Dados financeiros e decisões de escrita pertencem à API; o TED
é um cliente conversacional sujeito às mesmas fronteiras de identidade,
capability, confirmação e idempotência.

## Componentes ativos

| Componente | Responsabilidade | Runtime |
| --- | --- | --- |
| `apps/api` | Fonte de verdade financeira, Better-Auth, autorização de workspace e pending operations V2 | Contabo VPS (migrada em 2026-10-03) + PostgreSQL 15 |
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
- **Backend (Contabo VPS):** `apps/api` em container com PostgreSQL 15 local,
  exposto sob HTTPS; API nunca roda no setup local de produção.
- **Autenticação:** Better-Auth (email/senha com convites administrativos);
  resolução de workspace e permissões é integralmente server-side.

Detalhes em [Arquitetura atual](docs/ARCHITECTURE-CURRENT.md).

## Requisitos

- Node.js `>= 22.12.0`
- pnpm `>= 10` (mesma major que o CI fixa via `pnpm/action-setup`)
- PostgreSQL 16 local descartável para `test:integration` (prod=15, teste=16)

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

### Preparação live opt-in do TED (prep-only, sem inferência)

```bash
pnpm test:p2d-live-prep
```

Verificação explícita e opt-in do boot do runtime TED com modelo nativo
vivo, separada do E2E sintético (`P2D_BROWSER=1`) e do CI (nenhum job de CI
invoca este comando). O que o comando faz:

- Reutiliza `apps/pwa/e2e/support/p2d-browser-stack.mts` como dono da API
  Fastify sintética/in-memory + gateway P2D sintético (scripted local stub,
  loopback); no prep o stack roda no modo sintético padrão, sem instrumentação
  nova de plugin. Exige os marcadores de readiness do
  processo recém-criado mais processo vivo — não aceita um processo
  preexistente só pela porta.
- Preflight fail-closed por nomes de arquivo: recusa `apps/pwa/.env`,
  `.env.local`, `.env.development` e `.env.development.local` (o que o Next
  dev carregaria depois do env allowlist); `.env.example` é permitido.
  Conteúdos nunca são lidos.
- Prova respostas HTTP diretas: `GET /health` da API sintética (DTO
  esperado), GET seguro no gateway sintético (404 Fastify `gateway.not_found`
  esperado — resposta sem prompt), ctl `/health` + journal (zero escritas
  financeiras na largada **e** relido após o PWA servir, cobrindo toda a
  janela observada) e `GET / 200` do PWA.
- Sobe o runtime TED real em processo filho dedicado com
  `TED_RUNTIME_PROFILE=live` e modelo nativo **configurado/selecionado**:
  `tedConfig('live')` do bootstrap (importado sem o SDK) comparado por
  igualdade estrita a `apps/ted-runtime/src/live-model.json` antes do boot —
  sem chamar API externa. Não é verificação de provider: nenhum prompt,
  nenhuma inferência e nenhuma rota `/rpc/chat` live (o seam do
  `startTedRuntime` substitui o gateway por stub prep-only).
- A credencial vem de local conhecido (primeiro `.env` da raiz, depois
  apenas `../pi-financeiro/.env`, lido com `node:util.parseEnv`) e é fornecida
  **somente** como alias `OPENCODE_GO_API_KEY` ao processo filho, antes do
  boot do SDK. `setupIsolation` limpa o env herdado primeiro e preserva
  **apenas** esse alias (nenhum `OPENCODE_API_KEY` vindo do ambiente
  sobrevive); o prep **não** traduz o alias para chave nativa e não exige esse
  mapeamento. A tradução alias→`OPENCODE_API_KEY` (a chave que o OpenCode
  2.2.4 resolve para o provider `opencode-go`) pertence **exclusivamente** ao
  caminho `pnpm test:p2d-live-real` (probe do runtime), nunca ao prep nem ao
  bootstrap de produto. PWA, API e stack sintético recebem env mínimo por
  allowlist (sem `NODE_OPTIONS`, proxies, provider keys ou `DATABASE_URL`;
  `PLAYWRIGHT_BROWSERS_PATH` é preservado por ser caminho, não segredo; PWA
  ainda fixa `NEXT_TELEMETRY_DISABLED=1`) — nenhum log imprime valores (só
  presença booleana, estágio e exit code/signal).
- Sobe o PWA real (Next dev, via Node direto, sem shim de shell) contra a
  API sintética + **gateway P2D sintético**; o upstream legado A0 é pinado
  em loopback fechada e as bases `NEXT_PUBLIC_*` de agente/API ficam vazias,
  sem fallback para produção. Home temporário isolado — nunca o
  home/config/auth compartilhado do OpenCode.
- Modo de preparação apenas, por construção (sem listener live, sem chamada
  a `session.prompt` no caminho de código): verifica API, gateway, PWA,
  perfil live, presença da credencial dentro do próprio filho antes do boot
  do SDK, modelo configurado e origens financeiras loopback. **Não envia
  mensagem, não chama `session.prompt`, não tenta provider/inferência e não
  mede contagem de prompts — a evidência é o journal observado + recibo.**
- Fail-closed e sanitizado: `.env`/alias ausente nos dois locais, arquivos
  `.env*` bloqueados, origem não loopback, perfil/modelo divergente ou
  receipt fora do allowlist abortam sem efeito colateral (erros redigem o
  valor quando carregado). Não salva nem deleta snapshots e não toca em
  `.last-run.json`. Encerramento ordenado: `/p2d/close-probe` primeiro para
  o probe interno, depois árvores (`taskkill /T` só em PID criado pelo
  runner e ainda vivo); o sumário `live-prep-verified` só sai após cada
  saída comprovada por evento (`assertAllExited`).

### Chat offline opt-in do TED (provider loopback, sem inferência externa)

```bash
pnpm test:p2d-offline
```

Fluxo completo com browser real: PWA real → proxy same-origin → gateway
loopback real → SDK OpenCode 2.2.4 (`session.prompt`) → provider
OpenAI-compatible **local em 127.0.0.1** com chave dummy em
`providers.opencode-go.settings.apiKey` → tools financeiras reais → API
sintética. O perfil é `live` e provider/modelo vêm de
`apps/ted-runtime/src/live-model.json`, mas o endpoint HTTP é o stub de
loopback: **nenhuma inferência externa**. Sem credencial real e sem chave de
provider no env do filho; `READ_SLICE_PASS` permanece NOT ACHIEVED (provider
scripted).

### Chat live-real opt-in (provider real — NÃO executar sem confirmação)

```bash
pnpm test:p2d-live-real
```

> **Não execute este comando até o operador confirmar explicitamente o escopo
> da autorização, a quota corrente e o Extra Usage.** Ele faz inferência real
> no provider; nenhum desses três itens é verificado aqui.

Mesmo fluxo, com provider/modelo nativos. A credencial é lida apenas no filho
isolado (alias `OPENCODE_GO` dos dois `.env` locais allowlisted), entregue como
`OPENCODE_GO_API_KEY` e traduzida pelo próprio probe para o `OPENCODE_API_KEY`
nativo depois do `setupIsolation` (alias removido) — prep e bootstrap de
produto não fazem esse mapeamento. Egress restrito por guard de `fetch` sem
proxy/servidor novo: GET do catálogo oficial
`https://models.opencode.ai/experimental/v2.0/api.json` (só `User-Agent` e
`If-None-Match` opcional, filtro observado `?type=chat,decision,image`, sem
`Authorization`/`cookie`/chave) e `https://opencode.ai/inference/go/…` em
HTTPS/443, apenas POST `/chat/completions` cujo body JSON declare exatamente o
`model` pinado de `live-model.json` (ausência de body, JSON inválido ou model
divergente falham **antes** do socket, com contador/reason fixos — um fallback
de provider nunca recebe a credencial); redirecionamentos forçados
para `manual` e não seguidos (`redirected`/3xx falham fechado) e qualquer
destino desconhecido é bloqueado antes do socket. Só categorias/contagens/
status são observados — nunca URL, body, header ou credencial (a única exceção
é o identificador não-secreto `model`, validado antes do socket).

O mesmo guard cobre o tráfego de loopback que o processo do probe já faz para
a API Fastify sintética (`resolveGatewayIdentity` + `HttpFinanceTransport`).
Não é liberação genérica de localhost: só o origin exato
`http://127.0.0.1:<P2D_API_PORT>` e só os pares de contrato existentes —
`POST /auth/agent-token` (body exatamente `{}`), `GET /auth/devices/me`,
`GET /accounts` (sem query) e `GET /dashboard/month-summary`
(`yearMonth=YYYY-MM`) — com allowlist de headers por rota. `localhost`, `::1`,
outra porta, outro path/método/query/header, qualquer `Authorization`/
`x-api-key` e qualquer escrita são bloqueados; contadores separados
(`apiAllowed`/`apiBlocked`/`apiStatuses`) registram só categoria/contagem/
status.

## Qualidade e gates

- **Hook de pré-commit (husky):** roda 8 gates rápidos (fs/git, sem build) em
  ~15s: `docs:lint`, `action-pins:check`, `test:skip-gate`, `capabilities:check`,
  `write-policy:check`, `governance:check`, `boundary:check` e `public-safety --strict`.
  Bypass de emergência: `git commit --no-verify` (justificar no PR).
- **CI obrigatório (required checks):** `Gate — all checks` (`.github/workflows/ci.yml`)
  e `quality (22, 10)` (`.github/workflows/pwa-ci.yml`). Gates pesados —
  `typecheck`, `test`, `security:*`, E2E — são **CI-autoritativos**:
  não rodam no hook por custo. Nota de cobertura de lint: o CI roda `lint`
  de API, `@pi-finance/llm-contracts`, Agent, Broker e PWA (jobs `api`,
  `agent`, `broker`, `pwa`); `pnpm lint` local cobre os mesmos cinco
  (gate obrigatório de conclusão — regra 5 do AGENTS.md).
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
- **API:** Contabo VPS (Docker + Compose + Traefik; migrada da Hostinger em
  2026-10-03, que não mantém mais o pi-financeiro) — imagem publicada no GHCR
  por digest na `main`, com backup pré-release e tags de rollback preservadas.
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
- [Relatórios de sessão](docs/reports/) (exemplo: auditoria de configuração do repositório em `docs/reports/2026-10-02-repo-config-audit.md`)
