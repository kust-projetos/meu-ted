# Changelog

Formato: seção `Unreleased` para trabalho não lançado; releases só com
versão/tag declarada pela governança. Nada abaixo inventa versão ou release.

## Unreleased (2026-10-23 — canário local TED de edição de descrição; sem release)

- Segurança PWA: Next.js e `eslint-config-next` fixados em `16.4.1`, Sharp em `0.35.5`, e override `next>sharp` atualizado para a linha corrigida; removida a aceitação vigente dos dois achados críticos de runtime (GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr). A compatibilidade OpenNext/Cloudflare e os gates ainda precisam de validação; nenhuma produção alterada.
- Segurança de testes: Vitest e `@vitest/coverage-v8` alinhados em `4.1.12` nos manifests existentes, corrigindo os advisories moderados de `@vitest/mocker` (GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp); validação de compatibilidade/gates pendente.

- Registro documental de canário local `transactions.update` limitado à descrição: operação manual V2, precondição literal, replay/receipt vinculado e readback sem delta financeiro observado. Não representa CRUD geral nem evidência de produção.
- Cartões, exclusões, edição de outros campos financeiros, transferências, parcelas, assinaturas, payables e faturas/pagamentos continuam fora do aceite desta fatia; ver [relatório de fechamento](docs/reports/2026-10-23-ted-local-crud-session-closure.md) e matriz referenciada.
- Revisões e gates finais/CI ainda pendentes; sem merge/deploy ou mutação de produção registrados nesta entrada.

## Unreleased (2026-10-14 - release `3de0d3a` + E2E live + higiene; docs-only, sem tag/release)

- PR #161 (`feat: explicit web_search gate, golden GW-040/042, canonical docs sync, release-promote workflow`) mergeado por squash como `3de0d3a6a2ad1a297a1b2ce11714a25dd5099485` em 2026-10-14T09:37:07Z; CI main run `38543671348` success (~6m11s), PWA CI run `38543671350` success (~7m44s).
- Agent/PWA (Cloudflare): wave1 Agent `38544430462` + PWA `38544430292` deploy=skipped (~13s, corrida `workflow_run` conhecida); wave2 Agent `38544625400` + PWA `38544625419` success com attestation `ATTESTED` reason `deploy-smoke-pass` sha `3de0d3a` buildId `38543671350` (smoke Agent attempt 1/8 PASS); live PWA `/api/build-info` gitSha `3de0d3a`; API `/health` gitSha `fd3481f` sem redeploy (pacote sem código de API).
- Conteúdo: gate `TED_WEB_SEARCH_ENABLED==='1'` (prod sem flag => search disabled); docs sync (ROADMAP 14/10, runtime-facts V060/58, SPEC banner adendo); golden 39/33/6 (GW-040/GW-042 executáveis); `release-promote.yml` novo.
- E2E live-mobile-full PASS 1/1 (~1.2min) em `3de0d3a`: violations vazio, 1 decision POST, `receipt.entity.id==ledger`, 0 page/console/server errors, 23 screenshots em `apps/pwa/test-results/live-mobile/`; limpeza run `mv7xoski` (2 DELETE 200 + deactivate 200, re-verificado 0 restantes).
- Higiene: 22 contas E2E inactive, 0 txs vivas — NO-OP verificado, zero mutações.
- NÃO feito nesta entrega (docs-only): sem código/workflows, sem deploy/tag além do registrado. Detalhes: `docs/MEU-TED-V1-FINAL-STATE.md`.

## Unreleased (2026-10-14 - homologação live + veredito V1-textual CLOSED; docs-only, sem tag/release)

- E2E live-mobile-full PASS em 14/10 (~01:0xZ, 1.7min) contra produção (PWA `c5adf53` / API `fd3481f`): login real → conta → transação → extrato → TED leitura de dado real (modelo real) → TED mutação com aprovação + recibo; viewport mobile 390x844; `workspaceWriteViolations` vazio (só Test Family `550e8400…`); screenshots em `apps/pwa/test-results/live-mobile/` (01-login, 02-home, 03-nova-conta, 04-conta-criada, 06-extrato, 07-ted-leitura, 08-ted-aprovacao, 09-ted-recibo, 10-extrato-pos-ted, 11-nav--a-pagar).
- Limpeza E2E verificada: 2 txs soft-delete (DELETE com `Idempotency-Key`) + 1 conta deactivate (POST …/deactivate; exigiu `Content-Type` json — 415 sem ele); re-verificação: 0 contas + 0 txs "Teste E2E*" restantes no Test Family. Dry-run antes (1 conta / 2 txs, só desta execução).
- Veredito: critérios do ADENDO V1-TEXTUAL atendidos — CI/PWA CI verdes, Golden textual PASS `falseSuccess=0` (8 pending-capability skipped), E2E Test Family PASS sem violations, deploys ATTESTED SHAs casados, P0=0/P1=0 no escopo textual (residuais STT/R2/`pg_hba`/gokey/probes classificados pós-V1 ou diferidos com evidência; Release B/legado/autoexec-on pós-V1 por decisão). Tag `v1.0.0` liberada pelo Planner na sequência (fora deste escopo de docs).
- NÃO feito nesta entrega (docs-only): sem commit/push, sem deploy/tag. Detalhes: `docs/MEU-TED-V1-FINAL-STATE.md`.

## Unreleased (2026-10-14 - baseline viva `715b2cf` (docs-only, sem código); baseline de código V1-textual `fd3481f`; sem tag/release)

- Agent/PWA: `715b2cf3d11c8ac03e55fea1e35b15fa2049c4c1` (build `38487522792`), ATTESTED deploy-smoke-pass runs `38488407037`/`38488407171` (14/10 ~00:09Z); delta `fd3481f..715b2cf` SÓ-docs (código idêntico).
- API: permanece `fd3481f2f92c39ff8b68727ff73939121123280d` sem redeploy por delta só-docs (decisão registrada; camadas com SHAs independentes têm precedente).
- Convenção nova: commits SÓ-docs não avançam a baseline de código e dispensam re-registro; re-registro só com mudança de código/comportamento. PRs de docs seguem CI normal.
- NÃO feito (operador): turno autenticado com modelo real em produção; E2E live-mobile-full no SHA vigente; tag `v1.0.0`. Sem alegação de homologação live.

## Unreleased (2026-10-13 noite - deploy V1-textual `fd3481f` (PR #157) nas três camadas + restore proof + higiene VPS; sem tag/release)

- Produção: API/Agent/PWA em `fd3481f2f92c39ff8b68727ff73939121123280d` (merge squash do PR #157; CI 100% verde — Gate + quality 22,10; CI/PWA CI da main `38483695616`/`…618` verdes).
- API (Contabo): release via wrapper `api-release-20260930.sh --execute` (lane source-build, checkout pristine `src-fd3481f`, sem GHCR login na VPS), backup pré-release `pi-db-20261013T195335Z` (sha256 `0b4b04ad…cdb7e`), RELEASE OK, manifesto `release-manifest-fd3481f….json` na VPS, rollback tag `pi-finance-api:rollback-pre-fd3481f` preservada; smokes `/health` (gitSha `fd3481f`, buildId `38483695616`) + `/ready` 200 + PWA `/api/backend/health` `fd3481f`; container 0 restarts healthy, sem `FST_ERR`/`DUPLICATED_ROUTE` nos logs.
- Agent/PWA (Cloudflare): deploys runs `38484529550`/`38484529484` ATTESTED deploy-smoke-pass, sha `fd3481f`, buildId `38483695618` (par anterior 23:26 deploy-skipped pela corrida `workflow_run` conhecida); live Agent `/health` ready (`buildSha=fd3481f`) + PWA `/api/build-info` (`gitSha=fd3481f`).
- Restore proof: backup `pi-db-20261013T195335Z` restaurado em PG 15 descartável (exit 0; removido após) — ledger V060, 44 tabelas, 41 contas (20 active/21 inactive), 44 expenses, 3 users, sink legacy 250 eventos MAX `2026-10-10T22:09:01.594968Z`, 22 pending_operations pending, 16 idempotency_keys, agregação funcional de outubro OK (verificação via arquivos `.sql` — quoting entre camadas corrompeu filtros inline: `252` era `44+139+69`).
- VPS: removidos `.env.bak-pre-rotate-20261013T195457Z` (API+PG, senha antiga exposta); restam `.env.bak-pre-gokey-rotate-20261008` (follow-up) + `docker-compose.yml.bak-pre-contabo-migration` (referência); pg_hba trust local/loopback + scram resto, PG sem portas publicadas (`PortBindings {}`), endurecimento adiado com risco documentado.
- NÃO feito (sem credenciais live do operador): turno autenticado com modelo real em `fd3481f`; E2E live-mobile-full em `fd3481f` (último PASS em `e91a3cd`); tag `v1.0.0`. Sem alegação de homologação live/tag.

## Unreleased (2026-10-13 - sessão V1-textual: SPEC congelado, config OFF publicado, golden GW-039/GW-041, dedup de rotas API, reidratação PWA; sem merge/deploy/release)

- SPEC: ADENDO V1-TEXTUAL congela o escopo (texto obrigatório; STT/Vision/PDF/web/autoexec-on/Release B/legado = pós-V1 diferidos; #105/#107 seguem CLOSED; precedência sobre §16/§25; §15/§24 backup/restore seguem obrigatórios na tarefa 10).
- Config publicado: Agent com upload/STT/Vision OFF + coortes vazias (R2/binding/secrets preservados); PWA sem flags multimodais no build (wrangler + next.config + ci.yml + pwa-ci.yml; PDF segue OFF).
- Golden: GW-039 (casual, claim delimitado) e GW-041 (matriz-erro) executáveis PASS; GW-040 (multi-workspace) e GW-042 (matriz-por-status) pending-capability com requires (exigem harness); catálogo 39/31/8.
- API: registro de rotas deduplicado na origem (fim do duplo `registerPendingOperationRoutes`; guard first-wins preservado; trava de unicidade); runbook com pré-swap ledger×manifesto obrigatório.
- PWA: reidratação de envio não-confirmado como failed+retry fiel (âncora v1 com refs de anexo, legada/overLimit sem retry, reconciliação temporal em toda loadHistory, marcador de anexo só como prefixo); guidance de setup no empty (contas/categorias + CTAs); limite 10 anexos pré-envio alinhado ao 413.
- Validação local: typecheck 5/5, docs:lint PASS, suítes focadas verdes (sem números agregados — detalhe nos logs da sessão), reviews independentes (2 APPROVED P1, golden APPROVED após delimitação, API APPROVED, PWA 4 rodadas até APPROVED). CI pendente no PR (CI ainda não rodou nesta branch).
- NÃO deployado, NÃO tagueado; produção inalterada. Pendências de operador inalteradas (deploys, E2E live, modelo real, PG-real, restore proof, pg_hba/.bak, Release B ~24/10, tag v1.0.0).
- Commits (branch `docs/rotation-20261013`, sem PR ainda): `4e46301` (SPEC+flags), `89d4b8c` (golden), `594f0a3` (API routes), `a3d247b` (PWA).

## Unreleased (2026-10-12 - PR137 hardening round 4 (P1-A/P1-B): âncora síncrona, fronteira >=, vínculo de apresentação, amarração intentionId→operationId na API; sem merge/deploy/release)

- Agent (P1-A1): **âncora síncrona + sighting antes de qualquer I/O de decisão** - `runForgetDecisionTurn` (sondagem de precedência) executava antes da sighting: B nascida na janela precedia a âncora e passava. `tEntry = draftNowMs()` capturado na entrada do ramo `confirmation`, `noteConfirmationSighted` movida para antes de qualquer I/O (inclusive a sondagem do forget) com `createdAt = tEntry`; check temporal usa a âncora. Regressão com relógio avançado prova B-durante-sondagem rejeitada e ordenação âncora < createdAt(B) <= presentedAt(B).
- Agent (P1-A2): **fronteira `>=`** - o comparador admitia B em T0+5s exatos; agora a fronteira rejeita (só intenção nova confirma). Regressão de 1ª listagem em +5s.
- Agent (P1-A3): **vínculo ao conjunto apresentado** - tempo como prova de identidade é insuficiente (skew negativo/forjado passa no temporal). Nova tabela `mutation_confirmation_presentations` (ws/actor/device/op, primeira apresentação vence): confirmação exige `target ∈ conjunto` com `presentationTime <= âncora`; gravação em proposes, disambiguações e listagens (após o check — nunca auto-autoriza), best-effort. Regressões: B com createdAt forjado antigo nunca apresentada é rejeitada; com card, nova intenção confirma.
- Agent+API (P1-B): **amarração intentionId→operationId autoritativa na API (direção iii)** - bind `POST /pending-operations/v2/confirmation-intentions/bind` (tabela V060 `pending_operation_confirmation_intentions`, CAS, migration registrada legacy-safe) executado na entrada do turno ANTES das escritas locais; redelivery com sighting API prévia + local fresca falha fechado (`confirmation_post_outage_redelivery`); `confirm`/`execute` propagam `intentionId` e a API recusa divergente com 409 `approval.intention_conflict` (efeito zero); agente recusa pré-transporte quando o vínculo difere. Teste de outage TOTAL (sighting+fallback down, 0 linhas locais) + replay pós-recuperação nunca confirma B; golden com stack real idem.
- Agent (P2): **rollback comportamental** - leitor/escritor fiel ao pré-hardening (`7d6283e`: `ON CONFLICT DO UPDATE`, SELECT sem `status`) sobre linhas novas: sem throw/corrupção, pior caso = residual antigo (rebind); código novo sobre tabela antiga (sem `status`): compat ADD COLUMN + default `succeeded`.
- Testes: RED pré-fix 4/4 (round 4) via stash dos fontes; focados + golden 22/22 + suite agent completa + suites API (approvals/routes/contract/unit) + PG descartável (V060 aplicada; bind/confirm/divergência/corrida/restart) verdes; typecheck/lint/docs/governance/capabilities/write-policy/skip-gate verdes. Sem merge/deploy/produção (working tree não commitado, sem commits).
- Agent (round 5 — testemunho sem exibição): **rejeição nunca grava apresentação** - os caminhos temporal/`not_presented` registravam B e respondiam só `renderInconclusive()` (sem card): testemunho forjado que liberava a intenção seguinte sem exibição real. Gravação só onde há exibição efetiva (cards de proposta, disambiguação que rende listagem, refresh pós-check). Regressão dois turnos (X rejeita sem witness → Y sem card também rejeita → Z após proposta confirma).
- Agent (round 5 — fronteira same-ms): **snapshot lógico do present-set congelado na entrada síncrona** (antes do 1º await, junto ao `tEntry`) — admissão exige `target ∈ snapshot` (pertinência), não só `presentedAt <= âncora`; B apresentada durante os awaits de X no mesmo ms é rejeitada; temporal mantido como defense-in-depth. Regressão com relógio congelado. Residual estreito documentado (proposta concorrente concluída antes do snapshot-read entra; mitigado pelo read ser o 1º I/O).
- Agent (round 5 — prune 60d→30d): **comparação corrigida nos dois stores** (`expires_at <= agora`, não `agora-30d`, que dobrava o horizonte para 60d efetivos) + fronteira testada nos dois stores.
- Agent (round 5 — rollback): **leitor antigo sobre linhas novas = FALSO-SUCESSO novo** (ignora `status`; reserva/inconclusiva com operation_id replaya como sucesso — provado em `ROLLBACK-DANGER`, além do residual antigo de rebind) — bloqueio operacional: `scripts/check-confirmation-rollback.mjs --db <sqlite>` falha com reservas/pendências não drenadas; rollback para pré-hardening exige dreno (só bindings `succeeded`) + aprovação humana, sem apagar vínculos.

## Unreleased (2026-10-07 - closure transacional do forget_memory (issue #102): atomicidade, idempotência e escopo de recibos; sem release)

- Agent (P1): **execução confirmada do forget numa ÚNICA transação** - `confirmForgetMemory()` fazia claim, delete, cascade e terminal como statements separados: falha no meio deixava alvo apagado com UX de falha, cascade parcial ou claim travado. Novo `executeConfirmedForgetTransaction()`: revalidação final + claim + invalidação + cascade + `confirmed→executed` + recibo na mesma transação SQLite (COMMIT total ou ROLLBACK total; primitiva real `ctx.storage.transactionSync` ligada em `memorySql()`, fallback `BEGIN IMMEDIATE` para testes). Cancel (`cancel+receipt`) e propose (`supersede+insert`) também atômicos; `forgetMemory()` virou wrapper sobre `forgetMemoryInTransaction()`.
- Agent (P2+P1): **recibos com identidade, renewal e vínculo** - PK composta `(workspace, actor, intentionId)` com migração preservadora (rewrite em transação + contagem verificada); recibo expirado é renovado pela nova decisão; vínculo durável intenção→proposta (`proposal_id`): redelivery nunca re-resolve contra pending posterior (achado P1 dos reviewers desta closure — a confirmação autoriza UM preview específico); só `executed` alega "já foi esquecido".
- Testes: RED (9 falhas na lógica antiga) → GREEN 33/33 SQLite real com fault injection por estágio, cadeia root→child→grandchild, concorrência, replay, actor/workspace isolation, migração (incl. defesa ADD COLUMN e adapter DO) e binding R1–R15 (vínculo pré-tentativa em tabela própria, expiração vinculante, consumo permanente, sentinela '' vs NULL); suíte Agent 1869 passed/1 skipped; typecheck 0; lint via CI. Reviews locais: rodadas 1–4 CHANGES_REQUIRED (8 P1 no total, todos corrigidos com regressões); Codex: 1 P1 (consumo permanente de recibo NULL) + 1 P1 (boot sem transactionSync), ambos corrigidos; rodada final pendente; security local APPROVED.
- Docs: relatório `docs/reports/2026-10-07-forget-transactional-closure.md`, SPEC §11.7, PLAN, `apps/agent/AGENTS.md`. A19 segue NOT READY até CI verde + deploy saudável.

## Unreleased (2026-10-06 - closure two-step do forget_memory (issue #99): nenhuma heurística autoriza delete; sem release)

- Agent (P1): **`forget_memory` em duas etapas** - nenhuma resolução automática exclui: mesmo 1 candidato com 100% de match produz SÓ pending. Pedido → proposta pendente (TTL 10 min, convenção `undo_proposals`, tabela `agent_memory_forget_proposals`) → confirmação explícita em turno posterior ("sim") → revalidação (status/TTL/vínculo + memória viva + hash sha256) → `forgetMemory()` → pós-validação → resposta. Tool exposto ao modelo virou propose-only (sem tools de confirm/cancel); a decisão é determinística no orquestrador (`runForgetDecisionTurn`, SDK+REST) a partir do texto digitado, com veto por presença de anexo, precedência do financeiro com alvo decidível e de rascunho recuperável. Redelivery do mesmo turno é idempotente (intentionId + CAS); cancel/supersede terminais; cross-actor invisível; cross-workspace inalcançável; auditoria `forget.proposed/confirmed/executed/cancelled/expired/revalidation_failed` só com ids/hash; turnos do fluxo não ensinam (§30/A17). Discovery (discriminantes) localiza, nunca autoriza; completude gramatical (artigos `uma/umas/uns` + verbos de relato) melhora precisão sem valor de segurança. Caso exato do review (`por gentileza, esqueça uma coisa que eu falei` × `Prefere uma caminhada pela manhã`) pede especificação e nada apaga.
- Testes: RED na lógica antiga (3 falhas) + GREEN nas suítes de forget (two-step, confirmação B–N, runtime/orquestrador §29 com attachment `confirmo.pdf`, cross-actor, TTL, vaga, fragmentada, SQLite real com CAS winner/loser, round 2/2b com negações/replay/dedupe/recibos/rollback/falha-pós-claim) + suíte Agent completa sem regressão; typecheck e lint verdes; `scripts/agent-release-smoke.mjs` intocado. Docs: `apps/agent/AGENTS.md`, relatório A19 §13, SPEC §11.6. Veredito: READY WITH CONTROLLED ROLLOUT se P0=0 e P1=0 no review final (round 2/2b: 8 achados corrigidos — matcher fechado+veto, release de claim, rollback de publicação nos 3 pontos, dedupe por intenção, recibos de decisão incl. already_done, CAS com autoria).

## Unreleased (2026-10-06 - closure definitiva da A19 (issue #96): forget com autorização discriminante, attestation de deploy com retry bounded; sem release)

- Agent (P1): **`forget_memory` só esquece por correspondência DISCRIMINANTE** - a cobertura ≥ 0.5 da closure anterior ainda apagava a memória ERRADA: em "esqueça minha preferência do banco Nubank", genéricos `minha`+`banco` atingiam o threshold em "Minha conta favorita é Banco do Brasil" (2/4 = 0.5) enquanto o alvo correto ficava abaixo (1/4). Nova política determinística sem LLM: tokens da query separados em COMANDO (`FORGET_QUERY_STOP_TOKENS`) + ESTRUTURAL/GENÉRICO (`FORGET_GENERIC_STRUCTURE_TOKENS` - possessivos e substantivos de estrutura/domínio: banco, conta, cartão, categoria, preferência, principal, favorita...) + FUNÇÃO (`FORGET_FUNCTION_TOKENS` - stopwords pt-BR padrão estendida: contrações, pronomes, conectivos, locuções congeladas "acerca de/por causa de/a propósito", modais/volição, família lembrar) + DISCRIMINANTE (o resto). Candidato esquecível sse contém ≥ 1 discriminante; query sem discriminante não apaga nada e pede especificação; ambiguidade e visibilidade completa intocadas. Prova RED: a lógica antiga selecionava exatamente a memória errada (scratch fiel a `main@0cb7a72`); 15+ traps de review adversarial (3 rodadas) pinados como regressão no seletor e no fluxo real da tool. Residual honesto: funcional raríssimo fora da lista, contido numa única memória, escrito pelo usuário, é o limite teórico do determinismo sem LLM (documentado; nunca 2+ matches, nunca memória sem o token, nunca leak).
- Infra (P1 operacional): **attestation de release do Agent com retry bounded** - a propagação de versão do Cloudflare Workers é eventual: o run 37453906796 falhou com UM curl ~13 s após o publish (deploy 11:04:31Z, smoke 11:04:44Z) e a produção convergiu depois para o SHA correto. Novo `scripts/agent-release-smoke.mjs` (21 testes de contrato): 404 e 3xx (redirect nunca seguido - a attestation prova a origem CANÔNICA) = FAIL imediato; rede/non-JSON/5xx/status≠ready = retry; `ready` sem `buildSha` = FAIL imediato (violação de contrato); `buildSha == expected` = PASS; diferente = retry (8 × 5 s, deadline de request por tentativa via AbortSignal cobrindo connect+headers+body) e FAIL com o último SHA observado ao esgotar. Log por tentativa com o SHA observado. Workflow `agent-deploy.yml`: só o step de attestation mudou; falha verdadeira continua falhando.
- Docs: relatório anterior ("nada deployado") corrigido de forma auditável - houve deploy real em 2026-10-06 (PWA verde; Agent publicou `0cb7a72` e convergiu); pós-escrito §13 no relatório pós-merge; SPEC §11.5 e PLAN atualizados com a política discriminante e o retry bounded; novo relatório `docs/reports/2026-10-06-ted-agent-a19-definitive-closure.md`.
- Testes: +47 no agent (regressões discriminantes A-F, cortesia/locuções/modais/interjeições, fluxo real com sobreviventes por conteúdo e `invalidatedAt === null`) e +21 testes de contrato do smoke. Agent 1783 passed/1 skipped; typecheck/tsc/gates verdes; `wrangler deploy --dry-run` ok; smoke real read-only contra produção PASS. Flags default-off intocados.

## Unreleased (2026-10-05 - closure pós-merge do PR #90 (issue #91): forget com resolução segura de alvo, learning após persistência definitiva, proxy PWA bounded; sem release)

- Agent (P1): **`forget_memory` só esquece alvo provado** - o ranking do recall (`salience × recência + overlap`) gerava candidatos mas decidia a exclusão: memória única irrelevante podia ser apagada por ser top-1 e memórias não relacionadas causavam falsa ambiguidade. Novo filtro determinístico sem LLM (`selectRelevantForgetCandidates`: query normalizada menos stopwords do imperativo precisa cobrir >= 0.5 dos tokens do assunto, >= 1 token) sobre `listForgetCandidates`, que espelha o filtro de visibilidade do recall SEM o truncamento top-5/budget - o corte antes do filtro escondia uma segunda memória plausível e convertia ambiguidade real em unicidade deletada (caso provado em RED com o contraexato de saliences). 0 relevantes = "não encontrei" (conservador); 1 = esquece (invalidate + cascade + tombstone intocados); 2+ = ambiguidade com contagem honesta. A resolução também não faz mais bookkeeping de `last_seen_at`.
- Agent (P2/P1): **learning exige evidência definitiva do canal** - no REST, `recordPostTurnLearning` rodava ANTES de `persistMessages`: persistência que falhava devolvia 502 mas memória e contador já estavam gravados (turno que falhou para o usuário ensinava estado durável, violando A17). Agora o hook roda só depois da persistência confirmada; e turno com INTENÇÃO mutacional (`needsMutation`: plano de mutação, rascunho recuperável, confirmação/cancel, retry) só ensina com `turnResult.mutation` materializado - fechado o bypass de retry ("tenta de novo" roteia como plano `unsupported` e recusas/ambiguidades/erros do coordinator aprendiam sem evidência nenhuma). Retry de sucesso aprende (produz mutation); cancel nunca materializa mutation e nunca ensina (conservador por desenho); SDK mantém regra com a evidência do próprio canal (residual documentado). Budgets intocados (heurística todo turno, LLM 1/5, timeout 10 s, DLP scrubbed).
- PWA (P1): **proxy same-origin sem buffering ilimitado** - a rota `api/agent/[...path]` fazia `await request.arrayBuffer()` e só depois conferia o teto: `Content-Length` ausente, mentiroso ou menor que o real bufferizava o corpo completo antes de rejeitar. Novo `readBoundedBody` (mesmo conceito do Worker): leitura incremental com teto por rota (chat/RPC 2 MB; attachment = teto máximo A13, inalterados) e `reader.cancel()` + 413 no instante em que o teto é cruzado - provado por teste com stream observável (cancel disparado no meio do stream, não só status final). Tetos e validação por kind no Agent/DO intocados.
- Testes: +32 (agent: regressões de truncamento/relevância/evidência/persistência-rejeitada/retry real-path + unit tests da resolução; pwa: bounded body com stream observável). Fix latente de teste: mock SQL não consumia binding no ramo `expires_at IS NULL` (expiradas vazavam nos fixtures - agora fiel ao SQLite).
- Validação: Agent 1765 passed/1 skipped - PWA 2430 passed (test:stable) + build ok - typecheck/lint raiz/agent/pwa 0 - `wrangler deploy --dry-run` ok - review adversarial independente em 3 rodadas (rounds 1-2: CHANGES REQUIRED com 3 P1 corrigidos - truncamento, evidência durável, bypass de retry; round 3: APPROVED). Relatório: [2026-10-05-ted-agent-inteligente-a19-post-merge-closure.md](docs/reports/2026-10-05-ted-agent-inteligente-a19-post-merge-closure.md).

## Unreleased (2026-10-05 - closure A19 final do Agente Inteligente V1 (issue #89): caminho real de anexos, tetos por rota, texto/metadata separados, imunidade estrutural, cleanup retomável, A17/A18 no runtime; sem release)

- Agent+PWA (P0): `/rpc/attachments` atravessa o gateway real — `isRestRpc` inclui a rota e o upload recebe identidade SOMENTE da autenticação do Worker (workspace canônico, actor, role, device; headers do cliente são sobrescritos, nunca confiados). Suíte E2E pelo caminho real (Worker → DO real → storage → orchestrator) cobre upload válido, não-autorizado, alias→canônico, rota inexistente, spoof de identidade/device, binding ausente (503 fail-closed) e MIME inválido.
- Agent+PWA (P0): teto de corpo **por rota** — chat/RPC JSON mantém 2 MB; `/rpc/attachments` recebe teto próprio derivado estruturalmente de `ATTACHMENT_LIMITS` (máx. 15 MB), no Worker E no proxy same-origin da PWA (que também tinha 2 MB). Abort mid-read preservado; `Content-Length` mentiroso continua sendo cortado no streaming.
- PWA (P0/F1): `body.text` é SOMENTE o texto digitado — a composição `textWithAttachments` (`[pdf: nome]`) foi removida por construção; anexo viaja só como metadado `{type, ref, name}`; bubble otimista continua renderizando chips; retry reenvia exatamente o digitado. Anexo chamado `sim confirmo.pdf` não decide nada.
- Agent (P1/F1): **veto estrutural de autoexecute** — `isAutoExecutionEligible` recebe os anexos do turno e recusa QUALQUER presença (independente de tipo/estado/provider/texto/confiança), nos dois pontos de entrada (draft e no-draft); o cliente elevado nem é construído com anexo presente (o gate antigo olhava dado EXTRAÍDO e deixava o fast path alcançável quando a extração era vazia — capability off, provider down, `skipped_budget`). Invariante fixado na assinatura e em todo call site.
- Agent (P1): cleanup TTL de anexos **starvation-proof** — o cursor da última página consumida é persistido no DO (antes era variável local e cada sweep recomeçava no prefixo: expirados além da página 10 nunca eram alcançados). Wrap-around limpa o checkpoint; delete falho segura a posição (retry idempotente); cursor inválido faz fallback ao prefixo sem quebrar o upload; sem checkpoint o comportamento é byte a byte o antigo.
- Agent (P1/A17): learning pós-turno CONECTADO ao runtime — o hook rodava com `assistantText: ''` atrás do early return que a produção sempre toma (nunca aprendeu nada; contador de turnos parado). Agora roda só depois de resposta publicada, com o texto REAL, nos dois caminhos (REST e SDK); fail-closed/erro/vazio não ensinam; extractor LLM resolve o snapshot lazy (budget de 1 a cada 5 turnos preservado). Novo tombstone de CONTEÚDO (`isContentForgotten`): esquecido pelo usuário não é re-ensinado pelo job (o dedup de `rememberFact` ignora linhas invalidadas e reinseriria); o tool explícito `remember_fact` continua podendo recriar por declaração deliberada.
- Agent (P1): `forget_memory` exposto ao runtime ("esqueça isso") — resolução de candidatos PELO RECALL do chamador (workspace + actor + shared visível): memória privada de outro ator é indistinguível de inexistente (sem oráculo), outro workspace é inalcançável; ambiguidade recusa sem vazar id; resposta reporta cascade honestamente.
- Agent (P1/A18): user skills ATIVAS participam do `assembleCognition` nos dois call sites do runtime — projeção canônica (`toSelectableSkills`, dado delimitado, `tools: []`); workspace sem skills = um SELECT e prompt byte a byte idêntico (zero leitura de catálogo); catálogo de categorias cacheado por DO (a regra manda reconfirmar com `list_categories`); candidate/revogada/inativa nunca carregam; rollback restaura a versão anterior. Fix pego pelo teste de runtime: field initializers de classe não rodam em agentes prototype-built — flag e cache agora são lazy.
- Agent (E2E): suíte `tests/integration/a19-real-path.test.ts` atravessa Worker real → DO real → relay mockado: texto canônico, fragmentado sem escrita, mutação sem device = recusa honesta (H-12), anexo ponta a ponta, `sim confirmo.pdf` não confirma, provider fora = degradação honesta, redelivery não duplica, ref cross-workspace = estado explícito nunca hit.
- Validação: Agent 1735 passed/1 skipped · PWA 2416 passed · typecheck raiz/agent/pwa 0 · `wrangler deploy --dry-run` ok · docs/governance verdes · review independente adversarial (ver relatório). Provider de decisão permanece default-off (nenhum rollout); `TED_RISK_BASED_AUTOEXECUTE`, Release B e cutover intocados. Relatório: [2026-10-05-ted-agent-inteligente-a19-final-closure.md](docs/reports/2026-10-05-ted-agent-inteligente-a19-final-closure.md).

## Unreleased (2026-10-05 - plano TED V1: gates G04/G05/G06 resolvidos com condições + fatias A13–A18 default-off; sem release)

- Docs/spec: resolução formal dos gates **G04** (Jev permanece default-off em produção; wiring no hot path liberado com determinístico autoritativo; habilitação futura exige validação de provider + G07), **G05** (STT Groq `whisper-large-v3-turbo` com ZDR obrigatório antes de produção; storage R2 privado via binding opcional; imagem/PDF via adapters default-off) e **G06** (regra durável só com consentimento explícito; inferência permanece candidata; esquecimento é cascata) — SPEC §11.2. A13–A18 desbloqueadas com flags default-off; habilitação em produção continua rollout por fatia (A19). [Resolução](docs/reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md).
- Agent (A16/R15): wiring do `JudgmentProvider` no hot path — desempate advisory de `continuationRelation` (payload só com fatos estruturais, zero estado financeiro), determinístico autoritativo em todos os caminhos, 1 chamada/turno + breaker preservados, correção de valor nunca espera o judge, default-off byte a byte idêntico e sem novo await. AC25 provado com stubs.
- Agent (issue #86): camada de decisão **neutra de provider** — Jev deixa de estar acoplado ao domínio e vira um adapter. Contrato sem campo de autorização/escrita (ausência estrutural, guardada por teste), seletor `TED_DECISION_PROVIDER=jev|clef|strands` (default-off total: sem env, zero rede e turno byte a byte idêntico; nome desconhecido ⇒ `provider_not_supported`), adapters **jev** (reutiliza a fronteira A16 e as envs `TED_JUDGMENT_*`, mapeando `continuation_relation`→`jev_decide` dentro do adapter), **clef** (`env.AI.run`, binding ausente ⇒ `binding_missing`; binding `AI` **não** adicionado a `wrangler.jsonc` — passo de rollout) e **strands** (`POST /v1/systemone`, `redirect: 'manual'`, sem credencial no código). Tetos GERAIS preservados (2 s por tentativa incluindo corpo, 1 consulta/turno, breaker por provider+config, instância única por DO) e política de confiança nova: `TED_DECISION_MIN_CONFIDENCE` (default 0.7) **descarta** o answer abaixo do threshold (`abstained/low_confidence`) — sem escalonamento para modelo generativo, o turno volta ao caminho determinístico. `judgment/wiring.ts` → `decision/wiring.ts` consumindo `DecisionProvider`; evento `judgment.consulted` → `decision.consulted` com a operação do domínio; `resolveWithDecision` mantém o determinístico autoritativo em todos os caminhos. Eval replayável (16 casos pt-BR: typo, fragmento, incompleto, descrição ambígua, required-clarification): replay vs oráculo é 100% **por construção** (documentado como não-métrica de qualidade); métricas de provider real (accuracy/calibração/latência/custo) **pendentes** de configuração — nada inventado. Review adversarial (3 majors corrigidos): misconfiguração de provider selecionado agora emite `decision.consulted` com o motivo (`binding_missing`/`provider_not_supported` — default-off continua silencioso); answer inválido conta contra a saúde do breaker de forma consistente com a fronteira A16; confidence presente porém fora de `[0,1]` ⇒ `malformed_response` (resíduo documentado: no dialeto jev a fronteira normaliza para ausente ⇒ `low_confidence`, fail-closed igual); tetos numéricos pinados por teste; provider que lança não derruba o turno (`provider_error` + determinístico).
- Agent (A17/R16): memória com proveniência — fingerprint determinístico anti-redelivery (correção nova com mesmo alvo/campo **substitui** o learning, 1 linha); derivados nunca auto-promovidos a `preference`/`fact`; esquecimento com cascata BFS + tombstone que impede ressurreição pelo job de aprendizado; referências de conta/categoria marcadas como históricas no recall; escopo explícito opcional sem mudar o default de recall; coluna nova `catalog_references` (nome não-reservado; `references` é keyword SQLite).
- Agent (A18/R17): user skills declarativas (única regra aceita: alias merchant→categoria **existente**; 13 campos proibidos rejeitados no schema; DLP antes de persistir; colisão com core recusada), candidates com promoção exigindo replay offline read-only + safety + aprovação humana (safety fail bloqueia mesmo com média melhor), rotina periódica nunca promove, rollback restaura versão anterior, seleção dentro do budget 6000 com core intocado. Runtime ainda inerte (init/wiring = rollout A19).
- Agent+PWA (A13/R11 🔴): ingestão binária com identidade — referência opaca HMAC (domínio dedicado + compare timing-safe), storage R2 privado por binding opcional (sem binding ⇒ 503 fail-closed), MIME real por magic bytes (sniffing manual, zero dependência), tetos por tipo (imagem 25 MP/10 MB, pdf 15 MB, áudio 10 MB + duração WAV ≤ 120 s), sha256, upload idempotente por (workspace, actor, sha256), cleanup TTL com `include:['customMetadata']` + cursor, leitura mediada com revalidação de posse/TTL, bytes nunca em log/telemetria/DLP. PWA: capability **por tipo** (mestre legado preservado), `uploadAttachment` real, estados por anexo com envio bloqueado durante upload, blob do microfone no mesmo pipeline.
- Agent (A14/R12): STT Groq com trava dupla (`GROQ_API_KEY` + `TED_AUDIO_STT_ENABLED`), multipart sem prompt/nome (minimização), estados tipados (`stt_*`), 1 transcrição/turno, transcrição entra como dado marcado com cliente elevado nem construído — **anexo nunca autoexecuta**.
- Agent (A15/R13): visão Groq (trava dupla + `TED_VISION_ENABLED`, system prompt fixo, `unknown`/`ambiguous` com proveniência por campo) e PDF text-layer `unpdf@1.8.1` (spike aprovado: zero deps transitivas, 0,48 MB gzip; early-exit nos tetos; `pdf_encrypted`/`pdf_no_text_layer` fail-closed; **gate `TED_PDF_TEXT_ENABLED` default-off**). Conteúdo extraído é dado delimitado; múltiplos itens nunca viram bulk write.
- Segurança (review adversarial 🔴): **conteúdo de anexo não pode mais acionar confirmação/cancelamento/retry/undo** — `routeIntent(text, decisionText)` com decisão exclusivamente do texto digitado (server-side, cliente não forja) + guarda de contrato de estrutura que falha se surgir canal sem a propagação; memo de processors identity-bound com revalidação de posse/TTL no hit; single-flight real; Múltiplos anexos compostos ou marcados `skipped_budget` antes de processar; kind derivado do record do servidor. 33 sondas independentes pós-fix, 6/6 PASS.
- Evidência: [gates](docs/reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md) · [P4](docs/reports/2026-10-04-ted-inteligente-v1-p3-a07-a09int-a16.md) · [A13](docs/reports/2026-10-05-a13-ingestao-binaria-identidade-r11.md) · [P5](docs/reports/2026-10-05-ted-inteligente-p5-a13-a15.md).

## Unreleased (2026-10-04 - closure de pendências: A08, follow-ups Agent V1, config/docs; sem release)

- API: listagem de contas aceita `includeInactive` opt-in (enum fechado `'true'|'false'`, default fail-closed; relaxa SOMENTE o filtro de status — soft-delete, cards e escopo de household inalterados; `GET /accounts/:id` segue active-only). OpenAPI + contratos gerados alinhados.
- Agent: envelope de prova de analytics (G03) ligado ao caminho de evidência (`analytics_kpis`/`analytics_category_breakdown` como leituras próprias, fail-closed, teto `MAX_EVIDENCE_READS=2` travado por teste); `JudgmentProvider` com instância única por Durable Object (WeakMap, state do breaker preserva entre turnos); web-search mapeia `published_date` e passa a citar fontes com marcadores `[F1]`.
- Agent (fail-closed de evidência): payloads fora do contrato (sem `items` array / null / primitivo) viram `permanent_error` em vez de "lista vazia"; `workspace_empty` agora é produzido somente com ≥2 leituras reais vazias e nenhuma falha/escopo-estreito; listas singleton (statements/payables/budgets/goals/categories) emitem reason `setup_incomplete` na shape real `{items, total}`; catch externo do coletor preserva reasons tipadas (`permanent_error`) com `unavailable` só como piso. 23 fixtures que passavam com payload fora do contrato foram corrigidas para shapes reais.
- Config: janela Release B realinhada pós-migração (docs canônicas + `release-b-reminder.yml` com `WINDOW_START=2026-10-02T21:36:06Z`, gate `2026-10-16T21:36:06Z`, filtro EXCLUSIVO no evento âncora — `>=` contaria o evento que reiniciou a janela para sempre).
- Config: Prettier removido (devDep, scripts mortos e `check-reminder-format.mjs` phantom dep); floor `pnpm >=10` alinhado (raiz, README, AGENTS.md, codex-broker); governança morta `check-pwa-audit` removida (script TS-em-.mjs inexecutável + teste órfão + fixtures); falso positivo do `boundary:check` corrigido (comentário com "fetch (" no texto).
- Docs: Hostinger→Contabo nos fatos canônicos (README, ARCHITECTURE-CURRENT, AGENTS.md, `runtime-facts.json` regenerado — V059, Contabo, 127 rotas) com contrato de fatos usando asserções negativas; CHANGELOG da Fase 22 corrigido (executada, não pendente); plano V13 com 6 rotas de analytics; auditoria de config com addendum de encerramento.
- Evidência: `docs/reports/2026-10-04-pendencias-closure.md`.

## Unreleased (2026-10-03 - fix TED: self-heal do device token + recalibração da cota; sem release)

- PWA: self-heal do device token no mint do connection token quando o store está
  vazio (boot cookie-session nunca registra device → mint deviceless → 401 na
  lista de aprovações). Single-flight com guard de geração; 1 retry de mint em 401
  com device apresentado; announce de expiração de sessão somente em 401 definitivo
  (5xx/timeout/rede nunca deslogam); `skipUnauthorizedEvent` no apiFetch para a
  recuperação não derrubar a sessão viva.
- Agent: `DEFAULT_POLICY` recalibrada para a unidade real de reserva
  (`actorDailyBudget` 10000→200000, `dailyBudget` 20000→400000; ~7.7k por perna de
  relay; sucessos reconciliam para baixo; retenção em falha inalterada). Denials
  tipados com passthrough: `agent.usage_rate_limited` (janela 60s) e
  `agent.usage_input_cap` (mensagem acima do teto); `agent.rate_limited` permanece
  exclusivo do provider 429 (failover-eligible).
- PWA: copy honesta para falha de envio (cota diária / rate limit / mensagem longa);
  mensagens genéricas preservadas para os demais erros.
- Segurança: allowlist build-time (expira 2026-12-31) para a cadeia
  `eslint-config-next` bloqueada pelo scoped audit após extensão do advisory
  GHSA-vfj7-8cjw-p6xm em 2026-10-02 (drift de advisory, não regressão de PR).
- Evidência: `docs/reports/2026-10-03-ted-agent-device-quota-fix.md`.

## Unreleased (2026-10-02 - PR D: UX TED para autorização por risco; sem release)

- PWA caracteriza turnos `succeeded` com receipt: reconcilia a mutação,
  apresenta sucesso sem card de aprovação e mostra Undo somente quando o Agent
  fornece proposta estruturada elegível. Reload mantém sucesso fora da lista
  de cards ativos; receipt continua obrigatório.
- E2E fixture-only cobre autoexecução imediata, proposta de alto valor e
  clarificação sem card executável. Workspace/device/uncertain permanecem
  cobertos por testes da API nos PRs A/B, não por este harness.
- Arquitetura/roadmap alinhados: confirmação humana condicional, policy
  determinística, allowlist de despesas/receitas, R$500, destrutivas manuais,
  PendingOperation V2/receipt preservados e flag `off|shadow|on` default off.
- `docs/ops/ted-autoexecute-observability.md` mapeia métricas V5 aos três
  eventos sanitizados e ao audit trail; sink persistente permanece gate de
  operações. Fase 22 (deploy shadow) executada em 2026-10-02 (`37b9f47`, API
  via wrapper com V059 aplicada e rollback tag preservado; PWA/Agent via
  Cloudflare); canary (`on`) continua dependente de telemetria suficiente
  (undo-after-autoexecute).

## Unreleased (2026-10-02 — PR C: Agent solicita autoautorização com guard determinístico; sem release)

- **Guard de intenção explícita** (`hasExplicitMutationIntent` em
  `apps/agent/src/safety/tool-approvals.ts`): detecção conservadora de
  imperativos ("registre/adicione/lance/anote/inclua…" e inflexões testadas);
  perguntas, condicionais ("e se…"), negações, relatos ("gastei") e texto
  citado NUNCA elegem autoexecução.
- **Minting elevado lazy**: o token base do turno permanece com as 6
  capabilities (+ `financial.read`, exigida pelo detector de duplicidade —
  contrato REST atualizado); um client elevado com
  `financial.approval.autoexecute` só é mintado sob demanda, dentro do turno,
  quando a elegibilidade determinística passa: tool allowlisted + args
  completos + sem ambiguidade + intenção explícita + detector de duplicidade
  estrito **fail-closed** (erro/503 ⇒ suspeita ⇒ sem autoexecução).
- **Fast path no orquestrador**: propose → authorize → execute com os
  mesmos primitivos de attestation/receipt (sem segunda máquina de execução);
  `200` ⇒ turno `succeeded` com receipt, sem card; recusas definitivas
  (409 disabled/not_eligible, 403) ⇒ fallback silencioso para o card manual;
  erro de transporte/5xx no authorize ⇒ leitura autoritativa única: `proposed`
  ⇒ card seguro, qualquer outro estado ⇒ resposta inconclusiva (nunca card,
  nunca sucesso); incerteza pós-execute ⇒ caminho inconclusivo existente,
  no máximo 1 efeito, sem re-autorização.
- **MutationPolicy evolutiva** construída só por código determinístico
  (`authorizationMode`/`authorizationReason`/`risk`); provider-adapter
  rejeita os novos campos de autoridade vindos do modelo (`reason` genérico
  preservado).
- **Fix sistêmico pré-existente**: `POST /transactions/detect-duplicate`
  deixou de responder `200 {duplicate_detected:false}` em falha
  (pool indisponível/erro de busca) e passa a responder
  `503 duplicate_detection_unavailable` — falha nunca é negativa definitiva.
- **UX conversacional**: `TED_MUTATION_POLICY` e skill `registros`
  alinhadas ao sucesso imediato (ação+resultado+undo, sem jargão interno,
  sucesso só com receipt); `INSTRUCTIONS_VERSION` atualizada.
- Testes: 13 cenários de fast-path (sucesso/mint lazy/kill switch/recusa
  server-side/duplicata/lost-response/pós-falha/injeção de memória/sem
  jargão), guard, detector estrito, contrato REST. Suítes: Agent 812, API
  2448, broker 25, PWA 2280 — verdes.

## Unreleased (2026-10-02 — PR B: endpoint de autoautorização V2 com kill switch; sem release)

- **`POST /pending-operations/v2/:id/authorize`** (capability estreita
  `financial.approval.autoexecute`, só mintável server-side pelo Agent): a API
  reavalia a risk policy determinística sobre os args canônicos armazenados e
  só transita `proposed → confirmed` com attestation quando a decisão é
  `auto_execute`; caso contrário responde `409 approval.autoexecute_not_eligible`
  sem tocar o store. Kill switch `TED_RISK_BASED_AUTOEXECUTE`
  (`off|shadow|on`, default `off` — parsing fail-closed): `shadow` registra
  `mutation.authorization.evaluated` (dimensões sanitizadas tool/risk/decision/
  reason) e recusa; `off` recusa antes de qualquer avaliação persistente.
  Confirm manual persiste `authorization_mode='manual'` com reason/risk
  derivados da policy (ex.: `high_value`/`high` em R$500); authorize persiste
  `auto`/`explicit_low_risk`/`low`. Confirm rejeita corpo (cliente não força
  `mode`); binding mismatch vira `403 approval.forbidden` opaco. Stores PG e
  in-memory com transição atômica; auditoria ganha evento `authorize`; replay
  de attestation continua fail-closed. Testes: 11 cenários de rota +
  persistência PG real + replay + shadow/kill-switch.

## Unreleased (2026-10-02 — SPEC/PLAN V5 de autorização por risco documentadas e revisadas; sem release)

- **SPEC V5 — Autonomia por Risco e Inteligência Conversacional** documentada
  (`docs/MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md`) com plano faseado
  (`docs/MEU-TED-PLANO-V5-AUTONOMIA-POR-RISCO.md`) e revisão independente de
  baseline (`docs/reports/2026-10-02-ted-risk-authorization-spec-review.md`).
  Confirmação humana passa de universal a **condicional**: policy
  determinística na API, allowlist restrita a
  `transactions.{expense,income}.create`, R$500 segue exigindo confirmação,
  destrutivos sempre manuais, shadow mode antes de ON. PR A (preparatório,
  sem mudança de comportamento nos fluxos de autorização existentes):
  `evaluateMutation` determinístico em `apps/api/src/approvals/policy.ts`
  (matriz low/medium/high/destructive + `AUTOEXECUTION_ELIGIBLE_TOOLS`),
  metadados aditivos `authorizationPolicy`/`autoExecutionEligible` no
  tool registry, migration aditiva `V059__pending_operation_authorization.sql`
  (colunas nullable de auditoria de autorização) e `ADR-026`. Endpoint de
  autoautorização, capability, flag e rollout são PRs seguintes.

## Unreleased (2026-10-02 — sem auto-zoom no foco de form controls, sem release)

- **Fim do auto-zoom do iOS ao focar caixas de texto**: regra global em
  `globals.css` (`@media (pointer: coarse)`) força `font-size: 16px` em
  `input`/`textarea`/`select` — o iOS só aplica pinch-zoom no foco quando
  o controle computa < 16px, e vários componentes seguiam abaixo do limiar
  (textarea do chat, convite, gerenciador de workspaces, payables,
  registros, filtros). Zoom do usuário continua livre (WCAG 1.4.4, sem
  `maximum-scale`); desktop (`pointer: fine`) não é afetado. Teste de pin
  em `src/app/__tests__/globals-input-zoom.test.ts`; comentário do
  `Viewport` em `layout.tsx` atualizado para apontar o contrato global.

## Unreleased (2026-10-01 — página dedicada do agente TED `/ted`, sem release)

- **Chat do TED vira página `/ted` (sem semântica de modal)**: `TedChat`
  passa a renderizar `role="region"` page-bound (sem `open`/`onClose`, sem
  backdrop/scroll lock/focus trap/Escape/botão X); `TedChatLauncher` vira
  navegação (`router.push("/ted")`, deep-link `/ted?operationId=…`,
  oculto na própria `/ted`, A1 sob overlays mantido); nova página
  `app/ted/page.tsx` (server fino + `Suspense`) com `TedChatPage` lendo
  `?operationId=`; swipe direita em `/ted` faz `router.back()` (fora de
  `SWIPE_ROUTES`). Testes migrados para `region`/`router.push` + suite nova
  `TedChatPage`; E2E com `waitForURL(/\/ted/)` e seletor `region`. Emendas
  datadas na SPEC V3 (§21/§22/§24).

## Unreleased (2026-10-01 — fechamento de aceite dos 4 itens, produção alinhada; sem release)

### Gates abertos executados (sessão 2026-10-01b — `docs/reports/2026-10-01-open-gates-execution.md`)

- **Recon canônico drifted=0** com `--provenance=fresh` (mecanismo já existente; o default `historical` gerava 3 falsos drifts de contagem no banco novo). Comando canônico de produção documentado.
- **F2 rehearsal**: smoke sintético PASS (idempotente, dump pós sha256 `1603ce08…`); real-dump (legacy anonimizado, sha256 `29fce0f2…`) = **NO-GO documentado** — expense sem statement no legacy trava `balances` fail-closed (irrelevante: a API já serve o canônico, rota fresh concluída).
- **`release-b-reminder.yml`** atualizado para D11-R2 (gate 2026-10-15, query canônica `event_type` + filtro de início de janela — a query antiga era falso-zero).
- **Workflows future-gate** novos: 2026-12-01 (janela ADR-011/015 localStorage/bearer) e 2026-12-31 (allowlists pwa-audit + `.trivyignore`).
- **`refs/pi-rewind/store`**: inventário (2 commits; snapshot de 1.934 arquivos de 24/09) + bundle de preservação `backups-local/pi-rewind-store-20261001.bundle`.
- **Test Family cleanup**: 27 transações soft-delete + 17 contas desativadas via API cookie-only (0 erros; verificação 0 restante; janela Release B intacta).

### Release B (Rota A aprovada pelo operador): sink durável + nova janela de observação

- **Problema provado**: o evento `auth.request.legacy_bearer_used` só ia para
  logs pino do container (`legacyBearerAuditLog` nunca injetado em produção) e o
  container foi recriado nos deploys de hoje — a janela D11 (vence 2026-10-02)
  era inverificável; o SQL do `release-b-reminder.yml` contava tabela vazia por
  construção (falso-zero).
- **PR #51** (`fad863c`): sink durável `createLegacyBearerAuditSink` + wiring nos
  4 boot paths PG de produção.
- **PR #52** (`13ec135`): **descoberta em produção** — a API já roda
  `DB_SCHEMA=canonical`/`pi_financeiro_canonical` (rota fresh que supersedes
  F3–F5), onde `audit_logs` tem as colunas canônicas; sink corrigido para
  dual-shape (canônico espelhando `writes/pending-idempotency.ts`).
- **Deploys da API hoje**: `0b38535` → `29c015d` → `fad863c` → `13ec135`
  (wrapper versionado, backups frescos `pi-canonical-prerelease-*`, rollback
  tags preservadas, manifests na VPS; CI runs `36900550367`/`36914311011`/
  `36918626014` atestados verdes).
- **Smoke verificado**: 1 emissão controlada pousou em `audit_logs`
  (`event_type=auth.request.legacy_bearer_used`, 2026-10-01T20:13:42Z).
- **Nova janela de 14 dias declarada: 2026-10-01T20:14Z → 2026-10-15T20:14Z**
  (o evento do smoke é pré-janela e documentado). Gate Release B ≈ 15/10/2026,
  agora com evidência durável real. O `SESSION_BEARER_FALLBACK_ENABLED`
  (flag server-side da Release B, default ON) segue documentado apenas em
  código — flipar é env-only na VPS + rebuild do PWA para o flag client.

### Fixes de produção (3 causas raiz reais, encontradas pelo live closure E2E)

- API: veto de escopo no undo delegado — o preHandler global exigia
  `financial.write` genérico e reprovava o token com a grant estreita
  `financial.undo.execute` (403 → 502 `agent.approval_failed` em todo
  confirm de undo conversacional). Fix `undoScopeAdmitted` + re-check
  estreito na rota mantido. TDD RED→GREEN; suíte API 2399/2399. PR #49
  (`29c015d`), deployado na VPS via wrapper `api-release-20260930.sh`
  (CI `36900550367`, backup pré-release
  `pi-canonical-prerelease-20261001T174039Z`, rollback tag preservada).
- Agent: intent de undo não reconhecia o imperativo "desfaça" (regex só
  cobria `desfaz|desfazer`; ç ≠ z) — caía no fallback `unsupported` sem
  mintar proposal. Radical `desfaç` nas duas cópias do matcher; negação
  segue fail-closed. 778/778. PR #48 (`06c00c2`).
- PWA: card de aprovação com descrição dentro do `<dl>` (linha rotulada,
  revisável) + spec live-closure seleciona o card pelo id fresco da
  resposta do POST `/rpc/chat` (nunca card stale de outra run). 20/20.
  PR #47 (`375af2c`).

### Aceite verificado (evidência em `docs/reports/2026-10-01-acceptance-closure.md`)

- **Live closure E2E PASS em produção** (RUN_ID `closure0930-muptyzne`,
  29.4s total): criar → editar →
  confirmar → desfazer → cancelar → reload → excluir, guards de escopo
  fail-closed, cardinalidade exata (2 decisions + 1 undo + 1
  verify-target), reversão verificada no ledger.
- Produção alinhada: API `29c015d` (build `36900550367`), PWA/Agent
  `06c00c2` (build `36896164604`); smokes `/health`, `/ready`,
  `/api/build-info` verdes.
- Banco canônico: repair commitado em produção (`repair_committed=2`,
  `repair_compensated=0`) e **residual zero** (32 contas vivas) —
  sondagem SELECT-only; cutover F3–F5 permanece gate humano.
- Falso-verde do comprehensive no PWA CI provado corrigido (steps 8–9 do
  job `e2e` executando Playwright real, verde em 4 SHAs seguidos).

## Unreleased (2026-09-30 — acceptance verification PR #44, baseline `096c4e612fbcb7307a1431fa4f1920eb9434d22f`; sem aceite total)

### Release observada (baseline, não é release nova)

- Baseline `main@096c4e6` (PR #44): CI
  [36726347748](https://github.com/kust-projetos/meu-ted/actions/runs/36726347748)
  success + PWA CI
  [36726347704](https://github.com/kust-projetos/meu-ted/actions/runs/36726347704)
  success (com falso-verde confirmado no comprehensive, ver abaixo); deploys
  PWA [36727388392](https://github.com/kust-projetos/meu-ted/actions/runs/36727388392)
  + Agent [36727389081](https://github.com/kust-projetos/meu-ted/actions/runs/36727389081)
  success.
- Infra read-only UTC 2026-09-30T16:09:48Z: runtime API/PWA/Agent com SHA
  igual; API build `36726347748`, PWA build `36726347704`.

### Local / não deployado (fixes)

- API: fix do writer `createAccountInTx` (grava saldo + âncora no mesmo
  INSERT para futuras criações) + provas em PG descartável (8 + parity 6 +
  legacy 3 green) e 7 fake testes. Não deployado; produção segue sem reparo.
- Harness: ports `E2E_FIXTURE_PORT`/`E2E_NEXT_PORT`/`E2E_HARNESS_PORT`, reuse
  false, runner Playwright-owned; rodada final `apps/pwa` 89/89 PASS
  (7 files).
- Workflow: job e2e em `.github/workflows/pwa-ci.yml` com build de shared
  contracts antes do comprehensive; teste
  `src/__tests__/pwa-ci-workflow.test.ts` 2 passed; run-ci-failure sem
  dependência de git, propaga 42. CI remota nova pendente, sem disparo.

### Gates finais pós-fix (tester PASS)

- docs:lint 12/0 e governance PASS pós-docs; `pnpm test:pwa` rerun (250
  files) 2242 PASS; type 4ws, API 2361/52skip, Agent 763/1skip, broker 25
  anteriores valem (API sem mudança).
- Harness `apps/pwa` 89/89 PASS (7 files: 47 fixture + 29 failure guard +
  4 harness + 4 ports + 2 failclosed + 1 run-ci failure + 2 workflow); PG
  indep Planner 17/17 PASS (DDL manual V058 — sem provar migration/restore).
- AUTH 01 pass; subset históricos 23/23 PASS; mobile 148/26 e desktop 39
  herdados (app sem mudança de comportamento).

### Pendências (sem afirmar como verdes)

- CI comprehensive com falso-verde CONFIRMADO (`36726347704`, job
  `109924092896`: falha de build mascarada por trap, zero Playwright
  executado); fix local do workflow implementado, CI remota nova pendente
  sem disparo.
- Runtime SW/push failed sem causa identificada.
- Prova de restore do banco pendente (só existência de backups observada).
- Live bloqueado: sem credenciais admin; faltam edição, exclusão, undo e
  recovery com guards test family.
- Revisão independente de código e documentação APPROVED; o aceite de produção permanece parcial.

### Correções locais / não lançadas (2026-09-30 — closure funcional EM ANDAMENTO, sem release)

- Relatório de execução em `docs/reports/2026-09-30-production-functional-closure.md`
  (status `INPROGRESS`, sem aceite final; o relatório parcial
  `2026-09-30-acceptance-verification.md` permanece histórico).
- Backup canônico `pi-canonical-20260930T194523Z` (V058) + restore PG15/16 com
  checksum match em descartável; origem do residual +10000c identificada
  (criação `31`, match HH origem→ledger, target set
  `c30e17441d7899283182684a59099d7d`); repair em produção NÃO executado.
- SW causa provada (SW contorna `page.route`; `connect-src 'self'` bloqueava
  fixture → rewrite HTTP no harness; 6 PWA + 4 push passed). Gates API
  2398/56skip, Agent 778/1skip, broker 25, PWA 2273 + type/docs/governance
  strict, pins 81, smoke 8 verdes. CodeReviewer APPROVED, security do undo
  APPROVED, wrapper com 1 guard em ajuste final — sem claim final.
