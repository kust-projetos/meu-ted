<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Meu Ted — PWA canônica

- Frontend canônico em `apps/pwa` (Next.js 16, Cloudflare); fala com o backend só via proxies same-origin `/api/backend` (API Contabo) e `/api/agent` (Agent Cloudflare).
- Auth é session-first cookie-only (Better-Auth); device binding complementa, nunca substitui a sessão online.
- TED: o PWA envia só decisão + `requestId`; nunca atestação ou segredo; receipt seguro validado é obrigatório para aceitar `succeeded` (succeeded sem receipt válido é rejeitado).
- Comandos (em `apps/pwa`): `pnpm dev`, `pnpm test`, `pnpm build`, `pnpm lint`, `pnpm typecheck`.
- Canônico operacional: `AGENTS.md` da raiz (topologia Contabo/Cloudflare, gates, regras financeiras).
