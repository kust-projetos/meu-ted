---
date: 2026-11-17
status: execução parcial
---

# Sequência de corte e rollback

Sequência documentada; não executar como parte deste plano. Produção somente com autorização explícita.

| Etapa | Mudança | Verificação / contenção |
|---|---|---|
| S1 — CONCLUÍDO | API emite token delegado. | `POST /auth/agent/pending-token`; integração lifecycle 7/7. |
| S2 — CONCLUÍDO | Gateway recebe superfície pending/undo/attest. | Integração contra API Fastify real, 7/7; atestação HMAC canônica. |
| S3 — CONCLUÍDO | PWA roteia pelo gateway; anexos ficam fora. | Proxy gateway-only; typecheck e lint sem erros. |
| S4 — PARCIAL | Inteligência financeira. | Leitura real passou; piloto de proposta+confirmação bloqueado por falhas do harness, ver `VALIDATION.md`. |
| S5 — CONCLUÍDO | Remover live-sync, anexos e memória/prefs. | Live-sync, anexos/microfone removidos da PWA; testes PWA 305 arquivos/2710 testes. |
| S6 — CONCLUÍDO | Corte total: remover pin/kill-switch/allowlist/fallback A0; simplificar proxy. | Proxy gateway-only, sem pin/kill switch/allowlist/fallback A0. |
| S7 — CONCLUÍDO | Remover `apps/agent`, broker e CI/docs acoplados. | `apps/agent` e `apps/codex-broker` removidos; lockfile sem importer A0. |
| S8 — PARCIAL | Validação E2E. | Gates passaram e integração Pending V2 7/7; piloto real de leitura passou. Proposta+confirmação pendente por falhas de harness; recursos de produção não removidos. |

## Rollback

- Até S6, manter pin `agent` e kill switch disponíveis para retorno ao A0.
- Após S6, rollback é a versão anterior do app + infra.
- Não remover recursos Cloudflare em produção nem dados históricos A0 nesta sequência. Remoção requer autorização específica.
