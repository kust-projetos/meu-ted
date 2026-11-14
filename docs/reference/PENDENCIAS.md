# Pendências do Meu Ted - pós-V1 (2026-11-14)

**Estado de referência:** `main@37090d7`; PRs #361, #363, #364, #365 e #367
mergeados; #367 implementa freshness de evidência. CI e PWA CI verdes.
Produção documentada: API `32a05cb` (build
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
- **E2E sintético local (2026-11-13):** funcional mobile **145/145 PASS** em 6 lotes
  (autenticação, isolamento entre workspaces, contas, receitas/despesas,
  transferências, cartões/parcelas, faturas e pagamentos, metas, orçamentos,
  contas a pagar, TED pending/UI); rollback A0 (P2D) **1/1 PASS**; leitura
  conversacional com runtime real (P2D offline) **PASS** — browser → Next →
  gateway loopback → SDK → `list_accounts`/`get_month_summary` → API, com 1
  prompt, 2 tools e 2 GETs, zero escrita; mutações conversacionais (P3
  integrado) **PASS** — 7 turnos confirmados, 1 cancelamento e recuperação de
  contexto, zero escrita financeira direta. Um 502 `upstream_unavailable` foi
  reproduzido no caminho: em dev o `getCloudflareContext` resolve as `vars` de
  produção do `wrangler.jsonc` (allowlist e gateway) e sobrepõe `process.env`;
  o harness só escrevia `.dev.vars` nos modos A0. Corrigido para escrever e
  restaurar `.dev.vars` em qualquer execução P2D e para repassar a allowlist ao
  env dos modos live. Execução local — não é homologação em produção.

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

Issues abertas (10): #87, #95, #116, #131, #134, #136, #151, #235,
#245, #246.

Issue #218 foi implementada e fechada em 2026-11-14 pelo PR #367.

Issues fechadas no saneamento: #229, #230, #231, #232, #233, #236, #237,
#238, #239, #240, #241, #242, #243, #247, #248, #249, #251, #252, #234 e
#250 — **20 issues encerradas no ciclo** (18 anteriores + #234 e #250).
#234 foi encerrada em 2026-11-14 como **não aplicável**: parser preservado e
testado; `unpdf` não é dependência morta. #250 foi encerrada em 2026-11-14
como **não planejado**: token single-use no servidor; mint por chamada
preservado e proteção de replay inalterada. Também estão fechadas as anteriores
#244, #165, #143, #345 e #362.

Classificação atual:
- **Concluídos no saneamento:** #229–#243 (exceto #234/#235/#245/#246),
  #247, #248, #249, #251, #252.
- **Suspensa pós-V1:** #235 (STT desligado; duração de áudio não-WAV exige
  decodificação confiável ou recusa do formato).
- **Gates humanos:** #245 (purge Test Family), #246 (cutover F3–F5).
- **Pós-V1 / pesquisa:** #87, #95, #116, #131, #134, #136, #151.
- **Entrega de produto:** #218 (freshness de evidência financeira), implementada
  pelo PR #367: política em
  [`evidence-freshness-policy.md`](../architecture/evidence-freshness-policy.md),
  gate em `runGroundedRead`, telemetria `agent.evidence.stale` e goldens
  TEDV2-064/065/066.

#362 era duplicata do gate Release B (aberta pela última execução agendada do
workflow `release-b-reminder.yml`, já removido) e foi encerrada com a mesma
evidência de #345.

## 6. Sugestão para a próxima sessão

1. Se o foco for produto, escolher **uma** decisão da seção 4 e tratá-la como
   nova missão.
2. Se o foco for plataforma, priorizar #87; para gates humanos, #245/#246; para
   dívida de teste, #151.

**Limites que continuam valendo:** nada foi deployado neste saneamento; deploy
é manual (`workflow_dispatch`) e exige autorização explícita, assim como merge
ou alteração em produção. `TED_PRIVATE_VIEWS_ENABLED` permanece OFF; o trabalho
local não commitado do cartão deve ser preservado.
