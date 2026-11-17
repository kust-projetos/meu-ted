---
date: 2026-11-17
status: inventário
---

# Inventário de descomissionamento A0

## Migrar

| Componente | Resultado real |
|---|---|
| Chat conversacional REST (`/rpc/chat`, `/rpc/history`, `/rpc/session/new`) | MIGRADO: gateway OpenCode; PWA proxy gateway-only. |
| Broker `/rpc/pending-operations/propose` | MIGRADO: gateway usa `POST /pending-operations/v2/propose` com token delegado da API; ciclo integrado 7/7. |
| `/rpc/pending-operations/active` | MIGRADO: rota do gateway com projeção allowlist de `active`. |
| `/rpc/pending-operations/:id/decision` | MIGRADO: decisão retorna `succeeded` somente com receipt; incerteza → 502. |
| `/rpc/undo/active`, `/rpc/undo/decision`, `/rpc/undo/:requestId/verify-target` | MIGRADO: rotas undo active/decision; verify-target não recriado. |
| `/rpc/workspace/:id/attest-empty` | MIGRADO: atestação HMAC canônica byte-idêntica à API. |

## Remover

| Componente | Resultado real |
|---|---|
| `/rpc/memory/prefs`, memória DO | REMOVIDO: superfícies A0-only; dados históricos DO mantidos. |
| WebSocket `/live` | REMOVIDO da PWA (live-sync); sem remoção de recursos de produção. |
| `/rpc/attachments`, observabilidade, R2, STT/visão/PDF | REMOVIDO da PWA (UI/wire/capabilities/limites); recursos Cloudflare e dados históricos mantidos. |
| Admin modelos/providers (`/internal/agent/catalog|probe`, `llm-config`, failover/relay) | REMOVIDO: relay/config LLM internos e admin LLM A0-only removidos. |
| Auth de conexão A0 (`/auth/agent-token` consume, `x-agent-connection-token`, canonicalização namespace DO) | REMOVIDO: consumo/verificação de connection token A0 removidos. |
| Código morto | REMOVIDO: `apps/agent` e `apps/codex-broker`; ver workspaces finais no `VALIDATION.md`. |

## Manter na API

Pending V2 completo (propose/supersede/active/confirm/authorize/execute/retry/reconcile/cancel/outcome), undo, atestação/depósito, categorias, auth/membership e read-models. API é a única autoridade financeira.

## Build, CI e recursos exclusivos A0

| Item | Resultado real |
|---|---|
| Worker `pi-finance-agent`, DO `FINANCE_CHAT_AGENT` e migrações SQLite, R2 `TED_ATTACHMENTS_BUCKET`, vars/secrets `AGENT_*` e `TED_*` de anexo/voz/visão, `.github/workflows/agent-deploy.yml` | MANTIDO: recursos Cloudflare e dados históricos não removidos; produção não recebeu deploy. Remoção exige autorização e inventário próprios. |
| `scripts/check-agent-v2-invariants.mjs`, `scripts/generate-agent-tools.mjs`, `scripts/agent-release-smoke.mjs`, `scripts/canary-validation.ts`, allowlists (`legacy-runtime-allowlist.json`, `audit-allowlist.json`), `vitest.config.ts` (workspace agent), `pnpm-workspace.yaml` | REMOVIDO do build/workspace onde aplicável; lockfile sem importer A0 (`pnpm install --frozen-lockfile --offline --lockfile-only` OK). |
