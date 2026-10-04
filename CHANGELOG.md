# Changelog

Formato: seção `Unreleased` para trabalho não lançado; releases só com
versão/tag declarada pela governança. Nada abaixo inventa versão ou release.

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
