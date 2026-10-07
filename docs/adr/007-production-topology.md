# ADR-007: Topologia de Produção e Separação Edge / VPS

> **Status: superseded pela migração Contabo 2026-10-03.** Ver
> [relatório](../reports/2026-10-03-vps-migration-contabo.md).
>
> **Addendum 2026-10-07:** (1) o `pi-stack` da Hostinger está extinto para o
> pi-financeiro (removido em 2026-10-03); (2) produção atual na VPS Contabo
> (Docker 29 + Traefik + PostgreSQL 15); (3) borda Cloudflare (PWA + Agent)
> inalterada. A decisão original abaixo permanece como registro histórico.

**Status:** accepted  
**Date:** 2026-08-18  
**Decision:** D07  

## Contexto

Diferenciar claramente os serviços que rodam na infraestrutura física (VPS Hostinger) daqueles executados na edge global (Cloudflare).

## Decisão

1. **Hostinger VPS (`pi-stack`):** Hospeda o container PostgreSQL 16 e o servidor Fastify API (`apps/api`).
2. **Cloudflare Pages / Workers:** Hospeda a PWA canônica (`apps/pwa`) e o Cloudflare Agent Worker (`apps/agent`).
3. O repositório legado `../pi-finance-web` e processos locais PM2/Cloudflared no Windows não representam a produção e não devem ser usados para auditoria ou deploy.

## Impacto e Rollback

- **Clareza Operacional:** Previne deploys ou verificações erradas em ambientes depreciados.
