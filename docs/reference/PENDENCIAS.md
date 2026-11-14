# Pendências do Meu Ted - pós-V1 (2026-11-14)

**Estado de referência:** `main@3d4e0c1`; CI `43607796925` e PWA CI
`43607797036` verdes. Saneamento final de 2026-11-14: #151 e #136 encerradas
com evidência; #95, #116, #131 e #134 classificadas fora do backlog ativo;
#235 suspensa; #245/#246 mantidas como gates humanos; #87 mantida com decisão
KEEP + migração adiada; PR #354 encerrado como incompatível.
Produção documentada (não redeployada): API `32a05cb` (build
`43419632296`, Contabo), Agent `15c9691` (deploy `43435350750`, ATTESTED),
PWA `15c9691` (build `43434093369`, deploy `43435345101`, ATTESTED). Release
`v1.0.4` → `32a05cb`. Release B concluída em 2026-11-11. Live-sync ativo;
`TED_PRIVATE_VIEWS_ENABLED` off.
Relatório do ciclo em [`../reports/2026-11-14-simplification-sweep.md`](../reports/2026-11-14-simplification-sweep.md).
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
  dependências flui via PRs do Dependabot e pelo workflow agendado `Audits`;
  o PR #354 foi encerrado como incompatível (peer graph de `agents@0.3.x`).
- Cobertura LOW de `budgets.delete` (propagação de DomainError diferente de
  `not_found` e isolamento por household) fechada nesta entrega.
- **Jornadas críticas E2E (2026-11-14):** login (`AUTH-01/02`), despesa
  (`TX-01..09`) e aprovação de operação (`OP-01..06b`) = **21/21 PASS** com
  `--retries=1` (política do gate), sem retry necessário, com journal do
  backend sintético verificado. Com `--retries=0`, `AUTH-01/02` apresentaram
  flake de cold start (`page.goto` load timeout e preenchimento antes da
  hidratação) e passaram no rerun; residual da mesma família do #277, sem
  correção especulativa.
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

Issues abertas (4): #87, #235, #245, #246.

### Encerradas no saneamento final de 2026-11-14

- **#151 — cobertura E2E determinística já atende.** Login, despesa e
  aprovação de operação rodam em Playwright com fixture API e journal
  determinístico, sem LLM no caminho feliz e com gate de matriz
  (`e2e/support/matrix.test.ts`). Não foi criado motor separado de
  record/replay; o residual de cold start está na seção 2.
- **#136 — concorrência, recuperação e replay comprovados.** Sessão/memória:
  `session-renew-sqlite-proof` (renovação concorrente A/B, 1 aberta por ator,
  sem lost write) e `memory-forget-transactional` (11 confirmações
  concorrentes, uma vence). Recuperação: `b058-temporal-continuity` (dois
  reopenings), `p0-recovery`/`server` (retry/restart sem segundo prompt) e
  rollback A0. Replay sem duplicar: `confirmation-idempotency-hardening`
  (dupla confirmação → 1 execute; replay após restart),
  `pending-adversarial` (approve/approve → 1 execução) e `retry-no-repeat`.
  Execuções: Agent 132/132 + failover 44/44, runtime 40/40, API 10/10.
- **#95 — keepalive de Durable Object não aplicável.** `compatibility_date`
  do Agent é `2026-07-01` (anterior à mudança de 2026-10-01), e não há
  `waitUntil`, `schedule`, `setAlarm` nem Workflow no Agent. Turnos são
  bounded pelo request; trabalho durável já está na API. Não criar Workflow.
- **#131 — memória versionada não planejada nesta versão.** A promoção de
  skill já exige replay + safety + humano (A18) e memória não é autoridade
  financeira; não há requisito funcional comprovado para estados
  CURRENT/SUPERSEDED/HISTORICAL/CONFLICTED.
- **#134 — Clef-omni não planejado nesta versão.** Áudio/visão seguem
  default-off e a camada de decisão é advisory/default-off; sem provider novo
  nem PoC.
- **#116 — views adaptativas fora do backlog técnico ativo.** Preservada como
  possibilidade de produto futura no ROADMAP, sem protótipo.

### Mantidas

- **#87 — KEEP + migração adiada.** O A0 segue necessário (broker único de
  `financial.approval.propose` para o OpenCode, rollback e live-sync) e
  `agents`/`ai` são runtime. `@cloudflare/ai-chat` não tem consumidor real,
  mas fica retido até o lockfile poder ser regenerado. AI SDK v6/agents 0.26
  só com necessidade funcional e prova de bundle.
- **#235 — suspensa até a decisão de reativar áudio.** STT segue
  `TED_AUDIO_STT_ENABLED=0` e coorte vazia; residual de duração por formato
  documentado em `apps/agent/AGENTS.md` (F10).
- **#245 — gate humano.** Detecta resíduos Test Family; purge exige
  autorização, backup prévio e escopo por household. Nenhuma exclusão nesta
  missão.
- **#246 — gate humano.** Stores legacy seguem ligados sob
  `DB_SCHEMA=legacy`; produção serve `DB_SCHEMA=canonical`. Remoção só após
  cutover F3–F5 (ADR-024/025), com grep de `DB_SCHEMA=legacy` no CI.

### Histórico do saneamento anterior

Issue #218 foi implementada e fechada em 2026-11-14 pelo PR #367.

Issues fechadas no saneamento: #229, #230, #231, #232, #233, #236, #237,
#238, #239, #240, #241, #242, #243, #247, #248, #249, #251, #252, #234 e
#250 — **20 issues encerradas no ciclo** (18 anteriores + #234 e #250).
#234 foi encerrada em 2026-11-14 como **não aplicável**: parser preservado e
testado; `unpdf` não é dependência morta. #250 foi encerrada em 2026-11-14
como **não planejado**: token single-use no servidor; mint por chamada
preservado e proteção de replay inalterada. Também estão fechadas as anteriores
#244, #165, #143, #345 e #362.

#362 era duplicata do gate Release B (aberta pela última execução agendada do
workflow `release-b-reminder.yml`, já removido) e foi encerrada com a mesma
evidência de #345.

## 6. Sugestão para a próxima sessão

1. Gates humanos: #245 (purge Test Family) e #246 (cutover F3–F5) exigem
   autorização explícita, backup prévio e decisão de operador; nenhum dos dois
   bloqueia o produto.
2. Plataforma: só reabrir #87 se houver necessidade funcional de AI SDK v6;
   o PR #354 foi encerrado por incompatibilidade de peer graph.
3. Áudio: #235 só entra quando a reativação de STT for decidida.

**Limites que continuam valendo:** nada foi deployado neste saneamento; deploy
é manual (`workflow_dispatch`) e exige autorização explícita, assim como merge
ou alteração em produção. `TED_PRIVATE_VIEWS_ENABLED` permanece OFF; live-sync
está ativo conforme a configuração publicada.
