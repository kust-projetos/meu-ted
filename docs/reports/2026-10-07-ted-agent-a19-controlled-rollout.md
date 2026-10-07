# Rollout controlado da A19 — inventário real + Fase A (2026-10-07)

**HEAD inicial:** `e1cf1bb2058219bbd93f5fca7423a7cd68830762` (= `origin/main` no início da sessão de inventário, working tree clean). Corretivo-1 `cfbb7cd`.
**HEAD final:** `<commit corretivo-2, a registrar>` (branch `docs/a19-rollout-inventory-fase-a`; PR #106 aberto, mergeable, head `cfbb7cd`, docs-only — este relatório + a entrada da sessão 2026-10-07b no `AGENTS.md` são os únicos arquivos alterados).
**Issues/PRs:** #102 fechada; #103 (`bbdc948`) e #104 (`e1cf1bb`) mergeados. PR #106 aberto (docs-only, corretivo deste relatório).
**Escopo:** inventário real + prontidão Fase A. Nenhuma flag alterada, nenhum secret provisionado ou lido, nenhum deploy executado, nenhum binding declarado.

## 1. Estado de produção verificado (evidência viva, read-only)

| Superfície | Evidência (2026-10-07) | SHA vivo |
|---|---|---|
| Agent `/health` | `status=ready, schemaVersion=5, buildId=37631044197, builtAt=2026-10-07T13:45:24Z` | `e1cf1bb…` = HEAD inicial ✅ |
| Agent `/health/agent` | `status=ready, binding=FINANCE_CHAT_AGENT` | — |
| PWA `/api/build-info` | `buildId=37631044197, builtAt=2026-10-07T10:45:20-03:00` | `e1cf1bb…` = HEAD inicial ✅ |
| API `/health` + `/ready` | `status=ok/ready, buildId=37238430467, builtAt=2026-10-04T22:07:46Z` | `bd1ed9b` (Contabo, independente — inalterada, como esperado) |

Deploy attestation preservado (sem alteração em `scripts/agent-release-smoke.mjs`).

**CI remoto autoritativo (fonte de verdade para este PR docs-only):** `CI completo = PASS`, `run = 37654520900`, `Gate — all checks = success`, `PWA CI 37654521051 success`, ambos no SHA final `cfbb7cd`. Jobs com `success` no run `37654520900`: `Codex Broker — typecheck + test + build`, `Security — secrets + dependencies + containers`, `API — lint + typecheck + test`, `PWA — lint + typecheck + test`, `PWA — Cloudflare build + headers + JS budget`, `Public safety — secrets + prohibited metadata (strict)`, `Docker — API + Codex Broker images`, `Agent — typecheck + test + deterministic eval + architecture`, `Postgres — integration tests`, `Documentation — lint + facts + plans`, `Governance — ADR decision gate`, `Capability inventory — 72 registered tools classified`, `Write policy`, `Gate — all checks`. Histórico: run `37649649680` cobria o parent `63bd555`.

**Gates locais (complementares):** `capabilities:check` PASS (54 tools / 74 rows), `docs:lint` PASS (12 docs, 0 issues), `governance:check` PASS (sem mudança D01–D19) — rodados no commit do hook; CI remoto do SHA final verde acima.

## 2. Por que produção está com opcionais desligados em config-de-deploy (prova limitada ao repo/workflow)

- `apps/agent/wrangler.jsonc` (L1-21): bindings = somente `FINANCE_CHAT_AGENT` (DO sqlite) + `vars.API_ORIGIN`. **Sem** `r2_buckets`, sem binding `AI`, sem `TED_*`.
- `agent-deploy.yml` injeta **somente** `BUILD_SHA/BUILD_ID/BUILD_TIME` + `PWA_ORIGIN`. Nenhuma `TED_*`/`GROQ_*`/`TAVILY_*` por deploy → env ausente **em config-de-deploy** = default-off no código **para essa config**.
- `pwa-deploy.yml` injeta somente `PWA_ORIGIN` + `PWA_AGENT_PROXY_ORIGIN`. Nenhuma `NEXT_PUBLIC_TED_ATTACHMENT_*` no build → UI não anuncia anexos (fail-closed em config-de-deploy).
  Exceção: `apps/pwa/wrangler.jsonc:29` fixa `NEXT_PUBLIC_TED_MICROPHONE=true` (captura de voz V4 no browser — caminho distinto do STT Groq, que segue OFF em config-de-deploy).
- Ambiente local desta sessão: sem `CLOUDFLARE_API_TOKEN`, sem `CLOUDFLARE_ACCOUNT_ID`, sem `GROQ_API_KEY` (somente presença verificada, nenhum valor lido/criado).

**Aviso explícito — `repo config != live runtime config`:** secrets provisionados via dashboard ou via `wrangler secret put` são **invisíveis ao grep** no repo e nos workflows. O código do Agent lê env do Worker em call-time; portanto, ausência no repo/workflow **NÃO prova** ausência no runtime. A afirmação anterior "env ausente = default-off no código" fica enfraquecida para: "ausente em config-de-deploy = OFF nessa config; runtime live segue UNKNOWN até inventário live".

**Tentativa de inventário live nesta sessão (somente nomes/status, nenhum valor lido):** `npx wrangler r2 bucket list` falhou com erro de autenticação (código 10000); `wrangler secret list --name pi-finance-agent` falhou com erro de autenticação (código 10000 + token de acesso inválido, código 9109). Nenhum token/valor foi exposto ou registrado. Conclusão: **inventário live NÃO obtido; manter UNKNOWN como gate pendente** (ver Apêndice A).

## 3. Inventário real do rollout

Legenda: `CODE_AVAILABLE` = código presente e desligado por config-de-deploy; `UNKNOWN` = runtime live não inventariado; `DISABLED` = OFF em config-de-deploy; `BLOCKED` = gate de privacy/provider/infra impede até canary. A taxonomia `UNCONFIGURED/CONFIGURED_DISABLED/CANARY/ACTIVE/BLOCKED` é vocabulário deste relatório — **ainda NÃO existe no código** (proposta de observabilidade, ver §4.1).

| Capacidade | Estado atual | Binding existe? | Secret existe? | Flag atual | Dependência externa | Gate necessário | Risco | Pronta p/ canary? |
|---|---|---|---|---|---|---|---|---|
| Text Agent (core) | ACTIVE em `e1cf1bb` (saudável) | n/a (DO ativo) | n/a | n/a | API Contabo `bd1ed9b` | nenhum | baixo | SIM (já em prod) |
| Memory Parte B + A17 learning | CODE + ACTIVE (opt-out por workspace, ON default) | n/a (SQLite DO) | n/a | opt-out `POST /rpc/memory/prefs` | nenhuma | nenhum | baixo | SIM |
| Skills usuário A18 | CODE + ACTIVE (dado delimitado `tools:[]`) | n/a | n/a | nenhuma | nenhuma | nenhum | baixo | SIM |
| forget two-step + transacional (#99/#102) | CODE + ACTIVE (sempre no código, sem flag) | n/a | n/a | nenhuma | nenhuma | nenhum | baixo | SIM |
| Attachments ingestão (A13) | CODE_AVAILABLE, DISABLED (capability gate atual = binding: `getAttachmentStorage` retorna null ⇒ `503 attachment_storage_unavailable`; refs `apps/agent/src/attachments/storage.ts:getAttachmentStorage` L319-323, `apps/agent/src/finance-chat-agent.ts:handleAttachmentUpload` L1970-2042, `Env` L199 `TED_ATTACHMENTS_BUCKET?: unknown`) | NÃO (`wrangler.jsonc` sem `r2_buckets`; dashboard não inventariado — live pendente) | n/a | `TED_ATTACHMENTS_ENABLED` ainda **ausente** (gate server-side proposto, não implementado — ver §4.1); PWA `NEXT_PUBLIC_TED_ATTACHMENT_*` ausentes = UI OFF (não é capability gate) | R2 bucket + binding + server gate + sink | rollout fatia (PRs A/B/C no §5) | médio | NÃO (falta gate + sink + binding) |
| R2 bucket | Infra passiva: bucket `pi-finance-ted-attachments` **existe, privado, vazio, Standard, binding ausente, runtime unaffected** (criado 2026-10-07T16:06:35Z; privado por padrão — sem acesso público/domínio) | Binding ainda NÃO declarado (`wrangler.jsonc` intocado — adiado para PR C, após gate) | n/a | n/a | Cloudflare R2 | rollout fatia | baixo (vazio, deletável) | Infra PRONTA p/ binding futuro; capability NÃO pronta |
| Áudio/STT Groq (A14) | CODE_AVAILABLE, **BLOCKED** (trava dupla + privacy/provider gate: sem ZDR e sem key evidenciados) | n/a | NÃO evidenciado no repo — operador providencia key + ZDR (live UNKNOWN); `TAVILY/BRAVE` ausentes no repo NÃO provam runtime | Convenção existente `TED_AUDIO_STT_ENABLED=1` (trava exata `=== '1'`); ausente em config-de-deploy = OFF nessa config | Groq + ZDR ativado na org | G05-condição (ZDR) | alto (retenção 30d sem ZDR) | NÃO (falta key+ZDR) |
| Vision Groq (A15) | CODE_AVAILABLE, **BLOCKED** (mesmo motivo: sem ZDR/key; modelo default `llama-4-scout` a confirmar) | n/a | NÃO evidenciado no repo (live UNKNOWN) | Convenção `TED_VISION_ENABLED=1`; ausente em config-de-deploy = OFF nessa config | Groq + ZDR + confirmar modelo default | G05-condição | alto | NÃO |
| PDF texto local (A15) | CODE_AVAILABLE, **BLOCKED** por infra de attachments (sem egress/credencial, mas sem storage/sink/gate) | n/a (local, sem egress) | n/a | Convenção `TED_PDF_TEXT_ENABLED=1`; ausente em config-de-deploy = OFF nessa config | nenhuma (unpdf já no bundle) | rollout fatia | baixo | NÃO — só vira canary com storage safe + server flag + sink + parser + controles de prompt-injection + rollback (revalidação obrigatória) |
| Web search (A11) | CODE_AVAILABLE, **UNKNOWN** (secret live não inventariado; `TAVILY_API_KEY` preferido, fallback `BRAVE_API_KEY`, senão disabled — ref `apps/agent/src/agent-config/web.ts:createWebSearchProvider` L168-175; `TAVILY/BRAVE` ausentes no repo NÃO provam runtime) | n/a | UNKNOWN (live pendente; tentativa live falhou por auth) | nenhuma flag de search (disponibilidade = presença de key no runtime) | Tavily/Brave | G07 (custo) | médio | NÃO (UNKNOWN até inventário live) |
| Web fetch (A12) | CODE_AVAILABLE, DISABLED em config-de-deploy (allowlist ausente no repo/workflow; refs `apps/agent/src/agent-config/web.ts:resolveWebFetchAllowedHosts/parseWebFetchAllowedHosts` — ausente/vazio = OFF; `apps/agent/src/agent-config/tools.ts:buildExposedTools` L270-273; search funciona com fetch OFF). Live rigoroso também UNKNOWN (pendente) | n/a | n/a (allowlist `TED_WEB_FETCH_ALLOWED_HOSTS`, não secret) | `TED_WEB_FETCH_ALLOWED_HOSTS` ausente = fetch OFF nessa config | allowlist a definir | G07 (custo) | médio | NÃO |
| Decision Provider (A16) | CODE_AVAILABLE, DISABLED (advisory-only estrutural) | `AI` NÃO declarado no repo (clef indisponível por desenho; dashboard UNKNOWN) | NÃO evidenciado no repo (endpoint/key por adapter; live UNKNOWN) | `TED_DECISION_PROVIDER` ausente nos deploys = OFF nessa config | Jev/Clef/Strands a escolher | G07 | médio | NÃO |
| MCP Jev | Runtime usa `jev_gate/decide` como **ferramenta de decisão humana local**, não como capability do Agent em prod; Jev-adapter segue OFF com o resto da decision layer | — | — | `none` (default) | validação oferta/retention/custo (G04) | G07 | médio | NÃO |
| risk-based autoexecute | `shadow` preservado na API (imutável nesta sessão) | n/a | n/a | `TED_RISK_BASED_AUTOEXECUTE=shadow` | sink durável + telemetria undo-after-autoexecute | G08 + gate humano | alto | NÃO (`on` bloqueado) |
| `TED_ATTACHMENTS_ENABLED` | **Ausente** — nome conceitual de gate server-side proposto, **não implementado**; a confirmar contra a convenção `TED_*_ENABLED=1` no PR técnico (ver §5) | — | — | — | PR A (§5) | rollout fatia | — | NÃO (não existe) |
| Flags A19 (todas) | default-off em config-de-deploy, inalteradas | — | — | antes = depois = OFF (nessa config; live UNKNOWN onde houver secret) | — | por fatia | — | — |
| ZDR | NÃO evidenciado (condição G05 documentada, sem prova de console) | — | — | — | Groq org admin | G05 | alto | bloqueia STT/vision |
| Observabilidade | Único sink durável real = `audit_logs` Postgres da API (`apps/api/src/audit/legacy-bearer-sink.ts`); Agent só tem `console.info/warn` JSON sanitizado (`apps/agent/src/observability/events.ts:emitSanitizedEvent`) + `wrangler.jsonc observability.enabled=true`, sem Analytics Engine/traces/sink durável; eventos `attachment.upload.*`/`attachment.cleanup.*` **NÃO existem**; estados tipados existem em `attachments/types.ts` | — | — | — | sink a definir | G07/G08 | médio | bloqueia canary `on` |
| Rollback | flag/config OFF restauram comportamento (código fail-closed); Cloudflare rollback = novo commit+deploy (sem job dedicado); API = wrapper+rollback tag | — | — | — | — | — | baixo | testado p/ flags, não p/ dados |

Notas:
- `tool-capability-inventory.md` (54/74) cobre tools HTTP legadas — **não** é inventory de rollout A19; capabilities A19 (env+binding) estão fora do gate `capabilities:check`.
- Cleanup R2 (TTL 24h, sweep retomável com cursor, delete idempotente) está implementado em código, mas **nunca executou contra bucket real** (bucket vazio, sem binding). Lifecycle/orphan além do TTL e quota são UNKNOWN até o binding + canary.
- Residual documentado: STT sem teto de duração p/ não-WAV (só 10 MB); PDF deadline é de evento, não de CPU (mitigado por tetos de trabalho); vision default a confirmar.

## 4. Gates (separação A19 × global)

- **A19 (desta sessão):** R2+binding, `GROQ_API_KEY`+ZDR, flags por fatia, G07 (SLO/custo/validação provider p/ decision+web), G08 (versões/migrations p/ canary `on`).
- **Resolvidos com condições (desbloqueiam implementação, NÃO habilitação):** G04 (Jev off), G05 (Groq selecionado, ZDR antes de tráfego), G06 (consentimento).
- **Abertos globais (não-A19, intocados):** G01, G02 (produto), Release B (flip após 2026-10-16T21:36:06Z — HOJE 2026-10-07, janela ainda aberta; só citado como preservação), cutover F3–F5, canary `on` (gate humano), future-dated 2026-12-01/2026-12-31.

### 4.1 Princípio capability gate (finding P1 R2)

Comportamento atual do código (sem mudança neste PR): `storage = getAttachmentStorage(env); if (!bucket) 503 else accept upload`. O **binding é o capability gate atual**: sem `TED_ATTACHMENTS_BUCKET` válido, `handleAttachmentUpload` retorna `503 attachment_storage_unavailable` e nada é persistido.

Princípio a implementar no PR técnico (PR A): `binding presente + flag server-side ativa ⇒ upload elegível; qualquer outro caso ⇒ OFF fail-closed`. Matriz obrigatória:

| Bucket binding | Flag server-side | Comportamento exigido |
|---|---|---|
| ausente | OFF/ausente | `503`, zero bytes, zero objetos |
| ausente | ON | fail-closed `503` (flag sozinha nunca habilita) |
| presente | OFF/ausente | `503` + zero write (binding sozinho nunca habilita) |
| presente | ON | elegível (ainda sujeito a auth, quota, sink e coorte) |

Teste crítico do PR A: com `TED_ATTACHMENTS_BUCKET` configurado e flag `false`, `POST /rpc/attachments` autenticado retorna `503`, com zero bytes escritos e contagem de objetos inalterada.

**Cohort gate por workspace/actor (exigência do PR A):** flag ON sozinha não basta — o RPC de upload deve checar coorte por workspace/actor via allowlist server-side; fora da coorte ⇒ `503` + zero write. Teste non-cohort obrigatório no PR A (workspace/actor fora da allowlist recebe `503`, sem escrita). Registro: `selectRolloutCohort` atual cobre só execução de turnos LLM, não o RPC de upload — o check attachment-specific é requisito novo do PR A, não comportamento existente.

Regra: **`UI flag != capability gate`** — esconder o botão no PWA (`NEXT_PUBLIC_TED_ATTACHMENT_*`) é insuficiente; o bloqueio precisa ser server-side, com RPC direto também bloqueado.

Estados observáveis alvo (proposta de observabilidade — o enum **ainda não existe no código**): `UNCONFIGURED` (sem bucket/flag) / `CONFIGURED_DISABLED` (bucket presente, flag OFF) / `CANARY` (bucket + flag ON em coorte restrita) / `ACTIVE` (generalizado) / `BLOCKED` (gate privacy/provider/infra). Mapeamento bucket×flag conforme a matriz acima; instrumentação a definir no PR B.

## 5. Fase A — plano (gate + observabilidade antes de binding; flags seguem OFF)

Ordem corrigida (uma fatia por vez; rollback = flag OFF / remover binding). **Removido o "binding primeiro"** da versão anterior:

1. **Server-side capability gate + cohort check + tests (PR A):** implementar gate `TED_ATTACHMENTS_ENABLED` (nome conceitual a confirmar contra a convenção `TED_*_ENABLED=1`: `TED_AUDIO_STT_ENABLED`, `TED_VISION_ENABLED`, `TED_PDF_TEXT_ENABLED` usam trava exata `=== '1'`) + matriz do §4.1 + cohort check attachment-specific por workspace/actor (allowlist server-side; non-cohort ⇒ `503` zero-write) + teste crítico `503` com zero write + teste non-cohort obrigatório. Sem binding nesta sessão/PR; sem flag nova neste PR docs-only.
2. **Durable observability sink / required telemetry (PR B; ou A+B se acoplados):** sink mínimo do §6 + eventos ainda inexistentes + baseline G07 antes de qualquer tráfego externo. Sem sink, canary `on` continua bloqueado.
3. **Configure R2 binding com flag ainda OFF (PR C):** só então declarar `TED_ATTACHMENTS_BUCKET` em `wrangler.jsonc` + lifecycle/quota no dashboard, com a flag do PR A ainda OFF.
4. **Provar binding+flag OFF permanece disabled:** RPC direto bloqueado, contagem de objetos inalterada, `503` observável — evidência antes de qualquer canary.
5. **Operator-only canary (coorte explícita):** só após (1)–(4) verdes + G07/G08 aplicáveis, restrito à coorte explícita de workspace/actor do PR A. Depois: PDF local como primeiro candidato (revalidação do §3), Groq (STT→vision) SOMENTE após ZDR evidenciado + secret via `wrangler secret put` + confirmação do modelo vision, decision/web após G07.

**Bloqueadores que exigem o operador (nada disto é executável por agente):**
B1 bucket `pi-finance-ted-attachments` existe (ENAM/Standard/vazio/privado); **binding adiado para o PR C** (após gate + sink). B2 `GROQ_API_KEY` + prova ZDR — operador providencia (STT/vision seguem BLOCKED). B3 binding `AI` (clef indisponível por desenho); B4 sink durável p/ canary; B5 confirmação do modelo vision; B6 `TAVILY/BRAVE_API_KEY` se web entrar no escopo (live UNKNOWN até lá). Token Cloudflare local ausente — provisionamento é via dashboard ou com credencial fornecida pelo mecanismo oficial.

## 6. Canary / promoção (não iniciados) + sink mínimo

Nenhum canary ativado nesta sessão (correto: gates ausentes). Quando os bloqueadores fecharem, seguir: `operator-only → internal/test → small canary → larger → general` no mecanismo G08 existente; SLOs do código (2 s decision, STT 20 s, vision 30 s, PDF 10 s evento, anexos 10–15 MB, quotas 200k/400k, erro canary SDK <0,1%/24h); limites P50/P95 e custo/turno por modalidade ainda serão definidos no baseline (G07). Critérios de pausa §31 e matriz funcional §§12–13/25–28 ficam para a sessão de canary.

**Sink mínimo exigido para canary (PR B):** capability, request count, success, failure, latency, storage write result, provider failure, fallback, identidade técnica workspace/actor, rollout cohort, timestamp — **sem** bytes/conteúdo/secret/filename sensível. Eventos a criar (ainda inexistentes): `attachment.upload.requested/blocked/succeeded/failed`, `attachment.cleanup.succeeded/failed`. Antes de criar um segundo sistema, **investigar reutilização**: `audit_logs` da API, eventos sanitizados do Agent (`emitSanitizedEvent`), G07/G08. Papéis: **G07** = SLO/custo/baseline (definição `docs/MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md:312-313`, abertas `:335`) — bloqueia canary/`on`; **G08** = persistência/migrations/versões — canary `on` + gate humano.

## 7. Matriz final (veredito por capability)

| Capability | Code | Runtime Config | State | Blocker |
|---|---|---|---|---|
| text Agent (core) | ✅ | ✅ (DO ativo) | ACTIVE | none |
| memory / A17 | ✅ | ✅ | ACTIVE | none |
| skills A18 | ✅ | ✅ | ACTIVE | none |
| forget two-step+tx | ✅ | ✅ | ACTIVE | none |
| attachments | CODE_AVAILABLE | no binding + `TED_ATTACHMENTS_ENABLED` ausente | DISABLED (hoje) — exige server gate + sink + binding (§§4.1/5/6) | rollout fatia |
| R2 | bucket exists | no binding | PASSIVE (infra passiva, runtime unaffected) | binding adiado p/ PR C |
| PDF | yes-partial | attachment off | BLOCKED (revalidação: storage safe + server flag + sink + parser + prompt-injection controls + rollback) | rollout fatia |
| audio/STT | yes-partial | no ZDR/key (repo); live UNKNOWN | BLOCKED | ZDR + key (G05) |
| vision | yes-partial | no ZDR/key/modelo (repo); live UNKNOWN | BLOCKED | ZDR + key + modelo (G05) |
| web_search | yes | unknown live (secret não inventariado) | UNKNOWN | inventário live + G07 |
| web_fetch | yes | allowlist ausente (config-de-deploy OFF; live UNKNOWN rigoroso) | DISABLED (config-de-deploy) / live pendente | G07 + allowlist |
| decision provider | yes (advisory-only) | default-off | DISABLED | G07 |
| autoexecute | ✅ (`shadow`) | `shadow` | DISABLED-SHADOW | G08 + gate humano |

## 8. Veredito

**A19 = NOT READY** (não existe classificação "READY FOR NEXT INFRA PHASE" — verificado; portanto mantém-se NOT READY). Infra essencial pendente: server gate, sink/observabilidade, binding R2, secrets, ZDR, G07/G08. Core em produção (texto, memória/A17, skills/A18, forget) está **READY e estável**; opcionais permanecem **BLOCKED/DISABLED/UNKNOWN por desenho** — nenhuma é presumida habilitada.

Este PR é **docs-only**: nenhuma capability ativada, rollout **não iniciado**. Próximo passo = issue `A19 Phase A — server-side capability gates + observability prerequisite` + PRs A/B/C do §5.

Trilha preservada: #90 → #92 → #97/#98 → #100/#101 → #103/#104 → este relatório. Preservados sem toque: A17/A18/forget fechados, `scripts/agent-release-smoke.mjs` intocado, Release B (gate 2026-10-16T21:36:06Z).

## 9. Resposta aos findings P1 do PR #106

- **P1 gate set ⇒ `CI run 37649649680 Gate — all checks success` + atualização documental.** O parágrafo de gates locais foi substituído pelo bloco CI remoto autoritativo no §1 (run, Gate, jobs success, PWA CI `37649649654`), mantendo os gates locais apenas como complementares sem rerun.
- **P1 web search ⇒ `claim OFF removed; state now UNKNOWN until live secret inventory`.** A afirmação "web OFF" foi removida: `web_search` agora é `UNKNOWN` até inventário live de secrets (tentativa live nesta sessão falhou por auth — códigos acima, sem valores); `web_fetch` documentado separadamente (config-de-deploy OFF, live pendente).
- **P1 R2 binding ⇒ `binding step postponed; server-side gate required first`.** O "binding primeiro" foi removido: ordem corrigida para gate (PR A) → sink (PR B) → binding com flag OFF (PR C) → prova disabled → canary operador-only; princípio e matriz do capability gate no §4.1.

**Round-2 (review 5445520268 no PR #106, commit `cfbb7cd`) — 3 novos P1, respostas literais:**
- `final-SHA CI runs 37654520900 + PWA 37654521051, Gate success, sem rerun-pendente` — §1 agora cita os runs do SHA final `cfbb7cd`; `37649649680` mantido só como histórico do parent `63bd555`; frase "sem rerun" removida.
- `AGENTS.md session entry synced` — entrada da sessão 2026-10-07b reescrita (config-de-deploy OFF + runtime live UNKNOWN; tentativa live falhou por auth; ordem gate→sink→binding→prova→canary; CI runs citados; NOT READY).
- `attachment cohort gate added to PR A plan` — §4.1 exige cohort check attachment-specific por workspace/actor (allowlist server-side; non-cohort ⇒ `503` zero-write) + teste non-cohort obrigatório no PR A; registrado que `selectRolloutCohort` atual cobre só turnos LLM, não o upload RPC; §5 passos 1 e 5 atualizados (PR A com cohort; canary = coorte explícita).

## Apêndice A — Evidências

- **CI remoto:** run `37654520900` (`completed`, `success`, `headSha cfbb7cd`, `Gate — all checks success`); PWA CI run `37654521051` success no mesmo SHA. Histórico: run `37649649680` cobria o parent `63bd555`.
- **Tentativa live (sem tokens/valores):** comandos `npx wrangler r2 bucket list` → erro de autenticação código 10000; `wrangler secret list --name pi-finance-agent` → erro de autenticação código 10000 + token de acesso inválido código 9109. Inventário live pendente.
- **Refs de código (só arquivo:linhas, sem mudança):** `apps/agent/src/attachments/storage.ts:getAttachmentStorage` (L319-323); `apps/agent/src/finance-chat-agent.ts:handleAttachmentUpload` L1970-2042; `apps/agent/src/finance-chat-agent.ts:Env` L199; `apps/agent/wrangler.jsonc` L1-21; `apps/agent/src/agent-config/web.ts` L168-175 + `resolveWebFetchAllowedHosts/parseWebFetchAllowedHosts`; `apps/agent/src/agent-config/tools.ts:buildExposedTools` L270-273; `apps/agent/src/observability/events.ts:emitSanitizedEvent`; `apps/api/src/audit/legacy-bearer-sink.ts`; `attachments/types.ts`; convenção `TED_AUDIO_STT_ENABLED=1`, `TED_VISION_ENABLED=1`, `TED_PDF_TEXT_ENABLED=1` (travas `=== '1'`); `TED_WEB_FETCH_ALLOWED_HOSTS`, `TED_DECISION_PROVIDER`, `TED_RISK_BASED_AUTOEXECUTE`; G07 (`docs/MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md:312-313`, abertas `:335`).
- **Regra de ouro:** `infra provisionada != capability habilitada`; `repo config != live runtime`; `binding presence != passive infrastructure`.
