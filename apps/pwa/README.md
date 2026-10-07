# Meu Ted — PWA

Aplicativo Web Progressivo (PWA) complementar do [Pi Financeiro](..), um rastreador de finanças pessoais.

Roda dentro do diretório `apps/pwa` deste monorepo.
Este diretório é o frontend canônico atual do produto.

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16.2 (App Router) |
| Styling | Tailwind CSS v4 |
| State | React Context (`AppStateProvider`) |
| Testing | Vitest + Testing Library |
| Auth | Session-first cookie-only + device binding (Better-Auth; device token não substitui sessão online) |
| API Client | Proxies same-origin `/api/backend` (API Contabo) e `/api/agent` (Agent Cloudflare) |
| Deployment | Cloudflare Workers via `@opennextjs/cloudflare` |

## Root Directory

Todos os comandos rodam a partir de `apps/pwa`:

```bash
cd apps/pwa
```

## Getting Started

```bash
pnpm install
pnpm dev        # Next.js dev server on localhost:3000
pnpm test       # suíte Vitest (+ Playwright/E2E)
pnpm build      # Standard Next.js build
pnpm lint       # ESLint
```

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_PI_FINANCE_API_BASE_URL` | Base URL da API autoritativa. Local: `/api/backend` (proxy same-origin para `https://api.synkroo.com.br`); Produção: `https://api.synkroo.com.br` (definido em `wrangler.jsonc` vars). |
| `NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL` | Base URL do Agent Cloudflare (TED). Local: `/api/agent` (proxy same-origin para `https://<AGENT_HOST>`); Produção: `https://<AGENT_HOST>` (runtime env `PWA_AGENT_PROXY_ORIGIN`, valor de `AGENT_PROD_URL`, ver `resolveAgentOrigin` em `src/app/api/agent/[...path]/route.ts`). |

Sem `NEXT_PUBLIC_PI_FINANCE_API_BASE_URL`, o PWA roda em modo mock **sem** requisições
de rede — `AuthGate` é bypassado e dados vêm de mocks em memória.
Sem `NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL`, o TED retorna `Agent não configurado` e
o chat fica indisponível; a API financeira continua independente.

Configure localmente via `apps/pwa/.env.local` (não versionado, vide `docs/runbooks/pwa-local-dev-2026-08-28.md`):
```bash
NEXT_PUBLIC_PI_FINANCE_API_BASE_URL=/api/backend
NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL=/api/agent
```
Para build local de produção (standalone), exporte ambas as vars antes de `pnpm --filter pwa build`:
```powershell
set "NEXT_PUBLIC_PI_FINANCE_API_BASE_URL=/api/backend" && set "NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL=/api/agent" && pnpm --filter pwa build
```
Produção Cloudflare lê as mesmas vars de `apps/pwa/wrangler.jsonc` (vars). Não hard-code
URLs em código de produção e não commite `.env.local` — use apenas os proxies `/api/*` no local.

## Environment Behavior

| `BASE_URL` (API) | `AGENT_BASE_URL` (TED) | Comportamento |
|---|---|---|
| set (`/api/backend` ou `https://api.synkroo.com.br`) | set (`/api/agent` ou `https://<AGENT_HOST>`) | API + TED operacionais; `AuthGate` ativo; proxies same-origin `/api/backend` e `/api/agent` encaminham para upstreams com headers `x-device-token` / `x-agent-connection-token` |
| set | unset | API operacional, TED retorna `Agent não configurado` |
| unset | set ou unset | Mock mode: `AuthGate` bypassed, dados em memória, zero requisições de rede |
| | | `localStorage.getItem("pi-finance:token")` usado somente quando `NEXT_PUBLIC_PI_FINANCE_API_BASE_URL` está configurado |

> **Nota de segurança:** o device token é armazenado no `localStorage` sob a chave
> `pi-finance:token`. Isso é intencionalmente acessível via JavaScript — o PWA
> atua como cliente first-party do próprio backend e não suporta cenários
> de embed de terceiros. Nenhum mecanismo de token via env `NEXT_PUBLIC_*`
> é usado.

## Cloudflare Deployment

O app tem como alvo Cloudflare Workers via `@opennextjs/cloudflare`.

### Local Preview

```bash
pnpm preview
```

Compila o app para Cloudflare com `opennextjs-cloudflare build` e inicia
o `wrangler dev` localmente (porta 8787).

**Windows:** o build do OpenNext cria symlinks durante a etapa de bundle.
Ative o Modo de Desenvolvedor (`Configurações → Privacidade e segurança → Para desenvolvedores`)
ou rode o terminal como Administrador antes de compilar.

### Deploy to Production

```bash
pnpm deploy
```

Compila, adapta e faz deploy para a conta Cloudflare configurada em `wrangler.jsonc`.

### R2 Cache (Optional)

Para Incremental Static Regeneration (ISR), configure um bucket R2:

1. Crie o bucket `pi-finance-pwa-cache` no Painel Cloudflare → R2
2. Descomente o binding `r2_buckets` em `wrangler.jsonc`
3. Descomente `r2IncrementalCache` em `open-next.config.ts`

Sem R2, as páginas estáticas funcionam corretamente; a revalidação ISR é ignorada.

### Configuration Files

| Arquivo | Finalidade |
|------|---------|
| `wrangler.jsonc` | Nome do Worker, entry point, compatibility flags, binding R2 |
| `open-next.config.ts` | Config do adaptador OpenNext (estratégia de cache) |
| `next.config.ts` | Config padrão do Next.js |

### Manual Commands

```bash
pnpm build:next:cloudflare              # Next.js webpack build for Cloudflare
pnpm opennextjs-cloudflare build --skipBuild   # OpenNext adapt (skip next build)
pnpm wrangler dev                       # Start local Wrangler preview
pnpm opennextjs-cloudflare deploy       # Deploy without rebuild
```

## Security Middleware (Next.js 16 / OpenNext)

O app aplica headers de segurança + nonce de CSP em cada requisição via
`src/middleware.ts` com `export const runtime = "experimental-edge"`.

**Por que não `src/proxy.ts`?** O Next.js 16 recomenda `proxy.ts` em vez do
`middleware.ts` depreciado, mas um `proxy.ts` do Next 16 não aceita definir runtime
e sempre roda em Node.js (erro de build: *"Route segment config is not allowed in Proxy file. Proxy
always runs on Node.js runtime."*). O OpenNext Cloudflare rejeita middleware Node.js:

> ERROR Node.js middleware is not currently supported. Consider switching to Edge Middleware.

Por isso `middleware.ts` (Edge) é **obrigatório** para o deploy OpenNext/Cloudflare
compilar. O aviso (**warning**) de depreciação do `middleware.ts` no Next 16 não é fatal (o build
continua passando); a rejeição do OpenNext ao Node.js é fatal (quebra o `opennext build`).

**Gatilho de migração — migrar para `src/proxy.ts` somente quando AMBOS valerem:**
1. O OpenNext Cloudflare não mais emitir o erro `Node.js middleware is not currently supported`
   (após atualizar `@opennextjs/cloudflare`), **e**
2. O Next.js 16+ permitir runtime Edge em `proxy.ts` (atualmente um export `runtime`
   é rejeitado).

Até lá, mantenha `src/middleware.ts` (Edge). Não "corrija" o aviso de depreciação
renomeando para `proxy.ts` — isso quebra o deploy.

## Architecture

```
apps/pwa/
├── src/
│   ├── app/            # Páginas do Next.js App Router
│   ├── components/     # UI reutilizável (AppShell, BottomNav, etc.)
│   ├── features/       # Páginas de funcionalidade (home, records, cards, auth, …)
│   └── lib/            # Auth, client da API, gerenciamento de estado, tokens
├── wrangler.jsonc
├── open-next.config.ts
└── package.json
```

Fluxo de auth (API configurada): `RootProviders` → `AuthGate` → login email/senha session-first cookie-only via Better-Auth (cookie de sessão como autoridade; device binding complementar) → conteúdo do app.
Fluxo mock (sem API): `RootProviders` contorna o `AuthGate`, renderiza o `AppStateProvider` diretamente com dados mock.
Leia mais em `docs/superpowers/plans/2026-06-23-pwa-cloudflare-cutover.md`.
