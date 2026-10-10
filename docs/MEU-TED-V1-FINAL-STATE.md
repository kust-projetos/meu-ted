# MEU-TED-V1-FINAL-STATE (estado vigente — snapshot somente-leitura)

**Atualizado:** 09/10/2026. Este documento é snapshot, não plano. A definição de
encerramento vive em `docs/MEU-TED-SPEC-V1-FINAL-CLOSURE.md`.

## 1. Produção viva

| Camada | SHA vigente | Evidência |
|---|---|---|
| API (Contabo) | `bd1ed9b` | `/health` + `/ready` verdes; `TED_RISK_BASED_AUTOEXECUTE=shadow`, `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical` |
| Agent (Cloudflare) | `035d0a1d` (build `37860109691`) | GET `/health`: ready; SHA/builtAt conferidos em 09/10 |
| PWA (Cloudflare) | `035d0a1d` (build `37860109691`) | GET `/api/build-info`: SHA/builtAt conferidos em 09/10 |
| `main` (remota) | `035d0a1d` (PR #130) | fetch confirmou `main == origin/main`; working tree estava limpa no início |
| Credencial demo (E2E/prova) | `demo@clinicademo.com` | criada em 08/10 via fluxo de convite; membership owner no household E2E `550e8400…` (dados sintéticos); senha só no env do operador |

## 2. Matriz de capabilities (config-de-deploy; live runtime = UNKNOWN sem credencial)

| Capability | Código | Config-de-deploy | Live | Gate para avançar |
|---|---|---|---|---|
| Chat texto, memória/A17, skills/A18, forget two-step transacional | ACTIVE | ACTIVE | ACTIVE | — (baseline V1) |
| Attachments (upload/R2) | ACTIVE | **ACTIVE** (`TED_ATTACHMENTS_ENABLED=1`, coorte `*`, R2 binding) | upload/R2 provados em 08/10; nova flag não alterada | manter gates/cleanup |
| PDF textual | parser preservado, runtime fail-closed neste branch | produção no SHA `035d0a1d` veio de manifesto com `TED_PDF_TEXT_ENABLED=1`; branch altera para `0` e ignora override `1` | produção não redeployada; valor live inferido do SHA/manifesto, sem endpoint de flags | **WAITING_OPERATOR**: rever egress/retention; desativar via fluxo autorizado; reabilitar somente com limite CPU/memória verificável |
| STT (Groq whisper-large-v3-turbo) | disponível | manifesto com flag `1`, coorte workspace de teste; secret presente segundo relatório 08/10 | probe sintético aprovado; voz real pendente | **WAITING_OPERATOR** para aceite de precisão/privacidade |
| Vision (Gemini `gemini-2.5-flash`, canary; Groq alternativo) | ACTIVE (código) | manifesto com flag `1`, provider/modelo allowlisted, coorte workspace de teste | extração sintética off-box; turno real ainda pendente (cota anterior esgotada) | **BLOCKED_EXTERNAL**: turno canary/cota e verificação de privacidade |
| web_search | disponível | UNKNOWN (key fora do repo) | UNKNOWN (inventário pendente) | F2.4 |
| web_fetch | disponível | DISABLED (allowlist ausente) | pendente | F2.4 |
| Decision provider (Jev/Clef/Strands) | disponível | DISABLED (default-off) | DISABLED | POST-V1 / OPTIONAL |
| Autoexecute low-risk |policy ativa | `SHADOW` | `SHADOW` | F3 (sink + canary) |

Regra: `infra provisionada != capability habilitada`; `repo config != live runtime`.

## 3. Flags (todas default-off, trava exata `=== '1'`)

`TED_AUDIO_STT_ENABLED`, `TED_VISION_ENABLED`, `TED_PDF_TEXT_ENABLED` (branch = `0`; runtime de produção = SHA anterior),
`TED_DECISION_PROVIDER` (ausente/vazio/`none` = off), `TED_WEB_FETCH_ALLOWED_HOSTS`
(ausente/vazio = fetch OFF). `TED_ATTACHMENTS_ENABLED`: nome conceitual da #107,
**não implementado** (F1 PR A). PWA: `NEXT_PUBLIC_TED_ATTACHMENT_*` (anúncio, não
gate), `NEXT_PUBLIC_TED_MICROPHONE=true` (browser, distinto do STT).

## 4. Gates abertos e owners

| Gate | Data/condição | Owner |
|---|---|---|
| #107 Phase A (gate+cohort+sink) | código/gates entregues em #108 e sucessores; issue segue OPEN; inventário de capability/evidência ainda pendente de fechamento | **WAITING_OPERATOR** para gate privacy do PDF e fechamento explícito da issue |
| #105 Golden Workflows | issue OPEN; #110 cobre só cancel/confirm; suite completa exigida pela SPEC não existe | **WAITING_OPERATOR** para executar/aceitar os workflows restantes após este pacote |
| Release B (flip bearer legado) | ≥ `2026-10-16T21:36:06Z`, sink = 0 | operador (gate temporal) |
| Cutover F3–F5 | gate humano (ADR-024/ADR-025) | operador |
| Privacidade A19 (PDF → relay/provider) | classificação “sem egress” retificada; conteúdo pode sair pelo relay; sem prova de ZDR/retention neste endpoint | **WAITING_OPERATOR** |
| Web live inventory (Tavily/Brave) | pré-F2.4 | operador (credencial CF) |
| Autoexecute `on` | sink + telemetria undo-after-autoexecute | operador (gate humano) |
| #87 SDK épico (+#93/#94), #95 keepalive | POST-V1 | backlog |
| Future-dated 2026-12-01 / 2026-12-31 | MAINTENANCE POST-V1 | workflows/lembretes |

## 5. Backups / DR

Bootstrap Contabo + dumps em `backups-local/` (nunca deletar; ignorado no git);
backup diário na Contabo (`~/infra/backup`, cron 03:30 UTC); rollback tags
`pi-finance-api:rollback-pre-*` preservadas. Restore proof fresco: pendente (F6/F7).

## 6. Limitações conhecidas (residuais aceitos, fail-closed)

STT sem teto de duração p/ não-WAV (só 10 MB); PDF desabilitado porque o teto
de saída não limita materialização de uma página; timeout é só de evento; cleanup
nunca executado contra bucket real; retenção/provider de conteúdo LLM pendente;
SDK `AIChatAgent` persiste pós-retorno (evidência = resposta
completa não-fail-closed); tombstone de conteúdo não cobre camada shared.

## 7. Backlog POST-V1

#87 (+Dependabot #93/#94), #95, Decision provider, G01/G02, future-dated,
performance tuning, novos providers/agents/features, refactors cosméticos.

## 8. Trilha recente

#90→#92→#97→#100→#103/#104→#106→#108→#110–#130. Em 09/10, Agent/PWA live
`035d0a1d`; attachments/R2 ACTIVE; PDF flag configurada `1` no SHA live, STT e
Vision configurados em coorte de teste. Este branch prepara PDF fail-closed,
mas não foi publicado; A19 continua **NOT READY** até resolver gates de
privacidade, prova/canary e observabilidade.

## 9. Ativação de attachments (08/10/2026) — evidência e achados

- **Config live** (Cloudflare API, `settings`): `TED_ATTACHMENTS_ENABLED=1`,
  `TED_ATTACHMENTS_COHORT=*`, `TED_ATTACHMENTS_BUCKET` (R2), `BUILD_SHA=23d1485`.
- **Prova autenticada** (usuário demo): `POST /rpc/attachments` → `200` + `ref`;
  objeto relido do R2 (`wrangler r2 object get .../ted/attachments/v1/<ref>`)
  ⇒ upload grava de verdade. `GET /rpc/attachments/observability` → `200`
  (`baseline.total` cresce) ⇒ sink G07 ativo.
- **Fail-closed preservado**: matriz OFF/non-cohort → `503` + zero-write segue
  provada em `tests/attachments/upload-gate.test.ts`; zero-mutação global com
  gate negado (deletes de cleanup/ref-expirada) provada em
  `upload-gate-zero-mutation.test.ts`.
- **Achado operacional (corrida de deploy `workflow_run`)**: o merge de #115
  teve o job `deploy` **pulado** (duas execuções da corrida gate↔CI) e só foi
  publicado após `gh run rerun`; adicionalmente o E2E da PWA falhou por flake
  Playwright conhecido (`PWA-03`), resolvido por `rerun --failed`. Estes dois
  passos (rerun do deploy + rerun do flake) são hoje manuais; candidatos a
  follow-up (gatilho de deploy mais robusto). `object_count` do
  `wrangler r2 bucket info` é métrica periódica — não usar como prova imediata;
  a prova é reler o objeto.
- **Credencial demo**: `demo@clinicademo.com` (senha somente no env do
  operador) — criada via fluxo real de convite (`account_invites` → sign-up →
  `users` canônico → membership owner no household E2E `550e8400…`, dados
  sintéticos). E-mail/validade registrados aqui; **senha nunca vai ao git**.

## 10. Situação da closure V1 (09/10/2026)

Os estados abaixo são deliberadamente separados de “código implementado” e
“produção comprovada”. O hardening local está no branch
`fix/v1-attachment-grounding-hardening`; não foi publicado nem implantado.

| Frente | Estado | Bloqueador |
|---|---|---|
| A19 | **WAITING_OPERATOR** | Revisar egress/retention do PDF; confirmar deactivation/rollback live e gates restantes de canary. |
| Golden #105 | **WAITING_OPERATOR** | Workflows completos e invariantes da issue ainda não executados/aceitos; não transformar `pending-capability` em PASS. |
| Autoexecute low-risk | **WAITING_OPERATOR** | Continua SHADOW; `on` exige sink e telemetria de undo-after-autoexecute. |
| Release B | **WAITING_DATE** | Gate temporal `2026-10-16T21:36:06Z` + zero eventos na janela e procedimento autorizado. |
| F3–F5 | **WAITING_OPERATOR** | Canonical cutover/aposentadoria do legado requer gate humano. |
| Backup/restore | **WAITING_OPERATOR** | Backup diário/configurado; restore proof fresco ainda pendente. |
| Production E2E | **WAITING_OPERATOR** | Aceite final integrado (API/PWA/Agent, anexos, PDF/STT/Vision, mutation receipts/undo) ainda não executado. |
| Release v1 | **BLOCKED_EXTERNAL** | Bloqueado por A19, #105, Release B, F3–F5, restore proof e E2E final; este pacote sozinho não conclui v1. |

### Findings deste pacote

| Finding | Estado no branch | Evidência |
|---|---|---|
| PDF page work limit | Mitigado por **desativação fail-closed**, não por limite efetivo. Reabilitar bloqueado até isolamento/CPU/memória bounded. | `pdf-text.ts`; `pdf-gate-worklimit.test.ts`; `wrangler.jsonc=0`. |
| Grounding: unidade/moeda/count/sinal | Corrigido em validação local: contagem e campo sem unidade não suportam dinheiro; moeda e sinal comparados; moeda/unidade desconhecida fail-closed. | `grounding-quantity-provenance.test.ts`. |
| Vision Gemini/Groq | Parser comum preserva amount e normaliza símbolos conhecidos; unknown/ambiguous permanecem honestos; sem provider, timeout, quota ou retry extra. | `groq-vision.test.ts`, `gemini-vision.test.ts`. |
| Anexo vs. registro financeiro | Texto documental pode fundamentar leitura citada; não pode provar saldo/lançamento registrado, que requer suporte API. Anexo continua dado sem autoridade. | Testes de publicação no mesmo arquivo evidence. |
| Egress/privacidade | Documentação retificada; gate do operador pendente, sem alegação ZDR/retention. | Relatório A19 §11 + relatório hardening. |
| Instruction version/telemetria | Versão atualizada e eventos de grounding sanitizados implementados. | `cognitive-instructions.test.ts`, `grounding-events-observability.test.ts`. |

**Produção atual:** Agent/PWA `035d0a1d` (read-only smoke 09/10); API
`bd1ed9b`. O Agent live segue na versão anterior à mitigação e seu manifesto
indica PDF `1`; nenhuma flag/secret foi alterada nesta execução. A flag `0` do
branch só terá efeito após deploy autorizado. A retificação de egress exige
reapresentar o gate de privacidade antes de retomar rollout A19.
