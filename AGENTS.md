# Project Agent Notes

- PWA ativa: `apps/pwa/` deste repositório, hospedada na Cloudflare.
- `../pi-finance-web` está depreciado: nunca usá-lo para auditoria, deploy ou como origem de produção.
- Backend de produção roda na Hostinger VPS, não no setup local Windows pm2/cloudflared.
- Before assuming the live origin, inspect `../vps-hostinger/` for VPS access, deploy, restart, and service topology.
- Local `pm2` / `cloudflared` processes podem existir para experimentos ou fluxos antigos, mas não são fonte de verdade de produção sem confirmação explícita.
- Documentos canônicos de arquitetura residem em `docs/` (`PRODUCT.md`, `ARCHITECTURE-CURRENT.md`, `ARCHITECTURE-TARGET.md`, `ROADMAP.md`, `docs/adr/`).
- Todas as mutações financeiras passam pela API autoritativa (`apps/api`) com controle estrito de workspace.

## Transparência de Passos e Saída no Terminal (CLI Verbosity)
- **Comunicação Ativa**: Sempre explique brevemente o que você vai fazer antes de invocar ferramentas de execução de comandos (`run_command`), leitura ou edição de arquivos (`view_file`, `replace_file_content`).
- **Resumo de Resultados**: Após a execução de uma ferramenta ou comando, comente o resultado obtido, erros encontrados ou o impacto da alteração antes de partir para a próxima etapa.
- **Detalhamento**: Não execute sequências longas de ferramentas em silêncio; mantenha o usuário informado sobre o progresso em tempo real no terminal.

## Stack & Workspaces
- **Monorepo**: Gerenciado via `pnpm` (`pnpm-workspace.yaml`), `Node.js >= 22.12.0`, `pnpm >= 9.0.0`.
- **`apps/api` (Backend Autoritativo)**:
  - Framework: Fastify 5, TypeScript, Kysely, PostgreSQL (`pg`), Zod, Better-Auth (`better-auth`).
  - Runtime: Node.js hospedado na Hostinger VPS (`pi-stack`).
  - Responsabilidade: Única fonte da verdade para dados financeiros, autenticação, autorização por workspace, integridade referencial e auditoria.
- **`apps/pwa` (Cliente Canônico Web/Mobile)**:
  - Framework: Next.js 16, React 19, Tailwind CSS v4, Serwist (Service Worker PWA).
  - Runtime / Hosting: Cloudflare Pages / Workers via OpenNext (`@opennextjs/cloudflare`).
  - Responsabilidade: Interface canônica do usuário com autenticação por email/senha (Better-Auth) e comunicação direta via HTTP com a API autoritativa.
- **`apps/agent` (Assistente Financeiro AI TED)**:
  - Framework: Cloudflare Agents SDK, Durable Objects com persistência SQLite.
  - Runtime: Cloudflare Workers.
  - Responsabilidade: Motor do assistente conversacional TED, operando via tokens delegados e executando ferramentas geradas contra a API.
- **`apps/whatsapp-bridge` (Removido em P3 `f640e84`):**
  - Removido em 2026-08-25 `f640e84` (123 files `apps/whatsapp-bridge` + 3065 files `.pi/extensions/financial-tools`), `pnpm-workspace` limpo, `g6-48h-gate` COMPLETED bypass 2026-08-26, `check-legacy-runtime-references` 0 active. Evolution Go permanece como infra compartilhada (não pertence ao pi-financeiro).

## Topologia de Produção
1. **Borda (Cloudflare)**:
   - `apps/pwa` roda na infraestrutura Cloudflare (Pages / OpenNext) servindo a interface web/mobile.
   - `apps/agent` roda como Cloudflare Worker / Durable Object para orquestração conversacional do assistente.
2. **Backend e Persistência (Hostinger VPS)**:
   - `apps/api` executa em container/processo na VPS Hostinger, expondo endpoints REST autoritativos sob HTTPS (`https://api.synkroo.com.br`).
   - PostgreSQL 16 roda localmente na VPS, isolado e acessível exclusivamente pela API interna.
3. **Fluxo de Autenticação & Workspace**:
   - Autenticação via Better-Auth (email e senha com convites administrativos).
   - Resolução de workspace e permissões feita integralmente server-side na API autoritativa (`ADR-003`, `ADR-004`).

## Orquestração Orca & Comunicação Inter-Agentes
- **Supervisor / Planner**: Muse Spark via OpenCode (terminal `term_6d06e683-02d5-4967-b140-0706f32e8c44`).
- **Coder Operacional**: Antigravity agy (terminal `term_bb42c5b8-2688-474e-9026-3e98cb6434b8`).
- **Run Ativa**: `run_46965e431ba5`.
- **Protocolo de Execução**:
  - Supervisor cria tarefas (`task-create`) e despacha para o terminal do Coder (`worker-start --terminal`).
  - Coder processa instruções, emite heartbeats periódicos e executa a tarefa com transparência.
  - **Comunicação Interativa**: NUNCA utilize prompts interativos locais síncronos desconectados (`AskUserQuestion`); utilize sempre `orca orchestration ask` ou escalação de bloqueios.
  - **Finalização**: Conclusão formalizada via envio de `worker_done` com `--outcome succeeded|failed`, lista de `--files-modified` e `--body` conciso de exatamente 3 frases.

## Subagents Nativos do OpenCode (uso autônomo)
- **Escopo**: vale quando OpenCode é o runtime ativo; a seção Orca acima continua regendo os fluxos explicitamente executados/supervisionados por Orca.
- **Planner + `task`**: em sessões OpenCode, o agente principal atua como Planner e usa o mecanismo nativo de subagents (`task`) proativamente para toda tarefa não trivial de análise, implementação, debugging, testes, revisão ou documentação, escolhendo o menor conjunto de papéis úteis.
- **Direto quando trivial**: mudanças triviais/pontuais/localizadas e perguntas simples podem ser executadas diretamente, sem subagents.
- **Coordenação**: dividir trabalho independente, atribuir ownership/escopo explícito, critérios de aceite e validação; evitar escrita concorrente nos mesmos arquivos/estado; aguardar workers e integrar evidências no Planner.
- **Revisão e validação**: usar reviewer independente após mudanças substanciais e tester para validação quando útil; especialistas não subdelegam; Planner mantém decisão e integração.
- **Sem rito nem fingimento**: tarefa não trivial exige ao menos um subagent útil; evitar fan-out adicional quando o custo exceder o ganho. Falha/indisponibilidade deve ser comunicada e seguir o fallback autorizado pelo runtime, sem fingir participação.
- **Sem expansão de autoridade**: esta regra não amplia permissões, deploy ou commit.

## Regras de Engenharia & Qualidade
1. **TDD Rigoroso (RED -> GREEN)**:
   - Todo bugfix, refatoração ou funcionalidade deve obrigatoriamente iniciar com um teste automatizado falhando (RED) que capture o comportamento desejado antes de escrever o código de produção (GREEN).
2. **Isolamento Multitenant por Workspace / Household**:
   - Todo comando, rota e query SQL deve validar e aplicar estritamente o `workspace_id` e/ou `household_id`.
3. **Idempotência Obrigatória**:
   - Todas as operações de mutação financeira devem exigir e validar `Idempotency-Key` com tratamento de concorrência e idempotency records.
4. **Governança de Commits**:
   - O Coder operacional prepara as alterações e deixa o working tree pronto para revisão do Planner/Supervisor. Commits diretos devem ocorrer apenas após aprovação e validação.
5. **Gates de Verificação Contínua**:
   - Nenhum trabalho é dado como concluído sem a execução bem-sucedida de `pnpm docs:lint`, `pnpm typecheck`, `pnpm test` e `pnpm governance:check`.
6. **Saldos por Tipo de Conta**:
   - Contas `bank` e `cash` podem ter saldo inicial ou resultante negativo; aplique deltas financeiros exatos, sem clamps.
   - Contas `credit_card` mantêm saldo devedor não negativo. Consulte `docs/adr/ADR-018-negative-balance-bank-cash.md`.

## Working Tree e Estado Atual (2026-09-28 `main@3f6e7b7` — cutover canonical concluído; TED operacional em OpenCode Go; correção de workspace/live mobile E2E em andamento)
- **Sessão 2026-09-28 (agente TED quebrado → operacional):** PR #30 adicionou `sessionId` estável e `x-opencode-session` obrigatório para OpenCode Go; PR #31 corrigiu o bug pré-existente de Cloudflare Workers (`redirect: 'error'` lança TypeError; usar `manual` + fail-closed), self-hosted Plus Jakarta Sans/Space Grotesk (`next/font/local`) e logs sanitizados de falha do relay; PR #32 tornou o relay protocol-aware (`chat-completions` vs `responses` pelo protocolo registrado server-side); PR #33 corrigiu o mint device-bound de tokens (aprovações 401 H-12 × T2.5) e o duplicate-detector para o schema canonical (`account_id`/`transfer_to_account_id`, sem colunas legacy). Runtime canonical v12: ativo `opencode-go/deepseek-v4.1-flash` (protocolo `chat-completions`, training prohibited), fallback `opencode-go/mimo-v2.6-flash`; `muse-spark-1.3-contributor` permanece registrado como `training_allowed` e não pode ser ativado pela governança (tier contributor usa prompts para treino); OpenRouter tem limite de créditos e Zen está sem fundos. `OPENCODE_GO_API_KEY` provisionada no env_file da VPS com backups `.env.bak-*`. Produção API/Agent/PWA alinhada em `3f6e7b7`, health/ready 200. O pacote GHCR é privado: deploy por digest na VPS exige `docker login ghcr.io`; nesta sessão a API foi buildada do source no SHA exato do merge, com rollback tags `pi-finance-api:rollback-pre-*` preservadas. Follow-up em `fix/workspace-reload-live-e2e`: H-12×T2.5 approvals 401 corrigido; detector de duplicados canonical corrigido; E2E mobile valida Test Family com guard de escopo, full reload/header, conta→transação→TED leitura e aprovação. Encontrada regressão real: seleção de workspace era só memória e full reload voltava para `junio`; fix persistente principal-bound + race guards em validação local, aguardando PR/deploy e repetição do E2E live.
- **Sessão 2026-09-25:** 5 PRs do Dependabot mergeados (#6–#10: checkout 7.0.1, download-artifact 8.0.1, pnpm/action-setup 6.1.0, volta-cli 5.0.0, github-script 9.0.0; `main@80dfaea`, deploys PWA/Agent re-disparados e verdes); branch `v4.1-hardening` removida (conteúdo já em `main` via PR #11); **conversor legacy→canonical implementado** (branch `feat/canonical-converter`, working tree pronto para PR: `apps/api/src/scripts/canonical-converter/`, migration `V058`, reconciliação canônica com âncora, rehearsal Docker; ADR-025; gates locais verdes — units api 2142, integration PG m1–m4+ext+failed-resume, rehearsal e2e). Billing do GitHub Actions resolvido (repo público). Débito V1→V2 pending-ops **decidido** (ver `ADR-021`): V2 = só transações; undo conversional permanece serviço separado; remoção física das rotas V1 é etapa pós-cutover (F5).
- **Closure mergeada:** PR #11 mergeado em 2026-09-22 (merge commit `4e4e83c`; branch `v4.1-hardening` = 23 commits `1bb241d..e174482`, 64 arquivos). `main@7292dd8` é a baseline anterior; branch protection ativa (required checks `Gate — all checks` + `quality (22, 10)`, sem force-push/deletion; push direto a `main` é recusado — sempre via PR). CI + PWA CI success no merge commit; gates de deploy validados ao vivo (same-SHA, `head_repository`, `event == push`, freshness).
- **V4.1 closure implementada** (spec `docs/MEU-TED-SPEC-V4.1-CLOSURE-HARDENING.md`; relatório `docs/reports/v4.1-closure-hardening-final.md`): session-first cookie-only real (AUTH-T01..T08; bearer nunca é pré-requisito de bootstrap; compat ON/OFF preservados); Offline Snapshot V3 com identidade não-autenticadora, migração V2→V3 apenas com sessão validada e roteamento unreachable→read-only vs 401/403→purge+login; keyed mutations fail-closed em 7 dispatchers + undo (novo erro `idempotency.atomic_mutation_not_supported`); `createSubscriptionInTx` no schema legacy; deploys com gate `head_repository` + `workflow_run.event == push`; `public-safety --strict` required no CI; branch protection em `main` (required checks, sem force-push/deletion); API image publicada no GHCR por digest na main; manifest do Agent com lockfileHash+wranglerVersion; release-manifest consolidado; gitleaks cobre `.github/workflows/` (0 leaks em 738 commits de histórico).
- **Reconciliação read-only em produção (2026-09-21):** CLI SELECT-only via túnel SSH documentado — 1 finding apenas: conta `814332c4` (credit_card, −R$ 560,00), caso **ambíguo já documentado** na triagem; **0 new-regression**; nenhum repair executado.
- **Validação da closure:** units API 2012 / PWA 1966 / agent 541 / broker 25; PG `integration:all` 153 + concorrência 120 (DB fresco V001–V057, bootstrap: `_test_marker` + `db:migrate`); XLT-02/08/09 verdes; CI + PWA CI remotos success no mesmo SHA; 2 reviews independentes (arch/rel + security) — 5×P1 + 1×P2, todos corrigidos e revalidados.
- **Gates humanos restantes:** Release B (janela de 14 dias com 0 eventos `auth.request.legacy_bearer_used`, gate 2026-10-02); Canonical Cutover (conversor pronto, F2 rehearsal → F3–F5); reparos dos 55 findings determinísticos e decisão dos 8 ambíguos; itens future-dated (localStorage 2026-12-01, `sharp@0.34.5`, `.trivyignore` 2026-12-31). Resolvidos: billing do GitHub Actions (repo público, 2026-09-25); finding `814332c4` (reclassificado em 2026-09-22); cobertura V1→V2 pending-ops (decidida em `ADR-021`).
- **Produção (2026-09-22, rollout completo):** **API, PWA e Agent na mesma release `2d7bdf8`** — API VPS deployada por digest (`sha256:5b4d3de0…`, CI run `35771904872`, artefato `api-image-provenance`; runbook §9; rollback `pi-finance-api:rollback-pre-2d7bdf8` = imagem `bbc36930` da release anterior `d5ba79d`), PWA e Agent via Cloudflare (workflows 19:15 UTC; smokes + release identity verificados; PWA `/` e `/api/backend/health` 200, Agent `/health` `ready` com buildSha `2d7bdf8`, API `/health` gitSha `2d7bdf8` + `/ready` 200). Release anterior `d5ba79d` (API digest `bbc36930…`) documentada em `docs/reports/v4.1-closure-production-rollout.md`. `CLOUDFLARE_API_TOKEN` rotacionado (token full-access do cofre `D:\projetos\cloudflare`; trocar depois por escopo só de deploy). DB produção: schema `legacy`, migrations top **V054** (V055–V057 pendentes para o cutover). **Release B**: janela D11 iniciada 2026-09-18 (0 eventos `legacy_bearer_used`) → gate **2026-10-02**. Finding `814332c4`: dossier pronto (`docs/reports/v4.1-finding-814332c4-dossier.md`, 1 lançamento explica 100% do drift). Canonical Cutover: plano proposto (`docs/superpowers/plans/2026-09-22-canonical-cutover.md`, aguarda aprovação). Detalhes: `docs/reports/v4.1-closure-production-rollout.md`.
- **Follow-ups 2026-09-22 (autorizados e executados):** finding `814332c4` **reclassificado** em produção (backup `pi-financeiro-pre-repair-814332c4-20260922T182838Z.sql.gz`; carne R$560 → statement 2026-07 + card_purchases; recon pós: card_purchase 48/0, statement/duplicates 0, residual −56000 aceito na **allowlist v2** `adr-018-conscious-negative-credit-v2`); **lembrete Release B automatizado** (workflow `release-b-reminder.yml`, cron diário, cria issue a partir de 2026-10-02); Canonical Cutover desbloqueado tecnicamente pelo conversor (ver ADR-025 e atualização no plano; F2 rehearsal executável localmente). Branch `chore/v41-closure-followups` mergeada via PR #14 (`2d7bdf8`).
- **D1 supersedida:** a proibição histórica de saldo negativo da Phase 4 foi substituída por `ADR-018`: `bank`/`cash` aceitam saldo inicial e resultante negativo; `credit_card` mantém saldo devedor não negativo.
- **Gates humanos restantes (§3.4):** reparos dos 55 findings determinísticos e decisão dos 8 ambíguos; billing do GitHub Actions; autorização de publicação/visibilidade; decisão de rotação de credenciais e rewrite de histórico; Release B do bearer após 14 dias com 0 eventos `auth.request.legacy_bearer_used`; cutover Canonical separado.
- **Produção (estado verificado 2026-09-18):** API container `pi-finance-api` = `pi-finance-api:v41-debt-39ccc9e` (gitSha `39ccc9e…`, `/health` ok e `/ready` 200), `_migrations` top = **V054** (V053/V054 aplicadas; backup pré-V4.1 preservado). PWA Cloudflare = versão `4a9276f0-1fd1-4f2d-b08c-68b237234cf9` (gitSha `9910e42…`, `/`, `/api/backend/health` e `/api/agent/health` 200). Agent Cloudflare = versão `5279c5b4-143c-46e9-bfcf-6ff4df5d6df4` (gitSha `9910e42…`, `ready`; preflight CORS do PWA = 204 com origem exata). `main` foi fast-forward para `9910e42c`.
- **Débitos conhecidos (seção honesta, pós-sessão 2026-09-18):** RESOLVIDOS — regeneração de `http-tools.ts` com auth no gerador; bulk payables single-tx keyed; banner de retry com mesmo `commandId`; `StaleBanner` agora tenta refresh por domínio e só recarrega quando ele não recupera; suites integration auto-limpas; timeouts de migration (600s/60s); SHA-pinning completo; re-backfill de checksums em produção sem `baseline_drift`; triagem dos 63 findings; `public-safety --strict` verde; `PWA_PROD_URL`/`AGENT_PROD_URL` em GitHub Variables, fixtures `example.*`, origem Cloudflare validada por host exato e deploy/smokes sem interpolação de shell. RESTANTES — 63 findings aguardam decisão humana (55 propostos, 8 ambíguos); `refs/pi-rewind/store` mantém 1.970 commits locais exclusivos, incluindo `11b82e8`, portanto GC/rewrite exige plano explícito de preservação/rotação; default local `EVOLUTION_GO_API_URL` permanece allowlisted por decisão de ops; Release B/cutover Canonical e itens future-dated (localStorage 2026-12-01, `sharp@0.34.5`, `.trivyignore` 2026-12-31).
- **Proibição de Operações Destrutivas**: `git reset --hard`, `git clean -fd`, `git checkout -- .` exigem diff prévio e autorização.

## Idioma & Convenções
- **Comunicação e Documentação**: Português do Brasil (pt-BR) para respostas, documentações canônicas (`docs/*.md`) e relatórios de progresso.
- **Código e Commits**: Código-fonte TypeScript/SQL, nomes de variáveis, funções, tipos, comentários de código e mensagens de commit em Inglês técnico.
