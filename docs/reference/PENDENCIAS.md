# Pendências do Meu Ted — pós-V1 (2026-11-13)

**Estado de referência:** baseline `main@26014bf`; CI `43441230429` e PWA CI
`43441230568` verdes nesse SHA. Produção documentada: API `32a05cb` (build
`43419632296`, Contabo), Agent `15c9691` (deploy `43435350750`, ATTESTED),
PWA `15c9691` (build `43434093369`, deploy `43435345101`, ATTESTED). Release
`v1.0.4` → `32a05cb`. Release B concluída em 2026-11-11. Live-sync ativo.
Detalhe por camada em [`MEU-TED-V1-FINAL-STATE.md`](../MEU-TED-V1-FINAL-STATE.md).

Este arquivo lista o que o plano da V1 deixou explicitamente para depois e o
backlog que continua aberto. Não é uma autorização de trabalho: a próxima
missão é escolhida pelo usuário.

## 1. Gate de segurança (antes de conversas privadas)

- **#269 — isolamento por ator dos eventos WebSocket.** Issue CLOSED
  (`status:done`). C3 implementado e F1 provado em workerd. Live-sync
  **ATIVO**: `TED_LIVE_SYNC_ENABLED=1` em `apps/agent/wrangler.jsonc`; PWA
  construída com `NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED=1` e origem via
  `AGENT_PROD_URL`; CSP permite `https://` e `wss://` do host do Agent
  (PR #358). Handshake real validado em produção. Canary atual: **2
  workspaces** (`d36cb649-4462-486d-940a-47128ad329f2`,
  `550e8400-e29b-41d4-a716-446655440000`) e **3 RPC paths** no OpenCode
  (`chat`, `history`, `session/new`); kill switch retorna ao A0.
  `TED_PRIVATE_VIEWS_ENABLED` permanece **OFF**. Revogação de membership pode
  levar até 5 min; contas `Conta E2E Mobile *` desativadas continuam
  listáveis com `includeInactive=true`. Não é autorização de trabalho.

## 2. Qualidade e CI

- **#277 — flake de cold boot da PWA:** resolvido pelo PR #338 (fix do
  `t07c`); instrumentação fica como referência.
- **Dependabot:** #143 fechada como triagem concluída. Revisão de
  dependências flui via PRs do Dependabot (ex.: #354, vermelho e atrás da
  main — não mesclar) e pelo workflow agendado `Audits`.
- Cobertura LOW de `budgets.delete` (propagação de DomainError diferente de
  `not_found` e isolamento por household) fechada nesta entrega.

## 3. Gates de release

- **E2E live-mobile-full** PASS em `v1.0.4` no SHA vigente; tag/promote
  formal via `release-promote.yml` com evidência de homologação.
- **Release B (bearer legado) — CONCLUÍDA em 2026-11-11:** janela D11-R2
  conferida na Contabo (somente SELECT) com 0 eventos
  `auth.request.legacy_bearer_used` após `2026-10-19T13:23:55.399917Z`; flip
  `SESSION_BEARER_FALLBACK_ENABLED=off` e build PWA
  `NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off` (PR #320). Bearer-only retorna 401.
- **Cutover F3-F5 do legado** (ADR-024/025): API já serve o canônico;
  aposentadoria do legacy/archive é decisão humana. Issues: #246 (remover
  stores legacy), #245 (purge Test Family).
- **A19 multimodal** (pós-V1): PDF fail-closed; STT/Vision em coorte
  restrita. Reativação exige limites efetivos e gates de privacidade/egress/
  retention.

## 4. Decisões de produto (PÓS-V1 no plano)

O plano da V1 marcou estes itens como fora do escopo. Metas e orçamentos por
conversa foram implementados em #334–#337; os demais seguem sem autorização:

- Metas e orçamentos por conversa (mutação): implementados em #334–#337,
  manual-only e idempotentes.
- Conversas privadas — dependem de #269.
- Exclusões arbitrárias de dados.
- Áudio, visão, PDF, busca web e notificações proativas.
- Autoexecute `on` (hoje `shadow`) — exige sink e telemetria de undo.
- WhatsApp está fora de escopo por ora — não reconstruir Bridge nem iniciar
  integração.

## 5. Backlog técnico pós-V1

Issues abertas (31) — ordem numérica: #229, #230, #231, #232, #233, #234,
#235, #236, #237, #238, #239, #240, #241, #242, #243, #245, #246, #247,
#248, #249, #250, #251, #252, #218, #151, #136, #134, #131, #116, #95,
#87. Fechadas: #244, #165, #143, #345.

Classificação: 14 itens da era A0 (#229–#242) revalidados como válidos porque
o A0 permanece ativo como rollback e broker Pending V2. Prioridade para #218,
#243, #248, #249, #251, #252.

## 6. Sugestão para a próxima sessão

1. Corrigir os itens P2 (#243, #248, #249, #251, #252) antes de qualquer
   nova feature.
2. Em paralelo, se o foco for produto, escolher **uma** decisão da seção 4 e
   tratá-la como nova missão.

**Limites que continuam valendo:** sem deploy, merge ou alteração em produção
sem autorização explícita; `TED_PRIVATE_VIEWS_ENABLED` permanece OFF; o
trabalho local não commitado do cartão deve ser preservado.
