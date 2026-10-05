# Changelog

Formato: seção `Unreleased` para trabalho não lançado; releases só com
versão/tag declarada pela governança. Nada abaixo inventa versão ou release.

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
