# Rollout controlado da A19 — inventário real + Fase A (2026-10-07)

**HEAD inicial:** `e1cf1bb2058219bbd93f5fca7423a7cd68830762` (= `origin/main`, working tree clean, 0 commits posteriores).
**HEAD final:** `e1cf1bb` (nenhuma alteração de código/config nesta sessão — somente este relatório + entrada no `AGENTS.md`).
**Issues/PRs:** #102 fechada; #103 (`bbdc948`) e #104 (`e1cf1bb`) mergeados. Nenhuma issue/PR nova aberta.
**Escopo:** inventário real + prontidão Fase A. Nenhuma flag alterada, nenhum secret provisionado, nenhum deploy executado.

## 1. Estado de produção verificado (evidência viva, read-only)

| Superfície | Evidência (2026-10-07) | SHA vivo |
|---|---|---|
| Agent `/health` | `status=ready, schemaVersion=5, buildId=37631044197, builtAt=2026-10-07T13:45:24Z` | `e1cf1bb…` = HEAD ✅ |
| Agent `/health/agent` | `status=ready, binding=FINANCE_CHAT_AGENT` | — |
| PWA `/api/build-info` | `buildId=37631044197, builtAt=2026-10-07T10:45:20-03:00` | `e1cf1bb…` = HEAD ✅ |
| API `/health` + `/ready` | `status=ok/ready, buildId=37238430467, builtAt=2026-10-04T22:07:46Z` | `bd1ed9b` (Contabo, independente — inalterada, como esperado) |

Deploy attestation preservado (sem alteração em `scripts/agent-release-smoke.mjs`).
Gates locais rodados nesta sessão: `capabilities:check` PASS (54 tools / 74 rows),
`docs:lint` PASS (12 docs, 0 issues), `governance:check` PASS (sem mudança D01–D19).

## 2. Por que produção está com tudo opcional OFF (prova, não inferência)

- `apps/agent/wrangler.jsonc`: bindings = somente `FINANCE_CHAT_AGENT` (DO sqlite)
  + `vars.API_ORIGIN`. **Sem** `r2_buckets`, sem binding `AI`, sem `TED_*`.
- `agent-deploy.yml` injeta **somente** `BUILD_SHA/BUILD_ID/BUILD_TIME` + `PWA_ORIGIN`.
  Nenhuma `TED_*`/`GROQ_*`/`TAVILY_*` por deploy → env ausente = default-off no código.
- `pwa-deploy.yml` injeta somente `PWA_ORIGIN` + `PWA_AGENT_PROXY_ORIGIN`.
  Nenhuma `NEXT_PUBLIC_TED_ATTACHMENT_*` no build → UI não anuncia anexos (fail-closed).
  Exceção: `apps/pwa/wrangler.jsonc:29` fixa `NEXT_PUBLIC_TED_MICROPHONE=true`
  (captura de voz V4 no browser — caminho distinto do STT Groq, que segue OFF).
- Ambiente local desta sessão: sem `CLOUDFLARE_API_TOKEN`, sem `CLOUDFLARE_ACCOUNT_ID`,
  sem `GROQ_API_KEY` (somente presença verificada, nenhum valor lido/criado).

## 3. Inventário real do rollout

Legenda: `CODE` = código presente; `CFG` = configurado em produção; `CANARY`/`ACTIVE` = tráfego.

| Capacidade | Estado atual | Binding existe? | Secret existe? | Flag atual | Dependência externa | Gate necessário | Risco | Pronta p/ canary? |
|---|---|---|---|---|---|---|---|---|
| Text Agent (core) | ACTIVE em `e1cf1bb` (saudável) | n/a (DO ativo) | n/a | n/a | API Contabo `bd1ed9b` | nenhum | baixo | SIM (já em prod) |
| Memory Parte B + A17 learning | CODE + ACTIVE (opt-out por workspace, ON default) | n/a (SQLite DO) | n/a | opt-out `POST /rpc/memory/prefs` | nenhuma | nenhum | baixo | SIM |
| Skills usuário A18 | CODE + ACTIVE (dado delimitado `tools:[]`) | n/a | n/a | nenhuma | nenhuma | nenhum | baixo | SIM |
| forget two-step + transacional (#99/#102) | CODE + ACTIVE (sempre no código, sem flag) | n/a | n/a | nenhuma | nenhuma | nenhum | baixo | SIM |
| Attachments ingestão (A13) | CODE_AVAILABLE, DISABLED | NÃO no repo (`wrangler.jsonc` sem `r2_buckets`; dashboard inacessível nesta sessão) → 503 fail-closed | n/a | PWA `NEXT_PUBLIC_TED_ATTACHMENT_*` ausentes = OFF | R2 bucket + binding | rollout fatia | médio | NÃO (falta R2) |
| R2 bucket | ✅ PROVISIONADO nesta sessão: `pi-finance-ted-attachments` (ENAM, Standard, 0 objetos, criado 2026-10-07T16:06:35Z; privado por padrão — sem acesso público/domínio, conforme "sem URL pública") | Binding ainda NÃO declarado (`wrangler.jsonc` intocado — PR infra separado) | n/a | n/a | Cloudflare R2 (via wrangler OAuth do operador) | rollout fatia | baixo (vazio, deletável) | PRONTO p/ binding |
| Áudio/STT Groq (A14) | CODE_AVAILABLE, DISABLED (trava dupla) | n/a | NÃO evidenciado — operador providencia key + ZDR (decisão desta sessão) | `TED_AUDIO_STT_ENABLED` ausente nos deploys = OFF | Groq + ZDR ativado na org | G05-condição (ZDR) | alto (retenção 30d sem ZDR) | NÃO (falta key+ZDR) |
| Vision Groq (A15) | CODE_AVAILABLE, DISABLED (trava dupla) | n/a | NÃO evidenciado (mesma key) | `TED_VISION_ENABLED` ausente nos deploys = OFF | Groq + ZDR + confirmar modelo default (`llama-4-scout` a confirmar) | G05-condição | alto | NÃO |
| PDF texto local (A15) | CODE_AVAILABLE, DISABLED | n/a (local, sem egress) | n/a | `TED_PDF_TEXT_ENABLED` ausente nos deploys = OFF | nenhuma (unpdf já no bundle) | rollout fatia | baixo | QUASE (só falta decisão+flag) |
| Web search/fetch (A11–A12) | CODE_AVAILABLE, DISABLED | n/a | NÃO evidenciado (`TAVILY_API_KEY`/`BRAVE_API_KEY` sem referência no repo) | `TED_WEB_FETCH_ALLOWED_HOSTS` ausente = fetch OFF | Tavily/Brave | G07 (custo) | médio | NÃO |
| Decision Provider (A16) | CODE_AVAILABLE, DISABLED (advisory-only estrutural) | `AI` NÃO declarado no repo (clef indisponível por desenho; dashboard UNKNOWN) | NÃO evidenciado (endpoint/key por adapter) | `TED_DECISION_PROVIDER` ausente nos deploys = OFF | Jev/Clef/Strands a escolher | G07 | médio | NÃO |
| MCP Jev | Runtime usa `jev_gate/decide` como **ferramenta de decisão humana local**, não como capability do Agent em prod; Jev-adapter segue OFF com o resto da decision layer | — | — | `none` (default) | validação oferta/retention/custo (G04) | G07 | médio | NÃO |
| risk-based autoexecute | `shadow` preservado na API (imutável nesta sessão) | n/a | n/a | `TED_RISK_BASED_AUTOEXECUTE=shadow` | sink durável + telemetria undo-after-autoexecute | G08 + gate humano | alto | NÃO (`on` bloqueado) |
| Flags A19 (todas) | default-off, inalteradas | — | — | antes = depois = OFF | — | por fatia | — | — |
| ZDR | NÃO evidenciado (condição G05 documentada, sem prova de console) | — | — | — | Groq org admin | G05 | alto | bloqueia STT/vision |
| Observabilidade | eventos sanitizados (sem conteúdo); **sem sink durável** (`ted-autoexecute-observability.md`) | — | — | — | sink a definir | G07/G08 | médio | bloqueia canary `on` |
| Rollback | flag/config OFF restauram comportamento (código fail-closed); Cloudflare rollback = novo commit+deploy (sem job dedicado); API = wrapper+rollback tag | — | — | — | — | — | baixo | testado p/ flags, não p/ dados |

Notas:
- `tool-capability-inventory.md` (54/74) cobre tools HTTP legadas — **não** é inventory
  de rollout A19; capabilities A19 (env+binding) estão fora do gate `capabilities:check`.
- Cleanup R2 (TTL 24h, sweep retomável com cursor, delete idempotente) está implementado
  em código, mas **nunca executou contra bucket real** (sem bucket). Lifecycle/orphan
  além do TTL e quota são UNKNOWN até o provisionamento.
- Residual documentado: STT sem teto de duração p/ não-WAV (só 10 MB); PDF deadline é
  de evento, não de CPU (mitigado por tetos de trabalho); vision default a confirmar.

## 4. Gates (separação A19 × global)

- **A19 (desta sessão):** R2+binding, `GROQ_API_KEY`+ZDR, flags por fatia, G07 (SLO/custo/
  validação provider p/ decision+web), G08 (versões/migrations p/ canary `on`).
- **Resolvidos com condições (desbloqueiam implementação, NÃO habilitação):**
  G04 (Jev off), G05 (Groq selecionado, ZDR antes de tráfego), G06 (consentimento).
- **Abertos globais (não-A19, intocados):** G01, G02 (produto), Release B
  (flip após 2026-10-16T21:36:06Z — HOJE 2026-10-07, janela ainda aberta),
  cutover F3–F5, canary `on` (gate humano), future-dated 2026-12-01/2026-12-31.

## 5. Fase A — plano (infra passiva, flags seguem OFF)

Ordem proposta (uma fatia por vez, rollback = flag OFF / remover binding):

1. **R2:** ✅ bucket criado nesta sessão (`pi-finance-ted-attachments`, ENAM/Standard/vazio/privado
   por padrão). Falta: declarar binding `TED_ATTACHMENTS_BUCKET` em `wrangler.jsonc`
   (PR infra separado) + definir lifecycle/quota no dashboard; deploy valida 503→pronto
   sem anunciar UI (flags PWA seguem OFF).
   Testes: upload bloqueado antes / ingestão interna após, delete, orphan sweep, falha
   de delete, keys sem PII, cursor/checkpoint.
2. **Observabilidade:** definir sink durável + retenção + baseline (G07) antes de
   qualquer tráfego externo; sem sink, canary `on` continua bloqueado.
3. **PDF local:** menor risco (sem egress/credencial) — primeiro candidato a canary
   operador-only via `TED_PDF_TEXT_ENABLED=1` após (1)+(2).
4. **Groq (STT→vision):** SOMENTE após ZDR evidenciado no console da org + secret
   via `wrangler secret put`; confirmar modelo vision default (decisão humana).
5. **Decision/web:** após G07 (baseline SLO/custo + validação documentada do provider).

**Bloqueadores que exigem o operador (nada disto é executável por agente):**
B1 ✅ RESOLVIDO nesta sessão — bucket `pi-finance-ted-attachments` criado via wrangler
(ENAM/Standard/vazio/privado); falta declarar o binding `TED_ATTACHMENTS_BUCKET` em
`wrangler.jsonc` (PR infra separado) + definir lifecycle/quota no dashboard.
B2 `GROQ_API_KEY` + prova ZDR — operador providencia (decisão desta sessão; STT/vision seguem BLOCKED).
+ (clef) binding `AI`; B4 sink durável p/ canary; B5 confirmação do modelo vision;
B6 `TAVILY/BRAVE_API_KEY` se web entrar no escopo. Token Cloudflare local ausente —
provisionamento é via dashboard ou com credencial fornecida pelo mecanismo oficial.

## 6. Canary / promoção (não iniciados)

Nenhum canary ativado nesta sessão (correto: infra ausente). Quando B1–B6 fecharem,
seguir: `operator-only → internal/test → small canary → larger → general` no
mecanismo G08 existente; SLOs do código (2 s decision, STT 20 s, vision 30 s,
PDF 10 s evento, anexos 10–15 MB, quotas 200k/400k, erro canary SDK <0,1%/24h);
limites P50/P95 e custo/turno por modalidade ainda serão definidos no baseline (G07).
Critérios de pausa §31 e matriz funcional §§12–13/25–28 ficam para a sessão de canary.

## 7. Matriz final (veredito por capability)

| Capability | Code | Config | Canary | Production | Gate | Verdict |
|---|---|---|---|---|---|---|
| text Agent | ✅ | ✅ | n/a | ACTIVE `e1cf1bb` saudável | — | READY |
| memory / A17 | ✅ | ✅ | n/a | ACTIVE | — | READY |
| skills A18 | ✅ | ✅ | n/a | ACTIVE | — | READY |
| forget two-step+tx | ✅ | ✅ | n/a | ACTIVE | — | READY |
| attachments/R2 | ✅ | ❌ | — | DISABLED | rollout fatia | NOT READY (infra) |
| audio/STT | ✅ | ❌ | — | DISABLED | G05 (ZDR+key) | BLOCKED |
| vision | ✅ | ❌ | — | DISABLED | G05 (ZDR+key+modelo) | BLOCKED |
| PDF | ✅ | ❌ | — | DISABLED | rollout fatia | READY P/ CANARY OPERADOR* |
| web | ✅ | ❌ | — | DISABLED | G07 | BLOCKED |
| Decision Provider | ✅ | ❌ | — | DISABLED | G07 | BLOCKED |
| autoexecute | ✅ (`shadow`) | ✅ | — | SHADOW | G08+humano | SHADOW (correto) |

\* primeiro candidato após R2+sink.

## 8. Veredito

**A19 = NOT READY** (infra essencial ausente: R2, secrets, ZDR, sink, G07/G08).
Core em produção (texto, memória/A17, skills/A18, forget) está **READY e estável**;
opcionais permanecem **BLOCKED/DISABLED por desenho** — nenhuma é presumida habilitada.
Trilha preservada: #90 → #92 → #97/#98 → #100/#101 → #103/#104 → este relatório.
